#!/usr/bin/env python3
# trigger deploy 2026-03-11
"""Run a local Station Snapshot dashboard with ingestdb + ObsAQIDB data."""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import parse_qs, urlencode, urlparse

WINDOW_TO_DELTA = {
    "6h": timedelta(hours=6),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "21d": timedelta(days=21),
    "31d": timedelta(days=31),
    "90d": timedelta(days=90),
}
DEFAULT_WINDOW = "24h"
DEFAULT_PAGE_SIZE = 1000
DEFAULT_MAX_ROWS = 200000


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


def _upsert_env_file(path: Path, updates: Dict[str, str]) -> None:
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()
    else:
        lines = []
    found = set()
    new_lines: List[str] = []
    for line in lines:
        replaced = False
        for key, value in updates.items():
            if line.startswith(f"{key}="):
                new_lines.append(f"{key}={value}")
                found.add(key)
                replaced = True
                break
        if not replaced:
            new_lines.append(line)
    for key, value in updates.items():
        if key not in found:
            new_lines.append(f"{key}={value}")
    path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


def _default_edge_url() -> str:
    explicit = (
        os.getenv("UK_AQ_STATION_SNAPSHOT_EDGE_URL")
        or os.getenv("STATION_SNAPSHOT_EDGE_URL")
        or ""
    ).strip()
    if explicit:
        return explicit

    supabase_url = (
        os.getenv("SUPABASE_URL")
        or os.getenv("SB_SUPABASE_URL")
        or ""
    ).strip().rstrip("/")
    if not supabase_url:
        return ""
    return f"{supabase_url}/functions/v1/uk_aq_station_snapshot"


def _env_publishable_key() -> str:
    return (os.getenv("SB_PUBLISHABLE_DEFAULT_KEY") or "").strip()


def _env_service_key() -> str:
    return (
        os.getenv("SB_SECRET_KEY")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    ).strip()


def _env_obs_service_key() -> str:
    return (
        os.getenv("OBS_AQIDB_SECRET_KEY")
        or os.getenv("SBASE_HISTORY_SB_SECRET")
        or ""
    ).strip()


def _env_obs_db_url() -> str:
    return (
        os.getenv("OBS_AQIDB_SUPABASE_DB_URL")
        or os.getenv("SBASE_HISTORY_DB_URL")
        or ""
    ).strip()


def _to_rest_url(base_url: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return ""
    if base.endswith("/rest/v1"):
        return base
    return f"{base}/rest/v1"


def _jwt_expiry_epoch(token: str) -> Optional[int]:
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload.encode("ascii")).decode("utf-8")
        data = json.loads(decoded)
    except Exception:
        return None
    exp = data.get("exp")
    if isinstance(exp, (int, float)):
        return int(exp)
    return None


def _token_is_fresh(token: str, skew_seconds: int = 60) -> bool:
    if not token:
        return False
    exp = _jwt_expiry_epoch(token)
    if exp is None:
        return True
    return exp > int(time.time()) + max(0, skew_seconds)


def _refresh_access_token(auth_state: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    supabase_url = (auth_state.get("supabase_url") or "").strip().rstrip("/")
    publishable_key = (auth_state.get("publishable_key") or "").strip()
    refresh_token = (auth_state.get("refresh_token") or "").strip()
    if not (supabase_url and publishable_key and refresh_token):
        return None, "Refresh token flow is not configured."

    request_body = json.dumps({"refresh_token": refresh_token}).encode("utf-8")
    request = urllib_request.Request(
        f"{supabase_url}/auth/v1/token?grant_type=refresh_token",
        data=request_body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "apikey": publishable_key,
        },
    )
    try:
        with urllib_request.urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as exc:
        message = exc.reason
        try:
            body = exc.read().decode("utf-8")
            parsed = json.loads(body)
            message = parsed.get("msg") or parsed.get("message") or message
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            message = str(message)
        return None, f"Token refresh failed ({exc.code}): {message}"
    except Exception as exc:
        return None, f"Token refresh failed: {exc}"

    access_token = str(payload.get("access_token") or "").strip()
    next_refresh_token = str(payload.get("refresh_token") or "").strip()
    if not access_token:
        return None, "Token refresh returned no access_token."
    auth_state["access_token"] = access_token
    if next_refresh_token:
        auth_state["refresh_token"] = next_refresh_token
        env_path = (auth_state.get("env_path") or "").strip()
        if env_path:
            try:
                _upsert_env_file(
                    Path(env_path),
                    {
                        "UK_AQ_DEV_REFRESH_TOKEN": next_refresh_token,
                        "UK_AQ_DEV_JWT": access_token,
                    },
                )
            except OSError as exc:
                auth_state["env_write_error"] = str(exc)
    return access_token, None


def _ensure_access_token(
    auth_state: Dict[str, str], auth_lock: threading.Lock, force_refresh: bool = False
) -> Tuple[Optional[str], Optional[str]]:
    with auth_lock:
        token = (auth_state.get("access_token") or "").strip()
        if token and not force_refresh and _token_is_fresh(token):
            return token, None

        refreshed_token, refresh_error = _refresh_access_token(auth_state)
        if refreshed_token:
            return refreshed_token, None

        if token and _token_is_fresh(token, skew_seconds=0):
            return token, None
        return None, refresh_error or "No valid access token available."


