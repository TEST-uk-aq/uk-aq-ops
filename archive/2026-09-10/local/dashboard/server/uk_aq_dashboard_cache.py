"""Bounded persistent derived products, shared by local reads and the refresher."""
from __future__ import annotations
import copy
import json
import os
import threading
import time
from pathlib import Path
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs

PRODUCT_SECONDS = {"dashboard": 300, "metric_context": 300, "storage_coverage": 21600,
                   "r2_metrics": 3600, "daily_task_runs": 300}
METRIC_KEYS = ("db_size_metrics", "schema_size_metrics", "r2_domain_size_metrics",
               "db_size_metrics_error", "schema_size_metrics_error", "r2_domain_size_metrics_error",
               "r2_usage", "r2_usage_error", "service_egress_metrics", "service_egress_metrics_error",
               "r2_backup_window", "r2_backup_window_error", "r2_history_days_bucket", "r2_history_days_error",
               "r2_history_read_version", "r2_history_read_version_effective")
_WRITER = False
_INGEST_OVERRIDE_LOCK = threading.Lock()


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
    try:
        if _WRITER or not enabled(): return
        if product not in PRODUCT_SECONDS: return
        directory = request_dir()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        (directory / f"refresh-{product}").touch(mode=0o600)
    except (OSError, CacheConfigurationError):
        pass


def request_daily_task_refresh(day_value: date):
    """Request a complete authoritative reconciliation for one retained task day."""
    try:
        if _WRITER or not enabled(): return
        directory = request_dir()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker = directory / "refresh-daily_task_runs"
        temporary = directory / f".refresh-daily_task_runs-{os.getpid()}-{time.time_ns()}"
        temporary.write_text(day_value.isoformat(), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, marker)
    except (OSError, CacheConfigurationError):
        pass


def requested_daily_task_refresh_day():
    try:
        text = (request_dir() / "refresh-daily_task_runs").read_text(encoding="utf-8").strip()
        return date.fromisoformat(text)
    except (OSError, ValueError):
        return None


def read_product(product, version, role="reader"):
    with connect(role) as connection:
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


def provenance(product):
    return {"builder": product, "authority": {
        "dashboard": "ingestdb_dashboard_adapters_plus_local_rolling_ingest_runs",
        "metric_context": "local_rolling_db_schema_egress_plus_cloudflare_history_metadata",
        "storage_coverage": "ingestdb_obsaqidb_selected_history_dropbox_adapters",
        "r2_metrics": "cloudflare_account_and_selected_history_days",
        "daily_task_runs": "local_rolling_copy_of_operational_postgresql",
    }[product]}


def assert_complete(product, payload):
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


def _build_dashboard_with_local_ingest(core, base_url, service_role_key):
    import uk_aq_dashboard_rolling_cache as rolling
    rows = rolling.read_ingest_runs(role="writer", lookback_minutes=core.DISPATCH_OBSERVS_WINDOW_MINUTES)
    original = core._get_ingest_runs_cached

    def local_runs(*_args, **_kwargs):
        return copy.deepcopy(rows)

    with _INGEST_OVERRIDE_LOCK:
        core._get_ingest_runs_cached = local_runs
        try:
            return core._build_dashboard(base_url, service_role_key, include_storage_coverage=False, include_metric_context=False)
        finally:
            core._get_ingest_runs_cached = original


def _build_local_metric_context(core):
    import uk_aq_dashboard_rolling_cache as rolling
    version = core._resolve_r2_history_read_version()["version"]
    r2_row = read_product("r2_metrics", version, role="writer")
    r2_payload = r2_row[0] if r2_row else {}
    r2_usage = rolling.read_latest_r2_usage(role="writer") or r2_payload.get("r2_usage")
    payload = {
        "db_size_metrics": rolling.read_db_size_metrics(role="writer", lookback_days=30),
        "schema_size_metrics": rolling.read_schema_size_metrics(role="writer", lookback_days=30),
        "r2_domain_size_metrics": [],
        "db_size_metrics_error": None,
        "schema_size_metrics_error": None,
        "r2_domain_size_metrics_error": None,
        "r2_usage": r2_usage,
        "r2_usage_error": r2_payload.get("r2_usage_error"),
        "service_egress_metrics": rolling.read_service_egress(role="writer", lookback_hours=24),
        "service_egress_metrics_error": None,
        "r2_backup_window": r2_payload.get("r2_backup_window"),
        "r2_backup_window_error": r2_payload.get("r2_backup_window_error"),
        "r2_history_days_bucket": r2_payload.get("r2_history_days_bucket"),
        "r2_history_days_error": r2_payload.get("r2_history_days_error"),
        "r2_history_read_version": core._resolve_r2_history_read_version(),
        "r2_usage_history": rolling.read_r2_usage_history(role="writer", lookback_days=30),
        "generated_at": iso(utcnow()),
    }
    if version == "v3":
        payload["r2_domain_size_metrics_warning"] = "Historical domain byte metrics have no generation identity; unavailable for v3."
    return payload


