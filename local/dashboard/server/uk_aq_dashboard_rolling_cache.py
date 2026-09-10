#!/usr/bin/env python3
"""Rolling local MySQL copies for small dashboard operational/history datasets."""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

RETENTION_DAYS = 30
DAILY_TASK_OVERLAP = timedelta(minutes=10)
EGRESS_OVERLAP = timedelta(minutes=15)
SIZE_OVERLAP = timedelta(hours=2)
INGEST_OVERLAP = timedelta(minutes=10)
SIZE_SYNC_SECONDS = 60 * 60

DAILY_TASK_SELECT = (
    "run_id,task_key,task_name,platform,source,scheduled_for_date,scheduled_time_utc,"
    "scheduled_at_utc,attempt,raw_status,started_at,finished_at,failed_at,updated_at,"
    "duration_seconds,summary,error_message,log_url,effective_status,scheduled_or_started_at,"
    "finished_or_failed_at,is_failed,is_overdue,is_not_started,task_day_rank"
)

INGEST_RUN_SELECT = (
    "id,connector_id,connector_code,run_started_at,run_ended_at,run_status,run_message,"
    "last_observed_at,stations_updated,observations_upserted,timeseries_updated,series_polled,"
    "response_status,response_payload,created_at"
)

EGRESS_SELECT = (
    "bucket_minute,env_name,project_ref,service_name,source_type,source_name,route_name,query_name,"
    "window_label,status,request_count,response_rows,response_bytes_est,upstream_bytes_est,"
    "duration_ms,error_count,notes"
)

DB_SIZE_SELECT = "bucket_hour,database_label,database_name,size_bytes,oldest_observed_at,recorded_at"
SCHEMA_SIZE_SELECT = "bucket_hour,database_label,schema_name,size_bytes,oldest_observed_at,recorded_at"


def _cache_module():
    import uk_aq_dashboard_cache as cache
    return cache


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _naive_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _parse_ts(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return _naive_utc(value)
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return _naive_utc(parsed)


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        value = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    return value


def _int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"true", "1", "yes", "y", "on"}:
        return True
    if text in {"false", "0", "no", "n", "off"}:
        return False
    return None


def _json(value: Any) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


def _decode_json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list, int, float, bool)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


def _retention_start(now: Optional[datetime] = None) -> datetime:
    current = now or _utcnow()
    return current - timedelta(days=RETENTION_DAYS)


def _task_cutoff_day(now: Optional[datetime] = None) -> date:
    current = (now or _utcnow()).date()
    return current - timedelta(days=RETENTION_DAYS - 1)


def _state(dataset: str, role: str = "writer") -> Optional[Dict[str, Any]]:
    cache = _cache_module()
    with cache.connect(role) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM dashboard_sync_state WHERE dataset=%s", (dataset,))
            return cursor.fetchone()


def _state_success(
    cursor,
    dataset: str,
    *,
    watermark_at: Optional[datetime],
    source_window_start: Optional[datetime],
    source_window_end: Optional[datetime],
    source_row_count: int,
    full_reconcile_day: Optional[date] = None,
) -> None:
    now = _naive_utc(_utcnow())
    cursor.execute(
        """
        INSERT INTO dashboard_sync_state
            (dataset,last_attempt_at,last_success_at,watermark_at,source_window_start,source_window_end,
             last_full_reconcile_day,last_full_reconcile_at,source_row_count,last_error_code)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL)
        ON DUPLICATE KEY UPDATE
            last_attempt_at=VALUES(last_attempt_at),
            last_success_at=VALUES(last_success_at),
            watermark_at=COALESCE(VALUES(watermark_at),watermark_at),
            source_window_start=VALUES(source_window_start),
            source_window_end=VALUES(source_window_end),
            last_full_reconcile_day=COALESCE(VALUES(last_full_reconcile_day),last_full_reconcile_day),
            last_full_reconcile_at=CASE WHEN VALUES(last_full_reconcile_day) IS NULL
                THEN last_full_reconcile_at ELSE VALUES(last_full_reconcile_at) END,
            source_row_count=VALUES(source_row_count),
            last_error_code=NULL
        """,
        (
            dataset,
            now,
            now,
            watermark_at,
            source_window_start,
            source_window_end,
            full_reconcile_day,
            now if full_reconcile_day else None,
            max(0, int(source_row_count)),
        ),
    )


