"""Private bounded Accounts administration and Media delivery reads."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from http import HTTPStatus
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlparse
from uuid import UUID

import requests

from uk_aq_dashboard_accounts_auth import AccountsAccessError, authorize_accounts_request
from uk_aq_dashboard_media_proxy import _media_base_url


MAX_REQUEST_TARGET_BYTES = 4096
MAX_RESPONSE_BYTES = 512 * 1024
_SUBSCRIPTION_FIELDS = (
    "id", "email", "status", "delivery_mode", "daily_time_local", "timezone",
    "confirmed_at", "created_at", "updated_at", "unsubscribed_at", "blocked_at", "block_reason",
    "consent_text_version", "mode_since_at", "confirmation_last_sent_at", "confirmed",
)
_DELIVERY_FIELDS = (
    "id", "subscription_id", "delivery_mode", "state", "created_at", "sent_at",
    "failed_at", "attempt_count", "selected_transport", "attempt_transport",
    "retry_hold", "error_class",
)
_OUTBOX_FIELDS = ("id", "work_type", "state", "created_at", "queued_at", "attempt_count", "error_class")
_STATUS = {"pending", "active", "unsubscribed", "blocked"}
_MODE = {"immediate", "daily"}
_DELIVERY_MODE = {"confirmation", "immediate", "daily"}
_DELIVERY_STATE = {"pending", "sending", "accepted", "temporary_failure", "permanent_failure", "unknown", "cancelled"}
_ERROR_CLASS = {
    None, "digest_size_requires_operator", "stale_smtp_claim", "stale_pre_submission_claim",
    "temporary_failure", "permanent_failure", "unknown", "subscription_service_unavailable",
    "work_retry_required", "unavailable",
}
_TRANSPORT = {None, "cloudflare_xoauth2", "pro_app_password"}
_OUTBOX_STATE = {"pending", "queued", "completed"}
_WORK_TYPE = {"confirmation_email", "approval_dispatch", "immediate_delivery", "daily_digest", "daily_scan", "confirmation_scan"}
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


class AccountsRequestError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code or {
            HTTPStatus.BAD_REQUEST: "INVALID_QUERY",
            HTTPStatus.NOT_FOUND: "NOT_FOUND",
            HTTPStatus.METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
            HTTPStatus.REQUEST_URI_TOO_LONG: "REQUEST_TOO_LARGE",
            HTTPStatus.SERVICE_UNAVAILABLE: "ACCOUNTS_SOURCE_NOT_CONFIGURED",
            HTTPStatus.BAD_GATEWAY: "ACCOUNTS_SOURCE_UNAVAILABLE",
        }[status]


def is_accounts_path(path: str) -> bool:
    return path == "/api/accounts" or path.startswith("/api/accounts/")


def _send_json(handler: Any, status: int, body: dict[str, Any]) -> None:
    payload = json.dumps(body, allow_nan=False, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(payload)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Pragma", "no-cache")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Referrer-Policy", "no-referrer")
    if status == HTTPStatus.METHOD_NOT_ALLOWED:
        handler.send_header("Allow", "GET, POST")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(payload)


def _bad_request() -> None:
    raise AccountsRequestError(HTTPStatus.BAD_REQUEST, "Invalid Accounts request")


def _query(raw: str, allowed: set[str]) -> dict[str, str]:
    if re.search(r"%(?![0-9a-fA-F]{2})", raw):
        _bad_request()
    try:
        rows = parse_qsl(raw, keep_blank_values=True, strict_parsing=True, max_num_fields=12, errors="strict")
    except (ValueError, UnicodeError):
        _bad_request()
    result = {}
    for name, value in rows:
        if name not in allowed or name in result or any(ord(char) < 32 or ord(char) == 127 for char in value):
            _bad_request()
        result[name] = value
    return result


def _integer(query: dict[str, str], key: str, default: int, minimum: int, maximum: int) -> int:
    raw = query.get(key, str(default))
    if not re.fullmatch(r"0|[1-9][0-9]{0,4}", raw):
        _bad_request()
    value = int(raw)
    if not minimum <= value <= maximum:
        _bad_request()
    return value


def _uuid(value: Any) -> str:
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        _bad_request()
    return str(UUID(value))


def _subscriptions_query(parsed: Any) -> tuple[dict[str, Any], bool]:
    if parsed.path == "/api/accounts/subscriptions":
        query = _query(parsed.query, {"search", "status", "delivery_mode", "sort", "direction", "limit", "offset"})
        search = query.get("search", "").strip().lower()
        status = query.get("status", "")
        mode = query.get("delivery_mode", "")
        sort = query.get("sort", "created_at")
        direction = query.get("direction", "desc")
        if (
            len(search) > 254
            or status not in _STATUS | {""}
            or mode not in _MODE | {""}
            or sort not in {"email", "created_at", "updated_at", "status"}
            or direction not in {"asc", "desc"}
        ):
            _bad_request()
        return {
            "search": search, "status": status, "delivery_mode": mode,
            "sort": sort, "direction": direction,
            "limit": _integer(query, "limit", 25, 1, 100),
            "offset": _integer(query, "offset", 0, 0, 10000),
        }, False
    detail_prefix = "/api/accounts/subscriptions/"
    if parsed.path.startswith(detail_prefix):
        if parsed.query:
            _bad_request()
        return {"subscription_id": _uuid(parsed.path[len(detail_prefix):])}, True
    raise AccountsRequestError(HTTPStatus.NOT_FOUND, "Accounts API route not found")


def _upstream_json(method: str, target: str, *, media: bool = False, **kwargs: Any) -> Any:
    try:
        with requests.request(method, target, timeout=(3.05, 20), allow_redirects=False, stream=True, **kwargs) as response:
            if media and response.status_code != HTTPStatus.OK:
                raise AccountsRequestError(HTTPStatus.SERVICE_UNAVAILABLE, "Authoritative Email Delivery reads are unavailable", "EMAIL_DELIVERY_UNAVAILABLE")
            if response.status_code in {401, 403, 404, 406, 503}:
                raise AccountsRequestError(HTTPStatus.SERVICE_UNAVAILABLE, "Accounts source unavailable", "ACCOUNTS_SOURCE_UNAVAILABLE")
            if response.status_code != HTTPStatus.OK:
                raise AccountsRequestError(HTTPStatus.BAD_GATEWAY, "Accounts source unavailable")
            raw = bytearray()
            for chunk in response.iter_content(8192):
                raw.extend(chunk)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise ValueError("Response too large")
        return json.loads(raw)
    except (requests.RequestException, ValueError, TypeError):
        raise AccountsRequestError(HTTPStatus.BAD_GATEWAY, "Accounts source unavailable") from None


def _invalid_source() -> None:
    raise AccountsRequestError(HTTPStatus.BAD_GATEWAY, "Accounts source unavailable")


def _safe_record(value: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        _invalid_source()
    result = {}
    for name in fields:
        item = value.get(name)
        if item is not None and not isinstance(item, (str, bool, int)):
            _invalid_source()
        # Preserve historical block-reason whitespace as JSON text; the UI escapes it.
        if isinstance(item, str) and (len(item) > 512 or (
                name != "block_reason" and any(ord(char) < 32 or ord(char) == 127 for char in item))):
            _invalid_source()
        result[name] = item
    return result


def _subscription(value: Any) -> dict[str, Any]:
    result = _safe_record(value, _SUBSCRIPTION_FIELDS)
    if (
        not isinstance(result["id"], str)
        or not _UUID.fullmatch(result["id"])
        or not isinstance(result["email"], str)
        or len(result["email"]) > 254
        or result["status"] not in _STATUS
        or result["delivery_mode"] not in _MODE
        or not isinstance(result["confirmed"], bool)
    ):
        _invalid_source()
    return result


def _pagination(raw: Any, query: dict[str, Any]) -> dict[str, Any]:
    if (
        not isinstance(raw, dict)
        or type(raw.get("limit")) is not int
        or type(raw.get("offset")) is not int
        or raw["limit"] != query["limit"]
        or raw["offset"] != query["offset"]
        or not isinstance(raw.get("has_more"), bool)
    ):
        _invalid_source()
    return {"limit": raw["limit"], "offset": raw["offset"], "has_more": raw["has_more"]}


def _subscription_rpc(handler: Any, headers_builder: Callable[..., dict[str, str]], name: str, body: dict[str, Any]) -> Any:
    base = str(getattr(handler.server, "base_url", "") or "").strip().rstrip("/")
    key = str(getattr(handler.server, "service_role_key", "") or "").strip()
    schema = str(os.getenv("UK_AQ_PUBLIC_SCHEMA", "uk_aq_public")).strip()
    try:
        url = urlparse(base)
        configured = (
            url.scheme == "https" and url.hostname and not url.username and not url.password
            and not url.port and url.path == "/rest/v1" and not url.query and not url.fragment
            and key and re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", schema)
        )
    except ValueError:
        configured = False
    if not configured:
        raise AccountsRequestError(HTTPStatus.SERVICE_UNAVAILABLE, "Accounts source is not configured")
    headers = headers_builder(key, write=True, schema=schema)
    headers.update({"Content-Type": "application/json", "Accept": "application/json", "Cache-Control": "no-store"})
    return _upstream_json("POST", base + "/rpc/" + name, headers=headers, json=body)


def _read_subscriptions(handler: Any, parsed: Any, headers_builder: Callable[..., dict[str, str]]) -> dict[str, Any]:
    query, detail = _subscriptions_query(parsed)
    payload = _subscription_rpc(handler, headers_builder, "uk_aq_news_subscriptions_admin_read", {"p_query": query})
    if not isinstance(payload, dict):
        _invalid_source()
    if detail:
        if "subscription" not in payload:
            _invalid_source()
        subscription = payload["subscription"]
        if subscription is None:
            return {"subscription": None}
        result = _subscription(subscription)
        if result["id"].lower() != query["subscription_id"]:
            _invalid_source()
        return {"subscription": result}
    items = payload.get("items")
    counts = payload.get("counts")
    if not isinstance(items, list) or len(items) > query["limit"] or not isinstance(counts, dict):
        _invalid_source()
    if any(type(counts.get(status)) is not int or counts[status] < 0 for status in _STATUS):
        _invalid_source()
    return {
        "items": [_subscription(item) for item in items],
        "counts": {status: counts[status] for status in sorted(_STATUS)},
        "pagination": _pagination(payload.get("pagination"), query),
    }


def _read_email_delivery(parsed: Any) -> dict[str, Any]:
    raw_query = _query(parsed.query, {"subscription_id", "limit", "offset", "days"})
    query = {
        "limit": _integer(raw_query, "limit", 25, 1, 100),
        "offset": _integer(raw_query, "offset", 0, 0, 10000),
        "days": _integer(raw_query, "days", 7, 1, 30),
    }
    if "subscription_id" in raw_query:
        query["subscription_id"] = _uuid(raw_query["subscription_id"])
    base = _media_base_url()
    token = str(os.getenv("UK_AQ_MEDIA_ADMIN_TOKEN") or "").strip()
    if not base or not token or len(token) > 4096:
        raise AccountsRequestError(HTTPStatus.SERVICE_UNAVAILABLE, "Email Delivery read access is not configured", "EMAIL_DELIVERY_UNAVAILABLE")
    payload = _upstream_json(
        "GET", base + "/admin/news-email/delivery?" + urlencode(query),
        media=True,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Cache-Control": "no-store"},
    )
    if not isinstance(payload, dict) or payload.get("available") is not True:
        raise AccountsRequestError(HTTPStatus.SERVICE_UNAVAILABLE, "Authoritative Email Delivery reads are unavailable", "EMAIL_DELIVERY_UNAVAILABLE")
    summary, deliveries, outbox = payload.get("summary"), payload.get("deliveries"), payload.get("outbox")
    if (
        not isinstance(summary, list) or len(summary) > 24
        or not isinstance(deliveries, list) or len(deliveries) > query["limit"]
        or not isinstance(outbox, list) or len(outbox) > query["limit"]
        or type(payload.get("window_days")) is not int or payload["window_days"] != query["days"]
    ):
        _invalid_source()
    safe_summary = [_safe_record(row, ("delivery_mode", "state", "count")) for row in summary]
    safe_deliveries = [_safe_record(row, _DELIVERY_FIELDS) for row in deliveries]
    safe_outbox = [_safe_record(row, _OUTBOX_FIELDS) for row in outbox]
    if any(
        type(row["count"]) is not int or row["count"] < 0
        or row["delivery_mode"] not in _DELIVERY_MODE or row["state"] not in _DELIVERY_STATE | {"held"}
        for row in safe_summary
    ):
        _invalid_source()
    for row in safe_deliveries:
        if (
            row["delivery_mode"] not in _DELIVERY_MODE or row["state"] not in _DELIVERY_STATE
            or row["selected_transport"] not in _TRANSPORT or row["attempt_transport"] not in _TRANSPORT
            or row["error_class"] not in _ERROR_CLASS or not isinstance(row["retry_hold"], bool)
            or type(row["attempt_count"]) is not int or row["attempt_count"] < 0
            or not isinstance(row["subscription_id"], str) or not _UUID.fullmatch(row["subscription_id"])
            or ("subscription_id" in query and row["subscription_id"].lower() != query["subscription_id"])
        ):
            _invalid_source()
    for row in safe_outbox:
        if (
            row["work_type"] not in _WORK_TYPE or row["state"] not in _OUTBOX_STATE
            or row["error_class"] not in _ERROR_CLASS
            or type(row["attempt_count"]) is not int or row["attempt_count"] < 0
        ):
            _invalid_source()
    return {
        "available": True,
        "summary": safe_summary,
        "deliveries": safe_deliveries,
        "outbox": safe_outbox,
        "pagination": _pagination(payload.get("pagination"), query),
        "window_days": query["days"],
    }


def _write_subscription(handler: Any, parsed: Any, headers_builder: Callable[..., dict[str, str]]) -> tuple[int, dict[str, Any]]:
    route = re.fullmatch(r"/api/accounts/subscriptions/([^/]+)/actions", parsed.path)
    if not route:
        raise AccountsRequestError(HTTPStatus.NOT_FOUND, "Accounts API route not found")
    subscription_id = _uuid(route[1])
    if parsed.query:
        _bad_request()
    origin = urlparse(handler.headers.get("Origin", ""))
    if (handler.headers.get("X-UKAQ-Accounts-Action") != "1" or origin.scheme != "https"
            or origin.netloc != handler.headers.get("Host") or origin.path or origin.query or origin.fragment
            or origin.username or origin.password
            or handler.headers.get("Sec-Fetch-Site") not in (None, "same-origin")):
        raise AccountsRequestError(HTTPStatus.FORBIDDEN, "Same-origin administrative action required", "FORBIDDEN")
    if (handler.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json"
            or handler.headers.get("Transfer-Encoding")):
        _bad_request()
    raw_length = handler.headers.get("Content-Length", "")
    if not re.fullmatch(r"[1-9][0-9]{0,3}", raw_length) or not 0 < int(raw_length) <= 4096:
        _bad_request()
    handler.connection.settimeout(10)
    raw = handler.rfile.read(int(raw_length))
    if len(raw) != int(raw_length):
        _bad_request()
    try:
        body = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        _bad_request()
    if not isinstance(body, dict):
        _bad_request()
    action = body.get("action")
    revision = body.get("expected_updated_at")
    if (not isinstance(action, str) or action not in {"edit", "block", "unblock", "unsubscribe", "delete"}
            or body.get("confirmed") is not True or not isinstance(revision, str)
            or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})", revision)):
        _bad_request()
    try:
        datetime.fromisoformat(revision)
    except ValueError:
        _bad_request()
    allowed = {"action", "confirmed", "expected_updated_at"}
    if action == "edit":
        allowed |= {"delivery_mode", "daily_time_local"}
        if (not isinstance(body.get("delivery_mode"), str) or body["delivery_mode"] not in _MODE
                or not isinstance(body.get("daily_time_local"), str)
                or not re.fullmatch(r"([01][0-9]|2[0-3]):[0-5][0-9]", body["daily_time_local"])):
            _bad_request()
    if action == "block":
        allowed.add("reason")
        reason = body.get("reason")
        if (not isinstance(reason, str) or not reason.strip() or len(reason) > 200
                or any(ord(c) < 32 or ord(c) == 127 for c in reason)):
            _bad_request()
    if body.keys() - allowed:
        _bad_request()
    payload = _subscription_rpc(handler, headers_builder, "uk_aq_news_subscriptions_admin_write",
                                {"p_request": {**body, "subscription_id": subscription_id}})
    if not isinstance(payload, dict):
        _invalid_source()
    if payload.get("ok") is False and payload.get("code") in {"NOT_FOUND", "CONFLICT"}:
        missing = payload["code"] == "NOT_FOUND"
        return (HTTPStatus.NOT_FOUND if missing else HTTPStatus.CONFLICT), {"error": {
            "code": payload["code"], "message": "Subscription no longer exists" if missing else
            "Subscription changed or action is unavailable; refresh detail"}}
    if (payload.get("ok") is not True or payload.get("subscription_id") != subscription_id
            or (action == "delete" and payload.get("deleted") is not True)):
        _invalid_source()
    return HTTPStatus.OK, {"ok": True, "subscription_id": subscription_id,
                           **({"deleted": True} if action == "delete" else {})}


def serve_accounts_request(handler: Any, headers_builder: Callable[..., dict[str, str]]) -> None:
    """Runs before existing optional bearer auth, response caches and dispatch."""
    try:
        authorize_accounts_request(handler)
        if len(handler.path.encode("utf-8")) > MAX_REQUEST_TARGET_BYTES:
            raise AccountsRequestError(HTTPStatus.REQUEST_URI_TOO_LONG, "Accounts request is too large")
        parsed = urlparse(handler.path)
        if parsed.fragment or parsed.params:
            _bad_request()
        if handler.command == "POST":
            status, payload = _write_subscription(handler, parsed, headers_builder)
            _send_json(handler, status, payload)
            return
        if handler.command != "GET":
            raise AccountsRequestError(HTTPStatus.METHOD_NOT_ALLOWED, "Unsupported Accounts method")
        if handler.headers.get("Transfer-Encoding") or handler.headers.get("Content-Length", "0") != "0":
            _bad_request()
        if parsed.path == "/api/accounts/email-delivery":
            payload = _read_email_delivery(parsed)
        else:
            payload = _read_subscriptions(handler, parsed, headers_builder)
        status = HTTPStatus.NOT_FOUND if payload == {"subscription": None} else HTTPStatus.OK
        _send_json(handler, status, payload)
    except (AccountsAccessError, AccountsRequestError) as exc:
        _send_json(handler, exc.status, {"error": {"code": exc.code, "message": exc.message}})
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        return
    except Exception:
        # Never log upstream bodies, assertions, identities or search parameters.
        _send_json(handler, HTTPStatus.BAD_GATEWAY, {"error": {
            "code": "ACCOUNTS_SOURCE_UNAVAILABLE",
            "message": "Accounts source unavailable; verify its environment configuration and required migrations",
        }})