def build_product(core, product, base_url, service_role_key):
    if product == "dashboard":
        return _build_dashboard_with_local_ingest(core, base_url, service_role_key) if _WRITER else core._build_dashboard(base_url, service_role_key, include_storage_coverage=False, include_metric_context=False)
    if product == "metric_context":
        return _build_local_metric_context(core) if _WRITER else {
            key: core._build_dashboard(base_url, service_role_key, include_storage_coverage=False, include_metric_context=True, include_ingest_context=False).get(key)
            for key in (*METRIC_KEYS, "generated_at")
        }
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
        import uk_aq_dashboard_rolling_cache as rolling
        today = datetime.now(timezone.utc).date()
        rows = rolling.read_daily_task_runs(today, "latest", role="writer" if _WRITER else "reader")
        return {"day": today.isoformat(), "mode": "latest", "rows": rows or [], "generated_at": iso(utcnow())}
    raise ValueError("Unknown cache product")


def _serve_rolling_daily_tasks(handler, query):
    import uk_aq_dashboard_rolling_cache as rolling
    today = datetime.now(timezone.utc).date()
    day_text = (query.get("day") or [today.isoformat()])[0]
    mode = (query.get("mode") or ["latest"])[0]
    try:
        selected_day = date.fromisoformat(day_text)
    except ValueError:
        return False
    if mode not in {"latest", "all"}:
        return False
    try:
        rows = rolling.read_daily_task_runs(selected_day, mode, role="reader")
        state = rolling._state("daily_task_runs", role="reader")
    except Exception:
        return False
    if rows is None or not state or not state.get("last_success_at"):
        request_refresh("daily_task_runs")
        return False

    force_requested = ((query.get("force") or ["0"])[0].lower() not in {"0", "false", "no", "off"}) or "t" in query
    refresh_state = "cached"
    if force_requested:
        previous = rolling.daily_task_full_refresh_token(selected_day, role="reader")
        request_daily_task_refresh(selected_day)
        deadline = time.monotonic() + 12.0
        changed = False
        while time.monotonic() < deadline:
            current = rolling.daily_task_full_refresh_token(selected_day, role="reader")
            if current and current != previous:
                changed = True
                break
            time.sleep(0.1)
        rows = rolling.read_daily_task_runs(selected_day, mode, role="reader") or []
        state = rolling._state("daily_task_runs", role="reader") or state
        refresh_state = "refreshed" if changed else "refresh_timeout"

    generated = state.get("last_full_reconcile_at") if force_requested and state.get("last_full_reconcile_day") == selected_day else state.get("last_success_at")
    payload = {
        "day": selected_day.isoformat(),
        "mode": mode,
        "rows": rows,
        "generated_at": iso(generated) if isinstance(generated, datetime) else iso(utcnow()),
        "local_cache": {
            "daily_task_runs": {
                "source": "local_mysql",
                "state": refresh_state,
                "history_version": "none",
                "refreshed_at": iso(state.get("last_success_at")) if isinstance(state.get("last_success_at"), datetime) else None,
                "last_error_code": state.get("last_error_code"),
            }
        },
    }
    handler._send_cache_json(payload)
    return True


def serve_cached_request(handler, parsed):
    import uk_aq_dashboard_api_core as core
    if parsed.path not in {"/api/dashboard", "/api/storage_coverage", "/api/r2_metrics", "/api/daily_task_runs"}:
        return False
    query = parse_qs(parsed.query)
    flag = lambda name, default="1": (query.get(name) or [default])[0].lower() not in {"0", "false", "no", "off"}
    try:
        if not enabled(): return False
        configuration("reader")
    except CacheConfigurationError:
        handler._send_cache_json({"error": "Invalid local dashboard cache configuration"}, 503)
        return True

    if parsed.path == "/api/daily_task_runs":
        return _serve_rolling_daily_tasks(handler, query)

    products = {
        "/api/dashboard": ["dashboard"], "/api/storage_coverage": ["storage_coverage"],
        "/api/r2_metrics": ["r2_metrics"],
    }.get(parsed.path)
    if products is None: return False
    if parsed.path == "/api/dashboard":
        if flag("include_metric_context") or flag("include_storage_coverage"): products.append("metric_context")
        if flag("include_storage_coverage"): products.append("storage_coverage")
    if flag("force", "0"):
        for product in products: request_refresh(product)

    try:
        resolution = core._ensure_history_generation()
        version = resolution["version"]
        payload = {}; metadata = {}
        for product in products:
            try:
                row = read_product(product, version)
            except CacheConfigurationError:
                raise
            except Exception:
                row = None
            if row is None:
                result = build_product(core, product, handler.server.base_url, handler.server.service_role_key)
                meta = {"source": "direct_upstream", "state": "cache_unavailable_or_missing", "history_version": version}
                request_refresh(product)
            else:
                result, meta = row
            result = copy.deepcopy(result)
            if payload: result.pop("generated_at", None)
            payload.update(result); metadata[product] = meta
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
