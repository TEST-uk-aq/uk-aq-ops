"""Bounded persistent derived products, shared by local reads and the refresher."""
from __future__ import annotations
import copy
import json
import os
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs

PRODUCT_SECONDS = {"dashboard": 300, "metric_context": 300, "storage_coverage": 21600,
                   "r2_metrics": 3600, "daily_task_runs": 300}
METRIC_KEYS = ("db_size_metrics", "schema_size_metrics", "r2_domain_size_metrics",
               "db_size_metrics_error", "schema_size_metrics_error", "r2_domain_size_metrics_error",
               "r2_usage", "r2_usage_error", "service_egress_metrics", "service_egress_metrics_error",
               "r2_backup_window", "r2_backup_window_error", "r2_history_days_bucket", "r2_history_days_error",
               "r2_history_read_version", "r2_history_read_version_effective")
_WRITER = False


class CacheConfigurationError(RuntimeError):
    pass


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(value):
    return value.isoformat() + "Z" if isinstance(value, datetime) else value


def enabled():
    value = os.getenv("UK_AQ_DASHBOARD_MYSQL_ENABLED", "false").lower()
    if value not in {"true", "false"}:
        raise CacheConfigurationError("UK_AQ_DASHBOARD_MYSQL_ENABLED must be true or false")
    return value == "true"


def configuration(role):
    environment = os.getenv("UKAQ_ENV_NAME", "").lower()
    database = os.getenv("UK_AQ_DASHBOARD_MYSQL_DATABASE", "")
    expected = f"uk_aq_dashboard_{environment}"
    checkout = Path(__file__).resolve().parents[3].name
    if environment not in {"test", "live"} or database != expected:
        raise CacheConfigurationError("Explicit dashboard database must match TEST/LIVE environment")
    if checkout.startswith("TEST-") and environment != "test":
        raise CacheConfigurationError("TEST checkout cannot access LIVE dashboard cache")
    if checkout.startswith("LIVE-") and environment != "live":
        raise CacheConfigurationError("LIVE checkout cannot access TEST dashboard cache")
    user = os.getenv("UK_AQ_DASHBOARD_MYSQL_USER", "")
    if user != f"{expected}_{role}":
        raise CacheConfigurationError("Dashboard cache requires the environment-specific reader/writer user")
    password = os.getenv("UK_AQ_DASHBOARD_MYSQL_PASSWORD", "")
    if not password:
        raise CacheConfigurationError("Missing dashboard MySQL password")
    # Local socket only: no accidental remote database target or unencrypted TCP.
    socket = os.getenv("UK_AQ_DASHBOARD_MYSQL_SOCKET", "")
    if not socket or not Path(socket).is_absolute():
        raise CacheConfigurationError("An explicit absolute local MySQL socket path is required")
    return dict(database=database, user=user, password=password, unix_socket=socket)


def connect(role):
    config = configuration(role)
    import pymysql
    return pymysql.connect(**config, charset="utf8mb4", autocommit=False,
                           connect_timeout=2, read_timeout=3, write_timeout=3,
                           cursorclass=pymysql.cursors.DictCursor)


def request_dir():
    environment = os.getenv("UKAQ_ENV_NAME", "").lower()
    if environment not in {"test", "live"}:
        raise CacheConfigurationError("Cache refresh marker requires explicit environment")
    return Path.home() / "Library/Caches/uk-aq" / f"dashboard-{environment}"


def request_refresh(product="dashboard"):
    # This signal is best-effort and must never change the outcome of an
    # already applied authoritative connector/dispatcher mutation.
    try:
        if _WRITER or not enabled(): return
        if product not in PRODUCT_SECONDS: return
        directory = request_dir()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        (directory / f"refresh-{product}").touch(mode=0o600)
    except (OSError, CacheConfigurationError):
        pass


def read_product(product, version):
    with connect("reader") as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM dashboard_cache WHERE product=%s AND history_version=%s", (product, version))
            row = cursor.fetchone()
    if not row or row["payload"] is None:
        return None
    payload = json.loads(row["payload"])
    if not isinstance(payload, dict): raise RuntimeError("Invalid cached product payload")
    if version != "none" and payload.get("r2_history_read_version", {}).get("version") != version:
        raise RuntimeError("Cached product descriptor does not match row generation")
    stale = row["expires_at"] <= utcnow() or bool(row["last_error_code"])
    meta = {"source": "local_mysql", "state": "stale" if stale else "fresh", "history_version": version,
            "source_generated_at": iso(row["source_generated_at"]), "refreshed_at": iso(row["refreshed_at"]),
            "expires_at": iso(row["expires_at"]), "last_error_code": row["last_error_code"]}
    return payload, meta