def _parse_station_id(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    parsed = int(raw)
    if parsed < 0:
        raise ValueError("station_id must be a non-negative integer")
    return parsed


def _parse_timeseries_id(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    parsed = int(raw)
    if parsed < -2147483648 or parsed > 2147483647:
        raise ValueError("timeseries_id is out of int4 range")
    return parsed


def _parse_window(value: Optional[str]) -> str:
    normalized = (value or "").strip().lower()
    if not normalized:
        return DEFAULT_WINDOW
    if normalized not in WINDOW_TO_DELTA:
        raise ValueError("window must be one of: 6h, 24h, 7d, 21d, 31d, 90d")
    return normalized


def _parse_obs_limit(value: Optional[str]) -> Optional[int]:
    normalized = (value or "").strip().lower()
    if not normalized or normalized == "all":
        return None
    parsed = int(normalized)
    if parsed <= 0:
        raise ValueError("obs_limit must be a positive integer or 'all'")
    return parsed


def _isoz(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _window_bounds(window: str) -> Tuple[datetime, datetime]:
    now_utc = datetime.now(timezone.utc)
    return now_utc - WINDOW_TO_DELTA[window], now_utc


def _http_get_json(url: str, headers: Dict[str, str], timeout_seconds: int = 30) -> Tuple[int, Any]:
    request = urllib_request.Request(url, method="GET", headers=headers)
    try:
        with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
            payload = json.loads(raw) if raw else None
            return int(response.status), payload
    except urllib_error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = {"error": raw or str(exc.reason)}
        return int(exc.code), payload


def _http_post_json(
    url: str,
    headers: Dict[str, str],
    body: Dict[str, Any],
    timeout_seconds: int = 30,
) -> Tuple[int, Any]:
    request = urllib_request.Request(
        url,
        method="POST",
        headers=headers,
        data=json.dumps(body).encode("utf-8"),
    )
    try:
        with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
            payload = json.loads(raw) if raw else None
            return int(response.status), payload
    except urllib_error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = {"error": raw or str(exc.reason)}
        return int(exc.code), payload


def _postgrest_headers(api_key: str, schema: str) -> Dict[str, str]:
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Accept-Profile": schema,
    }


def _postgrest_get(
    rest_url: str,
    api_key: str,
    schema: str,
    table: str,
    params: List[Tuple[str, str]],
) -> List[Dict[str, Any]]:
    query = urlencode(params, doseq=True, safe="(),:*")
    url = f"{rest_url}/{table}"
    if query:
        url = f"{url}?{query}"
    status, payload = _http_get_json(url, _postgrest_headers(api_key, schema))
    if status >= 400:
        message = "PostgREST request failed"
        if isinstance(payload, dict):
            message = str(payload.get("message") or payload.get("error") or message)
        raise RuntimeError(f"{message} ({status})")
    if not isinstance(payload, list):
        return []
    return [row for row in payload if isinstance(row, dict)]


def _postgrest_rpc(
    rest_url: str,
    api_key: str,
    schema: str,
    rpc_name: str,
    body: Dict[str, Any],
) -> List[Dict[str, Any]]:
    url = f"{rest_url}/rpc/{rpc_name}"
    headers = _postgrest_headers(api_key, schema)
    headers["Content-Type"] = "application/json"
    status, payload = _http_post_json(url, headers, body)
    if status >= 400:
        message = f"RPC {rpc_name} failed"
        if isinstance(payload, dict):
            message = str(payload.get("message") or payload.get("error") or message)
        raise RuntimeError(f"{message} ({status})")
    if not isinstance(payload, list):
        return []
    return [row for row in payload if isinstance(row, dict)]


def _fetch_postgrest_all(
    rest_url: str,
    api_key: str,
    schema: str,
    table: str,
    base_params: List[Tuple[str, str]],
    order: Optional[str],
    limit: Optional[int],
    page_size: int,
    max_rows: int,
) -> Tuple[List[Dict[str, Any]], bool]:
    rows: List[Dict[str, Any]] = []
    offset = 0
    remaining = limit
    truncated = False

    while True:
        if remaining is not None and remaining <= 0:
            break
        page_limit = page_size if remaining is None else min(page_size, remaining)
        params = list(base_params)
        if order:
            params.append(("order", order))
        params.append(("limit", str(page_limit)))
        params.append(("offset", str(offset)))

        page_rows = _postgrest_get(rest_url, api_key, schema, table, params)
        rows.extend(page_rows)

        if len(rows) >= max_rows:
            rows = rows[:max_rows]
            truncated = True
            break

        fetched = len(page_rows)
        if fetched < page_limit:
            break

        offset += fetched
        if remaining is not None:
            remaining -= fetched

    return rows, truncated


def _sort_rows_desc(rows: Iterable[Dict[str, Any]], timestamp_key: str) -> List[Dict[str, Any]]:
    return sorted(rows, key=lambda row: str((row or {}).get(timestamp_key) or ""), reverse=True)


def _fetch_observations_for_timeseries(
    rest_url: str,
    api_key: str,
    schema: str,
    timeseries_ids: List[int],
    window_start_iso: str,
    window_end_iso: str,
    limit: Optional[int],
    timestamp_key: str,
    page_size: int,
    max_rows: int,
) -> Tuple[List[Dict[str, Any]], bool]:
    if not timeseries_ids:
        return [], False

    all_rows: List[Dict[str, Any]] = []
    truncated = False
    for ts_id in timeseries_ids:
        rows, rows_truncated = _fetch_postgrest_all(
            rest_url=rest_url,
            api_key=api_key,
            schema=schema,
            table="observations",
            base_params=[
                ("timeseries_id", f"eq.{ts_id}"),
                ("observed_at", f"gte.{window_start_iso}"),
                ("observed_at", f"lte.{window_end_iso}"),
                (
                    "select",
                    "connector_id,timeseries_id,observed_at,value,status,created_at",
                ),
            ],
            order="observed_at.desc",
            limit=limit,
            page_size=page_size,
            max_rows=max_rows,
        )
        all_rows.extend(rows)
        truncated = truncated or rows_truncated

    all_rows = _sort_rows_desc(all_rows, timestamp_key)
    if limit is not None and len(all_rows) > limit:
        all_rows = all_rows[:limit]
        truncated = True
    if len(all_rows) > max_rows:
        all_rows = all_rows[:max_rows]
        truncated = True
    return all_rows, truncated


def _resolve_station(
    ingest_rest_url: str,
    ingest_key: str,
    station_id: Optional[int],
    station_ref: Optional[str],
) -> Optional[Dict[str, Any]]:
    if station_id is not None:
        rows = _postgrest_get(
            ingest_rest_url,
            ingest_key,
            "uk_aq_core",
            "stations",
            [
                ("id", f"eq.{station_id}"),
                ("select", "*"),
                ("limit", "1"),
            ],
        )
        return rows[0] if rows else None

    if station_ref:
        rows = _postgrest_get(
            ingest_rest_url,
            ingest_key,
            "uk_aq_core",
            "stations",
            [
                ("station_ref", f"eq.{station_ref}"),
                ("select", "*"),
                ("order", "id.asc"),
                ("limit", "1"),
            ],
        )
        return rows[0] if rows else None

    return None


def _build_snapshot_from_ingest_postgrest(
    ingest_rest_url: str,
    ingest_key: str,
    station_id: Optional[int],
    station_ref: Optional[str],
    requested_timeseries_id: Optional[int],
    window: str,
    obs_limit: Optional[int],
    page_size: int,
    max_rows: int,
) -> Dict[str, Any]:
    window_start, window_end = _window_bounds(window)
    window_start_iso = _isoz(window_start)
    window_end_iso = _isoz(window_end)
    station = _resolve_station(ingest_rest_url, ingest_key, station_id, station_ref)

    payload: Dict[str, Any] = {
        "station": station,
        "timeseries": [],
        "stations_checkpoints": [],
        "timeseries_checkpoints": [],
        "selected_timeseries_id": None,
        "observations": [],
        "observations_all": [],
        "obs_aqidb_observations": [],
        "obs_aqidb_observations_all": [],
        "obs_aqidb_timeseries_aqi_hourly": [],
        "obs_aqidb_timeseries_aqi_daily": [],
        "meta": {
            "window": window,
            "window_start": window_start_iso,
            "window_end": window_end_iso,
            "obs_limit": "all" if obs_limit is None else obs_limit,
            "default_timeseries_rule": "lowest_timeseries_id_for_station",
            "station_resolution": "resolved" if station else "not_found",
            "ingest_source": "service_role_postgrest",
            "obs_aqidb_source": "unavailable",
        },
    }

    if not station:
        return payload

    resolved_station_id = int(station.get("id"))
    payload["meta"]["resolved_station_id"] = resolved_station_id
    payload["meta"]["resolved_station_ref"] = station.get("station_ref")

    timeseries_rows, timeseries_truncated = _fetch_postgrest_all(
        rest_url=ingest_rest_url,
        api_key=ingest_key,
        schema="uk_aq_core",
        table="timeseries",
        base_params=[
            ("station_id", f"eq.{resolved_station_id}"),
            ("select", "*"),
        ],
        order="id.asc",
        limit=None,
        page_size=page_size,
        max_rows=max_rows,
    )
    payload["timeseries"] = timeseries_rows

    station_checkpoints_rows, station_cp_truncated = _fetch_postgrest_all(
        rest_url=ingest_rest_url,
        api_key=ingest_key,
        schema="uk_aq_raw",
        table="openaq_station_checkpoints",
        base_params=[
            ("station_id", f"eq.{resolved_station_id}"),
            ("select", "*"),
        ],
        order="station_id.asc",
        limit=None,
        page_size=page_size,
        max_rows=max_rows,
    )
    payload["stations_checkpoints"] = station_checkpoints_rows

    timeseries_checkpoints_rows, timeseries_cp_truncated = _fetch_postgrest_all(
        rest_url=ingest_rest_url,
        api_key=ingest_key,
        schema="uk_aq_raw",
        table="openaq_timeseries_checkpoints",
        base_params=[
            ("station_id", f"eq.{resolved_station_id}"),
            ("select", "*"),
        ],
        order="timeseries_id.asc",
        limit=None,
        page_size=page_size,
        max_rows=max_rows,
    )
    payload["timeseries_checkpoints"] = timeseries_checkpoints_rows

    timeseries_ids: List[int] = []
    for row in timeseries_rows:
        try:
            timeseries_ids.append(int(row.get("id")))
        except (TypeError, ValueError):
            continue

    selected_timeseries_id: Optional[int] = None
    if requested_timeseries_id is not None and requested_timeseries_id in timeseries_ids:
        selected_timeseries_id = requested_timeseries_id
    elif timeseries_ids:
        selected_timeseries_id = min(timeseries_ids)
    payload["selected_timeseries_id"] = selected_timeseries_id

    observations_all_rows, observations_all_truncated = _fetch_observations_for_timeseries(
        rest_url=ingest_rest_url,
        api_key=ingest_key,
        schema="uk_aq_core",
        timeseries_ids=timeseries_ids,
        window_start_iso=window_start_iso,
        window_end_iso=window_end_iso,
        limit=obs_limit,
        timestamp_key="observed_at",
        page_size=page_size,
        max_rows=max_rows,
    )
    payload["observations_all"] = observations_all_rows

    selected_observations_rows: List[Dict[str, Any]] = []
    selected_observations_truncated = False
    if selected_timeseries_id is not None:
        selected_observations_rows, selected_observations_truncated = _fetch_observations_for_timeseries(
            rest_url=ingest_rest_url,
            api_key=ingest_key,
            schema="uk_aq_core",
            timeseries_ids=[selected_timeseries_id],
            window_start_iso=window_start_iso,
            window_end_iso=window_end_iso,
            limit=obs_limit,
            timestamp_key="observed_at",
            page_size=page_size,
            max_rows=max_rows,
        )
    payload["observations"] = selected_observations_rows

    payload["meta"]["ingest_truncated"] = bool(
        timeseries_truncated
        or station_cp_truncated
        or timeseries_cp_truncated
        or observations_all_truncated
        or selected_observations_truncated
    )
    payload["meta"]["ingest_counts"] = {
        "timeseries": len(timeseries_rows),
        "stations_checkpoints": len(station_checkpoints_rows),
        "timeseries_checkpoints": len(timeseries_checkpoints_rows),
        "observations_selected": len(selected_observations_rows),
        "observations_all": len(observations_all_rows),
    }
    return payload


def _parse_iso_datetime(value: Any) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _fetch_obs_aqidb_observs_rows_via_rpc(
    obs_rest_url: str,
    obs_key: str,
    timeseries_rows: List[Dict[str, Any]],
    window_start_iso: str,
    window_end_iso: str,
    max_rows: int,
) -> Tuple[List[Dict[str, Any]], bool]:
    start_dt = _parse_iso_datetime(window_start_iso)
    end_dt = _parse_iso_datetime(window_end_iso)
    if start_dt is None or end_dt is None:
        return [], False

    timeseries_to_connector: Dict[int, int] = {}
    for row in timeseries_rows:
        if not isinstance(row, dict):
            continue
        try:
            timeseries_id = int(row.get("id"))
            connector_id = int(row.get("connector_id"))
        except (TypeError, ValueError):
            continue
        if connector_id <= 0:
            continue
        timeseries_to_connector[timeseries_id] = connector_id

    if not timeseries_to_connector:
        return [], False

    connector_ids = sorted(set(timeseries_to_connector.values()))
    rpc_limit = 20000
    rows: List[Dict[str, Any]] = []
    truncated = False
    day_cursor = start_dt.date()
    end_day = end_dt.date()

    while day_cursor <= end_day and not truncated:
        day_iso = day_cursor.isoformat()
        for connector_id in connector_ids:
            after_timeseries_id: Optional[int] = None
            after_observed_at: Optional[str] = None
            while True:
                rpc_body: Dict[str, Any] = {
                    "p_day_utc": day_iso,
                    "p_connector_id": connector_id,
                    "p_after_timeseries_id": None,
                    "p_after_observed_at": None,
                    "p_limit": rpc_limit,
                }
                if after_timeseries_id is not None and after_observed_at is not None:
                    rpc_body["p_after_timeseries_id"] = after_timeseries_id
                    rpc_body["p_after_observed_at"] = after_observed_at

                batch = _postgrest_rpc(
                    rest_url=obs_rest_url,
                    api_key=obs_key,
                    schema="uk_aq_public",
                    rpc_name="uk_aq_rpc_observs_history_day_rows",
                    body=rpc_body,
                )
                if not batch:
                    break

                for item in batch:
                    try:
                        timeseries_id = int(item.get("timeseries_id"))
                    except (TypeError, ValueError):
                        continue
                    if timeseries_to_connector.get(timeseries_id) != connector_id:
                        continue
                    observed_at = _parse_iso_datetime(item.get("observed_at"))
                    if observed_at is None:
                        continue
                    if observed_at < start_dt or observed_at > end_dt:
                        continue

                    rows.append(
                        {
                            "connector_id": connector_id,
                            "timeseries_id": timeseries_id,
                            "observed_at": _isoz(observed_at),
                            "value": item.get("value"),
                        }
                    )
                    if len(rows) >= max_rows:
                        rows = rows[:max_rows]
                        truncated = True
                        break

                if truncated:
                    break

                if len(batch) < rpc_limit:
                    break

                last_row = batch[-1]
                try:
                    after_timeseries_id = int(last_row.get("timeseries_id"))
                    after_observed_at = str(last_row.get("observed_at") or "").strip()
                except (TypeError, ValueError):
                    break
                if after_timeseries_id is None or not after_observed_at:
                    break

            if truncated:
                break

        day_cursor += timedelta(days=1)

    rows.sort(
        key=lambda row: _parse_iso_datetime(row.get("observed_at"))
        or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return rows, truncated


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _psql_query_json_rows(obs_db_url: str, inner_select_sql: str) -> List[Dict[str, Any]]:
    sql = (
        "select coalesce(json_agg(t), '[]'::json) "
        "from (" + inner_select_sql + ") t"
    )
    command = [
        "psql",
        obs_db_url,
        "-X",
        "-q",
        "-t",
        "-A",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
    ]
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        raise RuntimeError(stderr or "psql query failed")
    stdout = (completed.stdout or "").strip()
    if not stdout:
        return []
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse psql JSON output: {exc}") from exc
    if not isinstance(payload, list):
        return []
    return [row for row in payload if isinstance(row, dict)]


def _fetch_obs_aqidb_snapshot_via_psql(
    obs_db_url: str,
    timeseries_ids: List[int],
    selected_timeseries_id: Optional[int],
    window_start_iso: str,
    window_end_iso: str,
    window_start_day: str,
    window_end_day: str,
    obs_limit: Optional[int],
    max_rows: int,
) -> Tuple[Dict[str, Any], bool]:
    rows_limit = max_rows if obs_limit is None else min(obs_limit, max_rows)
    ids_sql = ",".join(str(ts_id) for ts_id in sorted(set(timeseries_ids)))
    has_timeseries = bool(ids_sql)
    selected_limit_clause = f" limit {rows_limit}"
    all_limit_clause = f" limit {rows_limit}"
    aqi_limit_clause = f" limit {max_rows}"

    observations_selected: List[Dict[str, Any]] = []
    observations_all: List[Dict[str, Any]] = []
    aqi_hourly_rows: List[Dict[str, Any]] = []
    aqi_daily_rows: List[Dict[str, Any]] = []
    truncated = False

    if has_timeseries and selected_timeseries_id is not None:
        observations_selected = _psql_query_json_rows(
            obs_db_url,
            (
                "select connector_id, timeseries_id, observed_at, value "
                "from uk_aq_observs.observations "
                f"where timeseries_id = {selected_timeseries_id} "
                f"and observed_at >= {_sql_literal(window_start_iso)}::timestamptz "
                f"and observed_at <= {_sql_literal(window_end_iso)}::timestamptz "
                "order by observed_at desc"
                + selected_limit_clause
            ),
        )
        if len(observations_selected) >= rows_limit:
            truncated = True

    if has_timeseries:
        observations_all = _psql_query_json_rows(
            obs_db_url,
            (
                "select connector_id, timeseries_id, observed_at, value "
                "from uk_aq_observs.observations "
                f"where timeseries_id = any(array[{ids_sql}]::integer[]) "
                f"and observed_at >= {_sql_literal(window_start_iso)}::timestamptz "
                f"and observed_at <= {_sql_literal(window_end_iso)}::timestamptz "
                "order by observed_at desc"
                + all_limit_clause
            ),
        )
        if len(observations_all) >= rows_limit:
            truncated = True

    if has_timeseries:
        aqi_hourly_rows = _psql_query_json_rows(
            obs_db_url,
            (
                "select timeseries_id, station_id, connector_id, pollutant_code, timestamp_hour_utc, "
                "no2_hourly_mean_ugm3, pm25_hourly_mean_ugm3, pm10_hourly_mean_ugm3, "
                "pm25_rolling24h_mean_ugm3, pm10_rolling24h_mean_ugm3, hourly_sample_count, "
                "daqi_index_level, eaqi_index_level, daqi_no2_index_level, "
                "daqi_pm25_rolling24h_index_level, daqi_pm10_rolling24h_index_level, "
                "eaqi_no2_index_level, eaqi_pm25_index_level, eaqi_pm10_index_level, updated_at "
                "from uk_aq_aqilevels.timeseries_aqi_hourly "
                f"where timeseries_id = any(array[{ids_sql}]::integer[]) "
                f"and timestamp_hour_utc >= {_sql_literal(window_start_iso)}::timestamptz "
                f"and timestamp_hour_utc <= {_sql_literal(window_end_iso)}::timestamptz "
                "order by timestamp_hour_utc desc, timeseries_id asc"
                + aqi_limit_clause
            ),
        )
        if len(aqi_hourly_rows) >= max_rows:
            truncated = True

        aqi_daily_rows = _psql_query_json_rows(
            obs_db_url,
            (
                "select timeseries_id, station_id, connector_id, observed_day, standard_code, pollutant_code, "
                "index_level_hour_counts, valid_hour_count, max_index_level, updated_at "
                "from uk_aq_aqilevels.timeseries_aqi_daily "
                f"where timeseries_id = any(array[{ids_sql}]::integer[]) "
                f"and observed_day >= {_sql_literal(window_start_day)}::date "
                f"and observed_day <= {_sql_literal(window_end_day)}::date "
                "order by observed_day desc, timeseries_id asc, standard_code asc, pollutant_code asc"
                + aqi_limit_clause
            ),
        )
        if len(aqi_daily_rows) >= max_rows:
            truncated = True

    return {
        "observations_selected": observations_selected,
        "observations_all": observations_all,
        "timeseries_aqi_hourly": aqi_hourly_rows,
        "timeseries_aqi_daily": aqi_daily_rows,
    }, truncated


def _augment_snapshot_with_obs_aqidb(
    payload: Dict[str, Any],
    obs_rest_url: str,
    obs_key: str,
    obs_db_url: str,
    obs_limit: Optional[int],
    page_size: int,
    max_rows: int,
) -> None:
    station = payload.get("station")
    if not isinstance(station, dict):
        return
    if not obs_db_url and (not obs_rest_url or not obs_key):
        payload.setdefault("meta", {})["obs_aqidb_source"] = "unavailable"
        payload.setdefault("meta", {})["obs_aqidb_error"] = (
            "ObsAQIDB is not configured (set OBS_AQIDB_SUPABASE_DB_URL or OBS_AQIDB_SUPABASE_URL/OBS_AQIDB_SECRET_KEY)"
        )
        return

    meta = payload.setdefault("meta", {})
    window_start_iso = str(meta.get("window_start") or "")
    window_end_iso = str(meta.get("window_end") or "")
    window_start_day = window_start_iso[:10] if len(window_start_iso) >= 10 else ""
    window_end_day = window_end_iso[:10] if len(window_end_iso) >= 10 else ""

    timeseries_rows = payload.get("timeseries")
    timeseries_ids: List[int] = []
    if isinstance(timeseries_rows, list):
        for row in timeseries_rows:
            if not isinstance(row, dict):
                continue
            try:
                timeseries_ids.append(int(row.get("id")))
            except (TypeError, ValueError):
                continue

    selected_timeseries_id_raw = payload.get("selected_timeseries_id")
    selected_timeseries_id: Optional[int] = None
    try:
        if selected_timeseries_id_raw is not None:
            selected_timeseries_id = int(selected_timeseries_id_raw)
    except (TypeError, ValueError):
        selected_timeseries_id = None

    timeseries_rows_safe = timeseries_rows if isinstance(timeseries_rows, list) else []
    timeseries_ids: List[int] = []
    for row in timeseries_rows_safe:
        if not isinstance(row, dict):
            continue
        try:
            timeseries_ids.append(int(row.get("id")))
        except (TypeError, ValueError):
            continue

    payload["obs_aqidb_observations"] = []
    payload["obs_aqidb_observations_all"] = []
    payload["obs_aqidb_timeseries_aqi_hourly"] = []
    payload["obs_aqidb_timeseries_aqi_daily"] = []

    obs_aqidb_errors: List[str] = []
    obs_aqidb_truncated = False

    if obs_db_url:
        try:
            sql_payload, sql_truncated = _fetch_obs_aqidb_snapshot_via_psql(
                obs_db_url=obs_db_url,
                timeseries_ids=timeseries_ids,
                selected_timeseries_id=selected_timeseries_id,
                window_start_iso=window_start_iso,
                window_end_iso=window_end_iso,
                window_start_day=window_start_day,
                window_end_day=window_end_day,
                obs_limit=obs_limit,
                max_rows=max_rows,
            )
            payload["obs_aqidb_observations"] = sql_payload["observations_selected"]
            payload["obs_aqidb_observations_all"] = sql_payload["observations_all"]
            payload["obs_aqidb_timeseries_aqi_hourly"] = sql_payload["timeseries_aqi_hourly"]
            payload["obs_aqidb_timeseries_aqi_daily"] = sql_payload["timeseries_aqi_daily"]
            obs_aqidb_truncated = sql_truncated
            meta["obs_aqidb_source"] = "direct_sql_psql"
        except Exception as exc:
            obs_aqidb_errors.append(str(exc))

    if not payload["obs_aqidb_observations_all"] and obs_rest_url and obs_key:
        try:
            obs_all_rows, obs_all_truncated = _fetch_obs_aqidb_observs_rows_via_rpc(
                obs_rest_url=obs_rest_url,
                obs_key=obs_key,
                timeseries_rows=timeseries_rows_safe,
                window_start_iso=window_start_iso,
                window_end_iso=window_end_iso,
                max_rows=max_rows,
            )
            if obs_limit is not None and len(obs_all_rows) > obs_limit:
                obs_all_rows = obs_all_rows[:obs_limit]
                obs_all_truncated = True

            if selected_timeseries_id is not None:
                obs_selected_rows = []
                for row in obs_all_rows:
                    try:
                        ts_id = int((row or {}).get("timeseries_id"))
                    except (TypeError, ValueError):
                        continue
                    if ts_id == selected_timeseries_id:
                        obs_selected_rows.append(row)
            else:
                obs_selected_rows = []
            obs_selected_truncated = False
            if obs_limit is not None and len(obs_selected_rows) > obs_limit:
                obs_selected_rows = obs_selected_rows[:obs_limit]
                obs_selected_truncated = True

            payload["obs_aqidb_observations"] = obs_selected_rows
            payload["obs_aqidb_observations_all"] = obs_all_rows
            obs_aqidb_truncated = bool(
                obs_aqidb_truncated
                or obs_all_truncated
                or obs_selected_truncated
            )
            if meta.get("obs_aqidb_source") != "direct_sql_psql":
                meta["obs_aqidb_source"] = "service_role_postgrest_rpc"
        except Exception as exc:
            obs_aqidb_errors.append(str(exc))

    if (not payload["obs_aqidb_timeseries_aqi_hourly"] and not payload["obs_aqidb_timeseries_aqi_daily"]) and obs_rest_url and obs_key and timeseries_ids:
        try:
            timeseries_filter = "in.(" + ",".join(str(ts_id) for ts_id in sorted(set(timeseries_ids))) + ")"
            aqi_hourly_rows, aqi_hourly_truncated = _fetch_postgrest_all(
                rest_url=obs_rest_url,
                api_key=obs_key,
                schema="uk_aq_public",
                table="uk_aq_timeseries_aqi_hourly",
                base_params=[
                    ("timeseries_id", timeseries_filter),
                    ("timestamp_hour_utc", f"gte.{window_start_iso}"),
                    ("timestamp_hour_utc", f"lte.{window_end_iso}"),
                    ("select", "*"),
                ],
                order="timestamp_hour_utc.desc",
                limit=None,
                page_size=page_size,
                max_rows=max_rows,
            )

            aqi_daily_rows, aqi_daily_truncated = _fetch_postgrest_all(
                rest_url=obs_rest_url,
                api_key=obs_key,
                schema="uk_aq_public",
                table="uk_aq_timeseries_aqi_daily",
                base_params=[
                    ("timeseries_id", timeseries_filter),
                    ("observed_day", f"gte.{window_start_day}"),
                    ("observed_day", f"lte.{window_end_day}"),
                    ("select", "*"),
                ],
                order="observed_day.desc,timeseries_id.asc,standard_code.asc,pollutant_code.asc",
                limit=None,
                page_size=page_size,
                max_rows=max_rows,
            )
            payload["obs_aqidb_timeseries_aqi_hourly"] = aqi_hourly_rows
            payload["obs_aqidb_timeseries_aqi_daily"] = aqi_daily_rows
            obs_aqidb_truncated = bool(
                obs_aqidb_truncated
                or aqi_hourly_truncated
                or aqi_daily_truncated
            )
            if meta.get("obs_aqidb_source") not in {"direct_sql_psql", "service_role_postgrest_rpc"}:
                meta["obs_aqidb_source"] = "service_role_postgrest_views"
        except Exception as exc:
            obs_aqidb_errors.append(str(exc))

    if not any(
        [
            payload["obs_aqidb_observations"],
            payload["obs_aqidb_observations_all"],
            payload["obs_aqidb_timeseries_aqi_hourly"],
            payload["obs_aqidb_timeseries_aqi_daily"],
        ]
    ):
        if obs_aqidb_errors:
            meta["obs_aqidb_source"] = "error"
            meta["obs_aqidb_error"] = "; ".join(obs_aqidb_errors)
        else:
            meta["obs_aqidb_source"] = "unavailable"
        return

    meta["obs_aqidb_truncated"] = bool(obs_aqidb_truncated)
    meta["obs_aqidb_counts"] = {
        "observations_selected": len(payload["obs_aqidb_observations"]),
        "observations_all": len(payload["obs_aqidb_observations_all"]),
        "timeseries_aqi_hourly": len(payload["obs_aqidb_timeseries_aqi_hourly"]),
        "timeseries_aqi_daily": len(payload["obs_aqidb_timeseries_aqi_daily"]),
    }
    if obs_aqidb_errors:
        meta["obs_aqidb_warning"] = "; ".join(obs_aqidb_errors)


def _build_edge_snapshot_url(
    edge_url: str,
    station_id: Optional[int],
    station_ref: Optional[str],
    timeseries_id: Optional[int],
    window: str,
    obs_limit: Optional[int],
) -> str:
    params: List[Tuple[str, str]] = []
    if station_id is not None:
        params.append(("station_id", str(station_id)))
    if station_ref:
        params.append(("station_ref", station_ref))
    if timeseries_id is not None:
        params.append(("timeseries_id", str(timeseries_id)))
    params.append(("window", window))
    if obs_limit is None:
        params.append(("obs_limit", "1000"))
    else:
        params.append(("obs_limit", str(min(obs_limit, 1000))))

    query = urlencode(params, doseq=True, safe="(),:*")
    if "?" in edge_url:
        return f"{edge_url}&{query}"
    return f"{edge_url}?{query}"


def _fetch_snapshot_via_edge(
    edge_url: str,
    auth_state: Dict[str, str],
    auth_lock: threading.Lock,
    station_id: Optional[int],
    station_ref: Optional[str],
    timeseries_id: Optional[int],
    window: str,
    obs_limit: Optional[int],
) -> Dict[str, Any]:
    if not edge_url:
        raise RuntimeError("Edge URL is required for edge fallback mode")

    token, token_error = _ensure_access_token(auth_state, auth_lock, force_refresh=False)
    if not token:
        raise RuntimeError(token_error or "No valid token available")

    url = _build_edge_snapshot_url(
        edge_url=edge_url,
        station_id=station_id,
        station_ref=station_ref,
        timeseries_id=timeseries_id,
        window=window,
        obs_limit=obs_limit,
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    status, payload = _http_get_json(url, headers)

    if status == 401:
        token, token_error = _ensure_access_token(auth_state, auth_lock, force_refresh=True)
        if not token:
            raise RuntimeError(token_error or "No valid token available")
        headers["Authorization"] = f"Bearer {token}"
        status, payload = _http_get_json(url, headers)

    if status >= 400:
        message = "Snapshot request failed"
        if isinstance(payload, dict):
            message = str(payload.get("error") or payload.get("message") or message)
        raise RuntimeError(f"{message} ({status})")
    if not isinstance(payload, dict):
        raise RuntimeError("Snapshot response was not JSON object")

    payload.setdefault("observations_all", list(payload.get("observations") or []))
    payload.setdefault("obs_aqidb_observations", [])
    payload.setdefault("obs_aqidb_observations_all", [])
    payload.setdefault("obs_aqidb_timeseries_aqi_hourly", [])
    payload.setdefault("obs_aqidb_timeseries_aqi_daily", [])
    meta = payload.setdefault("meta", {})
    if isinstance(meta, dict):
        meta["ingest_source"] = "edge_rpc"
        meta["obs_aqidb_source"] = "unavailable"
    return payload


def _build_snapshot_payload(
    ingest_rest_url: str,
    ingest_key: str,
    obs_rest_url: str,
    obs_key: str,
    obs_db_url: str,
    edge_url: str,
    auth_state: Dict[str, str],
    auth_lock: threading.Lock,
    station_id: Optional[int],
    station_ref: Optional[str],
    timeseries_id: Optional[int],
    window: str,
    obs_limit: Optional[int],
    page_size: int,
    max_rows: int,
) -> Dict[str, Any]:
    if ingest_rest_url and ingest_key:
        payload = _build_snapshot_from_ingest_postgrest(
            ingest_rest_url=ingest_rest_url,
            ingest_key=ingest_key,
            station_id=station_id,
            station_ref=station_ref,
            requested_timeseries_id=timeseries_id,
            window=window,
            obs_limit=obs_limit,
            page_size=page_size,
            max_rows=max_rows,
        )
    else:
        payload = _fetch_snapshot_via_edge(
            edge_url=edge_url,
            auth_state=auth_state,
            auth_lock=auth_lock,
            station_id=station_id,
            station_ref=station_ref,
            timeseries_id=timeseries_id,
            window=window,
            obs_limit=obs_limit,
        )

    _augment_snapshot_with_obs_aqidb(
        payload=payload,
        obs_rest_url=obs_rest_url,
        obs_key=obs_key,
        obs_db_url=obs_db_url,
        obs_limit=obs_limit,
        page_size=page_size,
        max_rows=max_rows,
    )
    return payload


class StationSnapshotHandler(BaseHTTPRequestHandler):
    server_version = "uk-aq-station-snapshot-local/1.2"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
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
            self._serve_config()
            return
        if parsed.path == "/api/token":
            self._serve_token(parsed)
            return
        if parsed.path == "/api/snapshot":
            self._serve_snapshot(parsed)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _write_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, indent=2)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

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
        elif suffix in {".htm", ".html"}:
            content_type = "text/html; charset=utf-8"
        elif suffix == ".json":
            content_type = "application/json; charset=utf-8"
        else:
            content_type = "application/octet-stream"

        try:
            content = asset_path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def _serve_config(self) -> None:
        access_token = ""
        if self.server.edge_auth_enabled:
            access_token, _token_error = _ensure_access_token(
                self.server.auth_state,
                self.server.auth_lock,
                force_refresh=False,
            )
            access_token = access_token or ""

        self._write_json(
            HTTPStatus.OK,
            {
                "edge_url": self.server.edge_url,
                "default_station_id": self.server.default_station_id,
                "default_jwt": access_token,
                "snapshot_mode": self.server.snapshot_mode,
                "has_obs_aqidb": bool(
                    self.server.obs_db_url
                    or (self.server.obs_rest_url and self.server.obs_service_key)
                ),
                "default_obs_limit": "all",
            },
        )

    def _serve_token(self, parsed) -> None:
        if not self.server.edge_auth_enabled:
            self._write_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "Edge auth is not configured for this local server."},
            )
            return

        query = parse_qs(parsed.query or "")
        force_refresh = (query.get("force_refresh", ["0"])[0] or "").strip() in (
            "1",
            "true",
            "yes",
        )
        access_token, token_error = _ensure_access_token(
            self.server.auth_state,
            self.server.auth_lock,
            force_refresh=force_refresh,
        )
        if not access_token:
            self._write_json(
                HTTPStatus.UNAUTHORIZED,
                {"error": token_error or "No valid token available."},
            )
            return
        self._write_json(HTTPStatus.OK, {"access_token": access_token})

    def _serve_snapshot(self, parsed) -> None:
        query = parse_qs(parsed.query or "", keep_blank_values=False)

        station_id_raw = (query.get("station_id") or [""])[0]
        station_ref_raw = (query.get("station_ref") or [""])[0]
        timeseries_id_raw = (query.get("timeseries_id") or [""])[0]
        window_raw = (query.get("window") or [DEFAULT_WINDOW])[0]
        obs_limit_raw = (query.get("obs_limit") or ["all"])[0]

        try:
            station_id = _parse_station_id(station_id_raw)
            station_ref = str(station_ref_raw or "").strip() or None
            timeseries_id = _parse_timeseries_id(timeseries_id_raw)
            window = _parse_window(window_raw)
            obs_limit = _parse_obs_limit(obs_limit_raw)
        except (TypeError, ValueError) as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        if station_id is None and not station_ref:
            self._write_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "station_id or station_ref is required."},
            )
            return

        try:
            payload = _build_snapshot_payload(
                ingest_rest_url=self.server.ingest_rest_url,
                ingest_key=self.server.ingest_service_key,
                obs_rest_url=self.server.obs_rest_url,
                obs_key=self.server.obs_service_key,
                obs_db_url=self.server.obs_db_url,
                edge_url=self.server.edge_url,
                auth_state=self.server.auth_state,
                auth_lock=self.server.auth_lock,
                station_id=station_id,
                station_ref=station_ref,
                timeseries_id=timeseries_id,
                window=window,
                obs_limit=obs_limit,
                page_size=self.server.page_size,
                max_rows=self.server.max_rows,
            )
        except Exception as exc:
            self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        if not payload.get("station"):
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "Station not found.", **payload})
            return

        self._write_json(HTTPStatus.OK, payload)


