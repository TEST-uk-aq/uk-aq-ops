"""Verify private Accounts reads with the existing Access-protected Tunnel.

The installed cloudflared ingress file, not a request Host or JWT claim, selects
the application hostname. Cloudflare checks the app token again at its own
get-identity endpoint. No direct-listener identity header is trusted.
"""

from __future__ import annotations

import json
import re
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

try:
    import yaml
except ImportError:
    yaml = None


_HOSTNAME = re.compile(r"(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?")
_EMAIL = re.compile(r"[^\s@,]+@[^\s@,]+\.[^\s@,]+")
_MAX_CONFIG_BYTES = 64 * 1024
_MAX_IDENTITY_BYTES = 16 * 1024


class AccountsAccessError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code or {
            HTTPStatus.SERVICE_UNAVAILABLE: "ACCOUNTS_AUTH_NOT_CONFIGURED",
            HTTPStatus.UNAUTHORIZED: "UNAUTHORIZED",
        }[status]


def _protected_hostname(handler: Any) -> str:
    """Find the unique installed Tunnel ingress for this listener's port."""
    if yaml is None:
        raise AccountsAccessError(HTTPStatus.SERVICE_UNAVAILABLE, "Accounts access is not configured")
    config_path = Path.home() / ".cloudflared" / "config.yml"
    try:
        if config_path.stat().st_size > _MAX_CONFIG_BYTES:
            raise ValueError("Tunnel config too large")
        config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
        ingress = config.get("ingress") if isinstance(config, dict) else None
        if not isinstance(ingress, list) or len(ingress) > 32:
            raise ValueError("Invalid Tunnel ingress")
        port = handler.server.server_address[1]
        hostnames = []
        for rule in ingress:
            if not isinstance(rule, dict):
                raise ValueError("Invalid Tunnel rule")
            service = rule.get("service")
            if not isinstance(service, str):
                continue
            parsed = urlparse(service)
            if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"} or \
                    parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                continue
            if parsed.port != port:
                continue
            hostname = rule.get("hostname")
            if not isinstance(hostname, str) or not _HOSTNAME.fullmatch(hostname) or \
                    ".." in hostname or "." not in hostname:
                raise ValueError("Invalid protected hostname")
            hostnames.append(hostname)
        if len(hostnames) != 1:
            raise ValueError("No unique protected Tunnel ingress")
        return hostnames[0]
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, yaml.YAMLError):
        raise AccountsAccessError(HTTPStatus.SERVICE_UNAVAILABLE, "Accounts access is not configured") from None


def authorize_accounts_request(handler: Any) -> None:
    hostname = _protected_hostname(handler)
    assertions = handler.headers.get_all("Cf-Access-Jwt-Assertion", [])
    if len(assertions) != 1:
        raise AccountsAccessError(HTTPStatus.UNAUTHORIZED, "Accounts authentication required")
    assertion = assertions[0].strip()
    if not 1 <= len(assertion) <= 16 * 1024 or assertion.count(".") != 2 or \
            any(char.isspace() for char in assertion):
        raise AccountsAccessError(HTTPStatus.UNAUTHORIZED, "Accounts authentication required")

    # Use only the configured Tunnel hostname. Access checks this application
    # token and its policy before answering the identity endpoint. A missing
    # Access application, bad token or network failure denies the local read.
    session = requests.Session()
    session.trust_env = False
    try:
        with session.get(
            "https://" + hostname + "/cdn-cgi/access/get-identity",
            headers={"Cookie": "CF_Authorization=" + assertion, "Accept": "application/json"},
            timeout=(3.05, 10), allow_redirects=False, stream=True,
        ) as response:
            if response.status_code != HTTPStatus.OK or \
                    "application/json" not in response.headers.get("Content-Type", "").lower():
                raise AccountsAccessError(HTTPStatus.UNAUTHORIZED, "Accounts authentication required")
            raw = bytearray()
            for chunk in response.iter_content(8192):
                raw.extend(chunk)
                if len(raw) > _MAX_IDENTITY_BYTES:
                    raise ValueError("Identity response too large")
        identity = json.loads(raw)
        if not isinstance(identity, dict) or identity.get("service_token_status") is True or \
                identity.get("service_token_id") or \
                not isinstance(identity.get("user_uuid"), str) or not identity["user_uuid"].strip() or \
                len(identity["user_uuid"]) > 256 or \
                not isinstance(identity.get("email"), str) or len(identity["email"]) > 254 or \
                not _EMAIL.fullmatch(identity["email"].strip()):
            raise ValueError("No personal Access identity")
    except AccountsAccessError:
        raise
    except (requests.RequestException, ValueError, TypeError, UnicodeError):
        raise AccountsAccessError(HTTPStatus.UNAUTHORIZED, "Accounts authentication required") from None
    finally:
        session.close()