def record_sync_failure(dataset: str, code: str = "refresh_failed") -> None:
    cache = _cache_module()
    now = _naive_utc(_utcnow())
    with cache.connect("writer") as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO dashboard_sync_state (dataset,last_attempt_at,last_error_code)
                VALUES (%s,%s,%s)
                ON DUPLICATE KEY UPDATE last_attempt_at=VALUES(last_attempt_at),last_error_code=VALUES(last_error_code)
                """,
                (dataset, now, code[:64]),
            )
        connection.commit()


def _source_base(core, url: str) -> str:
    return core._ensure_allowed_base_url(url.rstrip("/") + "/rest/v1")


def _fetch_daily_task_rows(core, *, from_day: Optional[date] = None, day: Optional[date] = None,
                           updated_since: Optional[datetime] = None) -> List[Dict[str, Any]]:
    if not core.OBS_AQIDB_SUPABASE_URL or not core.OBS_AQIDB_SECRET_KEY:
        raise RuntimeError("ObsAQIDB daily-task source is not configured")
    base = _source_base(core, core.OBS_AQIDB_SUPABASE_URL)
    headers = core._postgrest_headers(core.OBS_AQIDB_SECRET_KEY, schema=core.OPS_SCHEMA)
    params: Dict[str, str] = {"select": DAILY_TASK_SELECT, "order": "updated_at.asc.nullsfirst,run_id.asc"}
    if day is not None:
        params["scheduled_for_date"] = f"eq.{day.isoformat()}"
    elif from_day is not None:
        params["scheduled_for_date"] = f"gte.{from_day.isoformat()}"
    if updated_since is not None:
        params["updated_at"] = f"gte.{core._to_postgrest_ts(updated_since.replace(tzinfo=timezone.utc))}"
    return core._fetch_all(base, headers, "daily_task_runs_dashboard", params, limit=1000)


def _upsert_daily_task(cursor, row: Dict[str, Any]) -> bool:
    run_id = str(row.get("run_id") or "").strip()
    task_key = str(row.get("task_key") or "").strip()
    day_text = str(row.get("scheduled_for_date") or "").strip()
    if not run_id or not task_key or not day_text:
        return False
    try:
        scheduled_day = date.fromisoformat(day_text[:10])
    except ValueError:
        return False
    cursor.execute(
        """
        INSERT INTO daily_task_runs
            (run_id,task_key,task_name,platform,source,scheduled_for_date,scheduled_time_utc,
             scheduled_at_utc,attempt,raw_status,started_at,finished_at,failed_at,updated_at,
             duration_seconds,summary,error_message,log_url,effective_status,scheduled_or_started_at,
             finished_or_failed_at,is_failed,is_overdue,is_not_started,source_task_day_rank)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
            task_key=VALUES(task_key),task_name=VALUES(task_name),platform=VALUES(platform),source=VALUES(source),
            scheduled_for_date=VALUES(scheduled_for_date),scheduled_time_utc=VALUES(scheduled_time_utc),
            scheduled_at_utc=VALUES(scheduled_at_utc),attempt=VALUES(attempt),raw_status=VALUES(raw_status),
            started_at=VALUES(started_at),finished_at=VALUES(finished_at),failed_at=VALUES(failed_at),
            updated_at=VALUES(updated_at),duration_seconds=VALUES(duration_seconds),summary=VALUES(summary),
            error_message=VALUES(error_message),log_url=VALUES(log_url),effective_status=VALUES(effective_status),
            scheduled_or_started_at=VALUES(scheduled_or_started_at),finished_or_failed_at=VALUES(finished_or_failed_at),
            is_failed=VALUES(is_failed),is_overdue=VALUES(is_overdue),is_not_started=VALUES(is_not_started),
            source_task_day_rank=VALUES(source_task_day_rank)
        """,
        (
            run_id, task_key, row.get("task_name"), row.get("platform"), row.get("source"), scheduled_day,
            row.get("scheduled_time_utc"), _parse_ts(row.get("scheduled_at_utc")), _int(row.get("attempt")),
            row.get("raw_status"), _parse_ts(row.get("started_at")), _parse_ts(row.get("finished_at")),
            _parse_ts(row.get("failed_at")), _parse_ts(row.get("updated_at")), _int(row.get("duration_seconds")),
            row.get("summary"), row.get("error_message"), row.get("log_url"), row.get("effective_status"),
            _parse_ts(row.get("scheduled_or_started_at")), _parse_ts(row.get("finished_or_failed_at")),
            _bool(row.get("is_failed")), _bool(row.get("is_overdue")), _bool(row.get("is_not_started")),
            _int(row.get("task_day_rank")),
        ),
    )
    return True


def sync_daily_task_runs(core, *, force_day: Optional[date] = None) -> Dict[str, Any]:
    dataset = "daily_task_runs"
    now = _utcnow()
    cutoff_day = _task_cutoff_day(now)
    state = _state(dataset)
    if force_day is not None:
        rows = _fetch_daily_task_rows(core, day=force_day)
        source_start = datetime.combine(force_day, datetime.min.time(), tzinfo=timezone.utc)
        source_end = source_start + timedelta(days=1)
    else:
        watermark = _parse_ts((state or {}).get("watermark_at"))
        since = None
        if watermark is not None:
            since = max(_retention_start(now), watermark.replace(tzinfo=timezone.utc) - DAILY_TASK_OVERLAP)
        rows = _fetch_daily_task_rows(core, from_day=cutoff_day, updated_since=since)
        source_start = since or datetime.combine(cutoff_day, datetime.min.time(), tzinfo=timezone.utc)
        source_end = now

    cache = _cache_module()
    written = 0
    with cache.connect("writer") as connection:
        with connection.cursor() as cursor:
            if force_day is not None:
                cursor.execute("DELETE FROM daily_task_runs WHERE scheduled_for_date=%s", (force_day,))
            for row in rows:
                written += 1 if _upsert_daily_task(cursor, row) else 0
            cursor.execute("DELETE FROM daily_task_runs WHERE scheduled_for_date < %s", (cutoff_day,))
            cursor.execute("SELECT MAX(updated_at) AS watermark FROM daily_task_runs")
            watermark_row = cursor.fetchone() or {}
            _state_success(
                cursor,
                dataset,
                watermark_at=_parse_ts(watermark_row.get("watermark")),
                source_window_start=_naive_utc(source_start),
                source_window_end=_naive_utc(source_end),
                source_row_count=len(rows),
                full_reconcile_day=force_day,
            )
        connection.commit()
    return {"source_rows": len(rows), "written_rows": written, "force_day": force_day.isoformat() if force_day else None}


def daily_task_full_refresh_token(day: date, role: str = "reader") -> Optional[str]:
    state = _state("daily_task_runs", role=role)
    if not state or state.get("last_full_reconcile_day") != day:
        return None
    return _iso(state.get("last_full_reconcile_at"))


def _task_row_payload(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "run_id": row.get("run_id"),
        "task_key": row.get("task_key"),
        "task_name": row.get("task_name"),
        "platform": row.get("platform"),
        "source": row.get("source"),
        "scheduled_for_date": _iso(row.get("scheduled_for_date")),
        "scheduled_time_utc": row.get("scheduled_time_utc"),
        "scheduled_at_utc": _iso(row.get("scheduled_at_utc")),
        "attempt": row.get("attempt"),
        "raw_status": row.get("raw_status"),
        "started_at": _iso(row.get("started_at")),
        "finished_at": _iso(row.get("finished_at")),
        "failed_at": _iso(row.get("failed_at")),
        "updated_at": _iso(row.get("updated_at")),
        "duration_seconds": row.get("duration_seconds"),
        "summary": row.get("summary"),
        "error_message": row.get("error_message"),
        "log_url": row.get("log_url"),
        "effective_status": row.get("effective_status"),
        "scheduled_or_started_at": _iso(row.get("scheduled_or_started_at")),
        "finished_or_failed_at": _iso(row.get("finished_or_failed_at")),
        "is_failed": None if row.get("is_failed") is None else bool(row.get("is_failed")),
        "is_overdue": None if row.get("is_overdue") is None else bool(row.get("is_overdue")),
        "is_not_started": None if row.get("is_not_started") is None else bool(row.get("is_not_started")),
        "task_day_rank": row.get("source_task_day_rank"),
    }


def _task_latest_sort(row: Dict[str, Any]) -> Tuple[datetime, int, datetime, str]:
    primary = _parse_ts(row.get("scheduled_or_started_at")) or _parse_ts(row.get("scheduled_at_utc")) or _parse_ts(row.get("started_at"))
    updated = _parse_ts(row.get("updated_at"))
    minimum = datetime.min
    return (primary or minimum, _int(row.get("attempt")) or 0, updated or minimum, str(row.get("run_id") or ""))


def read_daily_task_runs(day: date, mode: str, role: str = "reader") -> Optional[List[Dict[str, Any]]]:
    if mode not in {"latest", "all"}:
        raise ValueError("mode must be latest or all")
    if day < _task_cutoff_day() or day > _utcnow().date():
        return None
    cache = _cache_module()
    with cache.connect(role) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM daily_task_runs WHERE scheduled_for_date=%s", (day,))
            rows = cursor.fetchall() or []
    if mode == "all":
        selected = list(rows)
    else:
        latest: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            key = str(row.get("task_key") or "")
            if not key:
                continue
            prior = latest.get(key)
            if prior is None or _task_latest_sort(row) > _task_latest_sort(prior):
                latest[key] = row
        selected = list(latest.values())
    selected.sort(key=_task_latest_sort, reverse=True)
    return [_task_row_payload(row) for row in selected]


def _egress_dimension_hash(row: Dict[str, Any]) -> bytes:
    parts = [
        str(row.get(name) or "")
        for name in ("env_name", "project_ref", "service_name", "source_type", "source_name",
                     "route_name", "query_name", "window_label", "status")
    ]
    return hashlib.sha256("\0".join(parts).encode("utf-8")).digest()


def sync_service_egress(core) -> Dict[str, Any]:
    dataset = "service_egress_metrics_minute"
    if not core.OBS_AQIDB_SUPABASE_URL or not core.OBS_AQIDB_SECRET_KEY:
        raise RuntimeError("ObsAQIDB egress source is not configured")
    now = _utcnow()
    state = _state(dataset)
    watermark = _parse_ts((state or {}).get("watermark_at"))
    since = _retention_start(now)
    if watermark is not None:
        since = max(since, watermark.replace(tzinfo=timezone.utc) - EGRESS_OVERLAP)
    base = _source_base(core, core.OBS_AQIDB_SUPABASE_URL)
    headers = core._postgrest_headers(core.OBS_AQIDB_SECRET_KEY, schema=core.PUBLIC_SCHEMA)
    params = {
        "select": EGRESS_SELECT,
        "bucket_minute": f"gte.{core._to_postgrest_ts(since)}",
        "env_name": f"eq.{str(core.os.getenv('UKAQ_ENV_NAME') or 'TEST').strip() or 'TEST'}",
        "order": "bucket_minute.asc",
    }
    rows = core._fetch_all(base, headers, core.SERVICE_EGRESS_MINUTE_VIEW, params, limit=1000)
    cache = _cache_module()
    cutoff = _naive_utc(_retention_start(now))
    max_bucket = watermark
    with cache.connect("writer") as connection:
        with connection.cursor() as cursor:
            for row in rows:
                bucket = _parse_ts(row.get("bucket_minute"))
                if bucket is None:
                    continue
                max_bucket = bucket if max_bucket is None or bucket > max_bucket else max_bucket
                cursor.execute(
                    """
                    INSERT INTO service_egress_metrics_minute
                        (bucket_minute,dimension_hash,env_name,project_ref,service_name,source_type,source_name,
                         route_name,query_name,window_label,status,request_count,response_rows,response_bytes_est,
                         upstream_bytes_est,duration_ms,error_count,notes)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE
                        env_name=VALUES(env_name),project_ref=VALUES(project_ref),service_name=VALUES(service_name),
                        source_type=VALUES(source_type),source_name=VALUES(source_name),route_name=VALUES(route_name),
                        query_name=VALUES(query_name),window_label=VALUES(window_label),status=VALUES(status),
                        request_count=VALUES(request_count),response_rows=VALUES(response_rows),
                        response_bytes_est=VALUES(response_bytes_est),upstream_bytes_est=VALUES(upstream_bytes_est),
                        duration_ms=VALUES(duration_ms),error_count=VALUES(error_count),notes=VALUES(notes)
                    """,
                    (
                        bucket, _egress_dimension_hash(row), str(row.get("env_name") or "unknown"),
                        str(row.get("project_ref") or ""), str(row.get("service_name") or "unknown"),
                        str(row.get("source_type") or "other"), str(row.get("source_name") or ""),
                        str(row.get("route_name") or ""), str(row.get("query_name") or ""),
                        str(row.get("window_label") or ""), str(row.get("status") or "ok"),
                        max(0, _int(row.get("request_count")) or 0), max(0, _int(row.get("response_rows")) or 0),
                        max(0, _int(row.get("response_bytes_est")) or 0), max(0, _int(row.get("upstream_bytes_est")) or 0),
                        max(0, _int(row.get("duration_ms")) or 0), max(0, _int(row.get("error_count")) or 0),
                        _json(row.get("notes")) if isinstance(row.get("notes"), dict) else None,
                    ),
                )
            cursor.execute("DELETE FROM service_egress_metrics_minute WHERE bucket_minute < %s", (cutoff,))
            _state_success(cursor, dataset, watermark_at=max_bucket, source_window_start=_naive_utc(since),
                           source_window_end=_naive_utc(now), source_row_count=len(rows))
        connection.commit()
    return {"source_rows": len(rows)}


def _size_sync_due(dataset: str) -> bool:
    state = _state(dataset)
    last = _parse_ts((state or {}).get("last_success_at"))
    return last is None or (_naive_utc(_utcnow()) - last).total_seconds() >= SIZE_SYNC_SECONDS


def _fetch_size_rows(core, *, base: str, key: str, view: str, select: str, since: datetime) -> List[Dict[str, Any]]:
    headers = core._postgrest_headers(key, schema=core.PUBLIC_SCHEMA)
    return core._fetch_all(base, headers, view, {
        "select": select,
        "bucket_hour": f"gte.{core._to_postgrest_ts(since)}",
        "order": "bucket_hour.asc",
    }, limit=1000)


def sync_size_metrics(core, *, ingest_base: str, ingest_key: str) -> Dict[str, Any]:
    now = _utcnow()
    cutoff = _naive_utc(_retention_start(now))
    results: Dict[str, Any] = {}

    if _size_sync_due("db_size_metrics_hourly"):
        state = _state("db_size_metrics_hourly")
        watermark = _parse_ts((state or {}).get("watermark_at"))
        since = _retention_start(now) if watermark is None else max(_retention_start(now), watermark.replace(tzinfo=timezone.utc) - SIZE_OVERLAP)
        rows: List[Dict[str, Any]] = []
        rows.extend(_fetch_size_rows(core, base=ingest_base, key=ingest_key,
                                     view="uk_aq_db_size_metrics_hourly", select=DB_SIZE_SELECT, since=since))
        if core.OBS_AQIDB_SUPABASE_URL and core.OBS_AQIDB_SECRET_KEY:
            obs_base = _source_base(core, core.OBS_AQIDB_SUPABASE_URL)
            rows.extend(_fetch_size_rows(core, base=obs_base, key=core.OBS_AQIDB_SECRET_KEY,
                                         view="uk_aq_db_size_metrics_hourly", select=DB_SIZE_SELECT, since=since))
        max_bucket = watermark
        cache = _cache_module()
        with cache.connect("writer") as connection:
            with connection.cursor() as cursor:
                for row in rows:
                    bucket = _parse_ts(row.get("bucket_hour"))
                    label = str(row.get("database_label") or "").strip().lower()
                    name = str(row.get("database_name") or "").strip()
                    size = _int(row.get("size_bytes"))
                    if bucket is None or not label or size is None or size < 0:
                        continue
                    max_bucket = bucket if max_bucket is None or bucket > max_bucket else max_bucket
                    cursor.execute(
                        """INSERT INTO db_size_metrics_hourly
                           (bucket_hour,database_label,database_name,size_bytes,oldest_observed_at,recorded_at)
                           VALUES (%s,%s,%s,%s,%s,%s)
                           ON DUPLICATE KEY UPDATE size_bytes=VALUES(size_bytes),oldest_observed_at=VALUES(oldest_observed_at),recorded_at=VALUES(recorded_at)""",
                        (bucket, label, name, size, _parse_ts(row.get("oldest_observed_at")), _parse_ts(row.get("recorded_at"))),
                    )
                cursor.execute("DELETE FROM db_size_metrics_hourly WHERE bucket_hour < %s", (cutoff,))
                _state_success(cursor, "db_size_metrics_hourly", watermark_at=max_bucket,
                               source_window_start=_naive_utc(since), source_window_end=_naive_utc(now),
                               source_row_count=len(rows))
            connection.commit()
        results["db_size_metrics_hourly"] = len(rows)

    if _size_sync_due("schema_size_metrics_hourly"):
        if not core.OBS_AQIDB_SUPABASE_URL or not core.OBS_AQIDB_SECRET_KEY:
            raise RuntimeError("ObsAQIDB schema-size source is not configured")
        state = _state("schema_size_metrics_hourly")
        watermark = _parse_ts((state or {}).get("watermark_at"))
        since = _retention_start(now) if watermark is None else max(_retention_start(now), watermark.replace(tzinfo=timezone.utc) - SIZE_OVERLAP)
        obs_base = _source_base(core, core.OBS_AQIDB_SUPABASE_URL)
        rows = _fetch_size_rows(core, base=obs_base, key=core.OBS_AQIDB_SECRET_KEY,
                                view="uk_aq_schema_size_metrics_hourly", select=SCHEMA_SIZE_SELECT, since=since)
        max_bucket = watermark
        cache = _cache_module()
        with cache.connect("writer") as connection:
            with connection.cursor() as cursor:
                for row in rows:
                    bucket = _parse_ts(row.get("bucket_hour"))
                    label = str(row.get("database_label") or "").strip().lower()
                    schema = str(row.get("schema_name") or "").strip().lower()
                    size = _int(row.get("size_bytes"))
                    if bucket is None or not label or not schema or size is None or size < 0:
                        continue
                    max_bucket = bucket if max_bucket is None or bucket > max_bucket else max_bucket
                    cursor.execute(
                        """INSERT INTO schema_size_metrics_hourly
                           (bucket_hour,database_label,schema_name,size_bytes,oldest_observed_at,recorded_at)
                           VALUES (%s,%s,%s,%s,%s,%s)
                           ON DUPLICATE KEY UPDATE size_bytes=VALUES(size_bytes),oldest_observed_at=VALUES(oldest_observed_at),recorded_at=VALUES(recorded_at)""",
                        (bucket, label, schema, size, _parse_ts(row.get("oldest_observed_at")), _parse_ts(row.get("recorded_at"))),
                    )
                cursor.execute("DELETE FROM schema_size_metrics_hourly WHERE bucket_hour < %s", (cutoff,))
                _state_success(cursor, "schema_size_metrics_hourly", watermark_at=max_bucket,
                               source_window_start=_naive_utc(since), source_window_end=_naive_utc(now),
                               source_row_count=len(rows))
            connection.commit()
        results["schema_size_metrics_hourly"] = len(rows)
    return results


def _metric_rows(table: str, since: datetime, role: str) -> List[Dict[str, Any]]:
    cache = _cache_module()
    with cache.connect(role) as connection:
        with connection.cursor() as cursor:
            cursor.execute(f"SELECT * FROM {table} WHERE bucket_hour >= %s ORDER BY bucket_hour ASC", (_naive_utc(since),))
            return cursor.fetchall() or []


def read_db_size_metrics(role: str = "writer", lookback_days: int = 30) -> List[Dict[str, Any]]:
    rows = _metric_rows("db_size_metrics_hourly", _utcnow() - timedelta(days=lookback_days), role)
    return [{
        "bucket_hour": _iso(row.get("bucket_hour")), "database_label": row.get("database_label"),
        "database_name": row.get("database_name"), "size_bytes": row.get("size_bytes"),
        "oldest_observed_at": _iso(row.get("oldest_observed_at")), "recorded_at": _iso(row.get("recorded_at")),
    } for row in rows]


def read_schema_size_metrics(role: str = "writer", lookback_days: int = 30) -> List[Dict[str, Any]]:
    rows = _metric_rows("schema_size_metrics_hourly", _utcnow() - timedelta(days=lookback_days), role)
    return [{
        "bucket_hour": _iso(row.get("bucket_hour")), "database_label": row.get("database_label"),
        "schema_name": row.get("schema_name"), "size_bytes": row.get("size_bytes"),
        "oldest_observed_at": _iso(row.get("oldest_observed_at")), "recorded_at": _iso(row.get("recorded_at")),
    } for row in rows]


def read_service_egress(role: str = "writer", lookback_hours: int = 24) -> List[Dict[str, Any]]:
    cache = _cache_module()
    since = _naive_utc(_utcnow() - timedelta(hours=lookback_hours))
    with cache.connect(role) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM service_egress_metrics_minute WHERE bucket_minute >= %s ORDER BY bucket_minute ASC", (since,))
            rows = cursor.fetchall() or []
    result = []
    for row in rows:
        result.append({
            "bucket_minute": _iso(row.get("bucket_minute")), "env_name": row.get("env_name"),
            "project_ref": row.get("project_ref"), "service_name": row.get("service_name"),
            "source_type": row.get("source_type"), "source_name": row.get("source_name"),
            "route_name": row.get("route_name"), "query_name": row.get("query_name"),
            "window_label": row.get("window_label"), "status": row.get("status"),
            "request_count": row.get("request_count") or 0, "response_rows": row.get("response_rows") or 0,
            "response_bytes_est": row.get("response_bytes_est") or 0,
            "upstream_bytes_est": row.get("upstream_bytes_est") or 0, "duration_ms": row.get("duration_ms") or 0,
            "error_count": row.get("error_count") or 0, "notes": _decode_json(row.get("notes")),
        })
    return result


def store_r2_usage(usage: Optional[Dict[str, Any]]) -> None:
    if not isinstance(usage, dict):
        return
    now = _utcnow()
    bucket = now.replace(minute=0, second=0, microsecond=0)
    source_generated = _parse_ts(usage.get("as_of_utc"))
    cache = _cache_module()
    with cache.connect("writer") as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """INSERT INTO r2_usage_hourly
                   (bucket_hour,standard_used_bytes,standard_objects,class_a_used_requests,class_b_used_requests,source_generated_at,payload)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON DUPLICATE KEY UPDATE standard_used_bytes=VALUES(standard_used_bytes),standard_objects=VALUES(standard_objects),
                   class_a_used_requests=VALUES(class_a_used_requests),class_b_used_requests=VALUES(class_b_used_requests),
                   source_generated_at=VALUES(source_generated_at),payload=VALUES(payload)""",
                (_naive_utc(bucket), _int(usage.get("standard_used_bytes")), _int(usage.get("standard_objects")),
                 _int(usage.get("class_a_used_requests")), _int(usage.get("class_b_used_requests")),
                 source_generated, _json(usage)),
            )
            cursor.execute("DELETE FROM r2_usage_hourly WHERE bucket_hour < %s", (_naive_utc(_retention_start(now)),))
            _state_success(cursor, "r2_usage_hourly", watermark_at=_naive_utc(bucket),
                           source_window_start=_naive_utc(bucket), source_window_end=_naive_utc(now), source_row_count=1)
        connection.commit()


def read_latest_r2_usage(role: str = "writer") -> Optional[Dict[str, Any]]:
    cache = _cache_module()
    with cache.connect(role) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT payload FROM r2_usage_hourly ORDER BY bucket_hour DESC LIMIT 1")
            row = cursor.fetchone()
    return _decode_json((row or {}).get("payload")) if row else None


def read_r2_usage_history(role: str = "reader", lookback_days: int = 30) -> List[Dict[str, Any]]:
    cache = _cache_module()
    since = _naive_utc(_utcnow() - timedelta(days=lookback_days))
    with cache.connect(role) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM r2_usage_hourly WHERE bucket_hour >= %s ORDER BY bucket_hour ASC", (since,))
            rows = cursor.fetchall() or []
    return [{
        "bucket_hour": _iso(row.get("bucket_hour")), "standard_used_bytes": row.get("standard_used_bytes"),
        "standard_objects": row.get("standard_objects"), "class_a_used_requests": row.get("class_a_used_requests"),
        "class_b_used_requests": row.get("class_b_used_requests"), "source_generated_at": _iso(row.get("source_generated_at")),
    } for row in rows]


def sync_ingest_runs(core, *, base_url: str, service_role_key: str) -> Dict[str, Any]:
    dataset = "ingest_runs"
    now = _utcnow()
    state = _state(dataset)
    watermark = _parse_ts((state or {}).get("watermark_at"))
    since = _retention_start(now) if watermark is None else max(_retention_start(now), watermark.replace(tzinfo=timezone.utc) - INGEST_OVERLAP)
    headers = core._postgrest_headers(service_role_key)
    rows = core._fetch_all(base_url, headers, "uk_aq_ingest_runs", {
        "select": INGEST_RUN_SELECT,
        "created_at": f"gte.{core._to_postgrest_ts(since)}",
        "order": "created_at.asc",
    }, limit=1000)
    max_created = watermark
    cache = _cache_module()
    with cache.connect("writer") as connection:
        with connection.cursor() as cursor:
            for row in rows:
                run_id = str(row.get("id") or "").strip()
                created = _parse_ts(row.get("created_at"))
                if not run_id or created is None:
                    continue
                max_created = created if max_created is None or created > max_created else max_created
                cursor.execute(
                    """INSERT INTO ingest_runs
                       (run_id,connector_id,connector_code,run_started_at,run_ended_at,run_status,run_message,
                        last_observed_at,stations_updated,observations_upserted,timeseries_updated,series_polled,
                        response_status,response_payload,created_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       ON DUPLICATE KEY UPDATE connector_id=VALUES(connector_id),connector_code=VALUES(connector_code),
                        run_started_at=VALUES(run_started_at),run_ended_at=VALUES(run_ended_at),run_status=VALUES(run_status),
                        run_message=VALUES(run_message),last_observed_at=VALUES(last_observed_at),stations_updated=VALUES(stations_updated),
                        observations_upserted=VALUES(observations_upserted),timeseries_updated=VALUES(timeseries_updated),
                        series_polled=VALUES(series_polled),response_status=VALUES(response_status),response_payload=VALUES(response_payload),
                        created_at=VALUES(created_at)""",
                    (run_id, _int(row.get("connector_id")), row.get("connector_code"), _parse_ts(row.get("run_started_at")),
                     _parse_ts(row.get("run_ended_at")), row.get("run_status"), row.get("run_message"),
                     _parse_ts(row.get("last_observed_at")), _int(row.get("stations_updated")),
                     _int(row.get("observations_upserted")), _int(row.get("timeseries_updated")), _int(row.get("series_polled")),
                     _int(row.get("response_status")), _json(row.get("response_payload")), created),
                )
            cursor.execute("DELETE FROM ingest_runs WHERE created_at < %s", (_naive_utc(_retention_start(now)),))
            _state_success(cursor, dataset, watermark_at=max_created, source_window_start=_naive_utc(since),
                           source_window_end=_naive_utc(now), source_row_count=len(rows))
        connection.commit()
    return {"source_rows": len(rows)}


def read_ingest_runs(role: str = "writer", lookback_minutes: int = 240) -> List[Dict[str, Any]]:
    cache = _cache_module()
    since = _naive_utc(_utcnow() - timedelta(minutes=lookback_minutes))
    with cache.connect(role) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM ingest_runs WHERE created_at >= %s ORDER BY created_at DESC", (since,))
            rows = cursor.fetchall() or []
    result = []
    for row in rows:
        result.append({
            "id": row.get("run_id"), "connector_id": row.get("connector_id"), "connector_code": row.get("connector_code"),
            "run_started_at": _iso(row.get("run_started_at")), "run_ended_at": _iso(row.get("run_ended_at")),
            "run_status": row.get("run_status"), "run_message": row.get("run_message"),
            "last_observed_at": _iso(row.get("last_observed_at")), "stations_updated": row.get("stations_updated"),
            "observations_upserted": row.get("observations_upserted"), "timeseries_updated": row.get("timeseries_updated"),
            "series_polled": row.get("series_polled"), "response_status": row.get("response_status"),
            "response_payload": _decode_json(row.get("response_payload")), "created_at": _iso(row.get("created_at")),
        })
    return result