def parse_args() -> argparse.Namespace:
    host_default = os.getenv("HOST", "127.0.0.1")
    try:
        port_default = int(os.getenv("PORT", "8046"))
    except ValueError:
        port_default = 8046

    dev_env_default = os.getenv("UK_AQ_DEV_ENV_FILE", ".env.supabase")
    parser = argparse.ArgumentParser(description="Run a local UK AQ Station Snapshot dashboard.")
    parser.add_argument("--host", default=host_default, help="Bind host (default: HOST or 127.0.0.1).")
    parser.add_argument("--port", type=int, default=port_default, help="Bind port (default: PORT or 8046).")
    parser.add_argument(
        "--html",
        default="station_snapshot/index.html",
        help="Path to station snapshot HTML file.",
    )
    parser.add_argument(
        "--edge-url",
        default="",
        help=(
            "Station snapshot edge URL (used only when service-role ingest access is unavailable). "
            "Defaults to UK_AQ_STATION_SNAPSHOT_EDGE_URL or <SUPABASE_URL>/functions/v1/uk_aq_station_snapshot."
        ),
    )
    parser.add_argument(
        "--dev-jwt",
        default=os.getenv("UK_AQ_DEV_JWT", ""),
        help="Initial auth JWT for edge fallback calls (defaults to UK_AQ_DEV_JWT).",
    )
    parser.add_argument(
        "--dev-refresh-token",
        default=os.getenv("UK_AQ_DEV_REFRESH_TOKEN", ""),
        help=(
            "Refresh token for auto-refreshing UK_AQ_DEV_JWT in edge fallback mode. "
            "Defaults to UK_AQ_DEV_REFRESH_TOKEN."
        ),
    )
    parser.add_argument(
        "--dev-env-file",
        default=dev_env_default,
        help=(
            "Env file to update with rotated UK_AQ_DEV_REFRESH_TOKEN (default: "
            "UK_AQ_DEV_ENV_FILE or .env.supabase)."
        ),
    )
    return parser.parse_args()