def wait_for_newer_product(product, version, previous_refreshed_at, timeout_seconds=8.0):
    """Wait briefly for the independent writer to publish a requested refresh."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            row = read_product(product, version)
        except Exception:
            row = None
        if row and row[1].get("refreshed_at") != previous_refreshed_at:
            return row
        time.sleep(0.1)
    return None


def provenance(product):
    return {"builder": product, "authority": {
        "dashboard": "ingestdb_dashboard_adapters", "metric_context": "db_r2_metrics_and_cloudflare_and_egress_adapters",
        "storage_coverage": "ingestdb_obsaqidb_selected_history_dropbox_adapters",
        "r2_metrics": "cloudflare_account_and_selected_history_days", "daily_task_runs": "operational_postgresql",
    }[product]}


def assert_complete(product, payload):
    # Optional diagnostic warnings are preserved. Explicit adapter failures or
    # partial required products must not replace an earlier complete result.
    for key, value in payload.items():
        if value and (key == "error" or key.endswith("_error") or key in {"ingest_coverage_failed_days", "upstream_refresh_errors"}):
            raise RuntimeError("upstream_product_incomplete")
    if payload.get("ok") is False or payload.get("status") == "failed":
        raise RuntimeError("upstream_product_failed")
    if product == "dashboard" and not isinstance(payload.get("connectors_settings"), list):
        raise RuntimeError("upstream_product_shape")


def publish(product, version, payload, expires):
    assert_complete(product, payload)
    encoded = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode()) > 8 * 1024 * 1024:
        raise RuntimeError("dashboard_product_too_large")
    # Never persist credentials even if a future adapter accidentally includes them.
    def check(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if any(word in key.lower() for word in ("password", "secret", "authorization", "access_token", "refresh_token")):
                    raise RuntimeError("dashboard_product_secret_field")
                check(child)
        elif isinstance(value, list):
            for child in value: check(child)
    check(payload)
    for key, value in os.environ.items():
        if len(value) >= 8 and any(word in key.upper() for word in ("PASSWORD", "SECRET", "TOKEN", "SERVICE_ROLE")) and (value in encoded or json.dumps(value)[1:-1] in encoded):
            raise RuntimeError("dashboard_product_secret_value")
    now = utcnow()
    source = payload.get("generated_at")
    source = datetime.fromisoformat(source.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None) if source else None
    values = (encoded, json.dumps(provenance(product)), source, now, expires, now, now, product, version)
    with connect("writer") as connection:
        with connection.cursor() as cursor:
            cursor.execute("INSERT IGNORE INTO dashboard_cache (product, history_version, provenance, last_attempt_at) VALUES (%s,%s,%s,%s)", (product, version, "{}", now))
            cursor.execute("UPDATE dashboard_cache SET payload=%s, provenance=%s, source_generated_at=%s, refreshed_at=%s, expires_at=%s, last_attempt_at=%s, last_success_at=%s, last_error_code=NULL WHERE product=%s AND history_version=%s", values)
            cursor.execute("DELETE FROM dashboard_cache WHERE product=%s AND history_version<>%s", (product, version))
        connection.commit()


def record_failure(product, version):
    now = utcnow()
    with connect("writer") as connection:
        with connection.cursor() as cursor:
            cursor.execute("INSERT IGNORE INTO dashboard_cache (product, history_version, provenance, last_attempt_at) VALUES (%s,%s,%s,%s)", (product, version, "{}", now))
            cursor.execute("UPDATE dashboard_cache SET last_attempt_at=%s, last_error_code='refresh_failed' WHERE product=%s AND history_version=%s", (now, product, version))
        connection.commit()


def build_product(core, product, base_url, service_role_key):
    if product == "dashboard":
        return core._build_dashboard(base_url, service_role_key, include_storage_coverage=False, include_metric_context=False)
    if product == "metric_context":
        result = core._build_dashboard(base_url, service_role_key, include_storage_coverage=False, include_metric_context=True, include_ingest_context=False)
        payload = {key: result.get(key) for key in (*METRIC_KEYS, "generated_at")}
        if core._resolve_r2_history_read_version()["version"] == "v3":
            payload["r2_domain_size_metrics"] = []
            payload["r2_domain_size_metrics_error"] = None
            payload["r2_domain_size_metrics_warning"] = "Historical domain byte metrics have no generation identity; unavailable for v3."
        return payload
    if product == "storage_coverage":
        result = core._build_storage_coverage_payload(base_url, service_role_key, force_refresh=True)
        if core._resolve_r2_history_read_version()["version"] == "v3":
            result.get("upstream_refresh_errors", {}).pop("r2_domain_size_metrics_error", None)
        return result
    if product == "r2_metrics":
        usage, usage_error = core._get_r2_usage_cached()
        _, window, bucket, error = core._get_r2_history_days_cached(base_url=base_url, service_role_key=service_role_key)
        return {"r2_usage": usage, "r2_usage_error": usage_error, "r2_backup_window": window,
                "r2_backup_window_error": error, "r2_history_days_bucket": bucket, "r2_history_days_error": error,
                "r2_history_read_version": core._resolve_r2_history_read_version(), "generated_at": iso(utcnow())}
    if product == "daily_task_runs":
        today = datetime.now(timezone.utc).date()
        return {"day": today.isoformat(), "mode": "latest", "rows": core._fetch_daily_task_runs_dashboard_rows(scheduled_day=today, mode="latest"), "generated_at": iso(utcnow())}
    raise ValueError("Unknown cache product")


def serve_cached_request(handler, parsed):
    import uk_aq_dashboard_api_core as core
    if parsed.path not in {"/api/dashboard", "/api/storage_coverage", "/api/r2_metrics", "/api/daily_task_runs"}:
        return False
    query = parse_qs(parsed.query)
    flag = lambda name, default="1": (query.get(name) or [default])[0].lower() not in {"0", "false", "no", "off"}
    products = {
        "/api/dashboard": ["dashboard"], "/api/storage_coverage": ["storage_coverage"],
        "/api/r2_metrics": ["r2_metrics"], "/api/daily_task_runs": ["daily_task_runs"],
    }.get(parsed.path)
    if products is None: return False
    today = datetime.now(timezone.utc).date().isoformat()
    if parsed.path == "/api/daily_task_runs" and ((query.get("mode") or ["latest"])[0] != "latest" or (query.get("day") or [today])[0] != today):
        return False
    try:
        if not enabled(): return False
        configuration("reader")  # Misconfiguration never becomes a silent direct fallback.
    except CacheConfigurationError:
        handler._send_cache_json({"error": "Invalid local dashboard cache configuration"}, 503)
        return True
    if parsed.path == "/api/dashboard":
        if flag("include_metric_context") or flag("include_storage_coverage"): products.append("metric_context")
        if flag("include_storage_coverage"): products.append("storage_coverage")

    # The Daily Task Runs Refresh button currently sends t=<timestamp> as its
    # explicit cache-busting signal. Treat that as an on-demand refresh locally,
    # while also supporting the canonical force=1 form used by other routes.
    force_requested = flag("force", "0") or (parsed.path == "/api/daily_task_runs" and "t" in query)
    forced_daily_row = None
    if force_requested and parsed.path == "/api/daily_task_runs":
        try:
            before = read_product("daily_task_runs", "none")
        except Exception:
            before = None
        previous_refreshed_at = before[1].get("refreshed_at") if before else None
        request_refresh("daily_task_runs")
        forced_daily_row = wait_for_newer_product("daily_task_runs", "none", previous_refreshed_at)
    elif force_requested:
        for product in products: request_refresh(product)

    sensitive = products != ["daily_task_runs"]
    try:
        resolution = core._ensure_history_generation() if sensitive else None
        version = resolution["version"] if resolution else "none"
        payload = {}; metadata = {}
        for product in products:
            identity = "none" if product == "daily_task_runs" else version
            try:
                row = forced_daily_row if product == "daily_task_runs" and forced_daily_row else read_product(product, identity)
            except CacheConfigurationError:
                raise
            except Exception:
                row = None
            if row and product == "daily_task_runs" and row[0].get("day") != today:
                row = None
            if row is None:
                result = build_product(core, product, handler.server.base_url, handler.server.service_role_key)
                meta = {"source": "direct_upstream", "state": "cache_unavailable_or_missing", "history_version": identity}
                request_refresh(product)
            else:
                result, meta = row
            result = copy.deepcopy(result)
            # Keep main operational timestamp; each materialized product has its own timestamp in metadata.
            if payload: result.pop("generated_at", None)
            payload.update(result); metadata[product] = meta
        if resolution:
            if core._ensure_history_generation()["version"] != version:
                raise RuntimeError("generation_changed_during_read")
            payload["r2_history_read_version"] = resolution
            payload["r2_history_read_version_effective"] = resolution
            if resolution["version"] == "v3" and "r2_domain_size_metrics" in payload:
                payload["r2_domain_size_metrics"] = []
                payload["r2_domain_size_metrics_error"] = None
                payload["r2_domain_size_metrics_warning"] = "Historical domain byte metrics have no generation identity; unavailable for v3. Account usage remains account-wide."
        if parsed.path == "/api/dashboard" and not flag("include_ingest_context"):
            payload["pollutants"] = []; payload["connectors_settings"] = []
        payload["local_cache"] = metadata
        handler._send_cache_json(payload)
    except Exception:
        handler._send_cache_json({"error": "Dashboard cache or authoritative upstream unavailable"}, 503)
    return True
