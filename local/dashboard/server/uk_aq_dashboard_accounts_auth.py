"""Fail-closed Cloudflare Access authorisation for private Accounts reads.

Only public signing keys are cached. Assertions and verified identities remain
request-local, including when the caller reaches the Python listener directly.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from http import HTTPStatus
from typing import Any

import requests

try:
    import jwt
    from jwt.algorithms import RSAAlgorithm

    if "RS256" not in jwt.algorithms.get_default_algorithms():
        jwt = None
except ImportError:
    jwt = None


_ISSUER = re.compile(r"https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com")
_EMAIL = re.compile(r"[^\s@,]+@[^\s@,]+\.[^\s@,]+")
_KEY_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_KEY_TTL_SECONDS = 300
_KEY_FAILURE_BACKOFF_SECONDS = 30
_MAX_JWKS_BYTES = 64 * 1024
_KEY_LOCK = threading.Lock()
_KEY_CACHE: dict[str, Any] = {"issuer": None, "keys": {}, "expires": 0.0, "unavailable": False}


class AccountsAccessError(Exception):
    """Contains only a safe public status and fixed error message."""

    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code or {
            HTTPStatus.SERVICE_UNAVAILABLE: "ACCOUNTS_AUTH_NOT_CONFIGURED",
            HTTPStatus.UNAUTHORIZED: "UNAUTHORIZED",
            HTTPStatus.FORBIDDEN: "FORBIDDEN",
        }[status]


def _configuration() -> tuple[str, str, set[str]]:
    issuer = str(os.getenv("DASHBOARD_ACCESS_TEAM_DOMAIN") or "").strip().removesuffix("/")
    audience = str(os.getenv("DASHBOARD_ACCESS_AUD") or "").strip()
    raw_admins = str(os.getenv("DASHBOARD_ACCOUNTS_ADMIN_EMAILS") or "").strip()
    admins = {email.strip().lower() for email in raw_admins.split(",")}
    if (
        jwt is None
        or not _ISSUER.fullmatch(issuer)
        or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", audience)
        or not admins
        or len(admins) > 100
        or any(len(email) > 254 or not _EMAIL.fullmatch(email) for email in admins)
    ):
        raise AccountsAccessError(HTTPStatus.SERVICE_UNAVAILABLE, "Accounts access is not configured")
    return issuer, audience, admins


def _signing_keys(issuer: str) -> dict[str, Any]:
    # A bounded cache also prevents attacker-selected unknown kids from forcing
    # repeated network fetches. Rotated keys are picked up within five minutes.
    with _KEY_LOCK:
        now = time.monotonic()
        if _KEY_CACHE["issuer"] == issuer and now < _KEY_CACHE["expires"]:
            if _KEY_CACHE["unavailable"]:
                raise AccountsAccessError(HTTPStatus.SERVICE_UNAVAILABLE, "Accounts access verification unavailable", "ACCOUNTS_AUTH_UNAVAILABLE")
            return _KEY_CACHE["keys"]
        try:
            with requests.get(
                issuer + "/cdn-cgi/access/certs",
                headers={"Accept": "application/json"},
                timeout=(3.05, 10),
                allow_redirects=False,
                stream=True,
            ) as response:
                if response.status_code != HTTPStatus.OK:
                    raise ValueError("Signing keys unavailable")
                raw = bytearray()
                for chunk in response.iter_content(8192):
                    raw.extend(chunk)
                    if len(raw) > _MAX_JWKS_BYTES:
                        raise ValueError("Signing key response too large")
            body = json.loads(raw)
            key_rows = body.get("keys") if isinstance(body, dict) else None
            if not isinstance(key_rows, list) or not 1 <= len(key_rows) <= 32:
                raise ValueError("Invalid signing keys")
            keys = {}
            for row in key_rows:
                if not isinstance(row, dict):
                    continue
                kid = row.get("kid")
                if (
                    not isinstance(kid, str)
                    or not _KEY_ID.fullmatch(kid)
                    or row.get("kty") != "RSA"
                    or row.get("alg", "RS256") != "RS256"
                    or row.get("use", "sig") != "sig"
                ):
                    continue
                if kid in keys:
                    raise ValueError("Ambiguous signing key")
                key = RSAAlgorithm.from_jwk({name: row.get(name) for name in ("kty", "n", "e")})
                if not 2048 <= key.key_size <= 8192:
                    raise ValueError("Invalid signing key size")
                keys[kid] = key
            if not keys:
                raise ValueError("No usable signing keys")
        except (requests.RequestException, ValueError, TypeError, jwt.PyJWTError):
            _KEY_CACHE.update(issuer=issuer, keys={}, expires=time.monotonic() + _KEY_FAILURE_BACKOFF_SECONDS, unavailable=True)
            raise AccountsAccessError(HTTPStatus.SERVICE_UNAVAILABLE, "Accounts access verification unavailable", "ACCOUNTS_AUTH_UNAVAILABLE") from None
        _KEY_CACHE.update(issuer=issuer, keys=keys, expires=time.monotonic() + _KEY_TTL_SECONDS, unavailable=False)
        return keys


def _numeric_date(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def authorize_accounts_request(handler: Any) -> None:
    issuer, audience, admins = _configuration()
    assertions = handler.headers.get_all("Cf-Access-Jwt-Assertion", [])
    if len(assertions) != 1:
        raise AccountsAccessError(HTTPStatus.UNAUTHORIZED, "Accounts authentication required")
    assertion = assertions[0].strip()
    if not 1 <= len(assertion) <= 16 * 1024 or assertion.count(".") != 2:
        raise AccountsAccessError(HTTPStatus.UNAUTHORIZED, "Accounts authentication required")
    try:
        header = jwt.get_unverified_header(assertion)
        kid = header.get("kid")
        if header.get("alg") != "RS256" or not isinstance(kid, str) or not _KEY_ID.fullmatch(kid):
            raise ValueError("Invalid assertion header")
        key = _signing_keys(issuer).get(kid)
        if key is None:
            raise ValueError("Unknown signing key")
        claims = jwt.decode(
            assertion,
            key,
            algorithms=["RS256"],
            issuer=issuer,
            audience=audience,
            options={
                "require": ["exp", "iat", "iss", "aud", "sub", "email", "type"],
                "verify_iat": False,
            },
        )
        now = time.time()
        if (
            claims.get("type") != "app"
            or not isinstance(claims.get("sub"), str)
            or not claims["sub"].strip()
            or len(claims["sub"]) > 256
            or not _numeric_date(claims.get("exp"))
            or not _numeric_date(claims.get("iat"))
            or claims["iat"] > now + 5
            or claims["exp"] <= now
            or claims["exp"] <= claims["iat"]
            or ("nbf" in claims and (not _numeric_date(claims["nbf"]) or claims["nbf"] > now))
            or not isinstance(claims.get("email"), str)
        ):
            raise ValueError("Invalid assertion claims")
        email = claims["email"].strip().lower()
        if len(email) > 254 or not _EMAIL.fullmatch(email):
            raise ValueError("Invalid assertion email")
    except (jwt.PyJWTError, ValueError, TypeError, OverflowError):
        raise AccountsAccessError(HTTPStatus.UNAUTHORIZED, "Accounts authentication required") from None
    if email not in admins:
        raise AccountsAccessError(HTTPStatus.FORBIDDEN, "Accounts access denied")
