#!/usr/bin/env python3
"""
Run a local HTTP dashboard for UK AQ freshness buckets (PM2.5 + PM10).
"""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
import re
import secrets
import threading
import warnings
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import parse_qs, urlparse

# Local macOS Python builds can emit this on every import; it's noisy for local logs.
warnings.filterwarnings(
    "ignore",
    message=r"urllib3 v2 only supports OpenSSL 1\.1\.1\+.*",
)
import requests

NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
POLLUTANTS = {
    "pm25": {"label": "PM2.5", "tokens": ("pm25", "pm2.5", "pm2-5", "pm2_5")},
    "pm10": {"label": "PM10", "tokens": ("pm10",)},
    "no2": {"label": "NO2", "tokens": ("no2",)},
}
BUCKETS = ("0-3 Hours", "3-6 Hours", "6-24 Hours", "1 - 7 Days", "Older than 7 Days")
EXCLUDED_CONNECTORS_BY_POLLUTANT = {
    "pm10": {"breathelondon"},
    "no2": {"sensorcommunity"},
}
DISPATCH_OBSERVS_WINDOW_MINUTES = max(
    30,
    int(os.getenv("DISPATCH_OBSERVS_WINDOW_MINUTES", "240")),
)
DISPATCH_FETCH_LIMIT = max(
    100,
    int(os.getenv("DISPATCH_FETCH_LIMIT", "1000")),
)
DISPATCH_INCREMENTAL_OVERLAP_SECONDS = max(
    30,
    int(os.getenv("DISPATCH_INCREMENTAL_OVERLAP_SECONDS", "120")),
)
DISPATCH_MAX_ROWS = max(
    200,
    int(os.getenv("DISPATCH_MAX_ROWS", "5000")),
)
DB_SIZE_LOOKBACK_DAYS = max(
    1,
    int(os.getenv("UK_AQ_DB_SIZE_LOOKBACK_DAYS", "28")),
)
METRICS_VIEW_PAGE_SIZE = 1000
EXTERNAL_METRICS_MAX_LAG = timedelta(hours=6)
EXTERNAL_SCHEMA_MISSING_WARNING = "External DB size API payload missing usable schema_size_metrics rows"
EXTERNAL_SCHEMA_LAG_WARNING = "External DB size API returned lagging schema_size_metrics window"
EXTERNAL_R2_MISSING_WARNING = "External DB size API payload missing usable r2_domain_size_metrics rows"
EXTERNAL_R2_LAG_WARNING = "External DB size API returned lagging r2_domain_size_metrics window"
DB_SIZE_API_URL = str(os.getenv("UK_AQ_DB_SIZE_API_URL") or "").strip()
DB_SIZE_API_TOKEN = str(os.getenv("UK_AQ_DB_SIZE_API_TOKEN") or "").strip()
R2_HISTORY_DAYS_API_URL = str(os.getenv("UK_AQ_R2_HISTORY_DAYS_API_URL") or "").strip()
R2_HISTORY_DAYS_API_TOKEN = str(
    os.getenv("UK_AQ_R2_HISTORY_DAYS_API_TOKEN") or DB_SIZE_API_TOKEN
).strip()
R2_HISTORY_COUNTS_API_URL = str(os.getenv("UK_AQ_R2_HISTORY_COUNTS_API_URL") or "").strip()
R2_HISTORY_COUNTS_API_TOKEN = str(
    os.getenv("UK_AQ_R2_HISTORY_COUNTS_API_TOKEN") or R2_HISTORY_DAYS_API_TOKEN
).strip()
try:
    _raw_r2_history_days_max = int(str(os.getenv("UK_AQ_R2_HISTORY_DAYS_API_MAX_DAYS", "3660")).strip())
except ValueError:
    _raw_r2_history_days_max = 3660
R2_HISTORY_DAYS_API_MAX_DAYS = max(1, min(3660, _raw_r2_history_days_max))
OBS_AQIDB_SUPABASE_URL = str(os.getenv("OBS_AQIDB_SUPABASE_URL") or "").strip()
OBS_AQIDB_SECRET_KEY = str(os.getenv("OBS_AQIDB_SECRET_KEY") or "").strip()
PUBLIC_SCHEMA = os.getenv("UK_AQ_PUBLIC_SCHEMA", "uk_aq_public")
R2_BACKUP_WINDOW_RPC = os.getenv("UK_AQ_R2_HISTORY_WINDOW_RPC", "uk_aq_rpc_r2_history_window")
STATION_SNAPSHOT_RPC = os.getenv("UK_AQ_STATION_SNAPSHOT_RPC", "uk_aq_station_snapshot")
STATION_SNAPSHOT_DEFAULT_STATION_ID = str(os.getenv("CLEANAIRSURB_ST_ID") or "").strip()
STATION_SNAPSHOT_DEFAULT_OBS_LIMIT = str(
    os.getenv("UK_AQ_STATION_SNAPSHOT_DEFAULT_OBS_LIMIT") or "all"
).strip().lower()
UK_AQ_DROPBOX_ROOT = str(os.getenv("UK_AQ_DROPBOX_ROOT") or "CIC-Test").strip()
UK_AQ_DROPBOX_LOCAL_ROOT = str(os.getenv("UK_AQ_DROPBOX_LOCAL_ROOT") or "").strip()
UK_AQ_DROPBOX_APP_FOLDER = str(os.getenv("UK_AQ_DROPBOX_APP_FOLDER") or "").strip()
UK_AQ_R2_HISTORY_DROPBOX_DIR = str(
    os.getenv("UK_AQ_R2_HISTORY_DROPBOX_DIR") or "R2_history_backup"
).strip()
UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH = str(
    os.getenv("UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH")
    or "_ops/checkpoints/r2_history_backup_state_v1.json"
).strip()
UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE = str(
    os.getenv("UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE") or ""
).strip()
DROPBOX_APP_KEY = str(os.getenv("DROPBOX_APP_KEY") or "").strip()
DROPBOX_APP_SECRET = str(os.getenv("DROPBOX_APP_SECRET") or "").strip()
DROPBOX_REFRESH_TOKEN = str(os.getenv("DROPBOX_REFRESH_TOKEN") or "").strip()
DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token"
DROPBOX_CONTENT_API_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download"
DROPBOX_API_TIMEOUT_SECONDS = 30
IN_FLIGHT_WARN_MINUTES = 5
IN_FLIGHT_MAX_AGE_MINUTES = 180
SCHEDULER_BACKEND_SUPABASE_FUNCTION = "supabase_function"
SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN = "google_cloud_run"
SCHEDULER_BACKEND_ALLOWED = {
    SCHEDULER_BACKEND_SUPABASE_FUNCTION,
    SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN,
}
SCHEDULER_BACKEND_CONNECTOR_ALLOWLIST = {
    "uk_air_sos",
    "sensorcommunity",
    "breathelondon",
    "openaq"
}

CACHE_LOCK = threading.Lock()
CACHE_STATE: Dict[str, Dict[str, Any]] = {
    "with_coverage": {"data": None, "generated_at": None},
    "without_coverage": {"data": None, "generated_at": None},
}
R2_CACHE_STATE: Dict[str, Any] = {"usage": None, "error": None, "generated_at": None}
R2_HISTORY_DAYS_CACHE_STATE: Dict[str, Any] = {
    "day_sets": None,
    "window": None,
    "bucket": None,
    "error": None,
    "generated_at": None,
}
STORAGE_COVERAGE_CACHE_STATE: Dict[str, Any] = {"rows": None, "next_refresh_at": None}
DISPATCH_RUNS_STATE: Dict[str, Any] = {
    "rows": [],
    "latest_created_at": None,
}
CACHE_TTL_SECONDS = 20
R2_CACHE_TTL_SECONDS = 60 * 60
R2_HISTORY_DAYS_CACHE_TTL_SECONDS = 5 * 60
STORAGE_COVERAGE_CACHE_TTL_SECONDS = 6 * 60 * 60
UTC_DATETIME_MIN = datetime.min.replace(tzinfo=timezone.utc)
R2_BYTES_PER_GB = 1024 ** 3
R2_CLASS_A_ACTION_TYPES = {
    "ListBuckets",
    "PutBucket",
    "ListObjects",
    "PutObject",
    "CopyObject",
    "CompleteMultipartUpload",
    "CreateMultipartUpload",
    "LifecycleStorageTierTransition",
    "ListMultipartUploads",
    "UploadPart",
    "UploadPartCopy",
    "ListParts",
    "PutBucketEncryption",
    "PutBucketCors",
    "PutBucketLifecycleConfiguration",
}
R2_CLASS_B_ACTION_TYPES = {
    "HeadBucket",
    "HeadObject",
    "GetObject",
    "UsageSummary",
    "GetBucketEncryption",
    "GetBucketLocation",
    "GetBucketCors",
    "GetBucketLifecycleConfiguration",
}
R2_FREE_ACTION_TYPES = {
    "DeleteObject",
    "DeleteObjects",
    "DeleteBucket",
    "AbortMultipartUpload",
}
R2_OPS_GQL_QUERY = """
query R2OpsMonth($accountTag: string!, $startDate: Time!, $endDate: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(
        limit: 10000
        filter: {
          datetime_geq: $startDate
          datetime_leq: $endDate
        }
      ) {
        sum {
          requests
        }
        dimensions {
          actionType
        }
      }
    }
  }
}
"""
R2_STORAGE_GQL_QUERY = """
query R2StorageNow($accountTag: string!, $startDate: Time!, $endDate: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2StorageAdaptiveGroups(
        limit: 1000
        filter: {
          datetime_geq: $startDate
          datetime_leq: $endDate
        }
      ) {
        dimensions {
          bucketName
          storageClass
        }
        max {
          objectCount
          payloadSize
          metadataSize
        }
      }
    }
  }
}
"""


def _dashboard_cache_bucket(include_storage_coverage: bool) -> str:
    return "with_coverage" if include_storage_coverage else "without_coverage"


def _invalidate_dashboard_cache(clear_storage_coverage: bool = False) -> None:
    with CACHE_LOCK:
        for cache_bucket in ("with_coverage", "without_coverage"):
            bucket_state = CACHE_STATE.get(cache_bucket)
            if isinstance(bucket_state, dict):
                bucket_state["data"] = None
                bucket_state["generated_at"] = None
        if clear_storage_coverage:
            STORAGE_COVERAGE_CACHE_STATE["rows"] = None
            STORAGE_COVERAGE_CACHE_STATE["next_refresh_at"] = None


def _normalize_token(value: str) -> str:
    return NON_ALNUM_RE.sub("", value.lower())


NORMALIZED_POLLUTANT_TOKENS = {
    pollutant_key: tuple(_normalize_token(token) for token in config["tokens"])
    for pollutant_key, config in POLLUTANTS.items()
}


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _postgrest_headers(
    service_role_key: str,
    write: bool = False,
    schema: Optional[str] = None,
) -> Dict[str, str]:
    target_schema = schema or os.getenv("UK_AQ_CORE_SCHEMA", "uk_aq_core")
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Accept-Profile": target_schema,
    }
    if write:
        headers["Content-Profile"] = target_schema
    return headers


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _jwt_role(token: str) -> Optional[str]:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload = json.loads(_base64url_decode(parts[1]).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    role = payload.get("role")
    return role if isinstance(role, str) else None


def _project_ref_from_base_url(base_url: str) -> Optional[str]:
    parsed = urlparse(base_url)
    host = parsed.netloc or parsed.path
    host = host.split("/")[0]
    if not host:
        return None
    if host.endswith(".supabase.co"):
        return host.split(".")[0]
    return host


def _request_path(url: str) -> str:
    parsed = urlparse(url)
    return parsed.path or url


def _resolve_r2_history_days_api_url() -> str:
    if R2_HISTORY_DAYS_API_URL:
        return R2_HISTORY_DAYS_API_URL
    if not DB_SIZE_API_URL:
        return ""

    parsed = urlparse(DB_SIZE_API_URL)
    if not parsed.scheme or not parsed.netloc:
        return ""
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return f"{origin}/v1/r2-history-days"


def _resolve_r2_history_counts_api_url() -> str:
    if R2_HISTORY_COUNTS_API_URL:
        return R2_HISTORY_COUNTS_API_URL
    if R2_HISTORY_DAYS_API_URL:
        parsed = urlparse(R2_HISTORY_DAYS_API_URL)
    elif DB_SIZE_API_URL:
        parsed = urlparse(DB_SIZE_API_URL)
    else:
        return ""

    if not parsed.scheme or not parsed.netloc:
        return ""
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return f"{origin}/v1/r2-history-counts"


def _ensure_allowed_base_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"https", "http"}:
        raise ValueError(f"Unsupported URL scheme for base URL: {parsed.scheme}")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("Missing hostname in base URL.")
    if host in {"localhost", "127.0.0.1"}:
        return base_url.rstrip("/")
    if host.endswith(".supabase.co") or host.endswith(".supabase.in"):
        return base_url.rstrip("/")
    raise ValueError(f"Unsupported host for base URL: {host}")


def _safe_response_text(resp: requests.Response, max_chars: int = 500) -> str:
    text = (resp.text or "").strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "...(truncated)"