def _parse_positive_int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
    except ValueError:
        return default
    if parsed <= 0:
        return default
    return parsed


def main() -> None:
    _load_env(Path(".env"))
    _load_env(Path(".env.supabase"))
    args = parse_args()

    html_path = Path(args.html)
    if not html_path.exists():
        raise SystemExit(f"HTML file not found: {html_path}")

    supabase_url = (os.getenv("SUPABASE_URL") or os.getenv("SB_SUPABASE_URL") or "").strip()
    ingest_rest_url = _to_rest_url(supabase_url)
    ingest_service_key = _env_service_key()

    obs_base_url = (os.getenv("OBS_AQIDB_SUPABASE_URL") or "").strip()
    obs_rest_url = _to_rest_url(obs_base_url)
    obs_service_key = _env_obs_service_key()
    obs_db_url = _env_obs_db_url()

    edge_url = (args.edge_url or _default_edge_url()).strip()

    dev_jwt = (args.dev_jwt or "").strip()
    dev_refresh_token = (args.dev_refresh_token or "").strip()
    dev_env_file = (args.dev_env_file or "").strip()
    publishable_key = _env_publishable_key()

    service_mode_enabled = bool(ingest_rest_url and ingest_service_key)
    edge_auth_enabled = bool(dev_jwt or dev_refresh_token)
    edge_mode_enabled = bool(edge_url and edge_auth_enabled)

    if not service_mode_enabled and not edge_mode_enabled:
        raise SystemExit(
            "Station snapshot local server requires either:\n"
            "1) SUPABASE_URL + SB_SECRET_KEY for service-role mode, or\n"
            "2) edge URL plus UK_AQ_DEV_JWT/UK_AQ_DEV_REFRESH_TOKEN for edge fallback mode."
        )
    if dev_refresh_token and (not supabase_url or not publishable_key):
        raise SystemExit(
            "Auto-refresh requires SUPABASE_URL (or SB_SUPABASE_URL) and SB_PUBLISHABLE_DEFAULT_KEY."
        )

    page_size = _parse_positive_int_env("UK_AQ_STATION_SNAPSHOT_PAGE_SIZE", DEFAULT_PAGE_SIZE)
    max_rows = _parse_positive_int_env("UK_AQ_STATION_SNAPSHOT_MAX_ROWS", DEFAULT_MAX_ROWS)
    page_size = max(100, min(page_size, 5000))
    max_rows = max(1000, min(max_rows, 1000000))

    server = ThreadingHTTPServer((args.host, args.port), StationSnapshotHandler)
    server.html_path = html_path
    server.edge_url = edge_url
    server.default_station_id = (os.getenv("CLEANAIRSURB_ST_ID") or "").strip()

    server.snapshot_mode = "service_role_postgrest" if service_mode_enabled else "edge_fallback"
    server.ingest_rest_url = ingest_rest_url
    server.ingest_service_key = ingest_service_key
    server.obs_rest_url = obs_rest_url
    server.obs_service_key = obs_service_key
    server.obs_db_url = obs_db_url
    server.page_size = page_size
    server.max_rows = max_rows

    server.edge_auth_enabled = edge_auth_enabled
    server.auth_lock = threading.Lock()
    server.auth_state = {
        "access_token": dev_jwt,
        "refresh_token": dev_refresh_token,
        "supabase_url": supabase_url,
        "publishable_key": publishable_key,
        "env_path": dev_env_file,
    }

    print(f"UK AQ station snapshot dashboard running at http://{args.host}:{args.port}")
    print(
        "mode="
        f"{server.snapshot_mode}, "
        f"obs_aqidb={'enabled' if (obs_db_url or (obs_rest_url and obs_service_key)) else 'disabled'}, "
        f"page_size={page_size}, max_rows={max_rows}"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
