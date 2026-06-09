#!/usr/bin/env python3
"""UK-AQ History Integrity — entrypoint.

Phase 1: env loading, guardrails, schema, run row + report.
Phase 2: core snapshot import from the local Dropbox R2 history backup.
Phase 3: OpenAQ source adapter — HEAD-check, conditional download,
         SHA-256 over compressed + uncompressed bytes, source-cache for
         changed files, source_file_state + source_file_events upsert,
         soft download/runtime limits, planned-backfill print.

Sensor.Community adapter, real backfill invocation, and API adapters land
in Phases 5/4/7.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import http.client
import json
import logging
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable, Iterable


REQUIRED_ENV_VARS = (
    "UK_AQ_ENV_NAME",
    "UK_AQ_HISTORY_INTEGRITY_ROOT",
    "UK_AQ_HISTORY_INTEGRITY_STATE_DIR",
    "UK_AQ_HISTORY_INTEGRITY_DB_PATH",
    "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR",
    "UK_AQ_HISTORY_INTEGRITY_TMP_DIR",
    "UK_AQ_HISTORY_INTEGRITY_LOG_DIR",
    "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR",
    "UK_AQ_HISTORY_INTEGRITY_LOCK_DIR",
    "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT",
)

PATH_VARS_FOR_GUARDRAILS = (
    "UK_AQ_HISTORY_INTEGRITY_ROOT",
    "UK_AQ_HISTORY_INTEGRITY_STATE_DIR",
    "UK_AQ_HISTORY_INTEGRITY_DB_PATH",
    "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR",
    "UK_AQ_HISTORY_INTEGRITY_TMP_DIR",
    "UK_AQ_HISTORY_INTEGRITY_LOG_DIR",
    "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR",
    "UK_AQ_HISTORY_INTEGRITY_LOCK_DIR",
    "UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH",
    "UK_AQ_R2_HISTORY_DROPBOX_ROOT",
    "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT",
    "UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER",
    "UK_AQ_INTEGRITY_BACKFILL_WRAPPER",
    "UK_AQ_BACKFILL_WRAPPER",
    "UK_AQ_BACKFILL_ENV_FILE",
)

# start_offset_back in days for each schedule profile.
PROFILE_START_WINDOWS_DAYS = {
    "daily": 21,
    "weekly": 120,
    "monthly": 730,
}

DEFAULT_INGESTDB_RETENTION_DAYS = 5

DAILY_TASK_HEALTH_TASK_KEY = "ops.history_integrity"
DAILY_TASK_HEALTH_SOURCE_REPO = "uk-aq-ops"
DAILY_TASK_HEALTH_SOURCE_WORKER = "uk-aq-history-integrity"
DAILY_TASK_HEALTH_RPC_SCHEMA = "uk_aq_public"
DAILY_TASK_HEALTH_ERROR_LIMIT = 1200


def resolve_integrity_backfill_wrapper() -> str:
    for name in (
        "UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER",
        "UK_AQ_INTEGRITY_BACKFILL_WRAPPER",
    ):
        raw = str(os.environ.get(name, "")).strip()
        if raw:
            return raw
    return ""

# ---------------------------------------------------------------------------
# Phase 2 — core snapshot import
# ---------------------------------------------------------------------------

# Source-key canonicalisation: maps the value of `connectors.connector_code`
# in the core snapshot to the source_key strings used by the source adapters
# (and by source_file_state / source_file_events).
SOURCE_KEY_BY_CONNECTOR_CODE = {
    "openaq": "openaq",
    "sensorcommunity": "sensorcommunity",
    "uk_air_sos": "uk_air_sos",
}

# `--source all` includes all currently implemented source adapters.
CROSS_CHECK_SOURCE_KEYS_BY_FILTER: dict[str, tuple[str, ...]] = {
    "openaq": ("openaq",),
    "sensorcommunity": ("sensorcommunity",),
    "uk_air_sos": ("uk_air_sos",),
    "all": ("openaq", "sensorcommunity", "uk_air_sos"),
}
CROSS_CHECK_BACKFILL_CONNECTOR_CODES_BY_FILTER: dict[str, tuple[str, ...]] = {
    "openaq": ("openaq",),
    "sensorcommunity": ("sensorcommunity",),
    # Phase 7.4: include uk_air_sos in observation-repair candidates.
    "uk_air_sos": ("uk_air_sos",),
    "all": ("openaq", "sensorcommunity", "uk_air_sos"),
}

# Subset of core tables that the integrity DB needs. Other tables in the
# manifest (categories, observed_properties, offerings, features, procedures,
# uk_aq_networks, uk_air_sos_*, station_metadata, station_network_memberships)
# are accepted in the manifest but not imported in this phase.
CORE_TABLES_TO_IMPORT = ("connectors", "stations", "timeseries", "phenomena")

DAY_DIR_PATTERN = "day_utc=*"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS core_snapshot_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at_utc TEXT NOT NULL,
  env_name TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  snapshot_day_utc TEXT,
  snapshot_manifest_hash TEXT,
  rows_connectors INTEGER DEFAULT 0,
  rows_stations INTEGER DEFAULT 0,
  rows_timeseries INTEGER DEFAULT 0,
  rows_pollutants INTEGER DEFAULT 0,
  rows_lookup INTEGER DEFAULT 0,
  bytes_read INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_core_snapshot_imports_env_status
  ON core_snapshot_imports(env_name, status, id DESC);

CREATE TABLE IF NOT EXISTS core_connectors_snapshot (
  id INTEGER PRIMARY KEY,
  connector_code TEXT NOT NULL,
  label TEXT,
  display_name TEXT,
  service_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_core_connectors_snapshot_code
  ON core_connectors_snapshot(connector_code);

CREATE TABLE IF NOT EXISTS core_stations_snapshot (
  id INTEGER PRIMARY KEY,
  connector_id INTEGER NOT NULL,
  station_ref TEXT NOT NULL,
  service_ref TEXT,
  label TEXT,
  station_name TEXT,
  station_type TEXT,
  la_code TEXT,
  pcon_code TEXT,
  removed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_core_stations_snapshot_connector_ref
  ON core_stations_snapshot(connector_id, station_ref);

CREATE TABLE IF NOT EXISTS core_timeseries_snapshot (
  id INTEGER PRIMARY KEY,
  station_id INTEGER,
  connector_id INTEGER NOT NULL,
  timeseries_ref TEXT,
  label TEXT,
  phenomenon_id INTEGER,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_core_timeseries_snapshot_station
  ON core_timeseries_snapshot(station_id);
CREATE INDEX IF NOT EXISTS idx_core_timeseries_snapshot_conn_phen
  ON core_timeseries_snapshot(connector_id, phenomenon_id);

CREATE TABLE IF NOT EXISTS core_phenomena_snapshot (
  id INTEGER PRIMARY KEY,
  label TEXT,
  source_label TEXT,
  pollutant_label TEXT,
  observed_property_id INTEGER,
  connector_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_station_timeseries_lookup (
  source_key TEXT NOT NULL,
  source_location_id TEXT NOT NULL,
  station_ref TEXT NOT NULL,
  station_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  timeseries_id INTEGER NOT NULL,
  is_active INTEGER NOT NULL,
  PRIMARY KEY (source_key, source_location_id, timeseries_id)
);

CREATE INDEX IF NOT EXISTS idx_lookup_station
  ON source_station_timeseries_lookup(station_id);
CREATE INDEX IF NOT EXISTS idx_lookup_source_loc
  ON source_station_timeseries_lookup(source_key, source_location_id);

-- Phase 6.5 Pass A: per-(source_file, timeseries) row counts derived from
-- the upstream archive file at ingest time. Recorded only when we download
-- (first_seen / changed / reappeared); unchanged metadata reuses the
-- previously stored values since the source bytes haven't changed.
CREATE TABLE IF NOT EXISTS source_file_timeseries_counts (
  source_file_key TEXT NOT NULL,
  timeseries_id   INTEGER NOT NULL,
  row_count       INTEGER NOT NULL,
  counted_at_utc  TEXT NOT NULL,
  PRIMARY KEY (source_file_key, timeseries_id)
);

CREATE INDEX IF NOT EXISTS idx_sftc_timeseries
  ON source_file_timeseries_counts(timeseries_id);

-- Phase 6.5 Pass B: per-run source-vs-R2 comparison outcomes at
-- (connector_id, day_utc, timeseries_id) granularity.
CREATE TABLE IF NOT EXISTS cross_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  env_name TEXT NOT NULL,
  connector_id INTEGER NOT NULL,
  day_utc TEXT NOT NULL,
  timeseries_id INTEGER NOT NULL,
  source_row_count INTEGER,
  r2_row_count INTEGER,
  delta INTEGER,
  status TEXT NOT NULL,
  checked_at_utc TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_cross_checks_run
  ON cross_checks(run_id, status);
CREATE INDEX IF NOT EXISTS idx_cross_checks_day_connector
  ON cross_checks(day_utc, connector_id, timeseries_id);

CREATE TABLE IF NOT EXISTS aqi_rebuild_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  env_name TEXT NOT NULL,
  connector_id INTEGER NOT NULL,
  day_utc TEXT NOT NULL,

  reason TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  status TEXT NOT NULL,

  requested_timeseries_ids TEXT,
  notes TEXT,

  created_at_utc TEXT NOT NULL,
  started_at_utc TEXT,
  finished_at_utc TEXT,

  UNIQUE(run_id, connector_id, day_utc)
);

CREATE INDEX IF NOT EXISTS idx_aqi_rebuild_queue_run_status
  ON aqi_rebuild_queue(run_id, status, connector_id, day_utc);

CREATE TABLE IF NOT EXISTS source_file_state (
  source_file_key TEXT PRIMARY KEY,

  env_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  remote_scheme TEXT NOT NULL,
  remote_url_or_key TEXT NOT NULL,

  station_ref TEXT,
  source_location_id TEXT,
  day_utc TEXT,
  date_range_start_utc TEXT,
  date_range_end_utc TEXT,

  exists_remote INTEGER NOT NULL,
  content_length INTEGER,
  etag TEXT,
  last_modified_utc TEXT,

  sha256_downloaded TEXT,
  sha256_uncompressed TEXT,

  local_cached_path TEXT,

  first_seen_at_utc TEXT NOT NULL,
  last_checked_at_utc TEXT NOT NULL,
  last_changed_at_utc TEXT,

  last_status TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_file_state_source_day
  ON source_file_state(source_key, day_utc);

CREATE TABLE IF NOT EXISTS source_file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  event_at_utc TEXT NOT NULL,
  env_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  event_type TEXT NOT NULL,

  source_file_key TEXT NOT NULL,
  remote_url_or_key TEXT NOT NULL,

  station_ref TEXT,
  source_location_id TEXT,
  day_utc TEXT,

  old_content_length INTEGER,
  new_content_length INTEGER,

  old_etag TEXT,
  new_etag TEXT,

  old_last_modified_utc TEXT,
  new_last_modified_utc TEXT,

  old_sha256_downloaded TEXT,
  new_sha256_downloaded TEXT,

  old_sha256_uncompressed TEXT,
  new_sha256_uncompressed TEXT,

  downloaded_bytes INTEGER DEFAULT 0,
  hash_runtime_ms INTEGER DEFAULT 0,

  backfill_triggered INTEGER NOT NULL DEFAULT 0,
  backfill_timeseries_ids TEXT,
  backfill_status TEXT,

  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_file_events_key
  ON source_file_events(source_file_key, event_at_utc);

CREATE TABLE IF NOT EXISTS integrity_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT,
  env_name TEXT NOT NULL,
  profile TEXT NOT NULL,
  source_filter TEXT,
  from_day TEXT,
  to_day TEXT,

  status TEXT NOT NULL,

  files_head_checked INTEGER DEFAULT 0,
  files_downloaded INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  files_unchanged_after_download INTEGER DEFAULT 0,
  files_missing INTEGER DEFAULT 0,

  downloaded_bytes INTEGER DEFAULT 0,
  downloaded_mb REAL DEFAULT 0,
  runtime_seconds REAL DEFAULT 0,

  backfills_triggered INTEGER DEFAULT 0,
  cross_checks_total INTEGER DEFAULT 0,
  cross_checks_ok INTEGER DEFAULT 0,
  cross_checks_mismatch INTEGER DEFAULT 0,
  cross_checks_source_only INTEGER DEFAULT 0,
  cross_checks_r2_only INTEGER DEFAULT 0,
  cross_checks_r2_manifest_missing INTEGER DEFAULT 0,
  observation_backfills_attempted INTEGER DEFAULT 0,
  observation_backfills_ok INTEGER DEFAULT 0,
  observation_backfills_failed INTEGER DEFAULT 0,
  aqi_rebuilds_queued_from_obs_repair INTEGER DEFAULT 0,
  aqi_health_connector_days_checked INTEGER DEFAULT 0,
  aqi_health_rebuilds_queued INTEGER DEFAULT 0,
  aqi_health_skipped_already_obs_repaired INTEGER DEFAULT 0,
  aqi_health_manifest_missing INTEGER DEFAULT 0,
  aqi_health_manifest_stale INTEGER DEFAULT 0,
  aqi_health_manifest_empty INTEGER DEFAULT 0,
  aqi_health_previous_rebuild_failed INTEGER DEFAULT 0,
  aqi_rebuilds_queued_total INTEGER DEFAULT 0,
  aqi_rebuilds_attempted INTEGER DEFAULT 0,
  aqi_rebuilds_complete INTEGER DEFAULT 0,
  aqi_rebuilds_failed INTEGER DEFAULT 0,
  aqi_rebuilds_skipped INTEGER DEFAULT 0,

  warnings_count INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,

  notes TEXT
);
"""


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------------------
# SQLite helpers
# ---------------------------------------------------------------------------

def ensure_columns(
    conn: sqlite3.Connection,
    table: str,
    columns: dict[str, str],
) -> None:
    """Add columns to an existing table if missing. SQLite has no IF NOT EXISTS
    on ALTER TABLE ADD COLUMN, so we introspect via PRAGMA."""
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    for col_name, col_def in columns.items():
        if col_name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_def}")


# ---------------------------------------------------------------------------
# Phase 2 — snapshot discovery, manifest read, import, and lookup build.
# ---------------------------------------------------------------------------

def sha256_of_file(path: Path, chunk_size: int = 65536) -> tuple[str, int]:
    """Stream-hash a file. Returns (hex_digest, bytes_read)."""
    hasher = hashlib.sha256()
    total = 0
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
            total += len(chunk)
    return hasher.hexdigest(), total


def list_snapshot_day_dirs(root: Path) -> list[Path]:
    """Return day_utc=YYYY-MM-DD directories under root, newest first."""
    if not root.is_dir():
        return []
    days = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        name = entry.name
        if not name.startswith("day_utc="):
            continue
        date_part = name.split("=", 1)[1]
        if len(date_part) != 10 or date_part[4] != "-" or date_part[7] != "-":
            continue
        days.append(entry)
    days.sort(key=lambda p: p.name, reverse=True)
    return days


def read_manifest(day_dir: Path) -> dict[str, Any] | None:
    """Read and validate a manifest.json. Returns None if missing/invalid."""
    manifest_path = day_dir / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError:
        return None
    if (
        not isinstance(manifest, dict)
        or not isinstance(manifest.get("manifest_hash"), str)
        or not isinstance(manifest.get("tables"), list)
        or not isinstance(manifest.get("day_utc"), str)
    ):
        return None
    return manifest


def find_latest_snapshot(
    root: Path,
    log: logging.Logger,
) -> tuple[Path, dict[str, Any]] | None:
    """Find the newest day_utc directory whose manifest.json is valid."""
    candidates = list_snapshot_day_dirs(root)
    for day_dir in candidates:
        manifest = read_manifest(day_dir)
        if manifest is None:
            log.warning("snapshot %s: missing or invalid manifest.json — skipping", day_dir.name)
            continue
        return day_dir, manifest
    return None


def latest_successful_import(
    conn: sqlite3.Connection,
    env_name: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT id, snapshot_path, snapshot_manifest_hash, snapshot_day_utc, imported_at_utc
        FROM core_snapshot_imports
        WHERE env_name = ? AND status = 'ok'
        ORDER BY id DESC
        LIMIT 1
        """,
        (env_name,),
    ).fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "snapshot_path": row[1],
        "snapshot_manifest_hash": row[2],
        "snapshot_day_utc": row[3],
        "imported_at_utc": row[4],
    }


def snapshot_tables_have_rows(conn: sqlite3.Connection) -> bool:
    """True if the per-env snapshot tables look populated.
    Re-import is forced if the previous run claimed success but the rows
    were wiped (e.g. by a manual DB reset)."""
    row = conn.execute("SELECT COUNT(*) FROM core_stations_snapshot").fetchone()
    return bool(row and row[0] > 0)


def _row_get_int(row: dict[str, Any], key: str) -> int | None:
    val = row.get(key)
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _row_get_str(row: dict[str, Any], key: str) -> str | None:
    val = row.get(key)
    if val is None:
        return None
    return str(val)


def _stream_ndjson_gz(path: Path) -> Iterable[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            yield json.loads(line)


# Per-table row inserters. Each returns (insert_sql, row_to_tuple_fn).
def _connectors_insert_spec() -> tuple[str, Any]:
    sql = (
        "INSERT INTO core_connectors_snapshot "
        "(id, connector_code, label, display_name, service_url) "
        "VALUES (?, ?, ?, ?, ?)"
    )
    def to_tuple(r: dict[str, Any]) -> tuple:
        return (
            _row_get_int(r, "id"),
            _row_get_str(r, "connector_code"),
            _row_get_str(r, "label"),
            _row_get_str(r, "display_name"),
            _row_get_str(r, "service_url"),
        )
    return sql, to_tuple


def _stations_insert_spec() -> tuple[str, Any]:
    sql = (
        "INSERT INTO core_stations_snapshot "
        "(id, connector_id, station_ref, service_ref, label, station_name, "
        " station_type, la_code, pcon_code, removed_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    def to_tuple(r: dict[str, Any]) -> tuple:
        return (
            _row_get_int(r, "id"),
            _row_get_int(r, "connector_id"),
            _row_get_str(r, "station_ref"),
            _row_get_str(r, "service_ref"),
            _row_get_str(r, "label"),
            _row_get_str(r, "station_name"),
            _row_get_str(r, "station_type"),
            _row_get_str(r, "la_code"),
            _row_get_str(r, "pcon_code"),
            _row_get_str(r, "removed_at"),
        )
    return sql, to_tuple


def _timeseries_insert_spec() -> tuple[str, Any]:
    sql = (
        "INSERT INTO core_timeseries_snapshot "
        "(id, station_id, connector_id, timeseries_ref, label, "
        " phenomenon_id, ended_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    def to_tuple(r: dict[str, Any]) -> tuple:
        return (
            _row_get_int(r, "id"),
            _row_get_int(r, "station_id"),
            _row_get_int(r, "connector_id"),
            _row_get_str(r, "timeseries_ref"),
            _row_get_str(r, "label"),
            _row_get_int(r, "phenomenon_id"),
            _row_get_str(r, "ended_at"),
        )
    return sql, to_tuple


def _phenomena_insert_spec() -> tuple[str, Any]:
    sql = (
        "INSERT INTO core_phenomena_snapshot "
        "(id, label, source_label, pollutant_label, observed_property_id, "
        " connector_id) "
        "VALUES (?, ?, ?, ?, ?, ?)"
    )
    def to_tuple(r: dict[str, Any]) -> tuple:
        return (
            _row_get_int(r, "id"),
            _row_get_str(r, "label"),
            _row_get_str(r, "source_label"),
            _row_get_str(r, "pollutant_label"),
            _row_get_int(r, "observed_property_id"),
            _row_get_int(r, "connector_id"),
        )
    return sql, to_tuple


_INSERT_SPECS = {
    "connectors": _connectors_insert_spec,
    "stations":   _stations_insert_spec,
    "timeseries": _timeseries_insert_spec,
    "phenomena":  _phenomena_insert_spec,
}

_TARGET_TABLES = {
    "connectors": "core_connectors_snapshot",
    "stations":   "core_stations_snapshot",
    "timeseries": "core_timeseries_snapshot",
    "phenomena":  "core_phenomena_snapshot",
}


def _verify_and_load_table(
    conn: sqlite3.Connection,
    day_dir: Path,
    table_entry: dict[str, Any],
    log: logging.Logger,
) -> tuple[int, int]:
    """Verify the file's SHA-256 against the manifest, then load rows.
    Returns (rows_loaded, bytes_read). Raises on hash mismatch or read error."""
    rel_path = table_entry.get("relative_path") or ""
    expected_sha = table_entry.get("sha256")
    table = table_entry.get("table")
    if not rel_path or not expected_sha or not table:
        raise RuntimeError(f"manifest table entry missing required fields: {table_entry!r}")

    file_path = day_dir / rel_path
    if not file_path.is_file():
        raise RuntimeError(f"snapshot file missing: {file_path}")

    actual_sha, bytes_read = sha256_of_file(file_path)
    if actual_sha != expected_sha:
        raise RuntimeError(
            f"sha256 mismatch for {file_path}: expected {expected_sha} got {actual_sha}"
        )

    sql, to_tuple = _INSERT_SPECS[table]()
    target_table = _TARGET_TABLES[table]
    conn.execute(f"DELETE FROM {target_table}")

    rows_loaded = 0
    batch: list[tuple] = []
    for row in _stream_ndjson_gz(file_path):
        batch.append(to_tuple(row))
        if len(batch) >= 1000:
            conn.executemany(sql, batch)
            rows_loaded += len(batch)
            batch.clear()
    if batch:
        conn.executemany(sql, batch)
        rows_loaded += len(batch)

    log.info("snapshot table=%s loaded rows=%s bytes_read=%s", table, rows_loaded, bytes_read)
    return rows_loaded, bytes_read


def _build_lookup(conn: sqlite3.Connection, log: logging.Logger) -> int:
    """Rebuild source_station_timeseries_lookup from the snapshot tables."""
    conn.execute("DELETE FROM source_station_timeseries_lookup")

    # Map connector_code -> connector_id from the snapshot.
    conn_id_by_code: dict[str, int] = {}
    for code in SOURCE_KEY_BY_CONNECTOR_CODE:
        row = conn.execute(
            "SELECT id FROM core_connectors_snapshot WHERE connector_code = ?",
            (code,),
        ).fetchone()
        if row is None:
            log.warning("connector_code=%s not present in snapshot — lookup will skip its source", code)
            continue
        conn_id_by_code[code] = row[0]

    total = 0
    for code, connector_id in conn_id_by_code.items():
        source_key = SOURCE_KEY_BY_CONNECTOR_CODE[code]
        cur = conn.execute(
            """
            INSERT INTO source_station_timeseries_lookup
              (source_key, source_location_id, station_ref, station_id,
               connector_id, timeseries_id, is_active)
            SELECT
              ?,
              s.station_ref,
              s.station_ref,
              s.id,
              s.connector_id,
              t.id,
              CASE WHEN t.ended_at IS NULL OR t.ended_at = '' THEN 1 ELSE 0 END
            FROM core_stations_snapshot s
            JOIN core_timeseries_snapshot t ON t.station_id = s.id
            WHERE s.connector_id = ?
              AND (s.removed_at IS NULL OR s.removed_at = '')
              AND s.station_ref IS NOT NULL
              AND s.station_ref != ''
            """,
            (source_key, connector_id),
        )
        added = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
        log.info("lookup source_key=%s connector_id=%s rows=%s", source_key, connector_id, added)
        total += added
    return total


def collect_lookup_active_counts_by_source(
    conn: sqlite3.Connection,
    source_keys: Iterable[str] = ("openaq", "sensorcommunity", "uk_air_sos"),
) -> dict[str, dict[str, int]]:
    keys = tuple(dict.fromkeys(str(k) for k in source_keys if str(k)))
    if not keys:
        return {}
    placeholders = ",".join("?" for _ in keys)
    rows = conn.execute(
        f"""
        SELECT
          source_key,
          COUNT(DISTINCT CASE WHEN is_active = 1 THEN station_id END) AS active_stations,
          COUNT(DISTINCT CASE WHEN is_active = 1 THEN timeseries_id END) AS active_timeseries
        FROM source_station_timeseries_lookup
        WHERE source_key IN ({placeholders})
        GROUP BY source_key
        """,
        keys,
    ).fetchall()
    counts: dict[str, dict[str, int]] = {
        key: {"active_stations": 0, "active_timeseries": 0}
        for key in keys
    }
    for source_key, active_stations, active_timeseries in rows:
        counts[str(source_key)] = {
            "active_stations": int(active_stations or 0),
            "active_timeseries": int(active_timeseries or 0),
        }
    return counts


def import_core_snapshot(
    conn: sqlite3.Connection,
    env_name: str,
    snapshot_root_str: str | None,
    force: bool,
    dry_run: bool,
    log: logging.Logger,
) -> dict[str, Any]:
    """Full Phase 2 import workflow. Always returns a result dict; the caller
    uses `status` to decide how to surface this in the run summary.

    status values:
      missing_root   — env var unset or path missing/empty
      no_snapshot    — root exists but no valid manifest found
      reused         — manifest hash matches last successful import
      dry_run        — would import; no DB writes performed
      imported       — fresh import succeeded
      error          — import attempted but failed (raises after recording)
    """
    result: dict[str, Any] = {
        "status": "missing_root",
        "snapshot_root": snapshot_root_str,
        "snapshot_day_dir": None,
        "snapshot_day_utc": None,
        "manifest_hash": None,
        "previous_manifest_hash": None,
        "tables": {},
        "rows_lookup": 0,
        "bytes_read": 0,
        "error": None,
    }

    if not snapshot_root_str:
        result["error"] = "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT is not set"
        log.warning("snapshot import skipped: %s", result["error"])
        return result

    snapshot_root = Path(snapshot_root_str)
    if not snapshot_root.is_dir():
        result["error"] = f"snapshot root does not exist: {snapshot_root}"
        log.warning("snapshot import skipped: %s", result["error"])
        return result

    found = find_latest_snapshot(snapshot_root, log)
    if found is None:
        result["status"] = "no_snapshot"
        result["error"] = f"no valid snapshot manifest under {snapshot_root}"
        log.warning("snapshot import: %s", result["error"])
        return result

    day_dir, manifest = found
    manifest_hash = manifest["manifest_hash"]
    day_utc = manifest["day_utc"]
    result["snapshot_day_dir"] = str(day_dir)
    result["snapshot_day_utc"] = day_utc
    result["manifest_hash"] = manifest_hash

    previous = latest_successful_import(conn, env_name)
    if previous:
        result["previous_manifest_hash"] = previous["snapshot_manifest_hash"]

    if (
        not force
        and previous is not None
        and previous["snapshot_manifest_hash"] == manifest_hash
        and snapshot_tables_have_rows(conn)
    ):
        result["status"] = "reused"
        log.info(
            "snapshot reused: day=%s manifest_hash=%s (previous import id=%s)",
            day_utc, manifest_hash, previous["id"],
        )
        return result

    if dry_run:
        result["status"] = "dry_run"
        for entry in manifest["tables"]:
            tbl = entry.get("table")
            if tbl in CORE_TABLES_TO_IMPORT:
                result["tables"][tbl] = entry.get("row_count", 0)
        log.info(
            "dry-run snapshot: day=%s manifest_hash=%s would import tables=%s",
            day_utc, manifest_hash, sorted(result["tables"].keys()),
        )
        return result

    # Insert a 'running' row up front so failures are visible in the audit trail.
    cur = conn.execute(
        """
        INSERT INTO core_snapshot_imports (
          imported_at_utc, env_name, snapshot_path, snapshot_day_utc,
          snapshot_manifest_hash, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            fmt_iso(utc_now()), env_name, str(day_dir), day_utc,
            manifest_hash, "running",
            "phase2: importing core tables and rebuilding lookup.",
        ),
    )
    import_id = cur.lastrowid
    conn.commit()

    table_entries_by_name = {e.get("table"): e for e in manifest["tables"]}

    rows_by_table: dict[str, int] = {}
    bytes_total = 0
    try:
        for table in CORE_TABLES_TO_IMPORT:
            entry = table_entries_by_name.get(table)
            if entry is None:
                raise RuntimeError(
                    f"manifest is missing required table '{table}'; cannot import"
                )
            rows, bytes_read = _verify_and_load_table(conn, day_dir, entry, log)
            rows_by_table[table] = rows
            bytes_total += bytes_read

        rows_lookup = _build_lookup(conn, log)

        conn.execute(
            """
            UPDATE core_snapshot_imports SET
              rows_connectors = ?,
              rows_stations = ?,
              rows_timeseries = ?,
              rows_pollutants = ?,
              rows_lookup = ?,
              bytes_read = ?,
              status = 'ok',
              notes = 'phase2: import + lookup rebuild succeeded.'
            WHERE id = ?
            """,
            (
                rows_by_table.get("connectors", 0),
                rows_by_table.get("stations", 0),
                rows_by_table.get("timeseries", 0),
                rows_by_table.get("phenomena", 0),
                rows_lookup,
                bytes_total,
                import_id,
            ),
        )
        conn.commit()

        result["status"] = "imported"
        result["tables"] = rows_by_table
        result["rows_lookup"] = rows_lookup
        result["bytes_read"] = bytes_total
        log.info(
            "snapshot imported: day=%s manifest_hash=%s tables=%s lookup_rows=%s bytes_read=%s",
            day_utc, manifest_hash, rows_by_table, rows_lookup, bytes_total,
        )
        return result
    except Exception as exc:
        conn.rollback()
        try:
            conn.execute(
                """
                UPDATE core_snapshot_imports SET
                  status = 'error',
                  notes = ?
                WHERE id = ?
                """,
                (f"phase2 error: {exc}", import_id),
            )
            conn.commit()
        except Exception:
            pass
        result["status"] = "error"
        result["error"] = str(exc)
        result["bytes_read"] = bytes_total
        result["tables"] = rows_by_table
        log.exception("snapshot import failed: %s", exc)
        raise


# ---------------------------------------------------------------------------
# Phase 3 — OpenAQ adapter (HTTP HEAD/GET, source-cache, event ledger).
# ---------------------------------------------------------------------------

OPENAQ_SOURCE_KEY = "openaq"
OPENAQ_DEFAULT_BASE_URL = "https://openaq-data-archive.s3.amazonaws.com"
OPENAQ_REMOTE_SCHEME = "s3"
OPENAQ_HTTP_TIMEOUT_SECONDS = 30
HTTP_RETRY_ATTEMPTS = 3
HTTP_RETRY_BASE_SECONDS = 0.5
HTTP_RETRY_MAX_SECONDS = 3.0
RETRYABLE_HTTP_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
RETRYABLE_OS_ERRNOS = {54, 60, 104, 110, 111, 10054, 10060}


DEFAULT_CONCURRENCY = 8


# Thread-local SQLite connection pool. ThreadPoolExecutor reuses worker
# threads across tasks; each worker lazily opens its own sqlite3 connection
# the first time it's used. SQLite WAL mode handles concurrent readers and
# serializes writers natively, so no application-level lock is required.
_THREAD_DB = threading.local()


def _worker_db_conn(db_path: str) -> sqlite3.Connection:
    conn = getattr(_THREAD_DB, "conn", None)
    if conn is None:
        conn = sqlite3.connect(db_path, timeout=60)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _THREAD_DB.conn = conn
    return conn


def _copy_db_to_dropbox(
    env: dict[str, str],
    conn: sqlite3.Connection,
    log: logging.Logger,
) -> dict[str, Any]:
    """Copy the working SQLite DB to UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH.

    Runs a `wal_checkpoint(TRUNCATE)` to absorb the WAL into the main file
    first, then atomically replaces the destination via a sibling `.tmp`.
    Safe to call with the connection still open (no writes are in flight
    by this point in the run).

    Returns {"status": "ok"|"skipped"|"error", "src", "dst", "bytes", "error"}.
    """
    result: dict[str, Any] = {
        "status": "skipped",
        "src": env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"],
        "dst": os.environ.get("UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH"),
        "bytes": 0,
        "error": None,
    }
    dst_str = result["dst"]
    if not dst_str:
        result["error"] = "UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH not set"
        log.info("dropbox db copy skipped: %s", result["error"])
        return result

    src_path = Path(result["src"])
    if not src_path.is_file():
        result["status"] = "error"
        result["error"] = f"source DB not found: {src_path}"
        log.warning("dropbox db copy: %s", result["error"])
        return result

    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.Error as exc:
        log.warning("dropbox db copy: wal_checkpoint failed: %s", exc)

    dst_path = Path(dst_str)
    tmp_path = dst_path.with_name(dst_path.name + ".tmp")
    try:
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        if tmp_path.exists():
            tmp_path.unlink()
        shutil.copy2(src_path, tmp_path)
        os.replace(tmp_path, dst_path)
        result["status"] = "ok"
        result["bytes"] = dst_path.stat().st_size
        log.info(
            "dropbox db copied: %s -> %s (%s bytes)",
            src_path, dst_path, result["bytes"],
        )
    except Exception as exc:
        result["status"] = "error"
        result["error"] = str(exc)
        log.warning("dropbox db copy failed: %s", exc)
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
    return result


class LimitTracker:
    """Soft per-run limits: downloaded bytes and runtime minutes.

    Thread-safe. The adapter loops check `should_stop()` before submitting a
    new task and again inside each worker before issuing the request. When a
    limit trips, no new tasks are scheduled and in-flight tasks complete
    naturally; the run records status `stopped_limit`. Limit checks are
    advisory — nothing aborts an in-flight download mid-chunk.
    """

    def __init__(
        self,
        max_download_mb: int | None,
        max_runtime_minutes: int | None,
        started_mono: float,
    ) -> None:
        self.max_bytes: int | None = (
            int(max_download_mb) * 1024 * 1024 if max_download_mb else None
        )
        self.max_seconds: int | None = (
            int(max_runtime_minutes) * 60 if max_runtime_minutes else None
        )
        self.started_mono = started_mono
        self.bytes_downloaded = 0
        self.stopped_for: str | None = None  # "download_mb" | "runtime_minutes"
        self._lock = threading.Lock()

    def add_bytes(self, n: int) -> None:
        with self._lock:
            self.bytes_downloaded += int(n)

    def should_stop(self) -> bool:
        with self._lock:
            if self.stopped_for:
                return True
            if self.max_bytes is not None and self.bytes_downloaded >= self.max_bytes:
                self.stopped_for = "download_mb"
                return True
            if (
                self.max_seconds is not None
                and (time.monotonic() - self.started_mono) >= self.max_seconds
            ):
                self.stopped_for = "runtime_minutes"
                return True
            return False


def _http_head(url: str, timeout: int = OPENAQ_HTTP_TIMEOUT_SECONDS) -> dict[str, Any]:
    """HEAD request. Returns {status, etag, content_length, last_modified}.

    Network errors propagate; 4xx responses return status + (possibly empty)
    headers rather than raising — 404 is a normal outcome for absent files.
    """
    req = urllib.request.Request(url, method="HEAD")
    headers: dict[str, Any] = {}
    status: int | None = None
    for attempt in range(1, HTTP_RETRY_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                headers = dict(resp.headers)
                status = resp.status
            break
        except urllib.error.HTTPError as e:
            if _is_retryable_url_error(e) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("HEAD", url, attempt, e)
                continue
            headers = dict(e.headers or {})
            status = e.code
            break
        except Exception as e:
            if _is_retryable_url_error(e) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("HEAD", url, attempt, e)
                continue
            raise
    if status is None:
        raise RuntimeError(f"HEAD {url} failed with unknown status")

    cl_raw = headers.get("Content-Length")
    try:
        content_length = int(cl_raw) if cl_raw is not None else None
    except (TypeError, ValueError):
        content_length = None

    return {
        "status": status,
        "etag": headers.get("ETag"),
        "content_length": content_length,
        "last_modified": headers.get("Last-Modified"),
    }


def _http_get_to_file(
    url: str,
    dest_path: Path,
    timeout: int = 120,
    chunk_size: int = 65536,
) -> int:
    """Stream GET to dest_path. Returns total bytes written. Raises on non-200
    status or network error. Does NOT cap by size — caller decides whether to
    accept the result based on Content-Length signaled in the HEAD."""
    req = urllib.request.Request(url, method="GET")
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_name(dest_path.name + ".part")
    for attempt in range(1, HTTP_RETRY_ATTEMPTS + 1):
        bytes_written = 0
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"GET {url} returned {resp.status}")
                with tmp_path.open("wb") as fh:
                    while True:
                        chunk = resp.read(chunk_size)
                        if not chunk:
                            break
                        fh.write(chunk)
                        bytes_written += len(chunk)
            os.replace(tmp_path, dest_path)
            return bytes_written
        except Exception as e:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass
            if _is_retryable_url_error(e) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("GET", url, attempt, e)
                continue
            raise
    raise RuntimeError(f"GET {url} failed after retries")


def _is_retryable_url_error(exc: BaseException) -> bool:
    if isinstance(exc, http.client.IncompleteRead):
        return True
    if isinstance(exc, http.client.RemoteDisconnected):
        return True
    if isinstance(exc, urllib.error.HTTPError):
        return int(exc.code) in RETRYABLE_HTTP_STATUS_CODES
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, BaseException):
            return _is_retryable_url_error(reason)
        reason_text = str(reason).lower()
        return (
            "timed out" in reason_text
            or "connection reset by peer" in reason_text
            or "temporarily unavailable" in reason_text
        )
    if isinstance(exc, TimeoutError):
        return True
    if isinstance(exc, ConnectionError):
        return True
    if isinstance(exc, OSError):
        if exc.errno in RETRYABLE_OS_ERRNOS:
            return True
        text = str(exc).lower()
        return "connection reset by peer" in text or "timed out" in text
    return False