def _cloudflare_graphql_error_summary(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    raw_errors = payload.get("errors")
    if not isinstance(raw_errors, list) or not raw_errors:
        return None

    messages: List[str] = []
    seen: Set[str] = set()
    for item in raw_errors:
        if isinstance(item, dict):
            message = str(item.get("message") or "").strip()
            if not message:
                continue
            path = item.get("path")
            if isinstance(path, list) and path:
                path_text = ".".join(str(part) for part in path)
                message = f"{message} ({path_text})"
        else:
            message = str(item or "").strip()
        if not message or message in seen:
            continue
        seen.add(message)
        messages.append(message)
        if len(messages) >= 3:
            break

    if not messages:
        return None
    return "; ".join(messages)


def _safe_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return float(value)
    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return None
        try:
            parsed = float(candidate)
        except ValueError:
            return None
        if not math.isfinite(parsed):
            return None
        return parsed
    return None


def _safe_nonnegative_number(value: Any) -> Optional[float]:
    parsed = _safe_number(value)
    if parsed is None or parsed < 0:
        return None
    return parsed


def _clamp_percent(value: float) -> float:
    return max(0.0, min(200.0, value))


def _extract_r2_usage_point(raw: Any) -> Optional[Dict[str, float]]:
    if not isinstance(raw, dict):
        return None
    payload_size = _safe_nonnegative_number(raw.get("payloadSize"))
    metadata_size = _safe_nonnegative_number(raw.get("metadataSize"))
    objects = _safe_nonnegative_number(raw.get("objects"))
    if payload_size is None or metadata_size is None or objects is None:
        return None
    return {
        "used_bytes": payload_size + metadata_size,
        "objects": objects,
    }


def _fetch_r2_operations_metrics(
    account_id: str,
    api_token: str,
    now: datetime,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    window_end = now.astimezone(timezone.utc)
    window_start = window_end.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    try:
        resp = requests.post(
            "https://api.cloudflare.com/client/v4/graphql",
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
            },
            json={
                "query": R2_OPS_GQL_QUERY,
                "variables": {
                    "accountTag": account_id,
                    "startDate": window_start.isoformat().replace("+00:00", "Z"),
                    "endDate": window_end.isoformat().replace("+00:00", "Z"),
                },
            },
            timeout=30,
        )
    except requests.RequestException as exc:
        return None, f"R2 ops request failed ({exc.__class__.__name__})"
    if not resp.ok:
        return None, f"R2 ops HTTP {resp.status_code}"

    try:
        payload = resp.json()
    except ValueError:
        return None, "R2 ops returned non-JSON payload"
    if not isinstance(payload, dict):
        return None, "R2 ops payload is not an object"
    if payload.get("errors"):
        details = _cloudflare_graphql_error_summary(payload)
        if details:
            return None, f"R2 ops GraphQL returned errors: {details}"
        return None, "R2 ops GraphQL returned errors"

    data = payload.get("data")
    if not isinstance(data, dict):
        return None, "R2 ops missing data object"
    viewer = data.get("viewer")
    if not isinstance(viewer, dict):
        return None, "R2 ops missing viewer object"
    accounts = viewer.get("accounts")
    if not isinstance(accounts, list) or not accounts:
        return None, "R2 ops missing account data"
    account_row = accounts[0]
    if not isinstance(account_row, dict):
        return None, "R2 ops account row is invalid"
    groups = account_row.get("r2OperationsAdaptiveGroups")
    if not isinstance(groups, list):
        return None, "R2 ops missing operations groups"

    class_a_requests = 0.0
    class_b_requests = 0.0
    free_requests = 0.0
    unclassified_requests = 0.0
    unclassified_action_types: List[str] = []
    unclassified_seen: set[str] = set()
    for group in groups:
        if not isinstance(group, dict):
            continue
        dimensions = group.get("dimensions")
        totals = group.get("sum")
        if not isinstance(dimensions, dict) or not isinstance(totals, dict):
            continue
        action_type = str(dimensions.get("actionType") or "").strip()
        if not action_type:
            continue
        requests_count = _safe_nonnegative_number(totals.get("requests"))
        if requests_count is None:
            continue
        if action_type in R2_CLASS_A_ACTION_TYPES:
            class_a_requests += requests_count
        elif action_type in R2_CLASS_B_ACTION_TYPES:
            class_b_requests += requests_count
        elif action_type in R2_FREE_ACTION_TYPES or action_type.lower().startswith("delete"):
            free_requests += requests_count
        else:
            unclassified_requests += requests_count
            if action_type not in unclassified_seen:
                unclassified_seen.add(action_type)
                unclassified_action_types.append(action_type)

    return {
        "class_a_requests": int(round(class_a_requests)),
        "class_b_requests": int(round(class_b_requests)),
        "free_requests": int(round(free_requests)),
        "unclassified_requests": int(round(unclassified_requests)),
        "unclassified_action_types": sorted(unclassified_action_types),
        "window_start_utc": window_start.isoformat().replace("+00:00", "Z"),
        "window_end_utc": window_end.isoformat().replace("+00:00", "Z"),
    }, None


def _fetch_r2_storage_fallback_metrics(
    account_id: str,
    api_token: str,
    now: datetime,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    window_end = now.astimezone(timezone.utc)
    # Short lookback keeps this close to current bucket-state in Cloudflare UI.
    window_start = window_end - timedelta(hours=2)
    try:
        resp = requests.post(
            "https://api.cloudflare.com/client/v4/graphql",
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
            },
            json={
                "query": R2_STORAGE_GQL_QUERY,
                "variables": {
                    "accountTag": account_id,
                    "startDate": window_start.isoformat().replace("+00:00", "Z"),
                    "endDate": window_end.isoformat().replace("+00:00", "Z"),
                },
            },
            timeout=30,
        )
    except requests.RequestException as exc:
        return None, f"R2 storage fallback request failed ({exc.__class__.__name__})"
    if not resp.ok:
        return None, f"R2 storage fallback HTTP {resp.status_code}"

    try:
        payload = resp.json()
    except ValueError:
        return None, "R2 storage fallback returned non-JSON payload"
    if not isinstance(payload, dict):
        return None, "R2 storage fallback payload is not an object"
    if payload.get("errors"):
        details = _cloudflare_graphql_error_summary(payload)
        if details:
            return None, f"R2 storage fallback GraphQL returned errors: {details}"
        return None, "R2 storage fallback GraphQL returned errors"

    data = payload.get("data")
    if not isinstance(data, dict):
        return None, "R2 storage fallback missing data object"
    viewer = data.get("viewer")
    if not isinstance(viewer, dict):
        return None, "R2 storage fallback missing viewer object"
    accounts = viewer.get("accounts")
    if not isinstance(accounts, list) or not accounts:
        return None, "R2 storage fallback missing account data"
    account_row = accounts[0]
    if not isinstance(account_row, dict):
        return None, "R2 storage fallback account row is invalid"
    groups = account_row.get("r2StorageAdaptiveGroups")
    if not isinstance(groups, list):
        return None, "R2 storage fallback missing storage groups"

    used_bytes = 0.0
    objects = 0.0
    for group in groups:
        if not isinstance(group, dict):
            continue
        dimensions = group.get("dimensions")
        max_values = group.get("max")
        if not isinstance(dimensions, dict) or not isinstance(max_values, dict):
            continue
        storage_class = str(dimensions.get("storageClass") or "").strip()
        if storage_class.lower() != "standard":
            continue
        payload_size = _safe_nonnegative_number(max_values.get("payloadSize"))
        metadata_size = _safe_nonnegative_number(max_values.get("metadataSize"))
        object_count = _safe_nonnegative_number(max_values.get("objectCount"))
        if payload_size is None or metadata_size is None or object_count is None:
            continue
        used_bytes += payload_size + metadata_size
        objects += object_count

    return {
        "standard_used_bytes": int(round(used_bytes)),
        "standard_objects": int(round(objects)),
        "window_start_utc": window_start.isoformat().replace("+00:00", "Z"),
        "window_end_utc": window_end.isoformat().replace("+00:00", "Z"),
    }, None


def _fetch_json(url: str, headers: Dict[str, str], params: Dict[str, str]) -> List[Dict[str, Any]]:
    resp = requests.get(url, headers=headers, params=params, timeout=60)
    if not resp.ok:
        params_keys = sorted(params.keys())
        raise RuntimeError(
            (
                "PostgREST GET error "
                f"{resp.status_code} at {_request_path(url)} "
                f"(params_keys={params_keys}): {_safe_response_text(resp)}"
            )
        )
    payload = resp.json()
    return payload if isinstance(payload, list) else []


def _post_json_object(
    url: str,
    headers: Dict[str, str],
    body: Dict[str, Any],
) -> Dict[str, Any]:
    resp = requests.post(url, headers=headers, json=body, timeout=60)
    if not resp.ok:
        payload_keys = sorted(body.keys())
        raise RuntimeError(
            (
                "PostgREST POST error "
                f"{resp.status_code} at {_request_path(url)} "
                f"(payload_keys={payload_keys}): {_safe_response_text(resp)}"
            )
        )
    payload = resp.json()
    if not isinstance(payload, dict):
        raise RuntimeError("PostgREST RPC payload is not an object")
    return payload


def _patch_json(
    base_url: str,
    table: str,
    headers: Dict[str, str],
    params: Dict[str, str],
    payload: Dict[str, Any],
) -> None:
    if not re.fullmatch(r"[a-z_]+", table):
        raise ValueError(f"Invalid table name: {table}")
    safe_base_url = _ensure_allowed_base_url(base_url)
    url = f"{safe_base_url}/{table}"
    resp = requests.patch(url, headers=headers, params=params, json=payload, timeout=60)
    if not resp.ok:
        payload_keys = sorted(payload.keys())
        params_keys = sorted(params.keys())
        raise RuntimeError(
            (
                "PostgREST PATCH error "
                f"{resp.status_code} at {_request_path(url)} "
                f"(params_keys={params_keys}, payload_keys={payload_keys}): {_safe_response_text(resp)}"
            )
        )


def _timestamp_or_min(value: Optional[datetime]) -> datetime:
    return value if value is not None else UTC_DATETIME_MIN


def _fetch_all(
    base_url: str,
    headers: Dict[str, str],
    table: str,
    params: Dict[str, str],
    limit: int = 1000,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        batch_params = dict(params)
        batch_params["limit"] = str(limit)
        batch_params["offset"] = str(offset)
        batch = _fetch_json(f"{base_url}/{table}", headers, batch_params)
        rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return rows


def _fetch_ingest_runs(
    base_url: str,
    headers: Dict[str, str],
    *,
    created_since: Optional[datetime] = None,
    limit: int = DISPATCH_FETCH_LIMIT,
) -> List[Dict[str, Any]]:
    params: Dict[str, str] = {
        "select": "id,connector_id,connector_code,run_started_at,run_ended_at,run_status,run_message,last_observed_at,stations_updated,observations_upserted,timeseries_updated,series_polled,response_payload,created_at",
        "order": "created_at.desc.nullslast",
        "limit": str(limit),
    }
    if created_since:
        params["created_at"] = f"gte.{_to_postgrest_ts(created_since)}"
    return _fetch_json(
        f"{base_url}/uk_aq_ingest_runs",
        headers,
        params,
    )


def _fetch_dispatcher_settings(
    base_url: str,
    headers: Dict[str, str],
) -> Dict[str, Any]:
    rows = _fetch_json(
        f"{base_url}/dispatcher_settings",
        headers,
        {
            "select": "id,dispatcher_parallel_ingest,max_runs_per_dispatch_call,updated_at",
            "id": "eq.1",
            "limit": "1",
        },
    )
    if not rows:
        return {
            "id": 1,
            "dispatcher_parallel_ingest": False,
            "max_runs_per_dispatch_call": 1,
            "updated_at": None,
        }
    row = rows[0]
    return {
        "id": row.get("id", 1),
        "dispatcher_parallel_ingest": bool(row.get("dispatcher_parallel_ingest")),
        "max_runs_per_dispatch_call": row.get("max_runs_per_dispatch_call") or 1,
        "updated_at": row.get("updated_at"),
    }


def _normalize_db_size_metrics_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for row in rows:
        label = str(row.get("database_label") or "").strip().lower()
        if label not in {"ingestdb", "obs_aqidb"}:
            continue
        bucket_hour = _parse_timestamp(row.get("bucket_hour"))
        recorded_at = _parse_timestamp(row.get("recorded_at"))
        oldest_observed_at = _parse_timestamp(row.get("oldest_observed_at"))
        if bucket_hour is None:
            continue
        raw_size = row.get("size_bytes")
        try:
            size_bytes = int(raw_size)
        except (TypeError, ValueError):
            continue
        if size_bytes < 0:
            continue
        normalized.append(
            {
                "bucket_hour": bucket_hour.isoformat().replace("+00:00", "Z"),
                "database_label": label,
                "database_name": row.get("database_name"),
                "size_bytes": size_bytes,
                "oldest_observed_at": (
                    oldest_observed_at.isoformat().replace("+00:00", "Z")
                    if isinstance(oldest_observed_at, datetime)
                    else None
                ),
                "recorded_at": (
                    recorded_at.isoformat().replace("+00:00", "Z")
                    if isinstance(recorded_at, datetime)
                    else None
                ),
            }
        )

    normalized.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
    return normalized


def _normalize_schema_size_metrics_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for row in rows:
        database_label = str(row.get("database_label") or "").strip().lower()
        schema_name = str(row.get("schema_name") or "").strip().lower()
        if database_label != "obs_aqidb":
            continue
        if schema_name not in {"uk_aq_observs", "uk_aq_aqilevels"}:
            continue
        bucket_hour = _parse_timestamp(row.get("bucket_hour"))
        recorded_at = _parse_timestamp(row.get("recorded_at"))
        oldest_observed_at = _parse_timestamp(row.get("oldest_observed_at"))
        if bucket_hour is None:
            continue
        raw_size = row.get("size_bytes")
        try:
            size_bytes = int(raw_size)
        except (TypeError, ValueError):
            continue
        if size_bytes < 0:
            continue
        normalized.append(
            {
                "bucket_hour": bucket_hour.isoformat().replace("+00:00", "Z"),
                "database_label": database_label,
                "schema_name": schema_name,
                "size_bytes": size_bytes,
                "oldest_observed_at": (
                    oldest_observed_at.isoformat().replace("+00:00", "Z")
                    if isinstance(oldest_observed_at, datetime)
                    else None
                ),
                "recorded_at": (
                    recorded_at.isoformat().replace("+00:00", "Z")
                    if isinstance(recorded_at, datetime)
                    else None
                ),
            }
        )

    normalized.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
    return normalized


def _normalize_r2_domain_size_metrics_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for row in rows:
        domain_name = str(row.get("domain_name") or "").strip().lower()
        if domain_name not in {"observations", "aqilevels"}:
            continue
        bucket_hour = _parse_timestamp(row.get("bucket_hour"))
        recorded_at = _parse_timestamp(row.get("recorded_at"))
        if bucket_hour is None:
            continue
        raw_size = row.get("size_bytes")
        try:
            size_bytes = int(raw_size)
        except (TypeError, ValueError):
            continue
        if size_bytes < 0:
            continue
        normalized.append(
            {
                "bucket_hour": bucket_hour.isoformat().replace("+00:00", "Z"),
                "domain_name": domain_name,
                "size_bytes": size_bytes,
                "recorded_at": (
                    recorded_at.isoformat().replace("+00:00", "Z")
                    if isinstance(recorded_at, datetime)
                    else None
                ),
            }
        )

    normalized.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
    return normalized


def _filter_r2_domain_metrics_to_committed_days(
    rows: List[Dict[str, Any]],
    r2_history_days: Optional[Dict[str, Set[date]]],
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    if not isinstance(r2_history_days, dict):
        return rows, None

    committed_by_domain: Dict[str, Set[date]] = {
        "observations": set(r2_history_days.get("observations") or set()),
        "aqilevels": set(r2_history_days.get("aqilevels") or set()),
    }

    if not committed_by_domain["observations"] and not committed_by_domain["aqilevels"]:
        if rows:
            return [], (
                "No committed R2 history days found in current bucket; "
                "suppressed domain-size rows from metrics table"
            )
        return [], None

    min_committed_by_domain: Dict[str, Optional[date]] = {
        "observations": min(committed_by_domain["observations"])
        if committed_by_domain["observations"]
        else None,
        "aqilevels": min(committed_by_domain["aqilevels"])
        if committed_by_domain["aqilevels"]
        else None,
    }

    filtered: List[Dict[str, Any]] = []
    dropped_without_committed_days = 0
    dropped_before_committed_start = 0
    for row in rows:
        domain_name = str(row.get("domain_name") or "").strip().lower()
        if domain_name not in min_committed_by_domain:
            continue
        min_committed_day = min_committed_by_domain[domain_name]
        bucket_hour = _parse_timestamp(row.get("bucket_hour"))
        if min_committed_day is None:
            dropped_without_committed_days += 1
            continue
        if bucket_hour is None or bucket_hour.date() < min_committed_day:
            dropped_before_committed_start += 1
            continue
        filtered.append(row)

    warnings: List[str] = []
    if dropped_without_committed_days > 0:
        warnings.append(
            f"Suppressed {dropped_without_committed_days} r2-domain metric row(s) for domain(s) without committed history days"
        )
    if dropped_before_committed_start > 0:
        warnings.append(
            f"Suppressed {dropped_before_committed_start} r2-domain metric row(s) before first committed history day"
        )
    if warnings:
        return filtered, "; ".join(warnings)
    return filtered, None


def _fetch_metric_rows_from_supabase_view(
    base_url: str,
    service_role_key: str,
    view_name: str,
    select: str,
    since: datetime,
    normalizer,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    public_headers: Dict[str, str] = {}
    public_headers["apikey"] = service_role_key
    public_headers["Authorization"] = f"Bearer {service_role_key}"
    public_headers["Accept-Profile"] = PUBLIC_SCHEMA
    try:
        rows = _fetch_all(
            base_url,
            public_headers,
            view_name,
            {
                "select": select,
                "bucket_hour": f"gte.{_to_postgrest_ts(since)}",
                "order": "bucket_hour.asc",
            },
            limit=METRICS_VIEW_PAGE_SIZE,
        )
    except Exception as exc:
        return [], str(exc)
    return normalizer(rows), None


def _latest_bucket_hour(rows: List[Dict[str, Any]]) -> Optional[datetime]:
    latest: Optional[datetime] = None
    for row in rows:
        bucket_hour = _parse_timestamp((row or {}).get("bucket_hour"))
        if bucket_hour is None:
            continue
        if latest is None or bucket_hour > latest:
            latest = bucket_hour
    return latest


def _fetch_size_metrics_from_external_api(
    now: datetime,
) -> Tuple[
    Optional[List[Dict[str, Any]]],
    Optional[List[Dict[str, Any]]],
    Optional[List[Dict[str, Any]]],
    Optional[str],
    Optional[str],
    Optional[str],
    Optional[str],
]:
    if not DB_SIZE_API_URL:
        return None, None, None, None, None, None, None

    params = {
        "lookback_days": str(DB_SIZE_LOOKBACK_DAYS),
    }
    headers = {
        "Accept": "application/json",
    }
    if DB_SIZE_API_TOKEN:
        headers["Authorization"] = f"Bearer {DB_SIZE_API_TOKEN}"

    try:
        resp = requests.get(
            DB_SIZE_API_URL,
            headers=headers,
            params=params,
            timeout=60,
        )
    except requests.RequestException as exc:
        return None, None, None, None, None, None, f"External DB size API request failed ({exc.__class__.__name__})"

    if not resp.ok:
        return (None, None, None, None, None, None, (
            f"External DB size API HTTP {resp.status_code}: "
            f"{_safe_response_text(resp)}"
        ))

    try:
        payload = resp.json()
    except ValueError:
        return None, None, None, None, None, None, "External DB size API returned non-JSON payload"

    db_rows_raw: Any = None
    schema_rows_raw: Any = None
    r2_rows_raw: Any = None
    db_error: Optional[str] = None
    schema_error: Optional[str] = None
    r2_error: Optional[str] = None
    if isinstance(payload, dict):
        db_rows_raw = payload.get("db_size_metrics")
        schema_rows_raw = payload.get("schema_size_metrics")
        r2_rows_raw = payload.get("r2_domain_size_metrics")
        raw_db_error = payload.get("db_size_metrics_error")
        raw_schema_error = payload.get("schema_size_metrics_error")
        raw_r2_error = payload.get("r2_domain_size_metrics_error")
        if isinstance(raw_db_error, str) and raw_db_error.strip():
            db_error = raw_db_error.strip()
        if isinstance(raw_schema_error, str) and raw_schema_error.strip():
            schema_error = raw_schema_error.strip()
        if isinstance(raw_r2_error, str) and raw_r2_error.strip():
            r2_error = raw_r2_error.strip()
    elif isinstance(payload, list):
        db_rows_raw = payload

    if not isinstance(db_rows_raw, list):
        return None, None, None, None, None, None, "External DB size API payload missing db_size_metrics list"
    if schema_rows_raw is None:
        schema_rows_raw = []
    if r2_rows_raw is None:
        r2_rows_raw = []
    if not isinstance(schema_rows_raw, list):
        return None, None, None, None, None, None, "External DB size API payload missing schema_size_metrics list"
    if not isinstance(r2_rows_raw, list):
        return None, None, None, None, None, None, "External DB size API payload missing r2_domain_size_metrics list"

    db_rows = _normalize_db_size_metrics_rows(db_rows_raw)
    schema_rows = _normalize_schema_size_metrics_rows(schema_rows_raw)
    r2_rows = _normalize_r2_domain_size_metrics_rows(r2_rows_raw)

    db_latest_bucket = _latest_bucket_hour(db_rows)
    schema_latest_bucket = _latest_bucket_hour(schema_rows)
    r2_latest_bucket = _latest_bucket_hour(r2_rows)
    if db_latest_bucket is None:
        return None, None, None, None, None, None, "External DB size API payload missing usable db_size_metrics rows"
    if db_latest_bucket < now - EXTERNAL_METRICS_MAX_LAG:
        return None, None, None, None, None, None, "External DB size API returned stale db_size_metrics window"
    if schema_latest_bucket is None:
        schema_error = _join_error_messages(schema_error, EXTERNAL_SCHEMA_MISSING_WARNING)
    elif schema_latest_bucket < db_latest_bucket - EXTERNAL_METRICS_MAX_LAG:
        schema_error = _join_error_messages(schema_error, EXTERNAL_SCHEMA_LAG_WARNING)
    if r2_latest_bucket is None:
        r2_error = _join_error_messages(r2_error, EXTERNAL_R2_MISSING_WARNING)
    elif r2_latest_bucket < db_latest_bucket - EXTERNAL_METRICS_MAX_LAG:
        r2_error = _join_error_messages(r2_error, EXTERNAL_R2_LAG_WARNING)

    return db_rows, schema_rows, r2_rows, db_error, schema_error, r2_error, None


def _join_error_messages(*parts: Optional[str]) -> Optional[str]:
    values = [str(part).strip() for part in parts if isinstance(part, str) and str(part).strip()]
    if not values:
        return None
    return "; ".join(values)


def _strip_error_markers(message: Optional[str], markers: Set[str]) -> Optional[str]:
    if not message:
        return None
    parts = [
        part.strip()
        for part in str(message).split(";")
        if part and part.strip() and part.strip() not in markers
    ]
    if not parts:
        return None
    return "; ".join(parts)


def _row_sample_timestamp(row: Dict[str, Any]) -> datetime:
    recorded_at = _parse_timestamp((row or {}).get("recorded_at"))
    bucket_hour = _parse_timestamp((row or {}).get("bucket_hour"))
    return recorded_at or bucket_hour or UTC_DATETIME_MIN


def _merge_metric_rows(
    existing: List[Dict[str, Any]],
    incoming: List[Dict[str, Any]],
    *,
    key_fields: Tuple[str, ...],
) -> List[Dict[str, Any]]:
    merged: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
    for row in [*existing, *incoming]:
        if not isinstance(row, dict):
            continue
        key = tuple(row.get(field) for field in key_fields)
        if any(value is None for value in key):
            continue
        prior = merged.get(key)
        if prior is None or _row_sample_timestamp(row) >= _row_sample_timestamp(prior):
            merged[key] = row

    rows = list(merged.values())
    rows.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
    return rows


def _merge_schema_metric_rows(
    existing: List[Dict[str, Any]],
    incoming: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    return _merge_metric_rows(
        existing,
        incoming,
        key_fields=("bucket_hour", "database_label", "schema_name"),
    )


def _merge_r2_metric_rows(
    existing: List[Dict[str, Any]],
    incoming: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    return _merge_metric_rows(
        existing,
        incoming,
        key_fields=("bucket_hour", "domain_name"),
    )


def _fetch_size_metrics(
    base_url: str,
    headers: Dict[str, str],
    now: datetime,
) -> Tuple[
    List[Dict[str, Any]],
    List[Dict[str, Any]],
    List[Dict[str, Any]],
    Optional[str],
    Optional[str],
    Optional[str],
]:
    since = now - timedelta(days=DB_SIZE_LOOKBACK_DAYS)
    ingest_key = str(headers.get("apikey") or "").strip()
    obs_aqidb_base_url = (
        f"{OBS_AQIDB_SUPABASE_URL.rstrip('/')}/rest/v1"
        if OBS_AQIDB_SUPABASE_URL and OBS_AQIDB_SECRET_KEY
        else None
    )

    (
        external_db_rows,
        external_schema_rows,
        external_r2_rows,
        external_db_error,
        external_schema_error,
        external_r2_error,
        external_fetch_error,
    ) = _fetch_size_metrics_from_external_api(now)

    if external_db_rows is not None and external_schema_rows is not None and external_r2_rows is not None:
        db_rows = list(external_db_rows)
        schema_rows = list(external_schema_rows)
        r2_rows = list(external_r2_rows)
        db_warning = external_db_error
        schema_warning = external_schema_error
        r2_warning = external_r2_error
        db_latest_bucket = _latest_bucket_hour(db_rows)

        if db_latest_bucket is not None:
            schema_latest_bucket = _latest_bucket_hour(schema_rows)
            if (
                schema_latest_bucket is None
                or schema_latest_bucket < db_latest_bucket - EXTERNAL_METRICS_MAX_LAG
            ):
                if obs_aqidb_base_url and OBS_AQIDB_SECRET_KEY:
                    schema_since = (
                        max(since, schema_latest_bucket - timedelta(hours=1))
                        if schema_latest_bucket is not None
                        else since
                    )
                    schema_topup_rows, schema_topup_error = _fetch_metric_rows_from_supabase_view(
                        base_url=obs_aqidb_base_url,
                        service_role_key=OBS_AQIDB_SECRET_KEY,
                        view_name="uk_aq_schema_size_metrics_hourly",
                        select="bucket_hour,database_label,schema_name,size_bytes,oldest_observed_at,recorded_at",
                        since=schema_since,
                        normalizer=_normalize_schema_size_metrics_rows,
                    )
                    if schema_topup_error:
                        schema_warning = _join_error_messages(
                            schema_warning,
                            f"schema top-up failed: {schema_topup_error}",
                        )
                    else:
                        schema_rows = _merge_schema_metric_rows(schema_rows, schema_topup_rows)
                        schema_latest_bucket = _latest_bucket_hour(schema_rows)
                        if (
                            schema_latest_bucket is not None
                            and schema_latest_bucket >= db_latest_bucket - EXTERNAL_METRICS_MAX_LAG
                        ):
                            schema_warning = _strip_error_markers(
                                schema_warning,
                                {EXTERNAL_SCHEMA_MISSING_WARNING, EXTERNAL_SCHEMA_LAG_WARNING},
                            )
                else:
                    schema_warning = _join_error_messages(
                        schema_warning,
                        "obs_aqidb: missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY",
                    )

            r2_latest_bucket = _latest_bucket_hour(r2_rows)
            if (
                r2_latest_bucket is None
                or r2_latest_bucket < db_latest_bucket - EXTERNAL_METRICS_MAX_LAG
            ):
                if base_url and ingest_key:
                    r2_since = (
                        max(since, r2_latest_bucket - timedelta(hours=1))
                        if r2_latest_bucket is not None
                        else since
                    )
                    r2_topup_rows, r2_topup_error = _fetch_metric_rows_from_supabase_view(
                        base_url=base_url,
                        service_role_key=ingest_key,
                        view_name="uk_aq_r2_domain_size_metrics_hourly",
                        select="bucket_hour,domain_name,size_bytes,recorded_at",
                        since=r2_since,
                        normalizer=_normalize_r2_domain_size_metrics_rows,
                    )
                    if r2_topup_error:
                        r2_warning = _join_error_messages(
                            r2_warning,
                            f"r2-domain top-up failed: {r2_topup_error}",
                        )
                    else:
                        r2_rows = _merge_r2_metric_rows(r2_rows, r2_topup_rows)
                        r2_latest_bucket = _latest_bucket_hour(r2_rows)
                        if (
                            r2_latest_bucket is not None
                            and r2_latest_bucket >= db_latest_bucket - EXTERNAL_METRICS_MAX_LAG
                        ):
                            r2_warning = _strip_error_markers(
                                r2_warning,
                                {EXTERNAL_R2_MISSING_WARNING, EXTERNAL_R2_LAG_WARNING},
                            )
                else:
                    r2_warning = _join_error_messages(
                        r2_warning,
                        "ingestdb: missing base URL or service key",
                    )

        db_rows.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
        schema_rows.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
        r2_rows.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
        return (
            db_rows,
            schema_rows,
            r2_rows,
            db_warning,
            schema_warning,
            r2_warning,
        )

    fallback_note = (
        f"{external_fetch_error}; using direct Supabase fallback."
        if external_fetch_error
        else None
    )

    db_source_errors: List[str] = []
    db_rows: List[Dict[str, Any]] = []

    if base_url and ingest_key:
        ingest_rows, ingest_error = _fetch_metric_rows_from_supabase_view(
            base_url=base_url,
            service_role_key=ingest_key,
            view_name="uk_aq_db_size_metrics_hourly",
            select="bucket_hour,database_label,database_name,size_bytes,oldest_observed_at,recorded_at",
            since=since,
            normalizer=_normalize_db_size_metrics_rows,
        )
        ingest_rows = [
            row
            for row in ingest_rows
            if str(row.get("database_label") or "").strip().lower() == "ingestdb"
        ]
        if ingest_error:
            db_source_errors.append(f"ingestdb: {ingest_error}")
        db_rows.extend(ingest_rows)
    else:
        db_source_errors.append("ingestdb: missing base URL or service key")

    if obs_aqidb_base_url and OBS_AQIDB_SECRET_KEY:
        obs_aqidb_rows, obs_aqidb_error = _fetch_metric_rows_from_supabase_view(
            base_url=obs_aqidb_base_url,
            service_role_key=OBS_AQIDB_SECRET_KEY,
            view_name="uk_aq_db_size_metrics_hourly",
            select="bucket_hour,database_label,database_name,size_bytes,oldest_observed_at,recorded_at",
            since=since,
            normalizer=_normalize_db_size_metrics_rows,
        )
        obs_aqidb_rows = [
            row
            for row in obs_aqidb_rows
            if str(row.get("database_label") or "").strip().lower() == "obs_aqidb"
        ]
        if obs_aqidb_error:
            db_source_errors.append(f"obs_aqidb: {obs_aqidb_error}")
        db_rows.extend(obs_aqidb_rows)
    else:
        db_source_errors.append("obs_aqidb: missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY")

    schema_rows, schema_fetch_error = _fetch_metric_rows_from_supabase_view(
        base_url=obs_aqidb_base_url,
        service_role_key=OBS_AQIDB_SECRET_KEY,
        view_name="uk_aq_schema_size_metrics_hourly",
        select="bucket_hour,database_label,schema_name,size_bytes,oldest_observed_at,recorded_at",
        since=since,
        normalizer=_normalize_schema_size_metrics_rows,
    ) if obs_aqidb_base_url and OBS_AQIDB_SECRET_KEY else (
        [],
        "obs_aqidb: missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY",
    )

    r2_rows, r2_fetch_error = _fetch_metric_rows_from_supabase_view(
        base_url=base_url,
        service_role_key=ingest_key,
        view_name="uk_aq_r2_domain_size_metrics_hourly",
        select="bucket_hour,domain_name,size_bytes,recorded_at",
        since=since,
        normalizer=_normalize_r2_domain_size_metrics_rows,
    ) if base_url and ingest_key else ([], "ingestdb: missing base URL or service key")

    db_rows.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
    schema_rows.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)
    r2_rows.sort(key=lambda item: _parse_timestamp(item.get("bucket_hour")) or UTC_DATETIME_MIN)

    db_warning = _join_error_messages(
        fallback_note,
        "; ".join(db_source_errors) if db_source_errors else None,
        external_db_error,
    )
    schema_warning = _join_error_messages(
        fallback_note,
        schema_fetch_error,
        external_schema_error,
    )
    r2_warning = _join_error_messages(
        fallback_note,
        r2_fetch_error,
        external_r2_error,
    )
    return db_rows, schema_rows, r2_rows, db_warning, schema_warning, r2_warning


def _normalize_iso_date(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        candidate = text.split("T", 1)[0]
        try:
            parsed = datetime.fromisoformat(candidate).date()
        except ValueError:
            return None
        return parsed.isoformat()
    return None


def _parse_iso_day(value: Any) -> Optional[date]:
    normalized = _normalize_iso_date(value)
    if not normalized:
        return None
    try:
        return datetime.fromisoformat(normalized).date()
    except ValueError:
        return None


def _empty_dropbox_backup_days() -> Dict[str, Set[date]]:
    return {
        "observations": set(),
        "aqilevels": set(),
    }


def _normalize_dropbox_path(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    with_leading = value if value.startswith("/") else f"/{value}"
    return with_leading.rstrip("/")


def _resolve_dropbox_state_remote_path() -> str:
    root = str(UK_AQ_DROPBOX_ROOT or "").strip().strip("/")
    history_dir = str(UK_AQ_R2_HISTORY_DROPBOX_DIR or "").strip().strip("/")
    state_rel = str(UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH or "").strip().strip("/")
    path_parts = [part for part in (root, history_dir, state_rel) if part]
    if not path_parts:
        return ""
    return "/" + "/".join(path_parts)


def _extract_dropbox_backup_days(
    raw_state: Any,
) -> Tuple[Dict[str, Set[date]], Optional[str]]:
    domain_days = _empty_dropbox_backup_days()
    if not isinstance(raw_state, dict):
        return domain_days, "Dropbox checkpoint is not a JSON object"

    raw_domains = raw_state.get("domains")
    domains = raw_domains if isinstance(raw_domains, dict) else {}
    for domain_name in ("observations", "aqilevels"):
        raw_domain = domains.get(domain_name)
        if not isinstance(raw_domain, dict):
            continue
        raw_day_map = raw_domain.get("days")
        day_map = raw_day_map if isinstance(raw_day_map, dict) else {}
        for day_text in day_map.keys():
            parsed_day = _parse_iso_day(day_text)
            if parsed_day is not None:
                domain_days[domain_name].add(parsed_day)

    return domain_days, None


def _fetch_dropbox_access_token() -> Tuple[Optional[str], Optional[str]]:
    creds_present = [bool(DROPBOX_APP_KEY), bool(DROPBOX_APP_SECRET), bool(DROPBOX_REFRESH_TOKEN)]
    if not any(creds_present):
        return None, None
    if not all(creds_present):
        return None, "Dropbox credentials incomplete (DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN required)"

    try:
        resp = requests.post(
            DROPBOX_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": DROPBOX_REFRESH_TOKEN,
                "client_id": DROPBOX_APP_KEY,
                "client_secret": DROPBOX_APP_SECRET,
            },
            timeout=DROPBOX_API_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        return None, f"Dropbox token request failed ({exc.__class__.__name__})"

    if not resp.ok:
        detail = _safe_response_text(resp)
        if detail:
            return None, f"Dropbox token request failed ({resp.status_code}): {detail}"
        return None, f"Dropbox token request failed ({resp.status_code})"

    try:
        payload = resp.json()
    except ValueError:
        return None, "Dropbox token response was not valid JSON"
    token = str((payload or {}).get("access_token") or "").strip()
    if not token:
        return None, "Dropbox token response missing access_token"
    return token, None


def _load_dropbox_backup_days_remote() -> Tuple[Dict[str, Set[date]], Optional[str], Optional[str]]:
    domain_days = _empty_dropbox_backup_days()
    remote_path = _resolve_dropbox_state_remote_path()
    if not remote_path:
        return domain_days, None, None

    path_ref = f"dropbox:{remote_path}"
    access_token, token_error = _fetch_dropbox_access_token()
    if token_error:
        return domain_days, path_ref, token_error
    if not access_token:
        return domain_days, None, None

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Dropbox-API-Arg": json.dumps({"path": remote_path}),
    }
    try:
        resp = requests.post(
            DROPBOX_CONTENT_API_DOWNLOAD_URL,
            headers=headers,
            timeout=DROPBOX_API_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        return domain_days, path_ref, f"Dropbox checkpoint download failed ({exc.__class__.__name__})"

    if not resp.ok:
        detail = _safe_response_text(resp)
        if detail:
            return domain_days, path_ref, f"Dropbox checkpoint download failed ({resp.status_code}): {detail}"
        return domain_days, path_ref, f"Dropbox checkpoint download failed ({resp.status_code})"

    try:
        raw_state = json.loads(resp.text)
    except Exception as exc:  # noqa: BLE001
        return domain_days, path_ref, f"Dropbox checkpoint parse failed ({exc.__class__.__name__})"

    parsed_days, parse_error = _extract_dropbox_backup_days(raw_state)
    return parsed_days, path_ref, parse_error


def _candidate_dropbox_state_paths() -> List[Path]:
    candidates: List[Path] = []
    seen: Set[str] = set()

    def add_candidate(raw_path: Optional[Path]) -> None:
        if raw_path is None:
            return
        expanded = raw_path.expanduser()
        key = str(expanded)
        if key in seen:
            return
        seen.add(key)
        candidates.append(expanded)

    if UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE:
        add_candidate(Path(UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE))

    local_roots: List[Path] = []
    if UK_AQ_DROPBOX_LOCAL_ROOT:
        local_roots.append(Path(UK_AQ_DROPBOX_LOCAL_ROOT))
    default_local_root = Path.home() / "Dropbox"
    if default_local_root.exists():
        local_roots.append(default_local_root)

    remote_root = UK_AQ_DROPBOX_ROOT.strip().strip("/")
    history_dir = UK_AQ_R2_HISTORY_DROPBOX_DIR.strip().strip("/")
    state_rel_path = UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH.strip().strip("/")

    def add_from_base(base_root: Path) -> None:
        path_parts: List[str] = [str(base_root)]
        if remote_root:
            path_parts.append(remote_root)
        if history_dir:
            path_parts.append(history_dir)
        if state_rel_path:
            path_parts.append(state_rel_path)
        add_candidate(Path(*path_parts))

    for local_root in local_roots:
        # Full-access Dropbox paths (for example ~/Dropbox/CIC-Test/...).
        add_from_base(local_root)

        # App-folder Dropbox paths (for example ~/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/...).
        apps_root = local_root / "Apps"
        if UK_AQ_DROPBOX_APP_FOLDER:
            add_from_base(apps_root / UK_AQ_DROPBOX_APP_FOLDER)
            continue
        if not apps_root.is_dir():
            continue

        preferred_app_path = apps_root / "github-uk-air-quality-networks"
        if preferred_app_path.is_dir():
            add_from_base(preferred_app_path)
        try:
            app_dirs = sorted(
                child
                for child in apps_root.iterdir()
                if child.is_dir() and child != preferred_app_path
            )
        except OSError:
            app_dirs = []
        for app_dir in app_dirs:
            add_from_base(app_dir)

    return candidates


def _load_dropbox_backup_days() -> Tuple[Dict[str, Set[date]], Optional[str], Optional[str]]:
    domain_days = _empty_dropbox_backup_days()
    for candidate in _candidate_dropbox_state_paths():
        if not candidate.is_file():
            continue
        try:
            raw_state = json.loads(candidate.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            return domain_days, str(candidate), f"Dropbox checkpoint parse failed ({exc.__class__.__name__})"
        parsed_days, parse_error = _extract_dropbox_backup_days(raw_state)
        return parsed_days, str(candidate), parse_error

    remote_days, remote_path, remote_error = _load_dropbox_backup_days_remote()
    if remote_path or remote_error:
        return remote_days, remote_path, remote_error

    return domain_days, None, None


def _latest_oldest_day_by_label(
    db_size_metrics: Optional[List[Dict[str, Any]]],
) -> Dict[str, Optional[date]]:
    latest_rows: Dict[str, Tuple[datetime, Optional[date]]] = {}
    for row in db_size_metrics or []:
        label = str((row or {}).get("database_label") or "").strip().lower()
        if label not in {"ingestdb", "obs_aqidb"}:
            continue
        bucket_hour = _parse_timestamp((row or {}).get("bucket_hour"))
        recorded_at = _parse_timestamp((row or {}).get("recorded_at"))
        sample_ts = bucket_hour or recorded_at
        if sample_ts is None:
            continue
        oldest_day = _parse_iso_day((row or {}).get("oldest_observed_at"))
        current = latest_rows.get(label)
        if current is None or sample_ts >= current[0]:
            latest_rows[label] = (sample_ts, oldest_day)

    return {
        "ingestdb": latest_rows.get("ingestdb", (UTC_DATETIME_MIN, None))[1],
        "obs_aqidb": latest_rows.get("obs_aqidb", (UTC_DATETIME_MIN, None))[1],
    }


def _latest_oldest_day_by_schema(
    schema_size_metrics: Optional[List[Dict[str, Any]]],
) -> Dict[str, Optional[date]]:
    latest_rows: Dict[str, Tuple[datetime, Optional[date]]] = {}
    for row in schema_size_metrics or []:
        schema_name = str((row or {}).get("schema_name") or "").strip().lower()
        if schema_name not in {"uk_aq_observs", "uk_aq_aqilevels"}:
            continue
        bucket_hour = _parse_timestamp((row or {}).get("bucket_hour"))
        recorded_at = _parse_timestamp((row or {}).get("recorded_at"))
        sample_ts = bucket_hour or recorded_at
        if sample_ts is None:
            continue
        oldest_day = _parse_iso_day((row or {}).get("oldest_observed_at"))
        current = latest_rows.get(schema_name)
        if current is None or sample_ts >= current[0]:
            latest_rows[schema_name] = (sample_ts, oldest_day)

    return {
        "uk_aq_observs": latest_rows.get("uk_aq_observs", (UTC_DATETIME_MIN, None))[1],
        "uk_aq_aqilevels": latest_rows.get("uk_aq_aqilevels", (UTC_DATETIME_MIN, None))[1],
    }


def _latest_r2_domain_size_bytes(
    r2_domain_size_metrics: Optional[List[Dict[str, Any]]],
) -> Dict[str, int]:
    latest_sizes: Dict[str, Tuple[datetime, int]] = {}
    for row in r2_domain_size_metrics or []:
        domain_name = str((row or {}).get("domain_name") or "").strip().lower()
        if domain_name not in {"observations", "aqilevels"}:
            continue
        bucket_hour = _parse_timestamp((row or {}).get("bucket_hour"))
        if bucket_hour is None:
            continue
        try:
            size_bytes = int((row or {}).get("size_bytes"))
        except (TypeError, ValueError):
            continue
        size_bytes = max(0, size_bytes)
        current = latest_sizes.get(domain_name)
        if current is None or bucket_hour >= current[0]:
            latest_sizes[domain_name] = (bucket_hour, size_bytes)

    return {
        "observations": latest_sizes.get("observations", (UTC_DATETIME_MIN, 0))[1],
        "aqilevels": latest_sizes.get("aqilevels", (UTC_DATETIME_MIN, 0))[1],
    }


def _build_live_storage_coverage_days(
    now: datetime,
    db_size_metrics: Optional[List[Dict[str, Any]]],
    schema_size_metrics: Optional[List[Dict[str, Any]]],
    r2_domain_size_metrics: Optional[List[Dict[str, Any]]],
    dropbox_backup_days: Optional[Dict[str, Set[date]]],
    r2_backup_window: Optional[Dict[str, Any]],
    r2_history_days: Optional[Dict[str, Set[date]]],
    day_sets: Dict[str, Set[date]],
) -> List[Dict[str, Any]]:
    now_utc = now.astimezone(timezone.utc)
    today_utc = now_utc.date()
    oldest_by_label = _latest_oldest_day_by_label(db_size_metrics)
    oldest_by_schema = _latest_oldest_day_by_schema(schema_size_metrics)

    ingest_days = set(day_sets.get("ingestdb") or set())
    observs_days_raw = day_sets.get("obs_aqidb")
    has_explicit_observs_days = isinstance(observs_days_raw, set)
    observs_days = set(observs_days_raw or set()) if has_explicit_observs_days else set()
    aqilevels_days_raw = day_sets.get("obs_aqi_aqilevels")
    has_explicit_aqilevels_days = isinstance(aqilevels_days_raw, set)
    aqilevels_days = set(aqilevels_days_raw or set()) if has_explicit_aqilevels_days else set()

    ingest_start = min(ingest_days) if ingest_days else oldest_by_label.get("ingestdb")
    observs_start = (
        min(observs_days)
        if has_explicit_observs_days and observs_days
        else (
            None
            if has_explicit_observs_days
            else (
                oldest_by_schema.get("uk_aq_observs")
                or oldest_by_label.get("obs_aqidb")
            )
        )
    )
    aqilevels_start = (
        min(aqilevels_days)
        if has_explicit_aqilevels_days and aqilevels_days
        else (
            None
            if has_explicit_aqilevels_days
            else oldest_by_schema.get("uk_aq_aqilevels")
        )
    )
    has_explicit_r2_days = isinstance(r2_history_days, dict)
    r2_observs_days = set((r2_history_days or {}).get("observations") or set())
    r2_aqilevels_days = set((r2_history_days or {}).get("aqilevels") or set())

    if has_explicit_r2_days and r2_observs_days:
        r2_start = min(r2_observs_days)
        r2_end = max(r2_observs_days)
    else:
        # Per-day R2 presence is only valid from explicit history-days API results.
        # Do not infer day presence from broad min/max windows.
        r2_start = None
        r2_end = None
    dropbox_observs_days = set((dropbox_backup_days or {}).get("observations") or set())
    dropbox_aqilevels_days = set((dropbox_backup_days or {}).get("aqilevels") or set())
    dropbox_all_days = dropbox_observs_days | dropbox_aqilevels_days
    dropbox_start = min(dropbox_all_days) if dropbox_all_days else None
    dropbox_end = max(dropbox_all_days) if dropbox_all_days else None

    lower_bounds = [day for day in [ingest_start, observs_start, aqilevels_start, r2_start, dropbox_start] if day]
    if not lower_bounds:
        return []
    start_day = min(lower_bounds)
    end_day = max(
        day for day in [today_utc, r2_end, dropbox_end] if day is not None
    )

    rows: List[Dict[str, Any]] = []
    cursor = start_day
    while cursor <= end_day:
        ingest = bool(
            cursor <= today_utc
            and (
                (cursor in ingest_days)
                if ingest_days
                else (ingest_start and ingest_start <= cursor <= today_utc)
            )
        )
        observs = bool(
            cursor <= today_utc
            and (
                (cursor in observs_days)
                if has_explicit_observs_days
                else (
                    observs_start
                    and observs_start <= cursor <= today_utc
                )
            )
        )
        obs_aqi_aqilevels = bool(
            cursor <= today_utc
            and (
                (cursor in aqilevels_days)
                if has_explicit_aqilevels_days
                else (
                    aqilevels_start
                    and aqilevels_start <= cursor <= today_utc
                )
            )
        )
        r2_observs = bool(has_explicit_r2_days and cursor in r2_observs_days)
        r2_aqilevels = bool(has_explicit_r2_days and cursor in r2_aqilevels_days)
        if r2_observs:
            # Top row is mutually exclusive: if archived in R2, do not show ingest red.
            ingest = False
        dropbox_observs = cursor in dropbox_observs_days
        dropbox_aqilevels = cursor in dropbox_aqilevels_days

        rows.append(
            {
                "date": cursor.isoformat(),
                "ingest": ingest,
                "observs": observs,
                "r2": r2_observs,
                "obs_aqi_observs": observs,
                "obs_aqi_aqilevels": obs_aqi_aqilevels,
                "r2_observs": r2_observs,
                "r2_aqilevels": r2_aqilevels,
                "dropbox_observs": dropbox_observs,
                "dropbox_aqilevels": dropbox_aqilevels,
                "isToday": cursor == today_utc,
            }
        )
        cursor += timedelta(days=1)

    return rows


def _next_storage_coverage_refresh(now_utc: datetime) -> datetime:
    return now_utc + timedelta(seconds=STORAGE_COVERAGE_CACHE_TTL_SECONDS)


def _get_cached_storage_coverage_days(now: datetime) -> Optional[List[Dict[str, Any]]]:
    now_utc = now.astimezone(timezone.utc)
    with CACHE_LOCK:
        cached_rows = STORAGE_COVERAGE_CACHE_STATE.get("rows")
        next_refresh_at = STORAGE_COVERAGE_CACHE_STATE.get("next_refresh_at")
        if (
            isinstance(cached_rows, list)
            and isinstance(next_refresh_at, datetime)
            and now_utc < next_refresh_at
        ):
            return list(cached_rows)
    return None


def _get_storage_coverage_days_cached(
    now: datetime,
    base_url: str,
    service_role_key: str,
    db_size_metrics: Optional[List[Dict[str, Any]]],
    schema_size_metrics: Optional[List[Dict[str, Any]]],
    r2_domain_size_metrics: Optional[List[Dict[str, Any]]],
    dropbox_backup_days: Optional[Dict[str, Set[date]]],
    r2_backup_window: Optional[Dict[str, Any]],
    r2_history_days: Optional[Dict[str, Set[date]]],
) -> List[Dict[str, Any]]:
    cached_rows = _get_cached_storage_coverage_days(now)
    if isinstance(cached_rows, list):
        return cached_rows

    now_utc = now.astimezone(timezone.utc)
    day_sets = _fetch_storage_day_sets()
    rows = _build_live_storage_coverage_days(
        now=now_utc,
        db_size_metrics=db_size_metrics,
        schema_size_metrics=schema_size_metrics,
        r2_domain_size_metrics=r2_domain_size_metrics,
        dropbox_backup_days=dropbox_backup_days,
        r2_backup_window=r2_backup_window,
        r2_history_days=r2_history_days,
        day_sets=day_sets,
    )
    next_refresh_at = _next_storage_coverage_refresh(now_utc)
    with CACHE_LOCK:
        STORAGE_COVERAGE_CACHE_STATE["rows"] = rows
        STORAGE_COVERAGE_CACHE_STATE["next_refresh_at"] = next_refresh_at
    return rows


def _fetch_storage_day_sets() -> Dict[str, Set[date]]:
    day_sets: Dict[str, Set[date]] = {"ingestdb": set()}
    # Keep ingest on oldest_observed_at range logic.
    day_sets["ingestdb"] = set()
    observs_days = _fetch_obs_aqi_observs_row_days()
    if observs_days is not None:
        day_sets["obs_aqidb"] = observs_days
    aqilevels_days = _fetch_obs_aqi_aqilevels_hourly_days()
    if aqilevels_days is not None:
        day_sets["obs_aqi_aqilevels"] = aqilevels_days
    return day_sets


def _fetch_obs_aqidb_day_count_rows(dataset: str) -> Optional[List[Dict[str, Any]]]:
    if not OBS_AQIDB_SUPABASE_URL or not OBS_AQIDB_SECRET_KEY:
        return None

    dataset_value = (dataset or "").strip().lower()
    if dataset_value not in {"observs", "aqilevels"}:
        return None

    try:
        obs_aqidb_base_url = _ensure_allowed_base_url(
            f"{OBS_AQIDB_SUPABASE_URL.rstrip('/')}/rest/v1"
        )
    except Exception:
        return None

    url = f"{obs_aqidb_base_url}/uk_aq_obs_aqidb_day_counts_current"
    headers = _postgrest_headers(OBS_AQIDB_SECRET_KEY, schema=PUBLIC_SCHEMA)

    rows: List[Dict[str, Any]] = []
    limit = 200
    offset = 0
    max_pages = 10
    for _ in range(max_pages):
        try:
            batch = _fetch_json(
                url,
                headers,
                {
                    "dataset": f"eq.{dataset_value}",
                    "select": "day_utc,row_count",
                    "order": "day_utc.asc",
                    "limit": str(limit),
                    "offset": str(offset),
                },
            )
        except Exception:
            return None

        if not isinstance(batch, list):
            return None

        for row in batch:
            if isinstance(row, dict):
                rows.append(row)

        if len(batch) < limit:
            break
        offset += limit

    return rows


def _fetch_obs_aqi_observs_partition_days() -> Optional[Set[date]]:
    if not OBS_AQIDB_SUPABASE_URL or not OBS_AQIDB_SECRET_KEY:
        return None

    try:
        obs_aqidb_base_url = _ensure_allowed_base_url(
            f"{OBS_AQIDB_SUPABASE_URL.rstrip('/')}/rest/v1"
        )
    except Exception:
        return None
    url = f"{obs_aqidb_base_url}/rpc/uk_aq_rpc_observs_drop_candidates"
    headers = _postgrest_headers(OBS_AQIDB_SECRET_KEY, schema=PUBLIC_SCHEMA)
    cutoff_utc = f"{(datetime.now(timezone.utc).date() + timedelta(days=1)).isoformat()}T00:00:00Z"

    days: Set[date] = set()
    limit = 1000
    offset = 0
    max_pages = 20
    for _ in range(max_pages):
        try:
            batch = _fetch_json(
                url,
                headers,
                {
                    "cutoff_utc": cutoff_utc,
                    "select": "partition_day_utc",
                    "order": "partition_day_utc.asc",
                    "limit": str(limit),
                    "offset": str(offset),
                },
            )
        except Exception:
            return None

        for row in batch:
            if not isinstance(row, dict):
                continue
            parsed_day = _parse_iso_day(row.get("partition_day_utc"))
            if parsed_day is not None:
                days.add(parsed_day)

        if len(batch) < limit:
            break
        offset += limit

    return days


def _fetch_obs_aqi_observs_row_days() -> Optional[Set[date]]:
    count_rows = _fetch_obs_aqidb_day_count_rows("observs")
    if count_rows is not None:
        days_with_rows: Set[date] = set()
        for row in count_rows:
            try:
                row_count = int(row.get("row_count") or 0)
            except (TypeError, ValueError):
                continue
            if row_count <= 0:
                continue
            parsed_day = _parse_iso_day(row.get("day_utc"))
            if parsed_day is not None:
                days_with_rows.add(parsed_day)
        return days_with_rows

    if not OBS_AQIDB_SUPABASE_URL or not OBS_AQIDB_SECRET_KEY:
        return None

    partition_days = _fetch_obs_aqi_observs_partition_days()
    if partition_days is None:
        return None
    if not partition_days:
        return set()

    try:
        obs_aqidb_base_url = _ensure_allowed_base_url(
            f"{OBS_AQIDB_SUPABASE_URL.rstrip('/')}/rest/v1"
        )
    except Exception:
        return None
    url = f"{obs_aqidb_base_url}/rpc/uk_aq_rpc_observations_hourly_fingerprint"
    headers = _postgrest_headers(OBS_AQIDB_SECRET_KEY, schema=PUBLIC_SCHEMA)

    days_with_rows: Set[date] = set()
    for day_utc in sorted(partition_days):
        next_day_utc = day_utc + timedelta(days=1)
        try:
            batch = _fetch_json(
                url,
                headers,
                {
                    "window_start": f"{day_utc.isoformat()}T00:00:00Z",
                    "window_end": f"{next_day_utc.isoformat()}T00:00:00Z",
                    "select": "hour_start,observation_count",
                    "order": "hour_start.asc",
                    "limit": "1",
                    "offset": "0",
                },
            )
        except Exception:
            return None

        if not batch:
            continue
        first_row = batch[0] if isinstance(batch[0], dict) else None
        if not first_row:
            continue
        try:
            observation_count = int(first_row.get("observation_count") or 0)
        except (TypeError, ValueError):
            observation_count = 0
        if observation_count > 0:
            days_with_rows.add(day_utc)

    return days_with_rows


def _fetch_obs_aqi_aqilevels_hourly_days() -> Optional[Set[date]]:
    count_rows = _fetch_obs_aqidb_day_count_rows("aqilevels")
    if count_rows is not None:
        days: Set[date] = set()
        for row in count_rows:
            try:
                row_count = int(row.get("row_count") or 0)
            except (TypeError, ValueError):
                continue
            if row_count <= 0:
                continue
            parsed_day = _parse_iso_day(row.get("day_utc"))
            if parsed_day is not None:
                days.add(parsed_day)
        return days

    if not OBS_AQIDB_SUPABASE_URL or not OBS_AQIDB_SECRET_KEY:
        return None

    try:
        obs_aqidb_base_url = _ensure_allowed_base_url(
            f"{OBS_AQIDB_SUPABASE_URL.rstrip('/')}/rest/v1"
        )
    except Exception:
        return None
    url = f"{obs_aqidb_base_url}/rpc/uk_aq_rpc_aqilevels_drop_candidates"
    headers = _postgrest_headers(OBS_AQIDB_SECRET_KEY, schema=PUBLIC_SCHEMA)
    cutoff_day_utc = (datetime.now(timezone.utc).date() + timedelta(days=1)).isoformat()

    days: Set[date] = set()
    limit = 1000
    offset = 0
    max_pages = 20
    for _ in range(max_pages):
        try:
            batch = _fetch_json(
                url,
                headers,
                {
                    "p_cutoff_day_utc": cutoff_day_utc,
                    "select": "day_utc,hourly_rows",
                    "order": "day_utc.asc",
                    "limit": str(limit),
                    "offset": str(offset),
                },
            )
        except Exception:
            return None

        for row in batch:
            if not isinstance(row, dict):
                continue
            try:
                hourly_rows = int(row.get("hourly_rows") or row.get("row_count") or 0)
            except (TypeError, ValueError):
                continue
            if hourly_rows <= 0:
                continue
            parsed_day = _parse_iso_day(row.get("day_utc"))
            if parsed_day is not None:
                days.add(parsed_day)

        if len(batch) < limit:
            break
        offset += limit

    return days


def _fetch_r2_history_days_from_external_api(
) -> Tuple[
    Optional[Dict[str, Set[date]]],
    Optional[Dict[str, Any]],
    Optional[str],
    Optional[str],
]:
    api_url = _resolve_r2_history_days_api_url()
    if not api_url:
        return None, None, None, "R2 history-days API not configured"

    params: Dict[str, str] = {
        "max_days": str(R2_HISTORY_DAYS_API_MAX_DAYS),
    }

    headers: Dict[str, str] = {
        "Accept": "application/json",
    }
    if R2_HISTORY_DAYS_API_TOKEN:
        headers["Authorization"] = f"Bearer {R2_HISTORY_DAYS_API_TOKEN}"

    try:
        resp = requests.get(api_url, headers=headers, params=params, timeout=60)
    except requests.RequestException as exc:
        return None, None, None, f"R2 history-days API request failed ({exc.__class__.__name__})"

    if not resp.ok:
        return None, None, None, (
            f"R2 history-days API HTTP {resp.status_code}: {_safe_response_text(resp)}"
        )

    try:
        payload = resp.json()
    except ValueError:
        return None, None, None, "R2 history-days API returned non-JSON payload"

    if not isinstance(payload, dict):
        return None, None, None, "R2 history-days API payload is not an object"

    raw_error = payload.get("error")
    if isinstance(raw_error, str) and raw_error.strip():
        return None, None, None, raw_error.strip()

    raw_domains = payload.get("domains")
    if not isinstance(raw_domains, dict):
        return None, None, None, "R2 history-days API payload missing domains object"

    day_sets: Dict[str, Set[date]] = {
        "observations": set(),
        "aqilevels": set(),
    }
    for domain_name in ("observations", "aqilevels"):
        raw_domain = raw_domains.get(domain_name)
        if not isinstance(raw_domain, dict):
            continue
        raw_days = raw_domain.get("days")
        if not isinstance(raw_days, list):
            continue
        for day_text in raw_days:
            parsed_day = _parse_iso_day(day_text)
            if parsed_day is not None:
                day_sets[domain_name].add(parsed_day)

    observations_days = day_sets["observations"]
    aqilevels_days = day_sets["aqilevels"]
    overlap_days = observations_days & aqilevels_days

    if overlap_days:
        r2_window: Dict[str, Any] = {
            "min_day_utc": min(overlap_days).isoformat(),
            "max_day_utc": max(overlap_days).isoformat(),
            "day_count": len(overlap_days),
        }
    else:
        # Explicit day sets are available but there is no committed overlap across
        # observations + aqilevels yet.
        r2_window = {
            "min_day_utc": None,
            "max_day_utc": None,
            "day_count": 0,
        }

    # Include domain counts for debugging/inspection in dashboard payloads.
    r2_window["observations_day_count"] = len(observations_days)
    r2_window["aqilevels_day_count"] = len(aqilevels_days)
    r2_window["count_basis"] = "explicit_overlap_both_domains"

    bucket_value = str(payload.get("bucket") or "").strip() or None
    return day_sets, r2_window, bucket_value, None


def _get_r2_history_days_cached(
    *,
    force_refresh: bool = False,
) -> Tuple[
    Optional[Dict[str, Set[date]]],
    Optional[Dict[str, Any]],
    Optional[str],
    Optional[str],
]:
    now = datetime.now(timezone.utc)
    with CACHE_LOCK:
        cached_generated_at = R2_HISTORY_DAYS_CACHE_STATE.get("generated_at")
        if (
            not force_refresh
            and isinstance(cached_generated_at, datetime)
            and (now - cached_generated_at).total_seconds() < R2_HISTORY_DAYS_CACHE_TTL_SECONDS
        ):
            return (
                R2_HISTORY_DAYS_CACHE_STATE.get("day_sets"),
                R2_HISTORY_DAYS_CACHE_STATE.get("window"),
                R2_HISTORY_DAYS_CACHE_STATE.get("bucket"),
                R2_HISTORY_DAYS_CACHE_STATE.get("error"),
            )

    day_sets, r2_window, bucket_value, error = _fetch_r2_history_days_from_external_api()
    with CACHE_LOCK:
        R2_HISTORY_DAYS_CACHE_STATE["day_sets"] = day_sets
        R2_HISTORY_DAYS_CACHE_STATE["window"] = r2_window
        R2_HISTORY_DAYS_CACHE_STATE["bucket"] = bucket_value
        R2_HISTORY_DAYS_CACHE_STATE["error"] = error
        R2_HISTORY_DAYS_CACHE_STATE["generated_at"] = datetime.now(timezone.utc)
    return day_sets, r2_window, bucket_value, error


def _fetch_r2_history_counts_from_external_api(
    *,
    from_day: str,
    to_day: str,
    grain: str,
    connector_ids: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    api_url = _resolve_r2_history_counts_api_url()
    if not api_url:
        return None, "R2 history-counts API not configured"

    params: Dict[str, str] = {
        "from_day": from_day,
        "to_day": to_day,
        "grain": grain,
    }
    if connector_ids:
        params["connector_ids"] = connector_ids

    headers: Dict[str, str] = {
        "Accept": "application/json",
    }
    if R2_HISTORY_COUNTS_API_TOKEN:
        headers["Authorization"] = f"Bearer {R2_HISTORY_COUNTS_API_TOKEN}"

    try:
        resp = requests.get(api_url, headers=headers, params=params, timeout=60)
    except requests.RequestException as exc:
        return None, f"R2 history-counts API request failed ({exc.__class__.__name__})"

    if not resp.ok:
        return None, (
            f"R2 history-counts API HTTP {resp.status_code}: {_safe_response_text(resp)}"
        )

    try:
        payload = resp.json()
    except ValueError:
        return None, "R2 history-counts API returned non-JSON payload"

    if not isinstance(payload, dict):
        return None, "R2 history-counts API payload is not an object"

    raw_error = payload.get("error")
    if isinstance(raw_error, str) and raw_error.strip():
        return None, raw_error.strip()

    return payload, None


def _fetch_r2_backup_window(
    base_url: str,
    headers: Dict[str, str],
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    public_headers = dict(headers)
    public_headers["Accept-Profile"] = PUBLIC_SCHEMA
    try:
        rows = _fetch_json(
            f"{base_url}/rpc/{R2_BACKUP_WINDOW_RPC}",
            public_headers,
            {},
        )
    except Exception as exc:
        return None, str(exc)

    if not rows:
        return {
            "min_day_utc": None,
            "max_day_utc": None,
            "day_count": None,
            "count_basis": "range_rpc_fallback",
        }, None
    row = rows[0] if isinstance(rows[0], dict) else {}
    return {
        "min_day_utc": _normalize_iso_date(row.get("min_day_utc")),
        "max_day_utc": _normalize_iso_date(row.get("max_day_utc")),
        "day_count": None,
        "count_basis": "range_rpc_fallback",
    }, None


def _fetch_r2_account_metrics(now: datetime) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    account_id = str(os.getenv("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    api_token = str(os.getenv("CFLARE_API_READ_TOKEN") or "").strip()
    if not account_id or not api_token:
        return None, "missing CLOUDFLARE_ACCOUNT_ID or CFLARE_API_READ_TOKEN"

    free_tier_raw = str(os.getenv("UK_AQ_R2_FREE_TIER_GB", "10")).strip()
    free_tier_gb = _safe_number(free_tier_raw)
    if free_tier_gb is None or free_tier_gb <= 0:
        return None, "invalid UK_AQ_R2_FREE_TIER_GB"
    class_a_free_tier_raw = str(
        os.getenv("UK_AQ_R2_FREE_TIER_CLASS_A_REQUESTS", "1000000")
    ).strip()
    class_b_free_tier_raw = str(
        os.getenv("UK_AQ_R2_FREE_TIER_CLASS_B_REQUESTS", "10000000")
    ).strip()
    class_a_free_tier = _safe_number(class_a_free_tier_raw)
    class_b_free_tier = _safe_number(class_b_free_tier_raw)
    if class_a_free_tier is None or class_a_free_tier <= 0:
        return None, "invalid UK_AQ_R2_FREE_TIER_CLASS_A_REQUESTS"
    if class_b_free_tier is None or class_b_free_tier <= 0:
        return None, "invalid UK_AQ_R2_FREE_TIER_CLASS_B_REQUESTS"

    storage_source = "cloudflare_r2_storage_adaptive_groups_2h"
    storage_fetch_warning: Optional[str] = None
    standard_used_bytes = 0
    standard_objects = 0
    with ThreadPoolExecutor(max_workers=2) as executor:
        storage_future = executor.submit(
            _fetch_r2_storage_fallback_metrics,
            account_id,
            api_token,
            now,
        )
        ops_future = executor.submit(
            _fetch_r2_operations_metrics,
            account_id,
            api_token,
            now,
        )
        storage_metrics, storage_error = storage_future.result()
        ops_metrics, ops_error = ops_future.result()
    if storage_metrics is not None:
        standard_used_bytes = int(storage_metrics.get("standard_used_bytes") or 0)
        standard_objects = int(storage_metrics.get("standard_objects") or 0)
    else:
        storage_fetch_warning = storage_error

    # Backup path: if storage analytics return empty/zero, fall back to R2 REST metrics.
    if standard_used_bytes <= 0 and standard_objects <= 0:
        storage_source = "cloudflare_r2_account_metrics_backup"
        url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/r2/metrics"
        try:
            resp = requests.get(
                url,
                headers={
                    "Authorization": f"Bearer {api_token}",
                    "Content-Type": "application/json",
                },
                timeout=30,
            )
        except requests.RequestException as exc:
            if storage_fetch_warning:
                return None, f"{storage_fetch_warning}; R2 metrics request failed ({exc.__class__.__name__})"
            return None, f"R2 metrics request failed ({exc.__class__.__name__})"
        if not resp.ok:
            if storage_fetch_warning:
                return None, f"{storage_fetch_warning}; R2 metrics HTTP {resp.status_code}"
            return None, f"R2 metrics HTTP {resp.status_code}"

        try:
            payload = resp.json()
        except ValueError:
            if storage_fetch_warning:
                return None, f"{storage_fetch_warning}; R2 metrics returned non-JSON payload"
            return None, "R2 metrics returned non-JSON payload"
        if not isinstance(payload, dict):
            if storage_fetch_warning:
                return None, f"{storage_fetch_warning}; R2 metrics payload is not an object"
            return None, "R2 metrics payload is not an object"
        if payload.get("success") is not True:
            if storage_fetch_warning:
                return None, f"{storage_fetch_warning}; R2 metrics API reported success=false"
            return None, "R2 metrics API reported success=false"

        result = payload.get("result")
        if not isinstance(result, dict):
            if storage_fetch_warning:
                return None, f"{storage_fetch_warning}; R2 metrics missing result object"
            return None, "R2 metrics missing result object"

        standard = result.get("standard")
        if not isinstance(standard, dict):
            if storage_fetch_warning:
                return None, f"{storage_fetch_warning}; R2 metrics missing standard section"
            return None, "R2 metrics missing standard section"
        # Validate both sections defensively, but always prefer published usage.
        published_point = _extract_r2_usage_point(standard.get("published"))
        uploaded_point = _extract_r2_usage_point(standard.get("uploaded"))
        selected_point = published_point or uploaded_point
        if selected_point is None:
            if storage_fetch_warning:
                return None, f"{storage_fetch_warning}; R2 metrics missing standard usage values"
            return None, "R2 metrics missing standard usage values"

        standard_used_bytes = int(round(selected_point["used_bytes"]))
        standard_objects = int(round(selected_point["objects"]))
    free_bytes = int(free_tier_gb * R2_BYTES_PER_GB)
    percent_used = 0.0
    if free_bytes > 0:
        percent_used = (standard_used_bytes / free_bytes) * 100.0
    percent_used = _clamp_percent(percent_used)
    used_gb = standard_used_bytes / R2_BYTES_PER_GB

    payload: Dict[str, Any] = {
        "standard_used_bytes": standard_used_bytes,
        "standard_used_gb": used_gb,
        "standard_objects": standard_objects,
        "free_tier_gb": float(free_tier_gb),
        "percent_of_free_tier": percent_used,
        "class_a_used_requests": None,
        "class_b_used_requests": None,
        "class_a_free_tier_requests": int(round(class_a_free_tier)),
        "class_b_free_tier_requests": int(round(class_b_free_tier)),
        "class_a_percent_of_free_tier": None,
        "class_b_percent_of_free_tier": None,
        "class_ops_unclassified_requests": None,
        "class_ops_unclassified_action_types": [],
        "class_ops_window_start_utc": None,
        "class_ops_window_end_utc": None,
        "class_ops_error": None,
        "storage_source": storage_source,
        "storage_fallback_error": storage_fetch_warning,
        "source": "cloudflare_r2_account_metrics",
        "as_of_utc": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if ops_metrics is None:
        payload["class_ops_error"] = ops_error
        return payload, None

    class_a_used_requests = int(ops_metrics.get("class_a_requests") or 0)
    class_b_used_requests = int(ops_metrics.get("class_b_requests") or 0)
    class_a_percent = _clamp_percent((class_a_used_requests / class_a_free_tier) * 100.0)
    class_b_percent = _clamp_percent((class_b_used_requests / class_b_free_tier) * 100.0)
    payload["class_a_used_requests"] = class_a_used_requests
    payload["class_b_used_requests"] = class_b_used_requests
    payload["class_a_percent_of_free_tier"] = class_a_percent
    payload["class_b_percent_of_free_tier"] = class_b_percent
    payload["class_ops_unclassified_requests"] = int(
        ops_metrics.get("unclassified_requests") or 0
    )
    payload["class_ops_unclassified_action_types"] = ops_metrics.get(
        "unclassified_action_types"
    ) or []
    payload["class_ops_window_start_utc"] = ops_metrics.get("window_start_utc")
    payload["class_ops_window_end_utc"] = ops_metrics.get("window_end_utc")
    return payload, None


def _get_r2_usage_cached(
    *,
    force_refresh: bool = False,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    now = datetime.now(timezone.utc)
    with CACHE_LOCK:
        cached_usage = R2_CACHE_STATE.get("usage")
        cached_error = R2_CACHE_STATE.get("error")
        generated_at = R2_CACHE_STATE.get("generated_at")
        if (
            not force_refresh
            and isinstance(generated_at, datetime)
            and (now - generated_at).total_seconds() < R2_CACHE_TTL_SECONDS
        ):
            return cached_usage, cached_error

    usage, error = _fetch_r2_account_metrics(now)
    with CACHE_LOCK:
        R2_CACHE_STATE["usage"] = usage
        R2_CACHE_STATE["error"] = error
        R2_CACHE_STATE["generated_at"] = datetime.now(timezone.utc)
    return usage, error


def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if re.search(r"[+-]\d{2}$", text):
        text = text + ":00"
    if re.search(r"[+-]\d{4}$", text):
        text = text[:-2] + ":" + text[-2:]
    fraction = re.search(r"\.(\d+)", text)
    if fraction:
        digits = fraction.group(1)
        if len(digits) > 6:
            digits = digits[:6]
        else:
            digits = digits.ljust(6, "0")
        text = text[: fraction.start(1)] + digits + text[fraction.end(1) :]
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        if " " in text:
            try:
                return datetime.fromisoformat(text.replace(" ", "T", 1))
            except ValueError:
                return None
        return None


def _to_postgrest_ts(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00",
        "Z",
    )


def _parse_snapshot_station_id(raw_value: str) -> Optional[int]:
    value = (raw_value or "").strip()
    if not value:
        return None
    parsed = int(value)
    if parsed < 0:
        raise ValueError("station_id must be a non-negative integer")
    return parsed


def _parse_snapshot_station_ref(raw_value: str) -> Optional[str]:
    value = (raw_value or "").strip()
    if not value:
        return None
    return value


def _parse_snapshot_timeseries_id(raw_value: str) -> Optional[int]:
    value = (raw_value or "").strip()
    if not value:
        return None
    parsed = int(value)
    if parsed < -2147483648 or parsed > 2147483647:
        raise ValueError("timeseries_id is out of int4 range")
    return parsed


def _parse_snapshot_window(raw_value: str) -> str:
    normalized = (raw_value or "").strip().lower() or "24h"
    if normalized not in {"6h", "24h", "7d", "21d", "31d", "90d"}:
        raise ValueError("window must be one of: 6h, 24h, 7d, 21d, 31d, 90d")
    return normalized


def _parse_snapshot_obs_limit(raw_value: str) -> Optional[int]:
    normalized = (raw_value or "").strip().lower()
    if not normalized or normalized == "all":
        return None
    parsed = int(normalized)
    if parsed <= 0:
        raise ValueError("obs_limit must be a positive integer or 'all'")
    return parsed


def _rpc_obs_limit(obs_limit: Optional[int]) -> int:
    if obs_limit is None:
        return 1000
    return 1000 if obs_limit >= 1000 else 100


def _build_station_snapshot_payload(
    base_url: str,
    service_role_key: str,
    station_id: Optional[int],
    station_ref: Optional[str],
    timeseries_id: Optional[int],
    window: str,
    obs_limit: Optional[int],
) -> Dict[str, Any]:
    headers = _postgrest_headers(service_role_key, schema=PUBLIC_SCHEMA)
    headers["Content-Type"] = "application/json"
    payload = _post_json_object(
        f"{base_url}/rpc/{STATION_SNAPSHOT_RPC}",
        headers,
        {
            "p_station_id": station_id,
            "p_station_ref": station_ref,
            "p_timeseries_id": timeseries_id,
            "p_window": window,
            "p_obs_limit": _rpc_obs_limit(obs_limit),
        },
    )

    observations = payload.get("observations")
    if not isinstance(observations, list):
        observations = []
        payload["observations"] = observations

    # Keep the hosted payload compatible with the station_snapshot frontend shape.
    payload.setdefault("observations_all", list(observations))
    payload.setdefault("obs_aqidb_observations", [])
    payload.setdefault("obs_aqidb_observations_all", [])
    payload.setdefault("obs_aqidb_timeseries_aqi_hourly", [])
    payload.setdefault("obs_aqidb_timeseries_aqi_daily", [])

    meta_value = payload.get("meta")
    if not isinstance(meta_value, dict):
        meta_value = {}
        payload["meta"] = meta_value
    meta_value.setdefault("ingest_source", "service_role_postgrest_rpc")
    meta_value.setdefault("obs_aqidb_source", "unavailable")
    meta_value.setdefault("requested_obs_limit", "all" if obs_limit is None else obs_limit)

    return payload


def _dispatch_run_timestamp(row: Dict[str, Any]) -> Optional[datetime]:
    return _parse_timestamp(
        (row.get("run_ended_at") if isinstance(row, dict) else None)
        or (row.get("run_started_at") if isinstance(row, dict) else None)
    )


def _dispatch_created_timestamp(row: Dict[str, Any]) -> Optional[datetime]:
    return _parse_timestamp(row.get("created_at") if isinstance(row, dict) else None)


def _dispatch_row_key(row: Dict[str, Any]) -> str:
    row_id = row.get("id")
    if row_id is not None:
        return f"id:{row_id}"
    return (
        "fallback:"
        f"{row.get('connector_id')}|{row.get('run_started_at')}|"
        f"{row.get('run_ended_at')}|{row.get('run_status')}"
    )


def _merge_dispatch_runs(
    existing: List[Dict[str, Any]],
    incoming: List[Dict[str, Any]],
    *,
    window_start: datetime,
) -> List[Dict[str, Any]]:
    by_key: Dict[str, Dict[str, Any]] = {}
    for row in [*existing, *incoming]:
        key = _dispatch_row_key(row)
        current = by_key.get(key)
        if current is None:
            by_key[key] = row
            continue
        current_created = _dispatch_created_timestamp(current)
        row_created = _dispatch_created_timestamp(row)
        if _timestamp_or_min(row_created) >= _timestamp_or_min(current_created):
            by_key[key] = row

    merged = list(by_key.values())
    filtered = []
    for row in merged:
        run_ts = _dispatch_run_timestamp(row)
        created_ts = _dispatch_created_timestamp(row)
        if (run_ts and run_ts >= window_start) or (
            created_ts and created_ts >= window_start
        ):
            filtered.append(row)

    filtered.sort(
        key=lambda item: _dispatch_run_timestamp(item)
        or _dispatch_created_timestamp(item)
        or UTC_DATETIME_MIN,
        reverse=True,
    )
    if len(filtered) > DISPATCH_MAX_ROWS:
        return filtered[:DISPATCH_MAX_ROWS]
    return filtered


def _get_ingest_runs_cached(
    base_url: str,
    headers: Dict[str, str],
    now: datetime,
    dispatch_cursor: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    window_start = now - timedelta(minutes=DISPATCH_OBSERVS_WINDOW_MINUTES)
    with CACHE_LOCK:
        cached_rows: List[Dict[str, Any]] = list(DISPATCH_RUNS_STATE.get("rows") or [])
        latest_created_at = DISPATCH_RUNS_STATE.get("latest_created_at")

    created_since: Optional[datetime]
    # On cold start (no cached rows), always hydrate the full lookback window.
    # Otherwise a persisted UI cursor from a previous session can cause a partial
    # incremental fetch that misses quieter connectors.
    if not cached_rows:
        created_since = window_start
    elif isinstance(latest_created_at, datetime):
        created_since = latest_created_at - timedelta(
            seconds=DISPATCH_INCREMENTAL_OVERLAP_SECONDS
        )
    elif isinstance(dispatch_cursor, datetime):
        created_since = dispatch_cursor - timedelta(
            seconds=DISPATCH_INCREMENTAL_OVERLAP_SECONDS
        )
    else:
        created_since = window_start
    if created_since < window_start:
        created_since = window_start

    incoming = _fetch_ingest_runs(
        base_url,
        headers,
        created_since=created_since,
    )
    merged = _merge_dispatch_runs(cached_rows, incoming, window_start=window_start)
    newest_created = max(
        (
            _dispatch_created_timestamp(row)
            for row in merged
            if _dispatch_created_timestamp(row) is not None
        ),
        default=latest_created_at if isinstance(latest_created_at, datetime) else None,
    )

    with CACHE_LOCK:
        DISPATCH_RUNS_STATE["rows"] = merged
        DISPATCH_RUNS_STATE["latest_created_at"] = newest_created
    return list(merged)


def _is_truthy_flag(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        candidate = value.strip().lower()
    else:
        candidate = str(value).strip().lower()
    return candidate in {"y", "yes", "true", "1"}


def _extract_pollutant_key(row: Dict[str, Any]) -> Optional[str]:
    candidates: List[str] = []
    phenomenon = row.get("phenomenon") or {}
    for key in ("notation", "pollutant_label", "label"):
        value = phenomenon.get(key)
        if value:
            candidates.append(str(value))
    if row.get("label"):
        candidates.append(str(row["label"]))

    for candidate in candidates:
        cleaned = _normalize_token(candidate)
        for pollutant_key, tokens in NORMALIZED_POLLUTANT_TOKENS.items():
            for token in tokens:
                if token in cleaned:
                    return pollutant_key
    return None


def _bucket_for(latest_at: datetime, now: datetime) -> str:
    if latest_at >= now - timedelta(hours=3):
        return "0-3 Hours"
    if latest_at >= now - timedelta(hours=6):
        return "3-6 Hours"
    if latest_at >= now - timedelta(hours=24):
        return "6-24 Hours"
    if latest_at >= now - timedelta(days=7):
        return "1 - 7 Days"
    return "Older than 7 Days"


def _fetch_storage_coverage_context(
    base_url: str,
    headers: Dict[str, str],
    now: datetime,
) -> Dict[str, Any]:
    (
        db_size_metrics,
        schema_size_metrics,
        r2_domain_size_metrics,
        db_size_metrics_error,
        schema_size_metrics_error,
        r2_domain_size_metrics_error,
    ) = _fetch_size_metrics(
        base_url,
        headers,
        now,
    )
    (
        r2_history_days,
        r2_backup_window_from_history_days,
        r2_history_days_bucket,
        r2_history_days_error,
    ) = _get_r2_history_days_cached(force_refresh=False)
    r2_backup_window_rpc, r2_backup_window_rpc_error = _fetch_r2_backup_window(
        base_url,
        headers,
    )
    r2_backup_window = (
        r2_backup_window_from_history_days
        if r2_backup_window_from_history_days is not None
        else r2_backup_window_rpc
    )
    r2_backup_window_error = _join_error_messages(
        r2_history_days_error,
        r2_backup_window_rpc_error if r2_backup_window_from_history_days is None else None,
    )
    if r2_history_days_error is None:
        (
            r2_domain_size_metrics,
            r2_domain_filter_error,
        ) = _filter_r2_domain_metrics_to_committed_days(
            r2_domain_size_metrics,
            r2_history_days,
        )
        r2_domain_size_metrics_error = _join_error_messages(
            r2_domain_size_metrics_error,
            r2_domain_filter_error,
        )
    dropbox_backup_days, dropbox_state_path, dropbox_state_error = _load_dropbox_backup_days()
    return {
        "db_size_metrics": db_size_metrics,
        "schema_size_metrics": schema_size_metrics,
        "r2_domain_size_metrics": r2_domain_size_metrics,
        "db_size_metrics_error": db_size_metrics_error,
        "schema_size_metrics_error": schema_size_metrics_error,
        "r2_domain_size_metrics_error": r2_domain_size_metrics_error,
        "r2_history_days": r2_history_days,
        "r2_backup_window": r2_backup_window,
        "r2_backup_window_error": r2_backup_window_error,
        "r2_history_days_bucket": r2_history_days_bucket,
        "r2_history_days_error": r2_history_days_error,
        "dropbox_backup_days": dropbox_backup_days,
        "dropbox_state_path": dropbox_state_path,
        "dropbox_state_error": dropbox_state_error,
    }


def _build_dashboard(
    base_url: str,
    service_role_key: str,
    dispatch_cursor: Optional[datetime] = None,
    include_storage_coverage: bool = True,
) -> Dict[str, Any]:
    headers = _postgrest_headers(service_role_key)
    project_ref = _project_ref_from_base_url(base_url)

    connectors = _fetch_all(
        base_url,
        headers,
        "connectors",
        {
            "select": "id,connector_code,label,display_name,last_run_start,last_run_end,poll_enabled,poll_interval_minutes,poll_window_hours,poll_timeseries_batch_size,scheduler_backend",
            "order": "connector_code.asc",
        },
    )
    connector_map = {
        row["id"]: {
            "connector_code": row.get("connector_code"),
            "label": row.get("label"),
        }
        for row in connectors
        if row.get("id") is not None
    }

    stations = _fetch_all(
        base_url,
        headers,
        "stations",
        {
            "select": "id,connector_id,service_ref,removed_at",
        },
    )
    station_metadata = _fetch_all(
        base_url,
        headers,
        "station_metadata",
        {
            "select": "station_id,attributes",
        },
    )
    metadata_by_station = {
        row.get("station_id"): row.get("attributes") or {}
        for row in station_metadata
        if row.get("station_id") is not None
    }
    active_station_keys: Dict[Tuple[int, int], bool] = {}
    for row in stations:
        station_id = row.get("id")
        connector_id = row.get("connector_id")
        if station_id is None or connector_id is None:
            continue
        if row.get("removed_at") is not None:
            active_station_keys[(connector_id, station_id)] = False
            continue
        connector_meta = connector_map.get(connector_id, {})
        connector_code = connector_meta.get("connector_code") or ""
        service_ref = row.get("service_ref") or ""
        if connector_code == "breathelondon" and service_ref == "breathelondon":
            attributes = metadata_by_station.get(station_id, {})
            enabled_ok = _is_truthy_flag(attributes.get("enabled"))
            active_ok = _is_truthy_flag(attributes.get("site_active"))
            active_station_keys[(connector_id, station_id)] = enabled_ok or active_ok
        else:
            active_station_keys[(connector_id, station_id)] = True

    now = datetime.now(timezone.utc)
    coverage_context = _fetch_storage_coverage_context(
        base_url,
        headers,
        now,
    )
    db_size_metrics = coverage_context["db_size_metrics"]
    schema_size_metrics = coverage_context["schema_size_metrics"]
    r2_domain_size_metrics = coverage_context["r2_domain_size_metrics"]
    db_size_metrics_error = coverage_context["db_size_metrics_error"]
    schema_size_metrics_error = coverage_context["schema_size_metrics_error"]
    r2_domain_size_metrics_error = coverage_context["r2_domain_size_metrics_error"]
    r2_history_days = coverage_context["r2_history_days"]
    r2_backup_window = coverage_context["r2_backup_window"]
    r2_backup_window_error = coverage_context["r2_backup_window_error"]
    r2_history_days_bucket = coverage_context["r2_history_days_bucket"]
    r2_history_days_error = coverage_context["r2_history_days_error"]
    dropbox_backup_days = coverage_context["dropbox_backup_days"]
    dropbox_state_path = coverage_context["dropbox_state_path"]
    dropbox_state_error = coverage_context["dropbox_state_error"]
    r2_usage, r2_usage_error = _get_r2_usage_cached(force_refresh=False)
    ingest_runs = _get_ingest_runs_cached(
        base_url,
        headers,
        now,
        dispatch_cursor=dispatch_cursor,
    )
    dispatcher_settings = _fetch_dispatcher_settings(base_url, headers)
    in_flight_rows: List[Dict[str, Any]] = []
    latest_run_by_connector: Dict[int, Dict[str, Any]] = {}
    for row in ingest_runs:
        connector_id = row.get("connector_id")
        if connector_id is None:
            continue
        timestamp = _parse_timestamp(row.get("run_ended_at") or row.get("run_started_at"))
        if not timestamp:
            continue
        current = latest_run_by_connector.get(connector_id)
        if current is None:
            latest_run_by_connector[connector_id] = row
            continue
        current_ts = _parse_timestamp(current.get("run_ended_at") or current.get("run_started_at"))
        if not current_ts or timestamp > current_ts:
            latest_run_by_connector[connector_id] = row

    for connector in connectors:
        connector_id = connector.get("id")
        if connector_id is None:
            continue
        latest_run = latest_run_by_connector.get(connector_id)
        if latest_run:
            last_run_start = _parse_timestamp(latest_run.get("run_started_at"))
            last_run_end = _parse_timestamp(latest_run.get("run_ended_at"))
            if last_run_start and not last_run_end:
                minutes = max(0, int((now - last_run_start).total_seconds() / 60))
                in_flight_rows.append(
                    {
                        "connector_id": connector_id,
                        "connector_code": latest_run.get("connector_code") or connector.get("connector_code"),
                        "connector_label": connector.get("label")
                        or latest_run.get("connector_code")
                        or "",
                        "run_started_at": last_run_start.isoformat().replace("+00:00", "Z"),
                        "run_ended_at": None,
                        "run_status": "running",
                        "run_message": "in_flight",
                        "last_observed_at": None,
                        "stations_updated": None,
                        "observations_upserted": None,
                        "timeseries_updated": None,
                        "series_polled": None,
                        "run_timestamp": last_run_start.isoformat().replace("+00:00", "Z"),
                        "in_flight_minutes": minutes,
                        "in_flight_over_threshold": minutes >= IN_FLIGHT_WARN_MINUTES,
                    }
                )
            continue
        last_run_start = _parse_timestamp(connector.get("last_run_start"))
        last_run_end = _parse_timestamp(connector.get("last_run_end"))
        if last_run_start and not last_run_end:
            minutes = max(0, int((now - last_run_start).total_seconds() / 60))
            if minutes <= IN_FLIGHT_MAX_AGE_MINUTES:
                in_flight_rows.append(
                    {
                        "connector_id": connector_id,
                        "connector_code": connector.get("connector_code"),
                        "connector_label": connector.get("label")
                        or connector.get("connector_code")
                        or "",
                        "run_started_at": last_run_start.isoformat().replace("+00:00", "Z"),
                        "run_ended_at": None,
                        "run_status": "running",
                        "run_message": "in_flight",
                        "last_observed_at": None,
                        "stations_updated": None,
                        "observations_upserted": None,
                        "timeseries_updated": None,
                        "series_polled": None,
                        "run_timestamp": last_run_start.isoformat().replace("+00:00", "Z"),
                        "in_flight_minutes": minutes,
                        "in_flight_over_threshold": minutes >= IN_FLIGHT_WARN_MINUTES,
                    }
                )
    for row in ingest_runs:
        connector_id = row.get("connector_id")
        meta = connector_map.get(connector_id, {})
        row["connector_label"] = meta.get("label") or row.get("connector_code") or ""
        row["run_timestamp"] = row.get("run_ended_at") or row.get("run_started_at")
        row.setdefault("in_flight_minutes", None)
        row.setdefault("in_flight_over_threshold", False)

    dispatch_runs = in_flight_rows + ingest_runs
    dispatch_runs.sort(
        key=lambda item: _parse_timestamp(item.get("run_timestamp"))
        or UTC_DATETIME_MIN,
        reverse=True,
    )

    timeseries_rows = _fetch_all(
        base_url,
        headers,
        "timeseries",
        {
            "select": "station_id,connector_id,last_value,last_value_at,label,phenomenon:phenomena(label,notation,pollutant_label)",
            "last_value_at": "not.is.null",
            "last_value": "not.is.null",
        },
    )

    latest_by_pollutant: Dict[str, Dict[Tuple[int, int], datetime]] = {
        pollutant_key: {}
        for pollutant_key in POLLUTANTS.keys()
    }
    active_by_pollutant: Dict[str, Dict[Tuple[int, int], bool]] = {
        pollutant_key: {}
        for pollutant_key in POLLUTANTS.keys()
    }

    for row in timeseries_rows:
        station_id = row.get("station_id")
        connector_id = row.get("connector_id")
        if station_id is None or connector_id is None:
            continue
        latest_at = _parse_timestamp(row.get("last_value_at"))
        if not latest_at:
            continue
        pollutant_key = _extract_pollutant_key(row)
        if pollutant_key not in latest_by_pollutant:
            continue
        key = (connector_id, station_id)
        current = latest_by_pollutant[pollutant_key].get(key)
        if current is None or latest_at > current:
            latest_by_pollutant[pollutant_key][key] = latest_at
        if active_station_keys.get(key):
            active_by_pollutant[pollutant_key][key] = True

    pollutants_payload: List[Dict[str, Any]] = []

    for pollutant_key, config in POLLUTANTS.items():
        connector_counts: Dict[int, Dict[str, Any]] = {}
        excluded_connectors = EXCLUDED_CONNECTORS_BY_POLLUTANT.get(pollutant_key, set())
        for connector_id, meta in connector_map.items():
            connector_code = meta.get("connector_code") or ""
            if connector_code in excluded_connectors:
                continue
            connector_counts[connector_id] = {
                "connector_code": meta.get("connector_code") or "",
                "label": meta.get("label") or "",
                "stations_with_pollutant": 0,
                "active_stations_with_pollutant": 0,
                "buckets": {bucket: 0 for bucket in BUCKETS},
            }

        for (connector_id, _station_id), latest_at in latest_by_pollutant[pollutant_key].items():
            meta = connector_map.get(connector_id, {})
            connector_code = meta.get("connector_code") or ""
            if connector_code in excluded_connectors:
                continue
            bucket = _bucket_for(latest_at, now)
            entry = connector_counts.setdefault(
                connector_id,
                {
                    "connector_code": "",
                    "label": "",
                    "stations_with_pollutant": 0,
                    "active_stations_with_pollutant": 0,
                    "buckets": {bucket_name: 0 for bucket_name in BUCKETS},
                },
            )
            entry["stations_with_pollutant"] += 1
            entry["buckets"][bucket] += 1
            if active_by_pollutant[pollutant_key].get((connector_id, _station_id)):
                entry["active_stations_with_pollutant"] += 1

        connectors_payload = list(connector_counts.values())
        connectors_payload.sort(key=lambda row: row.get("connector_code") or "")

        pollutants_payload.append(
            {
                "key": pollutant_key,
                "label": config["label"],
                "connectors": connectors_payload,
            },
        )

    next_dispatch_cursor: Optional[str] = None
    with CACHE_LOCK:
        latest_created_at = DISPATCH_RUNS_STATE.get("latest_created_at")
        if isinstance(latest_created_at, datetime):
            next_dispatch_cursor = _to_postgrest_ts(latest_created_at)

    storage_coverage_days: List[Dict[str, Any]] = []
    if include_storage_coverage:
        storage_coverage_days = _get_storage_coverage_days_cached(
            now=now,
            base_url=base_url,
            service_role_key=service_role_key,
            db_size_metrics=db_size_metrics,
            schema_size_metrics=schema_size_metrics,
            r2_domain_size_metrics=r2_domain_size_metrics,
            dropbox_backup_days=dropbox_backup_days,
            r2_backup_window=r2_backup_window,
            r2_history_days=r2_history_days,
        )

    return {
        "project_ref": project_ref,
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "dispatch_cursor": next_dispatch_cursor,
        "buckets": list(BUCKETS),
        "db_size_metrics": db_size_metrics,
        "schema_size_metrics": schema_size_metrics,
        "r2_domain_size_metrics": r2_domain_size_metrics,
        "db_size_metrics_error": db_size_metrics_error,
        "schema_size_metrics_error": schema_size_metrics_error,
        "r2_domain_size_metrics_error": r2_domain_size_metrics_error,
        "r2_usage": r2_usage,
        "r2_usage_error": r2_usage_error,
        "r2_backup_window": r2_backup_window,
        "r2_backup_window_error": r2_backup_window_error,
        "r2_history_days_bucket": r2_history_days_bucket,
        "r2_history_days_error": r2_history_days_error,
        "dropbox_backup_state_path": dropbox_state_path,
        "dropbox_backup_state_error": dropbox_state_error,
        "storage_coverage_source": "live_per_day_presence",
        "storage_coverage_days": storage_coverage_days,
        "pollutants": pollutants_payload,
        "dispatch_runs": dispatch_runs,
        "dispatcher_settings": dispatcher_settings,
        "connectors_settings": [
            {
                "id": row.get("id"),
                "connector_code": row.get("connector_code"),
                "label": row.get("label"),
                "display_name": row.get("display_name"),
                "poll_enabled": row.get("poll_enabled"),
                "poll_interval_minutes": row.get("poll_interval_minutes"),
                "poll_window_hours": row.get("poll_window_hours"),
                "poll_timeseries_batch_size": row.get("poll_timeseries_batch_size"),
                "scheduler_backend": row.get("scheduler_backend")
                or SCHEDULER_BACKEND_SUPABASE_FUNCTION,
            }
            for row in connectors
            if row.get("id") is not None
        ],
    }


def _get_dashboard(
    base_url: str,
    service_role_key: str,
    dispatch_cursor: Optional[datetime] = None,
    include_storage_coverage: bool = True,
) -> Dict[str, Any]:
    # Cursor-based requests are incremental and should not be served from the shared cache.
    if dispatch_cursor is not None:
        return _build_dashboard(
            base_url,
            service_role_key,
            dispatch_cursor=dispatch_cursor,
            include_storage_coverage=include_storage_coverage,
        )

    cache_bucket = _dashboard_cache_bucket(include_storage_coverage)
    with CACHE_LOCK:
        bucket_state = CACHE_STATE.get(cache_bucket) or {}
        cached = bucket_state.get("data")
        generated_at = bucket_state.get("generated_at")
        if cached and isinstance(generated_at, datetime):
            age = (datetime.now(timezone.utc) - generated_at).total_seconds()
            if age < CACHE_TTL_SECONDS:
                return cached
    data = _build_dashboard(
        base_url,
        service_role_key,
        dispatch_cursor=dispatch_cursor,
        include_storage_coverage=include_storage_coverage,
    )
    with CACHE_LOCK:
        bucket_state = CACHE_STATE.setdefault(cache_bucket, {})
        bucket_state["data"] = data
        bucket_state["generated_at"] = datetime.now(timezone.utc)
    return data


def _build_storage_coverage_payload(
    base_url: str,
    service_role_key: str,
) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    storage_coverage_days = _get_cached_storage_coverage_days(now)
    if storage_coverage_days is None:
        headers = _postgrest_headers(service_role_key)
        coverage_context = _fetch_storage_coverage_context(
            base_url,
            headers,
            now,
        )
        storage_coverage_days = _get_storage_coverage_days_cached(
            now=now,
            base_url=base_url,
            service_role_key=service_role_key,
            db_size_metrics=coverage_context["db_size_metrics"],
            schema_size_metrics=coverage_context["schema_size_metrics"],
            r2_domain_size_metrics=coverage_context["r2_domain_size_metrics"],
            dropbox_backup_days=coverage_context["dropbox_backup_days"],
            r2_backup_window=coverage_context["r2_backup_window"],
            r2_history_days=coverage_context["r2_history_days"],
        )

    return {
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "storage_coverage_source": "live_per_day_presence",
        "storage_coverage_days": storage_coverage_days,
    }


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "uk-aq-dashboard/1.0"

    @staticmethod
    def _is_client_disconnect_error(exc: Exception) -> bool:
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return True
        if isinstance(exc, OSError):
            # Common client disconnect errnos:
            # 32=EPIPE, 53=ECONNABORTED, 54=ECONNRESET, 104=ECONNRESET (Linux).
            return exc.errno in {32, 53, 54, 104}
        return False

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/") and not self._authorize_api_request():
                return
            if parsed.path in ("/", "/index.html"):
                self._serve_html()
                return
            if parsed.path == "/favicon.ico":
                self._serve_asset("favicon.png")
                return
            if parsed.path.startswith("/assets/"):
                self._serve_asset(parsed.path[len("/assets/"):])
                return
            if parsed.path == "/api/config":
                self._serve_snapshot_config()
                return
            if parsed.path == "/api/snapshot":
                self._serve_station_snapshot(parsed)
                return
            if parsed.path == "/api/r2_metrics":
                self._serve_r2_metrics(parsed)
                return
            if parsed.path == "/api/dashboard":
                self._serve_dashboard(parsed)
                return
            if parsed.path == "/api/storage_coverage":
                self._serve_storage_coverage(parsed)
                return
            if parsed.path == "/api/r2_connector_counts":
                self._serve_r2_connector_counts(parsed)
                return
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
        except Exception as exc:
            if self._is_client_disconnect_error(exc):
                return
            raise

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/") and not self._authorize_api_request():
                return
            if parsed.path == "/api/connectors":
                self._update_connectors()
                return
            if parsed.path == "/api/dispatcher_settings":
                self._update_dispatcher_settings()
                return
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
        except Exception as exc:
            if self._is_client_disconnect_error(exc):
                return
            raise

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _authorize_api_request(self) -> bool:
        required_token = str(getattr(self.server, "upstream_bearer_token", "") or "").strip()
        if not required_token:
            return True
        auth_header = str(self.headers.get("Authorization") or "").strip()
        expected_header = f"Bearer {required_token}"
        if secrets.compare_digest(auth_header, expected_header):
            return True

        payload = json.dumps({"error": "Unauthorized"}, indent=2)
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("WWW-Authenticate", 'Bearer realm="uk-aq-dashboard-backend"')
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))
        return False

    def _serve_html(self) -> None:
        html_path: Path = self.server.html_path
        try:
            content = html_path.read_text(encoding="utf-8")
        except OSError as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

    def _serve_asset(self, relative_path: str) -> None:
        safe_relative = relative_path.strip().lstrip("/")
        if not safe_relative:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        root_dir = self.server.html_path.parent.resolve()
        asset_root = (root_dir / "assets").resolve()
        asset_path = (asset_root / safe_relative).resolve()
        try:
            asset_path.relative_to(asset_root)
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not asset_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        suffix = asset_path.suffix.lower()
        if suffix == ".svg":
            content_type = "image/svg+xml"
        elif suffix == ".png":
            content_type = "image/png"
        elif suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif suffix == ".css":
            content_type = "text/css; charset=utf-8"
        else:
            content_type = "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(asset_path.read_bytes())

    def _serve_dashboard(self, parsed) -> None:
        dispatch_cursor: Optional[datetime] = None
        query = parse_qs(parsed.query, keep_blank_values=False)
        force_refresh_raw = ((query.get("force") or [""])[0] or "").strip().lower()
        force_refresh = force_refresh_raw in {"1", "true", "yes", "y", "on"}
        include_storage_coverage_raw = ((query.get("include_storage_coverage") or ["1"])[0] or "").strip().lower()
        include_storage_coverage = include_storage_coverage_raw not in {"0", "false", "no", "n", "off"}
        cursor_values = query.get("dispatch_cursor") or []
        if cursor_values:
            parsed_cursor = _parse_timestamp(cursor_values[0])
            if isinstance(parsed_cursor, datetime):
                now = datetime.now(timezone.utc)
                # Reject far-future cursors; clamp old cursors via observs window in fetch path.
                if parsed_cursor <= now + timedelta(minutes=5):
                    dispatch_cursor = parsed_cursor
        if force_refresh:
            _invalidate_dashboard_cache(clear_storage_coverage=True)
        try:
            data = _get_dashboard(
                self.server.base_url,
                self.server.service_role_key,
                dispatch_cursor=dispatch_cursor,
                include_storage_coverage=include_storage_coverage,
            )
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        payload = json.dumps(data, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _serve_snapshot_config(self) -> None:
        default_obs_limit = STATION_SNAPSHOT_DEFAULT_OBS_LIMIT
        if default_obs_limit not in {"all", "100", "1000", "5000", "10000"}:
            default_obs_limit = "all"

        payload = json.dumps(
            {
                "edge_url": f"{self.server.base_url}/rpc/{STATION_SNAPSHOT_RPC}",
                "default_station_id": STATION_SNAPSHOT_DEFAULT_STATION_ID,
                "snapshot_mode": "service_role_postgrest_rpc",
                "has_obs_aqidb": False,
                "default_obs_limit": default_obs_limit,
            },
            indent=2,
        )
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _serve_station_snapshot(self, parsed) -> None:
        query = parse_qs(parsed.query or "", keep_blank_values=False)

        station_id_raw = (query.get("station_id") or [STATION_SNAPSHOT_DEFAULT_STATION_ID])[0]
        station_ref_raw = (query.get("station_ref") or [""])[0]
        timeseries_id_raw = (query.get("timeseries_id") or [""])[0]
        window_raw = (query.get("window") or ["24h"])[0]
        obs_limit_raw = (query.get("obs_limit") or [STATION_SNAPSHOT_DEFAULT_OBS_LIMIT])[0]

        try:
            station_id = _parse_snapshot_station_id(station_id_raw)
            station_ref = _parse_snapshot_station_ref(station_ref_raw)
            timeseries_id = _parse_snapshot_timeseries_id(timeseries_id_raw)
            window = _parse_snapshot_window(window_raw)
            obs_limit = _parse_snapshot_obs_limit(obs_limit_raw)
        except (TypeError, ValueError) as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        if station_id is None and not station_ref:
            payload = json.dumps({"error": "station_id or station_ref is required."}, indent=2)
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        try:
            payload_obj = _build_station_snapshot_payload(
                self.server.base_url,
                self.server.service_role_key,
                station_id,
                station_ref,
                timeseries_id,
                window,
                obs_limit,
            )
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        if payload_obj.get("station") is None:
            payload_obj = {"error": "Station not found.", **payload_obj}
            status = HTTPStatus.NOT_FOUND
        else:
            status = HTTPStatus.OK

        payload = json.dumps(payload_obj, indent=2)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _serve_storage_coverage(self, parsed) -> None:
        query = parse_qs(parsed.query, keep_blank_values=False)
        force_refresh_raw = ((query.get("force") or [""])[0] or "").strip().lower()
        force_refresh = force_refresh_raw in {"1", "true", "yes", "y", "on"}
        if force_refresh:
            with CACHE_LOCK:
                STORAGE_COVERAGE_CACHE_STATE["rows"] = None
                STORAGE_COVERAGE_CACHE_STATE["next_refresh_at"] = None
        try:
            data = _build_storage_coverage_payload(
                self.server.base_url,
                self.server.service_role_key,
            )
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        payload = json.dumps(data, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _serve_r2_metrics(self, parsed) -> None:
        query = parse_qs(parsed.query, keep_blank_values=False)
        force_refresh_raw = ((query.get("force") or [""])[0] or "").strip().lower()
        force_refresh = force_refresh_raw in {"1", "true", "yes", "y", "on"}
        try:
            r2_usage, r2_usage_error = _get_r2_usage_cached(force_refresh=force_refresh)
            headers = _postgrest_headers(self.server.service_role_key)
            (
                _r2_history_days,
                r2_backup_window_from_history_days,
                r2_history_days_bucket,
                r2_history_days_error,
            ) = _get_r2_history_days_cached(force_refresh=False)
            r2_backup_window_rpc, r2_backup_window_rpc_error = _fetch_r2_backup_window(
                self.server.base_url,
                headers,
            )
            r2_backup_window = (
                r2_backup_window_from_history_days
                if r2_backup_window_from_history_days is not None
                else r2_backup_window_rpc
            )
            r2_backup_window_error = _join_error_messages(
                r2_history_days_error,
                r2_backup_window_rpc_error if r2_backup_window_from_history_days is None else None,
            )
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        if force_refresh:
            _invalidate_dashboard_cache(clear_storage_coverage=False)

        payload = json.dumps(
            {
                "r2_usage": r2_usage,
                "r2_usage_error": r2_usage_error,
                "r2_backup_window": r2_backup_window,
                "r2_backup_window_error": r2_backup_window_error,
                "r2_history_days_bucket": r2_history_days_bucket,
                "r2_history_days_error": r2_history_days_error,
                "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
            indent=2,
        )
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _serve_r2_connector_counts(self, parsed) -> None:
        query = parse_qs(parsed.query, keep_blank_values=False)
        from_day = ((query.get("from_day") or [""])[0] or "").strip()
        to_day = ((query.get("to_day") or [""])[0] or "").strip()
        grain = ((query.get("grain") or ["day"])[0] or "day").strip().lower()
        connector_ids = ((query.get("connector_ids") or [""])[0] or "").strip()

        payload_data, payload_error = _fetch_r2_history_counts_from_external_api(
            from_day=from_day,
            to_day=to_day,
            grain=grain,
            connector_ids=connector_ids or None,
        )
        if payload_error or payload_data is None:
            payload = json.dumps({"error": payload_error or "unknown error"}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        payload = json.dumps(payload_data, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _update_connectors(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw_body = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except json.JSONDecodeError:
            body = {}

        updates = body.get("updates") if isinstance(body, dict) else None
        if not isinstance(updates, list):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid payload")
            return

        headers = _postgrest_headers(self.server.service_role_key, write=True)
        base_url = self.server.base_url
        try:
            for entry in updates:
                if not isinstance(entry, dict):
                    continue
                connector_id = entry.get("id")
                if connector_id is None:
                    continue
                scheduler_backend = entry.get("scheduler_backend")
                if scheduler_backend is None or scheduler_backend == "":
                    scheduler_backend = SCHEDULER_BACKEND_SUPABASE_FUNCTION
                if scheduler_backend not in SCHEDULER_BACKEND_ALLOWED:
                    self.send_error(
                        HTTPStatus.BAD_REQUEST,
                        f"Invalid scheduler_backend for connector id {connector_id}",
                    )
                    return
                connector_code = str(entry.get("connector_code") or "").strip()
                if (
                    scheduler_backend == SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN
                    and connector_code not in SCHEDULER_BACKEND_CONNECTOR_ALLOWLIST
                ):
                    self.send_error(
                        HTTPStatus.BAD_REQUEST,
                        (
                            "google_cloud_run scheduler_backend is only allowed for "
                            f"{', '.join(sorted(SCHEDULER_BACKEND_CONNECTOR_ALLOWLIST))}"
                        ),
                    )
                    return
                payload = {
                    "poll_enabled": entry.get("poll_enabled"),
                    "poll_interval_minutes": entry.get("poll_interval_minutes"),
                    "poll_window_hours": entry.get("poll_window_hours"),
                    "poll_timeseries_batch_size": entry.get("poll_timeseries_batch_size"),
                    "scheduler_backend": scheduler_backend,
                }
                _patch_json(
                    base_url,
                    "connectors",
                    headers,
                    {"id": f"eq.{connector_id}"},
                    payload,
                )
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        _invalidate_dashboard_cache(clear_storage_coverage=False)

        payload = json.dumps({"status": "ok"}, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _update_dispatcher_settings(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw_body = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except json.JSONDecodeError:
            body = {}

        if not isinstance(body, dict):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid payload")
            return

        parallel = body.get("dispatcher_parallel_ingest")
        max_runs = body.get("max_runs_per_dispatch_call")
        if max_runs is not None:
            try:
                max_runs = int(max_runs)
            except (TypeError, ValueError):
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid max_runs_per_dispatch_call")
                return
            if max_runs < 1:
                self.send_error(HTTPStatus.BAD_REQUEST, "max_runs_per_dispatch_call must be >= 1")
                return

        headers = _postgrest_headers(self.server.service_role_key, write=True)
        base_url = self.server.base_url
        payload = {
            "dispatcher_parallel_ingest": bool(parallel),
            "max_runs_per_dispatch_call": max_runs or 1,
            "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        try:
            _patch_json(
                base_url,
                "dispatcher_settings",
                headers,
                {"id": "eq.1"},
                payload,
            )
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        _invalidate_dashboard_cache(clear_storage_coverage=False)

        payload = json.dumps({"status": "ok"}, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))


def parse_args() -> argparse.Namespace:
    host_default = os.getenv("HOST", "127.0.0.1")
    try:
        port_default = int(os.getenv("PORT", "8045"))
    except ValueError:
        port_default = 8045
    parser = argparse.ArgumentParser(description="Run a local UK AQ dashboard API.")
    parser.add_argument("--host", default=host_default, help="Bind host (default: HOST or 127.0.0.1).")
    parser.add_argument("--port", type=int, default=port_default, help="Bind port (default: PORT or 8045).")
    parser.add_argument(
        "--html",
        default="dashboard/index.html",
        help="Path to dashboard HTML file.",
    )
    parser.add_argument(
        "--supabase-url",
        default=os.getenv("SUPABASE_URL"),
        help="Supabase URL (default: SUPABASE_URL).",
    )
    parser.add_argument(
        "--service-role-key",
        default=os.getenv("SB_SECRET_KEY"),
        help="Supabase service role key (default: SB_SECRET_KEY).",
    )
    return parser.parse_args()


def main() -> None:
    _load_env(Path(".env"))
    args = parse_args()

    supabase_url = (args.supabase_url or "").strip().rstrip("/")
    service_role_key = (args.service_role_key or "").strip()
    if not supabase_url or not service_role_key:
        raise SystemExit("SUPABASE_URL and SB_SECRET_KEY are required.")
    role = _jwt_role(service_role_key)
    if role and role != "service_role":
        raise SystemExit(
            "SB_SECRET_KEY must be a service role key; "
            f"current token role is '{role}'."
        )

    html_path = Path(args.html)
    if not html_path.exists():
        raise SystemExit(f"HTML file not found: {html_path}")

    base_url = f"{supabase_url}/rest/v1"
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    server.base_url = base_url
    server.service_role_key = service_role_key
    server.html_path = html_path
    server.upstream_bearer_token = str(os.getenv("DASHBOARD_UPSTREAM_BEARER_TOKEN") or "").strip()

    print(f"UK AQ dashboard running at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
