"""Narrow server-side compatibility proxy for the authoritative Media admin API."""

from __future__ import annotations

import json
import os
import re
from http import HTTPStatus
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse

import requests


MAX_BODY_BYTES = 16 * 1024
MAX_LOCAL_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024
MEDIA_TIMEOUT_SECONDS = 30
BROWSER_IMAGE_CACHE_CONTROL = "private, max-age=604800, immutable"
_ARTICLE_IMAGE_PATH = re.compile(r"^/api/media/articles/[1-9]\d*/image$")
_ARTICLE_LOCAL_IMAGE_PATH = re.compile(r"^/api/media/articles/[1-9]\d*/local-image$")
_LOCAL_IMAGE_VERSION = re.compile(r"^[a-f0-9]{64}$")

_ROUTES = (
    (re.compile(r"^/api/media/articles$"), {"GET", "POST"}),
    (re.compile(r"^/api/media/articles/selectors$"), {"GET"}),
    (re.compile(r"^/api/media/articles/lookup$"), {"POST"}),
    (re.compile(r"^/api/media/articles/bulk-approve$"), {"POST"}),
    (re.compile(r"^/api/media/articles/bulk-publish$"), {"POST"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*$"), {"GET"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/image$"), {"GET"}),
    (_ARTICLE_LOCAL_IMAGE_PATH, {"PUT", "DELETE"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/publish$"), {"POST"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/(?:approve|reject|hide|unhide)$"), {"POST"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/author$"), {"PUT"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/published-at$"), {"PUT"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/display-title$"), {"PUT"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/display-title/generate-ai$"), {"POST"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/display-title/(?:accept-ai|reject-ai)$"), {"POST"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/guardian-image-refresh/(?:preview|apply)$"), {"POST"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/metadata/preview$"), {"POST"}),
    (re.compile(r"^/api/media/articles/[1-9]\d*/metadata/apply$"), {"PUT"}),
    (re.compile(r"^/api/media/(?:ai-titles|ai-usage|runs)$"), {"GET"}),
    (re.compile(r"^/api/media/runs/gdelt$"), {"GET"}),
    (re.compile(r"^/api/media/sources$"), {"GET", "POST"}),
    (re.compile(r"^/api/media/sources/[a-z0-9]+(?:-[a-z0-9]+)*$"), {"PUT"}),
    (re.compile(r"^/api/media/author-rules$"), {"POST"}),
    (re.compile(r"^/api/media/author-rules/[a-z0-9]+:[a-z0-9]+(?:-[a-z0-9]+)*$"), {"PUT"}),
    (re.compile(r"^/api/media/bluesky/settings$"), {"GET", "PUT"}),
    (re.compile(r"^/api/media/facebook/settings$"), {"GET", "PUT"}),
    (re.compile(r"^/api/media/facebook/connection-check$"), {"POST"}),
)


def is_media_path(path: str) -> bool:
    return any(pattern.fullmatch(path) for pattern, _methods in _ROUTES)


def _send_json(handler: Any, status: int, error: str) -> None:
    payload = json.dumps({"error": error}).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(payload)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.end_headers()
    handler.wfile.write(payload)


def _media_base_url() -> str | None:
    raw = str(os.getenv("UK_AQ_MEDIA_ADMIN_URL") or "").strip().rstrip("/")
    if not raw:
        return None
    try:
        parsed = urlparse(raw)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.port
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            return None
        return f"https://{parsed.hostname}"
    except ValueError:
        return None


def proxy_media_request(handler: Any, method: str) -> None:
    parsed = urlparse(handler.path)
    route = next(
        ((pattern, methods) for pattern, methods in _ROUTES if pattern.fullmatch(parsed.path)),
        None,
    )
    if route is None:
        _send_json(handler, HTTPStatus.NOT_FOUND, "Media API route not found")
        return
    if method not in route[1]:
        _send_json(handler, HTTPStatus.METHOD_NOT_ALLOWED, "Method not supported for this Media route")
        return

    base_url = _media_base_url()
    token = str(os.getenv("UK_AQ_MEDIA_ADMIN_TOKEN") or "").strip()
    if not base_url or not token:
        _send_json(handler, HTTPStatus.SERVICE_UNAVAILABLE, "Media admin unavailable")
        return

    content_length_text = str(handler.headers.get("Content-Length") or "0")
    try:
        content_length = int(content_length_text)
    except ValueError:
        _send_json(handler, HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
        return
    max_body_bytes = (
        MAX_LOCAL_IMAGE_UPLOAD_BYTES
        if method == "PUT" and _ARTICLE_LOCAL_IMAGE_PATH.fullmatch(parsed.path)
        else MAX_BODY_BYTES
    )
    if content_length < 0 or content_length > max_body_bytes:
        _send_json(handler, HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Media request body is too large")
        return
    body = handler.rfile.read(content_length) if content_length else None
    if body is not None and len(body) > max_body_bytes:
        _send_json(handler, HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Media request body is too large")
        return

    explicit_paths = {
        "/api/media/articles/bulk-approve": "/articles/bulk/approve",
        "/api/media/articles/bulk-publish": "/articles/bulk/publish",
    }
    upstream_path = explicit_paths.get(parsed.path, parsed.path.removeprefix("/api/media"))
    query_items = parse_qsl(parsed.query, keep_blank_values=True)
    image_version = next((value.strip() for name, value in query_items if name == "v" and value.strip()), "")
    has_image_version = method == "GET" and bool(image_version) and bool(
        _ARTICLE_IMAGE_PATH.fullmatch(parsed.path)
    )
    is_versioned_remote_image = has_image_version and not _LOCAL_IMAGE_VERSION.fullmatch(
        image_version
    )
    upstream_query = urlencode(
        [(name, value) for name, value in query_items if not (has_image_version and name == "v")],
        doseq=True,
    )
    target = f"{base_url}/admin{upstream_path}"
    if upstream_query:
        target = f"{target}?{upstream_query}"
    headers = {"Authorization": f"Bearer {token}", "Accept": handler.headers.get("Accept", "*/*")}
    content_type = handler.headers.get("Content-Type")
    idempotency_key = handler.headers.get("Idempotency-Key")
    article_revision = handler.headers.get("If-Match")
    if content_type:
        headers["Content-Type"] = content_type
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    if content_length:
        headers["Content-Length"] = str(content_length)
    if article_revision:
        headers["If-Match"] = article_revision

    try:
        upstream = requests.request(
            method,
            target,
            headers=headers,
            data=body,
            timeout=MEDIA_TIMEOUT_SECONDS,
            allow_redirects=False,
            stream=True,
        )
    except requests.RequestException:
        _send_json(handler, HTTPStatus.BAD_GATEWAY, "Media admin unavailable")
        return

    try:
        handler.send_response(upstream.status_code)
        for name in ("Content-Type", "Content-Length", "ETag", "Last-Modified"):
            value = upstream.headers.get(name)
            if value:
                handler.send_header(name, value)
        response_content_type = str(upstream.headers.get("Content-Type") or "").lower()
        upstream_no_store = "no-store" in str(
            upstream.headers.get("Cache-Control") or ""
        ).lower()
        cache_control = BROWSER_IMAGE_CACHE_CONTROL if (
            is_versioned_remote_image
            and 200 <= upstream.status_code < 300
            and response_content_type.startswith("image/")
            and not upstream_no_store
        ) else "no-store"
        handler.send_header("Cache-Control", cache_control)
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.end_headers()
        for chunk in upstream.iter_content(chunk_size=64 * 1024):
            if chunk:
                handler.wfile.write(chunk)
    finally:
        upstream.close()