def _sleep_http_retry(operation: str, url: str, attempt: int, exc: BaseException) -> None:
    delay = min(HTTP_RETRY_MAX_SECONDS, HTTP_RETRY_BASE_SECONDS * (2 ** (attempt - 1)))
    logging.getLogger(__name__).debug(
        "%s retry %s/%s url=%s delay=%.2fs error=%s",
        operation,
        attempt,
        HTTP_RETRY_ATTEMPTS,
        url,
        delay,
        exc,
    )
    time.sleep(delay)


def _sha256_uncompressed_gzip(path: Path, chunk_size: int = 65536) -> str:
    hasher = hashlib.sha256()
    with gzip.open(path, "rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


# ---------------------------------------------------------------------------
# Phase 6.5 Pass A — per-(source_file, timeseries) row count parsers.
# These parse a freshly-downloaded source file once and return a mapping of
# timeseries_id -> row_count. Caller persists into source_file_timeseries_counts.
# ---------------------------------------------------------------------------

# Sensor.Community CSV measurement columns -> the suffix appended to
# timeseries_ref by uk-aq-ingest (see
# scripts/sensorcommunity/sensorcommunity_backfill_timeseries_phenomena.py).
SC_COLUMN_TO_REF_SUFFIX = {
    "P1": ":pm10",
    "P2": ":pm2.5",
    "temperature": ":temperature",
    "humidity": ":humidity",
    "pressure": ":pressure",
}

UK_AIR_SOS_SOURCE_KEY = "uk_air_sos"
UK_AIR_SOS_DEFAULT_BASE_URL = "https://uk-air.defra.gov.uk/sos-ukair/api/v1"
UK_AIR_SOS_DEFAULT_TIMEOUT_SECONDS = 30
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_ENV = "UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS"
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_ALLOWED = {"none", "changed", "all"}
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_DEFAULT = "changed"
UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES_ENV = (
    "UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES"
)
UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES_DEFAULT = 0

UK_AIR_SOS_STATUS_OK = "ok"
UK_AIR_SOS_STATUS_NO_DATA = "no_data"
UK_AIR_SOS_STATUS_NOT_FOUND = "not_found"
UK_AIR_SOS_STATUS_TEMP_ERROR = "temporary_error"
UK_AIR_SOS_STATUS_PERM_ERROR = "permanent_error"

UkAirSosFetcher = Callable[
    [str, str, str, str, int],
    dict[str, Any],
]


def _iso_utc_seconds(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).strftime(
        "%Y-%m-%dT%H:%M:%SZ",
    )


def _uk_air_sos_day_bounds(day_utc: str) -> tuple[str, str]:
    day = dt.date.fromisoformat(day_utc)
    start = dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc)
    end = start + dt.timedelta(days=1)
    return _iso_utc_seconds(start), _iso_utc_seconds(end)


def _uk_air_sos_parse_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        numeric = float(value)
        ts = numeric * 1000 if abs(numeric) < 1e12 else numeric
        parsed = dt.datetime.fromtimestamp(ts / 1000.0, tz=dt.timezone.utc)
        return _iso_utc_seconds(parsed)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            numeric = float(raw)
        except ValueError:
            numeric = None
        if numeric is not None and math.isfinite(numeric):
            ts = numeric * 1000 if abs(numeric) < 1e12 else numeric
            parsed = dt.datetime.fromtimestamp(ts / 1000.0, tz=dt.timezone.utc)
            return _iso_utc_seconds(parsed)
        candidate = raw[:-1] + "+00:00" if raw.endswith(("Z", "z")) else raw
        try:
            parsed_dt = dt.datetime.fromisoformat(candidate)
        except ValueError:
            return None
        if parsed_dt.tzinfo is None:
            parsed_dt = parsed_dt.replace(tzinfo=dt.timezone.utc)
        return _iso_utc_seconds(parsed_dt)
    return None


def _uk_air_sos_to_finite_number(value: Any) -> int | float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    normalized = float(f"{numeric:.15g}")
    if normalized == 0.0:
        normalized = 0.0
    return int(normalized) if normalized.is_integer() else normalized


def _uk_air_sos_extract_datapoints(payload: Any) -> list[dict[str, Any]]:
    values = payload
    if not isinstance(values, list) and isinstance(values, dict):
        nested = values.get("values") or values.get("data")
        if isinstance(nested, list):
            values = nested
    if not isinstance(values, list):
        return []

    datapoints: list[dict[str, Any]] = []
    for row in values:
        observed_at: str | None = None
        number_value: int | float | None = None
        if isinstance(row, list):
            if len(row) < 2:
                continue
            observed_at = _uk_air_sos_parse_timestamp(row[0])
            number_value = _uk_air_sos_to_finite_number(row[1])
        elif isinstance(row, dict):
            observed_at = _uk_air_sos_parse_timestamp(
                row.get("time")
                or row.get("timestamp")
                or row.get("t")
                or row.get("dateTime")
                or row.get("phenomenonTime")
                or row.get("observed_at"),
            )
            number_value = _uk_air_sos_to_finite_number(
                row.get("value")
                or row.get("v")
                or row.get("result"),
            )
        if not observed_at:
            continue
        datapoints.append({
            "observed_at_utc": observed_at,
            "value": number_value,
        })
    return datapoints


