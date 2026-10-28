"""Cryptographically verify Cloudflare Access for private local Accounts reads."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from http import HTTPStatus
from typing import Any, Literal
from urllib.parse import urlsplit

try:
    import jwt
    from jwt import PyJWKClient
    from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError, PyJWTError
except ImportError:  # Keep non-Accounts dashboard APIs available without this dependency.
    jwt = None
    PyJWKClient = None
    PyJWKClientConnectionError = Exception
    PyJWKClientError = Exception
    PyJWTError = Exception


_EMAIL = re.compile(r"[^\s@,]+@[^\s@,]+\.[^\s@,]+")
_ISSUER_HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com")
_AUDIENCE = re.compile(r"[A-Za-z0-9_-]{16,256}")
_KID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_MAX_ASSERTION_BYTES = 16 * 1024
_MAX_SUBJECT_LENGTH = 256
_MAX_EMAIL_LENGTH = 254

_jwks_lock = threading.Lock()
_jwks_issuer: str | None = None
_jwks_client: Any = None


class AccountsAccessError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code or {
            HTTPStatus.SERVICE_UNAVAILABLE: "ACCOUNTS_AUTH_NOT_CONFIGURED",
            HTTPStatus.UNAUTHORIZED: "UNAUTHORIZED",
        }[status]


_AccessDiagnostic = Literal[
    "ACCESS_JWT_DEPENDENCY_MISSING",
    "ACCESS_TRUST_CONFIG_MISSING",
    "ACCESS_TRUST_CONFIG_INVALID",
    "ACCESS_ASSERTION_MISSING_OR_MALFORMED",
    "ACCESS_JWKS_UNAVAILABLE",
    "ACCESS_JWKS_KEY_UNAVAILABLE",
    "ACCESS_JWT_INVALID",
    "ACCESS_PERSONAL_IDENTITY_REQUIRED",
]


def _access_error(
    diagnostic: _AccessDiagnostic,
    status: int = HTTPStatus.UNAUTHORIZED,
    upstream_status: int | None = None,
) -> AccountsAccessError:
    event = {"event": "accounts_access_failed", "code": diagnostic}
    if type(upstream_status) is int and 100 <= upstream_status <= 599:
        event["upstream_status"] = upstream_status
    logging.getLogger(__name__).warning(json.dumps(event, separators=(",", ":")))
    if status == HTTPStatus.SERVICE_UNAVAILABLE:
        message = "Accounts access is not configured"
    else:
        message = "Accounts authentication required"
    return AccountsAccessError(status, message)


def _trusted_configuration() -> tuple[str, str]:
    issuer = os.getenv("UK_AQ_LOCAL_ACCOUNTS_ACCESS_ISSUER")
    audience = os.getenv("UK_AQ_LOCAL_ACCOUNTS_ACCESS_AUD")
    if not issuer or not audience:
        raise _access_error("ACCESS_TRUST_CONFIG_MISSING", HTTPStatus.SERVICE_UNAVAILABLE)

    try:
        parts = urlsplit(issuer)
        hostname = parts.hostname
        valid_issuer = (
            issuer == issuer.strip()
            and parts.scheme == "https"
            and hostname is not None
            and hostname == hostname.lower()
            and _ISSUER_HOST.fullmatch(hostname) is not None
            and parts.netloc == hostname
            and not parts.username
            and not parts.password
            and parts.path == ""
            and not parts.query
            and not parts.fragment
        )
    except ValueError:
        valid_issuer = False
    if not valid_issuer or audience != audience.strip() or not _AUDIENCE.fullmatch(audience):
        raise _access_error("ACCESS_TRUST_CONFIG_INVALID", HTTPStatus.SERVICE_UNAVAILABLE)
    return issuer, audience


def _get_jwks_client(issuer: str) -> Any:
    global _jwks_client, _jwks_issuer
    if PyJWKClient is None:
        raise _access_error("ACCESS_JWT_DEPENDENCY_MISSING", HTTPStatus.SERVICE_UNAVAILABLE)
    with _jwks_lock:
        if _jwks_client is None or _jwks_issuer != issuer:
            # The URL is derived only from validated backend configuration. PyJWT
            # caches the JWKS for five minutes and rate-limits unknown-kid refreshes,
            # allowing Cloudflare key rotation without trusting a token URL.
            _jwks_client = PyJWKClient(
                issuer + "/cdn-cgi/access/certs",
                cache_jwk_set=True,
                lifespan=300,
                timeout=5,
                cache_keys=False,
                cooldown_duration=30,
            )
            _jwks_issuer = issuer
        return _jwks_client


def _verify_personal_access_jwt(assertion: str, issuer: str, audience: str) -> None:
    try:
        header = jwt.get_unverified_header(assertion)
    except (PyJWTError, TypeError, ValueError):
        raise _access_error("ACCESS_JWT_INVALID") from None
    if not isinstance(header, dict) or header.get("alg") != "RS256" or \
            not isinstance(header.get("kid"), str) or not _KID.fullmatch(header["kid"]):
        raise _access_error("ACCESS_JWT_INVALID")

    try:
        client = _get_jwks_client(issuer)
        # Serialize cache misses so concurrent unknown-kid requests do not cause
        # a burst of duplicate certificate fetches during rotation.
        with _jwks_lock:
            signing_key = client.get_signing_key_from_jwt(assertion).key
    except AccountsAccessError:
        raise
    except PyJWKClientConnectionError:
        raise _access_error("ACCESS_JWKS_UNAVAILABLE") from None
    except PyJWKClientError:
        # Includes malformed key sets and a kid still absent after refresh.
        raise _access_error("ACCESS_JWKS_KEY_UNAVAILABLE") from None
    except Exception:
        raise _access_error("ACCESS_JWKS_UNAVAILABLE") from None

    try:
        claims = jwt.decode(
            assertion,
            signing_key,
            algorithms=["RS256"],
            audience=audience,
            issuer=issuer,
            options={
                "require": ["iss", "aud", "exp", "iat", "nbf", "sub", "email", "type"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_iat": True,
                "verify_nbf": True,
                "verify_iss": True,
                "verify_aud": True,
            },
        )
    except (PyJWTError, TypeError, ValueError, OverflowError):
        raise _access_error("ACCESS_JWT_INVALID") from None

    # Cloudflare's service-token application JWT has an empty subject and a
    # common_name; a personal identity token has a non-empty subject and the
    # identity-provider-verified email claim. Reject service shape explicitly.
    subject = claims.get("sub")
    email = claims.get("email")
    if (
        claims.get("type") != "app"
        or "common_name" in claims
        or not isinstance(subject, str)
        or not subject
        or subject != subject.strip()
        or len(subject) > _MAX_SUBJECT_LENGTH
        or any(ord(char) < 32 or ord(char) == 127 for char in subject)
        or not isinstance(email, str)
        or len(email) > _MAX_EMAIL_LENGTH
        or not _EMAIL.fullmatch(email)
    ):
        raise _access_error("ACCESS_PERSONAL_IDENTITY_REQUIRED")


def authorize_accounts_request(handler: Any) -> None:
    """Require a personal JWT for this local Access application on every call."""
    if jwt is None:
        raise _access_error("ACCESS_JWT_DEPENDENCY_MISSING", HTTPStatus.SERVICE_UNAVAILABLE)
    issuer, audience = _trusted_configuration()

    assertions = handler.headers.get_all("Cf-Access-Jwt-Assertion", [])
    if len(assertions) != 1:
        raise _access_error("ACCESS_ASSERTION_MISSING_OR_MALFORMED")
    assertion = assertions[0]
    try:
        encoded = assertion.encode("ascii")
    except (AttributeError, UnicodeError):
        raise _access_error("ACCESS_ASSERTION_MISSING_OR_MALFORMED") from None
    if (
        not 1 <= len(encoded) <= _MAX_ASSERTION_BYTES
        or assertion.count(".") != 2
        or any(char.isspace() for char in assertion)
    ):
        raise _access_error("ACCESS_ASSERTION_MISSING_OR_MALFORMED")

    _verify_personal_access_jwt(assertion, issuer, audience)