def _uk_air_sos_fetch_timeseries_payload(
    base_url: str,
    day_utc: str,
    timeseries_ref: str,
    timespan: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    url = (
        f"{base_url.rstrip('/')}/timeseries/"
        f"{urllib.parse.quote(timeseries_ref, safe='')}/getData"
        f"?timespan={urllib.parse.quote(timespan, safe=':/')}&format=tvp"
    )
    req = urllib.request.Request(url, method="GET")

    for attempt in range(1, HTTP_RETRY_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                body = resp.read()
                payload = json.loads(body.decode("utf-8"))
                return {
                    "status": UK_AIR_SOS_STATUS_OK,
                    "payload": payload,
                    "error": None,
                    "http_status": int(resp.status),
                }
        except urllib.error.HTTPError as exc:
            if int(exc.code) == 404:
                return {
                    "status": UK_AIR_SOS_STATUS_NOT_FOUND,
                    "payload": None,
                    "error": f"HTTP 404 for timeseries_ref={timeseries_ref}",
                    "http_status": int(exc.code),
                }
            if _is_retryable_url_error(exc):
                if attempt < HTTP_RETRY_ATTEMPTS:
                    _sleep_http_retry("GET", url, attempt, exc)
                    continue
                return {
                    "status": UK_AIR_SOS_STATUS_TEMP_ERROR,
                    "payload": None,
                    "error": f"HTTP {exc.code} for timeseries_ref={timeseries_ref}",
                    "http_status": int(exc.code),
                }
            return {
                "status": UK_AIR_SOS_STATUS_PERM_ERROR,
                "payload": None,
                "error": f"HTTP {exc.code} for timeseries_ref={timeseries_ref}",
                "http_status": int(exc.code),
            }
        except json.JSONDecodeError as exc:
            return {
                "status": UK_AIR_SOS_STATUS_PERM_ERROR,
                "payload": None,
                "error": f"invalid JSON for timeseries_ref={timeseries_ref}: {exc}",
                "http_status": None,
            }
        except Exception as exc:
            if _is_retryable_url_error(exc):
                if attempt < HTTP_RETRY_ATTEMPTS:
                    _sleep_http_retry("GET", url, attempt, exc)
                    continue
                return {
                    "status": UK_AIR_SOS_STATUS_TEMP_ERROR,
                    "payload": None,
                    "error": f"temporary fetch failure for timeseries_ref={timeseries_ref}: {exc}",
                    "http_status": None,
                }
            return {
                "status": UK_AIR_SOS_STATUS_PERM_ERROR,
                "payload": None,
                "error": f"non-retryable fetch failure for timeseries_ref={timeseries_ref}: {exc}",
                "http_status": None,
            }

    return {
        "status": UK_AIR_SOS_STATUS_TEMP_ERROR,
        "payload": None,
        "error": f"timeseries_ref={timeseries_ref}: exhausted retries",
        "http_status": None,
    }


def build_uk_air_sos_canonical_snapshot(
    *,
    station_ref: str,
    day_utc: str,
    timeseries_bindings: Iterable[dict[str, Any]],
    base_url: str | None = None,
    timeout_seconds: int = UK_AIR_SOS_DEFAULT_TIMEOUT_SECONDS,
    fetcher: UkAirSosFetcher | None = None,
) -> dict[str, Any]:
    """Build canonical SOS snapshot rows for one station/day.

    Output rows are sorted by (timeseries_id, observed_at_utc) and encoded as
    stable NDJSON bytes with the minimal canonical row shape.
    """
    source_base_url = (
        (base_url or os.environ.get("UK_AQ_BACKFILL_UK_AIR_SOS_BASE_URL") or "")
        .strip()
        or UK_AIR_SOS_DEFAULT_BASE_URL
    )
    fetch_fn = fetcher or _uk_air_sos_fetch_timeseries_payload
    day_start_iso, day_end_iso = _uk_air_sos_day_bounds(day_utc)
    timespan = f"{day_start_iso}/{day_end_iso}"

    binding_rows = []
    for raw in timeseries_bindings:
        ts_id = _row_get_int(raw, "timeseries_id")
        ts_ref = _row_get_str(raw, "timeseries_ref")
        if ts_id is None or ts_id <= 0 or not ts_ref:
            continue
        binding_rows.append({"timeseries_id": ts_id, "timeseries_ref": ts_ref})
    binding_rows.sort(key=lambda row: (int(row["timeseries_id"]), str(row["timeseries_ref"])))

    rows: list[dict[str, Any]] = []
    timeseries_results: list[dict[str, Any]] = []
    for binding in binding_rows:
        ts_id = int(binding["timeseries_id"])
        ts_ref = str(binding["timeseries_ref"])
        fetched = fetch_fn(
            source_base_url,
            day_utc,
            ts_ref,
            timespan,
            int(timeout_seconds),
        )
        status = str(fetched.get("status") or UK_AIR_SOS_STATUS_PERM_ERROR)
        result_row: dict[str, Any] = {
            "timeseries_id": ts_id,
            "timeseries_ref": ts_ref,
            "status": status,
            "row_count": 0,
            "error": fetched.get("error"),
        }
        if status != UK_AIR_SOS_STATUS_OK:
            timeseries_results.append(result_row)
            continue

        datapoints = _uk_air_sos_extract_datapoints(fetched.get("payload"))
        for point in datapoints:
            observed_at = str(point.get("observed_at_utc") or "")
            value = point.get("value")
            if not observed_at:
                continue
            if observed_at < day_start_iso or observed_at >= day_end_iso:
                continue
            if value is None:
                continue
            rows.append({
                "station_ref": station_ref,
                "timeseries_id": ts_id,
                "timeseries_ref": ts_ref,
                "observed_at_utc": observed_at,
                "value": value,
            })
            result_row["row_count"] = int(result_row["row_count"]) + 1
        if int(result_row["row_count"]) == 0:
            result_row["status"] = UK_AIR_SOS_STATUS_NO_DATA
        timeseries_results.append(result_row)

    status_list = [str(item.get("status") or "") for item in timeseries_results]
    if any(status == UK_AIR_SOS_STATUS_TEMP_ERROR for status in status_list):
        final_status = UK_AIR_SOS_STATUS_TEMP_ERROR
    elif any(status == UK_AIR_SOS_STATUS_PERM_ERROR for status in status_list):
        final_status = UK_AIR_SOS_STATUS_PERM_ERROR
    elif status_list and all(status == UK_AIR_SOS_STATUS_NOT_FOUND for status in status_list):
        final_status = UK_AIR_SOS_STATUS_NOT_FOUND
    elif rows:
        final_status = UK_AIR_SOS_STATUS_OK
    else:
        final_status = UK_AIR_SOS_STATUS_NO_DATA

    if final_status in (UK_AIR_SOS_STATUS_TEMP_ERROR, UK_AIR_SOS_STATUS_PERM_ERROR):
        return {
            "status": final_status,
            "station_ref": station_ref,
            "day_utc": day_utc,
            "base_url": source_base_url,
            "timespan": timespan,
            "rows": [],
            "row_count": 0,
            "ndjson_bytes": b"",
            "sha256": None,
            "timeseries_results": timeseries_results,
            "error": "; ".join(
                str(item.get("error"))
                for item in timeseries_results
                if item.get("error")
            ) or None,
        }

    rows.sort(key=lambda row: (int(row["timeseries_id"]), str(row["observed_at_utc"])))
    ndjson_text = "".join(
        json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n"
        for row in rows
    )
    ndjson_bytes = ndjson_text.encode("utf-8")
    return {
        "status": final_status,
        "station_ref": station_ref,
        "day_utc": day_utc,
        "base_url": source_base_url,
        "timespan": timespan,
        "rows": rows,
        "row_count": len(rows),
        "ndjson_bytes": ndjson_bytes,
        "sha256": hashlib.sha256(ndjson_bytes).hexdigest(),
        "timeseries_results": timeseries_results,
        "error": None,
    }


def _resolve_keep_api_snapshots_policy() -> str:
    raw = str(
        os.environ.get(
            UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_ENV,
            UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_DEFAULT,
        ),
    ).strip().lower()
    if raw in UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_ALLOWED:
        return raw
    return UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_DEFAULT


def _resolve_uk_air_sos_not_found_cooldown_seconds() -> int:
    raw = str(
        os.environ.get(
            UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES_ENV,
            UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES_DEFAULT,
        ),
    ).strip()
    try:
        minutes = int(raw)
    except (TypeError, ValueError):
        minutes = UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES_DEFAULT
    if minutes <= 0:
        return 0
    return minutes * 60


def _parse_iso_utc(value: str | None) -> dt.datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    candidate = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = dt.datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _uk_air_sos_source_file_key(station_ref: str, day: dt.date) -> str:
    return f"uk_air_sos:station_ref={station_ref}:day_utc={day.isoformat()}"


def _uk_air_sos_cache_path(cache_root: Path, station_ref: str, day: dt.date) -> Path:
    station_token = urllib.parse.quote(station_ref, safe="._-")
    return (
        cache_root
        / f"station_ref={station_token}"
        / f"day_utc={day.isoformat()}"
        / "snapshot.ndjson"
    )


def _uk_air_sos_remote_key(base_url: str, station_ref: str, day: dt.date) -> str:
    station_token = urllib.parse.quote(station_ref, safe="")
    return (
        f"{base_url.rstrip('/')}/station_ref={station_token}/day_utc={day.isoformat()}"
    )


def _uk_air_sos_station_bindings(
    conn: sqlite3.Connection,
) -> dict[str, list[dict[str, Any]]]:
    rows = conn.execute(
        """
        SELECT
          l.source_location_id,
          l.station_ref,
          l.station_id,
          l.connector_id,
          l.timeseries_id,
          t.timeseries_ref
        FROM source_station_timeseries_lookup l
        JOIN core_timeseries_snapshot t ON t.id = l.timeseries_id
        WHERE l.source_key = ?
          AND l.is_active = 1
          AND l.station_ref IS NOT NULL
          AND l.station_ref != ''
          AND t.timeseries_ref IS NOT NULL
          AND t.timeseries_ref != ''
        ORDER BY l.station_ref, l.timeseries_id
        """,
        (UK_AIR_SOS_SOURCE_KEY,),
    ).fetchall()
    out: dict[str, list[dict[str, Any]]] = {}
    for source_location_id, station_ref, station_id, connector_id, timeseries_id, timeseries_ref in rows:
        station = str(station_ref or "").strip()
        if not station:
            continue
        out.setdefault(station, []).append({
            "source_location_id": str(source_location_id or station),
            "station_ref": station,
            "station_id": int(station_id),
            "connector_id": int(connector_id),
            "timeseries_id": int(timeseries_id),
            "timeseries_ref": str(timeseries_ref),
        })
    return out


def _openaq_parse_per_timeseries_counts(
    csv_gz_path: Path,
) -> dict[str, int]:
    """OpenAQ CSV (gzipped). Each row carries a `sensors_id` column whose
    value equals the corresponding `timeseries_ref` in the core snapshot.
    Returns {timeseries_ref: row_count}."""
    import csv
    counts: dict[str, int] = {}
    with gzip.open(csv_gz_path, "rt", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        sensor_col = None
        for candidate in ("sensors_id", "sensor_id"):
            if reader.fieldnames and candidate in reader.fieldnames:
                sensor_col = candidate
                break
        if sensor_col is None:
            return counts
        for row in reader:
            ref = (row.get(sensor_col) or "").strip()
            if not ref:
                continue
            counts[ref] = counts.get(ref, 0) + 1
    return counts


def _sc_parse_per_timeseries_counts(
    csv_path: Path,
    sensor_id: str,
) -> dict[str, int]:
    """Sensor.Community CSV (plain, ';'-delimited). For each row, each known
    measurement column contributes 1 to its mapped timeseries when the cell
    is non-empty. The timeseries_ref is the sensor_id with the column's
    pollutant suffix appended.

    Returns {timeseries_ref: row_count}.
    """
    import csv
    counts: dict[str, int] = {}
    with csv_path.open("rt", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh, delimiter=";")
        if not reader.fieldnames:
            return counts
        measurement_cols = [c for c in reader.fieldnames if c in SC_COLUMN_TO_REF_SUFFIX]
        if not measurement_cols:
            return counts
        for row in reader:
            for col in measurement_cols:
                cell = row.get(col)
                if cell is None:
                    continue
                cell_s = cell.strip() if isinstance(cell, str) else ""
                if cell_s == "":
                    continue
                ref = f"{sensor_id}{SC_COLUMN_TO_REF_SUFFIX[col]}"
                counts[ref] = counts.get(ref, 0) + 1
    return counts


def _resolve_ts_refs_to_ids(
    conn: sqlite3.Connection,
    source_key: str,
    refs: Iterable[str],
) -> dict[str, int]:
    """Look up timeseries_id for a set of timeseries_refs scoped to the
    connector that owns this source. Returns {ref: timeseries_id}; refs
    with no matching row are absent (caller decides how to log)."""
    refs_list = sorted({str(r) for r in refs if r})
    if not refs_list:
        return {}
    connector_code = next(
        (code for code, sk in SOURCE_KEY_BY_CONNECTOR_CODE.items() if sk == source_key),
        None,
    )
    if connector_code is None:
        return {}
    placeholders = ",".join("?" for _ in refs_list)
    out: dict[str, int] = {}
    rows = conn.execute(
        f"""
        SELECT t.timeseries_ref, t.id
        FROM core_timeseries_snapshot t
        JOIN core_connectors_snapshot c ON c.id = t.connector_id
        WHERE c.connector_code = ?
          AND t.timeseries_ref IN ({placeholders})
        """,
        (connector_code, *refs_list),
    ).fetchall()
    for ref, ts_id in rows:
        out[str(ref)] = int(ts_id)
    return out


def _record_source_file_timeseries_counts(
    conn: sqlite3.Connection,
    source_file_key: str,
    counts_by_ts_id: dict[int, int],
    now_iso: str,
) -> None:
    """Replace the (source_file_key, *) rows in source_file_timeseries_counts."""
    conn.execute(
        "DELETE FROM source_file_timeseries_counts WHERE source_file_key = ?",
        (source_file_key,),
    )
    if not counts_by_ts_id:
        return
    conn.executemany(
        """
        INSERT INTO source_file_timeseries_counts
          (source_file_key, timeseries_id, row_count, counted_at_utc)
        VALUES (?, ?, ?, ?)
        """,
        [
            (source_file_key, ts_id, count, now_iso)
            for ts_id, count in sorted(counts_by_ts_id.items())
        ],
    )


def _openaq_object_key(location_id: str, day: dt.date) -> str:
    return (
        f"records/csv.gz/locationid={location_id}/year={day.year}"
        f"/month={day.month:02d}/location-{location_id}-{day.strftime('%Y%m%d')}.csv.gz"
    )


def _openaq_url(base_url: str, location_id: str, day: dt.date) -> str:
    return f"{base_url.rstrip('/')}/{_openaq_object_key(location_id, day)}"


def _openaq_source_file_key(location_id: str, day: dt.date) -> str:
    return f"openaq:{location_id}:{day.isoformat()}"


def _openaq_cache_path(cache_root: Path, location_id: str, day: dt.date) -> Path:
    return (
        cache_root
        / f"locationid={location_id}"
        / f"year={day.year}"
        / f"month={day.month:02d}"
        / f"location-{location_id}-{day.strftime('%Y%m%d')}.csv.gz"
    )


def _openaq_distinct_locations(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT source_location_id
        FROM source_station_timeseries_lookup
        WHERE source_key = ?
        ORDER BY source_location_id
        """,
        (OPENAQ_SOURCE_KEY,),
    ).fetchall()
    return [r[0] for r in rows]


def _lookup_timeseries_for_location(
    conn: sqlite3.Connection, location_id: str
) -> list[int]:
    rows = conn.execute(
        """
        SELECT timeseries_id
        FROM source_station_timeseries_lookup
        WHERE source_key = ? AND source_location_id = ?
        ORDER BY timeseries_id
        """,
        (OPENAQ_SOURCE_KEY, location_id),
    ).fetchall()
    return [int(r[0]) for r in rows]


def _date_range_inclusive(from_day: str, to_day: str) -> list[dt.date]:
    start = dt.date.fromisoformat(from_day)
    end = dt.date.fromisoformat(to_day)
    if end < start:
        return []
    out: list[dt.date] = []
    d = start
    while d <= end:
        out.append(d)
        d += dt.timedelta(days=1)
    return out


def _upsert_state(
    conn: sqlite3.Connection,
    *,
    source_file_key: str,
    env_name: str,
    remote_url: str,
    location_id: str,
    day: dt.date,
    head: dict[str, Any],
    exists_remote: bool,
    sha256_downloaded: str | None,
    sha256_uncompressed: str | None,
    local_cached_path: str | None,
    now_iso: str,
    last_changed_at: str | None,
    last_status: str,
) -> None:
    """Insert or update source_file_state. Preserves first_seen_at_utc on
    update and only advances last_changed_at_utc when caller passes a value
    (None means 'keep prior value')."""
    cur = conn.execute(
        "SELECT first_seen_at_utc, last_changed_at_utc FROM source_file_state WHERE source_file_key = ?",
        (source_file_key,),
    )
    row = cur.fetchone()
    if row is None:
        first_seen = now_iso
        carried_changed = last_changed_at
    else:
        first_seen = row[0] or now_iso
        carried_changed = last_changed_at if last_changed_at is not None else row[1]

    conn.execute(
        """
        INSERT INTO source_file_state (
          source_file_key, env_name, source_key, remote_scheme,
          remote_url_or_key, station_ref, source_location_id, day_utc,
          date_range_start_utc, date_range_end_utc,
          exists_remote, content_length, etag, last_modified_utc,
          sha256_downloaded, sha256_uncompressed,
          local_cached_path,
          first_seen_at_utc, last_checked_at_utc, last_changed_at_utc,
          last_status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_file_key) DO UPDATE SET
          env_name = excluded.env_name,
          remote_url_or_key = excluded.remote_url_or_key,
          source_location_id = excluded.source_location_id,
          day_utc = excluded.day_utc,
          exists_remote = excluded.exists_remote,
          content_length = excluded.content_length,
          etag = excluded.etag,
          last_modified_utc = excluded.last_modified_utc,
          sha256_downloaded = COALESCE(excluded.sha256_downloaded, source_file_state.sha256_downloaded),
          sha256_uncompressed = COALESCE(excluded.sha256_uncompressed, source_file_state.sha256_uncompressed),
          local_cached_path = excluded.local_cached_path,
          last_checked_at_utc = excluded.last_checked_at_utc,
          last_changed_at_utc = excluded.last_changed_at_utc,
          last_status = excluded.last_status
        """,
        (
            source_file_key, env_name, OPENAQ_SOURCE_KEY, OPENAQ_REMOTE_SCHEME,
            remote_url, location_id, location_id, day.isoformat(),
            None, None,
            1 if exists_remote else 0, head.get("content_length"), head.get("etag"),
            head.get("last_modified"),
            sha256_downloaded, sha256_uncompressed,
            local_cached_path,
            first_seen, now_iso, carried_changed,
            last_status, None,
        ),
    )


def _upsert_source_state(
    conn: sqlite3.Connection,
    *,
    source_key: str,
    remote_scheme: str,
    source_file_key: str,
    env_name: str,
    remote_url_or_key: str,
    station_ref: str | None,
    source_location_id: str | None,
    day: dt.date,
    exists_remote: bool,
    content_length: int | None,
    etag: str | None,
    last_modified_utc: str | None,
    sha256_downloaded: str | None,
    sha256_uncompressed: str | None,
    local_cached_path: str | None,
    now_iso: str,
    last_changed_at: str | None,
    last_status: str,
    notes: str | None = None,
) -> None:
    """Generic source_file_state upsert for non-OpenAQ sources."""
    cur = conn.execute(
        "SELECT first_seen_at_utc, last_changed_at_utc FROM source_file_state WHERE source_file_key = ?",
        (source_file_key,),
    )
    row = cur.fetchone()
    if row is None:
        first_seen = now_iso
        carried_changed = last_changed_at
    else:
        first_seen = row[0] or now_iso
        carried_changed = last_changed_at if last_changed_at is not None else row[1]

    conn.execute(
        """
        INSERT INTO source_file_state (
          source_file_key, env_name, source_key, remote_scheme,
          remote_url_or_key, station_ref, source_location_id, day_utc,
          date_range_start_utc, date_range_end_utc,
          exists_remote, content_length, etag, last_modified_utc,
          sha256_downloaded, sha256_uncompressed,
          local_cached_path,
          first_seen_at_utc, last_checked_at_utc, last_changed_at_utc,
          last_status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_file_key) DO UPDATE SET
          env_name = excluded.env_name,
          source_key = excluded.source_key,
          remote_scheme = excluded.remote_scheme,
          remote_url_or_key = excluded.remote_url_or_key,
          station_ref = excluded.station_ref,
          source_location_id = excluded.source_location_id,
          day_utc = excluded.day_utc,
          exists_remote = excluded.exists_remote,
          content_length = excluded.content_length,
          etag = excluded.etag,
          last_modified_utc = excluded.last_modified_utc,
          sha256_downloaded = COALESCE(excluded.sha256_downloaded, source_file_state.sha256_downloaded),
          sha256_uncompressed = COALESCE(excluded.sha256_uncompressed, source_file_state.sha256_uncompressed),
          local_cached_path = excluded.local_cached_path,
          last_checked_at_utc = excluded.last_checked_at_utc,
          last_changed_at_utc = excluded.last_changed_at_utc,
          last_status = excluded.last_status,
          notes = excluded.notes
        """,
        (
            source_file_key, env_name, source_key, remote_scheme,
            remote_url_or_key, station_ref, source_location_id, day.isoformat(),
            None, None,
            1 if exists_remote else 0, content_length, etag, last_modified_utc,
            sha256_downloaded, sha256_uncompressed,
            local_cached_path,
            first_seen, now_iso, carried_changed,
            last_status, notes,
        ),
    )


def _mark_source_state_fetch_error(
    conn: sqlite3.Connection,
    *,
    source_file_key: str,
    status: str,
    now_iso: str,
) -> None:
    """Record a fetch error without overwriting baseline hashes/content."""
    conn.execute(
        """
        UPDATE source_file_state
        SET last_checked_at_utc = ?, last_status = ?
        WHERE source_file_key = ?
        """,
        (now_iso, status, source_file_key),
    )


def _insert_event(
    conn: sqlite3.Connection,
    *,
    event_type: str,
    env_name: str,
    source_file_key: str,
    remote_url: str,
    location_id: str,
    day: dt.date,
    prior: dict[str, Any] | None,
    head: dict[str, Any],
    new_sha_downloaded: str | None,
    new_sha_uncompressed: str | None,
    downloaded_bytes: int,
    hash_runtime_ms: int,
    now_iso: str,
    notes: str | None = None,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO source_file_events (
          event_at_utc, env_name, source_key, event_type,
          source_file_key, remote_url_or_key,
          station_ref, source_location_id, day_utc,
          old_content_length, new_content_length,
          old_etag, new_etag,
          old_last_modified_utc, new_last_modified_utc,
          old_sha256_downloaded, new_sha256_downloaded,
          old_sha256_uncompressed, new_sha256_uncompressed,
          downloaded_bytes, hash_runtime_ms,
          backfill_triggered, backfill_timeseries_ids, backfill_status,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            now_iso, env_name, OPENAQ_SOURCE_KEY, event_type,
            source_file_key, remote_url,
            location_id, location_id, day.isoformat(),
            (prior or {}).get("content_length"), head.get("content_length"),
            (prior or {}).get("etag"), head.get("etag"),
            (prior or {}).get("last_modified_utc"), head.get("last_modified"),
            (prior or {}).get("sha256_downloaded"), new_sha_downloaded,
            (prior or {}).get("sha256_uncompressed"), new_sha_uncompressed,
            downloaded_bytes, hash_runtime_ms,
            0, None, None,
            notes,
        ),
    )
    return int(cur.lastrowid)


def _insert_source_event(
    conn: sqlite3.Connection,
    *,
    source_key: str,
    event_type: str,
    env_name: str,
    source_file_key: str,
    remote_url_or_key: str,
    station_ref: str | None,
    source_location_id: str | None,
    day: dt.date,
    prior: dict[str, Any] | None,
    new_content_length: int | None,
    new_etag: str | None,
    new_last_modified_utc: str | None,
    new_sha256_downloaded: str | None,
    new_sha256_uncompressed: str | None,
    downloaded_bytes: int,
    hash_runtime_ms: int,
    now_iso: str,
    notes: str | None = None,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO source_file_events (
          event_at_utc, env_name, source_key, event_type,
          source_file_key, remote_url_or_key,
          station_ref, source_location_id, day_utc,
          old_content_length, new_content_length,
          old_etag, new_etag,
          old_last_modified_utc, new_last_modified_utc,
          old_sha256_downloaded, new_sha256_downloaded,
          old_sha256_uncompressed, new_sha256_uncompressed,
          downloaded_bytes, hash_runtime_ms,
          backfill_triggered, backfill_timeseries_ids, backfill_status,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            now_iso, env_name, source_key, event_type,
            source_file_key, remote_url_or_key,
            station_ref, source_location_id, day.isoformat(),
            (prior or {}).get("content_length"), new_content_length,
            (prior or {}).get("etag"), new_etag,
            (prior or {}).get("last_modified_utc"), new_last_modified_utc,
            (prior or {}).get("sha256_downloaded"), new_sha256_downloaded,
            (prior or {}).get("sha256_uncompressed"), new_sha256_uncompressed,
            downloaded_bytes, hash_runtime_ms,
            0, None, None,
            notes,
        ),
    )
    return int(cur.lastrowid)


def _fetch_prior_state(
    conn: sqlite3.Connection, source_file_key: str
) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT exists_remote, content_length, etag, last_modified_utc,
               sha256_downloaded, sha256_uncompressed, last_status, local_cached_path,
               last_checked_at_utc
        FROM source_file_state
        WHERE source_file_key = ?
        """,
        (source_file_key,),
    ).fetchone()
    if row is None:
        return None
    return {
        "exists_remote": int(row[0]) if row[0] is not None else None,
        "content_length": row[1],
        "etag": row[2],
        "last_modified_utc": row[3],
        "sha256_downloaded": row[4],
        "sha256_uncompressed": row[5],
        "last_status": row[6],
        "local_cached_path": row[7],
        "last_checked_at_utc": row[8],
    }


def _metadata_changed(prior: dict[str, Any], head: dict[str, Any]) -> bool:
    return (
        prior.get("etag") != head.get("etag")
        or prior.get("content_length") != head.get("content_length")
        or prior.get("last_modified_utc") != head.get("last_modified")
    )


def _check_one_openaq_file_threadsafe(
    db_path: str,
    env_name: str,
    base_url: str,
    location_id: str,
    day: dt.date,
    tmp_dir: Path,
    cache_root: Path,
    log: logging.Logger,
    limits: LimitTracker | None = None,
) -> dict[str, Any]:
    """Worker entrypoint: opens a thread-local connection, calls the inner
    function, commits, and enriches the result with location_id + day so the
    main thread can correlate completions in any order."""
    if limits is not None and limits.should_stop():
        return {
            "outcome": "stopped",
            "location_id": location_id,
            "day": day.isoformat(),
            "downloaded_bytes": 0,
            "event_id": None,
            "event_type": None,
            "timeseries_ids": [],
        }
    conn = _worker_db_conn(db_path)
    try:
        result = _check_one_openaq_file(
            conn, env_name, base_url, location_id, day, tmp_dir, cache_root, log,
        )
    finally:
        try:
            conn.commit()
        except sqlite3.Error:
            pass
    result["location_id"] = location_id
    result["day"] = day.isoformat()
    return result


def _check_one_openaq_file(
    conn: sqlite3.Connection,
    env_name: str,
    base_url: str,
    location_id: str,
    day: dt.date,
    tmp_dir: Path,
    cache_root: Path,
    log: logging.Logger,
) -> dict[str, Any]:
    """Run HEAD + (optional) download + hash for a single OpenAQ file."""
    url = _openaq_url(base_url, location_id, day)
    sfk = _openaq_source_file_key(location_id, day)
    now_iso = fmt_iso(utc_now())

    head = _http_head(url)
    prior = _fetch_prior_state(conn, sfk)
    timeseries_ids = _lookup_timeseries_for_location(conn, location_id)

    # ---- 404 path
    if head["status"] == 404:
        if prior is None:
            _upsert_state(
                conn, source_file_key=sfk, env_name=env_name, remote_url=url,
                location_id=location_id, day=day,
                head={"etag": None, "content_length": None, "last_modified": None},
                exists_remote=False,
                sha256_downloaded=None, sha256_uncompressed=None,
                local_cached_path=None,
                now_iso=now_iso, last_changed_at=None,
                last_status="missing",
            )
            event_id = _insert_event(
                conn, event_type="first_seen_missing", env_name=env_name,
                source_file_key=sfk, remote_url=url,
                location_id=location_id, day=day,
                prior=None, head={**head, "last_modified": None},
                new_sha_downloaded=None, new_sha_uncompressed=None,
                downloaded_bytes=0, hash_runtime_ms=0, now_iso=now_iso,
            )
            return {
                "outcome": "missing_first_seen", "downloaded_bytes": 0,
                "event_id": event_id, "event_type": "first_seen_missing",
                "timeseries_ids": timeseries_ids,
            }
        if prior["exists_remote"] == 1:
            _upsert_state(
                conn, source_file_key=sfk, env_name=env_name, remote_url=url,
                location_id=location_id, day=day,
                head={"etag": None, "content_length": None, "last_modified": None},
                exists_remote=False,
                sha256_downloaded=None, sha256_uncompressed=None,
                local_cached_path=None,
                now_iso=now_iso, last_changed_at=now_iso,
                last_status="missing",
            )
            event_id = _insert_event(
                conn, event_type="disappeared", env_name=env_name,
                source_file_key=sfk, remote_url=url,
                location_id=location_id, day=day,
                prior=prior, head={**head, "last_modified": None},
                new_sha_downloaded=None, new_sha_uncompressed=None,
                downloaded_bytes=0, hash_runtime_ms=0, now_iso=now_iso,
            )
            return {
                "outcome": "missing_disappeared", "downloaded_bytes": 0,
                "event_id": event_id, "event_type": "disappeared",
                "timeseries_ids": timeseries_ids,
            }
        # was already missing; just update last_checked
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=location_id, day=day,
            head={"etag": None, "content_length": None, "last_modified": None},
            exists_remote=False,
            sha256_downloaded=None, sha256_uncompressed=None,
            local_cached_path=None,
            now_iso=now_iso, last_changed_at=None,
            last_status="missing",
        )
        return {
            "outcome": "still_missing", "downloaded_bytes": 0,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    # ---- non-200 / non-404
    if head["status"] != 200:
        raise RuntimeError(f"HEAD {url} returned {head['status']}")

    # ---- 200 path: decide whether to download
    is_first_seen = prior is None
    was_missing = prior is not None and prior["exists_remote"] == 0
    needs_download = (
        is_first_seen
        or was_missing
        or _metadata_changed(prior, head)
    )

    if not needs_download:
        # metadata identical; no download, no event
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=location_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=prior["sha256_downloaded"],
            sha256_uncompressed=prior["sha256_uncompressed"],
            local_cached_path=None,
            now_iso=now_iso, last_changed_at=None,
            last_status="unchanged",
        )
        return {
            "outcome": "unchanged_metadata", "downloaded_bytes": 0,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    # Download + hash
    tmp_path = tmp_dir / f"openaq-{location_id}-{day.strftime('%Y%m%d')}.csv.gz"
    if tmp_path.exists():
        tmp_path.unlink()
    bytes_downloaded = _http_get_to_file(url, tmp_path)
    sha_compressed, _ = sha256_of_file(tmp_path)
    hash_start = time.monotonic()
    sha_uncompressed = _sha256_uncompressed_gzip(tmp_path)
    hash_runtime_ms = int((time.monotonic() - hash_start) * 1000)

    content_changed = (
        prior is None
        or prior.get("sha256_uncompressed") is None
        or prior["sha256_uncompressed"] != sha_uncompressed
    )
    # State change is broader than content change: a file going from missing
    # back to present is a transition worth recording even if the bytes match
    # what we had before it disappeared.
    state_changed = is_first_seen or was_missing or content_changed

    if not state_changed:
        # Downloaded only because metadata differed; content hash matches
        # prior. Discard temp; no event.
        tmp_path.unlink(missing_ok=True)
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=location_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=sha_compressed,
            sha256_uncompressed=sha_uncompressed,
            local_cached_path=None,
            now_iso=now_iso, last_changed_at=None,
            last_status="unchanged",
        )
        return {
            "outcome": "unchanged_content", "downloaded_bytes": bytes_downloaded,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    # State changed: first_seen, reappeared, or content changed (or all).
    # Cache the file regardless; reappeared-with-same-content still counts
    # as a state transition that may need a backfill.
    event_type = (
        "first_seen" if is_first_seen
        else "reappeared" if was_missing
        else "changed"
    )
    cache_path = _openaq_cache_path(cache_root, location_id, day)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.exists():
        cache_path.unlink()
    shutil.move(str(tmp_path), str(cache_path))

    # Phase 6.5 Pass A: parse the just-cached CSV once and record per-
    # timeseries row counts. We do this before _insert_event so a single
    # transaction (committed by the threadsafe wrapper) covers both.
    try:
        ref_counts = _openaq_parse_per_timeseries_counts(cache_path)
        ref_to_id = _resolve_ts_refs_to_ids(conn, OPENAQ_SOURCE_KEY, ref_counts.keys())
        counts_by_id: dict[int, int] = {}
        unmatched: list[str] = []
        for ref, n in ref_counts.items():
            ts_id = ref_to_id.get(ref)
            if ts_id is None:
                unmatched.append(ref)
                continue
            counts_by_id[ts_id] = counts_by_id.get(ts_id, 0) + n
        _record_source_file_timeseries_counts(conn, sfk, counts_by_id, now_iso)
        if unmatched:
            log.info(
                "openaq counts: loc=%s day=%s %d ref(s) unmatched in core (e.g. %s)",
                location_id, day.isoformat(), len(unmatched), unmatched[0],
            )
    except Exception as exc:
        log.warning(
            "openaq counts: parse failed loc=%s day=%s: %s",
            location_id, day.isoformat(), exc,
        )

    _upsert_state(
        conn, source_file_key=sfk, env_name=env_name, remote_url=url,
        location_id=location_id, day=day,
        head=head, exists_remote=True,
        sha256_downloaded=sha_compressed,
        sha256_uncompressed=sha_uncompressed,
        local_cached_path=str(cache_path),
        now_iso=now_iso, last_changed_at=now_iso,
        last_status=event_type,
    )
    event_id = _insert_event(
        conn, event_type=event_type, env_name=env_name,
        source_file_key=sfk, remote_url=url,
        location_id=location_id, day=day,
        prior=prior, head=head,
        new_sha_downloaded=sha_compressed, new_sha_uncompressed=sha_uncompressed,
        downloaded_bytes=bytes_downloaded, hash_runtime_ms=hash_runtime_ms,
        now_iso=now_iso,
        notes=("content unchanged from prior version (state-only transition)"
               if not content_changed else None),
    )
    log.info(
        "openaq %s loc=%s day=%s sha=%s..%s bytes=%s",
        event_type, location_id, day.isoformat(),
        sha_uncompressed[:8], sha_uncompressed[-4:], bytes_downloaded,
    )
    return {
        "outcome": event_type,
        "downloaded_bytes": bytes_downloaded,
        "event_id": event_id, "event_type": event_type,
        "timeseries_ids": timeseries_ids,
    }


def _planned_backfill_command(
    env: dict[str, str],
    timeseries_ids: list[int],
    day: dt.date,
    connector_ids: list[int] | None = None,
    output_scope: str | None = None,
) -> str:
    wrapper_raw = resolve_integrity_backfill_wrapper()
    env_file = str(
        env.get("UK_AQ_BACKFILL_ENV_FILE")
        or os.environ.get("UK_AQ_BACKFILL_ENV_FILE")
        or "<UK_AQ_BACKFILL_ENV_FILE unset>"
    ).strip()
    wrapper = wrapper_raw or "<integrity backfill wrapper unset>"
    connector_csv = ",".join(str(c) for c in (connector_ids or []) if int(c) > 0)
    ids_csv = ",".join(str(t) for t in timeseries_ids)
    iso = day.isoformat()
    return (
        f"UK_AQ_BACKFILL_RUN_MODE=source_to_r2 "
        f"UK_AQ_BACKFILL_DRY_RUN=false "
        f"UK_AQ_BACKFILL_FORCE_REPLACE=true "
        f"{f'UK_AQ_BACKFILL_OUTPUT_SCOPE={output_scope} ' if output_scope else ''}"
        f"{f'UK_AQ_BACKFILL_CONNECTOR_IDS={connector_csv} ' if connector_csv else ''}"
        f"UK_AQ_BACKFILL_TIMESERIES_IDS={ids_csv} "
        f"UK_AQ_BACKFILL_FROM_DAY_UTC={iso} "
        f"UK_AQ_BACKFILL_TO_DAY_UTC={iso} "
        f"UK_AQ_BACKFILL_ENV_FILE={env_file} "
        f"{wrapper}"
    )


# ---------------------------------------------------------------------------
# Phase 4 (Pass 1) — narrow backfill execution.
# ---------------------------------------------------------------------------

# Per-backfill safety timeout. A real source_to_r2 month can take a few
# minutes; we cap a single-day call generously.
BACKFILL_DEFAULT_TIMEOUT_SECONDS = 1800
BACKFILL_OUTPUT_TAIL_BYTES = 4096

# Optional cap on timeseries IDs sent to the backfill wrapper in one subprocess
# call. 0 (or unset) = no chunking, send the full union in a single call (legacy
# behaviour). When set to N>0, large lists are sliced into chunks of <=N and each
# chunk gets its own subprocess + 30-min budget. Useful for large daily batches
# (e.g. weekly/monthly runs with many mismatches) that would otherwise hit the
# per-call timeout.
_CHUNK_ENV_VAR = "UK_AQ_HISTORY_INTEGRITY_MAX_TIMESERIES_IDS_PER_BACKFILL"
_TRY_UNCHUNKED_FIRST_ENV_VAR = "UK_AQ_HISTORY_INTEGRITY_BACKFILL_TRY_UNCHUNKED_FIRST"

# Status precedence for combining per-chunk results into one per-event row.
# Worst status wins so a single failed chunk surfaces as a failed backfill on
# every event that contained any of its timeseries IDs.
_BACKFILL_STATUS_RANK = {
    "ok": 0,
    "no_timeseries_ids": 1,
    "error": 2,
    "timeout": 3,
    "spawn_error": 4,
    "no_wrapper": 5,
    "no_env_file": 5,
}


def _chunk_timeseries_ids(ids: list[int]) -> list[list[int]]:
    """Slice timeseries IDs into chunks of at most _CHUNK_ENV_VAR each.

    Returns [list(ids)] (a single chunk) when the env var is unset, '0', or
    invalid — preserving the legacy single-call behaviour. Otherwise splits in
    order so callers can map each chunk back to its source events by intersecting
    timeseries-ID sets.
    """
    raw = (os.environ.get(_CHUNK_ENV_VAR) or "").strip()
    try:
        max_per = int(raw)
    except (TypeError, ValueError):
        max_per = 0
    if max_per <= 0 or len(ids) <= max_per:
        return [list(ids)]
    return [list(ids[i:i + max_per]) for i in range(0, len(ids), max_per)]


def _combine_backfill_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Reduce per-chunk backfill results to a single dict suitable for
    `_record_backfill_on_event`.

    - status: worst across chunks (per _BACKFILL_STATUS_RANK)
    - exit_code: from the worst-ranked chunk (deterministic) or last if all ok
    - duration_seconds: sum across chunks
    - log_path / error: '; '-joined non-empty values
    - stdout_tail / stderr_tail: from the worst-ranked chunk (most useful for diagnosis)
    """
    if not results:
        return {"status": "no_timeseries_ids", "exit_code": None, "duration_seconds": 0.0,
                "wrapper_path": None, "env_file_path": None, "stdout_tail": "",
                "stderr_tail": "", "log_path": None, "error": None}
    if len(results) == 1:
        return results[0]
    ranked = sorted(
        results,
        key=lambda r: _BACKFILL_STATUS_RANK.get(r.get("status") or "", 99),
        reverse=True,
    )
    worst = ranked[0]
    log_paths = [str(r["log_path"]) for r in results if r.get("log_path")]
    errors = [str(r["error"]) for r in results if r.get("error")]
    return {
        "status": worst.get("status"),
        "exit_code": worst.get("exit_code") if worst.get("status") != "ok"
                     else results[-1].get("exit_code"),
        "duration_seconds": sum(float(r.get("duration_seconds") or 0) for r in results),
        "wrapper_path": results[-1].get("wrapper_path"),
        "env_file_path": results[-1].get("env_file_path"),
        "stdout_tail": worst.get("stdout_tail", "") or "",
        "stderr_tail": worst.get("stderr_tail", "") or "",
        "log_path": "; ".join(log_paths) if log_paths else None,
        "error": "; ".join(errors) if errors else None,
    }


def _load_env_file(path: Path) -> dict[str, str]:
    """Parse a bash-style KEY=VALUE env file. Strips matching surrounding
    single or double quotes. Skips blank lines and #-comments. Tolerates an
    optional leading 'export '."""
    def _strip_inline_comment(value: str) -> str:
        in_single = False
        in_double = False
        escaped = False
        out: list[str] = []
        prev = ""
        for i, ch in enumerate(value):
            if in_single:
                if ch == "'":
                    in_single = False
                out.append(ch)
                prev = ch
                continue
            if in_double:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_double = False
                out.append(ch)
                prev = ch
                continue
            if ch == "'":
                in_single = True
                out.append(ch)
                prev = ch
                continue
            if ch == '"':
                in_double = True
                out.append(ch)
                prev = ch
                continue
            if ch == "#" and (i == 0 or prev.isspace()):
                break
            out.append(ch)
            prev = ch
        return "".join(out).strip()

    out: dict[str, str] = {}
    with path.open() as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            val = _strip_inline_comment(val)
            if len(val) >= 2 and (
                (val.startswith('"') and val.endswith('"'))
                or (val.startswith("'") and val.endswith("'"))
            ):
                val = val[1:-1]
            if key:
                out[key] = val
    return out


def _summarize_loaded_backfill_env_keys(loaded: dict[str, str]) -> list[str]:
    return sorted(
        key
        for key in (
            "UK_AQ_BACKFILL_RUN_MODE",
            "UK_AQ_BACKFILL_OUTPUT_SCOPE",
            "UK_AQ_BACKFILL_RUN_JOB_PATH",
            "INGESTDB_RETENTION_DAYS",
            "UK_AQ_R2_HISTORY_DROPBOX_ROOT",
        )
        if key in loaded
    )


def _tail_bytes(text: str, limit: int = BACKFILL_OUTPUT_TAIL_BYTES) -> str:
    if not text:
        return ""
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= limit:
        return text
    return "...[truncated]...\n" + encoded[-limit:].decode("utf-8", errors="replace")


def run_narrow_backfill(
    *,
    wrapper_path: str | None,
    env_file_path: str | None,
    env_name: str,
    timeseries_ids: list[int],
    connector_ids: list[int] | None = None,
    day: dt.date,
    log: logging.Logger,
    timeout_seconds: int = BACKFILL_DEFAULT_TIMEOUT_SECONDS,
    log_dir: Path | None = None,
    log_label: str | None = None,
    output_scope: str | None = None,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Invoke `uk_aq_backfill_local.sh` for one (timeseries-ids, day).

    Returns a result dict suitable for recording on the source_file_events
    row: status in {ok, error, no_wrapper, no_env_file, no_timeseries_ids,
    spawn_error, timeout}, plus exit_code/duration/stdout_tail/stderr_tail/error.

    When log_dir is set, full stdout+stderr is also written to a file under
    that directory and the path is returned in `log_path`.
    """
    result: dict[str, Any] = {
        "status": None,
        "exit_code": None,
        "duration_seconds": 0.0,
        "wrapper_path": wrapper_path,
        "env_file_path": env_file_path,
        "stdout_tail": "",
        "stderr_tail": "",
        "log_path": None,
        "error": None,
    }
    if not timeseries_ids:
        result["status"] = "no_timeseries_ids"
        result["error"] = "no timeseries_ids to backfill"
        return result
    if not wrapper_path:
        result["status"] = "no_wrapper"
        result["error"] = "UK_AQ_BACKFILL_WRAPPER is not set"
        return result
    if not Path(wrapper_path).is_file():
        result["status"] = "no_wrapper"
        result["error"] = f"wrapper not found: {wrapper_path}"
        return result

    sub_env: dict[str, str] = {**os.environ}
    if env_file_path:
        if not Path(env_file_path).is_file():
            result["status"] = "no_env_file"
            result["error"] = f"env file not found: {env_file_path}"
            return result
        loaded = _load_env_file(Path(env_file_path))
        interesting_keys = _summarize_loaded_backfill_env_keys(loaded)
        log.info(
            "backfill loading env_file=%s var_count=%s keys=%s",
            env_file_path,
            len(loaded),
            interesting_keys,
        )
        sub_env.update(loaded)

    iso = day.isoformat()
    sub_env.update({
        "UK_AQ_BACKFILL_RUN_MODE": "source_to_r2",
        "UK_AQ_BACKFILL_DRY_RUN": "false",
        "UK_AQ_BACKFILL_FORCE_REPLACE": "true",
        "UK_AQ_BACKFILL_OUTPUT_SCOPE": output_scope or "default",
        "UK_AQ_BACKFILL_FROM_DAY_UTC": iso,
        "UK_AQ_BACKFILL_TO_DAY_UTC": iso,
        "UK_AQ_BACKFILL_TIMESERIES_IDS": ",".join(str(t) for t in timeseries_ids),
        # Always force trigger_mode=manual (wrapper enforces this anyway).
        "UK_AQ_BACKFILL_TRIGGER_MODE": "manual",
    })
    connector_csv = ",".join(str(c) for c in (connector_ids or []) if int(c) > 0)
    if connector_csv:
        sub_env["UK_AQ_BACKFILL_CONNECTOR_IDS"] = connector_csv
    if extra_env:
        for key, value in extra_env.items():
            if key and value is not None:
                sub_env[str(key)] = str(value)
    # Reuse integrity OpenAQ local source-cache as the backfill mirror root
    # unless backfill-specific mirror root is already explicitly set.
    integrity_cache_root = (
        sub_env.get("UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR") or ""
    ).strip()
    if integrity_cache_root:
        if not (sub_env.get("UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT") or "").strip():
            sub_env["UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT"] = str(
                Path(integrity_cache_root) / "openaq"
            )
        # Option 1 (same-run handoff): let source_to_r2(uk_air_sos) reuse
        # canonical station/day snapshots that integrity just fetched in this run.
        if not (
            sub_env.get("UK_AQ_BACKFILL_SOS_INTEGRITY_SNAPSHOT_ROOT") or ""
        ).strip():
            sub_env["UK_AQ_BACKFILL_SOS_INTEGRITY_SNAPSHOT_ROOT"] = str(
                Path(integrity_cache_root) / "uk_air_sos"
            )

    started = time.monotonic()
    log.info(
        "backfill invoke wrapper=%s day=%s connector_ids=%s timeseries_ids=%s",
        wrapper_path,
        iso,
        sub_env.get("UK_AQ_BACKFILL_CONNECTOR_IDS", "all"),
        sub_env["UK_AQ_BACKFILL_TIMESERIES_IDS"],
    )

    wrapper_name = Path(wrapper_path).name
    cmd = ["bash", wrapper_path]
    if wrapper_name == "uk_aq_integrity_backfill.sh":
        cmd = [
            "bash",
            wrapper_path,
            "--env",
            env_name,
            "--observs-only",
            "--from-day",
            iso,
            "--to-day",
            iso,
            "--timeseries-ids",
            sub_env["UK_AQ_BACKFILL_TIMESERIES_IDS"],
        ]
        if connector_csv:
            first_connector = connector_csv.split(",", 1)[0]
            cmd.extend(["--connector-id", first_connector])

    stdout_text = ""
    stderr_text = ""
    try:
        proc = subprocess.run(
            cmd,
            env=sub_env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        stdout_text = proc.stdout or ""
        stderr_text = proc.stderr or ""
        result["exit_code"] = proc.returncode
        result["status"] = "ok" if proc.returncode == 0 else "error"
        if proc.returncode != 0:
            result["error"] = f"wrapper exit_code={proc.returncode}"
    except subprocess.TimeoutExpired as exc:
        result["status"] = "timeout"
        result["error"] = f"wrapper timed out after {timeout_seconds}s"
        if isinstance(exc.stdout, (bytes, bytearray)):
            stdout_text = exc.stdout.decode("utf-8", errors="replace")
        else:
            stdout_text = exc.stdout or ""
        if isinstance(exc.stderr, (bytes, bytearray)):
            stderr_text = exc.stderr.decode("utf-8", errors="replace")
        else:
            stderr_text = exc.stderr or ""
    except OSError as exc:
        result["status"] = "spawn_error"
        result["error"] = f"spawn failed: {exc}"

    result["stdout_tail"] = _tail_bytes(stdout_text)
    result["stderr_tail"] = _tail_bytes(stderr_text)

    if log_dir is not None and (stdout_text or stderr_text or result["status"]):
        log_dir.mkdir(parents=True, exist_ok=True)
        label = log_label or f"day_{iso}"
        log_path = log_dir / f"{label}.log"
        try:
            with log_path.open("w", encoding="utf-8") as fh:
                fh.write(f"# wrapper: {wrapper_path}\n")
                fh.write(f"# env_file: {env_file_path}\n")
                fh.write(f"# day: {iso}\n")
                fh.write(f"# connector_ids: {sub_env.get('UK_AQ_BACKFILL_CONNECTOR_IDS', 'all')}\n")
                fh.write(f"# timeseries_ids: {sub_env['UK_AQ_BACKFILL_TIMESERIES_IDS']}\n")
                fh.write(f"# output_scope: {sub_env.get('UK_AQ_BACKFILL_OUTPUT_SCOPE', 'default')}\n")
                if extra_env:
                    fh.write(f"# extra_env: {json.dumps(extra_env, sort_keys=True)}\n")
                fh.write(f"# command: {' '.join(cmd)}\n")
                fh.write(f"# exit_code: {result['exit_code']}\n")
                fh.write(f"# status: {result['status']}\n")
                fh.write("\n# === STDOUT ===\n")
                fh.write(stdout_text)
                fh.write("\n# === STDERR ===\n")
                fh.write(stderr_text)
            result["log_path"] = str(log_path)
        except OSError as exc:
            log.warning("backfill log_path write failed: %s", exc)

    result["duration_seconds"] = round(time.monotonic() - started, 3)
    log.info(
        "backfill done status=%s exit_code=%s duration=%.3fs",
        result["status"], result["exit_code"], result["duration_seconds"],
    )
    return result


def _record_backfill_on_event(
    conn: sqlite3.Connection,
    event_id: int,
    timeseries_ids: list[int],
    backfill: dict[str, Any],
    batch_info: dict[str, Any] | None = None,
) -> None:
    """Update the source_file_events row with backfill outcome columns.

    `timeseries_ids` is the per-event subset (the IDs belonging to this
    file's `source_location_id`). `batch_info`, when set, captures the
    larger invocation context — total IDs in the batch and the count of
    sibling files. Useful when multiple changed files share a day.
    """
    ids_csv = ",".join(str(t) for t in timeseries_ids) if timeseries_ids else None
    status = backfill.get("status") or "unknown"
    triggered_flag = 1 if status in {"ok", "error", "timeout"} else 0
    notes_parts: list[str] = []
    if backfill.get("error"):
        notes_parts.append(f"error={backfill['error']}")
    if backfill.get("wrapper_path"):
        notes_parts.append(f"wrapper={backfill['wrapper_path']}")
    if backfill.get("exit_code") is not None:
        notes_parts.append(f"exit_code={backfill['exit_code']}")
    if backfill.get("duration_seconds"):
        notes_parts.append(f"duration_s={backfill['duration_seconds']}")
    if backfill.get("log_path"):
        notes_parts.append(f"log={backfill['log_path']}")
    if batch_info:
        notes_parts.append(
            f"batch: files={batch_info.get('files', 1)} "
            f"total_timeseries_ids={batch_info.get('total_timeseries_ids', len(timeseries_ids))}"
        )
    if backfill.get("stdout_tail"):
        notes_parts.append("stdout_tail:\n" + backfill["stdout_tail"])
    if backfill.get("stderr_tail"):
        notes_parts.append("stderr_tail:\n" + backfill["stderr_tail"])
    notes_blob = "\n".join(notes_parts) if notes_parts else None

    conn.execute(
        """
        UPDATE source_file_events SET
          backfill_triggered = ?,
          backfill_timeseries_ids = ?,
          backfill_status = ?,
          notes = CASE
            WHEN notes IS NULL OR notes = '' THEN ?
            ELSE notes || char(10) || '---backfill---' || char(10) || ?
          END
        WHERE id = ?
        """,
        (triggered_flag, ids_csv, status, notes_blob, notes_blob, event_id),
    )


def check_openaq(
    conn: sqlite3.Connection,
    env_name: str,
    env: dict[str, str],
    from_day: str | None,
    to_day: str | None,
    *,
    dry_run: bool,
    run_backfill: bool,
    limits: LimitTracker,
    log: logging.Logger,
    run_compact: str,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> dict[str, Any]:
    """Iterate distinct OpenAQ locations × days; run per-file workflow.

    Returns a metrics dict suitable for merging into integrity_runs / report.
    """
    metrics: dict[str, Any] = {
        "ran": False,
        "stopped_for": None,
        "locations": 0,
        "days": 0,
        "head_checked": 0,
        "downloaded": 0,
        "first_seen": 0,
        "changed": 0,
        "unchanged_after_download": 0,
        "missing": 0,
        "errors": 0,
        "downloaded_bytes": 0,
        # first_seen_files: baselined this run (new to integrity DB). Not backfilled
        # directly — cross-check phase will repair if R2 actually disagrees.
        "first_seen_files": [],
        # changed_files: metadata diverged from prior baseline (changed or reappeared).
        # These are the source-driven backfill candidates.
        "changed_files": [],
        "planned_backfills": [],
        "backfills_attempted": 0,
        "backfills_ok": 0,
        "backfills_failed": 0,
        "skipped_reason": None,
    }

    base_url = os.environ.get(
        "UK_AQ_HISTORY_INTEGRITY_OPENAQ_BASE_URL", OPENAQ_DEFAULT_BASE_URL
    )

    if not from_day or not to_day:
        metrics["skipped_reason"] = "from_day/to_day not set; manual profile requires both"
        log.warning("openaq: skipped — %s", metrics["skipped_reason"])
        return metrics

    locations = _openaq_distinct_locations(conn)
    if not locations:
        metrics["skipped_reason"] = "no openaq locations in source_station_timeseries_lookup"
        log.warning("openaq: skipped — %s", metrics["skipped_reason"])
        return metrics

    days = _date_range_inclusive(from_day, to_day)
    if not days:
        metrics["skipped_reason"] = f"empty date range {from_day}..{to_day}"
        log.warning("openaq: skipped — %s", metrics["skipped_reason"])
        return metrics

    metrics["locations"] = len(locations)
    metrics["days"] = len(days)
    metrics["ran"] = True
    log.info(
        "openaq: starting locations=%s days=%s base_url=%s%s",
        len(locations), len(days), base_url,
        " (dry-run)" if dry_run else "",
    )

    if dry_run:
        # Walk the work plan; sample a few keys for the log/report.
        sample_urls: list[str] = []
        for loc in locations[:3]:
            for day in days[:3]:
                sample_urls.append(_openaq_url(base_url, loc, day))
        metrics["sample_urls"] = sample_urls
        log.info("openaq dry-run: would HEAD %s objects; sample=%s",
                 len(locations) * len(days), sample_urls[:5])
        return metrics

    tmp_dir = Path(env["UK_AQ_HISTORY_INTEGRITY_TMP_DIR"])
    cache_root = Path(env["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"]) / "openaq"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)

    db_path = env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"]
    log.info("openaq: concurrency=%s", concurrency)

    progress = SingleLineProgress("openaq progress")
    total_tasks = 0
    completed_tasks = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures: list[concurrent.futures.Future] = []
        for loc in locations:
            if limits.should_stop():
                break
            for day in days:
                if limits.should_stop():
                    break
                futures.append(ex.submit(
                    _check_one_openaq_file_threadsafe,
                    db_path, env_name, base_url, loc, day,
                    tmp_dir, cache_root, log, limits,
                ))
        total_tasks = len(futures)
        progress.update(
            (
                f"0/{total_tasks} checked=0 changed=0 downloaded=0 "
                f"missing=0 errors=0 planned_backfills=0"
            ),
            force=True,
        )

        for fut in concurrent.futures.as_completed(futures):
            completed_tasks += 1
            try:
                result = fut.result()
            except Exception as exc:
                metrics["errors"] += 1
                log.warning("openaq worker raised: %s", exc)
                progress.update(
                    (
                        f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                        f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                        f"missing={metrics['missing']} errors={metrics['errors']} "
                        f"planned_backfills={len(metrics['planned_backfills'])}"
                    ),
                )
                continue
            outcome = result.get("outcome")
            if outcome == "stopped":
                progress.update(
                    (
                        f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                        f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                        f"missing={metrics['missing']} errors={metrics['errors']} "
                        f"planned_backfills={len(metrics['planned_backfills'])} "
                        f"stopped_for={limits.stopped_for or 'n/a'}"
                    ),
                )
                continue
            metrics["head_checked"] += 1
            if outcome in {"missing_first_seen", "missing_disappeared", "still_missing"}:
                metrics["missing"] += 1
            if outcome == "unchanged_content":
                metrics["downloaded"] += 1
                metrics["unchanged_after_download"] += 1
            if outcome == "first_seen":
                # Baseline: record metadata/hash/counts but do not drive backfill.
                # Cross-check phase remains the single source of truth for whether
                # R2 actually needs repair for these files.
                metrics["downloaded"] += 1
                metrics["first_seen"] += 1
                metrics["first_seen_files"].append({
                    "location_id": result["location_id"],
                    "day": result["day"],
                    "event_id": result["event_id"],
                    "event_type": result["event_type"],
                    "timeseries_ids": result["timeseries_ids"],
                })
            elif outcome in {"changed", "reappeared"}:
                metrics["downloaded"] += 1
                metrics["changed"] += 1
                metrics["changed_files"].append({
                    "location_id": result["location_id"],
                    "day": result["day"],
                    "event_id": result["event_id"],
                    "event_type": result["event_type"],
                    "timeseries_ids": result["timeseries_ids"],
                })
                if run_backfill:
                    day_obj = dt.date.fromisoformat(result["day"])
                    cmd = _planned_backfill_command(env, result["timeseries_ids"], day_obj)
                    metrics["planned_backfills"].append(cmd)
                    log.info("openaq planned backfill: %s", cmd)
            bytes_added = int(result.get("downloaded_bytes") or 0)
            if bytes_added:
                metrics["downloaded_bytes"] += bytes_added
                limits.add_bytes(bytes_added)
            progress.update(
                (
                    f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                    f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                    f"missing={metrics['missing']} errors={metrics['errors']} "
                    f"planned_backfills={len(metrics['planned_backfills'])}"
                ),
            )
    progress.update(
        (
            f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
            f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
            f"missing={metrics['missing']} errors={metrics['errors']} "
            f"planned_backfills={len(metrics['planned_backfills'])}"
        ),
        force=True,
    )
    progress.finish()

    # Sort for deterministic reports (completion order is non-deterministic).
    metrics["first_seen_files"].sort(key=lambda e: (e["day"], e["location_id"]))
    metrics["changed_files"].sort(key=lambda e: (e["day"], e["location_id"]))
    metrics["planned_backfills"].sort()

    if limits.should_stop():
        metrics["stopped_for"] = limits.stopped_for
        log.warning("openaq: stopped early due to limit=%s", limits.stopped_for)

    # ---- Phase 4 Pass 2: batched backfill phase ----
    # All HEAD/download work is complete. Group changed files by day, union
    # the per-location timeseries IDs, and invoke the wrapper once per day.
    if run_backfill and not dry_run and metrics["changed_files"]:
        backfill_log_dir = (
            Path(env["UK_AQ_HISTORY_INTEGRITY_LOG_DIR"]) / "backfill" / run_compact
        )
        by_day: dict[str, list[dict[str, Any]]] = {}
        for entry in metrics["changed_files"]:
            by_day.setdefault(entry["day"], []).append(entry)
        backfill_progress = SingleLineProgress("openaq backfill")
        total_backfill_days = len(by_day)
        done_backfill_days = 0
        backfill_progress.update(
            f"0/{total_backfill_days} attempted=0 ok=0 failed=0",
            force=True,
        )
        for day_iso in sorted(by_day):
            if limits.should_stop():
                log.warning(
                    "backfill phase: stopping early (%s) — %s days skipped",
                    limits.stopped_for,
                    len([d for d in by_day if d > day_iso]),
                )
                break
            group = by_day[day_iso]
            union_ids = sorted({ts for entry in group for ts in entry["timeseries_ids"]})
            chunks = _chunk_timeseries_ids(union_ids)
            log.info(
                "backfill batch day=%s files=%s total_timeseries_ids=%s chunks=%s",
                day_iso, len(group), len(union_ids), len(chunks),
            )
            event_chunk_results: dict[int, list[dict[str, Any]]] = {}
            for chunk_index, chunk_ids in enumerate(chunks, start=1):
                chunk_label = (
                    f"day_{day_iso}" if len(chunks) == 1
                    else f"day_{day_iso}_chunk_{chunk_index}_of_{len(chunks)}"
                )
                chunk_id_set = set(chunk_ids)
                bf = run_narrow_backfill(
                    wrapper_path=resolve_integrity_backfill_wrapper(),
                    env_file_path=os.environ.get("UK_AQ_BACKFILL_ENV_FILE"),
                    env_name=env_name,
                    timeseries_ids=chunk_ids,
                    day=dt.date.fromisoformat(day_iso),
                    log=log,
                    log_dir=backfill_log_dir,
                    log_label=chunk_label,
                )
                metrics["backfills_attempted"] += 1
                if bf["status"] == "ok":
                    metrics["backfills_ok"] += 1
                else:
                    metrics["backfills_failed"] += 1
                for entry in group:
                    eid = entry.get("event_id")
                    if not eid:
                        continue
                    if any(t in chunk_id_set for t in entry["timeseries_ids"]):
                        event_chunk_results.setdefault(int(eid), []).append(bf)
            for entry in group:
                eid = entry.get("event_id")
                if not eid:
                    continue
                chunk_bfs = event_chunk_results.get(int(eid), [])
                if not chunk_bfs:
                    continue
                _record_backfill_on_event(
                    conn, int(eid),
                    entry["timeseries_ids"],
                    _combine_backfill_results(chunk_bfs),
                    batch_info={
                        "files": len(group),
                        "total_timeseries_ids": len(union_ids),
                    },
                )
            conn.commit()
            done_backfill_days += 1
            backfill_progress.update(
                (
                    f"{done_backfill_days}/{total_backfill_days} "
                    f"attempted={metrics['backfills_attempted']} "
                    f"ok={metrics['backfills_ok']} "
                    f"failed={metrics['backfills_failed']}"
                ),
            )
        backfill_progress.update(
            (
                f"{done_backfill_days}/{total_backfill_days} "
                f"attempted={metrics['backfills_attempted']} "
                f"ok={metrics['backfills_ok']} "
                f"failed={metrics['backfills_failed']}"
            ),
            force=True,
        )
        backfill_progress.finish()

    log.info("openaq: done %s", {k: v for k, v in metrics.items() if k not in ("first_seen_files", "changed_files", "planned_backfills", "sample_urls")})
    return metrics


# ---------------------------------------------------------------------------
# Phase 5 — Sensor.Community adapter
# ---------------------------------------------------------------------------
#
# Archive layout (daily):
#   https://archive.sensor.community/<YYYY-MM-DD>/<YYYY-MM-DD>_<sensor_type>_sensor_<sensor_id>.csv
#
# Unlike OpenAQ:
# - Files are plain CSV (no gzip). sha256_downloaded == sha256_uncompressed.
# - Filename includes the sensor_type, which we don't carry per-station in
#   the core snapshot. We discover filenames by fetching the day's directory
#   index (one HTTP request per day) and parsing the HTML for sensor_id ->
#   filename. Sensors absent from the index are recorded as missing without
#   issuing a per-file HEAD.
# - Index parse uses a simple regex over the standard nginx-style listing.

SC_SOURCE_KEY = "sensorcommunity"
SC_DEFAULT_BASE_URL = "https://archive.sensor.community"
SC_REMOTE_SCHEME = "https"
SC_INDEX_FILENAME_RE = re.compile(
    r'href="((\d{4}-\d{2}-\d{2})_([A-Za-z0-9_]+)_sensor_(\d+)\.csv)"'
)
SC_HTTP_TIMEOUT_SECONDS = 60


def _sc_day_url(base_url: str, day: dt.date) -> str:
    return f"{base_url.rstrip('/')}/{day.isoformat()}/"


def _sc_object_url(base_url: str, day: dt.date, filename: str) -> str:
    return f"{base_url.rstrip('/')}/{day.isoformat()}/{filename}"


def _sc_source_file_key(sensor_id: str, day: dt.date) -> str:
    return f"sensorcommunity:{sensor_id}:{day.isoformat()}"


def _sc_cache_path(cache_root: Path, day: dt.date, filename: str) -> Path:
    return cache_root / day.isoformat() / filename


def _sc_distinct_sensor_ids(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT source_location_id
        FROM source_station_timeseries_lookup
        WHERE source_key = ?
        ORDER BY source_location_id
        """,
        (SC_SOURCE_KEY,),
    ).fetchall()
    return [r[0] for r in rows]


def _sc_lookup_timeseries_for_sensor(
    conn: sqlite3.Connection, sensor_id: str
) -> list[int]:
    rows = conn.execute(
        """
        SELECT timeseries_id
        FROM source_station_timeseries_lookup
        WHERE source_key = ? AND source_location_id = ?
        ORDER BY timeseries_id
        """,
        (SC_SOURCE_KEY, sensor_id),
    ).fetchall()
    return [int(r[0]) for r in rows]


def _sc_fetch_day_index(
    base_url: str, day: dt.date, timeout: int = SC_HTTP_TIMEOUT_SECONDS
) -> dict[str, str]:
    """GET the day's directory listing and parse it for sensor files.

    Returns {sensor_id: filename}. If multiple files match a sensor_id (rare),
    keeps the first. Raises on network error or non-200.
    """
    url = _sc_day_url(base_url, day)
    req = urllib.request.Request(url, method="GET")
    body: bytes | None = None
    for attempt in range(1, HTTP_RETRY_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"GET {url} returned {resp.status}")
                body = resp.read()
            break
        except urllib.error.HTTPError as e:
            if _is_retryable_url_error(e) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("GET", url, attempt, e)
                continue
            raise
        except Exception as e:
            if _is_retryable_url_error(e) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("GET", url, attempt, e)
                continue
            raise
    if body is None:
        raise RuntimeError(f"GET {url} failed after retries")
    text = body.decode("utf-8", errors="replace")
    out: dict[str, str] = {}
    for match in SC_INDEX_FILENAME_RE.finditer(text):
        filename = match.group(1)
        sensor_id = match.group(4)
        out.setdefault(sensor_id, filename)
    return out


def _sha256_of_csv(path: Path) -> str:
    digest, _ = sha256_of_file(path)
    return digest


def _check_one_sc_file_threadsafe(
    db_path: str,
    env_name: str,
    base_url: str,
    sensor_id: str,
    day: dt.date,
    filename_in_index: str | None,
    tmp_dir: Path,
    cache_root: Path,
    log: logging.Logger,
    limits: LimitTracker | None = None,
) -> dict[str, Any]:
    """Worker entrypoint mirroring `_check_one_openaq_file_threadsafe`."""
    if limits is not None and limits.should_stop():
        return {
            "outcome": "stopped",
            "sensor_id": sensor_id,
            "day": day.isoformat(),
            "downloaded_bytes": 0,
            "event_id": None,
            "event_type": None,
            "timeseries_ids": [],
        }
    conn = _worker_db_conn(db_path)
    try:
        result = _check_one_sc_file(
            conn, env_name, base_url, sensor_id, day, filename_in_index,
            tmp_dir, cache_root, log,
        )
    finally:
        try:
            conn.commit()
        except sqlite3.Error:
            pass
    result["sensor_id"] = sensor_id
    result["day"] = day.isoformat()
    return result


def _check_one_sc_file(
    conn: sqlite3.Connection,
    env_name: str,
    base_url: str,
    sensor_id: str,
    day: dt.date,
    filename_in_index: str | None,
    tmp_dir: Path,
    cache_root: Path,
    log: logging.Logger,
) -> dict[str, Any]:
    """Per-sensor/day workflow. Mirrors `_check_one_openaq_file` but:
    - skips HEAD entirely when not in index (avoids issuing per-file 404s),
    - treats the CSV as canonical bytes (sha256_downloaded == sha256_uncompressed).
    """
    sfk = _sc_source_file_key(sensor_id, day)
    now_iso = fmt_iso(utc_now())
    prior = _fetch_prior_state(conn, sfk)
    timeseries_ids = _sc_lookup_timeseries_for_sensor(conn, sensor_id)

    # No file in index for this day = missing.
    if filename_in_index is None:
        empty_head = {"status": 404, "etag": None, "content_length": None, "last_modified": None}
        # Reuse the OpenAQ path-encoded URL as a stable URL even when absent.
        # We don't know the filename, so record the day URL.
        url_for_state = _sc_day_url(base_url, day)
        if prior is None:
            _upsert_state(
                conn, source_file_key=sfk, env_name=env_name, remote_url=url_for_state,
                location_id=sensor_id, day=day,
                head={"etag": None, "content_length": None, "last_modified": None},
                exists_remote=False,
                sha256_downloaded=None, sha256_uncompressed=None,
                local_cached_path=None,
                now_iso=now_iso, last_changed_at=None,
                last_status="missing",
            )
            # Override remote_scheme since _upsert_state writes the OpenAQ default
            conn.execute(
                "UPDATE source_file_state SET source_key=?, remote_scheme=? WHERE source_file_key=?",
                (SC_SOURCE_KEY, SC_REMOTE_SCHEME, sfk),
            )
            event_id = _insert_event(
                conn, event_type="first_seen_missing", env_name=env_name,
                source_file_key=sfk, remote_url=url_for_state,
                location_id=sensor_id, day=day,
                prior=None, head=empty_head,
                new_sha_downloaded=None, new_sha_uncompressed=None,
                downloaded_bytes=0, hash_runtime_ms=0, now_iso=now_iso,
            )
            conn.execute(
                "UPDATE source_file_events SET source_key=? WHERE id=?",
                (SC_SOURCE_KEY, event_id),
            )
            return {
                "outcome": "missing_first_seen", "downloaded_bytes": 0,
                "event_id": event_id, "event_type": "first_seen_missing",
                "timeseries_ids": timeseries_ids,
            }
        if prior["exists_remote"] == 1:
            _upsert_state(
                conn, source_file_key=sfk, env_name=env_name, remote_url=url_for_state,
                location_id=sensor_id, day=day,
                head={"etag": None, "content_length": None, "last_modified": None},
                exists_remote=False,
                sha256_downloaded=None, sha256_uncompressed=None,
                local_cached_path=None,
                now_iso=now_iso, last_changed_at=now_iso,
                last_status="missing",
            )
            conn.execute(
                "UPDATE source_file_state SET source_key=?, remote_scheme=? WHERE source_file_key=?",
                (SC_SOURCE_KEY, SC_REMOTE_SCHEME, sfk),
            )
            event_id = _insert_event(
                conn, event_type="disappeared", env_name=env_name,
                source_file_key=sfk, remote_url=url_for_state,
                location_id=sensor_id, day=day,
                prior=prior, head=empty_head,
                new_sha_downloaded=None, new_sha_uncompressed=None,
                downloaded_bytes=0, hash_runtime_ms=0, now_iso=now_iso,
            )
            conn.execute(
                "UPDATE source_file_events SET source_key=? WHERE id=?",
                (SC_SOURCE_KEY, event_id),
            )
            return {
                "outcome": "missing_disappeared", "downloaded_bytes": 0,
                "event_id": event_id, "event_type": "disappeared",
                "timeseries_ids": timeseries_ids,
            }
        # already missing — just bump last_checked
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url_for_state,
            location_id=sensor_id, day=day,
            head={"etag": None, "content_length": None, "last_modified": None},
            exists_remote=False,
            sha256_downloaded=None, sha256_uncompressed=None,
            local_cached_path=None,
            now_iso=now_iso, last_changed_at=None,
            last_status="missing",
        )
        conn.execute(
            "UPDATE source_file_state SET source_key=?, remote_scheme=? WHERE source_file_key=?",
            (SC_SOURCE_KEY, SC_REMOTE_SCHEME, sfk),
        )
        return {
            "outcome": "still_missing", "downloaded_bytes": 0,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    # File present in index: HEAD + maybe download.
    url = _sc_object_url(base_url, day, filename_in_index)
    head = _http_head(url)
    if head["status"] != 200:
        # Index said it exists but HEAD disagreed — record as error-class missing.
        raise RuntimeError(f"HEAD {url} returned {head['status']} despite index listing")

    is_first_seen = prior is None
    was_missing = prior is not None and prior["exists_remote"] == 0
    needs_download = is_first_seen or was_missing or _metadata_changed(prior, head)

    if not needs_download:
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=sensor_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=prior["sha256_downloaded"],
            sha256_uncompressed=prior["sha256_uncompressed"],
            local_cached_path=None,
            now_iso=now_iso, last_changed_at=None,
            last_status="unchanged",
        )
        conn.execute(
            "UPDATE source_file_state SET source_key=?, remote_scheme=? WHERE source_file_key=?",
            (SC_SOURCE_KEY, SC_REMOTE_SCHEME, sfk),
        )
        return {
            "outcome": "unchanged_metadata", "downloaded_bytes": 0,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    tmp_path = tmp_dir / f"sc-{sensor_id}-{day.strftime('%Y%m%d')}.csv"
    if tmp_path.exists():
        tmp_path.unlink()
    bytes_downloaded = _http_get_to_file(url, tmp_path)
    hash_start = time.monotonic()
    sha_csv = _sha256_of_csv(tmp_path)
    hash_runtime_ms = int((time.monotonic() - hash_start) * 1000)

    content_changed = (
        prior is None
        or prior.get("sha256_uncompressed") is None
        or prior["sha256_uncompressed"] != sha_csv
    )
    state_changed = is_first_seen or was_missing or content_changed

    if not state_changed:
        tmp_path.unlink(missing_ok=True)
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=sensor_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=sha_csv,
            sha256_uncompressed=sha_csv,
            local_cached_path=None,
            now_iso=now_iso, last_changed_at=None,
            last_status="unchanged",
        )
        conn.execute(
            "UPDATE source_file_state SET source_key=?, remote_scheme=? WHERE source_file_key=?",
            (SC_SOURCE_KEY, SC_REMOTE_SCHEME, sfk),
        )
        return {
            "outcome": "unchanged_content", "downloaded_bytes": bytes_downloaded,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    event_type = (
        "first_seen" if is_first_seen
        else "reappeared" if was_missing
        else "changed"
    )
    cache_path = _sc_cache_path(cache_root, day, filename_in_index)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.exists():
        cache_path.unlink()
    shutil.move(str(tmp_path), str(cache_path))

    # Phase 6.5 Pass A: per-timeseries row counts. Each non-empty
    # measurement cell contributes 1 to the timeseries whose timeseries_ref
    # is sensor_id + ":<pollutant>".
    try:
        ref_counts = _sc_parse_per_timeseries_counts(cache_path, sensor_id)
        ref_to_id = _resolve_ts_refs_to_ids(conn, SC_SOURCE_KEY, ref_counts.keys())
        counts_by_id: dict[int, int] = {}
        unmatched: list[str] = []
        for ref, n in ref_counts.items():
            ts_id = ref_to_id.get(ref)
            if ts_id is None:
                unmatched.append(ref)
                continue
            counts_by_id[ts_id] = counts_by_id.get(ts_id, 0) + n
        _record_source_file_timeseries_counts(conn, sfk, counts_by_id, now_iso)
        if unmatched:
            log.info(
                "sensorcommunity counts: sensor=%s day=%s %d ref(s) unmatched in core (e.g. %s)",
                sensor_id, day.isoformat(), len(unmatched), unmatched[0],
            )
    except Exception as exc:
        log.warning(
            "sensorcommunity counts: parse failed sensor=%s day=%s: %s",
            sensor_id, day.isoformat(), exc,
        )

    _upsert_state(
        conn, source_file_key=sfk, env_name=env_name, remote_url=url,
        location_id=sensor_id, day=day,
        head=head, exists_remote=True,
        sha256_downloaded=sha_csv,
        sha256_uncompressed=sha_csv,
        local_cached_path=str(cache_path),
        now_iso=now_iso, last_changed_at=now_iso,
        last_status=event_type,
    )
    conn.execute(
        "UPDATE source_file_state SET source_key=?, remote_scheme=? WHERE source_file_key=?",
        (SC_SOURCE_KEY, SC_REMOTE_SCHEME, sfk),
    )
    event_id = _insert_event(
        conn, event_type=event_type, env_name=env_name,
        source_file_key=sfk, remote_url=url,
        location_id=sensor_id, day=day,
        prior=prior, head=head,
        new_sha_downloaded=sha_csv, new_sha_uncompressed=sha_csv,
        downloaded_bytes=bytes_downloaded, hash_runtime_ms=hash_runtime_ms,
        now_iso=now_iso,
        notes=("content unchanged from prior version (state-only transition)"
               if not content_changed else None),
    )
    conn.execute(
        "UPDATE source_file_events SET source_key=? WHERE id=?",
        (SC_SOURCE_KEY, event_id),
    )
    log.info(
        "sensorcommunity %s sensor=%s day=%s sha=%s..%s bytes=%s",
        event_type, sensor_id, day.isoformat(),
        sha_csv[:8], sha_csv[-4:], bytes_downloaded,
    )
    return {
        "outcome": event_type,
        "downloaded_bytes": bytes_downloaded,
        "event_id": event_id, "event_type": event_type,
        "timeseries_ids": timeseries_ids,
    }


def check_sensor_community(
    conn: sqlite3.Connection,
    env_name: str,
    env: dict[str, str],
    from_day: str | None,
    to_day: str | None,
    *,
    dry_run: bool,
    run_backfill: bool,
    limits: LimitTracker,
    log: logging.Logger,
    run_compact: str,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> dict[str, Any]:
    """Iterate days × distinct SC sensor IDs from the lookup; one index fetch per day."""
    metrics: dict[str, Any] = {
        "ran": False,
        "stopped_for": None,
        "sensors": 0,
        "days": 0,
        "index_fetched": 0,
        "head_checked": 0,
        "downloaded": 0,
        "first_seen": 0,
        "changed": 0,
        "unchanged_after_download": 0,
        "missing": 0,
        "errors": 0,
        "downloaded_bytes": 0,
        # first_seen_files: baselined this run; not backfilled directly.
        "first_seen_files": [],
        # changed_files: metadata diverged from baseline (changed or reappeared).
        "changed_files": [],
        "planned_backfills": [],
        "backfills_attempted": 0,
        "backfills_ok": 0,
        "backfills_failed": 0,
        "skipped_reason": None,
    }

    base_url = os.environ.get(
        "UK_AQ_HISTORY_INTEGRITY_SENSOR_COMMUNITY_BASE_URL", SC_DEFAULT_BASE_URL
    )

    if not from_day or not to_day:
        metrics["skipped_reason"] = "from_day/to_day not set; manual profile requires both"
        log.warning("sensorcommunity: skipped — %s", metrics["skipped_reason"])
        return metrics

    sensors = _sc_distinct_sensor_ids(conn)
    if not sensors:
        metrics["skipped_reason"] = "no sensorcommunity sensors in source_station_timeseries_lookup"
        log.warning("sensorcommunity: skipped — %s", metrics["skipped_reason"])
        return metrics

    days = _date_range_inclusive(from_day, to_day)
    if not days:
        metrics["skipped_reason"] = f"empty date range {from_day}..{to_day}"
        log.warning("sensorcommunity: skipped — %s", metrics["skipped_reason"])
        return metrics

    metrics["sensors"] = len(sensors)
    metrics["days"] = len(days)
    metrics["ran"] = True
    log.info(
        "sensorcommunity: starting sensors=%s days=%s base_url=%s%s",
        len(sensors), len(days), base_url,
        " (dry-run)" if dry_run else "",
    )

    if dry_run:
        sample = [_sc_day_url(base_url, d) for d in days[:3]]
        metrics["sample_urls"] = sample
        log.info(
            "sensorcommunity dry-run: would fetch %s indexes; sample=%s",
            len(days), sample,
        )
        return metrics

    tmp_dir = Path(env["UK_AQ_HISTORY_INTEGRITY_TMP_DIR"])
    cache_root = Path(env["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"]) / "sensorcommunity"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    db_path = env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"]
    log.info("sensorcommunity: concurrency=%s", concurrency)

    # Phase A (sequential, per day): fetch the day's index. ~18 fetches for
    # a daily window — small enough that parallelism here isn't worth it.
    work_items: list[tuple[str, dt.date, str | None]] = []
    for day in days:
        if limits.should_stop():
            break
        try:
            index = _sc_fetch_day_index(base_url, day)
            metrics["index_fetched"] += 1
        except Exception as exc:
            metrics["errors"] += 1
            log.warning(
                "sensorcommunity: index fetch failed for day=%s: %s", day, exc,
            )
            continue
        for sensor_id in sensors:
            work_items.append((sensor_id, day, index.get(sensor_id)))

    # Phase B (parallel, per (sensor, day)): HEAD/GET/hash via thread pool.
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures: list[concurrent.futures.Future] = []
        for sensor_id, day, filename in work_items:
            if limits.should_stop():
                break
            futures.append(ex.submit(
                _check_one_sc_file_threadsafe,
                db_path, env_name, base_url, sensor_id, day, filename,
                tmp_dir, cache_root, log, limits,
            ))
        total_tasks = len(futures)
        completed_tasks = 0
        progress = SingleLineProgress("sensorcommunity progress")
        progress.update(
            (
                f"0/{total_tasks} checked=0 changed=0 downloaded=0 "
                f"missing=0 errors=0 planned_backfills=0"
            ),
            force=True,
        )

        for fut in concurrent.futures.as_completed(futures):
            completed_tasks += 1
            try:
                result = fut.result()
            except Exception as exc:
                metrics["errors"] += 1
                log.warning("sensorcommunity worker raised: %s", exc)
                progress.update(
                    (
                        f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                        f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                        f"missing={metrics['missing']} errors={metrics['errors']} "
                        f"planned_backfills={len(metrics['planned_backfills'])}"
                    ),
                )
                continue
            outcome = result.get("outcome")
            if outcome == "stopped":
                progress.update(
                    (
                        f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                        f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                        f"missing={metrics['missing']} errors={metrics['errors']} "
                        f"planned_backfills={len(metrics['planned_backfills'])} "
                        f"stopped_for={limits.stopped_for or 'n/a'}"
                    ),
                )
                continue
            metrics["head_checked"] += 1
            if outcome in {"missing_first_seen", "missing_disappeared", "still_missing"}:
                metrics["missing"] += 1
            if outcome == "unchanged_content":
                metrics["downloaded"] += 1
                metrics["unchanged_after_download"] += 1
            if outcome == "first_seen":
                # Baseline: record metadata/hash/counts but do not drive backfill.
                metrics["downloaded"] += 1
                metrics["first_seen"] += 1
                metrics["first_seen_files"].append({
                    "sensor_id": result["sensor_id"],
                    "day": result["day"],
                    "event_id": result["event_id"],
                    "event_type": result["event_type"],
                    "timeseries_ids": result["timeseries_ids"],
                })
            elif outcome in {"changed", "reappeared"}:
                metrics["downloaded"] += 1
                metrics["changed"] += 1
                metrics["changed_files"].append({
                    "sensor_id": result["sensor_id"],
                    "day": result["day"],
                    "event_id": result["event_id"],
                    "event_type": result["event_type"],
                    "timeseries_ids": result["timeseries_ids"],
                })
                if run_backfill:
                    day_obj = dt.date.fromisoformat(result["day"])
                    cmd = _planned_backfill_command(env, result["timeseries_ids"], day_obj)
                    metrics["planned_backfills"].append(cmd)
                    log.info("sensorcommunity planned backfill: %s", cmd)
            bytes_added = int(result.get("downloaded_bytes") or 0)
            if bytes_added:
                metrics["downloaded_bytes"] += bytes_added
                limits.add_bytes(bytes_added)
            progress.update(
                (
                    f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                    f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                    f"missing={metrics['missing']} errors={metrics['errors']} "
                    f"planned_backfills={len(metrics['planned_backfills'])}"
                ),
            )
    progress.update(
        (
            f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
            f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
            f"missing={metrics['missing']} errors={metrics['errors']} "
            f"planned_backfills={len(metrics['planned_backfills'])}"
        ),
        force=True,
    )
    progress.finish()

    metrics["first_seen_files"].sort(key=lambda e: (e["day"], e["sensor_id"]))
    metrics["changed_files"].sort(key=lambda e: (e["day"], e["sensor_id"]))
    metrics["planned_backfills"].sort()

    if limits.should_stop():
        metrics["stopped_for"] = limits.stopped_for
        log.warning(
            "sensorcommunity: stopped early due to limit=%s", limits.stopped_for,
        )

    # Phase 4 batched backfill, same shape as OpenAQ.
    if run_backfill and not dry_run and metrics["changed_files"]:
        backfill_log_dir = (
            Path(env["UK_AQ_HISTORY_INTEGRITY_LOG_DIR"])
            / "backfill" / run_compact
        )
        by_day: dict[str, list[dict[str, Any]]] = {}
        for entry in metrics["changed_files"]:
            by_day.setdefault(entry["day"], []).append(entry)
        backfill_progress = SingleLineProgress("sensorcommunity backfill")
        total_backfill_days = len(by_day)
        done_backfill_days = 0
        backfill_progress.update(
            f"0/{total_backfill_days} attempted=0 ok=0 failed=0",
            force=True,
        )
        for day_iso in sorted(by_day):
            if limits.should_stop():
                log.warning(
                    "sensorcommunity backfill: stopping early (%s) — %s days skipped",
                    limits.stopped_for,
                    len([d for d in by_day if d > day_iso]),
                )
                break
            group = by_day[day_iso]
            union_ids = sorted({ts for entry in group for ts in entry["timeseries_ids"]})
            chunks = _chunk_timeseries_ids(union_ids)
            log.info(
                "sensorcommunity backfill batch day=%s files=%s total_timeseries_ids=%s chunks=%s",
                day_iso, len(group), len(union_ids), len(chunks),
            )
            event_chunk_results: dict[int, list[dict[str, Any]]] = {}
            for chunk_index, chunk_ids in enumerate(chunks, start=1):
                chunk_label = (
                    f"sc_day_{day_iso}" if len(chunks) == 1
                    else f"sc_day_{day_iso}_chunk_{chunk_index}_of_{len(chunks)}"
                )
                chunk_id_set = set(chunk_ids)
                bf = run_narrow_backfill(
                    wrapper_path=resolve_integrity_backfill_wrapper(),
                    env_file_path=os.environ.get("UK_AQ_BACKFILL_ENV_FILE"),
                    env_name=env_name,
                    timeseries_ids=chunk_ids,
                    day=dt.date.fromisoformat(day_iso),
                    log=log,
                    log_dir=backfill_log_dir,
                    log_label=chunk_label,
                )
                metrics["backfills_attempted"] += 1
                if bf["status"] == "ok":
                    metrics["backfills_ok"] += 1
                else:
                    metrics["backfills_failed"] += 1
                for entry in group:
                    eid = entry.get("event_id")
                    if not eid:
                        continue
                    if any(t in chunk_id_set for t in entry["timeseries_ids"]):
                        event_chunk_results.setdefault(int(eid), []).append(bf)
            for entry in group:
                eid = entry.get("event_id")
                if not eid:
                    continue
                chunk_bfs = event_chunk_results.get(int(eid), [])
                if not chunk_bfs:
                    continue
                _record_backfill_on_event(
                    conn, int(eid),
                    entry["timeseries_ids"],
                    _combine_backfill_results(chunk_bfs),
                    batch_info={
                        "files": len(group),
                        "total_timeseries_ids": len(union_ids),
                    },
                )
            conn.commit()
            done_backfill_days += 1
            backfill_progress.update(
                (
                    f"{done_backfill_days}/{total_backfill_days} "
                    f"attempted={metrics['backfills_attempted']} "
                    f"ok={metrics['backfills_ok']} "
                    f"failed={metrics['backfills_failed']}"
                ),
            )
        backfill_progress.update(
            (
                f"{done_backfill_days}/{total_backfill_days} "
                f"attempted={metrics['backfills_attempted']} "
                f"ok={metrics['backfills_ok']} "
                f"failed={metrics['backfills_failed']}"
            ),
            force=True,
        )
        backfill_progress.finish()

    log.info(
        "sensorcommunity: done %s",
        {k: v for k, v in metrics.items() if k not in ("first_seen_files", "changed_files", "planned_backfills", "sample_urls")},
    )
    return metrics


UK_AIR_SOS_REMOTE_SCHEME = "api"


def _should_suppress_uk_air_sos_not_found_retry(
    prior: dict[str, Any] | None,
    *,
    now_iso: str,
    cooldown_seconds: int,
) -> bool:
    if cooldown_seconds <= 0 or prior is None:
        return False
    if int(prior.get("exists_remote") or 0) != 0:
        return False
    last_checked = _parse_iso_utc(prior.get("last_checked_at_utc"))
    now_dt = _parse_iso_utc(now_iso)
    if last_checked is None or now_dt is None:
        return False
    elapsed = (now_dt - last_checked).total_seconds()
    if elapsed < 0:
        return False
    return elapsed < float(cooldown_seconds)


def _check_one_uk_air_sos_station_day_threadsafe(
    db_path: str,
    env_name: str,
    base_url: str,
    station_ref: str,
    bindings: list[dict[str, Any]],
    day: dt.date,
    cache_root: Path,
    keep_policy: str,
    not_found_cooldown_seconds: int,
    log: logging.Logger,
    limits: LimitTracker | None = None,
) -> dict[str, Any]:
    if limits is not None and limits.should_stop():
        return {
            "outcome": "stopped",
            "station_ref": station_ref,
            "day": day.isoformat(),
            "downloaded_bytes": 0,
            "row_count": 0,
            "event_id": None,
            "event_type": None,
            "timeseries_ids": [],
        }
    conn = _worker_db_conn(db_path)
    try:
        result = _check_one_uk_air_sos_station_day(
            conn=conn,
            env_name=env_name,
            base_url=base_url,
            station_ref=station_ref,
            bindings=bindings,
            day=day,
            cache_root=cache_root,
            keep_policy=keep_policy,
            not_found_cooldown_seconds=not_found_cooldown_seconds,
            log=log,
        )
    finally:
        try:
            conn.commit()
        except sqlite3.Error:
            pass
    result["station_ref"] = station_ref
    result["day"] = day.isoformat()
    return result


def _check_one_uk_air_sos_station_day(
    conn: sqlite3.Connection,
    env_name: str,
    base_url: str,
    station_ref: str,
    bindings: list[dict[str, Any]],
    day: dt.date,
    cache_root: Path,
    keep_policy: str,
    not_found_cooldown_seconds: int,
    log: logging.Logger,
) -> dict[str, Any]:
    sfk = _uk_air_sos_source_file_key(station_ref, day)
    now_iso = fmt_iso(utc_now())
    prior = _fetch_prior_state(conn, sfk)
    source_location_id = station_ref
    timeseries_ids = sorted({
        int(binding["timeseries_id"])
        for binding in bindings
        if int(binding["timeseries_id"]) > 0
    })
    remote_key = _uk_air_sos_remote_key(base_url, station_ref, day)

    if _should_suppress_uk_air_sos_not_found_retry(
        prior,
        now_iso=now_iso,
        cooldown_seconds=not_found_cooldown_seconds,
    ):
        _upsert_source_state(
            conn=conn,
            source_key=UK_AIR_SOS_SOURCE_KEY,
            remote_scheme=UK_AIR_SOS_REMOTE_SCHEME,
            source_file_key=sfk,
            env_name=env_name,
            remote_url_or_key=remote_key,
            station_ref=station_ref,
            source_location_id=source_location_id,
            day=day,
            exists_remote=False,
            content_length=None,
            etag=None,
            last_modified_utc=None,
            sha256_downloaded=None,
            sha256_uncompressed=None,
            local_cached_path=str(prior.get("local_cached_path") or "") or None,
            now_iso=now_iso,
            last_changed_at=None,
            last_status="not_found_suppressed",
            notes=(
                "uk_air_sos not_found suppressed by cooldown "
                f"({not_found_cooldown_seconds}s)"
            ),
        )
        return {
            "outcome": "not_found_suppressed",
            "snapshot_status": UK_AIR_SOS_STATUS_NOT_FOUND,
            "downloaded_bytes": 0,
            "row_count": 0,
            "event_id": None,
            "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    snapshot = build_uk_air_sos_canonical_snapshot(
        station_ref=station_ref,
        day_utc=day.isoformat(),
        timeseries_bindings=bindings,
        base_url=base_url,
    )
    snapshot_status = str(snapshot.get("status") or "")
    row_count = int(snapshot.get("row_count") or 0)
    ndjson_bytes = snapshot.get("ndjson_bytes") or b""
    sha = snapshot.get("sha256")

    # Temporary/permanent fetch errors: do not overwrite baseline hashes/counts.
    if snapshot_status in {UK_AIR_SOS_STATUS_TEMP_ERROR, UK_AIR_SOS_STATUS_PERM_ERROR}:
        if prior is not None:
            _mark_source_state_fetch_error(
                conn,
                source_file_key=sfk,
                status=snapshot_status,
                now_iso=now_iso,
            )
        event_type = "temporary_error" if snapshot_status == UK_AIR_SOS_STATUS_TEMP_ERROR else "permanent_error"
        event_id = _insert_source_event(
            conn=conn,
            source_key=UK_AIR_SOS_SOURCE_KEY,
            event_type=event_type,
            env_name=env_name,
            source_file_key=sfk,
            remote_url_or_key=remote_key,
            station_ref=station_ref,
            source_location_id=source_location_id,
            day=day,
            prior=prior,
            new_content_length=None,
            new_etag=None,
            new_last_modified_utc=None,
            new_sha256_downloaded=None,
            new_sha256_uncompressed=None,
            downloaded_bytes=0,
            hash_runtime_ms=0,
            now_iso=now_iso,
            notes=str(snapshot.get("error") or "source fetch error"),
        )
        return {
            "outcome": event_type,
            "snapshot_status": snapshot_status,
            "downloaded_bytes": 0,
            "row_count": 0,
            "event_id": event_id,
            "event_type": event_type,
            "timeseries_ids": timeseries_ids,
        }

    # not_found from SOS is a missing source unit (station/day).
    if snapshot_status == UK_AIR_SOS_STATUS_NOT_FOUND:
        if prior is None:
            _upsert_source_state(
                conn=conn,
                source_key=UK_AIR_SOS_SOURCE_KEY,
                remote_scheme=UK_AIR_SOS_REMOTE_SCHEME,
                source_file_key=sfk,
                env_name=env_name,
                remote_url_or_key=remote_key,
                station_ref=station_ref,
                source_location_id=source_location_id,
                day=day,
                exists_remote=False,
                content_length=None,
                etag=None,
                last_modified_utc=None,
                sha256_downloaded=None,
                sha256_uncompressed=None,
                local_cached_path=None,
                now_iso=now_iso,
                last_changed_at=None,
                last_status="missing",
                notes="uk_air_sos snapshot not_found",
            )
            event_id = _insert_source_event(
                conn=conn,
                source_key=UK_AIR_SOS_SOURCE_KEY,
                event_type="missing_first_seen",
                env_name=env_name,
                source_file_key=sfk,
                remote_url_or_key=remote_key,
                station_ref=station_ref,
                source_location_id=source_location_id,
                day=day,
                prior=None,
                new_content_length=None,
                new_etag=None,
                new_last_modified_utc=None,
                new_sha256_downloaded=None,
                new_sha256_uncompressed=None,
                downloaded_bytes=0,
                hash_runtime_ms=0,
                now_iso=now_iso,
                notes="uk_air_sos snapshot not_found",
            )
            return {
                "outcome": "not_found_first_seen",
                "snapshot_status": snapshot_status,
                "downloaded_bytes": 0,
                "row_count": 0,
                "event_id": event_id,
                "event_type": "missing_first_seen",
                "timeseries_ids": timeseries_ids,
            }

        if int(prior.get("exists_remote") or 0) == 1:
            _upsert_source_state(
                conn=conn,
                source_key=UK_AIR_SOS_SOURCE_KEY,
                remote_scheme=UK_AIR_SOS_REMOTE_SCHEME,
                source_file_key=sfk,
                env_name=env_name,
                remote_url_or_key=remote_key,
                station_ref=station_ref,
                source_location_id=source_location_id,
                day=day,
                exists_remote=False,
                content_length=None,
                etag=None,
                last_modified_utc=None,
                sha256_downloaded=None,
                sha256_uncompressed=None,
                local_cached_path=None,
                now_iso=now_iso,
                last_changed_at=now_iso,
                last_status="missing",
                notes="uk_air_sos snapshot not_found",
            )
            event_id = _insert_source_event(
                conn=conn,
                source_key=UK_AIR_SOS_SOURCE_KEY,
                event_type="missing_after_seen",
                env_name=env_name,
                source_file_key=sfk,
                remote_url_or_key=remote_key,
                station_ref=station_ref,
                source_location_id=source_location_id,
                day=day,
                prior=prior,
                new_content_length=None,
                new_etag=None,
                new_last_modified_utc=None,
                new_sha256_downloaded=None,
                new_sha256_uncompressed=None,
                downloaded_bytes=0,
                hash_runtime_ms=0,
                now_iso=now_iso,
                notes="uk_air_sos snapshot not_found after prior success",
            )
            return {
                "outcome": "not_found_after_seen",
                "snapshot_status": snapshot_status,
                "downloaded_bytes": 0,
                "row_count": 0,
                "event_id": event_id,
                "event_type": "missing_after_seen",
                "timeseries_ids": timeseries_ids,
            }

        _upsert_source_state(
            conn=conn,
            source_key=UK_AIR_SOS_SOURCE_KEY,
            remote_scheme=UK_AIR_SOS_REMOTE_SCHEME,
            source_file_key=sfk,
            env_name=env_name,
            remote_url_or_key=remote_key,
            station_ref=station_ref,
            source_location_id=source_location_id,
            day=day,
            exists_remote=False,
            content_length=None,
            etag=None,
            last_modified_utc=None,
            sha256_downloaded=None,
            sha256_uncompressed=None,
            local_cached_path=None,
            now_iso=now_iso,
            last_changed_at=None,
            last_status="missing",
            notes="uk_air_sos snapshot still missing",
        )
        return {
            "outcome": "not_found_still",
            "snapshot_status": snapshot_status,
            "downloaded_bytes": 0,
            "row_count": 0,
            "event_id": None,
            "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    # Successful snapshot (`ok` or `no_data`) path.
    counts_by_ts_id: dict[int, int] = {}
    for row in snapshot.get("rows", []):
        ts_id = int(row.get("timeseries_id") or 0)
        if ts_id <= 0:
            continue
        counts_by_ts_id[ts_id] = counts_by_ts_id.get(ts_id, 0) + 1
    _record_source_file_timeseries_counts(conn, sfk, counts_by_ts_id, now_iso)

    is_first_seen = prior is None
    was_missing = prior is not None and int(prior.get("exists_remote") or 0) == 0
    prior_sha = str(prior.get("sha256_uncompressed") or "") if prior else ""
    content_changed = is_first_seen or (not prior_sha) or prior_sha != str(sha or "")
    state_changed = is_first_seen or was_missing or content_changed

    if not state_changed:
        outcome = "unchanged"
        event_type = None
        last_changed_at = None
    else:
        if is_first_seen:
            outcome = "first_seen"
            event_type = "first_seen"
        elif was_missing:
            outcome = "reappeared"
            event_type = "reappeared"
        else:
            outcome = "changed"
            event_type = "changed"
        last_changed_at = now_iso

    keep_snapshot = (
        keep_policy == "all"
        or (keep_policy == "changed" and outcome in {"changed", "reappeared"})
    )
    cache_path = _uk_air_sos_cache_path(cache_root, station_ref, day)
    local_cached_path: str | None = None
    if keep_snapshot:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(ndjson_bytes)
        local_cached_path = str(cache_path)
    else:
        if cache_path.exists():
            cache_path.unlink(missing_ok=True)

    _upsert_source_state(
        conn=conn,
        source_key=UK_AIR_SOS_SOURCE_KEY,
        remote_scheme=UK_AIR_SOS_REMOTE_SCHEME,
        source_file_key=sfk,
        env_name=env_name,
        remote_url_or_key=remote_key,
        station_ref=station_ref,
        source_location_id=source_location_id,
        day=day,
        exists_remote=True,
        content_length=len(ndjson_bytes),
        etag=None,
        last_modified_utc=None,
        sha256_downloaded=str(sha or ""),
        sha256_uncompressed=str(sha or ""),
        local_cached_path=local_cached_path,
        now_iso=now_iso,
        last_changed_at=last_changed_at,
        last_status=outcome,
        notes=(
            f"uk_air_sos snapshot_status={snapshot_status} row_count={row_count} "
            f"keep_policy={keep_policy}"
        ),
    )

    event_id: int | None = None
    if event_type:
        event_id = _insert_source_event(
            conn=conn,
            source_key=UK_AIR_SOS_SOURCE_KEY,
            event_type=event_type,
            env_name=env_name,
            source_file_key=sfk,
            remote_url_or_key=remote_key,
            station_ref=station_ref,
            source_location_id=source_location_id,
            day=day,
            prior=prior,
            new_content_length=len(ndjson_bytes),
            new_etag=None,
            new_last_modified_utc=None,
            new_sha256_downloaded=str(sha or ""),
            new_sha256_uncompressed=str(sha or ""),
            downloaded_bytes=len(ndjson_bytes),
            hash_runtime_ms=0,
            now_iso=now_iso,
            notes=(
                f"uk_air_sos snapshot_status={snapshot_status} row_count={row_count} "
                f"keep_policy={keep_policy}"
            ),
        )

    return {
        "outcome": outcome,
        "snapshot_status": snapshot_status,
        "downloaded_bytes": len(ndjson_bytes),
        "row_count": row_count,
        "event_id": event_id,
        "event_type": event_type,
        "timeseries_ids": timeseries_ids,
    }


def check_uk_air_sos(
    conn: sqlite3.Connection,
    env_name: str,
    env: dict[str, str],
    from_day: str | None,
    to_day: str | None,
    *,
    dry_run: bool,
    run_backfill: bool,
    limits: LimitTracker,
    log: logging.Logger,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "ran": False,
        "stopped_for": None,
        "stations": 0,
        "stations_checked": 0,
        "station_days_checked": 0,
        "days": 0,
        "head_checked": 0,
        "downloaded": 0,
        "first_seen": 0,
        "changed": 0,
        "reappeared": 0,
        "unchanged_after_download": 0,
        "snapshots_successful": 0,
        "snapshots_no_data": 0,
        "missing": 0,
        "not_found": 0,
        "not_found_suppressed": 0,
        "temporary_errors": 0,
        "permanent_errors": 0,
        "errors": 0,
        "rows_counted": 0,
        "downloaded_bytes": 0,
        "first_seen_files": [],
        "changed_files": [],
        "planned_backfills": [],
        "backfills_attempted": 0,
        "backfills_ok": 0,
        "backfills_failed": 0,
        "keep_api_snapshots_policy": _resolve_keep_api_snapshots_policy(),
        "not_found_cooldown_seconds": _resolve_uk_air_sos_not_found_cooldown_seconds(),
        "skipped_reason": None,
    }
    base_url = os.environ.get(
        "UK_AQ_BACKFILL_UK_AIR_SOS_BASE_URL",
        UK_AIR_SOS_DEFAULT_BASE_URL,
    )

    if not from_day or not to_day:
        metrics["skipped_reason"] = "from_day/to_day not set; manual profile requires both"
        log.warning("uk_air_sos: skipped — %s", metrics["skipped_reason"])
        return metrics

    station_bindings = _uk_air_sos_station_bindings(conn)
    stations = sorted(station_bindings.keys())
    if not stations:
        metrics["skipped_reason"] = "no uk_air_sos active station/timeseries bindings in source_station_timeseries_lookup"
        log.warning("uk_air_sos: skipped — %s", metrics["skipped_reason"])
        return metrics

    days = _date_range_inclusive(from_day, to_day)
    if not days:
        metrics["skipped_reason"] = f"empty date range {from_day}..{to_day}"
        log.warning("uk_air_sos: skipped — %s", metrics["skipped_reason"])
        return metrics

    metrics["stations"] = len(stations)
    metrics["days"] = len(days)
    metrics["stations_checked"] = len(stations)
    metrics["ran"] = True

    log.info(
        "uk_air_sos: starting stations=%s days=%s base_url=%s keep_api_snapshots=%s not_found_cooldown_seconds=%s%s",
        len(stations),
        len(days),
        base_url,
        metrics["keep_api_snapshots_policy"],
        metrics["not_found_cooldown_seconds"],
        " (dry-run)" if dry_run else "",
    )
    if run_backfill:
        log.info("uk_air_sos: direct backfill is disabled in Phase 7.3 (cross-check-driven repair only)")

    if dry_run:
        sample = []
        for station in stations[:3]:
            for day in days[:2]:
                sample.append(_uk_air_sos_remote_key(base_url, station, day))
        metrics["sample_urls"] = sample
        log.info(
            "uk_air_sos dry-run: would check %s station/day units; sample=%s",
            len(stations) * len(days),
            sample[:6],
        )
        return metrics

    cache_root = Path(env["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"]) / UK_AIR_SOS_SOURCE_KEY
    cache_root.mkdir(parents=True, exist_ok=True)
    db_path = env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures: list[concurrent.futures.Future] = []
        for station_ref in stations:
            if limits.should_stop():
                break
            bindings = station_bindings.get(station_ref) or []
            if not bindings:
                continue
            for day in days:
                if limits.should_stop():
                    break
                futures.append(ex.submit(
                    _check_one_uk_air_sos_station_day_threadsafe,
                    db_path,
                    env_name,
                    base_url,
                    station_ref,
                    bindings,
                    day,
                    cache_root,
                    metrics["keep_api_snapshots_policy"],
                    int(metrics["not_found_cooldown_seconds"] or 0),
                    log,
                    limits,
                ))
        total_tasks = len(futures)
        completed_tasks = 0
        progress = SingleLineProgress("uk_air_sos progress")
        progress.update(
            (
                f"0/{total_tasks} checked=0 changed=0 downloaded=0 "
                f"missing=0 errors=0 planned_backfills=0"
            ),
            force=True,
        )

        for fut in concurrent.futures.as_completed(futures):
            completed_tasks += 1
            try:
                result = fut.result()
            except Exception as exc:
                metrics["errors"] += 1
                log.warning("uk_air_sos worker raised: %s", exc)
                progress.update(
                    (
                        f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                        f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                        f"missing={metrics['missing']} errors={metrics['errors']} "
                        f"planned_backfills=0"
                    ),
                )
                continue

            outcome = result.get("outcome")
            if outcome == "stopped":
                progress.update(
                    (
                        f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                        f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                        f"missing={metrics['missing']} errors={metrics['errors']} "
                        f"planned_backfills=0 stopped_for={limits.stopped_for or 'n/a'}"
                    ),
                )
                continue

            metrics["head_checked"] += 1
            metrics["station_days_checked"] += 1
            metrics["rows_counted"] += int(result.get("row_count") or 0)
            metrics["downloaded_bytes"] += int(result.get("downloaded_bytes") or 0)
            snapshot_status = str(result.get("snapshot_status") or "")
            if snapshot_status in {UK_AIR_SOS_STATUS_OK, UK_AIR_SOS_STATUS_NO_DATA}:
                metrics["snapshots_successful"] += 1
                if snapshot_status == UK_AIR_SOS_STATUS_NO_DATA:
                    metrics["snapshots_no_data"] += 1
            elif snapshot_status == UK_AIR_SOS_STATUS_NOT_FOUND:
                metrics["not_found"] += 1

            if outcome == "first_seen":
                metrics["downloaded"] += 1
                metrics["first_seen"] += 1
                metrics["first_seen_files"].append({
                    "station_ref": result["station_ref"],
                    "day": result["day"],
                    "event_id": result["event_id"],
                    "event_type": result["event_type"],
                    "timeseries_ids": result["timeseries_ids"],
                })
            elif outcome == "reappeared":
                metrics["downloaded"] += 1
                metrics["changed"] += 1
                metrics["reappeared"] += 1
                metrics["changed_files"].append({
                    "station_ref": result["station_ref"],
                    "day": result["day"],
                    "event_id": result["event_id"],
                    "event_type": result["event_type"],
                    "timeseries_ids": result["timeseries_ids"],
                })
            elif outcome == "changed":
                metrics["downloaded"] += 1
                metrics["changed"] += 1
                metrics["changed_files"].append({
                    "station_ref": result["station_ref"],
                    "day": result["day"],
                    "event_id": result["event_id"],
                    "event_type": result["event_type"],
                    "timeseries_ids": result["timeseries_ids"],
                })
            elif outcome == "unchanged":
                metrics["downloaded"] += 1
                metrics["unchanged_after_download"] += 1
            elif outcome in {"not_found_first_seen", "not_found_after_seen", "not_found_still"}:
                metrics["missing"] += 1
            elif outcome == "not_found_suppressed":
                metrics["missing"] += 1
                metrics["not_found_suppressed"] += 1
            elif outcome == "temporary_error":
                metrics["temporary_errors"] += 1
                metrics["errors"] += 1
            elif outcome == "permanent_error":
                metrics["permanent_errors"] += 1
                metrics["errors"] += 1
            else:
                metrics["errors"] += 1

            progress.update(
                (
                    f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                    f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
                    f"missing={metrics['missing']} errors={metrics['errors']} "
                    f"planned_backfills=0"
                ),
            )

    progress.update(
        (
            f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
            f"changed={metrics['changed']} downloaded={metrics['downloaded']} "
            f"missing={metrics['missing']} errors={metrics['errors']} planned_backfills=0"
        ),
        force=True,
    )
    progress.finish()

    metrics["first_seen_files"].sort(key=lambda e: (e["day"], e["station_ref"]))
    metrics["changed_files"].sort(key=lambda e: (e["day"], e["station_ref"]))

    if limits.should_stop():
        metrics["stopped_for"] = limits.stopped_for
        log.warning("uk_air_sos: stopped early due to limit=%s", limits.stopped_for)

    log.info(
        "uk_air_sos: done %s",
        {
            k: v
            for k, v in metrics.items()
            if k not in ("first_seen_files", "changed_files", "sample_urls")
        },
    )
    return metrics


R2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX = "history/_index/observations_timeseries"
R2_AQILEVELS_PREFIX = "history/v1/aqilevels"
AQILEVELS_EXPECTED_HISTORY_SCHEMA_NAME = "aqilevels"
AQILEVELS_EXPECTED_HISTORY_SCHEMA_VERSION = 2
AQILEVELS_EXPECTED_WRITER_VERSION = "parquet-wasm-zstd-v2"
CROSS_CHECK_MAX_REPORT_DISCREPANCIES = 250


def _normalize_timeseries_row_counts(raw: Any) -> dict[int, int]:
    if not isinstance(raw, dict):
        return {}
    out: dict[int, int] = {}
    for raw_ts_id, raw_count in raw.items():
        try:
            ts_id = int(str(raw_ts_id).strip())
        except (TypeError, ValueError):
            continue
        if ts_id <= 0:
            continue
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count < 0:
            continue
        out[ts_id] = count
    return out


def _read_r2_timeseries_manifest_counts(
    r2_history_root: Path,
    manifest_prefix: str,
    day_utc: str,
    connector_id: int,
) -> tuple[dict[int, int] | None, str | None, str | None]:
    manifest_path = (
        r2_history_root
        / manifest_prefix
        / f"day_utc={day_utc}"
        / f"connector_id={int(connector_id)}"
        / "manifest.json"
    )
    if not manifest_path.is_file():
        return None, f"manifest_missing:{manifest_path}", None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, f"manifest_invalid_json:{manifest_path}:{exc}", None
    if "timeseries_row_counts" not in payload:
        return {}, None, "timeseries_row_counts_missing"
    raw_counts = payload.get("timeseries_row_counts")
    if not isinstance(raw_counts, dict):
        return {}, None, "timeseries_row_counts_invalid_type"
    counts = _normalize_timeseries_row_counts(raw_counts)
    if not raw_counts:
        return counts, None, "timeseries_row_counts_empty_object"
    if not counts:
        return counts, None, "timeseries_row_counts_unusable_entries"
    return counts, None, None


def run_r2_cross_checks(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    env_name: str,
    source_filter: str,
    from_day: str | None,
    to_day: str | None,
    r2_history_root: str | None,
    r2_manifest_prefix: str | None,
    checked_at_utc: str,
    log: logging.Logger,
) -> dict[str, Any]:
    """Phase 6.5 Pass B: compare source_file_timeseries_counts against local
    R2 observations_timeseries index manifests.
    """
    if not r2_history_root:
        raise RuntimeError("UK_AQ_R2_HISTORY_DROPBOX_ROOT is not set")
    root = Path(r2_history_root)
    if not root.is_dir():
        raise RuntimeError(f"UK_AQ_R2_HISTORY_DROPBOX_ROOT is not a directory: {root}")
    manifest_prefix = (
        str(r2_manifest_prefix or R2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX)
        .strip()
        .strip("/")
    )
    if not manifest_prefix:
        raise RuntimeError("R2 observations_timeseries manifest prefix is empty")

    source_keys = CROSS_CHECK_SOURCE_KEYS_BY_FILTER.get(
        source_filter,
        CROSS_CHECK_SOURCE_KEYS_BY_FILTER["all"],
    )

    where = [
        "s.env_name = ?",
        "s.day_utc IS NOT NULL",
        "c.row_count > 0",
        f"s.source_key IN ({','.join('?' for _ in source_keys)})",
    ]
    params: list[Any] = [env_name, *source_keys]
    if from_day:
        where.append("s.day_utc >= ?")
        params.append(from_day)
    if to_day:
        where.append("s.day_utc <= ?")
        params.append(to_day)
    where_sql = " AND ".join(where)

    rows = conn.execute(
        f"""
        SELECT
          l.connector_id,
          s.day_utc,
          c.timeseries_id,
          SUM(c.row_count) AS source_row_count
        FROM source_file_timeseries_counts c
        JOIN source_file_state s
          ON s.source_file_key = c.source_file_key
        JOIN source_station_timeseries_lookup l
          ON l.source_key = s.source_key
         AND l.source_location_id = s.source_location_id
         AND l.timeseries_id = c.timeseries_id
        WHERE {where_sql}
        GROUP BY l.connector_id, s.day_utc, c.timeseries_id
        ORDER BY s.day_utc, l.connector_id, c.timeseries_id
        """,
        tuple(params),
    ).fetchall()

    grouped: dict[tuple[str, int], dict[int, int]] = {}
    for connector_id, day_utc, timeseries_id, source_row_count in rows:
        if not day_utc:
            continue
        key = (str(day_utc), int(connector_id))
        per_ts = grouped.setdefault(key, {})
        per_ts[int(timeseries_id)] = int(source_row_count or 0)

    status_counts = {
        "ok": 0,
        "mismatch": 0,
        "source_only": 0,
        "r2_only": 0,
        "r2_manifest_missing": 0,
        "r2_timeseries_counts_missing": 0,
    }
    discrepancy_total = 0
    discrepancies: list[dict[str, Any]] = []
    insert_rows: list[tuple[Any, ...]] = []
    manifest_missing_days = 0
    counts_missing_days = 0

    for day_utc, connector_id in sorted(grouped.keys()):
        source_counts = grouped[(day_utc, connector_id)]
        r2_counts, manifest_error, counts_missing_reason = _read_r2_timeseries_manifest_counts(
            root, manifest_prefix, day_utc, connector_id,
        )
        if r2_counts is None:
            manifest_missing_days += 1
            for timeseries_id, source_row_count in sorted(source_counts.items()):
                status = "r2_manifest_missing"
                status_counts[status] += 1
                discrepancy_total += 1
                entry = {
                    "status": status,
                    "connector_id": connector_id,
                    "day_utc": day_utc,
                    "timeseries_id": timeseries_id,
                    "source_row_count": source_row_count,
                    "r2_row_count": None,
                    "delta": None,
                    "notes": manifest_error,
                }
                if len(discrepancies) < CROSS_CHECK_MAX_REPORT_DISCREPANCIES:
                    discrepancies.append(entry)
                insert_rows.append((
                    run_id, env_name, connector_id, day_utc, timeseries_id,
                    source_row_count, None, None, status, checked_at_utc,
                    manifest_error,
                ))
            continue
        if counts_missing_reason:
            counts_missing_days += 1
            for timeseries_id, source_row_count in sorted(source_counts.items()):
                status = "r2_timeseries_counts_missing"
                status_counts[status] += 1
                discrepancy_total += 1
                notes = (
                    "timeseries_row_counts missing/invalid in R2 manifest "
                    f"({counts_missing_reason}); metadata enrichment required before cross-check repair"
                )
                entry = {
                    "status": status,
                    "connector_id": connector_id,
                    "day_utc": day_utc,
                    "timeseries_id": timeseries_id,
                    "source_row_count": source_row_count,
                    "r2_row_count": None,
                    "delta": None,
                    "notes": notes,
                }
                if len(discrepancies) < CROSS_CHECK_MAX_REPORT_DISCREPANCIES:
                    discrepancies.append(entry)
                insert_rows.append((
                    run_id, env_name, connector_id, day_utc, timeseries_id,
                    source_row_count, None, None, status, checked_at_utc,
                    notes,
                ))
            continue

        for timeseries_id in sorted(set(source_counts) | set(r2_counts)):
            source_row_count = source_counts.get(timeseries_id)
            r2_row_count = r2_counts.get(timeseries_id)
            delta: int | None
            notes: str | None = None
            if source_row_count is None and r2_row_count is None:
                continue
            if source_row_count is None:
                status = "r2_only"
                delta = -int(r2_row_count or 0)
                notes = "timeseries present in R2 manifest but absent from source counts"
            elif r2_row_count is None:
                status = "source_only"
                delta = int(source_row_count)
                notes = "timeseries present in source counts but absent from R2 manifest"
            else:
                delta = int(source_row_count) - int(r2_row_count)
                status = "ok" if delta == 0 else "mismatch"

            status_counts[status] += 1
            insert_rows.append((
                run_id,
                env_name,
                connector_id,
                day_utc,
                timeseries_id,
                source_row_count,
                r2_row_count,
                delta,
                status,
                checked_at_utc,
                notes,
            ))
            if status != "ok":
                discrepancy_total += 1
                entry = {
                    "status": status,
                    "connector_id": connector_id,
                    "day_utc": day_utc,
                    "timeseries_id": timeseries_id,
                    "source_row_count": source_row_count,
                    "r2_row_count": r2_row_count,
                    "delta": delta,
                    "notes": notes,
                }
                if len(discrepancies) < CROSS_CHECK_MAX_REPORT_DISCREPANCIES:
                    discrepancies.append(entry)

    if insert_rows:
        conn.executemany(
            """
            INSERT INTO cross_checks (
              run_id, env_name, connector_id, day_utc, timeseries_id,
              source_row_count, r2_row_count, delta, status, checked_at_utc, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            insert_rows,
        )
        conn.commit()

    discrepancies.sort(
        key=lambda e: (
            str(e.get("day_utc") or ""),
            int(e.get("connector_id") or 0),
            int(e.get("timeseries_id") or 0),
            str(e.get("status") or ""),
        )
    )

    metrics = {
        "ran": True,
        "skipped_reason": None,
        "source_rows": len(rows),
        "connector_days": len(grouped),
        "manifests_missing_days": manifest_missing_days,
        "timeseries_counts_missing_days": counts_missing_days,
        "cross_checks_total": sum(status_counts.values()),
        "cross_checks_ok": status_counts["ok"],
        "cross_checks_mismatch": status_counts["mismatch"],
        "cross_checks_source_only": status_counts["source_only"],
        "cross_checks_r2_only": status_counts["r2_only"],
        "cross_checks_r2_manifest_missing": status_counts["r2_manifest_missing"],
        "cross_checks_r2_timeseries_counts_missing": status_counts["r2_timeseries_counts_missing"],
        "discrepancy_total": discrepancy_total,
        "discrepancies_truncated_to": CROSS_CHECK_MAX_REPORT_DISCREPANCIES,
        "discrepancies": discrepancies,
        "r2_history_root": str(root),
        "manifest_prefix": manifest_prefix,
    }
    log.info(
        "cross-check done total=%s ok=%s mismatch=%s source_only=%s r2_only=%s manifest_missing=%s counts_missing=%s connector_days=%s source_rows=%s",
        metrics["cross_checks_total"],
        metrics["cross_checks_ok"],
        metrics["cross_checks_mismatch"],
        metrics["cross_checks_source_only"],
        metrics["cross_checks_r2_only"],
        metrics["cross_checks_r2_manifest_missing"],
        metrics["cross_checks_r2_timeseries_counts_missing"],
        metrics["connector_days"],
        metrics["source_rows"],
    )
    return metrics


def _collect_cross_check_backfill_targets(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    source_filter: str = "all",
    statuses: tuple[str, ...] = ("mismatch", "source_only", "r2_manifest_missing"),
) -> dict[tuple[str, int], list[int]]:
    if not statuses:
        return {}
    connector_codes = CROSS_CHECK_BACKFILL_CONNECTOR_CODES_BY_FILTER.get(
        source_filter,
        CROSS_CHECK_BACKFILL_CONNECTOR_CODES_BY_FILTER["all"],
    )
    if not connector_codes:
        return {}
    placeholders = ",".join("?" for _ in statuses)
    connector_placeholders = ",".join("?" for _ in connector_codes)
    rows = conn.execute(
        f"""
        SELECT x.day_utc, x.connector_id, x.timeseries_id
        FROM cross_checks x
        JOIN core_connectors_snapshot c ON c.id = x.connector_id
        WHERE x.run_id = ?
          AND x.status IN ({placeholders})
          AND x.day_utc IS NOT NULL
          AND c.connector_code IN ({connector_placeholders})
        ORDER BY x.day_utc, x.connector_id, x.timeseries_id
        """,
        (run_id, *statuses, *connector_codes),
    ).fetchall()
    grouped: dict[tuple[str, int], set[int]] = {}
    for day_utc, connector_id, ts_id in rows:
        if not day_utc:
            continue
        try:
            parsed_connector_id = int(connector_id)
        except (TypeError, ValueError):
            continue
        if parsed_connector_id <= 0:
            continue
        try:
            parsed = int(ts_id)
        except (TypeError, ValueError):
            continue
        if parsed <= 0:
            continue
        grouped.setdefault((str(day_utc), parsed_connector_id), set()).add(parsed)
    return {
        key: sorted(values)
        for key, values in sorted(grouped.items(), key=lambda item: item[0])
    }


def _collect_uk_air_sos_source_change_targets(
    conn: sqlite3.Connection,
    *,
    source_filter: str,
    uk_air_sos_metrics: Mapping[str, Any] | None,
) -> dict[tuple[str, int], list[int]]:
    """Build connector/day -> timeseries IDs from SOS changed/reappeared rows.

    Phase 7.4 uses these as additional observation-repair candidates so
    source content changes can be repaired even when row-count parity happens
    to match R2.
    """
    if source_filter not in {"uk_air_sos", "all"}:
        return {}
    changed_files = (uk_air_sos_metrics or {}).get("changed_files") or []
    if not isinstance(changed_files, list) or not changed_files:
        return {}

    candidate_pairs: list[tuple[str, int]] = []
    timeseries_ids_set: set[int] = set()
    for entry in changed_files:
        if not isinstance(entry, dict):
            continue
        day_utc = str(entry.get("day") or "").strip()
        if not day_utc:
            continue
        try:
            dt.date.fromisoformat(day_utc)
        except ValueError:
            continue
        raw_ids = entry.get("timeseries_ids")
        if not isinstance(raw_ids, list):
            continue
        for raw_id in raw_ids:
            try:
                ts_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            if ts_id <= 0:
                continue
            candidate_pairs.append((day_utc, ts_id))
            timeseries_ids_set.add(ts_id)

    if not candidate_pairs:
        return {}

    placeholders = ",".join("?" for _ in timeseries_ids_set)
    rows = conn.execute(
        f"""
        SELECT t.id, t.connector_id
        FROM core_timeseries_snapshot t
        JOIN core_connectors_snapshot c ON c.id = t.connector_id
        WHERE t.id IN ({placeholders})
          AND c.connector_code = ?
        """,
        (*sorted(timeseries_ids_set), UK_AIR_SOS_SOURCE_KEY),
    ).fetchall()
    ts_to_connector: dict[int, int] = {}
    for ts_id, connector_id in rows:
        try:
            parsed_ts = int(ts_id)
            parsed_connector = int(connector_id)
        except (TypeError, ValueError):
            continue
        if parsed_ts > 0 and parsed_connector > 0:
            ts_to_connector[parsed_ts] = parsed_connector

    grouped: dict[tuple[str, int], set[int]] = {}
    for day_utc, ts_id in candidate_pairs:
        connector_id = ts_to_connector.get(ts_id)
        if connector_id is None:
            continue
        grouped.setdefault((day_utc, connector_id), set()).add(ts_id)
    return {
        key: sorted(values)
        for key, values in sorted(grouped.items(), key=lambda item: item[0])
    }


def _merge_observation_repair_targets(
    cross_check_targets: Mapping[tuple[str, int], list[int]] | None,
    source_change_targets: Mapping[tuple[str, int], list[int]] | None,
) -> tuple[dict[tuple[str, int], list[int]], dict[tuple[str, int], list[str]]]:
    """Deduplicate repair targets by (day_utc, connector_id, timeseries_id)."""
    merged: dict[tuple[str, int], set[int]] = {}
    origins: dict[tuple[str, int], set[str]] = {}

    for key, ids in (cross_check_targets or {}).items():
        bucket = merged.setdefault(key, set())
        for raw_ts in ids:
            try:
                ts_id = int(raw_ts)
            except (TypeError, ValueError):
                continue
            if ts_id > 0:
                bucket.add(ts_id)
        origins.setdefault(key, set()).add("cross_check")
    for key, ids in (source_change_targets or {}).items():
        bucket = merged.setdefault(key, set())
        for raw_ts in ids:
            try:
                ts_id = int(raw_ts)
            except (TypeError, ValueError):
                continue
            if ts_id > 0:
                bucket.add(ts_id)
        origins.setdefault(key, set()).add("source_change")

    merged_sorted = {
        key: sorted(values)
        for key, values in sorted(merged.items(), key=lambda item: item[0])
        if values
    }
    origins_sorted = {
        key: sorted(values)
        for key, values in sorted(origins.items(), key=lambda item: item[0])
        if key in merged_sorted
    }
    return merged_sorted, origins_sorted


def _parse_csv_ints(value: str | None) -> set[int]:
    out: set[int] = set()
    if not value:
        return out
    for token in str(value).split(","):
        cleaned = token.strip()
        if not cleaned:
            continue
        try:
            parsed = int(cleaned)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            out.add(parsed)
    return out


def _parse_reason_tokens(reason: str | None) -> set[str]:
    out: set[str] = set()
    if not reason:
        return out
    normalized = str(reason).replace("|", ",")
    for token in normalized.split(","):
        cleaned = token.strip()
        if cleaned:
            out.add(cleaned)
    return out


def _merge_reason_tokens(existing: str | None, incoming: str) -> str:
    merged = _parse_reason_tokens(existing)
    merged.update(_parse_reason_tokens(incoming))
    if not merged:
        return incoming
    return ",".join(sorted(merged))


def _merge_csv_ids(existing: str | None, new_ids: list[int]) -> str | None:
    merged = _parse_csv_ints(existing)
    for ts_id in new_ids:
        if int(ts_id) > 0:
            merged.add(int(ts_id))
    if not merged:
        return None
    return ",".join(str(ts_id) for ts_id in sorted(merged))


def _merge_notes(existing: str | None, extra: str | None) -> str | None:
    base = (existing or "").strip()
    add = (extra or "").strip()
    if not base:
        return add or None
    if not add:
        return base
    if add in base:
        return base
    return f"{base} | {add}"


def _queue_aqi_rebuild(
    *,
    conn: sqlite3.Connection,
    run_id: int,
    env_name: str,
    connector_id: int,
    day_utc: str,
    reason: str,
    source_mode: str,
    requested_timeseries_ids: list[int],
    queue_note: str | None,
    log: logging.Logger,
) -> str:
    now_iso = fmt_iso(utc_now())
    merged_ids_csv = _merge_csv_ids(None, requested_timeseries_ids)

    existing = conn.execute(
        """
        SELECT id, reason, source_mode, requested_timeseries_ids, notes
        FROM aqi_rebuild_queue
        WHERE run_id = ? AND connector_id = ? AND day_utc = ?
        """,
        (run_id, connector_id, day_utc),
    ).fetchone()

    if existing is None:
        conn.execute(
            """
            INSERT INTO aqi_rebuild_queue (
              run_id, env_name, connector_id, day_utc,
              reason, source_mode, status,
              requested_timeseries_ids, notes,
              created_at_utc, started_at_utc, finished_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
            """,
            (
                run_id,
                env_name,
                connector_id,
                day_utc,
                reason,
                source_mode,
                "queued",
                merged_ids_csv,
                queue_note,
                now_iso,
            ),
        )
        conn.commit()
        log.info(
            "queued AQI rebuild run_id=%s connector_id=%s day=%s reason=%s source_mode=%s",
            run_id,
            connector_id,
            day_utc,
            reason,
            source_mode,
        )
        return "inserted"

    queue_id, existing_reason, existing_source_mode, existing_ids_csv, existing_notes = existing
    updated_ids_csv = _merge_csv_ids(existing_ids_csv, requested_timeseries_ids)
    updated_notes = _merge_notes(existing_notes, queue_note)
    merged_reason = _merge_reason_tokens(existing_reason, reason)
    merged_source_mode = existing_source_mode or source_mode
    conn.execute(
        """
        UPDATE aqi_rebuild_queue
        SET reason = ?,
            source_mode = ?,
            requested_timeseries_ids = ?,
            notes = ?
        WHERE id = ?
        """,
        (merged_reason, merged_source_mode, updated_ids_csv, updated_notes, int(queue_id)),
    )
    conn.commit()
    log.info(
        "merged AQI rebuild queue row id=%s connector_id=%s day=%s reason=%s",
        queue_id,
        connector_id,
        day_utc,
        merged_reason,
    )
    return "merged"


def _queue_aqi_rebuild_from_obs_repair(
    *,
    conn: sqlite3.Connection,
    run_id: int,
    env_name: str,
    connector_id: int,
    day_utc: str,
    requested_timeseries_ids: list[int],
    queue_note: str | None,
    log: logging.Logger,
) -> str:
    return _queue_aqi_rebuild(
        conn=conn,
        run_id=run_id,
        env_name=env_name,
        connector_id=connector_id,
        day_utc=day_utc,
        reason="obs_repaired",
        source_mode="live_r2",
        requested_timeseries_ids=requested_timeseries_ids,
        queue_note=queue_note,
        log=log,
    )


def run_cross_check_backfills(
    *,
    conn: sqlite3.Connection,
    run_id: int,
    env_name: str,
    run_compact: str,
    env: dict[str, str],
    source_filter: str,
    uk_air_sos_metrics: Mapping[str, Any] | None,
    dry_run: bool,
    run_backfill: bool,
    limits: LimitTracker,
    log: logging.Logger,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "observation_backfill_candidate_days": 0,
        "observation_backfill_candidate_timeseries_ids": 0,
        "observation_backfills_attempted": 0,
        "observation_backfills_ok": 0,
        "observation_backfills_failed": 0,
        "aqi_rebuilds_queued_from_obs_repair": 0,
        "source_change_candidate_days": 0,
        "source_change_candidate_timeseries_ids": 0,
        "planned_observation_backfills": [],
        "planned_aqi_rebuilds": [],
        "planned_aqi_rebuild_connector_days": [],
        # Backward-compatible aliases used by existing reports/notes.
        "backfill_candidate_days": 0,
        "backfill_candidate_timeseries_ids": 0,
        "backfills_attempted": 0,
        "backfills_ok": 0,
        "backfills_failed": 0,
        "planned_backfills": [],
    }
    if not run_backfill:
        return metrics

    cross_check_targets = _collect_cross_check_backfill_targets(
        conn,
        run_id=run_id,
        source_filter=source_filter,
    )
    source_change_targets = _collect_uk_air_sos_source_change_targets(
        conn,
        source_filter=source_filter,
        uk_air_sos_metrics=uk_air_sos_metrics,
    )
    metrics["source_change_candidate_days"] = len(
        {day_iso for day_iso, _ in source_change_targets.keys()}
    )
    metrics["source_change_candidate_timeseries_ids"] = sum(
        len(ids) for ids in source_change_targets.values()
    )
    targets_by_day_connector, origins_by_day_connector = _merge_observation_repair_targets(
        cross_check_targets,
        source_change_targets,
    )
    metrics["observation_backfill_candidate_days"] = len(
        {day_iso for day_iso, _ in targets_by_day_connector.keys()}
    )
    metrics["observation_backfill_candidate_timeseries_ids"] = sum(
        len(ids) for ids in targets_by_day_connector.values()
    )
    metrics["backfill_candidate_days"] = metrics["observation_backfill_candidate_days"]
    metrics["backfill_candidate_timeseries_ids"] = metrics["observation_backfill_candidate_timeseries_ids"]
    if not targets_by_day_connector:
        log.info(
            "cross-check observation repair: no candidates (cross-check or source-change) for run_id=%s source=%s",
            run_id,
            source_filter,
        )
        return metrics

    backfill_log_dir = (
        Path(env["UK_AQ_HISTORY_INTEGRITY_LOG_DIR"]) / "backfill" / run_compact
    )
    queued_aqi_rebuild_keys: set[tuple[str, int]] = set()
    for (day_iso, connector_id), ts_ids in sorted(targets_by_day_connector.items()):
        origins = origins_by_day_connector.get((day_iso, connector_id), ["cross_check"])
        day_obj = dt.date.fromisoformat(day_iso)
        cmd = _planned_backfill_command(
            env,
            ts_ids,
            day_obj,
            connector_ids=[connector_id],
            output_scope="observations_only",
        )
        metrics["planned_observation_backfills"].append(cmd)
        metrics["planned_backfills"].append(cmd)
        log.info("cross-check planned observation repair: %s", cmd)
        queue_entry = (
            f"connector_id={connector_id} day_utc={day_iso} reason=obs_repaired "
            f"source_mode=live_r2 origins={','.join(origins)} "
            f"timeseries_ids={','.join(str(ts_id) for ts_id in ts_ids)}"
        )
        metrics["planned_aqi_rebuilds"].append(queue_entry)
        metrics["planned_aqi_rebuild_connector_days"].append({
            "day_utc": day_iso,
            "connector_id": connector_id,
            "reasons": ["obs_repaired"],
            "notes": queue_entry,
        })
        if dry_run:
            queued_aqi_rebuild_keys.add((day_iso, connector_id))
            continue
        if limits.should_stop():
            log.warning(
                "cross-check observation repair: stopping early due to limit=%s",
                limits.stopped_for,
            )
            break
        chunks = _chunk_timeseries_ids(ts_ids)
        try_unchunked_first = _is_truthy(
            os.environ.get(_TRY_UNCHUNKED_FIRST_ENV_VAR, "1"),
        )
        if len(chunks) > 1 and try_unchunked_first:
            log.info(
                "cross-check observation repair: trying unchunked first day=%s connector=%s total_timeseries_ids=%s",
                day_iso,
                connector_id,
                len(ts_ids),
            )
            unchunked_label = f"cc_day_{day_iso}_connector_{connector_id}_unchunked_first"
            bf = run_narrow_backfill(
                wrapper_path=resolve_integrity_backfill_wrapper(),
                env_file_path=os.environ.get("UK_AQ_BACKFILL_ENV_FILE"),
                env_name=env_name,
                timeseries_ids=ts_ids,
                connector_ids=[connector_id],
                day=day_obj,
                log=log,
                log_dir=backfill_log_dir,
                log_label=unchunked_label,
                output_scope="observations_only",
            )
            metrics["observation_backfills_attempted"] += 1
            metrics["backfills_attempted"] += 1
            if bf["status"] == "ok":
                metrics["observation_backfills_ok"] += 1
                metrics["backfills_ok"] += 1
                queued = _queue_aqi_rebuild_from_obs_repair(
                    conn=conn,
                    run_id=run_id,
                    env_name=env_name,
                    connector_id=connector_id,
                    day_utc=day_iso,
                    requested_timeseries_ids=ts_ids,
                    queue_note=(
                        f"queued_from_cross_check day={day_iso} connector_id={connector_id} origins={','.join(origins)}"
                    ),
                    log=log,
                )
                if queued in {"inserted", "merged"}:
                    if queued == "inserted":
                        queued_aqi_rebuild_keys.add((day_iso, connector_id))
                continue
            metrics["observation_backfills_failed"] += 1
            metrics["backfills_failed"] += 1
            log.warning(
                "cross-check observation repair: unchunked attempt failed; falling back to chunked mode day=%s connector=%s status=%s",
                day_iso,
                connector_id,
                bf.get("status"),
            )
        if len(chunks) > 1:
            log.info(
                "cross-check observation repair: chunking day=%s connector=%s "
                "total_timeseries_ids=%s chunks=%s",
                day_iso, connector_id, len(ts_ids), len(chunks),
            )
        stage_root = (
            backfill_log_dir
            / "_targeted_stage"
            / f"run_{run_id}"
            / f"day_{day_iso}"
            / f"connector_{connector_id}"
        )
        if len(chunks) > 1:
            shutil.rmtree(stage_root, ignore_errors=True)
        all_chunks_ok = True
        for chunk_index, chunk_ids in enumerate(chunks, start=1):
            chunk_label = (
                f"cc_day_{day_iso}_connector_{connector_id}" if len(chunks) == 1
                else f"cc_day_{day_iso}_connector_{connector_id}_chunk_{chunk_index}_of_{len(chunks)}"
            )
            extra_env: dict[str, str] | None = None
            if len(chunks) > 1:
                extra_env = {
                    "UK_AQ_BACKFILL_TARGETED_STAGE_ENABLED": "true",
                    "UK_AQ_BACKFILL_TARGETED_STAGE_ROOT": str(stage_root),
                    "UK_AQ_BACKFILL_TARGETED_STAGE_FINALIZE": (
                        "true" if chunk_index == len(chunks) else "false"
                    ),
                    "UK_AQ_BACKFILL_TARGETED_STAGE_CLEANUP": (
                        "true" if chunk_index == len(chunks) else "false"
                    ),
                }
            bf = run_narrow_backfill(
                wrapper_path=resolve_integrity_backfill_wrapper(),
                env_file_path=os.environ.get("UK_AQ_BACKFILL_ENV_FILE"),
                env_name=env_name,
                timeseries_ids=chunk_ids,
                connector_ids=[connector_id],
                day=day_obj,
                log=log,
                log_dir=backfill_log_dir,
                log_label=chunk_label,
                output_scope="observations_only",
                extra_env=extra_env,
            )
            metrics["observation_backfills_attempted"] += 1
            metrics["backfills_attempted"] += 1
            if bf["status"] == "ok":
                metrics["observation_backfills_ok"] += 1
                metrics["backfills_ok"] += 1
            else:
                metrics["observation_backfills_failed"] += 1
                metrics["backfills_failed"] += 1
                all_chunks_ok = False
        if all_chunks_ok:
            queued = _queue_aqi_rebuild_from_obs_repair(
                conn=conn,
                run_id=run_id,
                env_name=env_name,
                connector_id=connector_id,
                day_utc=day_iso,
                requested_timeseries_ids=ts_ids,
                queue_note=(
                    f"queued_from_cross_check day={day_iso} connector_id={connector_id} origins={','.join(origins)}"
                ),
                log=log,
            )
            if queued in {"inserted", "merged"}:
                if queued == "inserted":
                    queued_aqi_rebuild_keys.add((day_iso, connector_id))

    metrics["aqi_rebuilds_queued_from_obs_repair"] = len(queued_aqi_rebuild_keys)

    log.info(
        "cross-check observation-repair: candidate_days=%s candidate_timeseries_ids=%s source_change_days=%s source_change_timeseries_ids=%s attempted=%s ok=%s failed=%s queued_aqi_rebuilds=%s",
        metrics["observation_backfill_candidate_days"],
        metrics["observation_backfill_candidate_timeseries_ids"],
        metrics["source_change_candidate_days"],
        metrics["source_change_candidate_timeseries_ids"],
        metrics["observation_backfills_attempted"],
        metrics["observation_backfills_ok"],
        metrics["observation_backfills_failed"],
        metrics["aqi_rebuilds_queued_from_obs_repair"],
    )
    return metrics


def _safe_non_negative_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return parsed


def _load_obs_repaired_queue_keys(
    conn: sqlite3.Connection,
    *,
    run_id: int,
) -> set[tuple[str, int]]:
    keys: set[tuple[str, int]] = set()
    rows = conn.execute(
        """
        SELECT day_utc, connector_id, reason
        FROM aqi_rebuild_queue
        WHERE run_id = ?
        """,
        (run_id,),
    ).fetchall()
    for day_utc, connector_id, reason in rows:
        if "obs_repaired" not in _parse_reason_tokens(reason):
            continue
        if not day_utc:
            continue
        try:
            parsed_connector_id = int(connector_id)
        except (TypeError, ValueError):
            continue
        if parsed_connector_id <= 0:
            continue
        keys.add((str(day_utc), parsed_connector_id))
    return keys


def _load_previous_aqi_rebuild_status(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    env_name: str,
    connector_id: int,
    day_utc: str,
) -> tuple[str | None, int | None]:
    row = conn.execute(
        """
        SELECT status, run_id
        FROM aqi_rebuild_queue
        WHERE env_name = ?
          AND connector_id = ?
          AND day_utc = ?
          AND run_id <> ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (env_name, connector_id, day_utc, run_id),
    ).fetchone()
    if not row:
        return None, None
    status = str(row[0]).strip() if row[0] is not None else None
    prev_run_id = int(row[1]) if row[1] is not None else None
    return status, prev_run_id


def run_aqi_health_checks(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    env_name: str,
    r2_history_root: str | None,
    r2_aqilevels_prefix: str | None,
    dry_run: bool,
    run_backfill: bool,
    log: logging.Logger,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "aqi_health_ran": False,
        "aqi_health_skipped_reason": None,
        "aqi_health_connector_days_checked": 0,
        "aqi_health_rebuilds_queued": 0,
        "aqi_health_skipped_already_obs_repaired": 0,
        "aqi_health_manifest_missing": 0,
        "aqi_health_manifest_stale": 0,
        "aqi_health_manifest_empty": 0,
        "aqi_health_previous_rebuild_failed": 0,
        "queued_aqi_only_connector_days": [],
    }
    if not run_backfill:
        metrics["aqi_health_skipped_reason"] = "skipped because --run-backfill not set"
        return metrics
    if not r2_history_root:
        metrics["aqi_health_skipped_reason"] = "UK_AQ_R2_HISTORY_DROPBOX_ROOT is not set"
        return metrics
    root = Path(r2_history_root)
    if not root.is_dir():
        metrics["aqi_health_skipped_reason"] = f"R2 history root is not a directory: {root}"
        return metrics
    aqilevels_prefix = str(r2_aqilevels_prefix or R2_AQILEVELS_PREFIX).strip().strip("/")
    if not aqilevels_prefix:
        metrics["aqi_health_skipped_reason"] = "AQI history prefix is empty"
        return metrics

    obs_repaired_keys = _load_obs_repaired_queue_keys(conn, run_id=run_id)
    candidate_rows = conn.execute(
        """
        SELECT
          day_utc,
          connector_id,
          SUM(CASE WHEN source_row_count > 0 THEN source_row_count ELSE 0 END) AS source_row_count
        FROM cross_checks
        WHERE run_id = ?
          AND day_utc IS NOT NULL
        GROUP BY day_utc, connector_id
        HAVING SUM(CASE WHEN source_row_count > 0 THEN source_row_count ELSE 0 END) > 0
        ORDER BY day_utc, connector_id
        """,
        (run_id,),
    ).fetchall()

    queued_keys: set[tuple[str, int]] = set()
    queued_rows: list[dict[str, Any]] = []

    for day_utc, connector_id, source_row_count in candidate_rows:
        if not day_utc:
            continue
        day_iso = str(day_utc)
        try:
            parsed_connector_id = int(connector_id)
        except (TypeError, ValueError):
            continue
        if parsed_connector_id <= 0:
            continue

        key = (day_iso, parsed_connector_id)
        if key in obs_repaired_keys:
            metrics["aqi_health_skipped_already_obs_repaired"] += 1
            continue

        metrics["aqi_health_connector_days_checked"] += 1

        reasons: set[str] = set()
        notes: list[str] = []

        previous_status, previous_run_id = _load_previous_aqi_rebuild_status(
            conn,
            run_id=run_id,
            env_name=env_name,
            connector_id=parsed_connector_id,
            day_utc=day_iso,
        )
        if previous_status in {"failed", "queued", "running"}:
            reasons.add("previous_rebuild_failed_or_pending")
            notes.append(
                f"previous_queue_status={previous_status} previous_run_id={previous_run_id}"
            )
            metrics["aqi_health_previous_rebuild_failed"] += 1

        manifest_path = (
            root
            / aqilevels_prefix
            / f"day_utc={day_iso}"
            / f"connector_id={parsed_connector_id}"
            / "manifest.json"
        )
        payload: dict[str, Any] | None = None
        if not manifest_path.is_file():
            reasons.add("manifest_missing")
            notes.append(f"manifest_missing:{manifest_path}")
            metrics["aqi_health_manifest_missing"] += 1
        else:
            try:
                raw = json.loads(manifest_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    payload = raw
                else:
                    reasons.add("manifest_stale")
                    notes.append("manifest_invalid:root_not_object")
                    metrics["aqi_health_manifest_stale"] += 1
            except Exception as exc:
                reasons.add("manifest_stale")
                notes.append(f"manifest_invalid_json:{exc}")
                metrics["aqi_health_manifest_stale"] += 1

        if payload is not None:
            schema_name = str(payload.get("history_schema_name") or "").strip()
            schema_version = _safe_non_negative_int(payload.get("history_schema_version"))
            writer_version = str(payload.get("writer_version") or "").strip()
            if (
                schema_name != AQILEVELS_EXPECTED_HISTORY_SCHEMA_NAME
                or schema_version != AQILEVELS_EXPECTED_HISTORY_SCHEMA_VERSION
                or writer_version != AQILEVELS_EXPECTED_WRITER_VERSION
            ):
                reasons.add("manifest_stale")
                notes.append(
                    "manifest_schema_mismatch:"
                    f"schema_name={schema_name or '<missing>'}"
                    f",schema_version={schema_version}"
                    f",writer_version={writer_version or '<missing>'}"
                )
                metrics["aqi_health_manifest_stale"] += 1

            manifest_rows = _safe_non_negative_int(payload.get("source_row_count"))
            if manifest_rows is None:
                manifest_rows = _safe_non_negative_int(payload.get("total_rows"))
            source_rows = _safe_non_negative_int(source_row_count) or 0
            if source_rows > 0 and (manifest_rows is None or manifest_rows == 0):
                reasons.add("manifest_empty")
                notes.append(
                    f"manifest_empty:source_rows={source_rows} manifest_rows={manifest_rows}"
                )
                metrics["aqi_health_manifest_empty"] += 1

        if not reasons:
            continue

        queue_note = "; ".join(notes) if notes else None
        queued_row = {
            "day_utc": day_iso,
            "connector_id": parsed_connector_id,
            "reasons": sorted(reasons),
            "notes": queue_note,
        }

        if dry_run:
            queued_keys.add(key)
            queued_rows.append(queued_row)
            continue

        action = _queue_aqi_rebuild(
            conn=conn,
            run_id=run_id,
            env_name=env_name,
            connector_id=parsed_connector_id,
            day_utc=day_iso,
            reason="aqi_health_check",
            source_mode="live_r2",
            requested_timeseries_ids=[],
            queue_note=queue_note,
            log=log,
        )
        if action in {"inserted", "merged"}:
            queued_rows.append(queued_row)
        if action == "inserted":
            queued_keys.add(key)

    metrics["aqi_health_ran"] = True
    metrics["aqi_health_rebuilds_queued"] = len(queued_keys)
    metrics["queued_aqi_only_connector_days"] = sorted(
        queued_rows,
        key=lambda row: (str(row.get("day_utc") or ""), int(row.get("connector_id") or 0)),
    )
    log.info(
        "aqi-health-check done checked=%s queued=%s skipped_obs_repaired=%s manifest_missing=%s manifest_stale=%s manifest_empty=%s previous_rebuild_failed=%s",
        metrics["aqi_health_connector_days_checked"],
        metrics["aqi_health_rebuilds_queued"],
        metrics["aqi_health_skipped_already_obs_repaired"],
        metrics["aqi_health_manifest_missing"],
        metrics["aqi_health_manifest_stale"],
        metrics["aqi_health_manifest_empty"],
        metrics["aqi_health_previous_rebuild_failed"],
    )
    return metrics


def _planned_aqi_rebuild_command(
    env: dict[str, str],
    connector_id: int | None,
    day: dt.date,
) -> str:
    wrapper_raw = resolve_integrity_backfill_wrapper()
    env_file = str(
        env.get("UK_AQ_BACKFILL_ENV_FILE")
        or os.environ.get("UK_AQ_BACKFILL_ENV_FILE")
        or "<UK_AQ_BACKFILL_ENV_FILE unset>"
    ).strip()
    wrapper = wrapper_raw or "<integrity backfill wrapper unset>"
    iso = day.isoformat()
    connector_scope = ""
    if connector_id is not None and int(connector_id) > 0:
        connector_scope = f"UK_AQ_BACKFILL_CONNECTOR_IDS={int(connector_id)} "
    return (
        f"UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels "
        f"UK_AQ_BACKFILL_DRY_RUN=false "
        f"UK_AQ_BACKFILL_FORCE_REPLACE=true "
        f"UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only "
        f"{connector_scope}"
        f"UK_AQ_BACKFILL_FROM_DAY_UTC={iso} "
        f"UK_AQ_BACKFILL_TO_DAY_UTC={iso} "
        f"UK_AQ_BACKFILL_ENV_FILE={env_file} "
        f"{wrapper}"
    )


def run_aqi_rebuild_backfill(
    *,
    wrapper_path: str | None,
    env_file_path: str | None,
    env_name: str,
    connector_id: int | None,
    day: dt.date,
    log: logging.Logger,
    timeout_seconds: int = BACKFILL_DEFAULT_TIMEOUT_SECONDS,
    log_dir: Path | None = None,
    log_label: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": None,
        "exit_code": None,
        "duration_seconds": 0.0,
        "wrapper_path": wrapper_path,
        "env_file_path": env_file_path,
        "stdout_tail": "",
        "stderr_tail": "",
        "log_path": None,
        "error": None,
    }
    if not wrapper_path:
        result["status"] = "no_wrapper"
        result["error"] = "UK_AQ_BACKFILL_WRAPPER is not set"
        return result
    if not Path(wrapper_path).is_file():
        result["status"] = "no_wrapper"
        result["error"] = f"wrapper not found: {wrapper_path}"
        return result

    sub_env: dict[str, str] = {**os.environ}
    if env_file_path:
        if not Path(env_file_path).is_file():
            result["status"] = "no_env_file"
            result["error"] = f"env file not found: {env_file_path}"
            return result
        loaded = _load_env_file(Path(env_file_path))
        interesting_keys = _summarize_loaded_backfill_env_keys(loaded)
        log.info(
            "aqi rebuild loading env_file=%s var_count=%s keys=%s",
            env_file_path,
            len(loaded),
            interesting_keys,
        )
        sub_env.update(loaded)

    iso = day.isoformat()
    sub_env.update({
        "UK_AQ_BACKFILL_RUN_MODE": "r2_history_obs_to_aqilevels",
        "UK_AQ_BACKFILL_DRY_RUN": "false",
        "UK_AQ_BACKFILL_FORCE_REPLACE": "true",
        "UK_AQ_BACKFILL_OUTPUT_SCOPE": "aqilevels_only",
        "UK_AQ_BACKFILL_FROM_DAY_UTC": iso,
        "UK_AQ_BACKFILL_TO_DAY_UTC": iso,
        "UK_AQ_BACKFILL_TRIGGER_MODE": "manual",
    })
    if connector_id is not None and int(connector_id) > 0:
        sub_env["UK_AQ_BACKFILL_CONNECTOR_IDS"] = str(int(connector_id))
    else:
        sub_env.pop("UK_AQ_BACKFILL_CONNECTOR_IDS", None)
    sub_env.pop("UK_AQ_BACKFILL_TIMESERIES_IDS", None)
    sub_env.pop("UK_AQ_BACKFILL_TIMESERIES_ID", None)

    wrapper_name = Path(wrapper_path).name
    cmd = ["bash", wrapper_path]
    if wrapper_name == "uk_aq_integrity_backfill.sh":
        cmd = [
            "bash",
            wrapper_path,
            "--env",
            env_name,
            "--aqi-only",
            "--from-day",
            iso,
            "--to-day",
            iso,
        ]
        if connector_id is not None and int(connector_id) > 0:
            cmd.extend(["--connector-id", str(int(connector_id))])

    started = time.monotonic()
    connector_scope = str(int(connector_id)) if connector_id is not None and int(connector_id) > 0 else "all"
    log.info(
        "aqi rebuild invoke wrapper=%s day=%s connector_scope=%s",
        wrapper_path,
        iso,
        connector_scope,
    )

    stdout_text = ""
    stderr_text = ""
    try:
        proc = subprocess.run(
            cmd,
            env=sub_env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        stdout_text = proc.stdout or ""
        stderr_text = proc.stderr or ""
        result["exit_code"] = proc.returncode
        result["status"] = "ok" if proc.returncode == 0 else "error"
        if proc.returncode != 0:
            result["error"] = f"wrapper exit_code={proc.returncode}"
    except subprocess.TimeoutExpired as exc:
        result["status"] = "timeout"
        result["error"] = f"wrapper timed out after {timeout_seconds}s"
        if isinstance(exc.stdout, (bytes, bytearray)):
            stdout_text = exc.stdout.decode("utf-8", errors="replace")
        else:
            stdout_text = exc.stdout or ""
        if isinstance(exc.stderr, (bytes, bytearray)):
            stderr_text = exc.stderr.decode("utf-8", errors="replace")
        else:
            stderr_text = exc.stderr or ""
    except OSError as exc:
        result["status"] = "spawn_error"
        result["error"] = f"spawn failed: {exc}"

    result["stdout_tail"] = _tail_bytes(stdout_text)
    result["stderr_tail"] = _tail_bytes(stderr_text)

    if log_dir is not None and (stdout_text or stderr_text or result["status"]):
        log_dir.mkdir(parents=True, exist_ok=True)
        label = log_label or f"aqi_day_{iso}_connector_{connector_scope}"
        log_path = log_dir / f"{label}.log"
        try:
            with log_path.open("w", encoding="utf-8") as fh:
                fh.write(f"# wrapper: {wrapper_path}\n")
                fh.write(f"# env_file: {env_file_path}\n")
                fh.write(f"# day: {iso}\n")
                fh.write(f"# connector_scope: {connector_scope}\n")
                fh.write("# run_mode: r2_history_obs_to_aqilevels\n")
                fh.write("# output_scope: aqilevels_only\n")
                fh.write(f"# command: {' '.join(cmd)}\n")
                fh.write(f"# exit_code: {result['exit_code']}\n")
                fh.write(f"# status: {result['status']}\n")
                fh.write("\n# === STDOUT ===\n")
                fh.write(stdout_text)
                fh.write("\n# === STDERR ===\n")
                fh.write(stderr_text)
            result["log_path"] = str(log_path)
        except OSError as exc:
            log.warning("aqi rebuild log_path write failed: %s", exc)

    result["duration_seconds"] = round(time.monotonic() - started, 3)
    log.info(
        "aqi rebuild done status=%s exit_code=%s duration=%.3fs",
        result["status"], result["exit_code"], result["duration_seconds"],
    )
    return result


def run_aqi_rebuild_queue_execution(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    env_name: str,
    run_compact: str,
    env: dict[str, str],
    dry_run: bool,
    run_backfill: bool,
    limits: LimitTracker,
    log: logging.Logger,
    dry_run_planned_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "aqi_rebuild_ran": False,
        "aqi_rebuild_skipped_reason": None,
        "aqi_rebuilds_queued_total": 0,
        "aqi_rebuilds_attempted": 0,
        "aqi_rebuilds_complete": 0,
        "aqi_rebuilds_failed": 0,
        "aqi_rebuilds_skipped": 0,
        "planned_aqi_rebuild_commands": [],
        "aqi_rebuild_results": [],
    }
    if not run_backfill:
        metrics["aqi_rebuild_skipped_reason"] = "skipped because --run-backfill not set"
        return metrics

    queue_rows = conn.execute(
        """
        SELECT id, connector_id, day_utc, reason, source_mode, status, notes
        FROM aqi_rebuild_queue
        WHERE run_id = ?
          AND status = 'queued'
          AND day_utc IS NOT NULL
        ORDER BY day_utc, connector_id, id
        """,
        (run_id,),
    ).fetchall()

    by_day: dict[str, list[tuple[Any, ...]]] = {}
    for row in queue_rows:
        row_id, connector_id, day_utc, *_ = row
        day_iso = str(day_utc or "").strip()
        if not day_iso:
            metrics["aqi_rebuilds_skipped"] += 1
            continue
        try:
            parsed_connector_id = int(connector_id)
        except (TypeError, ValueError):
            log.warning("aqi rebuild queue row id=%s has invalid connector_id=%r", row_id, connector_id)
            metrics["aqi_rebuilds_skipped"] += 1
            continue
        if parsed_connector_id <= 0:
            metrics["aqi_rebuilds_skipped"] += 1
            continue
        by_day.setdefault(day_iso, []).append(row)

    metrics["aqi_rebuilds_queued_total"] = len(by_day)
    if dry_run and metrics["aqi_rebuilds_queued_total"] == 0 and dry_run_planned_rows:
        seed_by_day: dict[str, dict[str, Any]] = {}
        for row in dry_run_planned_rows:
            day_iso = str(row.get("day_utc") or "").strip()
            if not day_iso:
                continue
            try:
                connector_id = int(row.get("connector_id"))
            except (TypeError, ValueError):
                continue
            if connector_id <= 0:
                continue
            current = seed_by_day.get(day_iso)
            row_reasons = _parse_reason_tokens(",".join(str(v) for v in (row.get("reasons") or [])))
            if not row_reasons and row.get("reason"):
                row_reasons = _parse_reason_tokens(str(row.get("reason")))
            if current is None:
                seed_by_day[day_iso] = {
                    "day_utc": day_iso,
                    "connector_ids": [connector_id],
                    "reasons": sorted(row_reasons),
                }
                continue
            merged = _parse_reason_tokens(",".join(current.get("reasons") or []))
            merged.update(row_reasons)
            current["reasons"] = sorted(merged)
            if connector_id not in current["connector_ids"]:
                current["connector_ids"].append(connector_id)

        for day_iso, seed in sorted(seed_by_day.items(), key=lambda item: item[0]):
            connector_ids = sorted(int(v) for v in seed.get("connector_ids") or [])
            planned_cmd = _planned_aqi_rebuild_command(
                env,
                None,
                dt.date.fromisoformat(day_iso),
            )
            metrics["planned_aqi_rebuild_commands"].append(planned_cmd)
            metrics["aqi_rebuild_results"].append({
                "queue_row_ids": [],
                "connector_id": None,
                "connector_ids": connector_ids,
                "day_utc": day_iso,
                "reasons": seed.get("reasons") or [],
                "status": "planned",
                "source_mode": "live_r2",
                "error": None,
                "log_path": None,
            })
        metrics["aqi_rebuilds_queued_total"] = len(seed_by_day)
        metrics["aqi_rebuild_ran"] = True
        return metrics

    if not by_day:
        metrics["aqi_rebuild_ran"] = True
        return metrics

    backfill_log_dir = (
        Path(env["UK_AQ_HISTORY_INTEGRITY_LOG_DIR"]) / "backfill" / run_compact
    )
    for day_iso, rows_for_key in sorted(by_day.items(), key=lambda item: item[0]):
        day_obj = dt.date.fromisoformat(day_iso)
        merged_reasons: set[str] = set()
        connector_ids: set[int] = set()
        for row in rows_for_key:
            merged_reasons.update(_parse_reason_tokens(row[3]))
            try:
                parsed_connector_id = int(row[1])
            except (TypeError, ValueError):
                continue
            if parsed_connector_id > 0:
                connector_ids.add(parsed_connector_id)
        reasons_sorted = sorted(merged_reasons)
        connector_ids_sorted = sorted(connector_ids)
        primary_row = rows_for_key[0]
        duplicate_rows = rows_for_key[1:]
        row_ids = [int(row[0]) for row in rows_for_key if row[0] is not None]

        planned_cmd = _planned_aqi_rebuild_command(env, None, day_obj)
        metrics["planned_aqi_rebuild_commands"].append(planned_cmd)

        if duplicate_rows:
            metrics["aqi_rebuilds_skipped"] += len(duplicate_rows)
            if not dry_run:
                now_iso = fmt_iso(utc_now())
                for dup in duplicate_rows:
                    dup_id = int(dup[0])
                    merged_note = _merge_notes(
                        dup[6],
                        f"skipped duplicate queue day; executed by queue_row_id={int(primary_row[0])}",
                    )
                    conn.execute(
                        """
                        UPDATE aqi_rebuild_queue
                        SET status = 'skipped',
                            finished_at_utc = ?,
                            notes = ?
                        WHERE id = ?
                        """,
                        (now_iso, merged_note, dup_id),
                    )
                conn.commit()

        if dry_run:
            metrics["aqi_rebuild_results"].append({
                "queue_row_ids": row_ids,
                "connector_id": None,
                "connector_ids": connector_ids_sorted,
                "day_utc": day_iso,
                "reasons": reasons_sorted,
                "status": "planned",
                "source_mode": "live_r2",
                "error": None,
                "log_path": None,
            })
            continue

        if limits.should_stop():
            metrics["aqi_rebuilds_skipped"] += 1
            metrics["aqi_rebuild_results"].append({
                "queue_row_ids": row_ids,
                "connector_id": None,
                "connector_ids": connector_ids_sorted,
                "day_utc": day_iso,
                "reasons": reasons_sorted,
                "status": "skipped_limit",
                "source_mode": "live_r2",
                "error": f"stopped_for={limits.stopped_for}",
                "log_path": None,
            })
            continue

        started_iso = fmt_iso(utc_now())
        primary_row_id = int(primary_row[0])
        conn.execute(
            """
            UPDATE aqi_rebuild_queue
            SET status = 'running',
                started_at_utc = ?,
                notes = ?
            WHERE id = ?
            """,
            (
                started_iso,
                _merge_notes(primary_row[6], f"rebuild_started_at={started_iso}"),
                primary_row_id,
            ),
        )
        conn.commit()

        bf = run_aqi_rebuild_backfill(
            wrapper_path=resolve_integrity_backfill_wrapper(),
            env_file_path=os.environ.get("UK_AQ_BACKFILL_ENV_FILE"),
            env_name=env_name,
            connector_id=None,
            day=day_obj,
            log=log,
            log_dir=backfill_log_dir,
            log_label=f"aqi_day_{day_iso}_all_connectors",
        )
        metrics["aqi_rebuilds_attempted"] += 1

        finished_iso = fmt_iso(utc_now())
        if bf["status"] == "ok":
            metrics["aqi_rebuilds_complete"] += 1
            conn.execute(
                """
                UPDATE aqi_rebuild_queue
                SET status = 'complete',
                    finished_at_utc = ?,
                    notes = ?
                WHERE id = ?
                """,
                (
                    finished_iso,
                    _merge_notes(primary_row[6], "aqi_rebuild_complete"),
                    primary_row_id,
                ),
            )
            final_status = "complete"
            error_text = None
        else:
            metrics["aqi_rebuilds_failed"] += 1
            failure_note = _merge_notes(
                primary_row[6],
                f"aqi_rebuild_failed status={bf.get('status')} error={bf.get('error')}",
            )
            conn.execute(
                """
                UPDATE aqi_rebuild_queue
                SET status = 'failed',
                    finished_at_utc = ?,
                    notes = ?
                WHERE id = ?
                """,
                (finished_iso, failure_note, primary_row_id),
            )
            final_status = "failed"
            error_text = str(bf.get("error") or bf.get("status") or "unknown")
        conn.commit()

        metrics["aqi_rebuild_results"].append({
            "queue_row_ids": row_ids,
            "connector_id": None,
            "connector_ids": connector_ids_sorted,
            "day_utc": day_iso,
            "reasons": reasons_sorted,
            "status": final_status,
            "source_mode": "live_r2",
            "error": error_text,
            "log_path": bf.get("log_path"),
        })

    metrics["aqi_rebuild_ran"] = True
    metrics["aqi_rebuild_results"] = sorted(
        metrics["aqi_rebuild_results"],
        key=lambda row: (
            str(row.get("day_utc") or ""),
            int(((row.get("connector_ids") or [0])[0]) or 0),
        ),
    )
    return metrics


def fmt_iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def fmt_compact(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H%M%SZ")


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="uk-aq-history-integrity",
        description="UK-AQ History Integrity entrypoint (Phase 1).",
    )
    p.add_argument("--env", required=True, choices=["CIC-Test", "LIVE"])
    p.add_argument(
        "--profile",
        default="manual",
        choices=["daily", "weekly", "monthly", "manual"],
    )
    p.add_argument(
        "--source",
        default="all",
        choices=["openaq", "sensorcommunity", "uk_air_sos", "all"],
        help="Source adapter filter (also scopes cross-check source rows).",
    )
    p.add_argument("--from-day", dest="from_day", default=None,
                   help="YYYY-MM-DD lower bound (manual profile or override).")
    p.add_argument("--to-day", dest="to_day", default=None,
                   help="YYYY-MM-DD upper bound (manual profile or override).")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--check-only", action="store_true",
                   help="Detect changes; do not trigger backfill.")
    p.add_argument("--run-backfill", action="store_true",
                   help="Trigger narrow backfill on confirmed source change.")
    p.add_argument("--max-download-mb", type=int, default=None)
    p.add_argument("--max-runtime-minutes", type=int, default=None)
    p.add_argument("--verbose", action="store_true")
    default_concurrency = int(os.environ.get(
        "UK_AQ_HISTORY_INTEGRITY_CONCURRENCY", DEFAULT_CONCURRENCY,
    ))
    p.add_argument(
        "--concurrency",
        type=int,
        default=default_concurrency,
        help=f"Worker count for the per-file thread pool (default {default_concurrency}; "
             "1 = strict sequential).",
    )
    p.add_argument(
        "--force-snapshot-import",
        action="store_true",
        help="Re-import the core snapshot even if its manifest_hash matches "
             "the previous successful import.",
    )
    p.add_argument(
        "--skip-snapshot-import",
        action="store_true",
        help="Skip the core snapshot import for this run (debug/recovery). "
             "Source adapters added in later phases will fail without a lookup.",
    )
    p.add_argument(
        "--skip-cross-check",
        action="store_true",
        help="Skip Phase 6.5 Pass B source-vs-R2 count cross-check (debug/recovery).",
    )
    return p.parse_args(argv)


def load_env_or_die() -> dict[str, str]:
    missing = [v for v in REQUIRED_ENV_VARS if not os.environ.get(v)]
    if missing:
        sys.stderr.write(
            "ERROR: required env vars not set; the shell launcher must load "
            "the env file before invoking python.\n"
            f"       Missing: {', '.join(missing)}\n"
        )
        sys.exit(3)
    return {v: os.environ[v] for v in REQUIRED_ENV_VARS}


def validate_guardrails(cli_env: str, env: dict[str, str]) -> None:
    if env["UK_AQ_ENV_NAME"] != cli_env:
        sys.stderr.write(
            f"ERROR: --env={cli_env} but UK_AQ_ENV_NAME={env['UK_AQ_ENV_NAME']}. Refusing to run.\n"
        )
        sys.exit(4)

    other = "LIVE" if cli_env == "CIC-Test" else "CIC-Test"
    fragment = f"/{other}/"
    for var in PATH_VARS_FOR_GUARDRAILS:
        val = os.environ.get(var, "")
        if val and fragment in val:
            sys.stderr.write(
                f"ERROR: --env={cli_env} but {var}={val} contains '{fragment}'. Refusing to run.\n"
            )
            sys.exit(4)

    state_dir = env["UK_AQ_HISTORY_INTEGRITY_STATE_DIR"].rstrip("/")
    db_path = env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"]
    if not db_path.startswith(state_dir + "/"):
        sys.stderr.write(
            f"ERROR: UK_AQ_HISTORY_INTEGRITY_DB_PATH={db_path} is not inside "
            f"UK_AQ_HISTORY_INTEGRITY_STATE_DIR={env['UK_AQ_HISTORY_INTEGRITY_STATE_DIR']}. "
            "Refusing to run.\n"
        )
        sys.exit(4)


def ensure_dirs(env: dict[str, str]) -> None:
    for var in (
        "UK_AQ_HISTORY_INTEGRITY_STATE_DIR",
        "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR",
        "UK_AQ_HISTORY_INTEGRITY_TMP_DIR",
        "UK_AQ_HISTORY_INTEGRITY_LOG_DIR",
        "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR",
        "UK_AQ_HISTORY_INTEGRITY_LOCK_DIR",
    ):
        Path(env[var]).mkdir(parents=True, exist_ok=True)


def _check_writable_dir(path: str, label: str, errors: list[str]) -> None:
    p = Path(path)
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        errors.append(
            f"{label} cannot be created: {path} ({exc})",
        )
        return
    if not p.is_dir():
        errors.append(f"{label} is not a directory: {path}")
        return
    if not os.access(p, os.W_OK):
        errors.append(f"{label} is not writable: {path}")


def _check_parent_writable(path: str, label: str, errors: list[str]) -> None:
    parent = Path(path).parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        errors.append(
            f"{label} parent cannot be created: {parent} ({exc})",
        )
        return
    if not os.access(parent, os.W_OK):
        errors.append(f"{label} parent is not writable: {parent}")


def _looks_like_snapshot_root(root: Path) -> bool:
    # Lightweight heuristic to avoid deep scans on large trees.
    likely_dir_names = {"history", "v1", "core"}
    likely_file_names = {"manifest.json"}
    likely_suffixes = {".parquet", ".json"}
    checked = 0
    for dirpath, dirnames, filenames in os.walk(root):
        checked += 1
        if checked > 300:
            break
        for dirname in dirnames:
            if dirname in likely_dir_names:
                return True
        for name in filenames:
            if name in likely_file_names:
                return True
            if Path(name).suffix.lower() in likely_suffixes:
                return True
    return False


def _looks_like_r2_history_root(root: Path) -> bool:
    candidates = (
        root / "history",
        root / "history" / "v1",
        root / "history" / "_index",
    )
    if any(path.exists() for path in candidates):
        return True
    # Fallback heuristic for older/local layouts.
    checked = 0
    for dirpath, dirnames, filenames in os.walk(root):
        checked += 1
        if checked > 400:
            break
        if "observations_timeseries" in dirpath or "aqilevels_station" in dirpath:
            return True
        if any(name.endswith(".json") for name in filenames):
            return True
    return False


def _parse_iso_day(day_value: str, field_name: str, errors: list[str]) -> dt.date | None:
    try:
        return dt.date.fromisoformat(day_value)
    except ValueError:
        errors.append(
            f"{field_name} must be YYYY-MM-DD, got '{day_value}'.",
        )
        return None


def _is_truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _parse_bool(value: str | None, default: bool) -> bool:
    raw = str(value or "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "y", "on"}:
        return True
    if raw in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _daily_task_health_enabled() -> bool:
    return _parse_bool(
        os.environ.get("UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED"),
        True,
    )


def _daily_task_health_strict() -> bool:
    return _parse_bool(
        os.environ.get("UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_STRICT"),
        False,
    )


def _truncate_text(value: Any, limit: int = DAILY_TASK_HEALTH_ERROR_LIMIT) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[: max(0, limit - 3)]}..."


def _daily_task_health_error_payload(exc: Exception) -> dict[str, Any]:
    stack = ""
    if hasattr(exc, "__traceback__"):
        stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    return {
        "name": type(exc).__name__,
        "message": _truncate_text(str(exc)),
        "stack_preview": _truncate_text(stack, 1800) if stack else None,
    }


def _http_post_json(
    *,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any] | list[dict[str, Any]],
    timeout_seconds: int = 30,
) -> Any:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    for key, value in headers.items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        payload = resp.read().decode("utf-8", errors="replace")
        if not payload.strip():
            return None
        return json.loads(payload)


def _resolve_daily_task_health_config(
    *,
    env_name: str,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "enabled": _daily_task_health_enabled(),
        "strict": _daily_task_health_strict(),
        "task_key": DAILY_TASK_HEALTH_TASK_KEY,
        "source_repo": DAILY_TASK_HEALTH_SOURCE_REPO,
        "source_worker": DAILY_TASK_HEALTH_SOURCE_WORKER,
        "env_name": env_name,
        "backfill_env_file": str(os.environ.get("UK_AQ_BACKFILL_ENV_FILE", "")).strip(),
        "supabase_url": "",
        "supabase_key": "",
        "supabase_db_url": "",
    }
    if not config["enabled"]:
        return config

    loaded: dict[str, str] = {}
    env_file = str(config["backfill_env_file"]).strip()
    if env_file:
        try:
            loaded = _load_env_file(Path(env_file))
        except OSError:
            loaded = {}
    config["supabase_url"] = str(
        loaded.get("OBS_AQIDB_SUPABASE_URL")
        or os.environ.get("OBS_AQIDB_SUPABASE_URL")
        or "",
    ).strip().rstrip("/")
    config["supabase_key"] = str(
        loaded.get("OBS_AQIDB_SECRET_KEY")
        or os.environ.get("OBS_AQIDB_SECRET_KEY")
        or "",
    ).strip()
    config["supabase_db_url"] = str(
        loaded.get("OBS_AQIDB_SUPABASE_DB_URL")
        or os.environ.get("OBS_AQIDB_SUPABASE_DB_URL")
        or "",
    ).strip()
    return config


def _daily_task_health_headers(supabase_key: str, schema: str) -> dict[str, str]:
    return {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Accept-Profile": schema,
        "Content-Profile": schema,
    }


def _daily_task_health_call_rpc(
    config: Mapping[str, Any],
    *,
    rpc_name: str,
    body: dict[str, Any],
) -> Any:
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    supabase_key = str(config.get("supabase_key") or "").strip()
    if not supabase_url or not supabase_key:
        raise RuntimeError("daily task health missing Supabase URL/service key")
    url = f"{supabase_url}/rest/v1/rpc/{rpc_name}"
    headers = _daily_task_health_headers(
        supabase_key,
        DAILY_TASK_HEALTH_RPC_SCHEMA,
    )
    return _http_post_json(url=url, headers=headers, body=body)


def _daily_task_health_start(
    config: Mapping[str, Any],
    *,
    scheduled_for_date: str,
    started_at_utc: str,
    summary: dict[str, Any],
    platform_run_id: str | None,
    log_url: str | None,
) -> str | None:
    result = _daily_task_health_call_rpc(
        config,
        rpc_name="uk_aq_rpc_daily_task_started",
        body={
            "p": {
                "task_key": DAILY_TASK_HEALTH_TASK_KEY,
                "scheduled_for_date": scheduled_for_date,
                "started_at": started_at_utc,
                "summary": summary,
                "source_repo": DAILY_TASK_HEALTH_SOURCE_REPO,
                "source_worker": DAILY_TASK_HEALTH_SOURCE_WORKER,
                "platform_run_id": platform_run_id,
                "log_url": log_url,
            },
        },
    )
    if isinstance(result, str):
        return result
    return None


def _daily_task_health_finish(
    config: Mapping[str, Any],
    *,
    run_id: str | None,
    scheduled_for_date: str,
    finished_at_utc: str,
    summary: dict[str, Any],
    platform_run_id: str | None,
    log_url: str | None,
) -> None:
    payload = {
        "summary": summary,
        "finished_at": finished_at_utc,
        "source_repo": DAILY_TASK_HEALTH_SOURCE_REPO,
        "source_worker": DAILY_TASK_HEALTH_SOURCE_WORKER,
        "platform_run_id": platform_run_id,
        "log_url": log_url,
    }
    if run_id:
        _daily_task_health_call_rpc(
            config,
            rpc_name="uk_aq_rpc_daily_task_finished",
            body={"p_run_id": run_id, "p": payload},
        )
    else:
        _daily_task_health_call_rpc(
            config,
            rpc_name="uk_aq_rpc_daily_task_report_final",
            body={
                "p": {
                    "task_key": DAILY_TASK_HEALTH_TASK_KEY,
                    "status": "Finished",
                    "scheduled_for_date": scheduled_for_date,
                    "finished_at": finished_at_utc,
                    "summary": summary,
                    "source_repo": DAILY_TASK_HEALTH_SOURCE_REPO,
                    "source_worker": DAILY_TASK_HEALTH_SOURCE_WORKER,
                    "platform_run_id": platform_run_id,
                    "log_url": log_url,
                },
            },
        )
    _daily_task_health_call_rpc(
        config,
        rpc_name="uk_aq_rpc_recompute_daily_task_status",
        body={"p_date": scheduled_for_date},
    )


def _daily_task_health_fail(
    config: Mapping[str, Any],
    *,
    run_id: str | None,
    scheduled_for_date: str,
    failed_at_utc: str,
    summary: dict[str, Any],
    error_message: str,
    error_payload: dict[str, Any],
    platform_run_id: str | None,
    log_url: str | None,
) -> None:
    payload = {
        "summary": summary,
        "failed_at": failed_at_utc,
        "error_message": _truncate_text(error_message),
        "error": error_payload,
        "source_repo": DAILY_TASK_HEALTH_SOURCE_REPO,
        "source_worker": DAILY_TASK_HEALTH_SOURCE_WORKER,
        "platform_run_id": platform_run_id,
        "log_url": log_url,
    }
    if run_id:
        _daily_task_health_call_rpc(
            config,
            rpc_name="uk_aq_rpc_daily_task_failed",
            body={"p_run_id": run_id, "p": payload},
        )
    else:
        _daily_task_health_call_rpc(
            config,
            rpc_name="uk_aq_rpc_daily_task_report_final",
            body={
                "p": {
                    "task_key": DAILY_TASK_HEALTH_TASK_KEY,
                    "status": "Failed",
                    "scheduled_for_date": scheduled_for_date,
                    "failed_at": failed_at_utc,
                    "summary": summary,
                    "error_message": _truncate_text(error_message),
                    "error": error_payload,
                    "source_repo": DAILY_TASK_HEALTH_SOURCE_REPO,
                    "source_worker": DAILY_TASK_HEALTH_SOURCE_WORKER,
                    "platform_run_id": platform_run_id,
                    "log_url": log_url,
                },
            },
        )
    _daily_task_health_call_rpc(
        config,
        rpc_name="uk_aq_rpc_recompute_daily_task_status",
        body={"p_date": scheduled_for_date},
    )


def _collect_guardrail_errors(cli_env: str, env: dict[str, str]) -> list[str]:
    errors: list[str] = []
    if env["UK_AQ_ENV_NAME"] != cli_env:
        errors.append(
            f"--env={cli_env} but UK_AQ_ENV_NAME={env['UK_AQ_ENV_NAME']}. Refusing to run.",
        )
    other = "LIVE" if cli_env == "CIC-Test" else "CIC-Test"
    fragment = f"/{other}/"
    for var in PATH_VARS_FOR_GUARDRAILS:
        val = os.environ.get(var, "")
        if val and fragment in val:
            errors.append(
                f"--env={cli_env} but {var}={val} contains '{fragment}'. Refusing to run.",
            )

    state_dir = env["UK_AQ_HISTORY_INTEGRITY_STATE_DIR"].rstrip("/")
    db_path = env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"]
    if not db_path.startswith(state_dir + "/"):
        errors.append(
            f"UK_AQ_HISTORY_INTEGRITY_DB_PATH={db_path} is not inside "
            f"UK_AQ_HISTORY_INTEGRITY_STATE_DIR={env['UK_AQ_HISTORY_INTEGRITY_STATE_DIR']}. Refusing to run.",
        )
    return errors


def _detect_integrity_wrapper_capabilities(
    wrapper_path: Path,
    env_name: str,
) -> tuple[bool, bool]:
    # Returns (supports_observs_only, supports_aqi_only)
    try:
        proc = subprocess.run(
            [str(wrapper_path), "--help"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=8,
            check=False,
            env={**os.environ, "UK_AQ_ENV_NAME": env_name},
        )
    except (OSError, subprocess.SubprocessError):
        return (False, False)
    text = proc.stdout or ""
    return ("--observs-only" in text, "--aqi-only" in text)


def collect_preflight_errors(
    args: argparse.Namespace,
    env: dict[str, str],
) -> tuple[list[str], list[str], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []

    guardrail_errors = _collect_guardrail_errors(args.env, env)
    errors.extend(guardrail_errors)

    for dir_var in (
        "UK_AQ_HISTORY_INTEGRITY_STATE_DIR",
        "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR",
        "UK_AQ_HISTORY_INTEGRITY_TMP_DIR",
        "UK_AQ_HISTORY_INTEGRITY_LOG_DIR",
        "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR",
        "UK_AQ_HISTORY_INTEGRITY_LOCK_DIR",
    ):
        _check_writable_dir(env[dir_var], dir_var, errors)

    db_path = Path(env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"])
    if "/Dropbox/" in str(db_path):
        errors.append(
            "UK_AQ_HISTORY_INTEGRITY_DB_PATH must be local (non-Dropbox).",
        )
    _check_parent_writable(str(db_path), "UK_AQ_HISTORY_INTEGRITY_DB_PATH", errors)

    db_copy_path = str(os.environ.get("UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH", "")).strip()
    if db_copy_path and str(db_path) == db_copy_path:
        errors.append(
            "UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH must differ from UK_AQ_HISTORY_INTEGRITY_DB_PATH.",
        )
    if db_copy_path:
        _check_parent_writable(
            db_copy_path,
            "UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH",
            errors,
        )

    if db_path.exists():
        if not os.access(db_path, os.R_OK):
            errors.append(f"live DB exists but is not readable: {db_path}")
        if not os.access(db_path, os.W_OK):
            errors.append(f"live DB exists but is not writable: {db_path}")
    else:
        try:
            db_path.parent.mkdir(parents=True, exist_ok=True)
            with open(db_path, "a", encoding="utf-8"):
                pass
            db_path.unlink(missing_ok=True)
        except OSError as exc:
            errors.append(f"live DB cannot be created at {db_path} ({exc})")

    wal_path = db_path.with_name(db_path.name + "-wal")
    shm_path = db_path.with_name(db_path.name + "-shm")
    sidecars = [str(p) for p in (wal_path, shm_path) if p.exists()]
    if sidecars:
        warnings.append(f"SQLite sidecar files present: {', '.join(sidecars)}")

    if args.max_download_mb is not None and args.max_download_mb <= 0:
        errors.append("--max-download-mb must be a positive integer when supplied.")
    if args.max_runtime_minutes is not None and args.max_runtime_minutes <= 0:
        errors.append("--max-runtime-minutes must be a positive integer when supplied.")
    if args.concurrency <= 0:
        errors.append("--concurrency must be a positive integer.")

    parsed_from: dt.date | None = None
    parsed_to: dt.date | None = None
    if args.from_day:
        parsed_from = _parse_iso_day(args.from_day, "--from-day", errors)
    if args.to_day:
        parsed_to = _parse_iso_day(args.to_day, "--to-day", errors)
    if args.profile == "manual" and (not args.from_day or not args.to_day):
        errors.append("manual profile requires both --from-day and --to-day.")
    if parsed_from and parsed_to and parsed_from > parsed_to:
        errors.append("--from-day must be less than or equal to --to-day.")

    snapshot_root = Path(env["UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT"])
    if not snapshot_root.exists():
        errors.append(
            f"UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT does not exist: {snapshot_root}. "
            "Has Dropbox finished syncing the core snapshot backup?",
        )
    elif not snapshot_root.is_dir():
        errors.append(
            f"UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT is not a directory: {snapshot_root}",
        )
    elif not os.access(snapshot_root, os.R_OK):
        errors.append(
            f"UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT is not readable: {snapshot_root}",
        )
    elif not _looks_like_snapshot_root(snapshot_root):
        errors.append(
            f"UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT does not look like a snapshot history root: {snapshot_root}. "
            "Has Dropbox finished syncing the core snapshot backup?",
        )

    cross_check_enabled = not args.skip_cross_check
    if cross_check_enabled:
        r2_root_raw = str(os.environ.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT", "")).strip()
        if not r2_root_raw:
            errors.append(
                "UK_AQ_R2_HISTORY_DROPBOX_ROOT is required while cross-check is enabled.",
            )
        else:
            r2_root = Path(r2_root_raw)
            if not r2_root.exists():
                errors.append(
                    f"UK_AQ_R2_HISTORY_DROPBOX_ROOT does not exist: {r2_root}. "
                    "Has Dropbox finished syncing the R2 history backup?",
                )
            elif not r2_root.is_dir():
                errors.append(
                    f"UK_AQ_R2_HISTORY_DROPBOX_ROOT is not a directory: {r2_root}",
                )
            elif not os.access(r2_root, os.R_OK):
                errors.append(
                    f"UK_AQ_R2_HISTORY_DROPBOX_ROOT is not readable: {r2_root}",
                )
            elif not _looks_like_r2_history_root(r2_root):
                errors.append(
                    f"UK_AQ_R2_HISTORY_DROPBOX_ROOT does not look like an R2 history backup root: {r2_root}.",
                )

    # Source adapter dependency checks (local import only; no network in preflight).
    if args.source in {"openaq", "all", "sensorcommunity", "uk_air_sos"}:
        for module_name in ("gzip", "hashlib", "urllib.request", "sqlite3"):
            try:
                __import__(module_name)
            except Exception as exc:  # pragma: no cover - defensive
                errors.append(f"required Python module '{module_name}' failed to import ({exc}).")

    daily_task_health_enabled = _daily_task_health_enabled()
    if daily_task_health_enabled:
        env_file_raw = str(os.environ.get("UK_AQ_BACKFILL_ENV_FILE", "")).strip()
        loaded_daily_env: dict[str, str] = {}
        if not env_file_raw:
            errors.append(
                "UK_AQ_BACKFILL_ENV_FILE is required when daily task health reporting is enabled.",
            )
        else:
            env_file_path = Path(env_file_raw)
            if not env_file_path.exists():
                errors.append(f"UK_AQ_BACKFILL_ENV_FILE does not exist: {env_file_path}")
            elif not env_file_path.is_file():
                errors.append(f"UK_AQ_BACKFILL_ENV_FILE is not a regular file: {env_file_path}")
            elif not os.access(env_file_path, os.R_OK):
                errors.append(f"UK_AQ_BACKFILL_ENV_FILE is not readable: {env_file_path}")
            else:
                loaded_daily_env = _load_env_file(env_file_path)

        if env_file_raw:
            other_env = "LIVE" if args.env == "CIC-Test" else "CIC-Test"
            if f"/{other_env}/" in env_file_raw:
                errors.append(
                    f"--env {args.env} but UK_AQ_BACKFILL_ENV_FILE contains /{other_env}/. Refusing to run.",
                )

        obs_supabase_url = str(
            loaded_daily_env.get("OBS_AQIDB_SUPABASE_URL", ""),
        ).strip()
        obs_supabase_key = str(
            loaded_daily_env.get("OBS_AQIDB_SECRET_KEY", ""),
        ).strip()
        if not obs_supabase_url:
            errors.append(
                "OBS_AQIDB_SUPABASE_URL is required in UK_AQ_BACKFILL_ENV_FILE when daily task health reporting is enabled.",
            )
        if not obs_supabase_key:
            errors.append(
                "OBS_AQIDB_SECRET_KEY is required in UK_AQ_BACKFILL_ENV_FILE when daily task health reporting is enabled.",
            )

    if args.run_backfill:
        wrapper_raw = resolve_integrity_backfill_wrapper()
        if not wrapper_raw:
            errors.append(
                "Backfill wrapper is required when --run-backfill is used, but none of "
                "UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER / UK_AQ_INTEGRITY_BACKFILL_WRAPPER is set.",
            )
        else:
            wrapper_path = Path(wrapper_raw)
            if not wrapper_path.exists():
                errors.append(f"integrity backfill wrapper does not exist: {wrapper_path}")
            elif not wrapper_path.is_file():
                errors.append(f"integrity backfill wrapper is not a regular file: {wrapper_path}")
            elif not os.access(wrapper_path, os.X_OK):
                errors.append(f"integrity backfill wrapper is not executable: {wrapper_path}")

        env_file_raw = str(os.environ.get("UK_AQ_BACKFILL_ENV_FILE", "")).strip()
        loaded_backfill_env: dict[str, str] = {}
        if not env_file_raw:
            errors.append(
                "UK_AQ_BACKFILL_ENV_FILE is required when --run-backfill is used, but it is not set.",
            )
        else:
            env_file_path = Path(env_file_raw)
            if not env_file_path.exists():
                errors.append(f"UK_AQ_BACKFILL_ENV_FILE does not exist: {env_file_path}")
            elif not env_file_path.is_file():
                errors.append(f"UK_AQ_BACKFILL_ENV_FILE is not a regular file: {env_file_path}")
            elif not os.access(env_file_path, os.R_OK):
                errors.append(f"UK_AQ_BACKFILL_ENV_FILE is not readable: {env_file_path}")
            else:
                loaded_backfill_env = _load_env_file(env_file_path)

        if env_file_raw:
            other_env = "LIVE" if args.env == "CIC-Test" else "CIC-Test"
            if f"/{other_env}/" in env_file_raw:
                errors.append(
                    f"--env {args.env} but UK_AQ_BACKFILL_ENV_FILE contains /{other_env}/. Refusing to run.",
                )

        nested_wrapper = loaded_backfill_env.get("UK_AQ_BACKFILL_WRAPPER", "").strip()
        wrapper_is_integrity = Path(wrapper_raw).name == "uk_aq_integrity_backfill.sh" if wrapper_raw else False
        if wrapper_is_integrity and not nested_wrapper:
            errors.append(
                "UK_AQ_BACKFILL_WRAPPER in UK_AQ_BACKFILL_ENV_FILE is required when the integrity wrapper is used, but it is not set.",
            )
        if nested_wrapper:
            nested_wrapper_path = Path(nested_wrapper)
            if not nested_wrapper_path.exists():
                errors.append(
                    f"UK_AQ_BACKFILL_WRAPPER in UK_AQ_BACKFILL_ENV_FILE does not exist: {nested_wrapper_path}",
                )
            elif not nested_wrapper_path.is_file():
                errors.append(
                    f"UK_AQ_BACKFILL_WRAPPER in UK_AQ_BACKFILL_ENV_FILE is not a regular file: {nested_wrapper_path}",
                )
            elif not os.access(nested_wrapper_path, os.X_OK):
                errors.append(
                    f"UK_AQ_BACKFILL_WRAPPER in UK_AQ_BACKFILL_ENV_FILE is not executable: {nested_wrapper_path}",
                )
            if f"/{'LIVE' if args.env == 'CIC-Test' else 'CIC-Test'}/" in nested_wrapper:
                errors.append(
                    f"--env {args.env} but nested UK_AQ_BACKFILL_WRAPPER contains the other env path: {nested_wrapper}",
                )
            if wrapper_raw:
                outer_wrapper_path = Path(wrapper_raw)
                try:
                    same_wrapper = (
                        nested_wrapper_path.resolve(strict=False)
                        == outer_wrapper_path.resolve(strict=False)
                    )
                except OSError:
                    same_wrapper = str(nested_wrapper_path) == str(outer_wrapper_path)
                if same_wrapper:
                    errors.append(
                        "nested UK_AQ_BACKFILL_WRAPPER resolves to the integrity wrapper path; this would recurse. "
                        "Set UK_AQ_BACKFILL_WRAPPER in UK_AQ_BACKFILL_ENV_FILE to the real backfill runner "
                        "(for example scripts/uk_aq_backfill_local.sh).",
                    )

        for opt_name in (
            "UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER",
            "UK_AQ_INTEGRITY_BACKFILL_WRAPPER",
        ):
            opt_raw = str(os.environ.get(opt_name, "")).strip()
            if not opt_raw:
                continue
            opt_path = Path(opt_raw)
            if not opt_path.exists():
                errors.append(f"{opt_name} does not exist: {opt_path}")
            elif not opt_path.is_file():
                errors.append(f"{opt_name} is not a regular file: {opt_path}")
            elif not os.access(opt_path, os.X_OK):
                errors.append(f"{opt_name} is not executable: {opt_path}")

        if wrapper_raw:
            wrapper_path = Path(wrapper_raw)
            supports_obs, supports_aqi = _detect_integrity_wrapper_capabilities(
                wrapper_path=wrapper_path,
                env_name=args.env,
            )
            if not supports_obs or not supports_aqi:
                supports_output_scope = _is_truthy(
                    os.environ.get("UK_AQ_BACKFILL_SUPPORTS_OUTPUT_SCOPE"),
                )
                supports_aqi_mode = _is_truthy(
                    os.environ.get("UK_AQ_BACKFILL_SUPPORTS_R2_HISTORY_OBS_TO_AQILEVELS"),
                )
                if not supports_output_scope:
                    errors.append(
                        "Backfill capability check failed: output-scope support not detected. "
                        "Set UK_AQ_BACKFILL_SUPPORTS_OUTPUT_SCOPE=true or use a wrapper exposing --observs-only/--aqi-only.",
                    )
                if not supports_aqi_mode:
                    errors.append(
                        "Backfill capability check failed: AQI rebuild mode support not detected. "
                        "Set UK_AQ_BACKFILL_SUPPORTS_R2_HISTORY_OBS_TO_AQILEVELS=true.",
                    )

    window_from, window_to = compute_window(
        args.profile, args.from_day, args.to_day, os.environ,
    )

    summary = {
        "env": args.env,
        "profile": args.profile,
        "source": args.source,
        "from_day": window_from,
        "to_day": window_to,
        "check_only": bool(args.check_only),
        "dry_run": bool(args.dry_run),
        "run_backfill": bool(args.run_backfill),
        "daily_task_health_enabled": daily_task_health_enabled,
        "daily_task_health_strict": _daily_task_health_strict(),
        "cross_check_enabled": not args.skip_cross_check,
        "paths": {
            "root": env["UK_AQ_HISTORY_INTEGRITY_ROOT"],
            "state_dir": env["UK_AQ_HISTORY_INTEGRITY_STATE_DIR"],
            "db_path": env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"],
            "snapshot_root": env["UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT"],
            "r2_history_root": str(os.environ.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT", "")),
            "backfill_wrapper": resolve_integrity_backfill_wrapper(),
            "backfill_env_file": str(os.environ.get("UK_AQ_BACKFILL_ENV_FILE", "")),
        },
    }
    return errors, warnings, summary


def run_preflight_or_die(
    args: argparse.Namespace,
    env: dict[str, str],
) -> dict[str, Any]:
    errors, warnings, summary = collect_preflight_errors(args, env)
    print(
        "preflight: "
        f"env={summary['env']} profile={summary['profile']} source={summary['source']} "
        f"window={summary['from_day']}..{summary['to_day']} "
        f"check_only={summary['check_only']} dry_run={summary['dry_run']} "
        f"run_backfill={summary['run_backfill']} cross_check_enabled={summary['cross_check_enabled']}"
    )
    print(
        "preflight paths: "
        f"state={summary['paths']['state_dir']} db={summary['paths']['db_path']} "
        f"snapshot={summary['paths']['snapshot_root']} r2={summary['paths']['r2_history_root'] or '<unset>'} "
        f"wrapper={summary['paths']['backfill_wrapper'] or '<unset>'}"
    )
    for warning in warnings:
        print(f"WARNING preflight: {warning}")
    if errors:
        for err in errors:
            print(f"ERROR preflight: {err}", file=sys.stderr)
        sys.exit(7)
    return summary


def resolve_integrity_end_back_days(env: Mapping[str, str] | None = None) -> int:
    source = env if env is not None else os.environ
    raw_retention = str(source.get("INGESTDB_RETENTION_DAYS", "")).strip()
    if not raw_retention:
        # Reuse ops/backfill env as a single source of truth when present.
        backfill_env_file = str(source.get("UK_AQ_BACKFILL_ENV_FILE", "")).strip()
        if backfill_env_file:
            try:
                loaded = _load_env_file(Path(backfill_env_file))
                raw_retention = str(
                    loaded.get("INGESTDB_RETENTION_DAYS", ""),
                ).strip()
            except OSError:
                raw_retention = ""
    retention_days = DEFAULT_INGESTDB_RETENTION_DAYS
    if raw_retention:
        try:
            parsed = int(raw_retention)
            if parsed > 0:
                retention_days = parsed
        except ValueError:
            pass
    # Keep integrity windows aligned with Phase B eligibility:
    # latest eligible R2 day = today - (retention_days + 1).
    return retention_days + 1


def compute_window(
    profile: str,
    from_day: str | None,
    to_day: str | None,
    env: Mapping[str, str] | None = None,
) -> tuple[str | None, str | None]:
    if profile == "manual":
        return (from_day, to_day)
    today = utc_now().date()
    start_back = PROFILE_START_WINDOWS_DAYS[profile]
    end_back = resolve_integrity_end_back_days(env)
    default_from = (today - dt.timedelta(days=start_back)).isoformat()
    default_to = (today - dt.timedelta(days=end_back)).isoformat()
    return (from_day or default_from, to_day or default_to)


CONSOLE_PROGRESS_UPDATE_SECONDS = 0.2


class ConsoleNoiseFilter(logging.Filter):
    """Keep console output compact while preserving full file logs."""

    _blocked_prefixes = (
        "openaq first_seen ",
        "openaq changed ",
        "openaq reappeared ",
        "sensorcommunity first_seen ",
        "sensorcommunity changed ",
        "sensorcommunity reappeared ",
        "openaq planned backfill: ",
        "sensorcommunity planned backfill: ",
        "cross-check planned observation repair: ",
        "backfill loading env_file=",
        "backfill invoke wrapper=",
        "backfill done status=",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        for prefix in self._blocked_prefixes:
            if msg.startswith(prefix):
                return False
        return True


class SingleLineProgress:
    """Terminal one-line progress reporter.

    Uses carriage-return updates so the screen stays concise.
    """

    def __init__(self, label: str) -> None:
        self.label = label
        self._last_emit_mono = 0.0
        self._last_width = 0
        self._active = False

    def update(self, text: str, force: bool = False) -> None:
        now = time.monotonic()
        if not force and (now - self._last_emit_mono) < CONSOLE_PROGRESS_UPDATE_SECONDS:
            return
        self._last_emit_mono = now
        line = f"{self.label}: {text}"
        pad = max(0, self._last_width - len(line))
        sys.stdout.write("\r" + line + (" " * pad))
        sys.stdout.flush()
        self._last_width = len(line)
        self._active = True

    def finish(self) -> None:
        if not self._active:
            return
        sys.stdout.write("\n")
        sys.stdout.flush()
        self._active = False


def open_db(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA_SQL)
    # In-place schema additions for DBs created by earlier phases.
    ensure_columns(conn, "core_snapshot_imports", {
        "snapshot_day_utc": "TEXT",
        "bytes_read": "INTEGER DEFAULT 0",
    })
    ensure_columns(conn, "integrity_runs", {
        "backfills_ok": "INTEGER DEFAULT 0",
        "backfills_failed": "INTEGER DEFAULT 0",
        "cross_checks_total": "INTEGER DEFAULT 0",
        "cross_checks_ok": "INTEGER DEFAULT 0",
        "cross_checks_mismatch": "INTEGER DEFAULT 0",
        "cross_checks_source_only": "INTEGER DEFAULT 0",
        "cross_checks_r2_only": "INTEGER DEFAULT 0",
        "cross_checks_r2_manifest_missing": "INTEGER DEFAULT 0",
        "observation_backfills_attempted": "INTEGER DEFAULT 0",
        "observation_backfills_ok": "INTEGER DEFAULT 0",
        "observation_backfills_failed": "INTEGER DEFAULT 0",
        "aqi_rebuilds_queued_from_obs_repair": "INTEGER DEFAULT 0",
        "aqi_health_connector_days_checked": "INTEGER DEFAULT 0",
        "aqi_health_rebuilds_queued": "INTEGER DEFAULT 0",
        "aqi_health_skipped_already_obs_repaired": "INTEGER DEFAULT 0",
        "aqi_health_manifest_missing": "INTEGER DEFAULT 0",
        "aqi_health_manifest_stale": "INTEGER DEFAULT 0",
        "aqi_health_manifest_empty": "INTEGER DEFAULT 0",
        "aqi_health_previous_rebuild_failed": "INTEGER DEFAULT 0",
        "aqi_rebuilds_queued_total": "INTEGER DEFAULT 0",
        "aqi_rebuilds_attempted": "INTEGER DEFAULT 0",
        "aqi_rebuilds_complete": "INTEGER DEFAULT 0",
        "aqi_rebuilds_failed": "INTEGER DEFAULT 0",
        "aqi_rebuilds_skipped": "INTEGER DEFAULT 0",
    })
    conn.commit()
    return conn


def normalize_source_key_sensorcommunity(
    conn: sqlite3.Connection,
    log: logging.Logger,
) -> None:
    """Canonicalize legacy Sensor.Community source_key variants in-place."""
    normalized_expr = "lower(replace(replace(source_key, '-', ''), '_', ''))"
    target_key = SC_SOURCE_KEY
    changed_total = 0

    # Lookup table has a PK on (source_key, source_location_id, timeseries_id).
    # Delete legacy rows that would collide with an existing canonical row first.
    changed_total += conn.execute(
        f"""
        DELETE FROM source_station_timeseries_lookup AS legacy
        WHERE {normalized_expr} = 'sensorcommunity'
          AND source_key <> ?
          AND EXISTS (
            SELECT 1
            FROM source_station_timeseries_lookup AS canonical
            WHERE canonical.source_key = ?
              AND canonical.source_location_id = legacy.source_location_id
              AND canonical.timeseries_id = legacy.timeseries_id
          )
        """,
        (target_key, target_key),
    ).rowcount or 0
    changed_total += conn.execute(
        f"""
        UPDATE source_station_timeseries_lookup
        SET source_key = ?
        WHERE {normalized_expr} = 'sensorcommunity'
          AND source_key <> ?
        """,
        (target_key, target_key),
    ).rowcount or 0

    for table_name in ("source_file_state", "source_file_events"):
        changed_total += conn.execute(
            f"""
            UPDATE {table_name}
            SET source_key = ?
            WHERE {normalized_expr} = 'sensorcommunity'
              AND source_key <> ?
            """,
            (target_key, target_key),
        ).rowcount or 0

    if changed_total > 0:
        conn.commit()
        log.info(
            "source_key normalization: canonicalized Sensor.Community rows=%s",
            changed_total,
        )


def setup_logging(log_dir: str, run_compact: str, verbose: bool) -> Path:
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    log_path = Path(log_dir) / f"run-{run_compact}.log"

    level = logging.DEBUG if verbose else logging.INFO
    formatter = logging.Formatter(
        fmt="%(asctime)sZ %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    formatter.converter = time.gmtime

    root = logging.getLogger()
    root.setLevel(level)
    # Clear any handlers carried over from re-entry in tests / repeated runs.
    for handler in list(root.handlers):
        root.removeHandler(handler)

    fh = logging.FileHandler(log_path)
    fh.setFormatter(formatter)
    fh.setLevel(level)
    root.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(formatter)
    sh.setLevel(level)
    sh.addFilter(ConsoleNoiseFilter())
    root.addHandler(sh)

    return log_path


def format_summary_md(s: dict[str, Any]) -> str:
    lines = [
        f"# UK-AQ History Integrity run — {s['env']} / {s['profile']}",
        "",
        f"- Started:   {s['started_at_utc']}",
        f"- Finished:  {s.get('finished_at_utc', '')}",
        f"- Status:    {s['status']}",
        f"- Source:    {s['source']}",
        f"- Window:    {s.get('from_day') or '(none)'} -> {s.get('to_day') or '(none)'}",
        f"- Dry run:   {s['dry_run']}",
        f"- Check only:{s['check_only']}",
        f"- Run backfill: {s['run_backfill']}",
        f"- DB:        {s['db_path']}",
        f"- Log:       {s['log_path']}",
        "",
    ]

    snap = s.get("snapshot") or {}
    if snap:
        lines.extend([
            "## Core snapshot",
            "",
            f"- Status:        {snap.get('status')}",
            f"- Snapshot day:  {snap.get('snapshot_day_utc') or '(none)'}",
            f"- Manifest hash: {snap.get('manifest_hash') or '(none)'}",
            f"- Previous hash: {snap.get('previous_manifest_hash') or '(none)'}",
            f"- Snapshot dir:  {snap.get('snapshot_day_dir') or '(none)'}",
            f"- Bytes read:    {snap.get('bytes_read', 0)}",
            f"- Lookup rows:   {snap.get('rows_lookup', 0)}",
        ])
        tables = snap.get("tables") or {}
        if tables:
            lines.append("- Table rows:")
            for table in ("connectors", "stations", "timeseries", "phenomena"):
                if table in tables:
                    lines.append(f"  - {table}: {tables[table]}")
        if snap.get("error"):
            lines.append(f"- Error:         {snap['error']}")
        lines.append("")
    lookup_counts = s.get("lookup_source_counts") or {}
    if lookup_counts:
        lines.extend([
            "## Active lookup counts",
            "",
        ])
        for source_key in ("openaq", "sensorcommunity", "uk_air_sos"):
            entry = lookup_counts.get(source_key) or {}
            lines.append(
                f"- {source_key}: stations={int(entry.get('active_stations', 0))} "
                f"timeseries={int(entry.get('active_timeseries', 0))}"
            )
        lines.append("")

    sc = s.get("sensor_community") or {}
    if sc.get("ran") or sc.get("skipped_reason"):
        lines.extend([
            "## Sensor.Community",
            "",
            f"- Ran:            {bool(sc.get('ran'))}",
            f"- Sensors:        {sc.get('sensors', 0)}",
            f"- Days:           {sc.get('days', 0)}",
            f"- Index fetches:  {sc.get('index_fetched', 0)}",
            f"- HEAD checked:   {sc.get('head_checked', 0)}",
            f"- Downloaded:     {sc.get('downloaded', 0)}",
            f"- First seen:     {sc.get('first_seen', 0)}",
            f"- Changed:        {sc.get('changed', 0)}",
            f"- Unchanged DL:   {sc.get('unchanged_after_download', 0)}",
            f"- Missing:        {sc.get('missing', 0)}",
            f"- Errors:         {sc.get('errors', 0)}",
            f"- Downloaded MB:  {round(sc.get('downloaded_bytes', 0) / (1024 * 1024), 4)}",
            f"- Stopped for:    {sc.get('stopped_for') or '(none)'}",
            f"- Backfills:      attempted={sc.get('backfills_attempted', 0)} ok={sc.get('backfills_ok', 0)} failed={sc.get('backfills_failed', 0)}",
        ])
        if sc.get("skipped_reason"):
            lines.append(f"- Skipped reason: {sc['skipped_reason']}")
        sc_first_seen = sc.get("first_seen_files") or []
        if sc_first_seen:
            lines.extend(["", "### First-seen files (sensorcommunity, baselined — not backfilled)", ""])
            for entry in sc_first_seen[:50]:
                lines.append(
                    f"- {entry['sensor_id']} / {entry['day']} "
                    f"(event_id={entry.get('event_id')}, "
                    f"type={entry.get('event_type')}, "
                    f"timeseries={entry.get('timeseries_ids')})"
                )
            if len(sc_first_seen) > 50:
                lines.append(f"- ... {len(sc_first_seen) - 50} more")
        sc_changed = sc.get("changed_files") or []
        if sc_changed:
            lines.extend(["", "### Changed files (sensorcommunity)", ""])
            for entry in sc_changed[:50]:
                lines.append(
                    f"- {entry['sensor_id']} / {entry['day']} "
                    f"(event_id={entry.get('event_id')}, "
                    f"type={entry.get('event_type')}, "
                    f"timeseries={entry.get('timeseries_ids')})"
                )
            if len(sc_changed) > 50:
                lines.append(f"- ... {len(sc_changed) - 50} more")
        lines.append("")

    cc_for_sos = s.get("cross_check") or {}
    sos = s.get("uk_air_sos") or {}
    if sos.get("ran") or sos.get("skipped_reason"):
        lines.extend([
            "## UK-AIR SOS",
            "",
            f"- Ran:            {bool(sos.get('ran'))}",
            f"- Stations:       {sos.get('stations', 0)}",
            f"- Days:           {sos.get('days', 0)}",
            f"- Station-days checked: {sos.get('station_days_checked', sos.get('head_checked', 0))}",
            f"- Successful snapshots: {sos.get('snapshots_successful', 0)}",
            f"- No-data snapshots: {sos.get('snapshots_no_data', 0)}",
            f"- Not-found (404): {sos.get('not_found', 0)}",
            f"- Not-found suppressed: {sos.get('not_found_suppressed', 0)}",
            f"- First seen:     {sos.get('first_seen', 0)}",
            f"- Changed:        {sos.get('changed', 0)}",
            f"- Reappeared:     {sos.get('reappeared', 0)}",
            f"- Unchanged:      {sos.get('unchanged_after_download', 0)}",
            f"- Missing:        {sos.get('missing', 0)}",
            f"- Temporary errors:{sos.get('temporary_errors', 0)}",
            f"- Permanent errors:{sos.get('permanent_errors', 0)}",
            f"- Rows counted:   {sos.get('rows_counted', 0)}",
            f"- Downloaded MB:  {round(sos.get('downloaded_bytes', 0) / (1024 * 1024), 4)}",
            f"- Cache keep policy: {sos.get('keep_api_snapshots_policy') or '(default)'}",
            f"- Not-found cooldown secs: {sos.get('not_found_cooldown_seconds', 0)}",
            f"- Cross-check discrepancies: {cc_for_sos.get('discrepancy_total', 0)}",
            f"- Observation repairs: attempted={cc_for_sos.get('observation_backfills_attempted', cc_for_sos.get('backfills_attempted', 0))} ok={cc_for_sos.get('observation_backfills_ok', cc_for_sos.get('backfills_ok', 0))} failed={cc_for_sos.get('observation_backfills_failed', cc_for_sos.get('backfills_failed', 0))}",
            f"- AQI rebuilds: queued={cc_for_sos.get('aqi_rebuilds_queued_total', 0)} complete={cc_for_sos.get('aqi_rebuilds_complete', 0)} failed={cc_for_sos.get('aqi_rebuilds_failed', 0)}",
            f"- Stopped for:    {sos.get('stopped_for') or '(none)'}",
            f"- Backfills:      attempted={sos.get('backfills_attempted', 0)} ok={sos.get('backfills_ok', 0)} failed={sos.get('backfills_failed', 0)}",
        ])
        if sos.get("skipped_reason"):
            lines.append(f"- Skipped reason: {sos['skipped_reason']}")
        sos_first_seen = sos.get("first_seen_files") or []
        if sos_first_seen:
            lines.extend(["", "### First-seen station/day snapshots (uk_air_sos, baselined — not backfilled)", ""])
            for entry in sos_first_seen[:50]:
                lines.append(
                    f"- {entry['station_ref']} / {entry['day']} "
                    f"(event_id={entry.get('event_id')}, "
                    f"type={entry.get('event_type')}, "
                    f"timeseries={entry.get('timeseries_ids')})"
                )
            if len(sos_first_seen) > 50:
                lines.append(f"- ... {len(sos_first_seen) - 50} more")
        sos_changed = sos.get("changed_files") or []
        if sos_changed:
            lines.extend(["", "### Changed station/day snapshots (uk_air_sos)", ""])
            for entry in sos_changed[:50]:
                lines.append(
                    f"- {entry['station_ref']} / {entry['day']} "
                    f"(event_id={entry.get('event_id')}, "
                    f"type={entry.get('event_type')}, "
                    f"timeseries={entry.get('timeseries_ids')})"
                )
            if len(sos_changed) > 50:
                lines.append(f"- ... {len(sos_changed) - 50} more")
        lines.append("")

    oq = s.get("openaq") or {}
    if oq.get("ran") or oq.get("skipped_reason"):
        lines.extend([
            "## OpenAQ",
            "",
            f"- Ran:            {bool(oq.get('ran'))}",
            f"- Locations:      {oq.get('locations', 0)}",
            f"- Days:           {oq.get('days', 0)}",
            f"- HEAD checked:   {oq.get('head_checked', 0)}",
            f"- Downloaded:     {oq.get('downloaded', 0)}",
            f"- First seen:     {oq.get('first_seen', 0)}",
            f"- Changed:        {oq.get('changed', 0)}",
            f"- Unchanged DL:   {oq.get('unchanged_after_download', 0)}",
            f"- Missing (404):  {oq.get('missing', 0)}",
            f"- Errors:         {oq.get('errors', 0)}",
            f"- Downloaded MB:  {round(oq.get('downloaded_bytes', 0) / (1024 * 1024), 4)}",
            f"- Stopped for:    {oq.get('stopped_for') or '(none)'}",
            f"- Backfills:      attempted={oq.get('backfills_attempted', 0)} ok={oq.get('backfills_ok', 0)} failed={oq.get('backfills_failed', 0)}",
        ])
        if oq.get("skipped_reason"):
            lines.append(f"- Skipped reason: {oq['skipped_reason']}")
        first_seen_oq = oq.get("first_seen_files") or []
        if first_seen_oq:
            lines.extend(["", "### First-seen files (baselined — not backfilled)", ""])
            for entry in first_seen_oq[:50]:
                lines.append(
                    f"- {entry['location_id']} / {entry['day']} "
                    f"(event_id={entry.get('event_id')}, "
                    f"type={entry.get('event_type')}, "
                    f"timeseries={entry.get('timeseries_ids')})"
                )
            if len(first_seen_oq) > 50:
                lines.append(f"- ... {len(first_seen_oq) - 50} more")
        changed = oq.get("changed_files") or []
        if changed:
            lines.extend(["", "### Changed files", ""])
            for entry in changed[:50]:
                lines.append(
                    f"- {entry['location_id']} / {entry['day']} "
                    f"(event_id={entry.get('event_id')}, "
                    f"type={entry.get('event_type')}, "
                    f"timeseries={entry.get('timeseries_ids')})"
                )
            if len(changed) > 50:
                lines.append(f"- ... {len(changed) - 50} more")
        planned = oq.get("planned_backfills") or []
        if planned:
            lines.extend(["", "### Planned backfill commands (--run-backfill, not executed)", ""])
            for cmd in planned[:20]:
                lines.extend(["```bash", cmd, "```"])
            if len(planned) > 20:
                lines.append(f"... {len(planned) - 20} more")
        lines.append("")

    cc = s.get("cross_check") or {}
    if cc.get("ran") or cc.get("skipped_reason"):
        lines.extend([
            "## R2 Cross-check",
            "",
            f"- Ran:                      {bool(cc.get('ran'))}",
            f"- Source rows:              {cc.get('source_rows', 0)}",
            f"- Connector-days:           {cc.get('connector_days', 0)}",
            f"- Missing manifests:        {cc.get('manifests_missing_days', 0)}",
            f"- Missing timeseries counts days: {cc.get('timeseries_counts_missing_days', 0)}",
            f"- cross_checks_total:       {cc.get('cross_checks_total', 0)}",
            f"- cross_checks_ok:          {cc.get('cross_checks_ok', 0)}",
            f"- cross_checks_mismatch:    {cc.get('cross_checks_mismatch', 0)}",
            f"- cross_checks_source_only: {cc.get('cross_checks_source_only', 0)}",
            f"- cross_checks_r2_only:     {cc.get('cross_checks_r2_only', 0)}",
            f"- cross_checks_r2_manifest_missing: {cc.get('cross_checks_r2_manifest_missing', 0)}",
            f"- cross_checks_r2_timeseries_counts_missing: {cc.get('cross_checks_r2_timeseries_counts_missing', 0)}",
            f"- Observation repair candidates: days={cc.get('observation_backfill_candidate_days', cc.get('backfill_candidate_days', 0))} timeseries_ids={cc.get('observation_backfill_candidate_timeseries_ids', cc.get('backfill_candidate_timeseries_ids', 0))}",
            f"- Source-change candidates:     days={cc.get('source_change_candidate_days', 0)} timeseries_ids={cc.get('source_change_candidate_timeseries_ids', 0)}",
            f"- Observation repairs:       attempted={cc.get('observation_backfills_attempted', cc.get('backfills_attempted', 0))} ok={cc.get('observation_backfills_ok', cc.get('backfills_ok', 0))} failed={cc.get('observation_backfills_failed', cc.get('backfills_failed', 0))}",
            f"- AQI rebuilds queued:       {cc.get('aqi_rebuilds_queued_from_obs_repair', 0)}",
            f"- AQI health checked connector-days: {cc.get('aqi_health_connector_days_checked', 0)}",
            f"- AQI health rebuilds queued:        {cc.get('aqi_health_rebuilds_queued', 0)}",
            f"- AQI health skipped obs-repaired:   {cc.get('aqi_health_skipped_already_obs_repaired', 0)}",
            f"- AQI health manifest missing:       {cc.get('aqi_health_manifest_missing', 0)}",
            f"- AQI health manifest stale:         {cc.get('aqi_health_manifest_stale', 0)}",
            f"- AQI health manifest empty:         {cc.get('aqi_health_manifest_empty', 0)}",
            f"- AQI health previous rebuild failed:{cc.get('aqi_health_previous_rebuild_failed', 0)}",
            f"- AQI health ran:                    {bool(cc.get('aqi_health_ran'))}",
            f"- AQI rebuild queued total:          {cc.get('aqi_rebuilds_queued_total', 0)}",
            f"- AQI rebuild attempted:             {cc.get('aqi_rebuilds_attempted', 0)}",
            f"- AQI rebuild complete:              {cc.get('aqi_rebuilds_complete', 0)}",
            f"- AQI rebuild failed:                {cc.get('aqi_rebuilds_failed', 0)}",
            f"- AQI rebuild skipped:               {cc.get('aqi_rebuilds_skipped', 0)}",
            f"- AQI rebuild ran:                   {bool(cc.get('aqi_rebuild_ran'))}",
        ])
        if cc.get("aqi_health_skipped_reason"):
            lines.append(f"- AQI health skipped reason:        {cc.get('aqi_health_skipped_reason')}")
        if cc.get("aqi_rebuild_skipped_reason"):
            lines.append(f"- AQI rebuild skipped reason:       {cc.get('aqi_rebuild_skipped_reason')}")
        if cc.get("skipped_reason"):
            lines.append(f"- Skipped reason:           {cc['skipped_reason']}")
        cc_planned = cc.get("planned_observation_backfills") or cc.get("planned_backfills") or []
        if cc_planned:
            lines.extend(["", "### Planned observation repair commands from cross-check", ""])
            for cmd in cc_planned[:20]:
                lines.extend(["```bash", cmd, "```"])
            if len(cc_planned) > 20:
                lines.append(f"... {len(cc_planned) - 20} more")
        planned_aqi = cc.get("planned_aqi_rebuilds") or []
        if planned_aqi:
            lines.extend(["", "### Planned AQI rebuild queue entries from cross-check", ""])
            for entry in planned_aqi[:50]:
                lines.append(f"- {entry}")
            if len(planned_aqi) > 50:
                lines.append(f"- ... {len(planned_aqi) - 50} more")
        aqi_only_queued = cc.get("queued_aqi_only_connector_days") or []
        if aqi_only_queued:
            lines.extend(["", "### AQI-only queued connector-days (Phase 6.7)", ""])
            for entry in aqi_only_queued:
                lines.append(
                    f"- connector={entry.get('connector_id')} day={entry.get('day_utc')} "
                    f"reasons={entry.get('reasons')} notes={entry.get('notes')}"
                )
        planned_aqi_rebuilds = cc.get("planned_aqi_rebuild_commands") or []
        if planned_aqi_rebuilds:
            lines.extend(["", "### Planned AQI rebuild commands (Phase 6.8)", ""])
            for cmd in planned_aqi_rebuilds[:50]:
                lines.extend(["```bash", cmd, "```"])
            if len(planned_aqi_rebuilds) > 50:
                lines.append(f"... {len(planned_aqi_rebuilds) - 50} more")
        aqi_rebuild_results = cc.get("aqi_rebuild_results") or []
        if aqi_rebuild_results:
            lines.extend(["", "### AQI rebuild results (Phase 6.8)", ""])
            for entry in aqi_rebuild_results:
                lines.append(
                    f"- connector={entry.get('connector_id')} day={entry.get('day_utc')} "
                    f"status={entry.get('status')} reasons={entry.get('reasons')} "
                    f"error={entry.get('error')} log_path={entry.get('log_path')}"
                )
        discrepancies = cc.get("discrepancies") or []
        if discrepancies:
            lines.extend(["", "### Discrepancies", ""])
            for entry in discrepancies:
                lines.append(
                    f"- {entry.get('status')} connector={entry.get('connector_id')} "
                    f"day={entry.get('day_utc')} timeseries={entry.get('timeseries_id')} "
                    f"source={entry.get('source_row_count')} r2={entry.get('r2_row_count')} "
                    f"delta={entry.get('delta')}"
                )
            shown = len(discrepancies)
            total = int(cc.get("discrepancy_total", shown) or shown)
            if total > shown:
                lines.append(
                    f"- ... {total - shown} more "
                    f"(report cap={cc.get('discrepancies_truncated_to', shown)})"
                )
        lines.append("")

    lines.extend(["## Metrics", ""])
    m = s.get("metrics", {})
    for key in (
        "files_head_checked",
        "files_downloaded",
        "files_changed",
        "files_unchanged_after_download",
        "files_missing",
        "downloaded_bytes",
        "downloaded_mb",
        "runtime_seconds",
        "backfills_triggered",
        "cross_checks_total",
        "cross_checks_ok",
        "cross_checks_mismatch",
        "cross_checks_source_only",
        "cross_checks_r2_only",
        "cross_checks_r2_manifest_missing",
        "observation_backfills_attempted",
        "observation_backfills_ok",
        "observation_backfills_failed",
        "aqi_rebuilds_queued_from_obs_repair",
        "source_change_candidate_days",
        "source_change_candidate_timeseries_ids",
        "aqi_health_connector_days_checked",
        "aqi_health_rebuilds_queued",
        "aqi_health_skipped_already_obs_repaired",
        "aqi_health_manifest_missing",
        "aqi_health_manifest_stale",
        "aqi_health_manifest_empty",
        "aqi_health_previous_rebuild_failed",
        "aqi_rebuilds_queued_total",
        "aqi_rebuilds_attempted",
        "aqi_rebuilds_complete",
        "aqi_rebuilds_failed",
        "aqi_rebuilds_skipped",
        "uk_air_sos_snapshots_successful",
        "uk_air_sos_snapshots_no_data",
        "uk_air_sos_not_found",
        "uk_air_sos_not_found_suppressed",
        "warnings_count",
        "errors_count",
    ):
        lines.append(f"- {key}: {m.get(key, 0)}")
    notes = s.get("notes")
    if notes:
        lines.extend(["", "## Notes", "", notes])
    lines.append("")
    return "\n".join(lines)


def write_reports(
    report_dir: str,
    run_compact: str,
    summary: dict[str, Any],
) -> tuple[Path, Path]:
    Path(report_dir).mkdir(parents=True, exist_ok=True)
    json_path = Path(report_dir) / f"{run_compact}-summary.json"
    md_path = Path(report_dir) / f"{run_compact}-summary.md"
    json_path.write_text(json.dumps(summary, indent=2, sort_keys=True))
    md_path.write_text(format_summary_md(summary))
    return json_path, md_path


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    env = load_env_or_die()
    preflight_summary = run_preflight_or_die(args, env)

    started_mono = time.monotonic()
    started_at = utc_now()
    started_iso = fmt_iso(started_at)
    run_compact = fmt_compact(started_at)

    log_path = setup_logging(
        env["UK_AQ_HISTORY_INTEGRITY_LOG_DIR"], run_compact, args.verbose
    )
    log = logging.getLogger("uk-aq-history-integrity")

    log.info(
        "start env=%s profile=%s source=%s dry_run=%s check_only=%s run_backfill=%s",
        args.env, args.profile, args.source,
        args.dry_run, args.check_only, args.run_backfill,
    )
    log.info("db=%s", env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"])
    log.info("log_file=%s", log_path)
    log.info("preflight summary=%s", preflight_summary)

    daily_task_health_config = _resolve_daily_task_health_config(env_name=args.env)
    daily_task_health_enabled = bool(daily_task_health_config.get("enabled"))
    daily_task_health_strict = bool(daily_task_health_config.get("strict"))
    daily_task_health_run_id: str | None = None
    daily_task_scheduled_for_date = started_at.date().isoformat()
    daily_task_platform_run_id = f"{args.env}:{run_compact}"
    if daily_task_health_enabled:
        start_summary = {
            "env": args.env,
            "profile": args.profile,
            "source": args.source,
            "from_day": args.from_day,
            "to_day": args.to_day,
            "check_only": bool(args.check_only),
            "dry_run": bool(args.dry_run),
            "run_backfill": bool(args.run_backfill),
            "skip_cross_check": bool(args.skip_cross_check),
            "status": "started",
            "log_path": str(log_path),
        }
        try:
            daily_task_health_run_id = _daily_task_health_start(
                daily_task_health_config,
                scheduled_for_date=daily_task_scheduled_for_date,
                started_at_utc=started_iso,
                summary=start_summary,
                platform_run_id=daily_task_platform_run_id,
                log_url=str(log_path),
            )
        except Exception as exc:
            log.warning("daily task health start failed: %s", exc)
            if daily_task_health_strict:
                log.error("daily task health strict mode enabled; aborting run")
                return 1

    end_back_days = resolve_integrity_end_back_days(os.environ)
    from_day, to_day = compute_window(
        args.profile, args.from_day, args.to_day, os.environ
    )
    log.info("window from=%s to=%s", from_day, to_day)
    if args.profile != "manual":
        log.info(
            "window defaults: profile_start_days=%s r2_end_days=%s (INGESTDB_RETENTION_DAYS+1)",
            PROFILE_START_WINDOWS_DAYS[args.profile],
            end_back_days,
        )
    if args.profile == "manual" and (not from_day or not to_day):
        log.warning(
            "manual profile without --from-day/--to-day; window is open-ended"
        )

    conn = open_db(env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"])
    normalize_source_key_sensorcommunity(conn, log)
    run_id: int | None = None
    try:
        cur = conn.execute(
            """
            INSERT INTO integrity_runs (
              started_at_utc, env_name, profile, source_filter,
              from_day, to_day, status, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                started_iso, args.env, args.profile, args.source,
                from_day, to_day, "running",
                "history integrity run in progress.",
            ),
        )
        run_id = cur.lastrowid
        conn.commit()
        log.info("integrity_runs.id=%s", run_id)

        # Phase 2: import the core snapshot from Dropbox R2 backup.
        snapshot_result: dict[str, Any]
        warnings_delta = 0
        if args.skip_snapshot_import:
            log.warning("--skip-snapshot-import: skipping core snapshot import")
            snapshot_result = {
                "status": "skipped",
                "error": "skipped by --skip-snapshot-import",
                "snapshot_root": os.environ.get("UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT"),
                "snapshot_day_dir": None,
                "snapshot_day_utc": None,
                "manifest_hash": None,
                "previous_manifest_hash": None,
                "tables": {},
                "rows_lookup": 0,
                "bytes_read": 0,
            }
            warnings_delta += 1
        else:
            snapshot_result = import_core_snapshot(
                conn=conn,
                env_name=args.env,
                snapshot_root_str=os.environ.get("UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT"),
                force=args.force_snapshot_import,
                dry_run=args.dry_run,
                log=log,
            )
            if snapshot_result["status"] in {"missing_root", "no_snapshot"}:
                warnings_delta += 1

        # Phase 3 / Phase 5: source adapters share a single LimitTracker
        # so soft caps cover the whole run, not per-adapter.
        limits = LimitTracker(
            max_download_mb=args.max_download_mb,
            max_runtime_minutes=args.max_runtime_minutes,
            started_mono=started_mono,
        )
        snapshot_ok = snapshot_result["status"] in {"imported", "reused"}

        empty_metrics = {"ran": False, "skipped_reason": None}
        openaq_metrics: dict[str, Any] = dict(empty_metrics)
        sc_metrics: dict[str, Any] = dict(empty_metrics)
        sos_metrics: dict[str, Any] = dict(empty_metrics)
        cross_check_metrics: dict[str, Any] = dict(empty_metrics)
        lookup_source_counts: dict[str, dict[str, int]] = (
            collect_lookup_active_counts_by_source(conn)
        )
        sos_counts = lookup_source_counts.get("uk_air_sos", {})
        log.info(
            "lookup active counts: openaq stations=%s timeseries=%s; sensorcommunity stations=%s timeseries=%s; uk_air_sos stations=%s timeseries=%s",
            (lookup_source_counts.get("openaq") or {}).get("active_stations", 0),
            (lookup_source_counts.get("openaq") or {}).get("active_timeseries", 0),
            (lookup_source_counts.get("sensorcommunity") or {}).get("active_stations", 0),
            (lookup_source_counts.get("sensorcommunity") or {}).get("active_timeseries", 0),
            sos_counts.get("active_stations", 0),
            sos_counts.get("active_timeseries", 0),
        )

        run_openaq = args.source in {"openaq", "all"} and snapshot_ok
        if args.source in {"openaq", "all"} and not run_openaq:
            log.warning(
                "openaq: skipped because core snapshot status=%s (need imported/reused)",
                snapshot_result["status"],
            )
        if run_openaq:
            openaq_metrics = check_openaq(
                conn=conn, env_name=args.env, env=env,
                from_day=from_day, to_day=to_day,
                dry_run=args.dry_run, run_backfill=args.run_backfill,
                limits=limits, log=log, run_compact=run_compact,
                concurrency=max(1, int(args.concurrency)),
            )

        run_sc = args.source in {"sensorcommunity", "all"} and snapshot_ok
        if args.source in {"sensorcommunity", "all"} and not run_sc:
            log.warning(
                "sensorcommunity: skipped because core snapshot status=%s (need imported/reused)",
                snapshot_result["status"],
            )
        if run_sc:
            sc_metrics = check_sensor_community(
                conn=conn, env_name=args.env, env=env,
                from_day=from_day, to_day=to_day,
                dry_run=args.dry_run, run_backfill=args.run_backfill,
                limits=limits, log=log, run_compact=run_compact,
                concurrency=max(1, int(args.concurrency)),
            )

        run_sos = args.source in {"uk_air_sos", "all"} and snapshot_ok
        if args.source in {"uk_air_sos", "all"} and not run_sos:
            log.warning(
                "uk_air_sos: skipped because core snapshot status=%s (need imported/reused)",
                snapshot_result["status"],
            )
        if run_sos:
            sos_metrics = check_uk_air_sos(
                conn=conn, env_name=args.env, env=env,
                from_day=from_day, to_day=to_day,
                dry_run=args.dry_run, run_backfill=args.run_backfill,
                limits=limits, log=log,
                concurrency=max(1, int(args.concurrency)),
            )

        if args.skip_cross_check:
            cross_check_metrics = {
                "ran": False,
                "skipped_reason": "skipped by --skip-cross-check",
            }
            log.warning("cross-check: skipped by --skip-cross-check")
        elif not snapshot_ok:
            cross_check_metrics = {
                "ran": False,
                "skipped_reason": (
                    "core snapshot not ready "
                    f"(status={snapshot_result['status']}; need imported/reused)"
                ),
            }
            log.warning("cross-check: skipped — %s", cross_check_metrics["skipped_reason"])
        else:
            cross_check_metrics = run_r2_cross_checks(
                conn=conn,
                run_id=int(run_id),
                env_name=args.env,
                source_filter=args.source,
                from_day=from_day,
                to_day=to_day,
                r2_history_root=os.environ.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT"),
                r2_manifest_prefix=os.environ.get(
                    "UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX"
                ),
                checked_at_utc=fmt_iso(utc_now()),
                log=log,
            )
        if cross_check_metrics.get("ran"):
            cc_backfill_metrics = run_cross_check_backfills(
                conn=conn,
                run_id=int(run_id),
                env_name=args.env,
                run_compact=run_compact,
                env=env,
                source_filter=args.source,
                uk_air_sos_metrics=sos_metrics,
                dry_run=args.dry_run,
                run_backfill=args.run_backfill,
                limits=limits,
                log=log,
            )
            cross_check_metrics.update(cc_backfill_metrics)
            aqi_health_metrics = run_aqi_health_checks(
                conn=conn,
                run_id=int(run_id),
                env_name=args.env,
                r2_history_root=os.environ.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT"),
                r2_aqilevels_prefix=os.environ.get("UK_AQ_R2_HISTORY_AQILEVELS_PREFIX"),
                dry_run=args.dry_run,
                run_backfill=args.run_backfill,
                log=log,
            )
            cross_check_metrics.update(aqi_health_metrics)
            aqi_rebuild_metrics = run_aqi_rebuild_queue_execution(
                conn=conn,
                run_id=int(run_id),
                env_name=args.env,
                run_compact=run_compact,
                env=env,
                dry_run=args.dry_run,
                run_backfill=args.run_backfill,
                limits=limits,
                log=log,
                dry_run_planned_rows=[
                    *(cross_check_metrics.get("planned_aqi_rebuild_connector_days") or []),
                    *(cross_check_metrics.get("queued_aqi_only_connector_days") or []),
                ],
            )
            cross_check_metrics.update(aqi_rebuild_metrics)

        any_adapter_ran = (
            openaq_metrics.get("ran")
            or sc_metrics.get("ran")
            or sos_metrics.get("ran")
        )
        any_stopped = (
            openaq_metrics.get("stopped_for")
            or sc_metrics.get("stopped_for")
            or sos_metrics.get("stopped_for")
        )

        # Decide top-level run status.
        if any_stopped:
            status = "stopped_limit"
        elif any_adapter_ran:
            status = "ok"
        elif args.dry_run:
            status = "noop"
        elif snapshot_ok:
            # Snapshot worked but no source adapter actually ran (filter, no
            # lookup rows, missing date window). Still a clean run.
            status = "ok"
        elif snapshot_result["status"] == "skipped":
            status = "noop"
        else:
            status = "noop"

        # Build the notes from snapshot + openaq outcomes.
        notes_parts: list[str] = []
        if snapshot_result["status"] == "imported":
            notes_parts.append(
                f"snapshot imported day={snapshot_result['snapshot_day_utc']} "
                f"hash={snapshot_result['manifest_hash']} "
                f"lookup_rows={snapshot_result['rows_lookup']}"
            )
        elif snapshot_result["status"] == "reused":
            notes_parts.append(
                f"snapshot reused day={snapshot_result['snapshot_day_utc']} "
                f"hash={snapshot_result['manifest_hash']}"
            )
        elif snapshot_result["status"] == "dry_run":
            notes_parts.append(
                f"snapshot dry-run day={snapshot_result['snapshot_day_utc']}"
            )
        elif snapshot_result["status"] == "skipped":
            notes_parts.append("snapshot skipped (--skip-snapshot-import)")
        else:
            notes_parts.append(
                f"snapshot {snapshot_result['status']}: {snapshot_result.get('error')}"
            )

        for adapter_name, adapter_metrics in (
            ("openaq", openaq_metrics),
            ("sensorcommunity", sc_metrics),
            ("uk_air_sos", sos_metrics),
        ):
            if adapter_metrics.get("ran"):
                notes_parts.append(
                    f"{adapter_name} head_checked={adapter_metrics.get('head_checked', 0)} "
                    f"first_seen={adapter_metrics.get('first_seen', 0)} "
                    f"changed={adapter_metrics.get('changed', 0)} missing={adapter_metrics.get('missing', 0)} "
                    f"downloaded_bytes={adapter_metrics.get('downloaded_bytes', 0)} "
                    f"errors={adapter_metrics.get('errors', 0)} "
                    f"backfills_attempted={adapter_metrics.get('backfills_attempted', 0)} "
                    f"backfills_ok={adapter_metrics.get('backfills_ok', 0)} "
                    f"backfills_failed={adapter_metrics.get('backfills_failed', 0)}"
                )
                if adapter_metrics.get("stopped_for"):
                    notes_parts.append(f"{adapter_name} stopped_for={adapter_metrics['stopped_for']}")
            elif adapter_metrics.get("skipped_reason"):
                notes_parts.append(f"{adapter_name} skipped: {adapter_metrics['skipped_reason']}")
        if cross_check_metrics.get("ran"):
            notes_parts.append(
                "cross-check "
                f"total={cross_check_metrics.get('cross_checks_total', 0)} "
                f"ok={cross_check_metrics.get('cross_checks_ok', 0)} "
                f"mismatch={cross_check_metrics.get('cross_checks_mismatch', 0)} "
                f"source_only={cross_check_metrics.get('cross_checks_source_only', 0)} "
                f"r2_only={cross_check_metrics.get('cross_checks_r2_only', 0)} "
                f"manifest_missing={cross_check_metrics.get('cross_checks_r2_manifest_missing', 0)} "
                f"r2_timeseries_counts_missing={cross_check_metrics.get('cross_checks_r2_timeseries_counts_missing', 0)}"
            )
            if args.run_backfill:
                notes_parts.append(
                    "cross-check-observation-repair "
                    f"candidates_days={cross_check_metrics.get('observation_backfill_candidate_days', cross_check_metrics.get('backfill_candidate_days', 0))} "
                    f"candidates_timeseries_ids={cross_check_metrics.get('observation_backfill_candidate_timeseries_ids', cross_check_metrics.get('backfill_candidate_timeseries_ids', 0))} "
                    f"source_change_days={cross_check_metrics.get('source_change_candidate_days', 0)} "
                    f"source_change_timeseries_ids={cross_check_metrics.get('source_change_candidate_timeseries_ids', 0)} "
                    f"attempted={cross_check_metrics.get('observation_backfills_attempted', cross_check_metrics.get('backfills_attempted', 0))} "
                    f"ok={cross_check_metrics.get('observation_backfills_ok', cross_check_metrics.get('backfills_ok', 0))} "
                    f"failed={cross_check_metrics.get('observation_backfills_failed', cross_check_metrics.get('backfills_failed', 0))} "
                    f"aqi_rebuilds_queued={cross_check_metrics.get('aqi_rebuilds_queued_from_obs_repair', 0)}"
                )
                notes_parts.append(
                    "aqi-health-check "
                    f"checked={cross_check_metrics.get('aqi_health_connector_days_checked', 0)} "
                    f"queued={cross_check_metrics.get('aqi_health_rebuilds_queued', 0)} "
                    f"skipped_obs_repaired={cross_check_metrics.get('aqi_health_skipped_already_obs_repaired', 0)} "
                    f"manifest_missing={cross_check_metrics.get('aqi_health_manifest_missing', 0)} "
                    f"manifest_stale={cross_check_metrics.get('aqi_health_manifest_stale', 0)} "
                    f"manifest_empty={cross_check_metrics.get('aqi_health_manifest_empty', 0)} "
                    f"previous_rebuild_failed={cross_check_metrics.get('aqi_health_previous_rebuild_failed', 0)}"
                )
                if cross_check_metrics.get("aqi_health_skipped_reason"):
                    notes_parts.append(
                        "aqi-health-check-skipped "
                        f"reason={cross_check_metrics.get('aqi_health_skipped_reason')}"
                    )
                notes_parts.append(
                    "aqi-rebuild-execution "
                    f"queued_total={cross_check_metrics.get('aqi_rebuilds_queued_total', 0)} "
                    f"attempted={cross_check_metrics.get('aqi_rebuilds_attempted', 0)} "
                    f"complete={cross_check_metrics.get('aqi_rebuilds_complete', 0)} "
                    f"failed={cross_check_metrics.get('aqi_rebuilds_failed', 0)} "
                    f"skipped={cross_check_metrics.get('aqi_rebuilds_skipped', 0)}"
                )
                if cross_check_metrics.get("aqi_rebuild_skipped_reason"):
                    notes_parts.append(
                        "aqi-rebuild-execution-skipped "
                        f"reason={cross_check_metrics.get('aqi_rebuild_skipped_reason')}"
                    )
        elif cross_check_metrics.get("skipped_reason"):
            notes_parts.append(f"cross-check skipped: {cross_check_metrics['skipped_reason']}")

        notes = "; ".join(notes_parts) + "."

        def _sum(key: str) -> int:
            return (
                int(openaq_metrics.get(key, 0))
                + int(sc_metrics.get(key, 0))
                + int(sos_metrics.get(key, 0))
            )

        cross_check_backfills_attempted = int(
            cross_check_metrics.get(
                "observation_backfills_attempted",
                cross_check_metrics.get("backfills_attempted", 0),
            ) or 0
        )
        cross_check_backfills_ok = int(
            cross_check_metrics.get(
                "observation_backfills_ok",
                cross_check_metrics.get("backfills_ok", 0),
            ) or 0
        )
        cross_check_backfills_failed = int(
            cross_check_metrics.get(
                "observation_backfills_failed",
                cross_check_metrics.get("backfills_failed", 0),
            ) or 0
        )
        aqi_rebuilds_queued_from_obs_repair = int(
            cross_check_metrics.get("aqi_rebuilds_queued_from_obs_repair", 0) or 0
        )
        aqi_health_connector_days_checked = int(
            cross_check_metrics.get("aqi_health_connector_days_checked", 0) or 0
        )
        aqi_health_rebuilds_queued = int(
            cross_check_metrics.get("aqi_health_rebuilds_queued", 0) or 0
        )
        aqi_health_skipped_already_obs_repaired = int(
            cross_check_metrics.get("aqi_health_skipped_already_obs_repaired", 0) or 0
        )
        aqi_health_manifest_missing = int(
            cross_check_metrics.get("aqi_health_manifest_missing", 0) or 0
        )
        aqi_health_manifest_stale = int(
            cross_check_metrics.get("aqi_health_manifest_stale", 0) or 0
        )
        aqi_health_manifest_empty = int(
            cross_check_metrics.get("aqi_health_manifest_empty", 0) or 0
        )
        aqi_health_previous_rebuild_failed = int(
            cross_check_metrics.get("aqi_health_previous_rebuild_failed", 0) or 0
        )
        aqi_rebuilds_queued_total = int(
            cross_check_metrics.get("aqi_rebuilds_queued_total", 0) or 0
        )
        aqi_rebuilds_attempted = int(
            cross_check_metrics.get("aqi_rebuilds_attempted", 0) or 0
        )
        aqi_rebuilds_complete = int(
            cross_check_metrics.get("aqi_rebuilds_complete", 0) or 0
        )
        aqi_rebuilds_failed = int(
            cross_check_metrics.get("aqi_rebuilds_failed", 0) or 0
        )
        aqi_rebuilds_skipped = int(
            cross_check_metrics.get("aqi_rebuilds_skipped", 0) or 0
        )

        downloaded_bytes_total = _sum("downloaded_bytes")
        errors_count = (
            _sum("errors")
            + _sum("backfills_failed")
            + cross_check_backfills_failed
            + aqi_rebuilds_failed
        )
        warnings_count_total = warnings_delta
        if openaq_metrics.get("skipped_reason"):
            warnings_count_total += 1
        if sc_metrics.get("skipped_reason"):
            warnings_count_total += 1
        if sos_metrics.get("skipped_reason"):
            warnings_count_total += 1
        if cross_check_metrics.get("skipped_reason"):
            warnings_count_total += 1
        if openaq_metrics.get("stopped_for"):
            warnings_count_total += 1
        if sc_metrics.get("stopped_for"):
            warnings_count_total += 1
        if sos_metrics.get("stopped_for"):
            warnings_count_total += 1

        metrics: dict[str, Any] = {
            "files_head_checked": _sum("head_checked"),
            "files_downloaded": _sum("downloaded"),
            "files_changed": _sum("changed"),
            "files_unchanged_after_download": _sum("unchanged_after_download"),
            "files_missing": _sum("missing"),
            "downloaded_bytes": downloaded_bytes_total,
            "downloaded_mb": round(downloaded_bytes_total / (1024 * 1024), 4),
            "runtime_seconds": 0.0,
            "backfills_triggered": _sum("backfills_attempted") + cross_check_backfills_attempted,
            "backfills_ok": _sum("backfills_ok") + cross_check_backfills_ok,
            "backfills_failed": _sum("backfills_failed") + cross_check_backfills_failed,
            "cross_checks_total": int(cross_check_metrics.get("cross_checks_total", 0) or 0),
            "cross_checks_ok": int(cross_check_metrics.get("cross_checks_ok", 0) or 0),
            "cross_checks_mismatch": int(cross_check_metrics.get("cross_checks_mismatch", 0) or 0),
            "cross_checks_source_only": int(cross_check_metrics.get("cross_checks_source_only", 0) or 0),
            "cross_checks_r2_only": int(cross_check_metrics.get("cross_checks_r2_only", 0) or 0),
            "cross_checks_r2_manifest_missing": int(
                cross_check_metrics.get("cross_checks_r2_manifest_missing", 0) or 0
            ),
            "cross_checks_r2_timeseries_counts_missing": int(
                cross_check_metrics.get("cross_checks_r2_timeseries_counts_missing", 0) or 0
            ),
            "observation_backfills_attempted": cross_check_backfills_attempted,
            "observation_backfills_ok": cross_check_backfills_ok,
            "observation_backfills_failed": cross_check_backfills_failed,
            "aqi_rebuilds_queued_from_obs_repair": aqi_rebuilds_queued_from_obs_repair,
            "aqi_health_connector_days_checked": aqi_health_connector_days_checked,
            "aqi_health_rebuilds_queued": aqi_health_rebuilds_queued,
            "aqi_health_skipped_already_obs_repaired": aqi_health_skipped_already_obs_repaired,
            "aqi_health_manifest_missing": aqi_health_manifest_missing,
            "aqi_health_manifest_stale": aqi_health_manifest_stale,
            "aqi_health_manifest_empty": aqi_health_manifest_empty,
            "aqi_health_previous_rebuild_failed": aqi_health_previous_rebuild_failed,
            "aqi_rebuilds_queued_total": aqi_rebuilds_queued_total,
            "aqi_rebuilds_attempted": aqi_rebuilds_attempted,
            "aqi_rebuilds_complete": aqi_rebuilds_complete,
            "aqi_rebuilds_failed": aqi_rebuilds_failed,
            "aqi_rebuilds_skipped": aqi_rebuilds_skipped,
            "warnings_count": warnings_count_total,
            "errors_count": errors_count,
            "snapshot_status": snapshot_result["status"],
            "snapshot_day_utc": snapshot_result["snapshot_day_utc"],
            "snapshot_manifest_hash": snapshot_result["manifest_hash"],
            "snapshot_tables": snapshot_result["tables"],
            "snapshot_rows_lookup": snapshot_result["rows_lookup"],
            "snapshot_bytes_read": snapshot_result["bytes_read"],
            "openaq_stopped_for": openaq_metrics.get("stopped_for"),
            "openaq_locations": openaq_metrics.get("locations", 0),
            "openaq_days": openaq_metrics.get("days", 0),
            "sensor_community_stopped_for": sc_metrics.get("stopped_for"),
            "sensor_community_sensors": sc_metrics.get("sensors", 0),
            "sensor_community_days": sc_metrics.get("days", 0),
            "sensor_community_index_fetched": sc_metrics.get("index_fetched", 0),
            "uk_air_sos_stopped_for": sos_metrics.get("stopped_for"),
            "uk_air_sos_stations": sos_metrics.get("stations", 0),
            "uk_air_sos_days": sos_metrics.get("days", 0),
            "uk_air_sos_station_days_checked": sos_metrics.get("station_days_checked", 0),
            "uk_air_sos_rows_counted": sos_metrics.get("rows_counted", 0),
            "uk_air_sos_snapshots_successful": sos_metrics.get("snapshots_successful", 0),
            "uk_air_sos_snapshots_no_data": sos_metrics.get("snapshots_no_data", 0),
            "uk_air_sos_not_found": sos_metrics.get("not_found", 0),
            "uk_air_sos_not_found_suppressed": sos_metrics.get("not_found_suppressed", 0),
            "uk_air_sos_temporary_errors": sos_metrics.get("temporary_errors", 0),
            "uk_air_sos_permanent_errors": sos_metrics.get("permanent_errors", 0),
            "uk_air_sos_lookup_active_stations": int(sos_counts.get("active_stations", 0)),
            "uk_air_sos_lookup_active_timeseries": int(sos_counts.get("active_timeseries", 0)),
        }

        finished_at = utc_now()
        finished_iso = fmt_iso(finished_at)
        runtime_seconds = round(time.monotonic() - started_mono, 3)
        metrics["runtime_seconds"] = runtime_seconds

        conn.execute(
            """
            UPDATE integrity_runs SET
              finished_at_utc = ?,
              status = ?,
              runtime_seconds = ?,
              files_head_checked = ?,
              files_downloaded = ?,
              files_changed = ?,
              files_unchanged_after_download = ?,
              files_missing = ?,
              downloaded_bytes = ?,
              downloaded_mb = ?,
              backfills_triggered = ?,
              backfills_ok = ?,
              backfills_failed = ?,
              cross_checks_total = ?,
              cross_checks_ok = ?,
              cross_checks_mismatch = ?,
              cross_checks_source_only = ?,
              cross_checks_r2_only = ?,
              cross_checks_r2_manifest_missing = ?,
              observation_backfills_attempted = ?,
              observation_backfills_ok = ?,
              observation_backfills_failed = ?,
              aqi_rebuilds_queued_from_obs_repair = ?,
              aqi_health_connector_days_checked = ?,
              aqi_health_rebuilds_queued = ?,
              aqi_health_skipped_already_obs_repaired = ?,
              aqi_health_manifest_missing = ?,
              aqi_health_manifest_stale = ?,
              aqi_health_manifest_empty = ?,
              aqi_health_previous_rebuild_failed = ?,
              aqi_rebuilds_queued_total = ?,
              aqi_rebuilds_attempted = ?,
              aqi_rebuilds_complete = ?,
              aqi_rebuilds_failed = ?,
              aqi_rebuilds_skipped = ?,
              warnings_count = warnings_count + ?,
              errors_count = errors_count + ?,
              notes = ?
            WHERE id = ?
            """,
            (
                finished_iso, status, runtime_seconds,
                metrics["files_head_checked"],
                metrics["files_downloaded"],
                metrics["files_changed"],
                metrics["files_unchanged_after_download"],
                metrics["files_missing"],
                metrics["downloaded_bytes"],
                metrics["downloaded_mb"],
                metrics["backfills_triggered"],
                metrics["backfills_ok"],
                metrics["backfills_failed"],
                metrics["cross_checks_total"],
                metrics["cross_checks_ok"],
                metrics["cross_checks_mismatch"],
                metrics["cross_checks_source_only"],
                metrics["cross_checks_r2_only"],
                metrics["cross_checks_r2_manifest_missing"],
                metrics["observation_backfills_attempted"],
                metrics["observation_backfills_ok"],
                metrics["observation_backfills_failed"],
                metrics["aqi_rebuilds_queued_from_obs_repair"],
                metrics["aqi_health_connector_days_checked"],
                metrics["aqi_health_rebuilds_queued"],
                metrics["aqi_health_skipped_already_obs_repaired"],
                metrics["aqi_health_manifest_missing"],
                metrics["aqi_health_manifest_stale"],
                metrics["aqi_health_manifest_empty"],
                metrics["aqi_health_previous_rebuild_failed"],
                metrics["aqi_rebuilds_queued_total"],
                metrics["aqi_rebuilds_attempted"],
                metrics["aqi_rebuilds_complete"],
                metrics["aqi_rebuilds_failed"],
                metrics["aqi_rebuilds_skipped"],
                warnings_count_total,
                errors_count,
                notes,
                run_id,
            ),
        )
        conn.commit()

        summary: dict[str, Any] = {
            "env": args.env,
            "profile": args.profile,
            "source": args.source,
            "from_day": from_day,
            "to_day": to_day,
            "dry_run": args.dry_run,
            "check_only": args.check_only,
            "run_backfill": args.run_backfill,
            "force_snapshot_import": args.force_snapshot_import,
            "skip_snapshot_import": args.skip_snapshot_import,
            "skip_cross_check": args.skip_cross_check,
            "max_download_mb": args.max_download_mb,
            "max_runtime_minutes": args.max_runtime_minutes,
            "started_at_utc": started_iso,
            "finished_at_utc": finished_iso,
            "status": status,
            "run_id": run_id,
            "db_path": env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"],
            "log_path": str(log_path),
            "snapshot": snapshot_result,
            "lookup_source_counts": lookup_source_counts,
            "openaq": openaq_metrics,
            "sensor_community": sc_metrics,
            "uk_air_sos": sos_metrics,
            "cross_check": cross_check_metrics,
            "metrics": metrics,
            "notes": notes,
        }
        # Dropbox DB copy on any non-error exit. Failures here are warnings,
        # not run failures — the local DB is the source of truth.
        db_copy = _copy_db_to_dropbox(env, conn, log)
        summary["dropbox_db_copy"] = db_copy
        if run_id is not None:
            try:
                conn.execute(
                    "UPDATE integrity_runs SET notes = COALESCE(notes, '') || ? WHERE id = ?",
                    (f" dropbox_db_copy={db_copy['status']}.", run_id),
                )
                conn.commit()
            except sqlite3.Error:
                pass

        json_path, md_path = write_reports(
            env["UK_AQ_HISTORY_INTEGRITY_REPORT_DIR"], run_compact, summary
        )
        log.info("report_json=%s", json_path)
        log.info("report_md=%s", md_path)
        log.info("done status=%s runtime_seconds=%s", status, runtime_seconds)
        if daily_task_health_enabled:
            finish_summary = {
                "env": args.env,
                "profile": args.profile,
                "source": args.source,
                "from_day": from_day,
                "to_day": to_day,
                "check_only": bool(args.check_only),
                "dry_run": bool(args.dry_run),
                "run_backfill": bool(args.run_backfill),
                "skip_cross_check": bool(args.skip_cross_check),
                "integrity_run_id": run_id,
                "status": status,
                "files_head_checked": metrics.get("files_head_checked", 0),
                "files_downloaded": metrics.get("files_downloaded", 0),
                "files_changed": metrics.get("files_changed", 0),
                "files_first_seen": int(openaq_metrics.get("first_seen", 0)) + int(sc_metrics.get("first_seen", 0)) + int(sos_metrics.get("first_seen", 0)),
                "cross_checks_total": metrics.get("cross_checks_total", 0),
                "cross_checks_ok": metrics.get("cross_checks_ok", 0),
                "cross_checks_mismatch": metrics.get("cross_checks_mismatch", 0),
                "cross_checks_source_only": metrics.get("cross_checks_source_only", 0),
                "cross_checks_r2_manifest_missing": metrics.get("cross_checks_r2_manifest_missing", 0),
                "cross_checks_r2_timeseries_counts_missing": metrics.get("cross_checks_r2_timeseries_counts_missing", 0),
                "backfills_triggered": metrics.get("backfills_triggered", 0),
                "backfills_ok": metrics.get("backfills_ok", 0),
                "backfills_failed": metrics.get("backfills_failed", 0),
                "aqi_rebuilds_queued": metrics.get("aqi_rebuilds_queued_total", 0),
                "aqi_rebuilds_ok": metrics.get("aqi_rebuilds_complete", 0),
                "aqi_rebuilds_failed": metrics.get("aqi_rebuilds_failed", 0),
                "runtime_seconds": runtime_seconds,
                "report_json_path": str(json_path),
                "report_md_path": str(md_path),
                "log_path": str(log_path),
            }
            try:
                _daily_task_health_finish(
                    daily_task_health_config,
                    run_id=daily_task_health_run_id,
                    scheduled_for_date=daily_task_scheduled_for_date,
                    finished_at_utc=finished_iso,
                    summary=finish_summary,
                    platform_run_id=daily_task_platform_run_id,
                    log_url=str(log_path),
                )
            except Exception as exc:
                log.warning("daily task health finish failed: %s", exc)
                if daily_task_health_strict:
                    raise
        return 0
    except Exception as exc:
        log.exception("run failed: %s", exc)
        if run_id is not None:
            try:
                conn.execute(
                    """
                    UPDATE integrity_runs SET
                      finished_at_utc = ?,
                      status = ?,
                      errors_count = errors_count + 1,
                      notes = COALESCE(notes, '') || ?
                    WHERE id = ?
                    """,
                    (fmt_iso(utc_now()), "error", f"\nerror: {exc}", run_id),
                )
                conn.commit()
            except Exception:
                pass
        if daily_task_health_enabled:
            failed_iso = fmt_iso(utc_now())
            fail_summary = {
                "env": args.env,
                "profile": args.profile,
                "source": args.source,
                "from_day": from_day if "from_day" in locals() else args.from_day,
                "to_day": to_day if "to_day" in locals() else args.to_day,
                "check_only": bool(args.check_only),
                "dry_run": bool(args.dry_run),
                "run_backfill": bool(args.run_backfill),
                "skip_cross_check": bool(args.skip_cross_check),
                "integrity_run_id": run_id,
                "status": "error",
                "runtime_seconds": round(time.monotonic() - started_mono, 3),
                "log_path": str(log_path),
            }
            try:
                _daily_task_health_fail(
                    daily_task_health_config,
                    run_id=daily_task_health_run_id,
                    scheduled_for_date=daily_task_scheduled_for_date,
                    failed_at_utc=failed_iso,
                    summary=fail_summary,
                    error_message=str(exc),
                    error_payload=_daily_task_health_error_payload(exc),
                    platform_run_id=daily_task_platform_run_id,
                    log_url=str(log_path),
                )
            except Exception as health_exc:
                log.warning("daily task health fail-report failed: %s", health_exc)
                if daily_task_health_strict:
                    raise
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
