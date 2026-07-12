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

import argparse
import concurrent.futures
import datetime as dt
from dataclasses import dataclass
import gzip
import hashlib
import http.client
import importlib.util
import json
import logging
import math
import os
import re
import shutil
import shlex
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
from typing import Any, Callable, Iterable, Literal


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
    "UK_AQ_DROPBOX_ROOT",
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

DROPBOX_APP_ROOT = Path(
    "/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks",
)
DEFAULT_R2_HISTORY_DROPBOX_DIR = "R2_history_backup"

DAILY_TASK_HEALTH_TASK_KEY = "ops.history_integrity"
DAILY_TASK_HEALTH_SOURCE_REPO = "uk-aq-ops"
DAILY_TASK_HEALTH_SOURCE_WORKER = "uk-aq-history-integrity"
DAILY_TASK_HEALTH_RPC_SCHEMA = "uk_aq_public"
DAILY_TASK_HEALTH_ERROR_LIMIT = 1200
DEFAULT_BACKUP_TASK_KEYS = ("ops.r2_history_dropbox_backup",)
BACKUP_GATE_URL_ENV_NAMES = (
    "DAILY_TASK_HEALTH_SUPABASE_URL",
    "OBS_AQIDB_SUPABASE_URL",
    "SUPABASE_URL",
    "UK_AQ_SUPABASE_URL",
)
BACKUP_GATE_KEY_ENV_NAMES = (
    "DAILY_TASK_HEALTH_SUPABASE_SERVICE_ROLE_KEY",
    "OBS_AQIDB_SECRET_KEY",
    "OBS_AQIDB_SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "UK_AQ_SUPABASE_SERVICE_ROLE_KEY",
)


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
    "sos": "sos",
}

# `--source all` includes all currently implemented source adapters.
CROSS_CHECK_SOURCE_KEYS_BY_FILTER: dict[str, tuple[str, ...]] = {
    "openaq": ("openaq",),
    "sensorcommunity": ("sensorcommunity",),
    "sos": ("sos",),
    "all": ("openaq", "sensorcommunity", "sos"),
}
CROSS_CHECK_BACKFILL_CONNECTOR_CODES_BY_FILTER: dict[str, tuple[str, ...]] = {
    "openaq": ("openaq",),
    "sensorcommunity": ("sensorcommunity",),
    # Phase 7.4: include sos in observation-repair candidates.
    "sos": ("sos",),
    "all": ("openaq", "sensorcommunity", "sos"),
}

# Subset of core tables that the integrity DB needs. Other tables in the
# manifest (categories, observed_properties, offerings, features, procedures,
# networks, sos_*, station_metadata)
# are accepted in the manifest but not imported in this phase.
CORE_TABLES_TO_IMPORT = (
    "connectors", "stations", "timeseries", "phenomena",
    "observed_property_mappings",
)

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

CREATE TABLE IF NOT EXISTS core_observed_property_mappings_snapshot (
  id INTEGER PRIMARY KEY,
  connector_id INTEGER NOT NULL,
  source_label TEXT NOT NULL,
  notation TEXT,
  pollutant_label TEXT,
  source_uom TEXT,
  observed_property_id INTEGER,
  observed_property_code TEXT,
  mapping_kind TEXT NOT NULL,
  is_aqi_eligible INTEGER NOT NULL,
  is_active INTEGER NOT NULL,
  confidence TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_core_observed_property_mappings_connector_label
  ON core_observed_property_mappings_snapshot(connector_id, source_label);
CREATE INDEX IF NOT EXISTS idx_core_observed_property_mappings_connector_active
  ON core_observed_property_mappings_snapshot(connector_id, is_active);
CREATE INDEX IF NOT EXISTS idx_core_observed_property_mappings_code
  ON core_observed_property_mappings_snapshot(observed_property_code);
CREATE INDEX IF NOT EXISTS idx_core_observed_property_mappings_kind
  ON core_observed_property_mappings_snapshot(mapping_kind);

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

-- Phase 6.5 Pass A: per-(source_file, day_utc, timeseries) row counts
-- derived from the upstream archive file at ingest time. Recorded only
-- when we download (first_seen / changed / reappeared); unchanged metadata
-- reuses the previously stored values since the source bytes haven't
-- changed.
CREATE TABLE IF NOT EXISTS source_file_timeseries_counts (
  source_file_key TEXT NOT NULL,
  day_utc         TEXT NOT NULL,
  timeseries_id   INTEGER NOT NULL,
  row_count       INTEGER NOT NULL,
  counted_at_utc  TEXT NOT NULL,
  PRIMARY KEY (source_file_key, day_utc, timeseries_id)
);

CREATE INDEX IF NOT EXISTS idx_sftc_timeseries
  ON source_file_timeseries_counts(timeseries_id);
CREATE INDEX IF NOT EXISTS idx_sftc_day_timeseries
  ON source_file_timeseries_counts(day_utc, timeseries_id);

-- Phase 6.5 Pass B: per-run source-vs-R2 comparison outcomes at
-- (connector_id, day_utc, timeseries_id) granularity.
CREATE TABLE IF NOT EXISTS cross_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  env_name TEXT NOT NULL,
  history_version TEXT,
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
  history_version TEXT,
  domain TEXT,
  profile TEXT,
  pollutant_code TEXT,
  source_observations_version TEXT,
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
    stations = conn.execute("SELECT COUNT(*) FROM core_stations_snapshot").fetchone()
    mappings = conn.execute(
        "SELECT COUNT(*) FROM core_observed_property_mappings_snapshot"
    ).fetchone()
    return bool(stations and stations[0] > 0 and mappings and mappings[0] > 0)


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


def _observed_property_mappings_insert_spec() -> tuple[str, Any]:
    sql = (
        "INSERT INTO core_observed_property_mappings_snapshot "
        "(id, connector_id, source_label, notation, pollutant_label, source_uom, "
        " observed_property_id, observed_property_code, mapping_kind, "
        " is_aqi_eligible, is_active, confidence, notes, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    def to_tuple(r: dict[str, Any]) -> tuple:
        return (
            _row_get_int(r, "id"), _row_get_int(r, "connector_id"),
            _row_get_str(r, "source_label"), _row_get_str(r, "notation"),
            _row_get_str(r, "pollutant_label"), _row_get_str(r, "source_uom"),
            _row_get_int(r, "observed_property_id"),
            _row_get_str(r, "observed_property_code"),
            _row_get_str(r, "mapping_kind"),
            1 if r.get("is_aqi_eligible") is True else 0,
            1 if r.get("is_active") is True else 0,
            _row_get_str(r, "confidence"), _row_get_str(r, "notes"),
            _row_get_str(r, "created_at"), _row_get_str(r, "updated_at"),
        )
    return sql, to_tuple


_INSERT_SPECS = {
    "connectors": _connectors_insert_spec,
    "stations":   _stations_insert_spec,
    "timeseries": _timeseries_insert_spec,
    "phenomena":  _phenomena_insert_spec,
    "observed_property_mappings": _observed_property_mappings_insert_spec,
}

_TARGET_TABLES = {
    "connectors": "core_connectors_snapshot",
    "stations":   "core_stations_snapshot",
    "timeseries": "core_timeseries_snapshot",
    "phenomena":  "core_phenomena_snapshot",
    "observed_property_mappings": "core_observed_property_mappings_snapshot",
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




def resolve_core_history_version_for_mode(history_version_mode: str) -> str:
    mode = str(history_version_mode or "v1").strip().lower()
    if mode in {"v1", "v2"}:
        return mode
    # A combined run preserves the existing v1 core snapshot behaviour; v2-only
    # runs use v2 and never fall back to v1.
    if mode == "both":
        return "v1"
    raise ValueError(f"unsupported history version mode: {history_version_mode!r}")

def resolve_core_snapshot_prefix(history_version: str, env: Mapping[str, str] | None = None) -> str:
    values = os.environ if env is None else env
    version = str(history_version or "v1").strip().lower()
    if version == "v2":
        return _normalize_history_prefix(
            values.get("UK_AQ_R2_HISTORY_V2_CORE_PREFIX"),
            "history/v2/core",
        )
    if version == "v1":
        return _normalize_history_prefix(
            values.get("UK_AQ_R2_HISTORY_CORE_PREFIX"),
            "history/v1/core",
        )
    raise ValueError(f"unsupported history version: {history_version!r}")


def _clean_dropbox_segment(value: str) -> str:
    return str(value or "").strip().strip("/").strip()


def resolve_r2_history_root(
    env: Mapping[str, str] | None = None,
    *,
    local_app_root: Path | str | None = None,
) -> str:
    values = os.environ if env is None else env
    explicit_root = str(values.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT", "") or "").strip()
    if explicit_root:
        return str(Path(explicit_root).expanduser())

    dropbox_root_raw = str(values.get("UK_AQ_DROPBOX_ROOT", "") or "").strip()
    if not dropbox_root_raw:
        return ""
    history_dir_raw = str(
        values.get("UK_AQ_R2_HISTORY_DROPBOX_DIR", DEFAULT_R2_HISTORY_DROPBOX_DIR)
        or DEFAULT_R2_HISTORY_DROPBOX_DIR
    ).strip()
    if not history_dir_raw:
        return ""

    history_dir = Path(history_dir_raw).expanduser()
    if history_dir.is_absolute():
        return str(history_dir)

    dropbox_root = Path(dropbox_root_raw).expanduser()
    if dropbox_root.is_absolute():
        return str(dropbox_root / _clean_dropbox_segment(history_dir_raw))

    base = Path(local_app_root) if local_app_root is not None else DROPBOX_APP_ROOT
    return str(
        base.expanduser()
        / _clean_dropbox_segment(dropbox_root_raw)
        / _clean_dropbox_segment(history_dir_raw)
    )


def resolve_core_snapshot_root(
    history_version: str,
    env: Mapping[str, str] | None = None,
) -> str:
    values = os.environ if env is None else env
    version = str(history_version or "v1").strip().lower()
    core_prefix = resolve_core_snapshot_prefix(version, values)
    backup_root = resolve_r2_history_root(values)
    if backup_root:
        return str(Path(backup_root) / core_prefix)

    explicit_root = str(values.get("UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT", "") or "").strip()
    if not explicit_root:
        return explicit_root
    # Preserve legacy v1 behaviour, but prevent v2-only runs from reusing a
    # configured v1 Dropbox core root silently.
    if version == "v2":
        normalized = explicit_root.replace("\\", "/")
        if normalized.endswith("/history/v1/core") or normalized == "history/v1/core":
            return explicit_root[: -len("history/v1/core")] + core_prefix
    return explicit_root


def classify_core_snapshot_status(
    snapshot_result: Mapping[str, Any],
    *,
    history_version: str,
    expected_day: str | None,
) -> str:
    version = str(history_version or "v1").strip().lower()
    status = str(snapshot_result.get("status") or "")
    if version == "v2" and status in {"missing_root", "no_snapshot"}:
        return "v2_core_snapshot_missing"
    day = str(snapshot_result.get("snapshot_day_utc") or "").strip()
    if version == "v2" and status in {"imported", "reused", "dry_run"} and expected_day and day and day < expected_day:
        return "v2_core_snapshot_stale"
    if status in {"imported", "reused", "dry_run"}:
        return "ok"
    if status in {"missing_root", "no_snapshot"}:
        return "missing"
    if status == "skipped":
        return "warning"
    return status or "warning"


def collect_lookup_active_counts_by_source(
    conn: sqlite3.Connection,
    source_keys: Iterable[str] = ("openaq", "sensorcommunity", "sos"),
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

SOS_SOURCE_KEY = "sos"
SOS_DEFAULT_BASE_URL = "https://uk-air.defra.gov.uk/sos-ukair/api/v1"
SOS_DEFAULT_TIMEOUT_SECONDS = 30
UK_AQ_HISTORY_INTEGRITY_UK_AIR_FLAT_FILE_BASE_URL_ENV = (
    "UK_AQ_HISTORY_INTEGRITY_UK_AIR_FLAT_FILE_BASE_URL"
)
UK_AQ_HISTORY_INTEGRITY_UK_AIR_FLAT_FILE_BASE_URL_DEFAULT = (
    "https://uk-air.defra.gov.uk/datastore/data_files/site_data"
)
UK_AQ_HISTORY_INTEGRITY_SOS_TARGET_POLLUTANTS_ENV = (
    "UK_AQ_HISTORY_INTEGRITY_SOS_TARGET_POLLUTANTS"
)
UK_AQ_HISTORY_INTEGRITY_SOS_TARGET_POLLUTANTS_DEFAULT = "pm25,pm10,no2"
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_ENV = "UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS"
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_ALLOWED = {"none", "changed", "all"}
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_DEFAULT = "changed"
UK_AQ_HISTORY_INTEGRITY_SOS_NOT_FOUND_COOLDOWN_MINUTES_ENV = (
    "UK_AQ_HISTORY_INTEGRITY_SOS_NOT_FOUND_COOLDOWN_MINUTES"
)
UK_AQ_HISTORY_INTEGRITY_SOS_NOT_FOUND_COOLDOWN_MINUTES_DEFAULT = 0

SOS_STATUS_OK = "ok"
SOS_STATUS_NO_DATA = "no_data"
SOS_STATUS_NOT_FOUND = "not_found"
SOS_STATUS_TEMP_ERROR = "temporary_error"
SOS_STATUS_PERM_ERROR = "permanent_error"

SosFetcher = Callable[
    [str, str, str, str, int],
    dict[str, Any],
]


def _iso_utc_seconds(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).strftime(
        "%Y-%m-%dT%H:%M:%SZ",
    )


def _sos_day_bounds(day_utc: str) -> tuple[str, str]:
    day = dt.date.fromisoformat(day_utc)
    start = dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc)
    end = start + dt.timedelta(days=1)
    return _iso_utc_seconds(start), _iso_utc_seconds(end)


def _sos_parse_timestamp(value: Any) -> str | None:
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


def _sos_to_finite_number(value: Any) -> int | float | None:
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


def _sos_extract_datapoints(payload: Any) -> list[dict[str, Any]]:
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
            observed_at = _sos_parse_timestamp(row[0])
            number_value = _sos_to_finite_number(row[1])
        elif isinstance(row, dict):
            observed_at = _sos_parse_timestamp(
                row.get("time")
                or row.get("timestamp")
                or row.get("t")
                or row.get("dateTime")
                or row.get("phenomenonTime")
                or row.get("observed_at"),
            )
            number_value = _sos_to_finite_number(
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


def _sos_fetch_timeseries_payload(
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
                    "status": SOS_STATUS_OK,
                    "payload": payload,
                    "error": None,
                    "http_status": int(resp.status),
                }
        except urllib.error.HTTPError as exc:
            if int(exc.code) == 404:
                return {
                    "status": SOS_STATUS_NOT_FOUND,
                    "payload": None,
                    "error": f"HTTP 404 for timeseries_ref={timeseries_ref}",
                    "http_status": int(exc.code),
                }
            if _is_retryable_url_error(exc):
                if attempt < HTTP_RETRY_ATTEMPTS:
                    _sleep_http_retry("GET", url, attempt, exc)
                    continue
                return {
                    "status": SOS_STATUS_TEMP_ERROR,
                    "payload": None,
                    "error": f"HTTP {exc.code} for timeseries_ref={timeseries_ref}",
                    "http_status": int(exc.code),
                }
            return {
                "status": SOS_STATUS_PERM_ERROR,
                "payload": None,
                "error": f"HTTP {exc.code} for timeseries_ref={timeseries_ref}",
                "http_status": int(exc.code),
            }
        except json.JSONDecodeError as exc:
            return {
                "status": SOS_STATUS_PERM_ERROR,
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
                    "status": SOS_STATUS_TEMP_ERROR,
                    "payload": None,
                    "error": f"temporary fetch failure for timeseries_ref={timeseries_ref}: {exc}",
                    "http_status": None,
                }
            return {
                "status": SOS_STATUS_PERM_ERROR,
                "payload": None,
                "error": f"non-retryable fetch failure for timeseries_ref={timeseries_ref}: {exc}",
                "http_status": None,
            }

    return {
        "status": SOS_STATUS_TEMP_ERROR,
        "payload": None,
        "error": f"timeseries_ref={timeseries_ref}: exhausted retries",
        "http_status": None,
    }


def build_sos_canonical_snapshot(
    *,
    station_ref: str,
    day_utc: str,
    timeseries_bindings: Iterable[dict[str, Any]],
    base_url: str | None = None,
    timeout_seconds: int = SOS_DEFAULT_TIMEOUT_SECONDS,
    fetcher: SosFetcher | None = None,
) -> dict[str, Any]:
    """Build canonical SOS snapshot rows for one station/day.

    Output rows are sorted by (timeseries_id, observed_at_utc) and encoded as
    stable NDJSON bytes with the minimal canonical row shape.
    """
    source_base_url = (
        (base_url or os.environ.get("UK_AQ_BACKFILL_SOS_BASE_URL") or "")
        .strip()
        or SOS_DEFAULT_BASE_URL
    )
    fetch_fn = fetcher or _sos_fetch_timeseries_payload
    day_start_iso, day_end_iso = _sos_day_bounds(day_utc)
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
        status = str(fetched.get("status") or SOS_STATUS_PERM_ERROR)
        result_row: dict[str, Any] = {
            "timeseries_id": ts_id,
            "timeseries_ref": ts_ref,
            "status": status,
            "row_count": 0,
            "error": fetched.get("error"),
        }
        if status != SOS_STATUS_OK:
            timeseries_results.append(result_row)
            continue

        datapoints = _sos_extract_datapoints(fetched.get("payload"))
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
            result_row["status"] = SOS_STATUS_NO_DATA
        timeseries_results.append(result_row)

    status_list = [str(item.get("status") or "") for item in timeseries_results]
    if any(status == SOS_STATUS_TEMP_ERROR for status in status_list):
        final_status = SOS_STATUS_TEMP_ERROR
    elif any(status == SOS_STATUS_PERM_ERROR for status in status_list):
        final_status = SOS_STATUS_PERM_ERROR
    elif status_list and all(status == SOS_STATUS_NOT_FOUND for status in status_list):
        final_status = SOS_STATUS_NOT_FOUND
    elif rows:
        final_status = SOS_STATUS_OK
    else:
        final_status = SOS_STATUS_NO_DATA

    if final_status in (SOS_STATUS_TEMP_ERROR, SOS_STATUS_PERM_ERROR):
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


def _resolve_sos_not_found_cooldown_seconds() -> int:
    raw = str(
        os.environ.get(
            UK_AQ_HISTORY_INTEGRITY_SOS_NOT_FOUND_COOLDOWN_MINUTES_ENV,
            UK_AQ_HISTORY_INTEGRITY_SOS_NOT_FOUND_COOLDOWN_MINUTES_DEFAULT,
        ),
    ).strip()
    try:
        minutes = int(raw)
    except (TypeError, ValueError):
        minutes = UK_AQ_HISTORY_INTEGRITY_SOS_NOT_FOUND_COOLDOWN_MINUTES_DEFAULT
    if minutes <= 0:
        return 0
    return minutes * 60


def _resolve_uk_air_flat_file_base_url(env: Mapping[str, str] | None = None) -> str:
    values = os.environ if env is None else env
    raw = str(
        values.get(UK_AQ_HISTORY_INTEGRITY_UK_AIR_FLAT_FILE_BASE_URL_ENV, "")
    ).strip()
    return raw.rstrip("/") or UK_AQ_HISTORY_INTEGRITY_UK_AIR_FLAT_FILE_BASE_URL_DEFAULT


def _resolve_sos_target_pollutants(env: Mapping[str, str] | None = None) -> tuple[str, ...]:
    values = os.environ if env is None else env
    raw = str(
        values.get(UK_AQ_HISTORY_INTEGRITY_SOS_TARGET_POLLUTANTS_ENV, "")
    ).strip()
    tokens = raw.split(",") if raw else UK_AQ_HISTORY_INTEGRITY_SOS_TARGET_POLLUTANTS_DEFAULT.split(",")
    seen: set[str] = set()
    out: list[str] = []
    for token in tokens:
        cleaned = str(token).strip().lower()
        if not cleaned:
            continue
        if cleaned not in {"pm25", "pm10", "no2"}:
            continue
        if cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    if not out:
        return ("pm25", "pm10", "no2")
    return tuple(out)


def _resolve_supabase_rest_config(
    env: Mapping[str, str] | None = None,
    *,
    url_env_names: tuple[str, ...],
    key_env_names: tuple[str, ...],
) -> dict[str, str]:
    values = os.environ if env is None else env
    loaded: dict[str, str] = {}
    env_file = str(values.get("UK_AQ_BACKFILL_ENV_FILE", "")).strip()
    if env_file:
        env_path = Path(env_file).expanduser()
        if env_path.is_file():
            try:
                loaded = _load_env_file(env_path)
            except OSError:
                loaded = {}

    def _first_present(keys: tuple[str, ...]) -> str:
        for key in keys:
            candidate = str(
                loaded.get(key)
                or values.get(key)
                or os.environ.get(key)
                or "",
            ).strip()
            if candidate:
                return candidate
        return ""

    supabase_url = _first_present(url_env_names).rstrip("/")
    supabase_key = _first_present(key_env_names)
    return {
        "supabase_url": supabase_url,
        "supabase_key": supabase_key,
        "env_file": env_file,
    }


def _resolve_obs_aqidb_supabase_rest_config(
    env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    return _resolve_supabase_rest_config(
        env,
        url_env_names=("OBS_AQIDB_SUPABASE_URL",),
        key_env_names=("OBS_AQIDB_SECRET_KEY",),
    )


def _resolve_ingestdb_supabase_rest_config(
    env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    return _resolve_supabase_rest_config(
        env,
        url_env_names=("SUPABASE_URL",),
        key_env_names=("SB_SECRET_KEY",),
    )


def _supabase_rest_headers(service_key: str, schema: str) -> dict[str, str]:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Accept-Profile": schema,
        "Content-Profile": schema,
    }


def _http_get_json(
    *,
    url: str,
    headers: dict[str, str],
    timeout_seconds: int = 30,
) -> Any:
    req = urllib.request.Request(url, method="GET")
    for key, value in headers.items():
        req.add_header(key, value)
    for attempt in range(1, HTTP_RETRY_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                body = resp.read()
                if not body:
                    return None
                return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if _is_retryable_url_error(exc) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("GET", url, attempt, exc)
                continue
            raise
        except Exception as exc:
            if _is_retryable_url_error(exc) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("GET", url, attempt, exc)
                continue
            raise
    raise RuntimeError(f"GET {url} failed after retries")


def _http_post_json(
    *,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any] | list[dict[str, Any]],
    timeout_seconds: int = 30,
) -> Any:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for key, value in headers.items():
        req.add_header(key, value)
    for attempt in range(1, HTTP_RETRY_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                payload = resp.read()
                if not payload:
                    return None
                return json.loads(payload.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if _is_retryable_url_error(exc) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("POST", url, attempt, exc)
                continue
            raise
        except Exception as exc:
            if _is_retryable_url_error(exc) and attempt < HTTP_RETRY_ATTEMPTS:
                _sleep_http_retry("POST", url, attempt, exc)
                continue
            raise
    raise RuntimeError(f"POST {url} failed after retries")


def _uk_air_flat_file_source_file_key(site_ref: str, year: int) -> str:
    return f"sos:site_ref={str(site_ref).strip().upper()}:year={int(year)}"


def _uk_air_flat_file_remote_url(base_url: str, site_ref: str, year: int) -> str:
    return f"{base_url.rstrip('/')}/{str(site_ref).strip().upper()}_{int(year)}.csv?v=1"


def _uk_air_flat_file_cache_path(cache_root: Path, site_ref: str, year: int) -> Path:
    site_token = str(site_ref).strip().upper()
    return cache_root / f"site_ref={site_token}" / f"year={int(year)}" / f"{site_token}_{int(year)}.csv"


def _uk_air_flat_file_remote_metadata_matches(
    prior: Mapping[str, Any],
    head: Mapping[str, Any],
) -> bool:
    remote_etag = str(head.get("etag") or "").strip()
    if remote_etag:
        return remote_etag == str(prior.get("etag") or "").strip()

    remote_last_modified = str(head.get("last_modified") or "").strip()
    prior_last_modified = str(prior.get("last_modified_utc") or "").strip()
    remote_content_length = head.get("content_length")
    prior_content_length = prior.get("content_length")
    if (
        not remote_last_modified
        or remote_last_modified != prior_last_modified
        or remote_content_length is None
        or prior_content_length is None
    ):
        return False
    try:
        return int(remote_content_length) == int(prior_content_length)
    except (TypeError, ValueError):
        return False


def _uk_air_flat_file_year_day(year: int) -> dt.date:
    return dt.date(int(year), 1, 1)


def _uk_air_parse_day(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d-%m-%y", "%d/%m/%y"):
        try:
            return dt.datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _uk_air_normalize_pollutant_code(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    text = (
        text.replace("µ", "u")
        .replace("μ", "u")
        .replace("&nbsp;", " ")
    )
    text = re.sub(r"<[^>]+>", "", text)
    compact = re.sub(r"[^a-z0-9.]+", "", text)
    if not compact:
        return None
    if "pm25" in compact or "pm2.5" in compact or "pm2p5" in compact or "particulatematter25" in compact:
        return "pm25"
    if "pm10" in compact or "particulatematter10" in compact:
        return "pm10"
    if "no2" in compact or "nitrogendioxide" in compact:
        return "no2"
    return None


def _uk_air_flat_file_query_sql(value: str) -> str:
    return urllib.parse.quote(str(value), safe=".-_~")


def _format_supabase_rpc_error(
    *,
    database_target: str,
    rpc_name: str,
    schema_profile: str,
    exc: urllib.error.HTTPError,
) -> RuntimeError:
    response_body = ""
    try:
        raw_body = exc.read()
        if raw_body:
            response_body = raw_body.decode("utf-8", errors="replace").strip()
    except Exception:
        response_body = ""
    parts = [
        f"flat-file mapping RPC failed",
        f"database target={database_target}",
        f"rpc={rpc_name}",
        f"schema/profile={schema_profile}",
        f"http_status={exc.code}",
    ]
    if response_body:
        parts.append(f"response_body={_truncate_text(response_body, 1000)}")
    return RuntimeError("; ".join(parts))


def _fetch_uk_air_flat_file_mapping_rows(
    *,
    env: Mapping[str, str] | None = None,
    from_day: str | None = None,
    to_day: str | None = None,
    target_pollutants: Iterable[str] | None = None,
) -> list[dict[str, Any]]:
    config = _resolve_ingestdb_supabase_rest_config(env)
    if not config["supabase_url"] or not config["supabase_key"]:
        raise RuntimeError(
            "SUPABASE_URL / SB_SECRET_KEY are required for UK-AIR flat-file mode"
        )

    pollutants = tuple(target_pollutants or _resolve_sos_target_pollutants(env))
    if not from_day or not to_day:
        raise RuntimeError("from_day/to_day are required for UK-AIR flat-file mapping lookup")

    url = f"{config['supabase_url']}/rest/v1/rpc/uk_aq_rpc_sos_uk_air_flat_file_mappings"
    try:
        payload = _http_post_json(
            url=url,
            headers=_supabase_rest_headers(config["supabase_key"], "uk_aq_public"),
            body={
                "p_from_day": from_day,
                "p_to_day": to_day,
                "p_pollutant_codes": list(pollutants),
            },
        )
    except urllib.error.HTTPError as exc:
        raise _format_supabase_rpc_error(
            database_target="ingestdb",
            rpc_name="uk_aq_rpc_sos_uk_air_flat_file_mappings",
            schema_profile="uk_aq_public",
            exc=exc,
        ) from exc
    if payload is None:
        return []
    if not isinstance(payload, list):
        raise RuntimeError("UK-AIR flat-file mapping query did not return a JSON array")
    rows: list[dict[str, Any]] = []
    for row in payload:
        if isinstance(row, dict):
            rows.append(row)
    rows.sort(key=lambda row: (
        str(row.get("site_ref") or "").upper(),
        str(row.get("pollutant_code") or "").lower(),
        str(row.get("valid_from_day_utc") or ""),
        str(row.get("valid_to_day_utc") or ""),
        int(row.get("timeseries_id") or 0),
    ))
    return rows


def _group_uk_air_flat_file_mapping_rows(
    rows: Iterable[Mapping[str, Any]],
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for row in rows:
        site_ref = str(row.get("site_ref") or "").strip().upper()
        pollutant_code = str(row.get("pollutant_code") or "").strip().lower()
        if not site_ref or pollutant_code not in {"pm25", "pm10", "no2"}:
            continue
        grouped.setdefault(site_ref, {}).setdefault(pollutant_code, []).append(dict(row))
    return grouped


def _resolve_uk_air_flat_file_mapping_row(
    rows: Iterable[Mapping[str, Any]],
    day_utc: str,
) -> tuple[dict[str, Any] | None, str | None]:
    day = dt.date.fromisoformat(day_utc)
    matched: list[dict[str, Any]] = []
    for row in rows:
        raw_from = str(row.get("valid_from_day_utc") or "").strip()
        raw_to = str(row.get("valid_to_day_utc") or "").strip()
        if raw_from:
            try:
                valid_from = dt.date.fromisoformat(raw_from)
            except ValueError:
                continue
            if day < valid_from:
                continue
        if raw_to:
            try:
                valid_to = dt.date.fromisoformat(raw_to)
            except ValueError:
                continue
            if day > valid_to:
                continue
        matched.append(dict(row))
    if len(matched) == 1:
        return matched[0], None
    if not matched:
        return None, "unmapped_source"
    return None, "ambiguous_mapping"


def _uk_air_flat_file_years_for_window(from_day: str, to_day: str) -> list[int]:
    start = dt.date.fromisoformat(from_day)
    end = dt.date.fromisoformat(to_day)
    return list(range(start.year, end.year + 1))


def _uk_air_flat_file_parse_day_pollutant_counts(
    csv_path: Path,
    *,
    target_pollutants: Iterable[str],
) -> tuple[dict[tuple[str, str], int], dict[str, Any]]:
    import csv

    allowed = {str(code).strip().lower() for code in target_pollutants if str(code or "").strip()}
    counts: dict[tuple[str, str], int] = {}
    stats: dict[str, Any] = {
        "sections": 0,
        "rows": 0,
        "days": set(),
        "pollutants": set(),
        "unsupported_sections": 0,
    }
    current_pollutant: str | None = None
    with csv_path.open("rt", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        for row in reader:
            if not row:
                continue
            cells = [str(cell).strip() for cell in row]
            if not any(cells):
                continue
            first = cells[0].lower() if len(cells) > 0 else ""
            second = cells[1].lower() if len(cells) > 1 else ""
            third = cells[2] if len(cells) > 2 else ""
            if first == "date" and second == "time":
                current_pollutant = _uk_air_normalize_pollutant_code(third)
                if current_pollutant in allowed:
                    stats["sections"] += 1
                else:
                    stats["unsupported_sections"] += 1
                    current_pollutant = None
                continue
            if current_pollutant is None or current_pollutant not in allowed:
                continue
            day_utc = _uk_air_parse_day(cells[0] if len(cells) > 0 else "")
            if not day_utc:
                continue
            value = None
            if len(cells) > 2:
                value = _sos_to_finite_number(cells[2])
            if value is None:
                continue
            key = (day_utc, current_pollutant)
            counts[key] = counts.get(key, 0) + 1
            stats["rows"] += 1
            stats["days"].add(day_utc)
            stats["pollutants"].add(current_pollutant)
    stats["days"] = sorted(stats["days"])
    stats["pollutants"] = sorted(stats["pollutants"])
    return counts, stats


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


def _sos_source_file_key(station_ref: str, day: dt.date) -> str:
    return f"sos:station_ref={station_ref}:day_utc={day.isoformat()}"


def _sos_cache_path(cache_root: Path, station_ref: str, day: dt.date) -> Path:
    station_token = urllib.parse.quote(station_ref, safe="._-")
    return (
        cache_root
        / f"station_ref={station_token}"
        / f"day_utc={day.isoformat()}"
        / "snapshot.ndjson"
    )


def _sos_remote_key(base_url: str, station_ref: str, day: dt.date) -> str:
    station_token = urllib.parse.quote(station_ref, safe="")
    return (
        f"{base_url.rstrip('/')}/station_ref={station_token}/day_utc={day.isoformat()}"
    )


def _sos_station_bindings(
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
        (SOS_SOURCE_KEY,),
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


def _source_file_day_from_key(source_file_key: str) -> str | None:
    raw = str(source_file_key or "").strip()
    if not raw:
        return None
    if "day_utc=" in raw:
        match = re.search(r"day_utc=(\d{4}-\d{2}-\d{2})", raw)
        if match:
            return match.group(1)
    if "year=" in raw:
        match = re.search(r"year=(\d{4})", raw)
        if match:
            return f"{match.group(1)}-01-01"
    parts = raw.split(":")
    if len(parts) >= 2:
        tail = parts[-1].strip()
        try:
            dt.date.fromisoformat(tail)
            return tail
        except ValueError:
            pass
    return None


def _record_source_file_timeseries_counts(
    conn: sqlite3.Connection,
    source_file_key: str,
    counts_by_key: Mapping[Any, int],
    now_iso: str,
    *,
    default_day_utc: str | None = None,
) -> None:
    """Replace the per-source-file rows in source_file_timeseries_counts.

    `counts_by_key` may use either `timeseries_id` integers (legacy daily
    source adapters) or `(day_utc, timeseries_id)` tuples (UK-AIR flat-file
    source adapters). The helper normalizes both shapes into the
    day-granular table layout.
    """
    conn.execute(
        "DELETE FROM source_file_timeseries_counts WHERE source_file_key = ?",
        (source_file_key,),
    )
    if not counts_by_key:
        return

    inferred_day = default_day_utc or _source_file_day_from_key(source_file_key)
    rows: list[tuple[str, str, int, int, str]] = []
    for raw_key, raw_count in sorted(counts_by_key.items(), key=lambda item: str(item[0])):
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count <= 0:
            continue

        day_utc: str | None = None
        timeseries_id: int | None = None
        if isinstance(raw_key, tuple) and len(raw_key) == 2:
            raw_day, raw_timeseries_id = raw_key
            day_utc = str(raw_day or "").strip()
            try:
                timeseries_id = int(raw_timeseries_id)
            except (TypeError, ValueError):
                timeseries_id = None
        else:
            try:
                timeseries_id = int(raw_key)
            except (TypeError, ValueError):
                timeseries_id = None
            day_utc = inferred_day

        if timeseries_id is None or timeseries_id <= 0:
            continue
        if not day_utc:
            continue
        rows.append((source_file_key, day_utc, timeseries_id, count, now_iso))

    if not rows:
        return
    conn.executemany(
        """
        INSERT INTO source_file_timeseries_counts
          (source_file_key, day_utc, timeseries_id, row_count, counted_at_utc)
        VALUES (?, ?, ?, ?, ?)
        """,
        rows,
    )


def _prepare_source_file_timeseries_counts_migration(
    conn: sqlite3.Connection,
) -> list[tuple[str, str, int, int, str]] | None:
    """Rename legacy counts tables before the schema DDL runs.

    Older SQLite files have `source_file_timeseries_counts` keyed only by
    `(source_file_key, timeseries_id)`. New runs need the day-granular table
    shape, so we snapshot the old rows, rename the legacy table out of the
    way, and drop the conflicting legacy index before the new schema is
    applied.
    """
    if not _table_exists(conn, "source_file_timeseries_counts"):
        return None

    columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(source_file_timeseries_counts)").fetchall()
    }
    if "day_utc" in columns:
        return None
    if "source_file_key" not in columns or "timeseries_id" not in columns or "row_count" not in columns:
        return None

    legacy_rows = conn.execute(
        """
        SELECT
          c.source_file_key,
          c.timeseries_id,
          c.row_count,
          c.counted_at_utc,
          s.day_utc
        FROM source_file_timeseries_counts c
        LEFT JOIN source_file_state s
          ON s.source_file_key = c.source_file_key
        ORDER BY c.source_file_key, c.timeseries_id
        """,
    ).fetchall()

    conn.execute(
        "ALTER TABLE source_file_timeseries_counts RENAME TO source_file_timeseries_counts_legacy",
    )
    conn.execute("DROP INDEX IF EXISTS idx_sftc_timeseries")

    migrated_rows: list[tuple[str, str, int, int, str]] = []
    for source_file_key, timeseries_id, row_count, counted_at_utc, day_utc in legacy_rows:
        resolved_day = str(day_utc or _source_file_day_from_key(str(source_file_key)) or "").strip()
        if not resolved_day:
            continue
        try:
            parsed_ts_id = int(timeseries_id)
            parsed_count = int(row_count)
        except (TypeError, ValueError):
            continue
        if parsed_ts_id <= 0 or parsed_count <= 0:
            continue
        migrated_rows.append(
            (
                str(source_file_key),
                resolved_day,
                parsed_ts_id,
                parsed_count,
                str(counted_at_utc or ""),
            ),
        )
    return migrated_rows


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


def _prior_local_cache_exists(prior: dict[str, Any] | None) -> bool:
    if not prior:
        return False
    local_cached_path = str(prior.get("local_cached_path") or "").strip()
    return bool(local_cached_path and Path(local_cached_path).is_file())


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
    force_download_when_cache_missing: bool = False,
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
            force_download_when_cache_missing=force_download_when_cache_missing,
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
    force_download_when_cache_missing: bool = False,
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
    needs_cache_refresh = (
        bool(force_download_when_cache_missing)
        and prior is not None
        and int(prior.get("exists_remote") or 0) == 1
        and not _prior_local_cache_exists(prior)
    )
    needs_download = (
        is_first_seen
        or was_missing
        or _metadata_changed(prior, head)
        or needs_cache_refresh
    )

    if not needs_download:
        # metadata identical; no download, no event
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=location_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=prior["sha256_downloaded"],
            sha256_uncompressed=prior["sha256_uncompressed"],
            local_cached_path=prior.get("local_cached_path"),
            now_iso=now_iso, last_changed_at=None,
            last_status="unchanged",
        )
        return {
            "outcome": "unchanged_metadata", "downloaded_bytes": 0,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    # Download + hash
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"openaq-{location_id}-{day.strftime('%Y%m%d')}.csv.gz"
    if tmp_path.exists():
        tmp_path.unlink()
    try:
        bytes_downloaded = _http_get_to_file(url, tmp_path)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=location_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=(prior or {}).get("sha256_downloaded"),
            sha256_uncompressed=(prior or {}).get("sha256_uncompressed"),
            local_cached_path=(prior or {}).get("local_cached_path"),
            now_iso=now_iso, last_changed_at=None,
            last_status="download_failed",
        )
        log.warning("openaq download failed loc=%s day=%s: %s", location_id, day.isoformat(), exc)
        return {
            "outcome": "download_failed", "downloaded_bytes": 0,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
            "error": str(exc),
        }
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

    if not state_changed and not needs_cache_refresh:
        # Downloaded only because metadata differed; content hash matches
        # prior. Discard temp; no event.
        tmp_path.unlink(missing_ok=True)
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=location_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=sha_compressed,
            sha256_uncompressed=sha_uncompressed,
            local_cached_path=prior.get("local_cached_path"),
            now_iso=now_iso, last_changed_at=None,
            last_status="unchanged",
        )
        return {
            "outcome": "unchanged_content", "downloaded_bytes": bytes_downloaded,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    event_type = (
        "first_seen" if is_first_seen
        else "reappeared" if was_missing
        else "changed" if state_changed
        else "unchanged"
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
        now_iso=now_iso, last_changed_at=now_iso if state_changed else None,
        last_status=event_type,
    )
    event_id = None
    if state_changed:
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
        "outcome": event_type if state_changed else "unchanged_content",
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
    history_version: str = "v1",
    env_name: str | None = None,
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
    wrapper_command = wrapper
    if wrapper_raw and Path(wrapper_raw).name == "uk_aq_integrity_backfill.sh":
        mode_arg = "--aqi-only" if output_scope == "aqilevels_only" else "--observs-only"
        cli_parts = [
            shlex.quote(wrapper),
            "--env",
            shlex.quote(str(env_name or env.get("UK_AQ_ENV_NAME") or os.environ.get("UK_AQ_ENV_NAME") or "<env unset>")),
            mode_arg,
            "--history-version",
            shlex.quote(str(history_version)),
            "--from-day",
            iso,
            "--to-day",
            iso,
            "--timeseries-ids",
            shlex.quote(ids_csv),
        ]
        if connector_csv:
            cli_parts.extend(["--connector-id", shlex.quote(connector_csv.split(",", 1)[0])])
        wrapper_command = " ".join(cli_parts)
    return (
        f"UK_AQ_BACKFILL_RUN_MODE=source_to_r2 "
        f"UK_AQ_BACKFILL_DRY_RUN=false "
        f"UK_AQ_BACKFILL_FORCE_REPLACE=true "
        f"UK_AQ_R2_HISTORY_VERSION={history_version} "
        f"UK_AQ_R2_HISTORY_INDEX_VERSION={history_version} "
        f"{f'UK_AQ_BACKFILL_OUTPUT_SCOPE={output_scope} ' if output_scope else ''}"
        f"{f'UK_AQ_BACKFILL_CONNECTOR_IDS={connector_csv} ' if connector_csv else ''}"
        f"UK_AQ_BACKFILL_TIMESERIES_IDS={ids_csv} "
        f"UK_AQ_BACKFILL_FROM_DAY_UTC={iso} "
        f"UK_AQ_BACKFILL_TO_DAY_UTC={iso} "
        f"UK_AQ_BACKFILL_ENV_FILE={env_file} "
        f"{wrapper_command}"
    )


def adapter_backfill_history_version(history_version_mode: str) -> str:
    """History version used by source-adapter triggered backfills.

    `both` mode remains conservative: source-change backfills keep the legacy
    v1 target while the v2 checker reports v2 gaps separately.
    """
    return "v2" if history_version_mode == "v2" else "v1"


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
_V2_OBSERVATION_REPAIR_CHUNK_ENV_VAR = "UK_AQ_HISTORY_INTEGRITY_V2_OBSERVATION_REPAIR_MAX_TIMESERIES_IDS"
_V2_OBSERVATION_REPAIR_DEFAULT_CHUNK_SIZE = 500

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


def _v2_observation_repair_chunk_size() -> int:
    raw = (os.environ.get(_V2_OBSERVATION_REPAIR_CHUNK_ENV_VAR) or "").strip()
    try:
        max_per = int(raw) if raw else _V2_OBSERVATION_REPAIR_DEFAULT_CHUNK_SIZE
    except (TypeError, ValueError):
        max_per = _V2_OBSERVATION_REPAIR_DEFAULT_CHUNK_SIZE
    if max_per <= 0:
        max_per = _V2_OBSERVATION_REPAIR_DEFAULT_CHUNK_SIZE
    return max_per


def _chunk_v2_observation_repair_timeseries_ids(ids: list[int]) -> list[list[int]]:
    """Chunk v2 source-scoped observation repairs before invoking the wrapper.

    v1 keeps the legacy opt-in chunking behavior above. v2 repairs can be
    connector-wide and source scoped, so a single OpenAQ connector/day can carry
    thousands of timeseries IDs through an env var and shell argument. Keep
    those wrapper calls bounded by default while preserving deterministic ID
    order.
    """
    max_per = _v2_observation_repair_chunk_size()
    if not ids:
        return []
    if len(ids) <= max_per:
        return [list(ids)]
    return [list(ids[i:i + max_per]) for i in range(0, len(ids), max_per)]


def _tail_lines(text: str, limit: int = 80) -> str:
    if not text:
        return ""
    lines = text.splitlines()
    if len(lines) <= limit:
        return text
    return "\n".join(["...[truncated]...", *lines[-limit:]])


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
                "stderr_tail": "", "log_path": None, "error": None,
                "rows_observations": 0, "source_connector_day_complete_events": 0,
                "source_connector_day_skipped_events": 0,
                "source_connector_day_pending_events": 0,
                "source_connector_day_failed_events": 0,
                "source_to_r2_targeted_stage_deferred_commit_events": 0,
                "targeted_stage_deferred_rows_observations": 0,
                "max_targeted_stage_deferred_rows_observations": 0,
                "source_timeseries_row_counts": {},
                "repaired_timeseries_row_counts": {},
                "source_pollutant_codes": [],
                "source_mapped_rows": 0,
                "backfill_run_status": None,
                "source_acquisition_pending_days": []}
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
        "rows_observations": sum(int(r.get("rows_observations") or 0) for r in results),
        "source_connector_day_complete_events": sum(int(r.get("source_connector_day_complete_events") or 0) for r in results),
        "source_connector_day_skipped_events": sum(int(r.get("source_connector_day_skipped_events") or 0) for r in results),
        "source_connector_day_pending_events": sum(int(r.get("source_connector_day_pending_events") or 0) for r in results),
        "source_connector_day_failed_events": sum(int(r.get("source_connector_day_failed_events") or 0) for r in results),
        "source_to_r2_targeted_stage_deferred_commit_events": sum(int(r.get("source_to_r2_targeted_stage_deferred_commit_events") or 0) for r in results),
        "targeted_stage_deferred_rows_observations": sum(int(r.get("targeted_stage_deferred_rows_observations") or 0) for r in results),
        "max_targeted_stage_deferred_rows_observations": max(
            [int(r.get("max_targeted_stage_deferred_rows_observations") or 0) for r in results] or [0]
        ),
        "source_timeseries_row_counts": _merge_timeseries_row_counts([
            r.get("source_timeseries_row_counts") for r in results
        ]),
        "repaired_timeseries_row_counts": _merge_timeseries_row_counts([
            r.get("repaired_timeseries_row_counts")
            or r.get("written_timeseries_row_counts")
            or r.get("observation_timeseries_row_counts")
            for r in results
        ]),
        "source_pollutant_codes": sorted({
            str(code).strip()
            for r in results
            for code in (r.get("source_pollutant_codes") or [])
            if str(code or "").strip()
        }),
        "source_mapped_rows": sum(int(r.get("source_mapped_rows") or 0) for r in results),
        "backfill_run_status": next((str(r.get("backfill_run_status")) for r in results if r.get("backfill_run_status")), None),
        "source_acquisition_pending_days": sorted({
            str(day)
            for r in results
            for day in (r.get("source_acquisition_pending_days") or [])
            if str(day or "").strip()
        }),
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
            "UK_AQ_DROPBOX_ROOT",
            "UK_AQ_R2_HISTORY_DROPBOX_DIR",
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


def _merge_timeseries_row_counts(
    raw_maps: Iterable[Any],
) -> dict[int, int]:
    merged: dict[int, int] = {}
    for raw_map in raw_maps:
        counts = _normalize_timeseries_row_counts(raw_map)
        for timeseries_id, count in counts.items():
            merged[timeseries_id] = merged.get(timeseries_id, 0) + count
    return merged


def _extract_source_to_r2_observation_status(stdout_text: str) -> dict[str, Any]:
    status: dict[str, Any] = {
        "rows_observations": 0,
        "source_connector_day_complete_events": 0,
        "source_connector_day_skipped_events": 0,
        "source_connector_day_pending_events": 0,
        "source_connector_day_failed_events": 0,
        "source_to_r2_targeted_stage_deferred_commit_events": 0,
        "targeted_stage_deferred_rows_observations": 0,
        "max_targeted_stage_deferred_rows_observations": 0,
        "source_timeseries_row_counts": {},
        "repaired_timeseries_row_counts": {},
        "source_pollutant_codes": [],
        "source_mapped_rows": 0,
        "backfill_run_status": None,
        "source_acquisition_pending_days": [],
    }
    source_timeseries_row_counts: dict[int, int] = {}
    source_pollutant_codes: set[str] = set()
    for line in stdout_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        event_name = event.get("event")
        try:
            timeseries_id = int(event.get("timeseries_id"))
        except (TypeError, ValueError):
            timeseries_id = None
        mapped_count = None
        for mapped_key in ("mapped_point_count", "mapped_records"):
            try:
                mapped_count = int(event.get(mapped_key))
            except (TypeError, ValueError):
                continue
            break
        if mapped_count is not None and mapped_count > 0:
            status["source_mapped_rows"] += mapped_count
            if timeseries_id is not None and timeseries_id > 0:
                source_timeseries_row_counts[timeseries_id] = (
                    source_timeseries_row_counts.get(timeseries_id, 0) + mapped_count
                )
        pollutant_code = str(event.get("pollutant_code") or "").strip()
        if pollutant_code and mapped_count is not None and mapped_count > 0:
            source_pollutant_codes.add(pollutant_code)
        if event_name == "source_to_r2_connector_day_complete":
            status["source_connector_day_complete_events"] += 1
            try:
                status["rows_observations"] += int(event.get("rows_observations") or 0)
            except (TypeError, ValueError):
                pass
            for code in event.get("pollutant_codes_written") or []:
                code_str = str(code or "").strip()
                if code_str:
                    source_pollutant_codes.add(code_str)
            continue
        if event_name == "source_to_r2_connector_day_skipped":
            status["source_connector_day_skipped_events"] += 1
            try:
                status["rows_observations"] += int(event.get("rows_observations") or 0)
            except (TypeError, ValueError):
                pass
            continue
        if event_name == "source_to_r2_connector_day_pending":
            status["source_connector_day_pending_events"] += 1
            continue
        if event_name == "source_to_r2_connector_day_failed":
            status["source_connector_day_failed_events"] += 1
            continue
        if event_name == "source_to_r2_targeted_stage_deferred_commit":
            status["source_to_r2_targeted_stage_deferred_commit_events"] += 1
            try:
                rows_observations = int(event.get("rows_observations") or 0)
            except (TypeError, ValueError):
                rows_observations = 0
            status["targeted_stage_deferred_rows_observations"] += rows_observations
            status["max_targeted_stage_deferred_rows_observations"] = max(
                int(status["max_targeted_stage_deferred_rows_observations"] or 0),
                rows_observations,
            )
            continue
        if event_name == "backfill_run_complete":
            run_status = event.get("status")
            if run_status is not None:
                status["backfill_run_status"] = str(run_status)
            summary = event.get("summary")
            if isinstance(summary, dict):
                pending_days = summary.get("source_acquisition_pending_days")
                if isinstance(pending_days, list):
                    status["source_acquisition_pending_days"] = [
                        str(day) for day in pending_days if str(day or "").strip()
                    ]
    status["source_timeseries_row_counts"] = source_timeseries_row_counts
    status["source_pollutant_codes"] = sorted(source_pollutant_codes)
    return status


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
    history_version: str = "v1",
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
        "UK_AQ_R2_HISTORY_VERSION": history_version,
        "UK_AQ_R2_HISTORY_INDEX_VERSION": history_version,
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
        # SOS historical repair uses the annual UK-AIR CSV cache exclusively.
        if not (
            sub_env.get("UK_AQ_BACKFILL_SOS_FLAT_FILE_ROOT") or ""
        ).strip():
            sub_env["UK_AQ_BACKFILL_SOS_FLAT_FILE_ROOT"] = str(
                Path(integrity_cache_root) / "sos"
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
            "--history-version",
            history_version,
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
    result.update(_extract_source_to_r2_observation_status(stdout_text))

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
    if result.get("status") != "ok":
        if result.get("stdout_tail"):
            log.warning("backfill stdout tail:\n%s", result["stdout_tail"])
        if result.get("stderr_tail"):
            log.warning("backfill stderr tail:\n%s", result["stderr_tail"])
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
    history_version: str = "v1",
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
        "download_failed": 0,
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
                    force_download_when_cache_missing=(history_version == "v2"),
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
            if outcome == "download_failed":
                metrics["download_failed"] += 1
                metrics["errors"] += 1
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
                    connector_ids = (
                        _connector_ids_for_timeseries(conn, result["timeseries_ids"])
                        if history_version == "v2"
                        else None
                    )
                    cmd = _planned_backfill_command(
                        env,
                        result["timeseries_ids"],
                        day_obj,
                        connector_ids=connector_ids,
                        history_version=history_version,
                        env_name=env_name,
                    )
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
            connector_ids = (
                _connector_ids_for_timeseries(conn, union_ids)
                if history_version == "v2"
                else None
            )
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
                    connector_ids=connector_ids,
                    day=dt.date.fromisoformat(day_iso),
                    log=log,
                    log_dir=backfill_log_dir,
                    log_label=chunk_label,
                    history_version=history_version,
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
    force_download_when_cache_missing: bool = False,
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
            force_download_when_cache_missing=force_download_when_cache_missing,
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
    force_download_when_cache_missing: bool = False,
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
    needs_cache_refresh = (
        bool(force_download_when_cache_missing)
        and prior is not None
        and int(prior.get("exists_remote") or 0) == 1
        and not _prior_local_cache_exists(prior)
    )
    needs_download = is_first_seen or was_missing or _metadata_changed(prior, head) or needs_cache_refresh

    if not needs_download:
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=sensor_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=prior["sha256_downloaded"],
            sha256_uncompressed=prior["sha256_uncompressed"],
            local_cached_path=prior.get("local_cached_path"),
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

    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"sc-{sensor_id}-{day.strftime('%Y%m%d')}.csv"
    if tmp_path.exists():
        tmp_path.unlink()
    try:
        bytes_downloaded = _http_get_to_file(url, tmp_path)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=sensor_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=(prior or {}).get("sha256_downloaded"),
            sha256_uncompressed=(prior or {}).get("sha256_uncompressed"),
            local_cached_path=(prior or {}).get("local_cached_path"),
            now_iso=now_iso, last_changed_at=None,
            last_status="download_failed",
        )
        conn.execute(
            "UPDATE source_file_state SET source_key=?, remote_scheme=? WHERE source_file_key=?",
            (SC_SOURCE_KEY, SC_REMOTE_SCHEME, sfk),
        )
        log.warning("sensorcommunity download failed sensor=%s day=%s: %s", sensor_id, day.isoformat(), exc)
        return {
            "outcome": "download_failed", "downloaded_bytes": 0,
            "event_id": None, "event_type": None,
            "timeseries_ids": timeseries_ids,
            "error": str(exc),
        }
    hash_start = time.monotonic()
    sha_csv = _sha256_of_csv(tmp_path)
    hash_runtime_ms = int((time.monotonic() - hash_start) * 1000)

    content_changed = (
        prior is None
        or prior.get("sha256_uncompressed") is None
        or prior["sha256_uncompressed"] != sha_csv
    )
    state_changed = is_first_seen or was_missing or content_changed

    if not state_changed and not needs_cache_refresh:
        tmp_path.unlink(missing_ok=True)
        _upsert_state(
            conn, source_file_key=sfk, env_name=env_name, remote_url=url,
            location_id=sensor_id, day=day,
            head=head, exists_remote=True,
            sha256_downloaded=sha_csv,
            sha256_uncompressed=sha_csv,
            local_cached_path=prior.get("local_cached_path"),
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
        else "changed" if state_changed
        else "unchanged"
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
        now_iso=now_iso, last_changed_at=now_iso if state_changed else None,
        last_status=event_type,
    )
    conn.execute(
        "UPDATE source_file_state SET source_key=?, remote_scheme=? WHERE source_file_key=?",
        (SC_SOURCE_KEY, SC_REMOTE_SCHEME, sfk),
    )
    event_id = None
    if state_changed:
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
        "outcome": event_type if state_changed else "unchanged_content",
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
    history_version: str = "v1",
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
        "download_failed": 0,
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
                force_download_when_cache_missing=(history_version == "v2"),
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
            if outcome == "download_failed":
                metrics["download_failed"] += 1
                metrics["errors"] += 1
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
                    connector_ids = (
                        _connector_ids_for_timeseries(conn, result["timeseries_ids"])
                        if history_version == "v2"
                        else None
                    )
                    cmd = _planned_backfill_command(
                        env,
                        result["timeseries_ids"],
                        day_obj,
                        connector_ids=connector_ids,
                        history_version=history_version,
                        env_name=env_name,
                    )
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
            connector_ids = (
                _connector_ids_for_timeseries(conn, union_ids)
                if history_version == "v2"
                else None
            )
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
                    connector_ids=connector_ids,
                    day=dt.date.fromisoformat(day_iso),
                    log=log,
                    log_dir=backfill_log_dir,
                    log_label=chunk_label,
                    history_version=history_version,
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


SOS_REMOTE_SCHEME = "api"


def _should_suppress_sos_not_found_retry(
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


def _check_one_sos_station_day_threadsafe(
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
        result = _check_one_sos_station_day(
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


def _check_one_sos_station_day(
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
    sfk = _sos_source_file_key(station_ref, day)
    now_iso = fmt_iso(utc_now())
    prior = _fetch_prior_state(conn, sfk)
    source_location_id = station_ref
    timeseries_ids = sorted({
        int(binding["timeseries_id"])
        for binding in bindings
        if int(binding["timeseries_id"]) > 0
    })
    remote_key = _sos_remote_key(base_url, station_ref, day)

    if _should_suppress_sos_not_found_retry(
        prior,
        now_iso=now_iso,
        cooldown_seconds=not_found_cooldown_seconds,
    ):
        _upsert_source_state(
            conn=conn,
            source_key=SOS_SOURCE_KEY,
            remote_scheme=SOS_REMOTE_SCHEME,
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
                "sos not_found suppressed by cooldown "
                f"({not_found_cooldown_seconds}s)"
            ),
        )
        return {
            "outcome": "not_found_suppressed",
            "snapshot_status": SOS_STATUS_NOT_FOUND,
            "downloaded_bytes": 0,
            "row_count": 0,
            "event_id": None,
            "event_type": None,
            "timeseries_ids": timeseries_ids,
        }

    snapshot = build_sos_canonical_snapshot(
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
    if snapshot_status in {SOS_STATUS_TEMP_ERROR, SOS_STATUS_PERM_ERROR}:
        if prior is not None:
            _mark_source_state_fetch_error(
                conn,
                source_file_key=sfk,
                status=snapshot_status,
                now_iso=now_iso,
            )
        event_type = "temporary_error" if snapshot_status == SOS_STATUS_TEMP_ERROR else "permanent_error"
        event_id = _insert_source_event(
            conn=conn,
            source_key=SOS_SOURCE_KEY,
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
    if snapshot_status == SOS_STATUS_NOT_FOUND:
        if prior is None:
            _upsert_source_state(
                conn=conn,
                source_key=SOS_SOURCE_KEY,
                remote_scheme=SOS_REMOTE_SCHEME,
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
                notes="sos snapshot not_found",
            )
            event_id = _insert_source_event(
                conn=conn,
                source_key=SOS_SOURCE_KEY,
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
                notes="sos snapshot not_found",
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
                source_key=SOS_SOURCE_KEY,
                remote_scheme=SOS_REMOTE_SCHEME,
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
                notes="sos snapshot not_found",
            )
            event_id = _insert_source_event(
                conn=conn,
                source_key=SOS_SOURCE_KEY,
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
                notes="sos snapshot not_found after prior success",
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
            source_key=SOS_SOURCE_KEY,
            remote_scheme=SOS_REMOTE_SCHEME,
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
            notes="sos snapshot still missing",
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
        row_count > 0
        and (
            keep_policy == "all"
            or (keep_policy == "changed" and outcome in {"changed", "reappeared"})
        )
    )
    cache_path = _sos_cache_path(cache_root, station_ref, day)
    local_cached_path: str | None = None
    if keep_snapshot:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(ndjson_bytes)
        local_cached_path = str(cache_path)
    else:
        if cache_path.exists():
            cache_path.unlink(missing_ok=True)
        try:
            cache_path.parent.rmdir()
            cache_path.parent.parent.rmdir()
        except OSError:
            pass

    _upsert_source_state(
        conn=conn,
        source_key=SOS_SOURCE_KEY,
        remote_scheme=SOS_REMOTE_SCHEME,
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
            f"sos snapshot_status={snapshot_status} row_count={row_count} "
            f"keep_policy={keep_policy}"
        ),
    )

    event_id: int | None = None
    if event_type:
        event_id = _insert_source_event(
            conn=conn,
            source_key=SOS_SOURCE_KEY,
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
                f"sos snapshot_status={snapshot_status} row_count={row_count} "
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


def _check_one_sos_uk_air_flat_file_threadsafe(
    db_path: str,
    env_name: str,
    base_url: str,
    site_ref: str,
    year: int,
    grouped_mappings: Mapping[str, Mapping[str, list[dict[str, Any]]]],
    target_pollutants: Iterable[str],
    cache_root: Path,
    keep_policy: str,
    requested_from_day: str,
    requested_to_day: str,
    log: logging.Logger,
    limits: LimitTracker | None = None,
) -> dict[str, Any]:
    if limits is not None and limits.should_stop():
        return {
            "outcome": "stopped",
            "site_ref": site_ref,
            "year": int(year),
            "downloaded_bytes": 0,
            "row_count": 0,
            "source_rows": 0,
            "event_id": None,
            "event_type": None,
            "timeseries_ids": [],
        }
    conn = _worker_db_conn(db_path)
    try:
        result = _check_one_sos_uk_air_flat_file(
            conn=conn,
            env_name=env_name,
            base_url=base_url,
            site_ref=site_ref,
            year=year,
            grouped_mappings=grouped_mappings,
            target_pollutants=target_pollutants,
            cache_root=cache_root,
            keep_policy=keep_policy,
            requested_from_day=requested_from_day,
            requested_to_day=requested_to_day,
            log=log,
        )
    finally:
        try:
            conn.commit()
        except sqlite3.Error:
            pass
    result["site_ref"] = str(site_ref).strip().upper()
    result["year"] = int(year)
    return result


def _check_one_sos_uk_air_flat_file(
    conn: sqlite3.Connection,
    env_name: str,
    base_url: str,
    site_ref: str,
    year: int,
    grouped_mappings: Mapping[str, Mapping[str, list[dict[str, Any]]]],
    target_pollutants: Iterable[str],
    cache_root: Path,
    keep_policy: str,
    log: logging.Logger,
    requested_from_day: str | None = None,
    requested_to_day: str | None = None,
) -> dict[str, Any]:
    site_token = str(site_ref).strip().upper()
    sfk = _uk_air_flat_file_source_file_key(site_token, year)
    now_iso = fmt_iso(utc_now())
    prior = _fetch_prior_state(conn, sfk)
    remote_url = _uk_air_flat_file_remote_url(base_url, site_token, year)
    source_location_id = site_token
    year_day = _uk_air_flat_file_year_day(year)

    metrics: dict[str, Any] = {
        "outcome": None,
        "snapshot_status": None,
        "downloaded_bytes": 0,
        "row_count": 0,
        "source_rows": 0,
        "mapped_rows": 0,
        "mapped_days": 0,
        "mapped_pollutants": 0,
        "unmapped_source_groups": 0,
        "ambiguous_mapping_groups": 0,
        "unmapped_source_rows": 0,
        "ambiguous_mapping_rows": 0,
        "out_of_window_unmapped_groups": 0,
        "out_of_window_unmapped_rows": 0,
        "actionable_mapping_issues": [],
        "event_id": None,
        "event_type": None,
        "timeseries_ids": [],
        "downloaded": False,
        "cache_reused": False,
        "cache_missing_redownloaded": False,
        "download_reason": None,
    }

    try:
        head = _http_head(remote_url)
    except Exception as exc:
        snapshot_status = SOS_STATUS_TEMP_ERROR if _is_retryable_url_error(exc) else SOS_STATUS_PERM_ERROR
        if prior is not None:
            _mark_source_state_fetch_error(
                conn,
                source_file_key=sfk,
                status=snapshot_status,
                now_iso=now_iso,
            )
        event_type = "temporary_error" if snapshot_status == SOS_STATUS_TEMP_ERROR else "permanent_error"
        event_id = _insert_source_event(
            conn=conn,
            source_key=SOS_SOURCE_KEY,
            event_type=event_type,
            env_name=env_name,
            source_file_key=sfk,
            remote_url_or_key=remote_url,
            station_ref=site_token,
            source_location_id=source_location_id,
            day=year_day,
            prior=prior,
            new_content_length=None,
            new_etag=None,
            new_last_modified_utc=None,
            new_sha256_downloaded=None,
            new_sha256_uncompressed=None,
            downloaded_bytes=0,
            hash_runtime_ms=0,
            now_iso=now_iso,
            notes=f"uk_air_flat_file head_failed:{exc}",
        )
        return {
            **metrics,
            "outcome": event_type,
            "snapshot_status": snapshot_status,
            "event_id": event_id,
            "event_type": event_type,
        }

    status_code = int(head.get("status") or 0)
    if status_code == 404:
        if prior is None:
            _upsert_source_state(
                conn=conn,
                source_key=SOS_SOURCE_KEY,
                remote_scheme="uk_air_flat_file",
                source_file_key=sfk,
                env_name=env_name,
                remote_url_or_key=remote_url,
                station_ref=site_token,
                source_location_id=source_location_id,
                day=year_day,
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
                notes="uk_air_flat_file not_found",
            )
            event_id = _insert_source_event(
                conn=conn,
                source_key=SOS_SOURCE_KEY,
                event_type="missing_first_seen",
                env_name=env_name,
                source_file_key=sfk,
                remote_url_or_key=remote_url,
                station_ref=site_token,
                source_location_id=source_location_id,
                day=year_day,
                prior=None,
                new_content_length=None,
                new_etag=None,
                new_last_modified_utc=None,
                new_sha256_downloaded=None,
                new_sha256_uncompressed=None,
                downloaded_bytes=0,
                hash_runtime_ms=0,
                now_iso=now_iso,
                notes="uk_air_flat_file not_found",
            )
            return {
                **metrics,
                "outcome": "not_found_first_seen",
                "snapshot_status": SOS_STATUS_NOT_FOUND,
                "event_id": event_id,
                "event_type": "missing_first_seen",
            }

        if int(prior.get("exists_remote") or 0) == 1:
            _upsert_source_state(
                conn=conn,
                source_key=SOS_SOURCE_KEY,
                remote_scheme="uk_air_flat_file",
                source_file_key=sfk,
                env_name=env_name,
                remote_url_or_key=remote_url,
                station_ref=site_token,
                source_location_id=source_location_id,
                day=year_day,
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
                notes="uk_air_flat_file not_found",
            )
            event_id = _insert_source_event(
                conn=conn,
                source_key=SOS_SOURCE_KEY,
                event_type="missing_after_seen",
                env_name=env_name,
                source_file_key=sfk,
                remote_url_or_key=remote_url,
                station_ref=site_token,
                source_location_id=source_location_id,
                day=year_day,
                prior=prior,
                new_content_length=None,
                new_etag=None,
                new_last_modified_utc=None,
                new_sha256_downloaded=None,
                new_sha256_uncompressed=None,
                downloaded_bytes=0,
                hash_runtime_ms=0,
                now_iso=now_iso,
                notes="uk_air_flat_file not_found after prior success",
            )
            return {
                **metrics,
                "outcome": "not_found_after_seen",
                "snapshot_status": SOS_STATUS_NOT_FOUND,
                "event_id": event_id,
                "event_type": "missing_after_seen",
            }

        _upsert_source_state(
            conn=conn,
            source_key=SOS_SOURCE_KEY,
            remote_scheme="uk_air_flat_file",
            source_file_key=sfk,
            env_name=env_name,
            remote_url_or_key=remote_url,
            station_ref=site_token,
            source_location_id=source_location_id,
            day=year_day,
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
            notes="uk_air_flat_file still missing",
        )
        return {
            **metrics,
            "outcome": "not_found_still",
            "snapshot_status": SOS_STATUS_NOT_FOUND,
        }

    if status_code != 200:
        snapshot_status = SOS_STATUS_TEMP_ERROR if status_code >= 500 or status_code == 429 else SOS_STATUS_PERM_ERROR
        if prior is not None:
            _mark_source_state_fetch_error(
                conn,
                source_file_key=sfk,
                status=snapshot_status,
                now_iso=now_iso,
            )
        event_type = "temporary_error" if snapshot_status == SOS_STATUS_TEMP_ERROR else "permanent_error"
        event_id = _insert_source_event(
            conn=conn,
            source_key=SOS_SOURCE_KEY,
            event_type=event_type,
            env_name=env_name,
            source_file_key=sfk,
            remote_url_or_key=remote_url,
            station_ref=site_token,
            source_location_id=source_location_id,
            day=year_day,
            prior=prior,
            new_content_length=None,
            new_etag=None,
            new_last_modified_utc=None,
            new_sha256_downloaded=None,
            new_sha256_uncompressed=None,
            downloaded_bytes=0,
            hash_runtime_ms=0,
            now_iso=now_iso,
            notes=f"uk_air_flat_file head_status={status_code}",
        )
        return {
            **metrics,
            "outcome": event_type,
            "snapshot_status": snapshot_status,
            "event_id": event_id,
            "event_type": event_type,
        }

    cache_path = _uk_air_flat_file_cache_path(cache_root, site_token, year)
    is_first_seen = prior is None
    was_missing = prior is not None and int(prior.get("exists_remote") or 0) == 0
    prior_sha = str(prior.get("sha256_uncompressed") or "") if prior else ""
    prior_cache_existed = cache_path.is_file()
    prior_status = str((prior or {}).get("last_status") or "")
    prior_status_is_error = prior_status in {
        SOS_STATUS_TEMP_ERROR,
        SOS_STATUS_PERM_ERROR,
        "download_failed",
    }

    cache_reused = False
    download_reason: str | None = None
    sha_csv = ""
    if is_first_seen:
        download_reason = "first_seen"
    elif was_missing:
        download_reason = "reappeared"
    elif prior_status_is_error:
        download_reason = "prior_error_status"
    elif not prior_cache_existed:
        download_reason = "cache_missing"
    elif not prior_sha:
        download_reason = "prior_hash_missing"
    elif not _uk_air_flat_file_remote_metadata_matches(prior, head):
        download_reason = "remote_metadata_changed_or_unreliable"
    else:
        sha_csv = hashlib.sha256(cache_path.read_bytes()).hexdigest()
        if sha_csv == prior_sha:
            cache_reused = True
        else:
            download_reason = "cache_hash_mismatch"

    downloaded_bytes = 0
    if not cache_reused:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            downloaded_bytes = _http_get_to_file(remote_url, cache_path)
        except Exception as exc:
            snapshot_status = (
                SOS_STATUS_TEMP_ERROR
                if _is_retryable_url_error(exc)
                else SOS_STATUS_PERM_ERROR
            )
            if prior is not None:
                _mark_source_state_fetch_error(
                    conn,
                    source_file_key=sfk,
                    status=snapshot_status,
                    now_iso=now_iso,
                )
            event_type = (
                "temporary_error"
                if snapshot_status == SOS_STATUS_TEMP_ERROR
                else "permanent_error"
            )
            event_id = _insert_source_event(
                conn=conn,
                source_key=SOS_SOURCE_KEY,
                event_type=event_type,
                env_name=env_name,
                source_file_key=sfk,
                remote_url_or_key=remote_url,
                station_ref=site_token,
                source_location_id=source_location_id,
                day=year_day,
                prior=prior,
                new_content_length=None,
                new_etag=None,
                new_last_modified_utc=None,
                new_sha256_downloaded=None,
                new_sha256_uncompressed=None,
                downloaded_bytes=0,
                hash_runtime_ms=0,
                now_iso=now_iso,
                notes=(
                    "uk_air_flat_file get_failed "
                    f"download_reason={download_reason} error={exc}"
                ),
            )
            return {
                **metrics,
                "outcome": event_type,
                "snapshot_status": snapshot_status,
                "event_id": event_id,
                "event_type": event_type,
                "download_reason": download_reason,
            }
        sha_csv = hashlib.sha256(cache_path.read_bytes()).hexdigest()

    metrics["downloaded"] = not cache_reused
    metrics["cache_reused"] = cache_reused
    metrics["cache_missing_redownloaded"] = (
        not cache_reused and download_reason == "cache_missing"
    )
    metrics["download_reason"] = download_reason

    parsed_counts, parse_stats = _uk_air_flat_file_parse_day_pollutant_counts(
        cache_path,
        target_pollutants=target_pollutants,
    )
    grouped = grouped_mappings.get(site_token, {})
    counts_by_day_ts: dict[tuple[str, int], int] = {}
    mapped_timeseries_ids: set[int] = set()
    mapped_days: set[str] = set()
    mapped_pollutants: set[str] = set()
    unmapped_groups = 0
    ambiguous_groups = 0
    unmapped_rows = 0
    ambiguous_rows = 0
    out_of_window_unmapped_groups = 0
    out_of_window_unmapped_rows = 0
    issue_notes: list[str] = []
    for (day_utc, pollutant_code), source_count in sorted(parsed_counts.items()):
        mapping_row, mapping_status = _resolve_uk_air_flat_file_mapping_row(
            grouped.get(pollutant_code, []),
            day_utc,
        )
        if mapping_row is None:
            in_requested_window = bool(
                not requested_from_day or not requested_to_day
                or requested_from_day <= day_utc <= requested_to_day
            )
            if mapping_status == "ambiguous_mapping":
                if in_requested_window:
                    ambiguous_groups += 1
                    ambiguous_rows += int(source_count)
            else:
                if in_requested_window:
                    unmapped_groups += 1
                    unmapped_rows += int(source_count)
                else:
                    out_of_window_unmapped_groups += 1
                    out_of_window_unmapped_rows += int(source_count)
            if in_requested_window:
                issue_notes.append(f"{day_utc}:{pollutant_code}={mapping_status}")
                metrics["actionable_mapping_issues"].append({
                    "site_ref": site_token,
                    "day_utc": day_utc,
                    "pollutant_code": pollutant_code,
                    "source_rows": int(source_count),
                    "mapping_status": mapping_status or "unmapped_source",
                })
            continue
        try:
            timeseries_id = int(mapping_row.get("timeseries_id") or 0)
        except (TypeError, ValueError):
            unmapped_groups += 1
            unmapped_rows += int(source_count)
            issue_notes.append(f"{day_utc}:{pollutant_code}=invalid_timeseries_id")
            continue
        if timeseries_id <= 0:
            unmapped_groups += 1
            unmapped_rows += int(source_count)
            issue_notes.append(f"{day_utc}:{pollutant_code}=invalid_timeseries_id")
            continue
        counts_by_day_ts[(day_utc, timeseries_id)] = counts_by_day_ts.get((day_utc, timeseries_id), 0) + int(source_count)
        mapped_timeseries_ids.add(timeseries_id)
        mapped_days.add(day_utc)
        mapped_pollutants.add(pollutant_code)

    metrics["source_rows"] = int(parse_stats.get("rows") or 0)
    metrics["mapped_rows"] = sum(counts_by_day_ts.values())
    metrics["row_count"] = metrics["mapped_rows"]
    metrics["mapped_days"] = len(mapped_days)
    metrics["mapped_pollutants"] = len(mapped_pollutants)
    metrics["unmapped_source_groups"] = unmapped_groups
    metrics["ambiguous_mapping_groups"] = ambiguous_groups
    metrics["unmapped_source_rows"] = unmapped_rows
    metrics["ambiguous_mapping_rows"] = ambiguous_rows
    metrics["out_of_window_unmapped_groups"] = out_of_window_unmapped_groups
    metrics["out_of_window_unmapped_rows"] = out_of_window_unmapped_rows
    metrics["timeseries_ids"] = sorted(mapped_timeseries_ids)
    metrics["downloaded_bytes"] = int(downloaded_bytes)
    metrics["snapshot_status"] = SOS_STATUS_OK if metrics["source_rows"] > 0 else SOS_STATUS_NO_DATA

    _record_source_file_timeseries_counts(
        conn,
        sfk,
        counts_by_day_ts,
        now_iso,
        default_day_utc=year_day.isoformat(),
    )

    content_changed = is_first_seen or (not prior_sha) or prior_sha != sha_csv
    state_changed = is_first_seen or was_missing or content_changed
    mapping_status = "ok"
    if unmapped_groups and ambiguous_groups:
        mapping_status = "mixed_mapping_issues"
    elif unmapped_groups:
        mapping_status = "unmapped_source"
    elif ambiguous_groups:
        mapping_status = "ambiguous_mapping"
    if metrics["mapped_rows"] <= 0 and mapping_status == "ok" and metrics["source_rows"] > 0:
        mapping_status = "unmapped_source"
    state_status = mapping_status if mapping_status != "ok" else (
        "first_seen" if is_first_seen else "reappeared" if was_missing else "changed" if content_changed else "unchanged"
    )

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

    keep_source_file = (
        keep_policy == "all"
        or (
            keep_policy == "changed"
            and (state_changed or prior_cache_existed)
        )
    )
    local_cached_path: str | None = None
    if keep_source_file:
        local_cached_path = str(cache_path)
    else:
        try:
            cache_path.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            cache_path.parent.rmdir()
            cache_path.parent.parent.rmdir()
        except OSError:
            pass

    notes_bits = [
        "uk_air_flat_file",
        f"site_ref={site_token}",
        f"year={int(year)}",
        f"source_rows={metrics['source_rows']}",
        f"mapped_rows={metrics['mapped_rows']}",
        f"mapped_days={metrics['mapped_days']}",
        f"mapped_pollutants={metrics['mapped_pollutants']}",
        f"mapping_status={mapping_status}",
        f"snapshot_status={metrics['snapshot_status']}",
        f"keep_policy={keep_policy}",
        f"local_cache={'kept' if keep_source_file else 'deleted'}",
        f"source_acquisition={'cache_reused' if cache_reused else 'downloaded'}",
    ]
    if download_reason:
        notes_bits.append(f"download_reason={download_reason}")
    if metrics["cache_missing_redownloaded"]:
        notes_bits.append("cache_missing_redownloaded=true")
    if issue_notes:
        notes_bits.append("mapping_issues=" + ";".join(issue_notes[:25]))
    notes = " ".join(notes_bits)

    try:
        source_content_length = int(head.get("content_length"))
    except (TypeError, ValueError):
        source_content_length = cache_path.stat().st_size

    _upsert_source_state(
        conn=conn,
        source_key=SOS_SOURCE_KEY,
        remote_scheme="uk_air_flat_file",
        source_file_key=sfk,
        env_name=env_name,
        remote_url_or_key=remote_url,
        station_ref=site_token,
        source_location_id=source_location_id,
        day=year_day,
        exists_remote=True,
        content_length=source_content_length,
        etag=str(head.get("etag") or "") or None,
        last_modified_utc=str(head.get("last_modified") or "") or None,
        sha256_downloaded=sha_csv,
        sha256_uncompressed=sha_csv,
        local_cached_path=local_cached_path,
        now_iso=now_iso,
        last_changed_at=last_changed_at,
        last_status=state_status,
        notes=notes,
    )

    event_id: int | None = None
    if event_type:
        event_id = _insert_source_event(
            conn=conn,
            source_key=SOS_SOURCE_KEY,
            event_type=event_type,
            env_name=env_name,
            source_file_key=sfk,
            remote_url_or_key=remote_url,
            station_ref=site_token,
            source_location_id=source_location_id,
            day=year_day,
            prior=prior,
            new_content_length=source_content_length,
            new_etag=str(head.get("etag") or "") or None,
            new_last_modified_utc=str(head.get("last_modified") or "") or None,
            new_sha256_downloaded=sha_csv,
            new_sha256_uncompressed=sha_csv,
            downloaded_bytes=downloaded_bytes,
            hash_runtime_ms=0,
            now_iso=now_iso,
            notes=notes,
        )

    return {
        **metrics,
        "outcome": outcome,
        "event_id": event_id,
        "event_type": event_type,
        "source_file_key": sfk,
        "remote_url": remote_url,
        "mapping_status": mapping_status,
    }


def check_sos_flat_files(
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
    history_version: str = "v1",
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "ran": False,
        "stopped_for": None,
        "source_mode": "uk_air_flat_files",
        "stations": 0,
        "stations_checked": 0,
        "days": 0,
        "site_years": 0,
        "station_days_checked": 0,
        "head_checked": 0,
        "files_checked": 0,
        "downloaded": 0,
        "unchanged": 0,
        "unchanged_cached": 0,
        "cache_reused": 0,
        "cache_missing_redownloaded": 0,
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
        "source_rows": 0,
        "downloaded_bytes": 0,
        "mapped_days": 0,
        "mapped_pollutants": 0,
        "unmapped_source_groups": 0,
        "ambiguous_mapping_groups": 0,
        "unmapped_source_rows": 0,
        "ambiguous_mapping_rows": 0,
        "out_of_window_unmapped_groups": 0,
        "out_of_window_unmapped_rows": 0,
        "actionable_mapping_issues": [],
        "first_seen_files": [],
        "changed_files": [],
        "planned_backfills": [],
        "backfills_attempted": 0,
        "backfills_ok": 0,
        "backfills_failed": 0,
        "keep_api_snapshots_policy": _resolve_keep_api_snapshots_policy(),
        "not_found_cooldown_seconds": _resolve_sos_not_found_cooldown_seconds(),
        "flat_file_base_url": _resolve_uk_air_flat_file_base_url(env),
        "target_pollutants": list(_resolve_sos_target_pollutants(env)),
        "sample_urls": [],
        "skipped_reason": None,
    }
    if not from_day or not to_day:
        metrics["skipped_reason"] = "from_day/to_day not set; manual profile requires both"
        log.warning("sos flat-file: skipped — %s", metrics["skipped_reason"])
        return metrics

    years = _uk_air_flat_file_years_for_window(from_day, to_day)
    if not years:
        metrics["skipped_reason"] = f"empty date range {from_day}..{to_day}"
        log.warning("sos flat-file: skipped — %s", metrics["skipped_reason"])
        return metrics

    mapping_rows = _fetch_uk_air_flat_file_mapping_rows(
        env=env,
        from_day=f"{min(years):04d}-01-01",
        to_day=f"{max(years):04d}-12-31",
        target_pollutants=metrics["target_pollutants"],
    )
    grouped_mappings = _group_uk_air_flat_file_mapping_rows(mapping_rows)
    if not grouped_mappings:
        metrics["skipped_reason"] = "no UK-AIR site_ref mappings returned from Supabase"
        log.warning("sos flat-file: skipped — %s", metrics["skipped_reason"])
        return metrics

    tasks: list[dict[str, Any]] = []
    for site_ref in sorted(grouped_mappings):
        for year in years:
            tasks.append({
                "site_ref": site_ref,
                "year": year,
                "source_file_key": _uk_air_flat_file_source_file_key(site_ref, year),
                "remote_url": _uk_air_flat_file_remote_url(metrics["flat_file_base_url"], site_ref, year),
            })

    metrics["stations"] = len(grouped_mappings)
    metrics["stations_checked"] = len(grouped_mappings)
    metrics["days"] = len(years)
    metrics["site_years"] = len(tasks)
    metrics["station_days_checked"] = 0
    metrics["head_checked"] = 0
    metrics["files_checked"] = 0
    metrics["ran"] = True

    log.info(
        "sos flat-file: starting sites=%s years=%s files=%s base_url=%s target_pollutants=%s%s",
        metrics["stations"],
        len(years),
        len(tasks),
        metrics["flat_file_base_url"],
        ",".join(metrics["target_pollutants"]),
        " (dry-run)" if dry_run else "",
    )

    if dry_run:
        metrics["sample_urls"] = [task["remote_url"] for task in tasks[:6]]
        log.info(
            "sos flat-file dry-run: would check %s site/year files; sample=%s",
            len(tasks),
            metrics["sample_urls"][:6],
        )
        return metrics

    cache_root = Path(env["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"]) / SOS_SOURCE_KEY
    cache_root.mkdir(parents=True, exist_ok=True)
    db_path = env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures: list[concurrent.futures.Future] = []
        for task in tasks:
            if limits.should_stop():
                break
            futures.append(ex.submit(
                _check_one_sos_uk_air_flat_file_threadsafe,
                db_path,
                env_name,
                metrics["flat_file_base_url"],
                task["site_ref"],
                int(task["year"]),
                grouped_mappings,
                metrics["target_pollutants"],
                cache_root,
                metrics["keep_api_snapshots_policy"],
                from_day,
                to_day,
                log,
                limits,
            ))

        total_tasks = len(futures)
        completed_tasks = 0
        progress = SingleLineProgress("sos flat-file progress")
        progress.update(
            (
                f"0/{total_tasks} checked=0 downloaded=0 cached=0 mapped_rows=0 "
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
                log.warning("sos flat-file worker raised: %s", exc)
                progress.update(
                    (
                        f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                        f"downloaded={metrics['downloaded']} cached={metrics['cache_reused']} "
                        f"mapped_rows={metrics['rows_counted']} "
                        f"missing={metrics['missing']} errors={metrics['errors']} "
                        f"planned_backfills=0"
                    ),
                )
                continue

            outcome = str(result.get("outcome") or "")
            metrics["head_checked"] += 1
            metrics["files_checked"] += 1
            metrics["downloaded_bytes"] += int(result.get("downloaded_bytes") or 0)
            if bool(result.get("downloaded")):
                metrics["downloaded"] += 1
            if bool(result.get("cache_reused")):
                metrics["cache_reused"] += 1
            if bool(result.get("cache_missing_redownloaded")):
                metrics["cache_missing_redownloaded"] += 1
            metrics["source_rows"] += int(result.get("source_rows") or 0)
            metrics["rows_counted"] += int(result.get("mapped_rows") or result.get("row_count") or 0)
            metrics["mapped_days"] += int(result.get("mapped_days") or 0)
            metrics["mapped_pollutants"] += int(result.get("mapped_pollutants") or 0)
            metrics["unmapped_source_groups"] += int(result.get("unmapped_source_groups") or 0)
            metrics["ambiguous_mapping_groups"] += int(result.get("ambiguous_mapping_groups") or 0)
            metrics["unmapped_source_rows"] += int(result.get("unmapped_source_rows") or 0)
            metrics["ambiguous_mapping_rows"] += int(result.get("ambiguous_mapping_rows") or 0)
            metrics["out_of_window_unmapped_groups"] += int(result.get("out_of_window_unmapped_groups") or 0)
            metrics["out_of_window_unmapped_rows"] += int(result.get("out_of_window_unmapped_rows") or 0)
            remaining_issue_slots = max(0, 100 - len(metrics["actionable_mapping_issues"]))
            if remaining_issue_slots:
                metrics["actionable_mapping_issues"].extend(
                    list(result.get("actionable_mapping_issues") or [])[:remaining_issue_slots]
                )

            snapshot_status = str(result.get("snapshot_status") or "")
            if snapshot_status in {SOS_STATUS_OK, SOS_STATUS_NO_DATA}:
                metrics["snapshots_successful"] += 1
                if snapshot_status == SOS_STATUS_NO_DATA:
                    metrics["snapshots_no_data"] += 1
            elif snapshot_status == SOS_STATUS_NOT_FOUND:
                metrics["not_found"] += 1

            if outcome == "first_seen":
                metrics["first_seen"] += 1
                metrics["first_seen_files"].append({
                    "site_ref": result["site_ref"],
                    "station_ref": result["site_ref"],
                    "year": result["year"],
                    "day": f"{int(result['year'])}-01-01",
                    "source_file_key": result.get("source_file_key"),
                    "event_id": result.get("event_id"),
                    "event_type": result.get("event_type"),
                    "timeseries_ids": result.get("timeseries_ids"),
                })
            elif outcome == "reappeared":
                metrics["changed"] += 1
                metrics["reappeared"] += 1
                metrics["changed_files"].append({
                    "site_ref": result["site_ref"],
                    "station_ref": result["site_ref"],
                    "year": result["year"],
                    "day": f"{int(result['year'])}-01-01",
                    "source_file_key": result.get("source_file_key"),
                    "event_id": result.get("event_id"),
                    "event_type": result.get("event_type"),
                    "timeseries_ids": result.get("timeseries_ids"),
                })
            elif outcome == "changed":
                metrics["changed"] += 1
                metrics["changed_files"].append({
                    "site_ref": result["site_ref"],
                    "station_ref": result["site_ref"],
                    "year": result["year"],
                    "day": f"{int(result['year'])}-01-01",
                    "source_file_key": result.get("source_file_key"),
                    "event_id": result.get("event_id"),
                    "event_type": result.get("event_type"),
                    "timeseries_ids": result.get("timeseries_ids"),
                })
            elif outcome == "unchanged":
                metrics["unchanged"] += 1
                if bool(result.get("cache_reused")):
                    metrics["unchanged_cached"] += 1
                else:
                    metrics["unchanged_after_download"] += 1
            elif outcome in {"not_found_first_seen", "not_found_after_seen", "not_found_still"}:
                metrics["missing"] += 1
            elif outcome == "temporary_error":
                metrics["temporary_errors"] += 1
                metrics["errors"] += 1
            elif outcome == "permanent_error":
                metrics["permanent_errors"] += 1
                metrics["errors"] += 1
            else:
                metrics["errors"] += 1

            metrics["errors"] += int(result.get("unmapped_source_groups") or 0)
            metrics["errors"] += int(result.get("ambiguous_mapping_groups") or 0)

            progress.update(
                (
                    f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
                    f"downloaded={metrics['downloaded']} cached={metrics['cache_reused']} "
                    f"mapped_rows={metrics['rows_counted']} "
                    f"missing={metrics['missing']} errors={metrics['errors']} "
                    f"planned_backfills=0"
                ),
            )

    progress.update(
        (
            f"{completed_tasks}/{total_tasks} checked={metrics['head_checked']} "
            f"downloaded={metrics['downloaded']} cached={metrics['cache_reused']} "
            f"mapped_rows={metrics['rows_counted']} "
            f"missing={metrics['missing']} errors={metrics['errors']} planned_backfills=0"
        ),
        force=True,
    )
    progress.finish()

    metrics["first_seen_files"].sort(key=lambda e: (e["year"], e["site_ref"]))
    metrics["changed_files"].sort(key=lambda e: (e["year"], e["site_ref"]))
    metrics["actionable_mapping_issues"].sort(
        key=lambda issue: (
            str(issue.get("day_utc") or ""),
            str(issue.get("site_ref") or ""),
            str(issue.get("pollutant_code") or ""),
        )
    )
    for issue in metrics["actionable_mapping_issues"]:
        log.warning(
            "sos flat-file mapping issue %s",
            json.dumps({"event": "sos_flat_file_mapping_issue", **issue}, sort_keys=True),
        )

    if limits.should_stop():
        metrics["stopped_for"] = limits.stopped_for
        log.warning("sos flat-file: stopped early due to limit=%s", limits.stopped_for)

    log.info(
        "sos flat-file: done %s",
        {
            k: v
            for k, v in metrics.items()
            if k not in ("first_seen_files", "changed_files", "sample_urls")
        },
    )
    return metrics


def check_sos(
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
    history_version: str = "v1",
) -> dict[str, Any]:
    return check_sos_flat_files(
        conn=conn,
        env_name=env_name,
        env=env,
        from_day=from_day,
        to_day=to_day,
        dry_run=dry_run,
        run_backfill=run_backfill,
        limits=limits,
        log=log,
        concurrency=concurrency,
        history_version=history_version,
    )

    # The former SOS API implementation below is unreachable. It remains only
    # as dead code pending a separate mechanical deletion from this large file.
    source_mode = "sos_api"
    metrics: dict[str, Any] = {
        "ran": False,
        "stopped_for": None,
        "source_mode": source_mode,
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
        "not_found_cooldown_seconds": _resolve_sos_not_found_cooldown_seconds(),
        "skipped_reason": None,
    }
    base_url = os.environ.get(
        "UK_AQ_BACKFILL_SOS_BASE_URL",
        SOS_DEFAULT_BASE_URL,
    )

    if not from_day or not to_day:
        metrics["skipped_reason"] = "from_day/to_day not set; manual profile requires both"
        log.warning("sos: skipped — %s", metrics["skipped_reason"])
        return metrics

    station_bindings = _sos_station_bindings(conn)
    stations = sorted(station_bindings.keys())
    if not stations:
        metrics["skipped_reason"] = "no sos active station/timeseries bindings in source_station_timeseries_lookup"
        log.warning("sos: skipped — %s", metrics["skipped_reason"])
        return metrics

    days = _date_range_inclusive(from_day, to_day)
    if not days:
        metrics["skipped_reason"] = f"empty date range {from_day}..{to_day}"
        log.warning("sos: skipped — %s", metrics["skipped_reason"])
        return metrics

    metrics["stations"] = len(stations)
    metrics["days"] = len(days)
    metrics["stations_checked"] = len(stations)
    metrics["ran"] = True

    log.info(
        "sos: starting stations=%s days=%s base_url=%s keep_api_snapshots=%s not_found_cooldown_seconds=%s%s",
        len(stations),
        len(days),
        base_url,
        metrics["keep_api_snapshots_policy"],
        metrics["not_found_cooldown_seconds"],
        " (dry-run)" if dry_run else "",
    )
    if run_backfill:
        log.info("sos: direct backfill is disabled in Phase 7.3 (cross-check-driven repair only)")

    if dry_run:
        sample = []
        for station in stations[:3]:
            for day in days[:2]:
                sample.append(_sos_remote_key(base_url, station, day))
        metrics["sample_urls"] = sample
        log.info(
            "sos dry-run: would check %s station/day units; sample=%s",
            len(stations) * len(days),
            sample[:6],
        )
        return metrics

    cache_root = Path(env["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"]) / SOS_SOURCE_KEY
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
                    _check_one_sos_station_day_threadsafe,
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
        progress = SingleLineProgress("sos progress")
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
                log.warning("sos worker raised: %s", exc)
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
            if snapshot_status in {SOS_STATUS_OK, SOS_STATUS_NO_DATA}:
                metrics["snapshots_successful"] += 1
                if snapshot_status == SOS_STATUS_NO_DATA:
                    metrics["snapshots_no_data"] += 1
            elif snapshot_status == SOS_STATUS_NOT_FOUND:
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
        log.warning("sos: stopped early due to limit=%s", limits.stopped_for)

    log.info(
        "sos: done %s",
        {
            k: v
            for k, v in metrics.items()
            if k not in ("first_seen_files", "changed_files", "sample_urls")
        },
    )
    return metrics


R2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX = "history/_index/observations_timeseries"
R2_AQILEVELS_PREFIX = "history/v1/aqilevels/hourly"
R2_HISTORY_INDEX_PREFIX = "history/_index"
R2_HISTORY_OBSERVATIONS_PREFIX = "history/v1/observations"
R2_HISTORY_V2_INDEX_PREFIX = "history/_index_v2"
R2_HISTORY_V2_OBSERVATIONS_PREFIX = "history/v2/observations"
R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX = "history/v2/aqilevels/hourly/data"
R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX = "history/v2/aqilevels/hourly/debug"
R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX = (
    "history/_index_v2/observations_timeseries"
)
R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX = (
    "history/_index_v2/aqilevels_hourly_data_timeseries"
)
AQILEVELS_EXPECTED_HISTORY_SCHEMA_NAME = "aqilevels"
AQILEVELS_EXPECTED_HISTORY_SCHEMA_VERSION = 2
AQILEVELS_EXPECTED_WRITER_VERSION = "parquet-wasm-zstd-v2"
CROSS_CHECK_MAX_REPORT_DISCREPANCIES = 250

HISTORY_INTEGRITY_SCHEMA_VERSION = 2
HISTORY_VERSION_CHOICES = ("v1", "v2", "both")
LAST_BACKFILL_ENV_LOAD_RESULT: dict[str, Any] = {}
AQI_INTEGRITY_OBS_COVERAGE_REASON = "aqi_integrity_obs_coverage_gap"
V2_AQI_EXECUTABLE_OBS_COVERAGE_GAP_TYPES = {
    "aqi_manifest_missing_after_obs_repair",
    "aqi_manifest_missing_for_observations",
    "aqi_rows_below_observation_rows",
    "data_manifest_missing",
    "data_manifest_empty",
    "parquet_missing",
    "parquet_empty_or_placeholder",
    "row_count_mismatch",
    "pollutant_dir_missing",
}


@dataclass(frozen=True)
class HistoryPathConfig:
    history_version: Literal["v1", "v2"]
    observations_data_prefix: str
    aqilevels_hourly_data_prefix: str
    aqilevels_hourly_debug_prefix: str | None
    observations_timeseries_index_prefix: str
    aqilevels_timeseries_index_prefix: str
    observations_latest_index_key: str
    aqilevels_latest_index_key: str
    observations_partition_levels: tuple[str, ...]
    aqilevels_partition_levels: tuple[str, ...]
    checks_implemented: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "history_version": self.history_version,
            "observations_data_prefix": self.observations_data_prefix,
            "aqilevels_hourly_data_prefix": self.aqilevels_hourly_data_prefix,
            "aqilevels_hourly_debug_prefix": self.aqilevels_hourly_debug_prefix,
            "observations_timeseries_index_prefix": self.observations_timeseries_index_prefix,
            "aqilevels_timeseries_index_prefix": self.aqilevels_timeseries_index_prefix,
            "observations_latest_index_key": self.observations_latest_index_key,
            "aqilevels_latest_index_key": self.aqilevels_latest_index_key,
            "observations_partition_levels": list(self.observations_partition_levels),
            "aqilevels_partition_levels": list(self.aqilevels_partition_levels),
            "checks_implemented": self.checks_implemented,
        }

def _normalize_history_prefix(value: str | None, default: str) -> str:
    raw = str(value if value is not None else default).strip().strip("/")
    return raw or default.strip("/")


def _append_json_name(prefix: str, name: str) -> str:
    return f"{prefix.strip('/')}/{name}"


def resolve_history_version_mode(args: argparse.Namespace | None = None) -> str:
    raw = ""
    if args is not None:
        raw = str(getattr(args, "history_version", "") or "").strip().lower()
    if not raw:
        raw = str(os.environ.get("UK_AQ_R2_HISTORY_INTEGRITY_VERSION", "v1")).strip().lower()
    if raw not in HISTORY_VERSION_CHOICES:
        raise ValueError(
            "history version must be one of "
            f"{', '.join(HISTORY_VERSION_CHOICES)} (got {raw!r})"
        )
    return raw


def expand_history_versions(history_version_mode: str) -> list[str]:
    if history_version_mode == "both":
        return ["v1", "v2"]
    if history_version_mode in {"v1", "v2"}:
        return [history_version_mode]
    raise ValueError(
        "history version must be one of "
        f"{', '.join(HISTORY_VERSION_CHOICES)} (got {history_version_mode!r})"
    )


def resolve_history_path_config(
    history_version: str,
    env: Mapping[str, str] | None = None,
) -> HistoryPathConfig:
    values = os.environ if env is None else env
    if history_version == "v1":
        index_prefix = _normalize_history_prefix(
            values.get("UK_AQ_R2_HISTORY_INDEX_PREFIX"),
            R2_HISTORY_INDEX_PREFIX,
        )
        observations_index_prefix = _normalize_history_prefix(
            values.get("UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX"),
            f"{index_prefix}/observations_timeseries",
        )
        aqilevels_index_prefix = _normalize_history_prefix(
            values.get("UK_AQ_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX"),
            f"{index_prefix}/aqilevels_timeseries",
        )
        return HistoryPathConfig(
            history_version="v1",
            observations_data_prefix=_normalize_history_prefix(
                values.get("UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX"),
                R2_HISTORY_OBSERVATIONS_PREFIX,
            ),
            aqilevels_hourly_data_prefix=_normalize_history_prefix(
                values.get("UK_AQ_R2_HISTORY_AQILEVELS_PREFIX"),
                R2_AQILEVELS_PREFIX,
            ),
            aqilevels_hourly_debug_prefix=None,
            observations_timeseries_index_prefix=observations_index_prefix,
            aqilevels_timeseries_index_prefix=aqilevels_index_prefix,
            observations_latest_index_key=_append_json_name(
                index_prefix,
                "observations_timeseries_latest.json",
            ),
            aqilevels_latest_index_key=_append_json_name(
                index_prefix,
                "aqilevels_timeseries_latest.json",
            ),
            observations_partition_levels=("day_utc", "connector_id"),
            aqilevels_partition_levels=("day_utc", "connector_id"),
            checks_implemented=True,
        )
    if history_version == "v2":
        index_prefix = _normalize_history_prefix(
            values.get("UK_AQ_R2_HISTORY_INDEX_V2_PREFIX"),
            R2_HISTORY_V2_INDEX_PREFIX,
        )
        observations_index_prefix = _normalize_history_prefix(
            values.get("UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX"),
            f"{index_prefix}/observations_timeseries",
        )
        aqilevels_index_prefix = _normalize_history_prefix(
            values.get("UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX"),
            f"{index_prefix}/aqilevels_hourly_data_timeseries",
        )
        return HistoryPathConfig(
            history_version="v2",
            observations_data_prefix=_normalize_history_prefix(
                values.get("UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX"),
                R2_HISTORY_V2_OBSERVATIONS_PREFIX,
            ),
            aqilevels_hourly_data_prefix=_normalize_history_prefix(
                values.get("UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX"),
                R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX,
            ),
            aqilevels_hourly_debug_prefix=_normalize_history_prefix(
                values.get("UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX"),
                R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX,
            ),
            observations_timeseries_index_prefix=observations_index_prefix,
            aqilevels_timeseries_index_prefix=aqilevels_index_prefix,
            observations_latest_index_key=_append_json_name(
                index_prefix,
                "observations_timeseries_latest.json",
            ),
            aqilevels_latest_index_key=_append_json_name(
                index_prefix,
                "aqilevels_hourly_data_timeseries_latest.json",
            ),
            observations_partition_levels=("day_utc", "connector_id", "pollutant_code"),
            aqilevels_partition_levels=("day_utc", "connector_id", "pollutant_code"),
            checks_implemented=True,
        )
    raise ValueError(f"unsupported history version: {history_version!r}")


def resolve_history_path_configs(
    history_version_mode: str,
    env: Mapping[str, str] | None = None,
) -> dict[str, HistoryPathConfig]:
    return {
        version: resolve_history_path_config(version, env)
        for version in expand_history_versions(history_version_mode)
    }


def serialize_history_path_configs(
    configs: Mapping[str, HistoryPathConfig],
) -> dict[str, dict[str, Any]]:
    return {version: config.to_dict() for version, config in sorted(configs.items())}




def _connector_dir_allowed(dirname: str, allowed_connector_ids: set[int]) -> bool:
    if not dirname.startswith("connector_id="):
        return False
    raw = dirname.split("=", 1)[1]
    try:
        return int(raw) in allowed_connector_ids
    except (TypeError, ValueError):
        return False


def _expected_connector_ids(allowed_connector_ids: set[int] | None) -> list[int]:
    if allowed_connector_ids is None:
        return []
    return sorted({int(cid) for cid in allowed_connector_ids if int(cid) > 0})


def _connector_id_from_dirname(dirname: str) -> int | None:
    if not dirname.startswith("connector_id="):
        return None
    raw = dirname.split("=", 1)[1]
    try:
        cid = int(raw)
    except (TypeError, ValueError):
        return None
    return cid if cid > 0 else None


def resolve_v2_source_scope(
    conn: sqlite3.Connection,
    source_filter: str,
) -> tuple[set[int] | None, dict[str, Any]]:
    source = str(source_filter or "all").strip() or "all"
    if source == "all":
        return None, {"source": "all", "connector_ids": None, "scope": "all"}
    rows = conn.execute(
        """
        SELECT DISTINCT connector_id
        FROM source_station_timeseries_lookup
        WHERE source_key = ?
          AND connector_id IS NOT NULL
        ORDER BY connector_id
        """,
        (source,),
    ).fetchall()
    connector_ids = sorted({int(row[0]) for row in rows if row[0] is not None})
    if not connector_ids:
        raise RuntimeError(
            "v2 source-specific integrity checks could not resolve any connector_id "
            f"for source={source!r} from the imported core snapshot lookup"
        )
    return set(connector_ids), {"source": source, "connector_ids": connector_ids, "scope": "source"}


def _v2_obs_gap(
    gap_type: str,
    *,
    day_utc: str | None = None,
    connector_id: int | str | None = None,
    pollutant_code: str | None = None,
    expected_path: str | None = None,
    related_paths: list[str] | None = None,
    severity: str = "error",
) -> dict[str, Any]:
    cid: int | str | None = connector_id
    if cid is not None:
        try:
            cid = int(str(cid))
        except (TypeError, ValueError):
            # Some gap records may use non-numeric connector identifiers; keep the
            # original value so the report still identifies the partition.
            cid = connector_id
    return {
        "history_version": "v2",
        "domain": "observations",
        "severity": severity,
        "gap_type": gap_type,
        "day_utc": day_utc,
        "connector_id": cid,
        "pollutant_code": pollutant_code,
        "expected_path": expected_path,
        "related_paths": list(related_paths or []),
        "source_evidence": {
            "v1_present": None,
            "source_counts_present": None,
            "db_dump_present": None,
        },
        "suggested_repair": {
            "kind": "repair_plan_unclassified",
            "requires_index_rebuild": False,
            "commands": [],
            "notes": "Repair planning did not classify this v2 observations finding.",
        },
    }


def _repair_day_connector_args(day_utc: str | None, connector_id: int | str | None) -> list[str]:
    args: list[str] = []
    if day_utc:
        args.extend(["--from-day", day_utc, "--to-day", day_utc])
    if connector_id is not None:
        args.extend(["--connector-ids", str(connector_id)])
    return args


def _local_v2_observations_evidence(
    root: Path,
    config: HistoryPathConfig,
    *,
    day_utc: str | None,
    connector_id: int | str | None,
    pollutant_code: str | None,
) -> tuple[bool | None, list[str]]:
    if not day_utc:
        return None, []
    base = root / config.observations_data_prefix.strip("/") / f"day_utc={day_utc}"
    if connector_id is not None:
        base = base / f"connector_id={connector_id}"
    if pollutant_code:
        base = base / f"pollutant_code={pollutant_code}"
    if not base.exists():
        return False, [str(base.relative_to(root))]
    return True, [str(base.relative_to(root))]


def _enrich_v2_observations_repair_plans(
    *,
    root: Path,
    gaps: list[dict[str, Any]],
    source_scope: Mapping[str, Any] | None = None,
) -> None:
    source_name = str((source_scope or {}).get("source") or "").strip().lower()
    sos_scope = source_name == "sos"
    index_gap_types = {
        "connector_manifest_invalid_json",
        "connector_manifest_pollutant_codes_missing_child",
        "connector_manifest_pollutant_codes_stale_child",
        "connector_manifest_child_manifests_missing_child",
        "connector_manifest_child_manifests_stale_child",
        "connector_manifest_pollutant_manifests_missing_child",
        "connector_manifest_pollutant_manifests_stale_child",
        "connector_manifest_files_missing_child",
        "connector_manifest_files_stale_child",
        "day_manifest_invalid_json",
        "day_manifest_connector_ids_missing_child",
        "day_manifest_connector_ids_stale_child",
        "day_manifest_child_manifests_missing_child",
        "day_manifest_child_manifests_stale_child",
        "day_manifest_connector_manifests_missing_child",
        "day_manifest_connector_manifests_stale_child",
        "day_manifest_files_missing_child",
        "day_manifest_files_stale_child",
        "index_day_dir_missing",
        "index_connector_dir_missing",
        "index_pollutant_dir_missing",
        "index_manifest_missing",
        "index_manifest_invalid_json",
        "index_manifest_missing_timeseries_counts",
        "index_manifest_empty_timeseries_counts",
        "latest_index_missing",
        "latest_index_invalid_json",
        "latest_index_stale_or_incomplete",
    }
    data_gap_types = {
        "day_dir_missing",
        "connector_dir_missing",
        "pollutant_dir_missing",
        "data_manifest_missing",
        "data_manifest_invalid_json",
        "data_manifest_schema_mismatch",
        "data_manifest_empty",
        "data_manifest_file_count_mismatch",
        "data_manifest_listed_parquet_missing",
        "data_manifest_unlisted_parquet",
        "data_manifest_duplicate_file_key",
        "data_manifest_timeseries_row_count_mismatch",
        "data_manifest_total_bytes_mismatch",
        "data_manifest_empty_timeseries_counts",
        "parquet_null_timeseries_id_rows",
        "data_partition_zero_rows",
        "parquet_missing",
        "parquet_empty_or_placeholder",
        "parquet_unreadable",
        "row_count_mismatch",
        "data_manifest_row_count_mismatch",
        "source_r2_timeseries_row_mismatch",
        "pollutant_missing",
        "orphan_parquet_without_manifest",
        "missing_pollutant_partitions",
        "unexpected_connector_level_part_file",
    }
    for gap in gaps:
        gap_type = str(gap.get("gap_type") or "")
        day_utc = gap.get("day_utc")
        connector_id = gap.get("connector_id")
        if gap.get("fault_class") == "pollutant manifest-only fault":
            gap["suggested_repair"] = {
                "kind": "observation_pollutant_manifest_repair",
                "requires_index_rebuild": True,
                "commands": [],
                "executes": False,
                "steps": ["Rebuild the pollutant manifest from the readable parquet files."],
                "notes": "The parquet content is readable; do not rewrite observation data.",
            }
            continue
        if gap_type.startswith("connector_manifest_"):
            gap["suggested_repair"] = {
                "kind": "observation_connector_manifest_repair",
                "requires_index_rebuild": True,
                "commands": [],
                "steps": [
                    "Rebuild the connector manifest from the live pollutant child manifests.",
                    "Keep any sibling pollutant partitions that are already present.",
                ],
                "notes": "Connector-level hierarchy gaps are repairable by rebuilding the parent manifest only.",
            }
            continue
        if gap_type.startswith("day_manifest_"):
            gap["suggested_repair"] = {
                "kind": "observation_day_manifest_repair",
                "requires_index_rebuild": True,
                "commands": [],
                "steps": [
                    "Rebuild the day manifest from the live connector child manifests.",
                    "Keep any sibling connector partitions that are already present.",
                ],
                "notes": "Day-level hierarchy gaps are repairable by rebuilding the parent manifest only.",
            }
            continue
        if gap_type in index_gap_types:
            gap["suggested_repair"] = {
                "kind": "rebuild_v2_observations_index_only",
                "requires_index_rebuild": True,
                "commands": [],
                "steps": [
                    "Confirm the v2 observations data partition exists for the finding.",
                    "Rebuild only the v2 observations _index_v2 timeseries manifest for the affected day/connector/pollutant.",
                ],
                "notes": (
                    "No exact _index_v2 rebuild command is emitted because the index rebuild "
                    "command contract remains unresolved."
                ),
            }
        elif gap_type in data_gap_types:
            gap["suggested_repair"] = {
                "kind": (
                    "observation_pollutant_manifest_repair"
                    if gap_type in {
                        "data_manifest_file_count_mismatch",
                        "data_manifest_listed_parquet_missing",
                        "data_manifest_unlisted_parquet",
                        "data_manifest_duplicate_file_key",
                        "data_manifest_timeseries_row_count_mismatch",
                        "data_manifest_total_bytes_mismatch",
                    }
                    else (
                        "uk_air_csv_to_v2_observations_backfill_required"
                        if sos_scope
                        else "source_to_v2_observations_backfill_required"
                    )
                ),
                "requires_index_rebuild": True,
                "commands": [],
                "executes": False,
                "operator_action_required": False,
                "write_risk": "writes_to_r2_when_run_backfill_is_enabled",
                "steps": [
                    (
                        "Use the cached annual UK-AIR CSV as the SOS observation source."
                        if sos_scope
                        else (
                            "Repair the pollutant manifest so it matches the live parquet set and row counts."
                            if gap_type in {
                                "data_manifest_file_count_mismatch",
                                "data_manifest_listed_parquet_missing",
                                "data_manifest_unlisted_parquet",
                                "data_manifest_duplicate_file_key",
                                "data_manifest_timeseries_row_count_mismatch",
                                "data_manifest_total_bytes_mismatch",
                            }
                            else "Use the current connector source cache as the observation source."
                        )
                    ),
                    "Write the affected v2 observation partition through the existing source-to-R2 writer.",
                    "Rebuild the affected v2 observations _index_v2 manifests and verify source parity before AQI rebuild.",
                ],
                "notes": (
                    "The executable --run-backfill path reads the cached UK-AIR annual CSV "
                    "as the sole SOS historical observation source."
                    if sos_scope
                    else (
                        "Pollutant manifest gaps are repaired by rebuilding the manifest from live parquet files."
                        if gap_type in {
                            "data_manifest_file_count_mismatch",
                            "data_manifest_listed_parquet_missing",
                            "data_manifest_unlisted_parquet",
                            "data_manifest_duplicate_file_key",
                            "data_manifest_timeseries_row_count_mismatch",
                            "data_manifest_total_bytes_mismatch",
                        }
                        else "The executable --run-backfill path uses the current connector source adapter."
                    )
                ),
            }


def _manifest_codes_from_child_list(payload: Mapping[str, Any], field: str, id_key: str) -> set[str]:
    raw_children = payload.get(field)
    if not isinstance(raw_children, list):
        return set()
    out: set[str] = set()
    for child in raw_children:
        if not isinstance(child, dict):
            continue
        value = str(child.get(id_key) or "").strip()
        if value:
            out.add(value)
    return out


def _manifest_codes_from_scalar_list(payload: Mapping[str, Any], field: str) -> set[str]:
    raw = payload.get(field)
    if not isinstance(raw, list):
        return set()
    return {str(value).strip() for value in raw if str(value or "").strip()}


def _manifest_pollutant_codes_from_files(payload: Mapping[str, Any]) -> set[str]:
    out: set[str] = set()
    for entry in _manifest_files(payload):
        if not isinstance(entry, dict):
            continue
        code = str(entry.get("pollutant_code") or "").strip()
        if code:
            out.add(code)
        for value in entry.get("pollutant_codes") or []:
            code = str(value or "").strip()
            if code:
                out.add(code)
        key = str(entry.get("key") or "").strip()
        match = re.search(r"/pollutant_code=([^/]+)/", key)
        if match:
            out.add(match.group(1))
    return out


def _manifest_connector_ids_from_files(payload: Mapping[str, Any]) -> set[str]:
    out: set[str] = set()
    for entry in _manifest_files(payload):
        if not isinstance(entry, dict):
            continue
        value = str(entry.get("connector_id") or "").strip()
        if value:
            out.add(value)
        for raw in entry.get("connector_ids") or []:
            value = str(raw or "").strip()
            if value:
                out.add(value)
        key = str(entry.get("key") or "").strip()
        match = re.search(r"/connector_id=([^/]+)/", key)
        if match:
            out.add(match.group(1))
    return out


def _append_field_set_gaps(
    gaps: list[dict[str, Any]],
    *,
    domain: str,
    field_label: str,
    actual: set[str],
    represented: set[str],
    day_utc: str,
    connector_id: int | str | None = None,
    expected_path: str,
    child_key: str,
) -> None:
    gap_fn = _v2_aqi_gap if domain == "aqilevels" else _v2_obs_gap
    missing = sorted(actual - represented)
    stale = sorted(represented - actual)
    if missing:
        kwargs: dict[str, Any] = {
            "day_utc": day_utc,
            "connector_id": connector_id,
            "expected_path": expected_path,
            "related_paths": [f"{child_key}={value}" for value in missing],
        }
        gaps.append(gap_fn(f"{field_label}_missing_child", **kwargs))
    if stale:
        kwargs = {
            "day_utc": day_utc,
            "connector_id": connector_id,
            "expected_path": expected_path,
            "related_paths": [f"{child_key}={value}" for value in stale],
        }
        gaps.append(gap_fn(f"{field_label}_stale_child", **kwargs))


def _validate_v2_parent_hierarchy(
    *,
    root: Path,
    data_prefix: str,
    day_utc: str,
    connector_dir: Path | None,
    day_dir: Path,
    gaps: list[dict[str, Any]],
    domain: str,
) -> None:
    """Validate connector/day parent representations against live child manifests."""
    gap_fn = _v2_aqi_gap if domain == "aqilevels" else _v2_obs_gap
    if connector_dir is not None:
        connector_raw = connector_dir.name.split("=", 1)[1]
        connector_rel = f"{data_prefix}/day_utc={day_utc}/{connector_dir.name}/manifest.json"
        connector_manifest = root / connector_rel
        child_payloads: dict[str, Mapping[str, Any]] = {}
        for pollutant_dir in sorted(p for p in connector_dir.glob("pollutant_code=*") if p.is_dir()):
            child_path = pollutant_dir / "manifest.json"
            if not child_path.is_file():
                continue
            child_payload, child_err = _load_json_file(child_path)
            if not child_err and isinstance(child_payload, Mapping):
                child_payloads[pollutant_dir.name.split("=", 1)[1]] = child_payload
        actual_pollutants = set(child_payloads)
        if not connector_manifest.is_file():
            gaps.append(gap_fn(
                "connector_manifest_missing",
                day_utc=day_utc,
                connector_id=connector_raw,
                expected_path=connector_rel,
            ))
            return
        payload, err = _load_json_file(connector_manifest)
        if err or not isinstance(payload, dict):
            gaps.append(gap_fn(
                "connector_manifest_invalid_json",
                day_utc=day_utc,
                connector_id=connector_raw,
                expected_path=connector_rel,
            ))
            return
        expected_profile = "data" if domain == "aqilevels" else None
        expected_grain = "hourly" if domain == "aqilevels" else None
        schema_mismatches = [
            field for field, expected in (
                ("manifest_kind", "connector"),
                ("history_version", "v2"),
                ("domain", domain),
                ("grain", expected_grain),
                ("profile", expected_profile),
                ("day_utc", day_utc),
                ("connector_id", str(connector_raw)),
            )
            if field not in payload or str(payload.get(field)) != str(expected)
        ]
        connector_files = _manifest_files_list(payload)
        connector_files_valid = connector_files is not None
        if not connector_files_valid:
            schema_mismatches.append("files")
            connector_files = []
        if schema_mismatches:
            gaps.append(gap_fn(
                "connector_manifest_schema_mismatch",
                day_utc=day_utc,
                connector_id=connector_raw,
                expected_path=connector_rel,
                related_paths=schema_mismatches,
            ))
        representations = {
            "connector_manifest_pollutant_codes": _manifest_codes_from_scalar_list(payload, "pollutant_codes"),
            "connector_manifest_child_manifests": _manifest_codes_from_child_list(payload, "child_manifests", "pollutant_code"),
            "connector_manifest_pollutant_manifests": _manifest_codes_from_child_list(payload, "pollutant_manifests", "pollutant_code"),
        }
        if connector_files_valid:
            representations["connector_manifest_files"] = _manifest_pollutant_codes_from_files(payload)
        for label, represented in representations.items():
            _append_field_set_gaps(
                gaps,
                domain=domain,
                field_label=label,
                actual=actual_pollutants,
                represented=represented,
                day_utc=day_utc,
                connector_id=connector_raw,
                expected_path=connector_rel,
                child_key="pollutant_code",
            )
        _append_parent_aggregate_gaps(
            gaps,
            domain=domain,
            level="connector",
            payload=payload,
            child_payloads=child_payloads.values(),
            day_utc=day_utc,
            connector_id=connector_raw,
            expected_path=connector_rel,
            manifest_files=connector_files,
            files_valid=connector_files_valid,
        )
        _append_child_hash_gaps(
            gaps,
            domain=domain,
            level="connector",
            child_manifest_level="data",
            child_id_key="pollutant_code",
            representations=(
                ("child_manifests", payload.get("child_manifests"), "pollutant_code"),
                ("pollutant_manifests", payload.get("pollutant_manifests"), "pollutant_code"),
            ),
            actual_hashes={key: _manifest_hash_text(value) for key, value in child_payloads.items()},
            day_utc=day_utc,
            connector_id=connector_raw,
            expected_path=connector_rel,
        )
    if connector_dir is not None:
        return

    day_rel = f"{data_prefix}/day_utc={day_utc}/manifest.json"
    day_manifest = root / day_rel
    child_payloads: dict[str, Mapping[str, Any]] = {}
    for connector_child_dir in sorted(p for p in day_dir.glob("connector_id=*") if p.is_dir()):
        child_path = connector_child_dir / "manifest.json"
        if not child_path.is_file():
            continue
        child_payload, child_err = _load_json_file(child_path)
        if not child_err and isinstance(child_payload, Mapping):
            child_payloads[connector_child_dir.name.split("=", 1)[1]] = child_payload
    actual_connectors = set(child_payloads)
    if not day_manifest.is_file():
        gaps.append(gap_fn("day_manifest_missing", day_utc=day_utc, expected_path=day_rel))
        return
    payload, err = _load_json_file(day_manifest)
    if err or not isinstance(payload, dict):
        gaps.append(gap_fn("day_manifest_invalid_json", day_utc=day_utc, expected_path=day_rel))
        return
    expected_profile = "data" if domain == "aqilevels" else None
    expected_grain = "hourly" if domain == "aqilevels" else None
    schema_mismatches = [
        field for field, expected in (
            ("manifest_kind", "day"),
            ("history_version", "v2"),
            ("domain", domain),
            ("grain", expected_grain),
            ("profile", expected_profile),
            ("day_utc", day_utc),
        )
        if field not in payload or str(payload.get(field)) != str(expected)
    ]
    day_files = _manifest_files_list(payload)
    day_files_valid = day_files is not None
    if not day_files_valid:
        schema_mismatches.append("files")
        day_files = []
    if schema_mismatches:
        gaps.append(gap_fn(
            "day_manifest_schema_mismatch",
            day_utc=day_utc,
            expected_path=day_rel,
            related_paths=schema_mismatches,
        ))
    representations = {
        "day_manifest_connector_ids": _manifest_codes_from_scalar_list(payload, "connector_ids"),
        "day_manifest_child_manifests": _manifest_codes_from_child_list(payload, "child_manifests", "connector_id"),
        "day_manifest_connector_manifests": _manifest_codes_from_child_list(payload, "connector_manifests", "connector_id"),
    }
    if day_files_valid:
        representations["day_manifest_files"] = _manifest_connector_ids_from_files(payload)
    for label, represented in representations.items():
        _append_field_set_gaps(
            gaps,
            domain=domain,
            field_label=label,
            actual=actual_connectors,
            represented=represented,
            day_utc=day_utc,
            expected_path=day_rel,
            child_key="connector_id",
        )
    _append_parent_aggregate_gaps(
        gaps,
        domain=domain,
        level="day",
        payload=payload,
        child_payloads=child_payloads.values(),
        day_utc=day_utc,
        connector_id=None,
        expected_path=day_rel,
        manifest_files=day_files,
        files_valid=day_files_valid,
    )
    _append_child_hash_gaps(
        gaps,
        domain=domain,
        level="day",
        child_manifest_level="connector",
        child_id_key="connector_id",
        representations=(
            ("child_manifests", payload.get("child_manifests"), "connector_id"),
            ("connector_manifests", payload.get("connector_manifests"), "connector_id"),
        ),
        actual_hashes={key: _manifest_hash_text(value) for key, value in child_payloads.items()},
        day_utc=day_utc,
        connector_id=None,
        expected_path=day_rel,
    )


def _manifest_files(payload: Any) -> list[dict[str, Any]]:
    files = payload.get("files") if isinstance(payload, dict) else None
    return files if isinstance(files, list) else []


def _manifest_files_list(payload: Any) -> list[Any] | None:
    files = payload.get("files") if isinstance(payload, Mapping) else None
    return files if isinstance(files, list) else None


def _manifest_hash_text(payload: Any) -> str | None:
    if not isinstance(payload, Mapping):
        return None
    value = payload.get("manifest_hash")
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _parse_required_timestamp_value(value: Any) -> dt.datetime | None:
    if isinstance(value, dt.datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    if isinstance(value, str):
        return _parse_iso_utc(value)
    return None


def _read_parquet_partition_stats(files: Iterable[Path]) -> tuple[dict[str, Any] | None, str | None]:
    """Read actual local parquet content without trusting manifest metadata."""
    parquet_files = sorted({str(Path(path)) for path in files if Path(path).is_file()})
    if not parquet_files:
        return {
            "row_count": 0,
            "timeseries_row_counts": {},
            "null_timeseries_count": 0,
            "min_timeseries_id": None,
            "max_timeseries_id": None,
            "min_timestamp_utc": None,
            "max_timestamp_utc": None,
            "parquet_null_timeseries_id_rows": False,
        }, None
    if importlib.util.find_spec("duckdb") is None:
        return None, "duckdb_unavailable"

    import duckdb  # type: ignore[import-not-found]

    connection = duckdb.connect(database=":memory:")
    try:
        described = connection.execute(
            "DESCRIBE SELECT * FROM read_parquet(?, union_by_name=true)",
            [parquet_files],
        ).fetchall()
        columns = {str(row[0]) for row in described}
        if "timeseries_id" not in columns:
            return None, "timeseries_id_column_missing"

        def _duckdb_single_int(result: Any) -> int:
            if isinstance(result, tuple):
                result = result[0] if result else 0
            return int(result)

        # Get total row count and the non-null timeseries_id count separately.
        total_row_count_result = connection.execute(
            "SELECT COUNT(*) FROM read_parquet(?, union_by_name=true)",
            [parquet_files],
        ).fetchone()
        try:
            total_row_count = _duckdb_single_int(total_row_count_result)
        except (TypeError, ValueError):
            total_row_count = 0
        non_null_timeseries_count_result = connection.execute(
            "SELECT COUNT(timeseries_id) FROM read_parquet(?, union_by_name=true)",
            [parquet_files],
        ).fetchone()
        try:
            non_null_timeseries_count = _duckdb_single_int(non_null_timeseries_count_result)
        except (TypeError, ValueError):
            non_null_timeseries_count = 0

        # Get non-null timeseries_id rows and their counts
        rows = connection.execute(
            "SELECT CAST(timeseries_id AS BIGINT), COUNT(*) "
            "FROM read_parquet(?, union_by_name=true) "
            "WHERE timeseries_id IS NOT NULL GROUP BY 1 ORDER BY 1",
            [parquet_files],
        ).fetchall()
        counts = {int(timeseries_id): int(row_count) for timeseries_id, row_count in rows}

        # Calculate null timeseries_id count
        try:
            null_timeseries_count = max(0, total_row_count - non_null_timeseries_count)
        except (TypeError, ValueError):
            # If we can't calculate, assume no null timeseries_id rows.
            null_timeseries_count = 0

        # Get timestamp stats
        timestamp_column = next(
            (name for name in ("observed_at_utc", "observed_at", "timestamp_hour_utc") if name in columns),
            None,
        )
        min_timestamp = None
        max_timestamp = None
        if timestamp_column:
            min_timestamp, max_timestamp = connection.execute(
                f"SELECT CAST(MIN({timestamp_column}) AS VARCHAR), "
                f"CAST(MAX({timestamp_column}) AS VARCHAR) "
                "FROM read_parquet(?, union_by_name=true)",
                [parquet_files],
            ).fetchone()

        # Determine if we have null timeseries_id rows
        has_null_timeseries_id_rows = null_timeseries_count > 0
        return {
            "row_count": total_row_count,
            "non_null_timeseries_count": non_null_timeseries_count,
            "timeseries_row_counts": counts,
            "null_timeseries_count": null_timeseries_count,
            "min_timeseries_id": min(counts.keys()) if counts else None,
            "max_timeseries_id": max(counts.keys()) if counts else None,
            "min_timestamp_utc": str(min_timestamp) if min_timestamp is not None else None,
            "max_timestamp_utc": str(max_timestamp) if max_timestamp is not None else None,
            "parquet_null_timeseries_id_rows": has_null_timeseries_id_rows,
        }, None
    except Exception as exc:
        return None, f"{type(exc).__name__}:{exc}"
    finally:
        connection.close()


def _int_field(payload: Mapping[str, Any], field: str) -> int | None:
    value = payload.get(field)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


_MANIFEST_FIELD_UNSET = object()


def _append_required_int_field_gap(
    gaps: list[dict[str, Any]],
    *,
    gap_fn,
    gap_prefix: str,
    payload: Mapping[str, Any],
    field: str,
    day_utc: str,
    connector_id: int | str | None,
    expected_path: str,
    pollutant_code: str | None = None,
    expected_value: Any = _MANIFEST_FIELD_UNSET,
) -> int | None:
    field_present = field in payload
    actual_raw = payload.get(field)
    gap_kwargs: dict[str, Any] = {
        "day_utc": day_utc,
        "connector_id": connector_id,
        "expected_path": expected_path,
    }
    if pollutant_code is not None:
        gap_kwargs["pollutant_code"] = pollutant_code
    if not field_present:
        gaps.append(gap_fn(
            f"{gap_prefix}_{field}_schema_mismatch",
            **gap_kwargs,
            related_paths=[f"field={field} missing_or_invalid_type"],
        ))
        return None
    if actual_raw is None:
        if expected_value is None:
            return None
        gaps.append(gap_fn(
            f"{gap_prefix}_{field}_schema_mismatch",
            **gap_kwargs,
            related_paths=[f"field={field} missing_or_invalid_type"],
        ))
        return None
    if not isinstance(actual_raw, int) or isinstance(actual_raw, bool):
        gaps.append(gap_fn(
            f"{gap_prefix}_{field}_schema_mismatch",
            **gap_kwargs,
            related_paths=[f"field={field} missing_or_invalid_type"],
        ))
        return None
    actual = int(actual_raw)
    if expected_value is not _MANIFEST_FIELD_UNSET and actual != expected_value:
        gaps.append(gap_fn(
            f"{gap_prefix}_{field}_mismatch",
            **gap_kwargs,
            related_paths=[f"manifest_{field}={actual} expected_{field}={expected_value}"],
        ))
    return actual


def _append_required_timestamp_field_gap(
    gaps: list[dict[str, Any]],
    *,
    gap_fn,
    gap_prefix: str,
    payload: Mapping[str, Any],
    field: str,
    day_utc: str,
    connector_id: int | str | None,
    expected_path: str,
    pollutant_code: str | None = None,
    expected_value: Any = _MANIFEST_FIELD_UNSET,
) -> str | None:
    field_present = field in payload
    actual_raw = payload.get(field)
    gap_kwargs: dict[str, Any] = {
        "day_utc": day_utc,
        "connector_id": connector_id,
        "expected_path": expected_path,
    }
    if pollutant_code is not None:
        gap_kwargs["pollutant_code"] = pollutant_code
    if not field_present:
        gaps.append(gap_fn(
            f"{gap_prefix}_{field}_schema_mismatch",
            **gap_kwargs,
            related_paths=[f"field={field} missing_or_invalid_type"],
        ))
        return None
    if actual_raw is None:
        if expected_value is None:
            return None
        gaps.append(gap_fn(
            f"{gap_prefix}_{field}_schema_mismatch",
            **gap_kwargs,
            related_paths=[f"field={field} missing_or_invalid_type"],
        ))
        return None
    actual = _parse_required_timestamp_value(actual_raw)
    if actual is None:
        gaps.append(gap_fn(
            f"{gap_prefix}_{field}_schema_mismatch",
            **gap_kwargs,
            related_paths=[f"field={field} missing_or_invalid_type"],
        ))
        return None
    if expected_value is not _MANIFEST_FIELD_UNSET:
        expected = _parse_required_timestamp_value(expected_value)
        if expected is None and expected_value is not None:
            gaps.append(gap_fn(
                f"{gap_prefix}_{field}_schema_mismatch",
                **gap_kwargs,
                related_paths=[f"field={field} missing_or_invalid_type"],
            ))
            return None
        if expected != actual:
            gaps.append(gap_fn(
                f"{gap_prefix}_{field}_mismatch",
                **gap_kwargs,
                related_paths=[f"manifest_{field}={actual_raw} expected_{field}={expected_value}"],
            ))
    return actual_raw if isinstance(actual_raw, str) else None


def _manifest_file_keys_from_entries(entries: Iterable[Any]) -> set[str]:
    return {
        str(entry.get("key") or "").strip().lstrip("/")
        for entry in entries
        if isinstance(entry, Mapping) and str(entry.get("key") or "").strip()
    }


def _manifest_file_keys(payload: Mapping[str, Any]) -> set[str]:
    return _manifest_file_keys_from_entries(_manifest_files(payload))


def _child_manifest_aggregate(payloads: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    children = list(payloads)
    numeric_sums = {
        field: sum(_int_field(child, field) or 0 for child in children)
        for field in ("row_count", "source_row_count", "file_count", "total_bytes")
    }
    min_ids = [int(child["min_timeseries_id"]) for child in children if _is_positive_int(child.get("min_timeseries_id"))]
    max_ids = [int(child["max_timeseries_id"]) for child in children if _is_positive_int(child.get("max_timeseries_id"))]
    min_times = [
        _parse_required_timestamp_value(child.get("min_observed_at_utc") or child.get("min_timestamp_hour_utc"))
        for child in children
    ]
    max_times = [
        _parse_required_timestamp_value(child.get("max_observed_at_utc") or child.get("max_timestamp_hour_utc"))
        for child in children
    ]
    return {
        **numeric_sums,
        "min_timeseries_id": min(min_ids) if min_ids else None,
        "max_timeseries_id": max(max_ids) if max_ids else None,
        "min_timestamp_utc": min((value for value in min_times if value is not None), default=None),
        "max_timestamp_utc": max((value for value in max_times if value is not None), default=None),
        "file_keys": set().union(*(_manifest_file_keys(child) for child in children)) if children else set(),
    }


def _append_parent_aggregate_gaps(
    gaps: list[dict[str, Any]],
    *,
    domain: str,
    level: str,
    payload: Mapping[str, Any],
    child_payloads: Iterable[Mapping[str, Any]],
    day_utc: str,
    connector_id: int | str | None,
    expected_path: str,
    manifest_files: list[Any] | None = None,
    files_valid: bool = True,
) -> None:
    gap_fn = _v2_aqi_gap if domain == "aqilevels" else _v2_obs_gap
    aggregate = _child_manifest_aggregate(child_payloads)

    gap_prefix = f"{level}_manifest"
    required_int_fields = (
        ("row_count", aggregate["row_count"]),
        ("source_row_count", aggregate["source_row_count"]),
        ("file_count", aggregate["file_count"]),
        ("total_bytes", aggregate["total_bytes"]),
        ("min_timeseries_id", aggregate["min_timeseries_id"]),
        ("max_timeseries_id", aggregate["max_timeseries_id"]),
    )
    for field, expected_value in required_int_fields:
        _append_required_int_field_gap(
            gaps,
            gap_fn=gap_fn,
            gap_prefix=gap_prefix,
            payload=payload,
            field=field,
            day_utc=day_utc,
            connector_id=connector_id,
            expected_path=expected_path,
            expected_value=expected_value,
        )

    if domain == "observations":
        timestamp_fields = (
            ("min_observed_at_utc", "min_timestamp_utc"),
            ("max_observed_at_utc", "max_timestamp_utc"),
        )
    elif domain == "aqilevels":
        timestamp_fields = (
            ("min_timestamp_hour_utc", "min_timestamp_utc"),
            ("max_timestamp_hour_utc", "max_timestamp_utc"),
        )
    else:
        timestamp_fields = ()

    for field, aggregate_field in timestamp_fields:
        _append_required_timestamp_field_gap(
            gaps,
            gap_fn=gap_fn,
            gap_prefix=gap_prefix,
            payload=payload,
            field=field,
            day_utc=day_utc,
            connector_id=connector_id,
            expected_path=expected_path,
            expected_value=aggregate[aggregate_field],
        )
    if files_valid:
        parent_file_keys = _manifest_file_keys_from_entries(manifest_files or [])
        if parent_file_keys != aggregate["file_keys"]:
            gaps.append(gap_fn(
                f"{level}_manifest_parquet_keys_mismatch",
                day_utc=day_utc,
                connector_id=connector_id,
                expected_path=expected_path,
                related_paths=sorted(
                    [f"missing={key}" for key in aggregate["file_keys"] - parent_file_keys]
                    + [f"stale={key}" for key in parent_file_keys - aggregate["file_keys"]]
                ),
            ))


def _append_child_hash_gaps(
    gaps: list[dict[str, Any]],
    *,
    domain: str,
    level: str,
    child_manifest_level: str,
    child_id_key: str,
    representations: Iterable[tuple[str, Any, str]],
    actual_hashes: Mapping[str, str | None],
    day_utc: str,
    connector_id: int | str | None,
    expected_path: str,
) -> None:
    gap_fn = _v2_aqi_gap if domain == "aqilevels" else _v2_obs_gap
    child_hash_gap_type = f"{child_manifest_level}_manifest_manifest_hash_schema_mismatch"
    for field, raw_entries, id_key in representations:
        if not isinstance(raw_entries, list):
            continue
        for entry in raw_entries:
            if not isinstance(entry, Mapping):
                continue
            child_id = str(entry.get(id_key) or "").strip()
            represented_hash = _manifest_hash_text(entry)
            if represented_hash is None:
                gap = gap_fn(
                    f"{level}_manifest_{field}_manifest_hash_schema_mismatch",
                    day_utc=day_utc,
                    connector_id=connector_id,
                    expected_path=expected_path,
                    related_paths=[f"{id_key}={child_id}", "field=manifest_hash missing_or_invalid_type"],
                )
                if child_manifest_level == "data":
                    gap["parquet_readable"] = True
                gaps.append(gap)
                continue
            expected_hash = actual_hashes.get(child_id)
            if expected_hash is None:
                continue
            if expected_hash != represented_hash:
                gaps.append(gap_fn(
                    f"{level}_manifest_{field}_child_hash_mismatch",
                    day_utc=day_utc,
                    connector_id=connector_id,
                    expected_path=expected_path,
                    related_paths=[f"{id_key}={child_id}"],
                ))
    for child_id, actual_hash in actual_hashes.items():
        if actual_hash is not None:
            continue
        gap = gap_fn(
            child_hash_gap_type,
            day_utc=day_utc,
            connector_id=connector_id,
            expected_path=expected_path,
            related_paths=[f"{child_id_key}={child_id}", "field=manifest_hash missing_or_invalid_type"],
        )
        if child_manifest_level == "data":
            gap["parquet_readable"] = True
        gaps.append(gap)


def _rel_key_to_path(root: Path, key: str) -> Path | None:
    raw = str(key).strip().lstrip("/")
    if not raw:
        return None
    root_resolved = root.resolve()
    candidate = (root_resolved / raw).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        return None
    return candidate


def _normalize_history_pollutant_code(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    compact = re.sub(r"[^a-z0-9]+", "", text.replace("µ", "u").replace("μ", "u"))
    if not compact:
        return None
    if "pm25" in compact or "pm2p5" in compact or "particulatematter25" in compact:
        return "pm25"
    if "pm10" in compact or "particulatematter10" in compact:
        return "pm10"
    if "no2" in compact or "nitrogendioxide" in compact:
        return "no2"
    if compact == "o3" or "ozone" in compact:
        return "o3"
    if "so2" in compact or "sulphurdioxide" in compact or "sulfurdioxide" in compact:
        return "so2"
    if compact == "co" or "carbonmonoxide" in compact:
        return "co"
    return None


def _source_keys_for_scope(source_scope: Mapping[str, Any] | None) -> tuple[str, ...]:
    source_filter = "all"
    if isinstance(source_scope, Mapping):
        source_filter = str(source_scope.get("source") or "all").strip() or "all"
    return CROSS_CHECK_SOURCE_KEYS_BY_FILTER.get(
        source_filter,
        CROSS_CHECK_SOURCE_KEYS_BY_FILTER["all"],
    )


def _current_source_counts_for_v2_partition(
    conn: sqlite3.Connection | None,
    *,
    env_name: str | None,
    source_scope: Mapping[str, Any] | None,
    day_utc: str,
    connector_id: int,
    pollutant_code: str,
) -> tuple[dict[int, int], dict[str, Any]]:
    partition_evidence: dict[str, Any] = {
        "source_partition_state": "counts_unavailable",
        "source_counts_present": False,
        "source_rows": 0,
        "source_timeseries_row_counts": {},
        "source_file_count": 0,
        "source_file_keys": [],
        "source_skip_reason": "source_counts_unavailable",
        "partition": {
            "state": "counts_unavailable",
            "source_counts_present": False,
            "source_rows": 0,
            "source_timeseries_row_counts": {},
            "source_file_count": 0,
            "source_file_keys": [],
            "source_skip_reason": "source_counts_unavailable",
        },
    }
    if conn is None:
        partition_evidence["source_partition_state"] = "connection_unavailable"
        partition_evidence["source_skip_reason"] = "source_connection_unavailable"
        partition_evidence["partition"]["state"] = "connection_unavailable"
        partition_evidence["partition"]["source_skip_reason"] = "source_connection_unavailable"
        return {}, partition_evidence

    source_keys = _source_keys_for_scope(source_scope)
    if not source_keys:
        partition_evidence["source_partition_state"] = "scope_unavailable"
        partition_evidence["source_skip_reason"] = "source_scope_has_no_source_keys"
        partition_evidence["partition"]["state"] = "scope_unavailable"
        partition_evidence["partition"]["source_skip_reason"] = "source_scope_has_no_source_keys"
        return {}, partition_evidence

    day = dt.date.fromisoformat(day_utc)
    lookup_rows = conn.execute(
        f"""
        SELECT DISTINCT source_key, source_location_id
        FROM source_station_timeseries_lookup
        WHERE connector_id = ?
          AND is_active = 1
          AND source_location_id IS NOT NULL
          AND source_key IN ({','.join('?' for _ in source_keys)})
        ORDER BY source_key, source_location_id
        """,
        (int(connector_id), *source_keys),
    ).fetchall()
    source_file_keys = [
        key
        for source_key, source_location_id in lookup_rows
        if (key := _source_file_key_for_lookup_row(str(source_key), str(source_location_id), day)) is not None
    ]
    if not source_file_keys:
        return {}, partition_evidence

    state_where = [f"s.source_file_key IN ({','.join('?' for _ in source_file_keys)})"]
    state_params: list[Any] = [*source_file_keys]
    if env_name:
        state_where.insert(0, "s.env_name = ?")
        state_params.insert(0, env_name)
    state_rows = conn.execute(
        f"""
        SELECT DISTINCT s.source_file_key, s.exists_remote, s.last_status
        FROM source_file_state s
        WHERE {' AND '.join(state_where)}
        ORDER BY s.source_file_key
        """,
        tuple(state_params),
    ).fetchall()

    rows_where = [
        "c.row_count > 0",
        "s.day_utc = ?",
        "t.connector_id = ?",
        f"s.source_file_key IN ({','.join('?' for _ in source_file_keys)})",
        "l.connector_id = ?",
        "l.is_active = 1",
        "l.source_location_id IS NOT NULL",
        f"l.source_key IN ({','.join('?' for _ in source_keys)})",
    ]
    rows_params: list[Any] = [day_utc, int(connector_id), *source_file_keys, int(connector_id), *source_keys]
    if env_name:
        rows_where.insert(0, "s.env_name = ?")
        rows_params.insert(0, env_name)
    rows = conn.execute(
        f"""
        SELECT
          c.timeseries_id,
          SUM(c.row_count) AS source_row_count,
          t.timeseries_ref,
          t.label AS timeseries_label,
          p.label AS phenomenon_label,
          p.source_label AS phenomenon_source_label,
          p.pollutant_label AS phenomenon_pollutant_label
        FROM source_file_timeseries_counts c
        JOIN source_file_state s
          ON s.source_file_key = c.source_file_key
        JOIN source_station_timeseries_lookup l
          ON l.source_key = s.source_key
         AND l.source_location_id = s.source_location_id
         AND l.timeseries_id = c.timeseries_id
        JOIN core_timeseries_snapshot t
          ON t.id = c.timeseries_id
        LEFT JOIN core_phenomena_snapshot p
          ON p.id = t.phenomenon_id
        WHERE {' AND '.join(rows_where)}
        GROUP BY
          c.timeseries_id,
          t.timeseries_ref,
          t.label,
          p.label,
          p.source_label,
          p.pollutant_label
        ORDER BY c.timeseries_id
        """,
        tuple(rows_params),
    ).fetchall()

    counts: dict[int, int] = {}
    saw_source_rows = False
    saw_pollutant_metadata = False
    wanted_pollutant = _normalize_history_pollutant_code(pollutant_code)
    for (
        timeseries_id,
        source_row_count,
        timeseries_ref,
        timeseries_label,
        phenomenon_label,
        phenomenon_source_label,
        phenomenon_pollutant_label,
    ) in rows:
        saw_source_rows = True
        candidates = [
            phenomenon_pollutant_label,
            phenomenon_source_label,
            phenomenon_label,
            timeseries_label,
            timeseries_ref,
        ]
        normalized_candidates = {
            code for code in (_normalize_history_pollutant_code(value) for value in candidates) if code
        }
        if normalized_candidates:
            saw_pollutant_metadata = True
        if wanted_pollutant and wanted_pollutant not in normalized_candidates:
            continue
        try:
            ts_id = int(timeseries_id)
            count = int(source_row_count or 0)
        except (TypeError, ValueError):
            continue
        if ts_id > 0 and count > 0:
            counts[ts_id] = counts.get(ts_id, 0) + count

    source_file_keys_evidence = [str(row[0]) for row in state_rows] or [str(key) for key in source_file_keys]

    if counts:
        source_rows = sum(counts.values())
        source_timeseries_row_counts = {str(timeseries_id): count for timeseries_id, count in sorted(counts.items())}
        partition_evidence.update({
            "source_partition_state": "successful_non_empty",
            "source_counts_present": True,
            "source_rows": source_rows,
            "source_timeseries_row_counts": source_timeseries_row_counts,
            "source_file_count": len(state_rows),
            "source_file_keys": source_file_keys_evidence,
            "source_skip_reason": None,
            "partition": {
                "state": "successful_non_empty",
                "source_counts_present": True,
                "source_rows": source_rows,
                "source_timeseries_row_counts": source_timeseries_row_counts,
                "source_file_count": len(state_rows),
                "source_file_keys": source_file_keys_evidence,
                "source_skip_reason": None,
            },
        })
        return counts, partition_evidence

    successful_state_statuses = {"first_seen", "changed", "reappeared", "unchanged"}
    if not rows and state_rows and any(
        int(row[1] or 0) == 1 and str(row[2] or "").strip() in successful_state_statuses
        for row in state_rows
    ):
        partition_evidence.update({
            "source_partition_state": "successful_empty",
            "source_counts_present": False,
            "source_rows": 0,
            "source_timeseries_row_counts": {},
            "source_file_count": len(state_rows),
            "source_file_keys": source_file_keys_evidence,
            "source_skip_reason": None,
            "partition": {
                "state": "successful_empty",
                "source_counts_present": False,
                "source_rows": 0,
                "source_timeseries_row_counts": {},
                "source_file_count": len(state_rows),
                "source_file_keys": source_file_keys_evidence,
                "source_skip_reason": None,
            },
        })
        return {}, partition_evidence

    if saw_source_rows and not saw_pollutant_metadata:
        partition_evidence["source_partition_state"] = "metadata_unavailable"
        partition_evidence["source_skip_reason"] = "source_pollutant_metadata_unavailable"
        partition_evidence["partition"]["state"] = "metadata_unavailable"
        partition_evidence["partition"]["source_skip_reason"] = "source_pollutant_metadata_unavailable"
        return {}, partition_evidence
    if saw_source_rows:
        partition_evidence["source_partition_state"] = "pollutant_absent"
        partition_evidence["source_skip_reason"] = "source_pollutant_not_present"
        partition_evidence["partition"]["state"] = "pollutant_absent"
        partition_evidence["partition"]["source_skip_reason"] = "source_pollutant_not_present"
        return {}, partition_evidence
    partition_evidence["source_partition_state"] = "counts_unavailable"
    partition_evidence["source_skip_reason"] = "source_counts_unavailable"
    partition_evidence["partition"]["state"] = "counts_unavailable"
    partition_evidence["partition"]["source_skip_reason"] = "source_counts_unavailable"
    return {}, partition_evidence


def _build_v2_source_r2_mismatch_gap(
    *,
    day_utc: str,
    connector_id: int | str,
    pollutant_code: str,
    expected_path: str,
    source_counts: Mapping[int, int],
    r2_counts: Mapping[int, int],
    source_partition_evidence: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    source_partition_state = str((source_partition_evidence or {}).get("source_partition_state") or "")
    # Only successful_empty may compare against an empty source map; all
    # unavailable states must stay distinct from an authoritative zero.
    if not source_counts and source_partition_state != "successful_empty":
        return None

    mismatches: list[dict[str, Any]] = []
    for timeseries_id in sorted(set(source_counts) | set(r2_counts)):
        source_rows = int(source_counts.get(timeseries_id) or 0)
        r2_rows = int(r2_counts.get(timeseries_id) or 0)
        if source_rows != r2_rows:
            mismatches.append({
                "timeseries_id": int(timeseries_id),
                "source_rows": source_rows,
                "r2_rows": r2_rows,
                "missing_rows": max(0, source_rows - r2_rows),
                "extra_rows": max(0, r2_rows - source_rows),
            })
    if not mismatches:
        return None

    source_total = sum(int(v or 0) for v in source_counts.values())
    r2_total_for_source = sum(int(value or 0) for value in r2_counts.values())
    sample = mismatches[:25]
    gap = _v2_obs_gap(
        "source_r2_timeseries_row_mismatch",
        day_utc=day_utc,
        connector_id=connector_id,
        pollutant_code=pollutant_code,
        expected_path=expected_path,
        related_paths=[
            (
                f"timeseries_id={entry['timeseries_id']} "
                f"source_rows={entry['source_rows']} "
                f"r2_rows={entry['r2_rows']} "
                f"missing_rows={entry['missing_rows']} "
                f"extra_rows={entry['extra_rows']}"
            )
            for entry in sample
        ],
    )
    gap["source_rows"] = source_total
    gap["r2_rows"] = r2_total_for_source
    gap["missing_timeseries_count"] = len(mismatches)
    gap["missing_timeseries_ids"] = [entry["timeseries_id"] for entry in mismatches]
    gap["source_only_timeseries_ids"] = [
        entry["timeseries_id"] for entry in mismatches if entry["source_rows"] > 0 and entry["r2_rows"] == 0
    ]
    gap["r2_only_timeseries_ids"] = [
        entry["timeseries_id"] for entry in mismatches if entry["source_rows"] == 0 and entry["r2_rows"] > 0
    ]
    gap["sample_missing_timeseries_ids"] = [entry["timeseries_id"] for entry in sample]
    # Keep the complete compact mismatch set in JSON so a targeted repair can
    # be constructed exactly; only human-facing related_paths are truncated.
    gap["source_r2_mismatches"] = mismatches
    evidence = gap.setdefault("source_evidence", {})
    evidence["source_counts_present"] = True
    evidence["source_rows"] = source_total
    evidence["r2_rows_for_source_timeseries"] = r2_total_for_source
    evidence["missing_timeseries_count"] = len(mismatches)
    evidence["sample_missing_timeseries_ids"] = [entry["timeseries_id"] for entry in sample]
    if source_partition_evidence is not None:
        evidence["source_partition_state"] = source_partition_evidence.get("source_partition_state")
        evidence["source_skip_reason"] = source_partition_evidence.get("source_skip_reason")
        evidence["partition"] = dict(source_partition_evidence.get("partition") or {})
    return gap


def _r2_partition_timeseries_counts_from_manifest(payload: Any) -> dict[int, int]:
    if not isinstance(payload, dict):
        return {}
    return _normalize_timeseries_row_counts(payload.get("timeseries_row_counts"))


def _append_actual_parquet_gaps(
    gaps: list[dict[str, Any]],
    *,
    domain: str,
    day_utc: str,
    connector_id: int | str,
    pollutant_code: str,
    manifest_rel: str,
    payload: Mapping[str, Any] | None,
    parquet_files: Iterable[Path],
) -> tuple[dict[str, Any] | None, str | None]:
    gap_fn = _v2_aqi_gap if domain == "aqilevels" else _v2_obs_gap
    stats, error = _read_parquet_partition_stats(parquet_files)
    if error:
        gap_type = "parquet_reader_unavailable" if error == "duckdb_unavailable" else "parquet_unreadable"
        gaps.append(gap_fn(
            gap_type,
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant_code,
            expected_path=manifest_rel,
            related_paths=[error],
        ))
        return None, error
    if stats is None or payload is None:
        return stats, None
    local_parquet_files = [Path(path) for path in parquet_files if Path(path).is_file()]
    actual_bytes = sum(path.stat().st_size for path in local_parquet_files)
    actual_file_count = len(local_parquet_files)
    manifest_files = _manifest_files_list(payload)
    if manifest_files is None:
        gaps.append(gap_fn(
            "data_manifest_schema_mismatch",
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant_code,
            expected_path=manifest_rel,
            related_paths=["field=files missing_or_invalid_type"],
        ))
    gap_prefix = "data_manifest"

    row_count = _append_required_int_field_gap(
        gaps,
        gap_fn=gap_fn,
        gap_prefix=gap_prefix,
        payload=payload,
        field="row_count",
        day_utc=day_utc,
        connector_id=connector_id,
        pollutant_code=pollutant_code,
        expected_path=manifest_rel,
        expected_value=stats["row_count"],
    )
    _append_required_int_field_gap(
        gaps,
        gap_fn=gap_fn,
        gap_prefix=gap_prefix,
        payload=payload,
        field="source_row_count",
        day_utc=day_utc,
        connector_id=connector_id,
        pollutant_code=pollutant_code,
        expected_path=manifest_rel,
        expected_value=stats["row_count"],
    )
    _append_required_int_field_gap(
        gaps,
        gap_fn=gap_fn,
        gap_prefix=gap_prefix,
        payload=payload,
        field="file_count",
        day_utc=day_utc,
        connector_id=connector_id,
        pollutant_code=pollutant_code,
        expected_path=manifest_rel,
        expected_value=actual_file_count,
    )
    _append_required_int_field_gap(
        gaps,
        gap_fn=gap_fn,
        gap_prefix=gap_prefix,
        payload=payload,
        field="total_bytes",
        day_utc=day_utc,
        connector_id=connector_id,
        pollutant_code=pollutant_code,
        expected_path=manifest_rel,
        expected_value=actual_bytes,
    )

    if row_count == 0 and stats["row_count"] == 0:
        gaps.append(gap_fn(
            "data_partition_zero_rows",
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant_code,
            expected_path=manifest_rel,
            related_paths=[f"row_count={row_count}"],
        ))

    _append_required_int_field_gap(
        gaps,
        gap_fn=gap_fn,
        gap_prefix=gap_prefix,
        payload=payload,
        field="min_timeseries_id",
        day_utc=day_utc,
        connector_id=connector_id,
        pollutant_code=pollutant_code,
        expected_path=manifest_rel,
        expected_value=stats["min_timeseries_id"],
    )
    _append_required_int_field_gap(
        gaps,
        gap_fn=gap_fn,
        gap_prefix=gap_prefix,
        payload=payload,
        field="max_timeseries_id",
        day_utc=day_utc,
        connector_id=connector_id,
        pollutant_code=pollutant_code,
        expected_path=manifest_rel,
        expected_value=stats["max_timeseries_id"],
    )

    if domain == "observations":
        timestamp_fields = (
            ("min_observed_at_utc", "min_timestamp_utc"),
            ("max_observed_at_utc", "max_timestamp_utc"),
        )
    elif domain == "aqilevels":
        timestamp_fields = (
            ("min_timestamp_hour_utc", "min_timestamp_utc"),
            ("max_timestamp_hour_utc", "max_timestamp_utc"),
        )
    else:
        timestamp_fields = ()

    for field, actual_field in timestamp_fields:
        _append_required_timestamp_field_gap(
            gaps,
            gap_fn=gap_fn,
            gap_prefix=gap_prefix,
            payload=payload,
            field=field,
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant_code,
            expected_path=manifest_rel,
            expected_value=stats[actual_field],
        )

    raw_timeseries_counts = payload.get("timeseries_row_counts")
    if not isinstance(raw_timeseries_counts, dict):
        gaps.append(gap_fn(
            "data_manifest_schema_mismatch",
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant_code,
            expected_path=manifest_rel,
            related_paths=["field=timeseries_row_counts missing_or_invalid_type"],
        ))
        return stats, None

    manifest_counts = _r2_partition_timeseries_counts_from_manifest(payload)
    actual_counts = stats["timeseries_row_counts"]
    if row_count is not None and row_count > 0 and not raw_timeseries_counts:
        gaps.append(gap_fn(
            "data_manifest_empty_timeseries_counts",
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant_code,
            expected_path=manifest_rel,
        ))

    if manifest_counts != actual_counts:
        gaps.append(gap_fn(
            "data_manifest_timeseries_row_count_mismatch",
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant_code,
            expected_path=manifest_rel,
            related_paths=[
                f"timeseries_id={timeseries_id} manifest_rows={manifest_counts.get(timeseries_id, 0)} parquet_rows={actual_counts.get(timeseries_id, 0)}"
                for timeseries_id in sorted(set(manifest_counts) | set(actual_counts))
                if manifest_counts.get(timeseries_id, 0) != actual_counts.get(timeseries_id, 0)
            ],
        ))
    return stats, None


def _classify_v2_gaps(gaps: Iterable[dict[str, Any]]) -> None:
    for gap in gaps:
        gap_type = str(gap.get("gap_type") or "")
        if gap_type.startswith("connector_manifest_"):
            fault_class = "connector manifest-only fault"
        elif gap_type.startswith("day_manifest_"):
            fault_class = "day manifest-only fault"
        elif gap_type.startswith("index_") or gap_type.startswith("latest_index_"):
            fault_class = "index-only fault"
        elif gap_type.startswith("data_manifest_") or gap_type == "orphan_parquet_without_manifest":
            fault_class = (
                "pollutant manifest-only fault"
                if gap.get("parquet_readable") is True
                else "data fault"
            )
        elif gap_type in {"parquet_reader_unavailable"}:
            fault_class = "source unavailable"
        elif gap_type in {"source_mapping_issue"}:
            fault_class = "source mapping issue"
        elif gap_type in {"source_unavailable"}:
            fault_class = "source unavailable"
        elif gap_type.startswith("metadata_"):
            fault_class = "metadata-only fault"
        else:
            fault_class = "data fault"
        gap["fault_class"] = fault_class


def run_v2_observations_integrity_checks(
    *,
    r2_history_root: str | Path | None,
    config: HistoryPathConfig,
    from_day: str | None,
    to_day: str | None,
    conn: sqlite3.Connection | None = None,
    env_name: str | None = None,
    allowed_connector_ids: set[int] | None = None,
    source_scope: dict[str, Any] | None = None,
    log: logging.Logger | None = None,
) -> dict[str, Any]:
    if not r2_history_root:
        raise RuntimeError("UK_AQ_R2_HISTORY_DROPBOX_ROOT is not set")
    root = Path(r2_history_root)
    if not root.is_dir():
        raise RuntimeError(f"UK_AQ_R2_HISTORY_DROPBOX_ROOT is not a directory: {root}")
    if not from_day or not to_day:
        raise RuntimeError("v2 observations integrity requires a selected from/to day range")

    gaps: list[dict[str, Any]] = []
    checked = 0
    data_prefix = config.observations_data_prefix.strip("/")
    index_prefix = config.observations_timeseries_index_prefix.strip("/")
    latest_key = config.observations_latest_index_key.strip("/")

    latest_path = root / latest_key
    if not latest_path.is_file():
        gaps.append(_v2_obs_gap("latest_index_missing", expected_path=latest_key))
    else:
        try:
            json.loads(latest_path.read_text(encoding="utf-8"))
        except Exception:
            gaps.append(_v2_obs_gap("latest_index_invalid_json", expected_path=latest_key))

    for day in _date_range_inclusive(from_day, to_day):
        day_utc = day.isoformat()
        day_rel = f"{data_prefix}/day_utc={day_utc}"
        day_dir = root / day_rel
        if not day_dir.is_dir():
            if allowed_connector_ids is None:
                gaps.append(_v2_obs_gap("day_dir_missing", day_utc=day_utc, expected_path=day_rel))
            else:
                for connector_id in _expected_connector_ids(allowed_connector_ids):
                    gaps.append(_v2_obs_gap(
                        "day_dir_missing",
                        day_utc=day_utc,
                        connector_id=connector_id,
                        expected_path=f"{day_rel}/connector_id={connector_id}",
                    ))
            continue
        connector_dirs = sorted(p for p in day_dir.glob("connector_id=*") if p.is_dir())
        if allowed_connector_ids is not None:
            existing_allowed_ids = {
                cid
                for p in connector_dirs
                for cid in [_connector_id_from_dirname(p.name)]
                if cid is not None and cid in allowed_connector_ids
            }
            for connector_id in _expected_connector_ids(allowed_connector_ids):
                if connector_id not in existing_allowed_ids:
                    gaps.append(_v2_obs_gap(
                        "connector_dir_missing",
                        day_utc=day_utc,
                        connector_id=connector_id,
                        expected_path=f"{day_rel}/connector_id={connector_id}",
                    ))
            connector_dirs = [
                p for p in connector_dirs
                if _connector_dir_allowed(p.name, allowed_connector_ids)
            ]
        if not connector_dirs:
            if allowed_connector_ids is not None:
                continue
            gaps.append(_v2_obs_gap("connector_dir_missing", day_utc=day_utc, expected_path=f"{day_rel}/connector_id=*"))
            continue
        for connector_dir in connector_dirs:
            connector_raw = connector_dir.name.split("=", 1)[1]
            pollutant_dirs = sorted(p for p in connector_dir.glob("pollutant_code=*") if p.is_dir())
            connector_level_parts = sorted(p for p in connector_dir.glob("part-*.parquet") if p.is_file())
            if connector_level_parts:
                gaps.append(_v2_obs_gap(
                    "unexpected_connector_level_part_file",
                    day_utc=day_utc,
                    connector_id=connector_raw,
                    expected_path=f"{day_rel}/{connector_dir.name}/pollutant_code=*/part-*.parquet",
                    related_paths=[str(p.relative_to(root)) for p in connector_level_parts],
                ))
            if not pollutant_dirs:
                gaps.append(_v2_obs_gap("missing_pollutant_partitions", day_utc=day_utc, connector_id=connector_raw, expected_path=f"{day_rel}/{connector_dir.name}/pollutant_code=*"))
                continue
            for pollutant_dir in pollutant_dirs:
                pollutant = pollutant_dir.name.split("=", 1)[1]
                checked += 1
                partition_gap_start = len(gaps)
                part_rel = f"{day_rel}/{connector_dir.name}/{pollutant_dir.name}"
                manifest_rel = f"{part_rel}/manifest.json"
                manifest_path = root / manifest_rel
                local_parquets = list(pollutant_dir.glob("*.parquet"))
                payload: Any = None
                if not manifest_path.is_file():
                    gaps.append(_v2_obs_gap("data_manifest_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[str(p.relative_to(root)) for p in local_parquets]))
                    if local_parquets:
                        gaps.append(_v2_obs_gap("orphan_parquet_without_manifest", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[str(p.relative_to(root)) for p in local_parquets]))
                else:
                    try:
                        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
                    except Exception:
                        gaps.append(_v2_obs_gap("data_manifest_invalid_json", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel))
                    if isinstance(payload, dict):
                        expected_manifest_fields = {
                            "manifest_kind": "pollutant",
                            "history_version": "v2",
                            "domain": "observations",
                            "grain": None,
                            "profile": None,
                        }
                        expected_path_fields = {
                            "day_utc": day_utc,
                            "connector_id": str(connector_raw),
                            "pollutant_code": pollutant,
                        }
                        schema_bad = [
                            field for field, expected in expected_manifest_fields.items()
                            if field not in payload or str(payload.get(field)) != str(expected)
                        ]
                        if schema_bad:
                            gaps.append(_v2_obs_gap("data_manifest_schema_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=schema_bad))
                        path_bad = [
                            field for field, expected in expected_path_fields.items()
                            if field not in payload or str(payload.get(field)) != str(expected)
                        ]
                        if path_bad:
                            gaps.append(_v2_obs_gap("data_manifest_path_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=path_bad))
                        files = _manifest_files_list(payload)
                        files_valid = files is not None
                        if not files_valid:
                            files = []
                        local_parquet_keys = {
                            str(p.relative_to(root))
                            for p in sorted(local_parquets)
                        }
                        if files_valid:
                            listed_keys: list[str] = []
                            duplicate_keys: set[str] = set()
                            for entry in files:
                                if isinstance(entry, dict) and str(entry.get("key") or "").strip():
                                    key_str = str(entry.get("key")).strip().lstrip("/")
                                    if key_str in listed_keys:
                                        duplicate_keys.add(key_str)
                                    listed_keys.append(key_str)
                            listed_key_set = set(listed_keys)
                            if duplicate_keys:
                                gaps.append(_v2_obs_gap("data_manifest_duplicate_file_key", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=sorted(duplicate_keys)))
                            for missing_key in sorted(listed_key_set - local_parquet_keys):
                                gaps.append(_v2_obs_gap("data_manifest_listed_parquet_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=missing_key))
                            for unlisted_key in sorted(local_parquet_keys - listed_key_set):
                                gaps.append(_v2_obs_gap("data_manifest_unlisted_parquet", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=unlisted_key))
                            for entry in files:
                                key = entry.get("key") if isinstance(entry, dict) else None
                                if not key:
                                    gaps.append(_v2_obs_gap("data_manifest_schema_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=["files[] entry missing key"]))
                                    continue
                                file_path = _rel_key_to_path(root, str(key))
                                if file_path is None:
                                    gaps.append(_v2_obs_gap("data_manifest_schema_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[f"files[] key escapes mirror root: {key}"]))
                                elif not file_path.is_file():
                                    gaps.append(_v2_obs_gap("parquet_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=str(key)))
                                elif file_path.stat().st_size <= 0:
                                    gaps.append(_v2_obs_gap("parquet_empty_or_placeholder", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=str(key)))
                    elif payload is not None:
                        gaps.append(_v2_obs_gap("data_manifest_schema_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel))
                try:
                    connector_id_for_source = int(str(connector_raw))
                except (TypeError, ValueError):
                    connector_id_for_source = None
                source_partition_evidence: dict[str, Any] | None = None
                source_counts: dict[int, int] = {}
                if connector_id_for_source is not None:
                    source_counts, source_partition_evidence = _current_source_counts_for_v2_partition(
                        conn,
                        env_name=env_name,
                        source_scope=source_scope,
                        day_utc=day_utc,
                        connector_id=connector_id_for_source,
                        pollutant_code=pollutant,
                    )
                parquet_stats, parquet_error = _append_actual_parquet_gaps(
                    gaps,
                    domain="observations",
                    day_utc=day_utc,
                    connector_id=connector_raw,
                    pollutant_code=pollutant,
                    manifest_rel=manifest_rel,
                    payload=payload if isinstance(payload, Mapping) else None,
                    parquet_files=local_parquets,
                )
                parquet_readable = parquet_stats is not None and parquet_error is None and bool(local_parquets)

                # Check for null timeseries_id rows in observation parquet files
                if parquet_stats and parquet_stats.get("parquet_null_timeseries_id_rows"):
                    gaps.append(_v2_obs_gap("parquet_null_timeseries_id_rows", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[f"null_timeseries_count={parquet_stats.get('null_timeseries_count', 0)}"]))

                for partition_gap in gaps[partition_gap_start:]:
                    if str(partition_gap.get("gap_type") or "").startswith("data_manifest_") or partition_gap.get("gap_type") == "orphan_parquet_without_manifest":
                        partition_gap["parquet_readable"] = parquet_readable
                idx_rel = f"{index_prefix}/day_utc={day_utc}/{connector_dir.name}/{pollutant_dir.name}/manifest.json"
                idx_path = root / idx_rel
                if not idx_path.is_file():
                    gaps.append(_v2_obs_gap("index_manifest_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=idx_rel))
                else:
                    try:
                        idx_payload = json.loads(idx_path.read_text(encoding="utf-8"))
                        if "timeseries_row_counts" not in idx_payload:
                            gaps.append(_v2_obs_gap("index_manifest_missing_timeseries_counts", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=idx_rel))
                        elif not idx_payload.get("timeseries_row_counts"):
                            gaps.append(_v2_obs_gap("index_manifest_empty_timeseries_counts", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=idx_rel))
                    except Exception:
                        gaps.append(_v2_obs_gap("index_manifest_invalid_json", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=idx_rel))
                if source_partition_evidence is not None:
                    for partition_gap in gaps[partition_gap_start:]:
                        partition_gap.setdefault("source_evidence", {}).update(source_partition_evidence)

                if parquet_stats is not None and connector_id_for_source is not None:
                    stale_gap = _build_v2_source_r2_mismatch_gap(
                        day_utc=day_utc,
                        connector_id=connector_raw,
                        pollutant_code=pollutant,
                        expected_path=manifest_rel,
                        source_counts=source_counts,
                        r2_counts=parquet_stats["timeseries_row_counts"],
                        source_partition_evidence=source_partition_evidence,
                    )
                    if stale_gap is not None:
                        gaps.append(stale_gap)
            _validate_v2_parent_hierarchy(
                root=root,
                data_prefix=data_prefix,
                day_utc=day_utc,
                connector_dir=connector_dir,
                day_dir=day_dir,
                gaps=gaps,
                domain="observations",
            )
        _validate_v2_parent_hierarchy(
            root=root,
            data_prefix=data_prefix,
            day_utc=day_utc,
            connector_dir=None,
            day_dir=day_dir,
            gaps=gaps,
            domain="observations",
        )

    _classify_v2_gaps(gaps)
    _enrich_v2_observations_repair_plans(
        root=root,
        gaps=gaps,
        source_scope=source_scope,
    )
    status = "fail" if any(g.get("severity") == "error" for g in gaps) else "ok"
    result = {
        "status": status,
        "checked_partitions": checked,
        "gap_count": len(gaps),
        "gaps": gaps,
        "repair_plan": build_v2_repair_plan(observation_gaps=gaps, conn=conn),
    }
    if source_scope is not None:
        result["source_scope"] = source_scope
    if log:
        log.info("v2 observations integrity done status=%s checked_partitions=%s gaps=%s", status, checked, len(gaps))
        _log_v2_integrity_gaps(log, "observations", gaps)
    return result


def _log_v2_integrity_gaps(
    log: logging.Logger,
    domain: str,
    gaps: Iterable[Mapping[str, Any]],
    *,
    limit: int = 100,
) -> None:
    gap_list = list(gaps)
    for gap in gap_list[:limit]:
        compact = {
            key: gap.get(key)
            for key in (
                "gap_type", "day_utc", "connector_id", "pollutant_code",
                "expected_path", "source_rows", "r2_rows",
                "missing_timeseries_count", "sample_missing_timeseries_ids",
                "source_evidence", "related_paths",
            )
            if gap.get(key) not in (None, [], {})
        }
        log.warning(
            "v2 integrity gap %s",
            json.dumps({"event": "v2_integrity_gap", "domain": domain, **compact}, sort_keys=True, default=str),
        )
    if len(gap_list) > limit:
        log.warning(
            "v2 integrity gaps truncated %s",
            json.dumps({"event": "v2_integrity_gaps_truncated", "domain": domain, "logged": limit, "total": len(gap_list)}, sort_keys=True),
        )



def _v2_aqi_gap(
    gap_type: str,
    *,
    profile: str = "data",
    day_utc: str | None = None,
    connector_id: int | str | None = None,
    pollutant_code: str | None = None,
    expected_path: str | None = None,
    related_paths: list[str] | None = None,
    severity: str = "error",
) -> dict[str, Any]:
    cid: int | str | None = connector_id
    if cid is not None:
        try:
            cid = int(str(cid))
        except (TypeError, ValueError):
            cid = connector_id
    return {
        "history_version": "v2",
        "domain": "aqilevels",
        "grain": "hourly",
        "profile": profile,
        "severity": severity,
        "gap_type": gap_type,
        "day_utc": day_utc,
        "connector_id": cid,
        "pollutant_code": pollutant_code,
        "expected_path": expected_path,
        "related_paths": list(related_paths or []),
        "source_evidence": {
            "v2_observations_present": None,
            "v1_aqi_present": None,
            "source_counts_present": None,
            "db_dump_present": None,
        },
        "suggested_repair": {
            "kind": "repair_plan_unclassified",
            "requires_index_rebuild": True,
            "commands": [],
            "notes": "Repair planning did not classify this v2 AQI finding.",
        },
    }


def _enrich_v2_aqi_repair_plans(
    *,
    root: Path,
    config: HistoryPathConfig,
    gaps: list[dict[str, Any]],
) -> None:
    index_gap_types = {
        "index_day_dir_missing",
        "index_connector_dir_missing",
        "index_pollutant_dir_missing",
        "index_manifest_missing",
        "index_manifest_invalid_json",
        "index_manifest_missing_timeseries_counts",
        "index_manifest_empty_timeseries_counts",
        "latest_index_missing",
        "latest_index_invalid_json",
        "latest_index_stale_or_incomplete",
    }
    data_gap_types = {
        "day_dir_missing",
        "connector_dir_missing",
        "pollutant_dir_missing",
        "data_manifest_missing",
        "data_manifest_invalid_json",
        "data_manifest_schema_mismatch",
        "data_manifest_empty",
        "data_manifest_file_count_mismatch",
        "data_manifest_listed_parquet_missing",
        "data_manifest_unlisted_parquet",
        "data_manifest_duplicate_file_key",
        "data_manifest_timeseries_row_count_mismatch",
        "data_manifest_total_bytes_mismatch",
        "parquet_missing",
        "parquet_empty_or_placeholder",
        "parquet_unreadable",
        "row_count_mismatch",
        "data_manifest_row_count_mismatch",
        "pollutant_missing",
        "orphan_parquet_without_manifest",
        "missing_pollutant_partitions",
        "unexpected_connector_level_part_file",
    }
    debug_gap_prefixes = ("debug_",)
    for gap in gaps:
        gap_type = str(gap.get("gap_type") or "")
        day_utc = gap.get("day_utc")
        connector_id = gap.get("connector_id")
        pollutant_code = gap.get("pollutant_code")
        if gap.get("fault_class") == "pollutant manifest-only fault":
            gap["suggested_repair"] = {
                "kind": "aqi_pollutant_manifest_repair",
                "requires_index_rebuild": True,
                "commands": [],
                "executes": False,
                "steps": ["Rebuild the AQI pollutant manifest from the readable parquet files."],
                "notes": "The parquet content is readable; do not rebuild AQI data.",
            }
            continue
        v2_obs_present, v2_obs_paths = _local_v2_observations_evidence(
            root,
            config,
            day_utc=str(day_utc) if day_utc else None,
            connector_id=connector_id,
            pollutant_code=str(pollutant_code) if pollutant_code else None,
        )
        evidence = gap.setdefault("source_evidence", {})
        evidence["v2_observations_present"] = v2_obs_present
        if v2_obs_paths:
            evidence["v2_observations_paths"] = v2_obs_paths

        if gap_type in index_gap_types:
            gap["suggested_repair"] = {
                "kind": "rebuild_v2_aqi_index_only",
                "requires_index_rebuild": True,
                "commands": [],
                "steps": [
                    "Confirm the v2 AQI hourly data partition exists for the finding.",
                    "Rebuild only the v2 AQI hourly data _index_v2 timeseries manifest for the affected day/connector/pollutant.",
                ],
                "notes": "No exact _index_v2 rebuild command is emitted because the command contract remains unresolved.",
            }
        elif gap_type.startswith("connector_manifest_"):
            gap["suggested_repair"] = {
                "kind": "aqi_connector_manifest_repair",
                "requires_index_rebuild": True,
                "commands": [],
                "steps": [
                    "Rebuild the AQI connector manifest from the live pollutant child manifests.",
                    "Keep any sibling pollutant partitions that are already present.",
                ],
                "notes": "Connector-level AQI hierarchy gaps are repairable by rebuilding the parent manifest only.",
            }
        elif gap_type.startswith("day_manifest_"):
            gap["suggested_repair"] = {
                "kind": "aqi_day_manifest_repair",
                "requires_index_rebuild": True,
                "commands": [],
                "steps": [
                    "Rebuild the AQI day manifest from the live connector child manifests.",
                    "Keep any sibling connector partitions that are already present.",
                ],
                "notes": "Day-level AQI hierarchy gaps are repairable by rebuilding the parent manifest only.",
            }
        elif gap_type.startswith(debug_gap_prefixes):
            gap["suggested_repair"] = {
                "kind": "v2_aqi_debug_optional_rebuild_plan",
                "requires_index_rebuild": False,
                "commands": [],
                "steps": [
                    "Decide whether debug AQI coverage is required for this run.",
                    "If required, rebuild v2 AQI debug outputs from v2 observations using the confirmed operational rebuild path.",
                ],
                "notes": "Debug coverage is optional unless the checker was run with debug required; no exact rebuild command is confirmed here.",
            }
        elif (
            (gap_type in data_gap_types or gap_type in V2_AQI_EXECUTABLE_OBS_COVERAGE_GAP_TYPES)
            and v2_obs_present is True
        ):
            if day_utc and connector_id:
                try:
                    command = _planned_aqi_rebuild_command(
                        {},
                        int(connector_id),
                        dt.date.fromisoformat(str(day_utc)),
                        history_version="v2",
                    )
                except (TypeError, ValueError):
                    command = None
            else:
                command = None
            gap["suggested_repair"] = {
                "kind": "v2_aqi_hourly_rebuild_from_v2_observations",
                "requires_index_rebuild": True,
                "commands": [command] if command else [],
                "steps": [
                    "Queue the existing AQI-only v2 rebuild from v2 observations for the affected connector/day.",
                    "Run the queued AQI-only rebuild through the integrity backfill wrapper.",
                    "Post-validate v2 AQI hourly data manifests against v2 observation manifests.",
                ],
                "notes": "Observation-backed v2 AQI data coverage gaps are executable by the integrity runner.",
            }
        elif gap_type in data_gap_types:
            gap["suggested_repair"] = {
                "kind": (
                    "aqi_pollutant_manifest_repair"
                    if gap_type in {
                        "data_manifest_file_count_mismatch",
                        "data_manifest_listed_parquet_missing",
                        "data_manifest_unlisted_parquet",
                        "data_manifest_duplicate_file_key",
                        "data_manifest_timeseries_row_count_mismatch",
                        "data_manifest_total_bytes_mismatch",
                    }
                    else "repair_v2_observations_before_v2_aqi"
                ),
                "requires_index_rebuild": True,
                "commands": [],
                "steps": [
                    (
                        "Repair the AQI pollutant manifest so it matches the live parquet set and row counts."
                        if gap_type in {
                            "data_manifest_file_count_mismatch",
                            "data_manifest_listed_parquet_missing",
                            "data_manifest_unlisted_parquet",
                            "data_manifest_duplicate_file_key",
                            "data_manifest_timeseries_row_count_mismatch",
                            "data_manifest_total_bytes_mismatch",
                        }
                        else "Repair or generate the missing v2 observations partition first."
                    ),
                    "Then rebuild v2 AQI hourly data from v2 observations.",
                    "Finally rebuild the affected v2 AQI hourly data _index_v2 manifests.",
                ],
                "notes": (
                    "Manifest-only AQI gaps are repairable by rebuilding the pollutant manifest."
                    if gap_type in {
                        "data_manifest_file_count_mismatch",
                        "data_manifest_listed_parquet_missing",
                        "data_manifest_unlisted_parquet",
                        "data_manifest_duplicate_file_key",
                        "data_manifest_timeseries_row_count_mismatch",
                        "data_manifest_total_bytes_mismatch",
                    }
                    else "No Supabase/prune/backfill command is emitted because the exact v2 write contract has not been confirmed."
                ),
            }


_SOURCE_PARTITION_UNAVAILABLE_STATES = {
    "connection_unavailable",
    "scope_unavailable",
    "metadata_unavailable",
    "pollutant_absent",
    "counts_unavailable",
}


def _source_partition_state_from_gap(gap: Mapping[str, Any]) -> str | None:
    evidence = gap.get("source_evidence")
    if not isinstance(evidence, Mapping):
        return None
    partition = evidence.get("partition")
    if isinstance(partition, Mapping):
        state = partition.get("state")
        if state:
            return str(state)
    state = evidence.get("source_partition_state")
    if state:
        return str(state)
    return None


def build_v2_repair_plan(
    *,
    observation_gaps: Iterable[Mapping[str, Any]] = (),
    aqi_gaps: Iterable[Mapping[str, Any]] = (),
    conn: sqlite3.Connection | None = None,
) -> list[dict[str, Any]]:
    """Summarize v2 repairs in operator order without executing writes."""
    eligible_pollutants_by_connector: dict[int, set[str] | None] = {}
    observation_partition_priority = {
        "observation_data_repair": 3,
        "source_mapping_issue": 2,
        "observation_pollutant_manifest_repair": 1,
        "observation_index_repair": 0,
    }

    def eligible_for(connector_id: int | str | None, pollutant_code: str | None) -> bool:
        if not pollutant_code:
            return False
        code = str(pollutant_code).strip().lower()
        if code not in {"pm25", "pm10", "no2"}:
            return False
        if connector_id is None:
            return True
        try:
            cid = int(str(connector_id))
        except (TypeError, ValueError):
            return False
        if cid not in eligible_pollutants_by_connector:
            if conn is None:
                eligible_pollutants_by_connector[cid] = {"pm25", "pm10", "no2"}
            else:
                eligible_pollutants_by_connector[cid] = _active_aqi_eligible_pollutants_for_connector(conn, connector_id=cid)
        eligible = eligible_pollutants_by_connector[cid]
        return eligible is None or code in eligible

    actions: dict[tuple[str, str, int | str | None, str | None], dict[str, Any]] = {}

    def add_action(
        kind: str,
        *,
        gap: Mapping[str, Any],
        requires_index_rebuild: bool = False,
        executes: bool = False,
        operator_action_required: bool = False,
        data_changes_required: bool = False,
        notes: str | None = None,
    ) -> None:
        day_utc = gap.get("day_utc")
        connector_id = gap.get("connector_id")
        pollutant_code = gap.get("pollutant_code")
        key = (kind, str(day_utc or ""), connector_id, str(pollutant_code or "") or None)
        entry = actions.get(key)
        gap_type = str(gap.get("gap_type") or "")
        if entry is None:
            entry = {
                "kind": kind,
                "status": "planned",
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": pollutant_code,
                "requires_index_rebuild": bool(requires_index_rebuild),
                "data_changes_required": bool(data_changes_required),
                "executes": False,
                "operator_action_required": bool(operator_action_required),
                "gap_types": [gap_type] if gap_type else [],
                "commands": [],
                "notes": notes or "",
            }
            actions[key] = entry
        else:
            if gap_type and gap_type not in entry["gap_types"]:
                entry["gap_types"].append(gap_type)
            entry["requires_index_rebuild"] = bool(entry["requires_index_rebuild"] or requires_index_rebuild)
            entry["executes"] = bool(entry["executes"] or executes)
            entry["operator_action_required"] = bool(entry["operator_action_required"] or operator_action_required)
            entry["data_changes_required"] = bool(entry["data_changes_required"] or data_changes_required)
            if notes and notes not in str(entry.get("notes") or ""):
                entry["notes"] = f"{entry['notes']}; {notes}" if entry.get("notes") else notes

    for gap in observation_gaps:
        gap_type = str(gap.get("gap_type") or "")
        fault_class = str(gap.get("fault_class") or "")
        source_partition_state = _source_partition_state_from_gap(gap)
        source_partition_unavailable = source_partition_state in _SOURCE_PARTITION_UNAVAILABLE_STATES
        parquet_readable = gap.get("parquet_readable") is True
        if (
            source_partition_unavailable
            and gap_type in {
                "data_manifest_missing",
                "data_manifest_invalid_json",
                "data_manifest_schema_mismatch",
                "data_manifest_empty",
                "data_manifest_file_count_mismatch",
                "data_manifest_listed_parquet_missing",
                "data_manifest_unlisted_parquet",
                "data_manifest_duplicate_file_key",
                "data_manifest_timeseries_row_count_mismatch",
                "data_manifest_total_bytes_mismatch",
                "data_manifest_row_count_mismatch",
                "parquet_missing",
                "parquet_empty_or_placeholder",
                "parquet_unreadable",
                "row_count_mismatch",
                "source_r2_timeseries_row_mismatch",
                "pollutant_missing",
                "missing_pollutant_partitions",
                "unexpected_connector_level_part_file",
                "orphan_parquet_without_manifest",
            }
        ):
            add_action(
                "source_mapping_issue",
                gap=gap,
                operator_action_required=True,
                data_changes_required=False,
                notes="Source evidence is unavailable for this scope; review the source mapping before choosing a repair.",
            )
            continue
        if gap_type.startswith("connector_manifest_"):
            add_action(
                "observation_connector_manifest_repair",
                gap=gap,
                requires_index_rebuild=True,
                notes="Rebuild the connector manifest from all valid live-R2 pollutant children without dropping siblings.",
            )
        elif gap_type.startswith("day_manifest_"):
            add_action(
                "observation_day_manifest_repair",
                gap=gap,
                requires_index_rebuild=True,
                notes="Rebuild the day manifest from all valid live-R2 connector children without dropping siblings.",
            )
        elif gap_type.startswith("index_") or gap_type.startswith("latest_index_"):
            add_action(
                "observation_index_repair",
                gap=gap,
                requires_index_rebuild=True,
                notes="Rebuild the observation index metadata for the affected day/connector/pollutant.",
            )
        elif gap_type in {
            "data_manifest_file_count_mismatch",
            "data_manifest_unlisted_parquet",
            "data_manifest_listed_parquet_missing",
            "data_manifest_duplicate_file_key",
            "data_manifest_timeseries_row_count_mismatch",
            "data_manifest_total_bytes_mismatch",
            "data_manifest_row_count_mismatch",
        }:
            add_action(
                "observation_pollutant_manifest_repair",
                gap=gap,
                requires_index_rebuild=True,
                notes="Repair the pollutant manifest so it matches the actual live-R2 parquet set and row counts.",
            )
        elif fault_class == "pollutant manifest-only fault" and (
            gap_type.startswith("data_manifest_") or gap_type == "orphan_parquet_without_manifest"
        ):
            add_action(
                "observation_pollutant_manifest_repair",
                gap=gap,
                requires_index_rebuild=True,
                data_changes_required=False,
                notes="Rebuild the pollutant manifest from readable parquet without rewriting observation data.",
            )
        elif gap_type in {
            "data_manifest_missing",
            "data_manifest_invalid_json",
            "data_manifest_schema_mismatch",
            "data_manifest_empty",
            "data_partition_zero_rows",
            "parquet_missing",
            "parquet_empty_or_placeholder",
            "parquet_unreadable",
            "row_count_mismatch",
            "source_r2_timeseries_row_mismatch",
            "pollutant_missing",
            "orphan_parquet_without_manifest",
            "missing_pollutant_partitions",
            "unexpected_connector_level_part_file",
        }:
            add_action(
                "observation_data_repair",
                gap=gap,
                requires_index_rebuild=True,
                data_changes_required=True,
                notes="Repair the underlying observation data partition before rebuilding manifests and indexes.",
            )
            if eligible_for(gap.get("connector_id"), gap.get("pollutant_code")) and gap_type in {
                "data_manifest_missing",
                "data_manifest_invalid_json",
                "data_manifest_schema_mismatch",
                "data_manifest_empty",
                "parquet_missing",
                "parquet_empty_or_placeholder",
                "parquet_unreadable",
                "row_count_mismatch",
                "data_manifest_row_count_mismatch",
                "source_r2_timeseries_row_mismatch",
                "pollutant_missing",
                "orphan_parquet_without_manifest",
            }:
                add_action(
                    "aqi_rebuild",
                    gap=gap,
                    requires_index_rebuild=True,
                    data_changes_required=True,
                    notes="Queue AQI rebuilding only because the observation data changed for an AQI-enabled pollutant.",
                )

    for gap in aqi_gaps:
        gap_type = str(gap.get("gap_type") or "")
        fault_class = str(gap.get("fault_class") or "")
        if gap_type.startswith("connector_manifest_"):
            add_action(
                "aqi_connector_manifest_repair",
                gap=gap,
                requires_index_rebuild=True,
                notes="Rebuild the AQI connector manifest from all valid live-R2 pollutant children without dropping siblings.",
            )
        elif gap_type.startswith("day_manifest_"):
            add_action(
                "aqi_day_manifest_repair",
                gap=gap,
                requires_index_rebuild=True,
                notes="Rebuild the AQI day manifest from all valid live-R2 connector children without dropping siblings.",
            )
        elif gap_type.startswith("index_") or gap_type.startswith("latest_index_"):
            add_action(
                "aqi_index_repair",
                gap=gap,
                requires_index_rebuild=True,
                notes="Rebuild AQI index metadata for the affected day/connector/pollutant.",
            )
        elif gap_type in {
            "data_manifest_file_count_mismatch",
            "data_manifest_unlisted_parquet",
            "data_manifest_listed_parquet_missing",
            "data_manifest_duplicate_file_key",
            "data_manifest_timeseries_row_count_mismatch",
            "data_manifest_total_bytes_mismatch",
            "data_manifest_row_count_mismatch",
        }:
            add_action(
                "aqi_pollutant_manifest_repair",
                gap=gap,
                requires_index_rebuild=True,
                notes="Repair the AQI pollutant manifest so it matches the actual live-R2 parquet set and row counts.",
            )
        elif fault_class == "pollutant manifest-only fault" and (
            gap_type.startswith("data_manifest_") or gap_type == "orphan_parquet_without_manifest"
        ):
            add_action(
                "aqi_pollutant_manifest_repair",
                gap=gap,
                requires_index_rebuild=True,
                data_changes_required=False,
                notes="Rebuild the AQI pollutant manifest from readable parquet without rewriting AQI data.",
            )
        elif gap_type in {
            "data_manifest_missing",
            "data_manifest_invalid_json",
            "data_manifest_schema_mismatch",
            "data_manifest_empty",
            "data_partition_zero_rows",
            "parquet_missing",
            "parquet_empty_or_placeholder",
            "parquet_unreadable",
            "row_count_mismatch",
            "pollutant_missing",
            "orphan_parquet_without_manifest",
        }:
            add_action(
                "aqi_rebuild",
                gap=gap,
                requires_index_rebuild=True,
                data_changes_required=True,
                notes="Rebuild AQI data only where the AQI partition itself is stale or incomplete.",
            )

    selected_observation_actions: dict[tuple[str, str, str], str] = {}
    for entry in actions.values():
        kind = str(entry.get("kind") or "")
        if kind not in observation_partition_priority:
            continue
        pollutant_code = entry.get("pollutant_code")
        day_utc = entry.get("day_utc")
        connector_id = entry.get("connector_id")
        if pollutant_code is None or day_utc is None or connector_id is None:
            continue
        key = (str(day_utc), str(connector_id), str(pollutant_code))
        current_kind = selected_observation_actions.get(key)
        if current_kind is None or observation_partition_priority[kind] > observation_partition_priority[current_kind]:
            selected_observation_actions[key] = kind

    filtered_actions: dict[tuple[str, str, int | str | None, str | None], dict[str, Any]] = {}
    for action_key, entry in actions.items():
        kind = str(entry.get("kind") or "")
        pollutant_code = entry.get("pollutant_code")
        day_utc = entry.get("day_utc")
        connector_id = entry.get("connector_id")
        if pollutant_code is None or day_utc is None or connector_id is None:
            filtered_actions[action_key] = entry
            continue
        partition_key = (str(day_utc), str(connector_id), str(pollutant_code))
        selected_kind = selected_observation_actions.get(partition_key)
        if kind == "aqi_rebuild":
            if selected_kind != "observation_data_repair":
                continue
            entry["data_changes_required"] = True
            filtered_actions[action_key] = entry
            continue
        if kind in observation_partition_priority and selected_kind != kind:
            continue
        filtered_actions[action_key] = entry

    order = [
        "observation_data_repair",
        "source_mapping_issue",
        "observation_pollutant_manifest_repair",
        "observation_index_repair",
        "observation_connector_manifest_repair",
        "observation_day_manifest_repair",
        "aqi_rebuild",
        "aqi_pollutant_manifest_repair",
        "aqi_connector_manifest_repair",
        "aqi_day_manifest_repair",
        "aqi_index_repair",
    ]
    position = {kind: idx for idx, kind in enumerate(order)}
    for entry in filtered_actions.values():
        entry["gap_types"] = sorted(set(entry.get("gap_types") or []))
    return sorted(
        filtered_actions.values(),
        key=lambda entry: (
            position.get(str(entry.get("kind") or ""), 999),
            str(entry.get("day_utc") or ""),
            int(entry["connector_id"]) if str(entry.get("connector_id") or "").isdigit() else -1,
            str(entry.get("pollutant_code") or ""),
        ),
    )


def _is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _load_json_file(path: Path) -> tuple[Any | None, str | None]:
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError:
        return None, "invalid_json"
    except OSError:
        return None, "unreadable"


def _validate_v2_aqi_manifest(
    *,
    payload: Any,
    profile: str,
    day_utc: str,
    connector_id: str,
    pollutant_code: str,
) -> list[str]:
    if not isinstance(payload, dict):
        return ["manifest_not_object"]
    bad: list[str] = []
    expected = {
        "manifest_kind": "pollutant",
        "history_version": "v2",
        "domain": "aqilevels",
        "grain": "hourly",
        "profile": profile,
    }
    for key, want in expected.items():
        if key not in payload or str(payload.get(key)) != str(want):
            bad.append(key)
    return bad


def run_v2_aqilevels_integrity_checks(
    *,
    r2_history_root: str | Path | None,
    config: HistoryPathConfig,
    from_day: str | None,
    to_day: str | None,
    allowed_connector_ids: set[int] | None = None,
    source_scope: dict[str, Any] | None = None,
    conn: sqlite3.Connection | None = None,
    check_aqi_debug: bool = False,
    require_aqi_debug: bool = False,
    log: logging.Logger | None = None,
) -> dict[str, Any]:
    if not r2_history_root:
        raise RuntimeError("UK_AQ_R2_HISTORY_DROPBOX_ROOT is not set")
    root = Path(r2_history_root)
    if not root.is_dir():
        raise RuntimeError(f"UK_AQ_R2_HISTORY_DROPBOX_ROOT is not a directory: {root}")
    if not from_day or not to_day:
        raise RuntimeError("v2 AQI integrity requires a selected from/to day range")

    data_gaps: list[dict[str, Any]] = []
    debug_gaps: list[dict[str, Any]] = []
    checked = 0
    debug_checked = 0
    data_prefix = config.aqilevels_hourly_data_prefix.strip("/")
    debug_prefix = (config.aqilevels_hourly_debug_prefix or "").strip("/")
    index_prefix = config.aqilevels_timeseries_index_prefix.strip("/")
    latest_key = config.aqilevels_latest_index_key.strip("/")

    latest_path = root / latest_key
    if not latest_path.is_file():
        data_gaps.append(_v2_aqi_gap("latest_index_missing", expected_path=latest_key))
    else:
        payload, err = _load_json_file(latest_path)
        if err:
            data_gaps.append(_v2_aqi_gap("latest_index_invalid_json", expected_path=latest_key))
        elif not isinstance(payload, dict):
            data_gaps.append(_v2_aqi_gap("latest_index_stale_or_incomplete", expected_path=latest_key, related_paths=["latest index is not an object"]))

    expected_parts: list[tuple[str, str, str]] = []
    for day in _date_range_inclusive(from_day, to_day):
        day_utc = day.isoformat()
        day_rel = f"{data_prefix}/day_utc={day_utc}"
        day_dir = root / day_rel
        if not day_dir.is_dir():
            if allowed_connector_ids is None:
                data_gaps.append(_v2_aqi_gap("day_dir_missing", day_utc=day_utc, expected_path=day_rel))
            else:
                for connector_id in _expected_connector_ids(allowed_connector_ids):
                    data_gaps.append(_v2_aqi_gap(
                        "day_dir_missing",
                        day_utc=day_utc,
                        connector_id=connector_id,
                        expected_path=f"{day_rel}/connector_id={connector_id}",
                    ))
            continue
        connector_dirs = sorted(p for p in day_dir.glob("connector_id=*") if p.is_dir())
        if allowed_connector_ids is not None:
            existing_allowed_ids = {
                cid
                for p in connector_dirs
                for cid in [_connector_id_from_dirname(p.name)]
                if cid is not None and cid in allowed_connector_ids
            }
            for connector_id in _expected_connector_ids(allowed_connector_ids):
                if connector_id not in existing_allowed_ids:
                    data_gaps.append(_v2_aqi_gap(
                        "connector_dir_missing",
                        day_utc=day_utc,
                        connector_id=connector_id,
                        expected_path=f"{day_rel}/connector_id={connector_id}",
                    ))
            connector_dirs = [
                p for p in connector_dirs
                if _connector_dir_allowed(p.name, allowed_connector_ids)
            ]
        if not connector_dirs:
            if allowed_connector_ids is not None:
                continue
            data_gaps.append(_v2_aqi_gap("connector_dir_missing", day_utc=day_utc, expected_path=f"{day_rel}/connector_id=*"))
            continue
        for connector_dir in connector_dirs:
            connector_raw = connector_dir.name.split("=", 1)[1]
            pollutant_dirs = sorted(p for p in connector_dir.glob("pollutant_code=*") if p.is_dir())
            if not pollutant_dirs:
                data_gaps.append(_v2_aqi_gap("pollutant_dir_missing", day_utc=day_utc, connector_id=connector_raw, expected_path=f"{day_rel}/{connector_dir.name}/pollutant_code=*"))
                continue
            for pollutant_dir in pollutant_dirs:
                pollutant = pollutant_dir.name.split("=", 1)[1]
                expected_parts.append((day_utc, connector_raw, pollutant))
                checked += 1
                partition_gap_start = len(data_gaps)
                part_rel = f"{day_rel}/{connector_dir.name}/{pollutant_dir.name}"
                manifest_rel = f"{part_rel}/manifest.json"
                manifest_path = root / manifest_rel
                local_parquets = list(pollutant_dir.glob("*.parquet"))
                payload: Any = None
                if not manifest_path.is_file():
                    data_gaps.append(_v2_aqi_gap("data_manifest_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[str(p.relative_to(root)) for p in local_parquets]))
                    if local_parquets:
                        data_gaps.append(_v2_aqi_gap("orphan_parquet_without_manifest", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[str(p.relative_to(root)) for p in local_parquets]))
                else:
                    payload, err = _load_json_file(manifest_path)
                    if err:
                        data_gaps.append(_v2_aqi_gap("data_manifest_invalid_json", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel))
                    elif isinstance(payload, dict):
                        bad = _validate_v2_aqi_manifest(payload=payload, profile="data", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant)
                        if bad:
                            data_gaps.append(_v2_aqi_gap("data_manifest_schema_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=bad))
                        path_bad = [
                            field for field, expected in {
                                "day_utc": day_utc,
                                "connector_id": str(connector_raw),
                                "pollutant_code": pollutant,
                            }.items()
                            if field not in payload or str(payload.get(field)) != str(expected)
                        ]
                        if path_bad:
                            data_gaps.append(_v2_aqi_gap("data_manifest_path_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=path_bad))
                        files = _manifest_files_list(payload)
                        files_valid = files is not None
                        if not files_valid:
                            files = []
                        local_parquet_keys = {
                            str(p.relative_to(root))
                            for p in sorted(local_parquets)
                        }
                        if files_valid:
                            listed_keys: list[str] = []
                            duplicate_keys: set[str] = set()
                            for entry in files:
                                if isinstance(entry, dict) and str(entry.get("key") or "").strip():
                                    key_str = str(entry.get("key")).strip().lstrip("/")
                                    if key_str in listed_keys:
                                        duplicate_keys.add(key_str)
                                    listed_keys.append(key_str)
                            listed_key_set = set(listed_keys)
                            if duplicate_keys:
                                data_gaps.append(_v2_aqi_gap("data_manifest_duplicate_file_key", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=sorted(duplicate_keys)))
                            for missing_key in sorted(listed_key_set - local_parquet_keys):
                                data_gaps.append(_v2_aqi_gap("data_manifest_listed_parquet_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=missing_key))
                            for unlisted_key in sorted(local_parquet_keys - listed_key_set):
                                data_gaps.append(_v2_aqi_gap("data_manifest_unlisted_parquet", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=unlisted_key))
                            for entry in files:
                                key = entry.get("key") if isinstance(entry, dict) else None
                                if not key:
                                    data_gaps.append(_v2_aqi_gap("data_manifest_schema_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=["files[] entry missing key"]))
                                    continue
                                file_path = _rel_key_to_path(root, str(key))
                                if file_path is None:
                                    data_gaps.append(_v2_aqi_gap("data_manifest_schema_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[f"files[] key escapes mirror root: {key}"]))
                                elif not file_path.is_file():
                                    data_gaps.append(_v2_aqi_gap("parquet_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=str(key)))
                                elif file_path.stat().st_size <= 0:
                                    data_gaps.append(_v2_aqi_gap("parquet_empty_or_placeholder", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=str(key)))
                    else:
                        data_gaps.append(_v2_aqi_gap("data_manifest_schema_mismatch", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel))
                parquet_stats, parquet_error = _append_actual_parquet_gaps(
                    data_gaps,
                    domain="aqilevels",
                    day_utc=day_utc,
                    connector_id=connector_raw,
                    pollutant_code=pollutant,
                    manifest_rel=manifest_rel,
                    payload=payload if isinstance(payload, Mapping) else None,
                    parquet_files=local_parquets,
                )
                parquet_readable = parquet_stats is not None and parquet_error is None and bool(local_parquets)

                # Check for null timeseries_id rows in AQI parquet files
                if parquet_stats and parquet_stats.get("parquet_null_timeseries_id_rows"):
                    data_gaps.append(_v2_aqi_gap("parquet_null_timeseries_id_rows", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[f"null_timeseries_count={parquet_stats.get('null_timeseries_count', 0)}"]))
                for partition_gap in data_gaps[partition_gap_start:]:
                    if str(partition_gap.get("gap_type") or "").startswith("data_manifest_") or partition_gap.get("gap_type") == "orphan_parquet_without_manifest":
                        partition_gap["parquet_readable"] = parquet_readable
                idx_rel = f"{index_prefix}/day_utc={day_utc}/{connector_dir.name}/{pollutant_dir.name}/manifest.json"
                idx_path = root / idx_rel
                if not (root / f"{index_prefix}/day_utc={day_utc}").is_dir():
                    data_gaps.append(_v2_aqi_gap("index_day_dir_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=f"{index_prefix}/day_utc={day_utc}"))
                elif not (root / f"{index_prefix}/day_utc={day_utc}/{connector_dir.name}").is_dir():
                    data_gaps.append(_v2_aqi_gap("index_connector_dir_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=f"{index_prefix}/day_utc={day_utc}/{connector_dir.name}"))
                elif not (root / f"{index_prefix}/day_utc={day_utc}/{connector_dir.name}/{pollutant_dir.name}").is_dir():
                    data_gaps.append(_v2_aqi_gap("index_pollutant_dir_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=f"{index_prefix}/day_utc={day_utc}/{connector_dir.name}/{pollutant_dir.name}"))
                elif not idx_path.is_file():
                    data_gaps.append(_v2_aqi_gap("index_manifest_missing", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=idx_rel))
                else:
                    idx_payload, idx_err = _load_json_file(idx_path)
                    if idx_err:
                        data_gaps.append(_v2_aqi_gap("index_manifest_invalid_json", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=idx_rel))
                    elif not isinstance(idx_payload, dict) or "timeseries_row_counts" not in idx_payload:
                        data_gaps.append(_v2_aqi_gap("index_manifest_missing_timeseries_counts", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=idx_rel))
                    elif not idx_payload.get("timeseries_row_counts"):
                        data_gaps.append(_v2_aqi_gap("index_manifest_empty_timeseries_counts", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=idx_rel))
            _validate_v2_parent_hierarchy(
                root=root,
                data_prefix=data_prefix,
                day_utc=day_utc,
                connector_dir=connector_dir,
                day_dir=day_dir,
                gaps=data_gaps,
                domain="aqilevels",
            )
        _validate_v2_parent_hierarchy(
            root=root,
            data_prefix=data_prefix,
            day_utc=day_utc,
            connector_dir=None,
            day_dir=day_dir,
            gaps=data_gaps,
            domain="aqilevels",
        )

    debug_status = "skipped"
    if check_aqi_debug:
        severity = "error" if require_aqi_debug else "warning"
        for day_utc, connector_raw, pollutant in expected_parts:
            debug_checked += 1
            debug_rel = f"{debug_prefix}/day_utc={day_utc}/connector_id={connector_raw}/pollutant_code={pollutant}"
            manifest_rel = f"{debug_rel}/manifest.json"
            manifest_path = root / manifest_rel
            if not manifest_path.is_file():
                debug_gaps.append(_v2_aqi_gap("debug_manifest_missing", profile="debug", severity=severity, day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel))
                continue
            payload, err = _load_json_file(manifest_path)
            if err:
                debug_gaps.append(_v2_aqi_gap("debug_manifest_invalid_json", profile="debug", severity=severity, day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel))
                continue
            bad = _validate_v2_aqi_manifest(payload=payload, profile="debug", day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant)
            bad.extend(
                field for field, expected in {
                    "day_utc": day_utc,
                    "connector_id": str(connector_raw),
                    "pollutant_code": pollutant,
                }.items()
                if field not in payload or str(payload.get(field)) != str(expected)
            )
            if bad:
                debug_gaps.append(_v2_aqi_gap("debug_manifest_schema_mismatch", profile="debug", severity=severity, day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=bad))
            for entry in _manifest_files(payload):
                key = entry.get("key") if isinstance(entry, dict) else None
                if key:
                    file_path = _rel_key_to_path(root, str(key))
                    if file_path is None:
                        debug_gaps.append(_v2_aqi_gap("debug_manifest_schema_mismatch", profile="debug", severity=severity, day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=manifest_rel, related_paths=[f"files[] key escapes mirror root: {key}"]))
                    elif not file_path.is_file():
                        debug_gaps.append(_v2_aqi_gap("debug_parquet_missing", profile="debug", severity=severity, day_utc=day_utc, connector_id=connector_raw, pollutant_code=pollutant, expected_path=str(key)))
        if any(g.get("severity") == "error" for g in debug_gaps):
            debug_status = "fail"
        elif debug_gaps:
            debug_status = "warning"
        else:
            debug_status = "ok"

    observation_coverage_checked = 0
    for day in _date_range_inclusive(from_day, to_day):
        day_utc = day.isoformat()
        for connector_id in _v2_observation_connector_ids_for_aqi_validation(
            root=root,
            config=config,
            day_utc=day_utc,
            allowed_connector_ids=allowed_connector_ids,
        ):
            observation_coverage_checked += 1
            data_gaps.extend(_v2_aqi_observation_coverage_gaps(
                root=root,
                config=config,
                day_utc=day_utc,
                connector_id=connector_id,
                conn=conn,
            ))

    all_gaps = data_gaps + debug_gaps
    _classify_v2_gaps(all_gaps)
    _enrich_v2_aqi_repair_plans(root=root, config=config, gaps=all_gaps)
    status = "fail" if any(g.get("severity") == "error" for g in all_gaps) else "ok"
    result = {
        "status": status,
        "checked_partitions": checked,
        "observation_coverage_checked": observation_coverage_checked,
        "gap_count": len(data_gaps),
        "gaps": data_gaps,
        "repair_plan": build_v2_repair_plan(aqi_gaps=data_gaps, conn=conn),
        "debug": {
            "checked": bool(check_aqi_debug),
            "required": bool(require_aqi_debug),
            "status": debug_status,
            "checked_partitions": debug_checked,
            "gap_count": len(debug_gaps),
            "gaps": debug_gaps,
        },
    }
    if source_scope is not None:
        result["source_scope"] = source_scope
    if log:
        log.info("v2 AQI integrity done status=%s checked_partitions=%s gaps=%s debug_gaps=%s", status, checked, len(data_gaps), len(debug_gaps))
        _log_v2_integrity_gaps(log, "aqilevels", data_gaps)
        _log_v2_integrity_gaps(log, "aqilevels_debug", debug_gaps)
    return result


def run_v2_post_repair_integrity_rechecks(
    *,
    conn: sqlite3.Connection | None = None,
    env_name: str | None = None,
    r2_history_root: str | Path | None,
    config: HistoryPathConfig,
    from_day: str | None,
    to_day: str | None,
    allowed_connector_ids: set[int] | None,
    source_scope: dict[str, Any] | None,
    check_aqi_debug: bool,
    require_aqi_debug: bool,
    log: logging.Logger,
) -> dict[str, Any]:
    """Re-run v2 integrity checks after repairs so final status reflects reality."""
    post_obs = run_v2_observations_integrity_checks(
        r2_history_root=r2_history_root,
        config=config,
        from_day=from_day,
        to_day=to_day,
        conn=conn,
        env_name=env_name,
        allowed_connector_ids=allowed_connector_ids,
        source_scope=source_scope,
        log=log,
    )
    post_aqi = run_v2_aqilevels_integrity_checks(
        r2_history_root=r2_history_root,
        config=config,
        from_day=from_day,
        to_day=to_day,
        allowed_connector_ids=allowed_connector_ids,
        source_scope=source_scope,
        conn=conn,
        check_aqi_debug=check_aqi_debug,
        require_aqi_debug=require_aqi_debug,
        log=log,
    )
    obs_status = str(post_obs.get("status") or "fail")
    aqi_status = str(post_aqi.get("status") or "fail")
    if obs_status == "ok" and aqi_status == "ok":
        message = "v2 observations fixed and AQI fixed"
    elif obs_status == "ok":
        message = "v2 observations fixed; v2 AQI still failing"
    elif aqi_status == "ok":
        message = "v2 AQI fixed; v2 observations still failing"
    else:
        message = "v2 observations and v2 AQI still failing"
    status = "ok" if obs_status == "ok" and aqi_status == "ok" else "fail"
    remaining_observation_gaps = list(post_obs.get("gaps") or [])
    remaining_aqi_gaps = list(post_aqi.get("gaps") or [])
    remaining_aqi_debug_gaps = list((post_aqi.get("debug") or {}).get("gaps") or [])
    for domain, gaps in (
        ("observations", remaining_observation_gaps),
        ("aqilevels", remaining_aqi_gaps),
        ("aqilevels_debug", remaining_aqi_debug_gaps),
    ):
        for gap in gaps:
            log.warning(
                "v2 post-repair remaining gap domain=%s details=%s",
                domain,
                json.dumps(gap, sort_keys=True, default=str),
            )
    return {
        "ran": True,
        "status": status,
        "message": message,
        "observations": post_obs,
        "aqilevels": post_aqi,
        "remaining_observation_gap_count": len(remaining_observation_gaps),
        "remaining_aqi_gap_count": len(remaining_aqi_gaps),
        "remaining_aqi_debug_gap_count": len(remaining_aqi_debug_gaps),
    }


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
        "c.day_utc IS NOT NULL",
        "c.row_count > 0",
        f"s.source_key IN ({','.join('?' for _ in source_keys)})",
    ]
    params: list[Any] = [env_name, *source_keys]
    if from_day:
        where.append("c.day_utc >= ?")
        params.append(from_day)
    if to_day:
        where.append("c.day_utc <= ?")
        params.append(to_day)
    where_sql = " AND ".join(where)

    rows = conn.execute(
        f"""
        SELECT
          t.connector_id,
          c.day_utc,
          c.timeseries_id,
          SUM(c.row_count) AS source_row_count
        FROM source_file_timeseries_counts c
        JOIN source_file_state s
          ON s.source_file_key = c.source_file_key
        JOIN core_timeseries_snapshot t
          ON t.id = c.timeseries_id
        WHERE {where_sql}
        GROUP BY t.connector_id, c.day_utc, c.timeseries_id
        ORDER BY c.day_utc, t.connector_id, c.timeseries_id
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
                    run_id, env_name, "v1", connector_id, day_utc, timeseries_id,
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
                    run_id, env_name, "v1", connector_id, day_utc, timeseries_id,
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
                "v1",
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
              run_id, env_name, history_version, connector_id, day_utc, timeseries_id,
              source_row_count, r2_row_count, delta, status, checked_at_utc, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          AND EXISTS (
            SELECT 1
            FROM source_file_timeseries_counts sc
            JOIN source_file_state s
              ON s.source_file_key = sc.source_file_key
            WHERE sc.day_utc = x.day_utc
              AND sc.timeseries_id = x.timeseries_id
              AND sc.row_count > 0
              AND s.exists_remote = 1
              AND (
                s.remote_scheme <> 'uk_air_flat_file'
                OR s.last_status IN (
                  'unchanged', 'changed', 'first_seen', 'reappeared',
                  'unmapped_source', 'mixed_mapping_issues'
                )
              )
          )
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


def _collect_sos_source_change_targets(
    conn: sqlite3.Connection,
    *,
    source_filter: str,
    sos_metrics: Mapping[str, Any] | None,
) -> dict[tuple[str, int], list[int]]:
    """Build connector/day -> timeseries IDs from SOS changed/reappeared rows.

    Phase 7.4 uses these as additional observation-repair candidates so
    source content changes can be repaired even when row-count parity happens
    to match R2.
    """
    if source_filter not in {"sos", "all"}:
        return {}
    changed_files = (sos_metrics or {}).get("changed_files") or []
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
        (*sorted(timeseries_ids_set), SOS_SOURCE_KEY),
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
    history_version: str = "v1",
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
              run_id, env_name, history_version, domain, profile,
              pollutant_code, source_observations_version,
              connector_id, day_utc,
              reason, source_mode, status,
              requested_timeseries_ids, notes,
              created_at_utc, started_at_utc, finished_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
            """,
            (
                run_id,
                env_name,
                history_version,
                "aqilevels",
                "hourly",
                None,
                history_version,
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


def queue_v2_aqi_rebuilds_from_integrity_gaps(
    *,
    conn: sqlite3.Connection,
    run_id: int,
    env_name: str,
    env: dict[str, str],
    v2_aqilevels: Mapping[str, Any],
    dry_run: bool,
    run_backfill: bool,
    log: logging.Logger,
    allowed_connector_ids: set[int] | None = None,
    blocked_connector_days: set[tuple[str, int]] | None = None,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "v2_aqi_integrity_rebuild_bridge_ran": False,
        "v2_aqi_rebuilds_queued_from_integrity": 0,
        "v2_aqi_rebuilds_skipped_missing_observation_evidence": 0,
        "v2_aqi_rebuilds_skipped_non_executable_gap": 0,
        "v2_aqi_rebuilds_skipped_observation_repair_unverified": 0,
        "planned_v2_aqi_rebuilds_from_integrity": [],
        "planned_aqi_rebuild_connector_days": [],
        "queued_aqi_only_connector_days": [],
        "skipped_v2_aqi_rebuilds_from_integrity": [],
    }
    if not run_backfill:
        return metrics

    grouped: dict[tuple[str, int], dict[str, Any]] = {}
    for gap in list(v2_aqilevels.get("gaps") or []):
        gap_type = str(gap.get("gap_type") or "").strip()
        day_utc = str(gap.get("day_utc") or "").strip()
        try:
            connector_id = int(gap.get("connector_id"))
        except (TypeError, ValueError):
            connector_id = 0
        pollutant_code = str(gap.get("pollutant_code") or "").strip()
        evidence = gap.get("source_evidence") if isinstance(gap.get("source_evidence"), dict) else {}
        observations_present = evidence.get("v2_observations_present") is True

        skip_reason: str | None = None
        if gap_type not in V2_AQI_EXECUTABLE_OBS_COVERAGE_GAP_TYPES:
            skip_reason = "non_executable_gap_type"
            metrics["v2_aqi_rebuilds_skipped_non_executable_gap"] += 1
        elif not day_utc or connector_id <= 0:
            skip_reason = "missing_connector_day"
            metrics["v2_aqi_rebuilds_skipped_non_executable_gap"] += 1
        elif allowed_connector_ids is not None and connector_id not in allowed_connector_ids:
            skip_reason = "outside_source_scope"
            metrics["v2_aqi_rebuilds_skipped_non_executable_gap"] += 1
        elif (day_utc, connector_id) in (blocked_connector_days or set()):
            skip_reason = "observation_repair_not_verified"
            metrics["v2_aqi_rebuilds_skipped_observation_repair_unverified"] += 1
        elif not observations_present:
            skip_reason = "missing_v2_observation_evidence"
            metrics["v2_aqi_rebuilds_skipped_missing_observation_evidence"] += 1

        if skip_reason is not None:
            metrics["skipped_v2_aqi_rebuilds_from_integrity"].append({
                "day_utc": day_utc or None,
                "connector_id": connector_id if connector_id > 0 else None,
                "pollutant_code": pollutant_code or None,
                "gap_type": gap_type or None,
                "reason": skip_reason,
            })
            continue

        key = (day_utc, connector_id)
        entry = grouped.setdefault(key, {
            "day_utc": day_utc,
            "connector_id": connector_id,
            "gap_types": set(),
            "pollutants": set(),
        })
        entry["gap_types"].add(gap_type)
        if pollutant_code:
            entry["pollutants"].add(pollutant_code)

    queued_keys: set[tuple[str, int]] = set()
    planned_rows: list[dict[str, Any]] = []
    for (day_utc, connector_id), entry in sorted(grouped.items()):
        gap_types = sorted(entry["gap_types"])
        pollutants = sorted(entry["pollutants"])
        try:
            day_obj = dt.date.fromisoformat(day_utc)
        except ValueError:
            metrics["skipped_v2_aqi_rebuilds_from_integrity"].append({
                "day_utc": day_utc,
                "connector_id": connector_id,
                "gap_types": gap_types,
                "reason": "invalid_day",
            })
            continue
        command = _planned_aqi_rebuild_command(
            env,
            connector_id,
            day_obj,
            history_version="v2",
            env_name=env_name,
        )
        queue_note = (
            "source=v2_aqi_integrity "
            f"gap_types={','.join(gap_types)} "
            f"pollutants={','.join(pollutants) if pollutants else '<unknown>'} "
            "history_version=v2"
        )
        row = {
            "day_utc": day_utc,
            "connector_id": connector_id,
            "reasons": [AQI_INTEGRITY_OBS_COVERAGE_REASON],
            "gap_types": gap_types,
            "pollutants": pollutants,
            "notes": queue_note,
            "history_version": "v2",
            "source_mode": "live_r2",
            "planned_command": command,
        }
        planned_rows.append(row)
        metrics["planned_v2_aqi_rebuilds_from_integrity"].append(command)
        if dry_run:
            queued_keys.add((day_utc, connector_id))
            continue

        action = _queue_aqi_rebuild(
            conn=conn,
            run_id=run_id,
            env_name=env_name,
            connector_id=connector_id,
            day_utc=day_utc,
            reason=AQI_INTEGRITY_OBS_COVERAGE_REASON,
            source_mode="live_r2",
            requested_timeseries_ids=[],
            queue_note=queue_note,
            log=log,
            history_version="v2",
        )
        if action in {"inserted", "merged"}:
            queued_keys.add((day_utc, connector_id))

    metrics["v2_aqi_integrity_rebuild_bridge_ran"] = True
    metrics["v2_aqi_rebuilds_queued_from_integrity"] = len(queued_keys)
    metrics["planned_aqi_rebuild_connector_days"] = planned_rows
    metrics["queued_aqi_only_connector_days"] = planned_rows
    log.info(
        "v2 AQI integrity rebuild bridge done planned=%s queued=%s skipped_missing_obs=%s skipped_non_executable=%s",
        len(planned_rows),
        metrics["v2_aqi_rebuilds_queued_from_integrity"],
        metrics["v2_aqi_rebuilds_skipped_missing_observation_evidence"],
        metrics["v2_aqi_rebuilds_skipped_non_executable_gap"],
    )
    return metrics


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
    history_version: str = "v1",
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
        history_version=history_version,
    )


def _validate_chunked_v2_observation_repair_for_aqi(
    *,
    chunk_count: int,
    chunk_results: list[dict[str, Any]],
    repaired_observation_rows: int,
) -> tuple[bool, str | None]:
    if chunk_count <= 1:
        return True, None
    if len(chunk_results) != chunk_count:
        return False, f"attempted_chunks={len(chunk_results)} expected_chunks={chunk_count}"

    deferred_events = sum(
        int(result.get("source_to_r2_targeted_stage_deferred_commit_events") or 0)
        for result in chunk_results
    )
    complete_events = sum(
        int(result.get("source_connector_day_complete_events") or 0)
        for result in chunk_results
    )
    expected_deferred_events = chunk_count - 1
    if deferred_events != expected_deferred_events:
        return False, (
            f"targeted_stage_deferred_events={deferred_events} "
            f"expected={expected_deferred_events}"
        )
    if complete_events != 1:
        return False, f"connector_day_complete_events={complete_events} expected=1"

    for index, result in enumerate(chunk_results[:-1], start=1):
        if int(result.get("source_connector_day_complete_events") or 0) > 0:
            return False, f"chunk_{index}_published_before_finalise"
    final_result = chunk_results[-1]
    if int(final_result.get("source_connector_day_complete_events") or 0) != 1:
        return False, "final_chunk_did_not_publish_connector_day"

    max_deferred_rows = max(
        [
            int(result.get("max_targeted_stage_deferred_rows_observations") or 0)
            for result in chunk_results[:-1]
        ] or [0]
    )
    if max_deferred_rows > 0 and repaired_observation_rows < max_deferred_rows:
        return False, (
            f"final_rows={repaired_observation_rows} "
            f"less_than_staged_rows={max_deferred_rows}"
        )
    return True, None


def _resolve_repo_root_with_diagnostics(env: Mapping[str, str] | None = None) -> tuple[Path, str]:
    values = os.environ if env is None else env
    explicit_root = str(values.get("UK_AQ_OPS_REPO_ROOT", "") or "").strip()
    inferred = Path(__file__).resolve().parents[3]

    if explicit_root:
        path = Path(explicit_root)
        if path.is_dir() and (path / "workers/shared/r2_sigv4.mjs").is_file():
            return path, "ops_repo_root_explicit_valid"
        if path.is_dir():
            diag = "r2_sigv4_missing"
        else:
            diag = "ops_repo_root_invalid"
    else:
        diag = "ops_repo_root_missing"

    if not (inferred / "workers/shared/r2_sigv4.mjs").is_file():
        return inferred, "r2_sigv4_missing"
    return inferred, diag if diag != "ops_repo_root_missing" else "ops_repo_root_inferred"


def _repo_root_for_integrity_script(env: Mapping[str, str] | None = None) -> Path:
    path, _ = _resolve_repo_root_with_diagnostics(env)
    return path


def _v2_observation_connector_manifest_key(
    *,
    day_utc: str,
    connector_id: int,
    env: Mapping[str, str],
) -> str:
    merged_env = {**os.environ, **{str(k): str(v) for k, v in env.items()}}
    config = resolve_history_path_config("v2", merged_env)
    return (
        f"{config.observations_data_prefix.strip('/')}"
        f"/day_utc={day_utc}/connector_id={int(connector_id)}/manifest.json"
    )


def _has_direct_r2_read_config(env: Mapping[str, str]) -> bool:
    return all(
        str(env.get(key) or "").strip()
        for key in (
            "CFLARE_R2_ENDPOINT",
            "CFLARE_R2_BUCKET",
            "CFLARE_R2_ACCESS_KEY_ID",
            "CFLARE_R2_SECRET_ACCESS_KEY",
        )
    ) or all(
        str(env.get(key) or "").strip()
        for key in (
            "R2_ENDPOINT",
            "R2_BUCKET",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
        )
    )


def _read_json_manifest_from_r2(
    *,
    manifest_key: str,
    env: Mapping[str, str],
    timeout_seconds: int = 30,
) -> tuple[Any | None, str | None]:
    merged_env = {**os.environ, **{str(k): str(v) for k, v in env.items()}}
    if not _has_direct_r2_read_config(merged_env):
        return None, "r2_config_missing"

    cwd_path, diag_reason = _resolve_repo_root_with_diagnostics(merged_env)
    if diag_reason == "r2_sigv4_missing":
        return None, f"r2_read_failed:{diag_reason}"

    node_bin = (
        merged_env.get("UK_AQ_BACKFILL_NODE_BIN")
        or merged_env.get("NODE_BIN")
        or shutil.which("node")
        or "node"
    )
    read_env = {
        **merged_env,
        "UK_AQ_MANIFEST_GUARD_KEY": manifest_key,
    }
    code = r"""
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";

const env = process.env;
const key = String(env.UK_AQ_MANIFEST_GUARD_KEY || "").trim();
const r2 = {
  endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
  bucket: String(env.CFLARE_R2_BUCKET || env.R2_BUCKET || "").trim(),
  region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
  access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
  secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim(),
};
const object = await r2GetObject({ r2, key });
process.stdout.write(object.body.toString("utf8"));
"""
    try:
        proc = subprocess.run(
            [node_bin, "--input-type=module", "-e", code],
            cwd=cwd_path,
            env=read_env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"r2_read_failed:{type(exc).__name__}:[diag={diag_reason}]"
    if proc.returncode != 0:
        return None, f"r2_read_failed:exit_code={proc.returncode}:[diag={diag_reason}]"
    try:
        return json.loads(proc.stdout or ""), None
    except json.JSONDecodeError:
        return None, f"r2_manifest_invalid_json:[diag={diag_reason}]"


def _read_json_manifest_for_guard(
    *,
    manifest_key: str,
    env: Mapping[str, str],
) -> tuple[Any | None, str | None, str | None]:
    payload, err = _read_json_manifest_from_r2(manifest_key=manifest_key, env=env)
    if err is None:
        return payload, "r2", None

    merged_env = {**os.environ, **{str(k): str(v) for k, v in env.items()}}
    root_raw = resolve_r2_history_root(merged_env)
    if root_raw:
        manifest_path = Path(root_raw) / manifest_key
        if manifest_path.is_file():
            local_payload, local_err = _load_json_file(manifest_path)
            if local_err is None:
                return local_payload, "local_mirror", None
            return None, "local_mirror", f"local_manifest_{local_err}"
        return None, "local_mirror", f"local_manifest_missing:{manifest_key}"
    return None, None, err


def _manifest_row_count(payload: Mapping[str, Any]) -> int:
    for key in ("row_count", "source_row_count"):
        try:
            value = int(payload.get(key))
        except (TypeError, ValueError):
            continue
        if value >= 0:
            return value
    total = 0
    for entry in _manifest_files(payload):
        try:
            total += int(entry.get("row_count") or 0)
        except (TypeError, ValueError):
            continue
    return total


def _manifest_timeseries_row_counts(payload: Mapping[str, Any]) -> dict[int, int]:
    counts = _normalize_timeseries_row_counts(payload.get("timeseries_row_counts"))
    if counts:
        return counts
    return _merge_timeseries_row_counts(
        entry.get("timeseries_row_counts") for entry in _manifest_files(payload)
    )


def _manifest_pollutant_codes(payload: Mapping[str, Any]) -> set[str]:
    codes: set[str] = {
        str(code).strip()
        for code in (payload.get("pollutant_codes") or [])
        if str(code or "").strip()
    }
    for key in ("pollutant_manifests", "child_manifests"):
        raw_children = payload.get(key)
        if isinstance(raw_children, list):
            for child in raw_children:
                if isinstance(child, dict):
                    code = str(child.get("pollutant_code") or "").strip()
                    if code:
                        codes.add(code)
    for entry in _manifest_files(payload):
        code = str(entry.get("pollutant_code") or "").strip()
        if code:
            codes.add(code)
        for entry_code in entry.get("pollutant_codes") or []:
            code_str = str(entry_code or "").strip()
            if code_str:
                codes.add(code_str)
    return codes


def _v2_partition_manifest_rel(
    *,
    prefix: str,
    day_utc: str,
    connector_id: int,
    pollutant_code: str,
) -> str:
    return (
        f"{prefix.strip('/')}/day_utc={day_utc}/connector_id={int(connector_id)}"
        f"/pollutant_code={pollutant_code}/manifest.json"
    )


def _v2_observation_pollutant_dirs_for_aqi_validation(
    *,
    root: Path,
    config: HistoryPathConfig,
    day_utc: str,
    connector_id: int,
) -> list[Path]:
    obs_connector_dir = (
        root
        / config.observations_data_prefix.strip("/")
        / f"day_utc={day_utc}"
        / f"connector_id={int(connector_id)}"
    )
    if not obs_connector_dir.is_dir():
        return []
    return sorted(p for p in obs_connector_dir.glob("pollutant_code=*") if p.is_dir())


def _v2_observation_connector_ids_for_aqi_validation(
    *,
    root: Path,
    config: HistoryPathConfig,
    day_utc: str,
    allowed_connector_ids: set[int] | None,
) -> list[int]:
    obs_day_dir = root / config.observations_data_prefix.strip("/") / f"day_utc={day_utc}"
    if not obs_day_dir.is_dir():
        return []
    connector_ids: set[int] = set()
    for connector_dir in sorted(p for p in obs_day_dir.glob("connector_id=*") if p.is_dir()):
        parsed = _connector_id_from_dirname(connector_dir.name)
        if parsed is None:
            continue
        if allowed_connector_ids is not None and parsed not in allowed_connector_ids:
            continue
        connector_ids.add(parsed)
    return sorted(connector_ids)


def _active_aqi_eligible_pollutants_for_connector(
    conn: sqlite3.Connection | None,
    *,
    connector_id: int,
) -> set[str] | None:
    """Return authoritative AQI-eligible codes, or None to fail closed."""
    if conn is None or not _table_exists(conn, "core_observed_property_mappings_snapshot"):
        return None
    active_count = conn.execute(
        "SELECT COUNT(*) FROM core_observed_property_mappings_snapshot "
        "WHERE connector_id = ? AND is_active = 1",
        (int(connector_id),),
    ).fetchone()
    if not active_count or int(active_count[0] or 0) <= 0:
        return None
    rows = conn.execute(
        """
        SELECT DISTINCT observed_property_code
        FROM core_observed_property_mappings_snapshot
        WHERE connector_id = ?
          AND is_active = 1
          AND is_aqi_eligible = 1
          AND observed_property_code IS NOT NULL
          AND observed_property_code != ''
        """,
        (int(connector_id),),
    ).fetchall()
    return {str(row[0]).strip() for row in rows if str(row[0] or "").strip()}


def _v2_aqi_observation_coverage_gaps(
    *,
    root: Path,
    config: HistoryPathConfig,
    day_utc: str,
    connector_id: int,
    conn: sqlite3.Connection | None = None,
    missing_manifest_gap_type: str = "aqi_manifest_missing_after_obs_repair",
    rows_low_gap_type: str = "aqi_rows_below_observation_rows",
    missing_observations_gap_type: str | None = None,
    invalid_gap_type: str = "aqi_post_rebuild_validation_failed",
) -> list[dict[str, Any]]:
    gaps: list[dict[str, Any]] = []
    obs_prefix = config.observations_data_prefix.strip("/")
    aqi_prefix = config.aqilevels_hourly_data_prefix.strip("/")
    obs_pollutant_dirs = _v2_observation_pollutant_dirs_for_aqi_validation(
        root=root,
        config=config,
        day_utc=day_utc,
        connector_id=connector_id,
    )
    if not obs_pollutant_dirs:
        if missing_observations_gap_type:
            expected = f"{obs_prefix}/day_utc={day_utc}/connector_id={int(connector_id)}/pollutant_code=*"
            gaps.append(_v2_aqi_gap(
                missing_observations_gap_type,
                day_utc=day_utc,
                connector_id=connector_id,
                expected_path=expected,
                related_paths=["no v2 observation pollutant manifests found"],
            ))
        return gaps

    eligible_pollutants = _active_aqi_eligible_pollutants_for_connector(
        conn,
        connector_id=connector_id,
    )

    for obs_dir in obs_pollutant_dirs:
        pollutant = obs_dir.name.split("=", 1)[1]
        if eligible_pollutants is not None and pollutant not in eligible_pollutants:
            continue
        obs_manifest_rel = _v2_partition_manifest_rel(
            prefix=obs_prefix,
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant,
        )
        obs_payload, obs_err = _load_json_file(root / obs_manifest_rel)
        if obs_err or not isinstance(obs_payload, dict):
            gaps.append(_v2_aqi_gap(
                invalid_gap_type,
                day_utc=day_utc,
                connector_id=connector_id,
                pollutant_code=pollutant,
                expected_path=obs_manifest_rel,
                related_paths=[f"observation_manifest_{obs_err or 'not_object'}"],
            ))
            continue
        obs_rows = _manifest_row_count(obs_payload)
        obs_counts = _manifest_timeseries_row_counts(obs_payload)
        if obs_rows <= 0 and not obs_counts:
            continue

        aqi_manifest_rel = _v2_partition_manifest_rel(
            prefix=aqi_prefix,
            day_utc=day_utc,
            connector_id=connector_id,
            pollutant_code=pollutant,
        )
        aqi_manifest_path = root / aqi_manifest_rel
        if not aqi_manifest_path.is_file():
            gaps.append(_v2_aqi_gap(
                missing_manifest_gap_type,
                day_utc=day_utc,
                connector_id=connector_id,
                pollutant_code=pollutant,
                expected_path=aqi_manifest_rel,
                related_paths=[obs_manifest_rel, f"observation_rows={obs_rows}"],
            ))
            continue
        aqi_payload, aqi_err = _load_json_file(aqi_manifest_path)
        if aqi_err or not isinstance(aqi_payload, dict):
            gaps.append(_v2_aqi_gap(
                invalid_gap_type,
                day_utc=day_utc,
                connector_id=connector_id,
                pollutant_code=pollutant,
                expected_path=aqi_manifest_rel,
                related_paths=[obs_manifest_rel, f"aqi_manifest_{aqi_err or 'not_object'}"],
            ))
            continue

        aqi_rows = _manifest_row_count(aqi_payload)
        aqi_counts = _manifest_timeseries_row_counts(aqi_payload)
        low_reasons: list[str] = []
        if obs_rows > 0 and aqi_rows < obs_rows:
            low_reasons.append(f"row_count:{aqi_rows}<{obs_rows}")
        for timeseries_id, obs_count in sorted(obs_counts.items()):
            if obs_count <= 0:
                continue
            aqi_count = int(aqi_counts.get(timeseries_id, 0) or 0)
            if aqi_count < obs_count:
                low_reasons.append(f"timeseries_id={timeseries_id}:{aqi_count}<{obs_count}")
            if len(low_reasons) >= 25:
                break
        if low_reasons:
            gaps.append(_v2_aqi_gap(
                rows_low_gap_type,
                day_utc=day_utc,
                connector_id=connector_id,
                pollutant_code=pollutant,
                expected_path=aqi_manifest_rel,
                related_paths=[obs_manifest_rel, *low_reasons],
            ))
    return gaps


def _verify_v2_observation_manifest_content_for_aqi(
    *,
    day_utc: str,
    connector_id: int,
    env: Mapping[str, str],
    expected_timeseries_row_counts: Mapping[int, int],
    expected_pollutant_codes: Iterable[str],
    expected_min_rows: int,
) -> tuple[bool, str | None, dict[str, Any]]:
    manifest_key = _v2_observation_connector_manifest_key(
        day_utc=day_utc,
        connector_id=connector_id,
        env=env,
    )
    payload, source, err = _read_json_manifest_for_guard(
        manifest_key=manifest_key,
        env=env,
    )
    details: dict[str, Any] = {
        "manifest_key": manifest_key,
        "manifest_source": source,
        "expected_min_rows": int(expected_min_rows or 0),
        "expected_timeseries_count": len(expected_timeseries_row_counts),
        "expected_pollutant_codes": sorted({
            str(code).strip()
            for code in expected_pollutant_codes
            if str(code or "").strip()
        }),
    }
    if err is not None:
        details["error"] = err
        return False, f"manifest_read_failed:{err}", details
    if not isinstance(payload, dict):
        return False, "manifest_not_object", details
    if str(payload.get("history_version") or "v2") != "v2":
        return False, "manifest_history_version_mismatch", details
    if str(payload.get("domain") or "observations") != "observations":
        return False, "manifest_domain_mismatch", details
    if "day_utc" in payload and str(payload.get("day_utc")) != day_utc:
        return False, "manifest_day_mismatch", details
    if "connector_id" in payload:
        try:
            manifest_connector_id = int(payload.get("connector_id") or 0)
        except (TypeError, ValueError):
            manifest_connector_id = 0
        if manifest_connector_id != int(connector_id):
            return False, "manifest_connector_mismatch", details

    manifest_rows = _manifest_row_count(payload)
    manifest_counts = _manifest_timeseries_row_counts(payload)
    manifest_pollutants = _manifest_pollutant_codes(payload)
    details.update({
        "manifest_rows": manifest_rows,
        "manifest_timeseries_count": len(manifest_counts),
        "manifest_timeseries_row_counts": {
            str(timeseries_id): count
            for timeseries_id, count in sorted(manifest_counts.items())
        },
        "manifest_pollutant_codes": sorted(manifest_pollutants),
    })
    if expected_min_rows > 0 and manifest_rows < expected_min_rows:
        details["shortfall_rows"] = expected_min_rows - manifest_rows
        return False, "manifest_total_rows_below_expected", details

    missing_timeseries: list[int] = []
    low_count_timeseries: list[str] = []
    for raw_timeseries_id, raw_expected_count in expected_timeseries_row_counts.items():
        try:
            timeseries_id = int(raw_timeseries_id)
            expected_count = int(raw_expected_count)
        except (TypeError, ValueError):
            continue
        if expected_count <= 0:
            continue
        observed_count = int(manifest_counts.get(timeseries_id, 0) or 0)
        if observed_count <= 0:
            missing_timeseries.append(timeseries_id)
        elif observed_count < expected_count:
            low_count_timeseries.append(f"{timeseries_id}:{observed_count}<{expected_count}")
    if missing_timeseries:
        details["missing_timeseries_ids"] = missing_timeseries[:25]
        details["missing_timeseries_count"] = len(missing_timeseries)
        return False, "manifest_missing_timeseries", details
    if low_count_timeseries:
        details["low_count_timeseries"] = low_count_timeseries[:25]
        details["low_count_timeseries_count"] = len(low_count_timeseries)
        details["shortfall_rows"] = sum(
            max(0, int(expected_timeseries_row_counts[timeseries_id]) - int(manifest_counts.get(timeseries_id, 0) or 0))
            for timeseries_id in expected_timeseries_row_counts
        )
        return False, "manifest_timeseries_rows_below_expected", details

    expected_pollutants = set(details["expected_pollutant_codes"])
    missing_pollutants = sorted(expected_pollutants - manifest_pollutants)
    if missing_pollutants:
        details["missing_pollutant_codes"] = missing_pollutants
        return False, "manifest_missing_pollutant", details
    return True, None, details


def _timeseries_ids_for_v2_observation_gap(
    conn: sqlite3.Connection,
    *,
    connector_id: int,
    gap: Mapping[str, Any],
) -> list[int]:
    explicit_ids: set[int] = set()
    for raw_id in list(gap.get("missing_timeseries_ids") or []):
        try:
            timeseries_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if timeseries_id > 0:
            explicit_ids.add(timeseries_id)
    for row in list(gap.get("source_r2_mismatches") or []):
        if not isinstance(row, Mapping):
            continue
        try:
            timeseries_id = int(row.get("timeseries_id") or 0)
        except (TypeError, ValueError):
            continue
        if timeseries_id > 0:
            explicit_ids.add(timeseries_id)
    if not explicit_ids:
        for raw_id in list(gap.get("sample_missing_timeseries_ids") or []):
            try:
                timeseries_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            if timeseries_id > 0:
                explicit_ids.add(timeseries_id)
    if explicit_ids:
        return sorted(explicit_ids)
    pollutant_code = _uk_air_normalize_pollutant_code(gap.get("pollutant_code"))
    if pollutant_code and _table_exists(conn, "core_phenomena_snapshot"):
        rows = conn.execute(
            """
            SELECT t.id, p.label, p.source_label, p.pollutant_label
            FROM core_timeseries_snapshot t
            JOIN core_phenomena_snapshot p ON p.id = t.phenomenon_id
            WHERE t.connector_id = ?
              AND (t.ended_at IS NULL OR trim(t.ended_at) = '')
            ORDER BY t.id
            """,
            (int(connector_id),),
        ).fetchall()
        matched = [
            int(row[0])
            for row in rows
            if any(
                _uk_air_normalize_pollutant_code(value) == pollutant_code
                for value in row[1:]
            )
        ]
        if matched:
            return sorted(set(matched))
    return _timeseries_ids_for_connector(conn, connector_id)


def _sos_day_scoped_expected_counts(
    conn: sqlite3.Connection,
    *,
    day_utc: str,
    connector_id: int,
    timeseries_ids: Iterable[int],
) -> tuple[dict[int, int], list[str]]:
    requested_ids = sorted({int(value) for value in timeseries_ids if int(value) > 0})
    if not requested_ids:
        return {}, []
    placeholders = ",".join("?" for _ in requested_ids)
    rows = conn.execute(
        f"""
        SELECT
          c.timeseries_id,
          SUM(c.row_count) AS expected_rows,
          p.label,
          p.source_label,
          p.pollutant_label
        FROM source_file_timeseries_counts c
        JOIN source_file_state s ON s.source_file_key = c.source_file_key
        JOIN core_timeseries_snapshot t ON t.id = c.timeseries_id
        LEFT JOIN core_phenomena_snapshot p ON p.id = t.phenomenon_id
        WHERE c.day_utc = ?
          AND t.connector_id = ?
          AND c.timeseries_id IN ({placeholders})
          AND c.row_count > 0
          AND s.source_key = ?
          AND s.remote_scheme = 'uk_air_flat_file'
          AND s.exists_remote = 1
        GROUP BY c.timeseries_id, p.label, p.source_label, p.pollutant_label
        ORDER BY c.timeseries_id
        """,
        (day_utc, int(connector_id), *requested_ids, SOS_SOURCE_KEY),
    ).fetchall()
    counts: dict[int, int] = {}
    pollutants: set[str] = set()
    for row in rows:
        timeseries_id = int(row[0])
        counts[timeseries_id] = counts.get(timeseries_id, 0) + int(row[1] or 0)
        for raw_label in row[2:]:
            pollutant = _uk_air_normalize_pollutant_code(raw_label)
            if pollutant:
                pollutants.add(pollutant)
                break
    return counts, sorted(pollutants)


def run_cross_check_backfills(
    *,
    conn: sqlite3.Connection,
    run_id: int,
    env_name: str,
    run_compact: str,
    env: dict[str, str],
    source_filter: str,
    sos_metrics: Mapping[str, Any] | None,
    dry_run: bool,
    run_backfill: bool,
    limits: LimitTracker,
    log: logging.Logger,
    history_version: str = "v1",
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
        "cross_check_observation_repair_skipped_reason": None,
    }
    if not run_backfill:
        return metrics
    if str(history_version).strip().lower() == "v2":
        metrics["cross_check_observation_repair_skipped_reason"] = (
            "legacy cross_checks repair is not used in v2-only mode; "
            "v2 observation gaps are handled by run_v2_gap_backfills"
        )
        log.info(
            "cross-check observation repair: skipped legacy planner in v2-only mode; "
            "v2 gap repair planner will handle observation gaps"
        )
        return metrics

    cross_check_targets = _collect_cross_check_backfill_targets(
        conn,
        run_id=run_id,
        source_filter=source_filter,
    )
    source_change_targets: dict[tuple[str, int], list[int]] = {}
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
            env_name=env_name,
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
    history_version: str = "v1",
    env_name: str | None = None,
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
    wrapper_command = wrapper
    if wrapper_raw and Path(wrapper_raw).name == "uk_aq_integrity_backfill.sh":
        cli_parts = [
            shlex.quote(wrapper),
            "--env",
            shlex.quote(str(env_name or env.get("UK_AQ_ENV_NAME") or os.environ.get("UK_AQ_ENV_NAME") or "<env unset>")),
            "--aqi-only",
            "--history-version",
            shlex.quote(str(history_version)),
            "--from-day",
            iso,
            "--to-day",
            iso,
        ]
        if connector_id is not None and int(connector_id) > 0:
            cli_parts.extend(["--connector-id", str(int(connector_id))])
        wrapper_command = " ".join(cli_parts)
    return (
        f"UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels "
        f"UK_AQ_BACKFILL_DRY_RUN=false "
        f"UK_AQ_BACKFILL_FORCE_REPLACE=true "
        f"UK_AQ_R2_HISTORY_VERSION={history_version} "
        f"UK_AQ_R2_HISTORY_INDEX_VERSION={history_version} "
        f"UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only "
        f"{connector_scope}"
        f"UK_AQ_BACKFILL_FROM_DAY_UTC={iso} "
        f"UK_AQ_BACKFILL_TO_DAY_UTC={iso} "
        f"UK_AQ_BACKFILL_ENV_FILE={env_file} "
        f"{wrapper_command}"
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
    history_version: str = "v1",
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
        "UK_AQ_R2_HISTORY_VERSION": history_version,
        "UK_AQ_R2_HISTORY_INDEX_VERSION": history_version,
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
            "--history-version",
            history_version,
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




def _timeseries_ids_for_connector(conn: sqlite3.Connection, connector_id: int) -> list[int]:
    rows = conn.execute(
        """
        SELECT id
        FROM core_timeseries_snapshot
        WHERE connector_id = ?
          AND (ended_at IS NULL OR TRIM(ended_at) = '')
        ORDER BY id
        """,
        (int(connector_id),),
    ).fetchall()
    return [int(row[0]) for row in rows if row and int(row[0]) > 0]


def _connector_ids_for_timeseries(
    conn: sqlite3.Connection,
    timeseries_ids: Iterable[int],
) -> list[int]:
    ids = sorted({int(ts_id) for ts_id in timeseries_ids if int(ts_id) > 0})
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    try:
        rows = conn.execute(
            f"""
            SELECT DISTINCT connector_id
            FROM core_timeseries_snapshot
            WHERE id IN ({placeholders})
              AND connector_id IS NOT NULL
              AND (ended_at IS NULL OR TRIM(ended_at) = '')
            ORDER BY connector_id
            """,
            ids,
        ).fetchall()
    except sqlite3.Error:
        return []
    return [int(row[0]) for row in rows if row and int(row[0]) > 0]


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def _source_file_key_for_lookup_row(source_key: str, source_location_id: str, day: dt.date) -> str | None:
    if source_key == OPENAQ_SOURCE_KEY:
        return _openaq_source_file_key(source_location_id, day)
    if source_key == SC_SOURCE_KEY:
        return _sc_source_file_key(source_location_id, day)
    if source_key == SOS_SOURCE_KEY:
        return _sos_source_file_key(source_location_id, day)
    return None


def _source_cache_status_for_connector_day(
    conn: sqlite3.Connection,
    *,
    connector_id: int,
    day: dt.date,
) -> dict[str, Any]:
    if not _table_exists(conn, "source_station_timeseries_lookup") or not _table_exists(conn, "source_file_state"):
        return {"status": "not_checked", "reason": "source state tables unavailable"}

    lookup_rows = conn.execute(
        """
        SELECT DISTINCT source_key, source_location_id
        FROM source_station_timeseries_lookup
        WHERE connector_id = ?
          AND is_active = 1
          AND source_location_id IS NOT NULL
        ORDER BY source_key, source_location_id
        """,
        (int(connector_id),),
    ).fetchall()
    has_sos_source = any(str(row[0]) == SOS_SOURCE_KEY for row in lookup_rows)
    if (
        has_sos_source
        and _table_exists(conn, "source_file_timeseries_counts")
        and _table_exists(conn, "core_timeseries_snapshot")
    ):
        flat_rows = conn.execute(
            """
            SELECT
              s.source_file_key,
              s.local_cached_path,
              c.timeseries_id,
              c.row_count
            FROM source_file_timeseries_counts c
            JOIN source_file_state s
              ON s.source_file_key = c.source_file_key
            JOIN core_timeseries_snapshot t
              ON t.id = c.timeseries_id
            WHERE t.connector_id = ?
              AND c.day_utc = ?
              AND c.row_count > 0
              AND s.source_key = ?
              AND s.remote_scheme = 'uk_air_flat_file'
              AND s.exists_remote = 1
              AND s.last_status IN (
                'unchanged', 'changed', 'first_seen', 'reappeared',
                'unmapped_source', 'mixed_mapping_issues'
              )
            ORDER BY s.source_file_key, c.timeseries_id
            """,
            (int(connector_id), day.isoformat(), SOS_SOURCE_KEY),
        ).fetchall()
        if flat_rows:
            source_files = {str(row[0]) for row in flat_rows}
            cached_files = {
                str(row[0])
                for row in flat_rows
                if str(row[1] or "").strip()
                and Path(str(row[1])).is_file()
            }
            return {
                "status": "ok",
                "source_mode": "uk_air_flat_files",
                "source_file_count": len(source_files),
                "remote_exists": len(source_files),
                "cached": len(cached_files),
                "timeseries_count": len({int(row[2]) for row in flat_rows}),
                "source_rows": sum(int(row[3] or 0) for row in flat_rows),
                "evidence_day_utc": day.isoformat(),
            }

        flat_file_count = int(conn.execute(
            """
            SELECT COUNT(*)
            FROM source_file_state
            WHERE source_key = ?
              AND remote_scheme = 'uk_air_flat_file'
              AND exists_remote = 1
              AND source_file_key LIKE ?
            """,
            (SOS_SOURCE_KEY, f"sos:site_ref=%:year={day.year}"),
        ).fetchone()[0] or 0)
        if flat_file_count > 0:
            return {
                "status": "unavailable",
                "source_mode": "uk_air_flat_files",
                "reason": "no mapped UK-AIR flat-file source counts exist for connector/day",
                "source_file_count": flat_file_count,
                "evidence_day_utc": day.isoformat(),
            }

    source_keys = [
        _source_file_key_for_lookup_row(str(row[0]), str(row[1]), day)
        for row in lookup_rows
    ]
    source_keys = [key for key in source_keys if key]
    if not source_keys:
        return {"status": "unavailable", "reason": "no active source files resolved for connector/day"}

    remote_exists = 0
    cached = 0
    download_failed = 0
    missing = 0
    absent_state = 0
    for source_file_key in source_keys:
        row = conn.execute(
            """
            SELECT exists_remote, local_cached_path, last_status
            FROM source_file_state
            WHERE source_file_key = ?
            """,
            (source_file_key,),
        ).fetchone()
        if row is None:
            absent_state += 1
            continue
        exists_remote = int(row[0] or 0)
        last_status = str(row[2] or "")
        if exists_remote == 1:
            remote_exists += 1
            local_cached_path = str(row[1] or "").strip()
            if local_cached_path and Path(local_cached_path).is_file():
                cached += 1
            if last_status == "download_failed":
                download_failed += 1
        else:
            missing += 1

    if remote_exists <= 0:
        return {
            "status": "unavailable",
            "reason": "no remote source files exist for connector/day",
            "source_file_count": len(source_keys),
            "missing": missing,
            "absent_state": absent_state,
        }
    if cached < remote_exists:
        return {
            "status": "download_failed" if download_failed else "cache_missing",
            "reason": "remote source files exist but local cache is incomplete",
            "source_file_count": len(source_keys),
            "remote_exists": remote_exists,
            "cached": cached,
            "download_failed": download_failed,
            "missing": missing,
            "absent_state": absent_state,
        }
    return {
        "status": "ok",
        "source_file_count": len(source_keys),
        "remote_exists": remote_exists,
        "cached": cached,
        "download_failed": download_failed,
        "missing": missing,
        "absent_state": absent_state,
    }


def _set_v2_source_repair_plan(
    gap: dict[str, Any],
    *,
    status: str,
    command: str | None,
    source_cache_status: Mapping[str, Any] | None,
) -> None:
    evidence = gap.setdefault("source_evidence", {})
    if source_cache_status is not None:
        evidence["source_cache_status"] = dict(source_cache_status)
    if status == "ready":
        gap["suggested_repair"] = {
            "kind": "source_to_v2_observations_backfill",
            "requires_index_rebuild": True,
            "commands": [command] if command else [],
            "executes": False,
            "operator_action_required": False,
            "write_risk": "writes_to_r2_when_run_backfill_is_enabled",
            "steps": [
                "Use the normal source-to-R2 backfill wrapper with --history-version v2.",
                "Rebuild the affected v2 observations timeseries index after observations are written.",
                "Queue connector-scoped v2 AQI rebuild only after the observation repair succeeds.",
            ],
            "notes": "Source cache for the connector/day is available; no v1 Dropbox evidence is required.",
        }
    elif status == "planned_after_obs_repair":
        gap["suggested_repair"] = {
            "kind": "source_to_v2_observations_backfill_planned",
            "requires_index_rebuild": True,
            "commands": [command] if command else [],
            "executes": False,
            "operator_action_required": False,
            "write_risk": "dry_run_only",
            "steps": [
                "Dry-run plan: source-to-v2 observation repair would run with --history-version v2.",
                "AQI rebuild would be queued only after a successful observation repair.",
            ],
            "notes": "Dry-run planning does not claim obs_repaired.",
        }
    else:
        reason = ""
        if source_cache_status is not None:
            reason = str(source_cache_status.get("reason") or source_cache_status.get("status") or "")
        gap["suggested_repair"] = {
            "kind": "source_cache_required_for_v2_observations_backfill",
            "requires_index_rebuild": True,
            "commands": [],
            "executes": False,
            "operator_action_required": True,
            "write_risk": "none",
            "steps": [
                "Refresh/check the upstream source cache for the affected connector/day.",
                "Retry the v2 source-to-R2 observation repair after source cache is available.",
            ],
            "notes": reason or "Source cache is not available for this connector/day.",
        }


def _v2_observations_index_rebuild_command(
    day_utc: str,
    connector_id: int,
) -> list[str]:
    return [
        "node",
        "scripts/backup_r2/uk_aq_build_r2_history_index.mjs",
        "--history-version", "v2",
        "--targeted",
        "--kind", "observations",
        "--from-day", day_utc,
        "--to-day", day_utc,
        "--connector-id", str(int(connector_id)),
    ]


def run_v2_gap_backfills(
    *,
    conn: sqlite3.Connection,
    run_id: int,
    env_name: str,
    run_compact: str,
    env: dict[str, str],
    v2_observations: Mapping[str, Any],
    dry_run: bool,
    run_backfill: bool,
    limits: LimitTracker,
    log: logging.Logger,
) -> dict[str, Any]:
    """Execute direct source -> v2 observation repairs for missing v2 gaps.

    The lower-level supported contract is UK_AQ_R2_HISTORY_VERSION=v2
    and UK_AQ_R2_HISTORY_INDEX_VERSION=v2;
    the integrity shell wrapper forwards these and calls the v2-aware targeted
    index builder with --history-version v2. This intentionally does not use
    any v1-to-v2 Dropbox conversion plan.
    """
    metrics: dict[str, Any] = {
        "v2_observation_repairs_attempted": 0,
        "v2_observation_repairs_ok": 0,
        "v2_observation_repairs_failed": 0,
        "v2_observation_repairs_no_rows": 0,
        "v2_observation_repairs_guard_failed": 0,
        "observation_backfills_attempted": 0,
        "observation_backfills_ok": 0,
        "observation_backfills_failed": 0,
        "v2_observation_index_rebuilds_attempted": 0,
        "v2_observation_index_rebuilds_ok": 0,
        "v2_observation_index_rebuilds_failed": 0,
        "v2_observation_repairs_source_unavailable": 0,
        "v2_observation_repairs_source_download_failed": 0,
        "v2_observation_repair_chunk_size": _v2_observation_repair_chunk_size(),
        "planned_v2_observation_repairs": [],
        "planned_v2_observation_index_rebuilds": [],
        "skipped_v2_observation_repairs": [],
        "v2_observation_repair_results": [],
        "aqi_rebuilds_queued_from_obs_repair": 0,
        "planned_aqi_rebuilds": [],
        "planned_aqi_rebuild_connector_days": [],
        "unsupported_v2_backfill": False,
    }
    if not run_backfill:
        return metrics
    gaps = list(v2_observations.get("gaps") or [])
    if not gaps:
        return metrics
    by_key_sets: dict[tuple[str, int], set[int]] = {}
    gaps_by_key: dict[tuple[str, int], list[dict[str, Any]]] = {}
    index_only_keys: set[tuple[str, int]] = set()
    for gap in gaps:
        day_iso = str(gap.get("day_utc") or "").strip()
        try:
            connector_id = int(gap.get("connector_id"))
        except (TypeError, ValueError):
            continue
        if not day_iso or connector_id <= 0:
            continue
        if (
            str(gap.get("gap_type") or "").startswith("index_")
            or str((gap.get("suggested_repair") or {}).get("kind") or "")
            == "rebuild_v2_observations_index_only"
        ):
            index_only_keys.add((day_iso, connector_id))
            continue
        ts_ids = _timeseries_ids_for_v2_observation_gap(
            conn,
            connector_id=connector_id,
            gap=gap,
        )
        if ts_ids:
            by_key_sets.setdefault((day_iso, connector_id), set()).update(ts_ids)
            gaps_by_key.setdefault((day_iso, connector_id), []).append(gap)
    by_key = {key: sorted(values) for key, values in by_key_sets.items()}
    standalone_index_keys = sorted(index_only_keys - set(by_key))
    metrics["observation_backfill_candidate_days"] = len(by_key)
    metrics["observation_backfill_candidate_timeseries_ids"] = sum(len(ids) for ids in by_key.values())
    metrics["backfill_candidate_days"] = metrics["observation_backfill_candidate_days"]
    metrics["backfill_candidate_timeseries_ids"] = metrics["observation_backfill_candidate_timeseries_ids"]
    backfill_log_dir = Path(env["UK_AQ_HISTORY_INTEGRITY_LOG_DIR"]) / "backfill" / run_compact
    queued: set[tuple[str, int]] = set()
    for day_iso, connector_id in standalone_index_keys:
        idx_cmd = _v2_observations_index_rebuild_command(day_iso, connector_id)
        metrics["planned_v2_observation_index_rebuilds"].append(" ".join(idx_cmd))
        if dry_run:
            continue
        metrics["v2_observation_index_rebuilds_attempted"] += 1
        result = subprocess.run(
            idx_cmd,
            cwd=Path(__file__).resolve().parents[3],
            env={**os.environ, **env},
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            metrics["v2_observation_index_rebuilds_ok"] += 1
        else:
            metrics["v2_observation_index_rebuilds_failed"] += 1
            log.warning(
                "v2 observation index-only rebuild failed day=%s connector_id=%s exit_code=%s stderr=%s",
                day_iso,
                connector_id,
                result.returncode,
                _truncate_text(result.stderr or result.stdout or "", 2000),
            )
    for (day_iso, connector_id), ts_ids in sorted(by_key.items()):
        day_obj = dt.date.fromisoformat(day_iso)
        chunks = _chunk_v2_observation_repair_timeseries_ids(ts_ids)
        planned_cmds = [
            _planned_backfill_command(env, chunk_ids, day_obj, connector_ids=[connector_id], output_scope="observations_only", history_version="v2", env_name=env_name)
            for chunk_ids in chunks
        ]
        first_cmd = planned_cmds[0] if planned_cmds else None
        idx_cmd = " ".join(_v2_observations_index_rebuild_command(day_iso, connector_id))
        if dry_run:
            metrics["planned_v2_observation_repairs"].extend(planned_cmds)
            metrics["planned_v2_observation_index_rebuilds"].append(idx_cmd)
            metrics["planned_aqi_rebuilds"].append(f"connector_id={connector_id} day_utc={day_iso} reason=planned_after_obs_repair history_version=v2")
            metrics["planned_aqi_rebuild_connector_days"].append({"day_utc": day_iso, "connector_id": connector_id, "reasons": ["planned_after_obs_repair"], "history_version": "v2"})
            for gap in gaps_by_key.get((day_iso, connector_id), []):
                _set_v2_source_repair_plan(gap, status="planned_after_obs_repair", command=first_cmd, source_cache_status=None)
            queued.add((day_iso, connector_id))
            continue
        if limits.should_stop():
            break
        source_cache_status = _source_cache_status_for_connector_day(
            conn,
            connector_id=connector_id,
            day=day_obj,
        )
        if source_cache_status.get("status") not in {"ok", "not_checked"}:
            log.warning(
                "v2 observation repair will run despite source cache status day=%s connector_id=%s source_status=%s reason=%s",
                day_iso,
                connector_id,
                source_cache_status.get("status"),
                source_cache_status.get("reason"),
            )
        metrics["planned_v2_observation_repairs"].extend(planned_cmds)
        metrics["planned_v2_observation_index_rebuilds"].append(idx_cmd)
        for gap in gaps_by_key.get((day_iso, connector_id), []):
            _set_v2_source_repair_plan(gap, status="ready", command=first_cmd, source_cache_status=source_cache_status)
        chunk_results: list[dict[str, Any]] = []
        stage_root = (
            backfill_log_dir
            / "_targeted_stage"
            / f"v2_run_{run_id}"
            / f"day_{day_iso}"
            / f"connector_{connector_id}"
        )
        if len(chunks) > 1:
            shutil.rmtree(stage_root, ignore_errors=True)
        for chunk_index, chunk_ids in enumerate(chunks, start=1):
            if limits.should_stop():
                break
            chunk_label = f"v2_obs_day_{day_iso}_connector_{connector_id}"
            if len(chunks) > 1:
                chunk_label = f"{chunk_label}_chunk_{chunk_index:03d}_of_{len(chunks):03d}"
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
                history_version="v2",
                extra_env=extra_env,
            )
            chunk_results.append(bf)
            metrics["v2_observation_repairs_attempted"] += 1
            metrics["observation_backfills_attempted"] += 1
            metrics["v2_observation_index_rebuilds_attempted"] += 1
            if bf.get("status") == "ok":
                metrics["v2_observation_index_rebuilds_ok"] += 1
            else:
                metrics["v2_observation_repairs_failed"] += 1
                metrics["observation_backfills_failed"] += 1
                metrics["v2_observation_index_rebuilds_failed"] += 1
                break
        combined = _combine_backfill_results(chunk_results)
        wrapper_ok = bool(chunk_results) and all((r.get("status") == "ok") for r in chunk_results)
        repaired_observation_rows = int(combined.get("rows_observations") or 0)
        complete_events = int(combined.get("source_connector_day_complete_events") or 0)
        skipped_events = int(combined.get("source_connector_day_skipped_events") or 0)
        pending_events = int(combined.get("source_connector_day_pending_events") or 0)
        failed_events = int(combined.get("source_connector_day_failed_events") or 0)
        backfill_run_status = combined.get("backfill_run_status")
        pending_days = list(combined.get("source_acquisition_pending_days") or [])
        process_guard_ok, process_guard_reason = _validate_chunked_v2_observation_repair_for_aqi(
            chunk_count=len(chunks),
            chunk_results=chunk_results,
            repaired_observation_rows=repaired_observation_rows,
        )
        source_timeseries_row_counts = _normalize_timeseries_row_counts(
            combined.get("source_timeseries_row_counts")
        )
        repaired_timeseries_row_counts = _normalize_timeseries_row_counts(
            combined.get("repaired_timeseries_row_counts")
            or combined.get("written_timeseries_row_counts")
            or combined.get("observation_timeseries_row_counts")
        )
        source_pollutant_codes = list(combined.get("source_pollutant_codes") or [])
        source_rows_from_counts = sum(source_timeseries_row_counts.values())
        source_scope = v2_observations.get("source_scope")
        sos_scope = isinstance(source_scope, Mapping) and str(source_scope.get("source") or "").strip().lower() == "sos"
        expected_timeseries_row_counts = repaired_timeseries_row_counts
        expected_pollutant_codes = source_pollutant_codes
        expected_counts_source = "backfill_repaired_rows"
        expected_counts_scope_valid = True
        if sos_scope:
            expected_timeseries_row_counts, expected_pollutant_codes = (
                _sos_day_scoped_expected_counts(
                    conn,
                    day_utc=day_iso,
                    connector_id=connector_id,
                    timeseries_ids=ts_ids,
                )
            )
            expected_counts_source = "source_file_timeseries_counts"
            expected_counts_scope_valid = bool(expected_timeseries_row_counts) and bool(
                expected_pollutant_codes
            )
        expected_min_manifest_rows = sum(expected_timeseries_row_counts.values())
        if not sos_scope:
            expected_min_manifest_rows = max(
                expected_min_manifest_rows,
                repaired_observation_rows,
            )
        source_pending = wrapper_ok and (
            pending_events > 0
            or str(backfill_run_status or "").strip() == "stubbed"
            or len(pending_days) > 0
        )
        no_observation_rows = (
            wrapper_ok
            and not source_pending
            and failed_events <= 0
            and repaired_observation_rows <= 0
            and (complete_events > 0 or skipped_events > 0)
        )
        manifest_guard_ok = True
        manifest_guard_reason: str | None = None
        manifest_guard_details: dict[str, Any] = {}
        should_verify_manifest = (
            wrapper_ok
            and not source_pending
            and failed_events <= 0
            and repaired_observation_rows > 0
            and process_guard_ok
        )
        if should_verify_manifest:
            if not expected_counts_scope_valid:
                manifest_guard_ok = False
                manifest_guard_reason = "expected_counts_scope_invalid"
                manifest_guard_details = {
                    "requested_day": day_iso,
                    "requested_connector_id": connector_id,
                    "requested_timeseries_count": len(ts_ids),
                    "expected_counts_source": expected_counts_source,
                }
            else:
                manifest_guard_ok, manifest_guard_reason, manifest_guard_details = (
                    _verify_v2_observation_manifest_content_for_aqi(
                        day_utc=day_iso,
                        connector_id=connector_id,
                        env=env,
                        expected_timeseries_row_counts=expected_timeseries_row_counts,
                        expected_pollutant_codes=expected_pollutant_codes,
                        expected_min_rows=expected_min_manifest_rows,
                    )
                )
            manifest_guard_details.update({
                "requested_day": day_iso,
                "requested_connector_id": connector_id,
                "requested_timeseries_count": len(ts_ids),
                "expected_counts_source": expected_counts_source,
                "expected_source_rows_for_day": expected_min_manifest_rows,
                "expected_timeseries_row_counts_for_day": {
                    str(timeseries_id): count
                    for timeseries_id, count in sorted(expected_timeseries_row_counts.items())
                },
                "repair_output_rows": repaired_observation_rows,
            })
            log.info(
                "v2 observation manifest guard day=%s connector_id=%s requested_timeseries=%s expected_rows=%s repair_output_rows=%s manifest_rows=%s result=%s reason=%s",
                day_iso,
                connector_id,
                len(ts_ids),
                expected_min_manifest_rows,
                repaired_observation_rows,
                manifest_guard_details.get("manifest_rows"),
                "pass" if manifest_guard_ok else "fail",
                manifest_guard_reason,
            )
        repair_ok = (
            wrapper_ok
            and not source_pending
            and failed_events <= 0
            and repaired_observation_rows > 0
            and process_guard_ok
            and manifest_guard_ok
        )
        if source_pending:
            repair_status = "source_pending"
        elif repair_ok:
            repair_status = "ok"
        elif no_observation_rows:
            repair_status = "no_observations"
        elif wrapper_ok and repaired_observation_rows > 0 and (
            not process_guard_ok
            or not manifest_guard_ok
        ):
            repair_status = "guard_failed"
        else:
            repair_status = "failed"
        repair_entry = {
            "day_utc": day_iso,
            "connector_id": connector_id,
            "history_version": "v2",
            "status": repair_status,
            "wrapper_status": combined.get("status"),
            "exit_code": combined.get("exit_code"),
            "error": combined.get("error"),
            "stdout_tail": combined.get("stdout_tail") or "",
            "stderr_tail": combined.get("stderr_tail") or "",
            "log_path": combined.get("log_path"),
            "rows_observations": repaired_observation_rows,
            "source_connector_day_complete_events": complete_events,
            "source_connector_day_skipped_events": skipped_events,
            "source_connector_day_pending_events": pending_events,
            "source_connector_day_failed_events": failed_events,
            "source_to_r2_targeted_stage_deferred_commit_events": int(combined.get("source_to_r2_targeted_stage_deferred_commit_events") or 0),
            "targeted_stage_deferred_rows_observations": int(combined.get("targeted_stage_deferred_rows_observations") or 0),
            "max_targeted_stage_deferred_rows_observations": int(combined.get("max_targeted_stage_deferred_rows_observations") or 0),
            "source_timeseries_row_counts": {
                str(timeseries_id): count
                for timeseries_id, count in sorted(source_timeseries_row_counts.items())
            },
            "repaired_timeseries_row_counts": {
                str(timeseries_id): count
                for timeseries_id, count in sorted(repaired_timeseries_row_counts.items())
            },
            "source_pollutant_codes": sorted({str(code) for code in source_pollutant_codes}),
            "source_mapped_rows": int(combined.get("source_mapped_rows") or 0),
            "source_rows_from_counts": source_rows_from_counts,
            "expected_counts_source": expected_counts_source,
            "expected_source_rows_for_day": expected_min_manifest_rows,
            "expected_timeseries_row_counts_for_day": {
                str(timeseries_id): count
                for timeseries_id, count in sorted(expected_timeseries_row_counts.items())
            },
            "expected_pollutant_codes": sorted({str(code) for code in expected_pollutant_codes}),
            "aqi_rebuild_guard_ok": (
                process_guard_ok
                and manifest_guard_ok
            ),
            "aqi_rebuild_guard_reason": (
                process_guard_reason
                or manifest_guard_reason
            ),
            "aqi_rebuild_process_guard_ok": process_guard_ok,
            "aqi_rebuild_process_guard_reason": process_guard_reason,
            "aqi_rebuild_manifest_guard_ok": manifest_guard_ok,
            "aqi_rebuild_manifest_guard_reason": manifest_guard_reason,
            "aqi_rebuild_manifest_guard": manifest_guard_details,
            "backfill_run_status": backfill_run_status,
            "source_acquisition_pending_days": pending_days,
            "timeseries_id_count": len(ts_ids),
            "chunk_count": len(chunks),
            "attempted_chunks": len(chunk_results),
            "ok_chunks": sum(1 for r in chunk_results if r.get("status") == "ok"),
            "failed_chunks": sum(1 for r in chunk_results if r.get("status") != "ok"),
            "source_cache": source_cache_status,
            "chunks": [
                {
                    "chunk_index": i,
                    "chunk_timeseries_ids": list(chunks[i - 1]) if i - 1 < len(chunks) else [],
                    "timeseries_id_count": len(chunks[i - 1]) if i - 1 < len(chunks) else None,
                    "chunk_expected_counts": {
                        str(timeseries_id): expected_timeseries_row_counts[timeseries_id]
                        for timeseries_id in (chunks[i - 1] if i - 1 < len(chunks) else [])
                        if timeseries_id in expected_timeseries_row_counts
                    },
                    "chunk_expected_rows": sum(
                        expected_timeseries_row_counts.get(timeseries_id, 0)
                        for timeseries_id in (chunks[i - 1] if i - 1 < len(chunks) else [])
                    ),
                    "status": result.get("status"),
                    "exit_code": result.get("exit_code"),
                    "error": result.get("error"),
                    "stdout_tail": result.get("stdout_tail") or "",
                    "stderr_tail": result.get("stderr_tail") or "",
                    "log_path": result.get("log_path"),
                    "rows_observations": int(result.get("rows_observations") or 0),
                    "source_connector_day_complete_events": int(result.get("source_connector_day_complete_events") or 0),
                    "source_connector_day_skipped_events": int(result.get("source_connector_day_skipped_events") or 0),
                    "source_connector_day_pending_events": int(result.get("source_connector_day_pending_events") or 0),
                    "source_connector_day_failed_events": int(result.get("source_connector_day_failed_events") or 0),
                    "source_to_r2_targeted_stage_deferred_commit_events": int(result.get("source_to_r2_targeted_stage_deferred_commit_events") or 0),
                    "targeted_stage_deferred_rows_observations": int(result.get("targeted_stage_deferred_rows_observations") or 0),
                    "max_targeted_stage_deferred_rows_observations": int(result.get("max_targeted_stage_deferred_rows_observations") or 0),
                    "source_timeseries_row_counts": {
                        str(timeseries_id): count
                        for timeseries_id, count in sorted(
                            _normalize_timeseries_row_counts(result.get("source_timeseries_row_counts")).items()
                        )
                    },
                    "source_pollutant_codes": list(result.get("source_pollutant_codes") or []),
                    "source_mapped_rows": int(result.get("source_mapped_rows") or 0),
                    "backfill_run_status": result.get("backfill_run_status"),
                    "source_acquisition_pending_days": list(result.get("source_acquisition_pending_days") or []),
                }
                for i, result in enumerate(chunk_results, start=1)
            ],
        }
        metrics["v2_observation_repair_results"].append(repair_entry)
        if repair_ok:
            metrics["v2_observation_repairs_ok"] += 1
            metrics["observation_backfills_ok"] += 1
            action = _queue_aqi_rebuild_from_obs_repair(conn=conn, run_id=run_id, env_name=env_name, connector_id=connector_id, day_utc=day_iso, requested_timeseries_ids=ts_ids, queue_note="queued_from_v2_observation_repair", log=log, history_version="v2")
            if action in {"inserted", "merged"}:
                queued.add((day_iso, connector_id))
            metrics["planned_aqi_rebuilds"].append(f"connector_id={connector_id} day_utc={day_iso} reason=obs_repaired history_version=v2")
            metrics["planned_aqi_rebuild_connector_days"].append({"day_utc": day_iso, "connector_id": connector_id, "reasons": ["obs_repaired"], "history_version": "v2"})
        elif no_observation_rows:
            metrics["v2_observation_repairs_no_rows"] += 1
            log.warning(
                "v2 observation repair wrote no rows day=%s connector_id=%s attempted_chunks=%s complete_events=%s; AQI rebuild not queued",
                day_iso,
                connector_id,
                repair_entry["attempted_chunks"],
                complete_events,
            )
        elif source_pending:
            metrics["v2_observation_repairs_source_unavailable"] += 1
            log.warning(
                "v2 observation repair pending source acquisition day=%s connector_id=%s attempted_chunks=%s pending_events=%s pending_days=%s; AQI rebuild not queued",
                day_iso,
                connector_id,
                repair_entry["attempted_chunks"],
                pending_events,
                pending_days,
            )
        elif repair_status == "guard_failed":
            metrics["v2_observation_repairs_guard_failed"] += 1
            metrics["v2_observation_repairs_failed"] += 1
            metrics["observation_backfills_failed"] += 1
            log.warning(
                "v2 observation repair blocked AQI rebuild by guard day=%s connector_id=%s attempted_chunks=%s reason=%s; AQI rebuild not queued",
                day_iso,
                connector_id,
                repair_entry["attempted_chunks"],
                repair_entry["aqi_rebuild_guard_reason"],
            )
        else:
            if wrapper_ok:
                metrics["v2_observation_repairs_failed"] += 1
                metrics["observation_backfills_failed"] += 1
            log.warning(
                "v2 observation repair failed day=%s connector_id=%s attempted_chunks=%s failed_chunks=%s exit_code=%s error=%s",
                day_iso,
                connector_id,
                repair_entry["attempted_chunks"],
                repair_entry["failed_chunks"],
                repair_entry["exit_code"],
                repair_entry["error"],
            )
    metrics["aqi_rebuilds_queued_from_obs_repair"] = len(queued)
    return metrics

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
    history_version: str = "v1",
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "aqi_rebuild_ran": False,
        "aqi_rebuild_skipped_reason": None,
        "aqi_rebuilds_queued_total": 0,
        "aqi_rebuilds_attempted": 0,
        "aqi_rebuilds_complete": 0,
        "aqi_rebuilds_failed": 0,
        "aqi_rebuilds_skipped": 0,
        "aqi_post_rebuild_validation_failed": 0,
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

    by_key: dict[tuple[str, int | None], list[tuple[Any, ...]]] = {}
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
        connector_scope = parsed_connector_id if history_version == "v2" else None
        by_key.setdefault((day_iso, connector_scope), []).append(row)

    metrics["aqi_rebuilds_queued_total"] = len(by_key)
    if dry_run and metrics["aqi_rebuilds_queued_total"] == 0 and dry_run_planned_rows:
        seed_by_key: dict[tuple[str, int | None], dict[str, Any]] = {}
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
            connector_scope = connector_id if history_version == "v2" else None
            seed_key = (day_iso, connector_scope)
            current = seed_by_key.get(seed_key)
            row_reasons = _parse_reason_tokens(",".join(str(v) for v in (row.get("reasons") or [])))
            if not row_reasons and row.get("reason"):
                row_reasons = _parse_reason_tokens(str(row.get("reason")))
            if current is None:
                seed_by_key[seed_key] = {
                    "day_utc": day_iso,
                    "connector_ids": [connector_id],
                    "connector_scope": connector_scope,
                    "reasons": sorted(row_reasons),
                }
                continue
            merged = _parse_reason_tokens(",".join(current.get("reasons") or []))
            merged.update(row_reasons)
            current["reasons"] = sorted(merged)
            if connector_id not in current["connector_ids"]:
                current["connector_ids"].append(connector_id)

        for (day_iso, connector_scope), seed in sorted(seed_by_key.items(), key=lambda item: (item[0][0], int(item[0][1] or 0))):
            connector_ids = sorted(int(v) for v in seed.get("connector_ids") or [])
            planned_cmd = _planned_aqi_rebuild_command(
                env,
                connector_scope,
                dt.date.fromisoformat(day_iso),
                history_version=history_version,
                env_name=env_name,
            )
            metrics["planned_aqi_rebuild_commands"].append(planned_cmd)
            metrics["aqi_rebuild_results"].append({
                "queue_row_ids": [],
                "connector_id": connector_scope,
                "connector_ids": connector_ids,
                "day_utc": day_iso,
                "reasons": seed.get("reasons") or [],
                "status": "planned",
                "source_mode": "live_r2",
                "error": None,
                "log_path": None,
            })
        metrics["aqi_rebuilds_queued_total"] = len(seed_by_key)
        metrics["aqi_rebuild_ran"] = True
        return metrics

    if not by_key:
        metrics["aqi_rebuild_ran"] = True
        return metrics

    backfill_log_dir = (
        Path(env["UK_AQ_HISTORY_INTEGRITY_LOG_DIR"]) / "backfill" / run_compact
    )
    for (day_iso, connector_scope), rows_for_key in sorted(by_key.items(), key=lambda item: (item[0][0], int(item[0][1] or 0))):
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

        planned_cmd = _planned_aqi_rebuild_command(
            env,
            connector_scope,
            day_obj,
            history_version=history_version,
            env_name=env_name,
        )
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
                "connector_id": connector_scope,
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
                "connector_id": connector_scope,
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
            connector_id=connector_scope,
            day=day_obj,
            log=log,
            log_dir=backfill_log_dir,
            log_label=(
                f"aqi_day_{day_iso}_connector_{connector_scope}"
                if connector_scope is not None
                else f"aqi_day_{day_iso}_all_connectors"
            ),
            history_version=history_version,
        )
        metrics["aqi_rebuilds_attempted"] += 1

        finished_iso = fmt_iso(utc_now())
        post_validation_gaps: list[dict[str, Any]] = []
        if (
            bf.get("status") == "ok"
            and history_version == "v2"
            and connector_scope is not None
            and (
                "obs_repaired" in merged_reasons
                or AQI_INTEGRITY_OBS_COVERAGE_REASON in merged_reasons
            )
        ):
            root_raw = resolve_r2_history_root({**os.environ, **env})
            if root_raw:
                post_validation_gaps = _v2_aqi_observation_coverage_gaps(
                    root=Path(root_raw),
                    config=resolve_history_path_config("v2", env),
                    day_utc=day_iso,
                    connector_id=int(connector_scope),
                    conn=conn,
                    missing_observations_gap_type="aqi_missing_after_obs_repair",
                )
            else:
                post_validation_gaps = [_v2_aqi_gap(
                    "aqi_post_rebuild_validation_failed",
                    day_utc=day_iso,
                    connector_id=connector_scope,
                    related_paths=["UK_AQ_R2_HISTORY_DROPBOX_ROOT is not set"],
                )]

        if bf.get("status") == "ok" and not post_validation_gaps:
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
            if post_validation_gaps:
                metrics["aqi_post_rebuild_validation_failed"] += 1
                gap_types = ",".join(sorted({str(g.get("gap_type")) for g in post_validation_gaps}))
                bf_status = f"post_validation_failed:{gap_types}"
            else:
                bf_status = str(bf.get("status") or "unknown")
            failure_note = _merge_notes(
                primary_row[6],
                f"aqi_rebuild_failed status={bf_status} error={bf.get('error')}",
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
            error_text = str(bf.get("error") or bf_status or "unknown")
        conn.commit()

        metrics["aqi_rebuild_results"].append({
            "queue_row_ids": row_ids,
            "connector_id": connector_scope,
            "connector_ids": connector_ids_sorted,
            "day_utc": day_iso,
            "reasons": reasons_sorted,
            "status": final_status,
            "source_mode": "live_r2",
            "error": error_text,
            "log_path": bf.get("log_path"),
            "post_rebuild_validation_gaps": post_validation_gaps,
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
        choices=["openaq", "sensorcommunity", "sos", "all"],
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
    p.add_argument(
        "--allow-stale-dropbox",
        action="store_true",
        help="Allow the daily task backup gate to proceed even when the Dropbox backup is not yet ready.",
    )
    default_history_version = os.environ.get("UK_AQ_R2_HISTORY_INTEGRITY_VERSION", "v1")
    p.add_argument(
        "--history-version",
        default=default_history_version,
        choices=list(HISTORY_VERSION_CHOICES),
        help=(
            "R2 history layout version to check "
            f"(default {default_history_version!r}; env UK_AQ_R2_HISTORY_INTEGRITY_VERSION)."
        ),
    )
    p.add_argument(
        "--check-aqi-debug",
        action="store_true",
        default=_parse_bool(os.environ.get("UK_AQ_R2_HISTORY_INTEGRITY_CHECK_AQI_DEBUG"), False),
        help="Check optional v2 AQI hourly debug partitions (default false; env UK_AQ_R2_HISTORY_INTEGRITY_CHECK_AQI_DEBUG).",
    )
    p.add_argument(
        "--require-aqi-debug",
        action="store_true",
        default=_parse_bool(os.environ.get("UK_AQ_R2_HISTORY_INTEGRITY_REQUIRE_AQI_DEBUG"), False),
        help="Treat missing/invalid v2 AQI hourly debug partitions as errors (default false; env UK_AQ_R2_HISTORY_INTEGRITY_REQUIRE_AQI_DEBUG).",
    )
    return p.parse_args(argv)


def check_dropbox_backup_ready(
    *,
    supabase_url: str | None,
    service_role_key: str | None,
    task_keys: list[str],
    scheduled_for_date: str,
    integrity_started_at_utc: str,
    allow_stale_dropbox: bool = False,
    rpc_name: str = "uk_aq_rpc_daily_task_backup_readiness",
) -> dict[str, Any]:
    normalized_task_keys = [str(value or "").strip() for value in task_keys]
    summary: dict[str, Any] = {
        "backup_gate_checked": True,
        "backup_ready": False,
        "backup_task_keys": normalized_task_keys,
        "backup_scheduled_for_date": scheduled_for_date,
        "backup_completed_at": None,
        "allow_stale_dropbox": bool(allow_stale_dropbox),
        "blocked_reason": None,
        "tasks": [],
    }
    if allow_stale_dropbox:
        summary["backup_ready"] = True
        summary["blocked_reason"] = "allow_stale_dropbox_override"
        return summary
    if not normalized_task_keys or any(not value for value in normalized_task_keys):
        summary["blocked_reason"] = "no_required_backup_task_keys_configured"
        return summary
    try:
        parsed_date = dt.date.fromisoformat(str(scheduled_for_date))
        if parsed_date.isoformat() != str(scheduled_for_date):
            raise ValueError("date is not canonical YYYY-MM-DD")
    except (TypeError, ValueError):
        summary["blocked_reason"] = "invalid_scheduled_for_date"
        return summary
    started_raw = str(integrity_started_at_utc or "").strip()
    integrity_started_at = _parse_iso_utc(started_raw)
    if (
        integrity_started_at is None
        or not (started_raw.endswith("Z") or started_raw.endswith("+00:00"))
    ):
        summary["blocked_reason"] = "invalid_integrity_started_at_utc"
        return summary
    if not supabase_url or not service_role_key:
        summary["blocked_reason"] = "supabase_credentials_unavailable"
        return summary

    endpoint = supabase_url.rstrip("/") + f"/rest/v1/rpc/{rpc_name}"
    payload = json.dumps(
        {
            "p_scheduled_for_date": scheduled_for_date,
            "p_integrity_started_at_utc": integrity_started_at_utc,
            "p_task_keys": normalized_task_keys,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=payload,
        method="POST",
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
            "Accept-Profile": DAILY_TASK_HEALTH_RPC_SCHEMA,
            "Content-Profile": DAILY_TASK_HEALTH_RPC_SCHEMA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body) if body else {}
    except Exception as exc:
        summary["blocked_reason"] = f"daily_task_health_query_failed:{exc}"
        return summary

    if isinstance(data, list):
        if len(data) != 1:
            summary["blocked_reason"] = "daily_task_health_query_returned_unexpected_shape"
            return summary
        data = data[0]
    if not isinstance(data, dict) or not isinstance(data.get("backup_ready"), bool) or not isinstance(data.get("tasks"), list):
        summary["blocked_reason"] = "daily_task_health_query_returned_unexpected_shape"
        return summary

    tasks = data["tasks"]
    if any(not isinstance(task, dict) for task in tasks):
        summary["blocked_reason"] = "daily_task_health_query_returned_unexpected_shape"
        return summary
    summary["tasks"] = tasks
    tasks_by_key = {str(task.get("task_key") or "").strip(): task for task in tasks}
    if any(task_key not in tasks_by_key for task_key in normalized_task_keys):
        summary["blocked_reason"] = str(data.get("blocked_reason") or "missing_required_task")
        return summary

    completed_values: list[tuple[dt.datetime, str]] = []
    for task_key in normalized_task_keys:
        task = tasks_by_key[task_key]
        if task.get("status") != "Finished":
            summary["blocked_reason"] = str(task.get("blocked_reason") or "latest_task_not_finished")
            return summary
        finished_at_raw = str(task.get("finished_at") or "").strip()
        finished_at = _parse_iso_utc(finished_at_raw)
        if (
            finished_at is None
            or not (finished_at_raw.endswith("Z") or finished_at_raw.endswith("+00:00"))
        ):
            summary["blocked_reason"] = "daily_task_health_query_returned_unexpected_shape"
            return summary
        if finished_at > integrity_started_at:
            summary["blocked_reason"] = "task_finished_after_integrity_start"
            return summary
        completed_values.append((finished_at, finished_at_raw))

    if not data["backup_ready"]:
        summary["blocked_reason"] = str(data.get("blocked_reason") or "backup_not_ready")
        return summary

    summary["backup_completed_at"] = max(completed_values, key=lambda item: item[0])[1]
    summary["backup_ready"] = True
    return summary


def _first_configured_value(values: Mapping[str, Any], names: Iterable[str]) -> str:
    for name in names:
        value = str(values.get(name) or "").strip()
        if value:
            return value
    return ""


def resolve_backup_gate_credentials(values: Mapping[str, Any] | None = None) -> tuple[str, str]:
    source = os.environ if values is None else values
    resolved_values = dict(source)
    backfill_env_path = str(source.get("UK_AQ_BACKFILL_ENV_FILE") or "").strip()
    if backfill_env_path:
        try:
            resolved_values.update(load_env_file_assignments(backfill_env_path))
        except OSError:
            # Preflight reports an unreadable configured file. The gate still
            # fails closed below if no usable credentials remain.
            pass
    return (
        _first_configured_value(resolved_values, BACKUP_GATE_URL_ENV_NAMES).rstrip("/"),
        _first_configured_value(resolved_values, BACKUP_GATE_KEY_ENV_NAMES),
    )


def configured_backup_task_keys(values: Mapping[str, Any] | None = None) -> list[str]:
    source = os.environ if values is None else values
    if "UK_AQ_HISTORY_INTEGRITY_BACKUP_TASK_KEYS" in source:
        raw = str(source.get("UK_AQ_HISTORY_INTEGRITY_BACKUP_TASK_KEYS") or "")
    else:
        raw = ",".join(DEFAULT_BACKUP_TASK_KEYS)
    return [part.strip() for part in raw.split(",") if part.strip()]


def run_scheduled_backup_gate(args: argparse.Namespace, started_iso: str) -> dict[str, Any]:
    if args.profile == "manual":
        return {
            "backup_gate_checked": False,
            "backup_ready": None,
            "allow_stale_dropbox": bool(args.allow_stale_dropbox),
        }
    supabase_url, service_role_key = resolve_backup_gate_credentials()
    return check_dropbox_backup_ready(
        supabase_url=supabase_url,
        service_role_key=service_role_key,
        task_keys=configured_backup_task_keys(),
        scheduled_for_date=started_iso[:10],
        integrity_started_at_utc=started_iso,
        allow_stale_dropbox=bool(args.allow_stale_dropbox),
        rpc_name=str(
            os.environ.get(
                "UK_AQ_HISTORY_INTEGRITY_BACKUP_READINESS_RPC",
                "uk_aq_rpc_daily_task_backup_readiness",
            )
        ),
    )


def _parse_env_assignment_line(raw_line: str) -> tuple[str, str] | None:
    line = raw_line.strip()
    if not line or line.startswith("#"):
        return None
    if line.startswith("export "):
        line = line[len("export "):].lstrip()
    if "=" not in line:
        return None
    key, raw_value = line.split("=", 1)
    key = key.strip()
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
        return None
    value_part = raw_value.strip()
    if not value_part:
        return key, ""
    try:
        pieces = shlex.split(value_part, comments=True, posix=True)
    except ValueError:
        pieces = [value_part.strip().strip("'\"")]
    if not pieces:
        return key, ""
    return key, pieces[0]


def load_env_file_assignments(path: str | Path) -> dict[str, str]:
    env_path = Path(path).expanduser()
    values: dict[str, str] = {}
    with env_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            parsed = _parse_env_assignment_line(raw_line)
            if parsed is None:
                continue
            key, value = parsed
            values[key] = value
    return values


def load_backfill_env_file_if_set(*, override_existing: bool = False) -> dict[str, Any]:
    raw_path = str(os.environ.get("UK_AQ_BACKFILL_ENV_FILE", "")).strip()
    result: dict[str, Any] = {
        "path": raw_path,
        "loaded": False,
        "loaded_keys": [],
        "shared_history_keys": [],
        "skipped_existing_keys": [],
        "error": None,
    }
    if not raw_path:
        return result
    env_path = Path(raw_path).expanduser()
    if not env_path.is_file():
        result["error"] = f"UK_AQ_BACKFILL_ENV_FILE not found: {env_path}"
        return result
    loaded = load_env_file_assignments(env_path)
    loaded_keys: list[str] = []
    skipped_existing: list[str] = []
    for key, value in loaded.items():
        if not override_existing and key in os.environ:
            skipped_existing.append(key)
            continue
        os.environ[key] = value
        loaded_keys.append(key)
    result["path"] = str(env_path)
    result["loaded"] = True
    result["loaded_keys"] = sorted(loaded_keys)
    result["skipped_existing_keys"] = sorted(skipped_existing)
    result["shared_history_keys"] = sorted(
        key for key in loaded
        if key.startswith("UK_AQ_R2_HISTORY_")
    )
    return result


def load_env_or_die() -> dict[str, str]:
    global LAST_BACKFILL_ENV_LOAD_RESULT
    missing = [v for v in REQUIRED_ENV_VARS if not os.environ.get(v)]
    if missing:
        sys.stderr.write(
            "ERROR: required env vars not set; the shell launcher must load "
            "the env file before invoking python.\n"
            f"       Missing: {', '.join(missing)}\n"
        )
        sys.exit(3)
    LAST_BACKFILL_ENV_LOAD_RESULT = load_backfill_env_file_if_set()
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

    core_history_version = resolve_core_history_version_for_mode(resolve_history_version_mode(args))
    resolved_snapshot_root = resolve_core_snapshot_root(core_history_version, os.environ)
    snapshot_root = Path(resolved_snapshot_root)
    if not snapshot_root.exists():
        errors.append(
            f"resolved core snapshot root for history_version={core_history_version} does not exist: {snapshot_root}. "
            "Has Dropbox finished syncing the core snapshot backup?",
        )
    elif not snapshot_root.is_dir():
        errors.append(
            f"resolved core snapshot root for history_version={core_history_version} is not a directory: {snapshot_root}",
        )
    elif not os.access(snapshot_root, os.R_OK):
        errors.append(
            f"resolved core snapshot root for history_version={core_history_version} is not readable: {snapshot_root}",
        )
    elif not _looks_like_snapshot_root(snapshot_root):
        errors.append(
            f"resolved core snapshot root for history_version={core_history_version} does not look like a snapshot history root: {snapshot_root}. "
            "Has Dropbox finished syncing the core snapshot backup?",
        )

    cross_check_enabled = not args.skip_cross_check
    if cross_check_enabled:
        r2_root_raw = resolve_r2_history_root(os.environ)
        if not r2_root_raw:
            errors.append(
                "R2 history Dropbox root could not be resolved; set UK_AQ_R2_HISTORY_DROPBOX_ROOT or UK_AQ_DROPBOX_ROOT plus UK_AQ_R2_HISTORY_DROPBOX_DIR.",
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
    if args.source in {"openaq", "all", "sensorcommunity", "sos"}:
        for module_name in ("gzip", "hashlib", "urllib.request", "sqlite3"):
            try:
                __import__(module_name)
            except Exception as exc:  # pragma: no cover - defensive
                errors.append(f"required Python module '{module_name}' failed to import ({exc}).")

    if args.source in {"sos", "all"}:
        flat_file_supabase = _resolve_ingestdb_supabase_rest_config(os.environ)
        if not flat_file_supabase.get("supabase_url"):
            errors.append(
                "SUPABASE_URL is required for UK-AIR flat-file SOS mode.",
            )
        if not flat_file_supabase.get("supabase_key"):
            errors.append(
                "SB_SECRET_KEY is required for UK-AIR flat-file SOS mode.",
            )

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
            "snapshot_root": resolve_core_snapshot_root(core_history_version, os.environ),
            "core_history_version": core_history_version,
            "core_prefix": resolve_core_snapshot_prefix(core_history_version, os.environ),
            "r2_history_root": resolve_r2_history_root(os.environ),
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
        f"snapshot={summary['paths']['snapshot_root']} core_version={summary['paths']['core_history_version']} "
        f"core_prefix={summary['paths']['core_prefix']} r2={summary['paths']['r2_history_root'] or '<unset>'} "
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
    legacy_sftc_rows = _prepare_source_file_timeseries_counts_migration(conn)
    conn.executescript(SCHEMA_SQL)
    if legacy_sftc_rows is not None:
        conn.executemany(
            """
            INSERT INTO source_file_timeseries_counts
              (source_file_key, day_utc, timeseries_id, row_count, counted_at_utc)
            VALUES (?, ?, ?, ?, ?)
            """,
            legacy_sftc_rows,
        )
        conn.execute("DROP TABLE IF EXISTS source_file_timeseries_counts_legacy")
    # In-place schema additions for DBs created by earlier phases.
    ensure_columns(conn, "core_snapshot_imports", {
        "snapshot_day_utc": "TEXT",
        "bytes_read": "INTEGER DEFAULT 0",
    })
    ensure_columns(conn, "cross_checks", {
        "history_version": "TEXT",
    })
    ensure_columns(conn, "aqi_rebuild_queue", {
        "history_version": "TEXT",
        "domain": "TEXT",
        "profile": "TEXT",
        "pollutant_code": "TEXT",
        "source_observations_version": "TEXT",
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

    history_configs = s.get("history_path_configs") or {}
    if history_configs:
        lines.extend([
            "## History version configuration",
            "",
            f"- Integrity schema version: {s.get('history_integrity_schema_version')}",
            f"- Version mode: {s.get('history_version_mode')}",
            f"- Checked versions: {', '.join(s.get('checked_versions') or [])}",
            f"- Site read version: {s.get('site_read_version') or '(unset)'}",
        ])
        backfill_env = s.get("backfill_env_file") or {}
        if backfill_env.get("path") or backfill_env.get("loaded"):
            lines.extend([
                f"- Backfill env file: {backfill_env.get('path') or '(unset)'}",
                f"- Backfill env loaded: {bool(backfill_env.get('loaded'))}",
                "- Shared history keys loaded: "
                + ", ".join(backfill_env.get("shared_history_keys") or []),
            ])
            if backfill_env.get("error"):
                lines.append(f"- Backfill env error: {backfill_env.get('error')}")
        for version in sorted(history_configs):
            config = history_configs.get(version) or {}
            lines.extend([
                "",
                f"### history_version={version}",
                "",
                f"- Checks implemented: {bool(config.get('checks_implemented'))}",
                f"- Observations data prefix: {config.get('observations_data_prefix')}",
                f"- AQI hourly data prefix: {config.get('aqilevels_hourly_data_prefix')}",
                f"- AQI hourly debug prefix: {config.get('aqilevels_hourly_debug_prefix') or '(none)'}",
                f"- Observations index prefix: {config.get('observations_timeseries_index_prefix')}",
                f"- AQI index prefix: {config.get('aqilevels_timeseries_index_prefix')}",
                f"- Observations latest index: {config.get('observations_latest_index_key')}",
                f"- AQI latest index: {config.get('aqilevels_latest_index_key')}",
            ])
        lines.append("")

    snap = s.get("snapshot") or {}
    if snap:
        lines.extend([
            "## Core snapshot",
            "",
            f"- Status:        {snap.get('status')}",
            f"- Core history version: {snap.get('core_history_version') or '(unset)'}",
            f"- Core prefix:   {snap.get('core_prefix') or '(unset)'}",
            f"- Snapshot root: {snap.get('snapshot_root') or '(unset)'}",
            f"- Core snapshot status: {snap.get('core_snapshot_status') or '(unset)'}",
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
    backup = s.get("backup_readiness") or {}
    if backup:
        lines.extend([
            "## Dropbox backup readiness",
            "",
            f"- Gate checked: {bool(backup.get('backup_gate_checked'))}",
            f"- Ready: {backup.get('backup_ready')}",
            f"- Required task keys: {', '.join(backup.get('backup_task_keys') or [])}",
            f"- Scheduled date: {backup.get('backup_scheduled_for_date') or '(none)'}",
            f"- Completed at: {backup.get('backup_completed_at') or '(none)'}",
            f"- Allow stale Dropbox: {bool(backup.get('allow_stale_dropbox'))}",
            f"- Blocked reason: {backup.get('blocked_reason') or '(none)'}",
            "",
        ])
    lookup_counts = s.get("lookup_source_counts") or {}
    if lookup_counts:
        lines.extend([
            "## Active lookup counts",
            "",
        ])
        for source_key in ("openaq", "sensorcommunity", "sos"):
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
    sos = s.get("sos") or {}
    if sos.get("ran") or sos.get("skipped_reason"):
        lines.extend([
            "## UK-AIR SOS",
            "",
            f"- Ran:            {bool(sos.get('ran'))}",
            f"- Source mode:    {sos.get('source_mode') or '(default)'}",
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
            f"- Unchanged:      {sos.get('unchanged', sos.get('unchanged_after_download', 0))}",
            f"- Unchanged cached: {sos.get('unchanged_cached', 0)}",
            f"- Unchanged after download: {sos.get('unchanged_after_download', 0)}",
            f"- Downloaded files: {sos.get('downloaded', 0)}",
            f"- Cache reused:   {sos.get('cache_reused', 0)}",
            f"- Cache-missing redownloads: {sos.get('cache_missing_redownloaded', 0)}",
            f"- Missing:        {sos.get('missing', 0)}",
            f"- Temporary errors:{sos.get('temporary_errors', 0)}",
            f"- Permanent errors:{sos.get('permanent_errors', 0)}",
            f"- Actionable mapping groups: {sos.get('unmapped_source_groups', 0)}",
            f"- Actionable mapping rows: {sos.get('unmapped_source_rows', 0)}",
            f"- Out-of-window mapping groups: {sos.get('out_of_window_unmapped_groups', 0)}",
            f"- Out-of-window mapping rows: {sos.get('out_of_window_unmapped_rows', 0)}",
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
        mapping_issues = list(sos.get("actionable_mapping_issues") or [])
        if mapping_issues:
            lines.extend([
                "",
                "### Actionable SOS mapping issues",
                "",
                "| Site | Day | Pollutant | Source rows | Status |",
                "| --- | --- | --- | ---: | --- |",
            ])
            for issue in mapping_issues[:25]:
                lines.append(
                    f"| {issue.get('site_ref', '')} | {issue.get('day_utc', '')} | "
                    f"{issue.get('pollutant_code', '')} | {issue.get('source_rows', 0)} | "
                    f"{issue.get('mapping_status', '')} |"
                )
            if len(mapping_issues) > 25:
                lines.append(f"\n- ... {len(mapping_issues) - 25} more mapping issues")
        sos_first_seen = sos.get("first_seen_files") or []
        if sos_first_seen:
            lines.extend(["", "### First-seen station/day snapshots (sos, baselined — not backfilled)", ""])
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
            lines.extend(["", "### Changed station/day snapshots (sos)", ""])
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
        checked_versions = list(s.get("checked_versions") or [])
        if checked_versions:
            for version in checked_versions:
                config = (s.get("history_path_configs") or {}).get(version) or {}
                heading = (
                    f"## R2 Cross-check — history_version={version}"
                    if len(checked_versions) == 1
                    else f"## R2 Cross-check — {version}"
                )
                lines.extend([
                    heading,
                    "",
                    f"- History version: {version}",
                    f"- Observations prefix: {config.get('observations_data_prefix')}",
                    f"- Observations index prefix: {config.get('observations_timeseries_index_prefix')}",
                ])
                hvr = (s.get("history_version_results") or {}).get(version) or {}
                if version == "v2":
                    obs = hvr.get("observations") or (cc.get("v2_observations") or {}) or ((cc.get("additional_history_versions") or {}).get("v2", {}).get("observations") or {})
                    aqi = hvr.get("aqilevels") or (cc.get("v2_aqilevels") or {}) or ((cc.get("additional_history_versions") or {}).get("v2", {}).get("aqilevels") or {})
                    gaps = list(obs.get("gaps") or [])
                    aqi_gaps = list(aqi.get("gaps") or []) + list((aqi.get("debug") or {}).get("gaps") or [])
                    debug = aqi.get("debug") or {}
                    debug_mode = "skipped" if not debug.get("checked") else ("required" if debug.get("required") else "warning-only")
                    source_scope = obs.get("source_scope") or aqi.get("source_scope") or {}
                    source_scope_line = "all connectors"
                    if source_scope.get("scope") == "source":
                        connector_ids = source_scope.get("connector_ids") or []
                        source_scope_line = f"{source_scope.get('source')} connector_id={','.join(str(c) for c in connector_ids)}"
                    lines.extend([
                        f"- Source scope: {source_scope_line}",
                        f"- AQI hourly data prefix: {config.get('aqilevels_hourly_data_prefix')}",
                        f"- AQI hourly data index prefix: {config.get('aqilevels_timeseries_index_prefix')}",
                        "- V2 observations checks: implemented",
                        "- V2 AQI hourly data checks: implemented",
                        f"- AQI debug checks: {debug_mode}",
                        f"- Checked observation partitions: {obs.get('checked_partitions', 0)}",
                        f"- Observation gaps: {obs.get('gap_count', len(gaps))}",
                        f"- Checked AQI hourly data partitions: {aqi.get('checked_partitions', 0)}",
                        f"- AQI hourly data gaps: {aqi.get('gap_count', len(aqi.get('gaps') or []))}",
                    ])
                    if gaps:
                        lines.extend([
                            "",
                            "### V2 observation gaps",
                            "",
                            "| Severity | Gap type | Day | Connector | Pollutant | Expected path | Repair plan | Index rebuild |",
                            "| --- | --- | --- | --- | --- | --- | --- | --- |",
                        ])
                        for gap in gaps[:25]:
                            repair = gap.get("suggested_repair") or {}
                            lines.append(
                                "| "
                                f"{gap.get('severity') or ''} | "
                                f"{gap.get('gap_type') or ''} | "
                                f"{gap.get('day_utc') or ''} | "
                                f"{gap.get('connector_id') or ''} | "
                                f"{gap.get('pollutant_code') or ''} | "
                                f"{gap.get('expected_path') or ''} | "
                                f"{repair.get('kind') or ''} | "
                                f"{bool(repair.get('requires_index_rebuild'))} |"
                            )
                        if len(gaps) > 25:
                            lines.append(f"| info | truncated |  |  |  | {len(gaps) - 25} more gaps |  |  |")
                    if aqi_gaps:
                        lines.extend([
                            "",
                            "### V2 AQI gaps",
                            "",
                            "| Severity | Profile | Gap type | Day | Connector | Pollutant | Expected path |",
                            "| --- | --- | --- | --- | --- | --- | --- |",
                        ])
                        for gap in aqi_gaps[:25]:
                            lines.append(
                                "| "
                                f"{gap.get('severity') or ''} | "
                                f"{gap.get('profile') or ''} | "
                                f"{gap.get('gap_type') or ''} | "
                                f"{gap.get('day_utc') or ''} | "
                                f"{gap.get('connector_id') or ''} | "
                                f"{gap.get('pollutant_code') or ''} | "
                                f"{gap.get('expected_path') or ''} |"
                            )
                        if len(aqi_gaps) > 25:
                            lines.append(f"| info |  | truncated |  |  |  | {len(aqi_gaps) - 25} more gaps |")
                elif version == "v2" and not config.get("checks_implemented", True):
                    lines.append("- Deep v2 checks: not implemented in Phase 1")
                lines.append("")
            if s.get("history_version_mode") == "both":
                lines.extend([
                    "## v1/v2 comparison",
                    "",
                    "- Full comparison: not implemented until Phase 5",
                    "",
                ])
        lines.extend([
            "## R2 Cross-check metrics",
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
            f"- V2 AQI integrity rebuilds queued: {cc.get('v2_aqi_rebuilds_queued_from_integrity', 0)}",
            f"- V2 AQI integrity bridge ran:      {bool(cc.get('v2_aqi_integrity_rebuild_bridge_ran'))}",
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
        skipped_v2_repairs = cc.get("skipped_v2_observation_repairs") or []
        if skipped_v2_repairs:
            lines.extend(["", "### Skipped v2 observation repairs", ""])
            for entry in skipped_v2_repairs[:50]:
                lines.append(
                    f"- connector={entry.get('connector_id')} day={entry.get('day_utc')} "
                    f"status={entry.get('status')} reason={entry.get('reason')}"
                )
            if len(skipped_v2_repairs) > 50:
                lines.append(f"- ... {len(skipped_v2_repairs) - 50} more")
        v2_repair_results = cc.get("v2_observation_repair_results") or []
        if v2_repair_results:
            lines.extend(["", "### V2 observation repair results", ""])
            for entry in v2_repair_results[:25]:
                source_cache = entry.get("source_cache") or {}
                lines.append(
                    f"- connector={entry.get('connector_id')} day={entry.get('day_utc')} "
                    f"status={entry.get('status')} wrapper_status={entry.get('wrapper_status')} "
                    f"source_cache={source_cache.get('status') or '(unknown)'} "
                    f"chunks={entry.get('attempted_chunks')}/{entry.get('chunk_count')} "
                    f"failed_chunks={entry.get('failed_chunks')} exit_code={entry.get('exit_code')} "
                    f"log={entry.get('log_path') or '(none)'}"
                )
                if entry.get("error"):
                    lines.append(f"  - error: {entry.get('error')}")
                if entry.get("status") != "ok":
                    lines.append("  - AQI rebuild was not queued because the observation repair did not complete successfully.")
                stdout_tail = _tail_lines(str(entry.get("stdout_tail") or ""), 80)
                if stdout_tail:
                    lines.extend(["", "  stdout tail:", "  ```text"])
                    lines.extend(f"  {line}" for line in stdout_tail.splitlines())
                    lines.append("  ```")
                stderr_tail = _tail_lines(str(entry.get("stderr_tail") or ""), 80)
                if stderr_tail:
                    lines.extend(["", "  stderr tail:", "  ```text"])
                    lines.extend(f"  {line}" for line in stderr_tail.splitlines())
                    lines.append("  ```")
            if len(v2_repair_results) > 25:
                lines.append(f"- ... {len(v2_repair_results) - 25} more")
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
        "sos_snapshots_successful",
        "sos_snapshots_no_data",
        "sos_not_found",
        "sos_not_found_suppressed",
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
    history_version_mode = resolve_history_version_mode(args)
    checked_history_versions = expand_history_versions(history_version_mode)
    history_path_configs = resolve_history_path_configs(history_version_mode)
    serialized_history_path_configs = serialize_history_path_configs(history_path_configs)
    site_read_version = str(os.environ.get("UK_AQ_R2_HISTORY_VERSION", "")).strip() or None

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
    daily_task_health_config = _resolve_daily_task_health_config(env_name=args.env)
    daily_task_health_enabled = bool(daily_task_health_config.get("enabled"))
    daily_task_health_strict = bool(daily_task_health_config.get("strict"))
    daily_task_health_run_id: str | None = None
    daily_task_scheduled_for_date = started_at.date().isoformat()
    daily_task_platform_run_id = f"{args.env}:{run_compact}"
    backup_gate_summary = run_scheduled_backup_gate(args, started_iso)
    if args.profile != "manual":
        log.info("dropbox backup gate: %s", json.dumps(backup_gate_summary, sort_keys=True, default=str))
        if not backup_gate_summary.get("backup_ready"):
            log.error("backup gate blocked before Dropbox history scan: %s", backup_gate_summary.get("blocked_reason"))
            summary = {
                "env": args.env,
                "profile": args.profile,
                "source": args.source,
                "from_day": args.from_day,
                "to_day": args.to_day,
                "started_at_utc": started_iso,
                "finished_at_utc": fmt_iso(utc_now()),
                "status": "blocked_backup_not_ready",
                "dry_run": bool(args.dry_run),
                "check_only": bool(args.check_only),
                "run_backfill": bool(args.run_backfill),
                "allow_stale_dropbox": bool(args.allow_stale_dropbox),
                "db_path": env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"],
                "log_path": str(log_path),
                "history_version_mode": history_version_mode,
                "checked_versions": checked_history_versions,
                "history_path_configs": serialized_history_path_configs,
                "backup_readiness": backup_gate_summary,
                "metrics": {},
            }
            write_reports(env["UK_AQ_HISTORY_INTEGRITY_REPORT_DIR"], run_compact, summary)
            return 2

    # Preflight inspects the configured Dropbox roots. It must run only after
    # scheduled backup readiness has been established (or explicitly bypassed).
    preflight_summary = run_preflight_or_die(args, env)
    log.info("preflight summary=%s", preflight_summary)
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
            "allow_stale_dropbox": bool(args.allow_stale_dropbox),
            "status": "started",
            "log_path": str(log_path),
            "backup_readiness": backup_gate_summary,
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
                "snapshot_root": resolve_core_snapshot_root(resolve_core_history_version_for_mode(history_version_mode), os.environ),
                "core_history_version": resolve_core_history_version_for_mode(history_version_mode),
                "core_prefix": resolve_core_snapshot_prefix(resolve_core_history_version_for_mode(history_version_mode), os.environ),
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
                snapshot_root_str=resolve_core_snapshot_root(resolve_core_history_version_for_mode(history_version_mode), os.environ),
                force=args.force_snapshot_import,
                dry_run=args.dry_run,
                log=log,
            )
            snapshot_result["core_history_version"] = resolve_core_history_version_for_mode(history_version_mode)
            snapshot_result["core_prefix"] = resolve_core_snapshot_prefix(snapshot_result["core_history_version"], os.environ)
            snapshot_result["core_snapshot_status"] = classify_core_snapshot_status(
                snapshot_result,
                history_version=snapshot_result["core_history_version"],
                expected_day=to_day,
            )
            if snapshot_result["status"] in {"missing_root", "no_snapshot"} or snapshot_result["core_snapshot_status"].endswith("_missing") or snapshot_result["core_snapshot_status"].endswith("_stale"):
                warnings_delta += 1

        # Phase 3 / Phase 5: source adapters share a single LimitTracker
        # so soft caps cover the whole run, not per-adapter.
        limits = LimitTracker(
            max_download_mb=args.max_download_mb,
            max_runtime_minutes=args.max_runtime_minutes,
            started_mono=started_mono,
        )
        if "core_history_version" not in snapshot_result:
            snapshot_result["core_history_version"] = resolve_core_history_version_for_mode(history_version_mode)
            snapshot_result["core_prefix"] = resolve_core_snapshot_prefix(snapshot_result["core_history_version"], os.environ)
            snapshot_result["core_snapshot_status"] = classify_core_snapshot_status(snapshot_result, history_version=snapshot_result["core_history_version"], expected_day=to_day)
        snapshot_ok = snapshot_result["status"] in {"imported", "reused"} and snapshot_result.get("core_snapshot_status") == "ok"

        empty_metrics = {"ran": False, "skipped_reason": None}
        openaq_metrics: dict[str, Any] = dict(empty_metrics)
        sc_metrics: dict[str, Any] = dict(empty_metrics)
        sos_metrics: dict[str, Any] = dict(empty_metrics)
        cross_check_metrics: dict[str, Any] = dict(empty_metrics)
        lookup_source_counts: dict[str, dict[str, int]] = (
            collect_lookup_active_counts_by_source(conn)
        )
        v2_allowed_connector_ids: set[int] | None = None
        v2_source_scope = {"source": args.source, "connector_ids": None, "scope": "all"}
        if "v2" in checked_history_versions and snapshot_ok:
            v2_allowed_connector_ids, v2_source_scope = resolve_v2_source_scope(conn, args.source)
            log.info("v2 source scope: %s", v2_source_scope)
        sos_counts = lookup_source_counts.get("sos", {})
        source_adapter_history_version = adapter_backfill_history_version(history_version_mode)
        log.info(
            "lookup active counts: openaq stations=%s timeseries=%s; sensorcommunity stations=%s timeseries=%s; sos stations=%s timeseries=%s",
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
                history_version=source_adapter_history_version,
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
                history_version=source_adapter_history_version,
            )

        run_sos = args.source in {"sos", "all"} and snapshot_ok
        if args.source in {"sos", "all"} and not run_sos:
            log.warning(
                "sos: skipped because core snapshot status=%s (need imported/reused)",
                snapshot_result["status"],
            )
        if run_sos:
            sos_metrics = check_sos(
                conn=conn, env_name=args.env, env=env,
                from_day=from_day, to_day=to_day,
                dry_run=args.dry_run, run_backfill=args.run_backfill,
                limits=limits, log=log,
                concurrency=max(1, int(args.concurrency)),
                history_version=source_adapter_history_version,
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
        elif history_version_mode == "v2":
            r2_history_root = resolve_r2_history_root(os.environ)
            v2_obs = run_v2_observations_integrity_checks(
                r2_history_root=r2_history_root,
                config=history_path_configs["v2"],
                from_day=from_day,
                to_day=to_day,
                conn=conn,
                env_name=args.env,
                allowed_connector_ids=v2_allowed_connector_ids,
                source_scope=v2_source_scope,
                log=log,
            )
            v2_aqi = run_v2_aqilevels_integrity_checks(
                r2_history_root=r2_history_root,
                config=history_path_configs["v2"],
                from_day=from_day,
                to_day=to_day,
                allowed_connector_ids=v2_allowed_connector_ids,
                source_scope=v2_source_scope,
                conn=conn,
                check_aqi_debug=bool(args.check_aqi_debug),
                require_aqi_debug=bool(args.require_aqi_debug),
                log=log,
            )
            cross_check_metrics = {
                "ran": True,
                "history_version": "v2",
                "skipped_reason": None,
                "source_scope": v2_source_scope,
                "v2_observations": v2_obs,
                "v2_aqilevels": v2_aqi,
                "cross_checks_total": int(v2_obs.get("checked_partitions", 0) or 0) + int(v2_aqi.get("checked_partitions", 0) or 0),
                "cross_checks_ok": (int(v2_obs.get("checked_partitions", 0) or 0) + int(v2_aqi.get("checked_partitions", 0) or 0)) if v2_obs.get("status") == "ok" and v2_aqi.get("status") == "ok" else 0,
                "cross_checks_mismatch": int(v2_obs.get("gap_count", 0) or 0) + int(v2_aqi.get("gap_count", 0) or 0) + int((v2_aqi.get("debug") or {}).get("gap_count", 0) or 0),
                "discrepancy_total": int(v2_obs.get("gap_count", 0) or 0) + int(v2_aqi.get("gap_count", 0) or 0) + int((v2_aqi.get("debug") or {}).get("gap_count", 0) or 0),
            }
        else:
            v1_config = history_path_configs.get("v1")
            if v1_config is None:
                raise RuntimeError("v1 history path config is required for v1 cross-check mode")
            r2_history_root = resolve_r2_history_root(os.environ)
            cross_check_metrics = run_r2_cross_checks(
                conn=conn,
                run_id=int(run_id),
                env_name=args.env,
                source_filter=args.source,
                from_day=from_day,
                to_day=to_day,
                r2_history_root=r2_history_root,
                r2_manifest_prefix=v1_config.observations_timeseries_index_prefix,
                checked_at_utc=fmt_iso(utc_now()),
                log=log,
            )
            cross_check_metrics["history_version"] = "v1"
            if history_version_mode == "both":
                v2_obs = run_v2_observations_integrity_checks(
                    r2_history_root=r2_history_root,
                    config=history_path_configs["v2"],
                    from_day=from_day,
                    to_day=to_day,
                    conn=conn,
                    env_name=args.env,
                    allowed_connector_ids=v2_allowed_connector_ids,
                    source_scope=v2_source_scope,
                    log=log,
                )
                v2_aqi = run_v2_aqilevels_integrity_checks(
                    r2_history_root=r2_history_root,
                    config=history_path_configs["v2"],
                    from_day=from_day,
                    to_day=to_day,
                    allowed_connector_ids=v2_allowed_connector_ids,
                    source_scope=v2_source_scope,
                    conn=conn,
                    check_aqi_debug=bool(args.check_aqi_debug),
                    require_aqi_debug=bool(args.require_aqi_debug),
                    log=log,
                )
                cross_check_metrics["additional_history_versions"] = {
                    "v2": {
                        "ran": True,
                        "checks_implemented": True,
                        "status": "fail" if v2_obs.get("status") == "fail" or v2_aqi.get("status") == "fail" else "ok",
                        "source_scope": v2_source_scope,
                        "observations": v2_obs,
                        "aqilevels": v2_aqi,
                    }
                }
        if cross_check_metrics.get("ran"):
            cc_backfill_metrics = run_cross_check_backfills(
                conn=conn,
                run_id=int(run_id),
                env_name=args.env,
                run_compact=run_compact,
                env=env,
                source_filter=args.source,
                sos_metrics=sos_metrics,
                dry_run=args.dry_run,
                run_backfill=args.run_backfill,
                limits=limits,
                log=log,
                history_version=history_version_mode,
            )
            cross_check_metrics.update(cc_backfill_metrics)
            if history_version_mode == "v2":
                v2_backfill_metrics = run_v2_gap_backfills(
                    conn=conn,
                    run_id=int(run_id),
                    env_name=args.env,
                    run_compact=run_compact,
                    env=env,
                    v2_observations=cross_check_metrics.get("v2_observations") or {},
                    dry_run=args.dry_run,
                    run_backfill=args.run_backfill,
                    limits=limits,
                    log=log,
                )
                cross_check_metrics.update(v2_backfill_metrics)
            v1_config_for_legacy_aqi = history_path_configs.get("v1")
            if v1_config_for_legacy_aqi is None:
                aqi_health_metrics = {
                    "aqi_health_ran": False,
                    "aqi_health_skipped_reason": "skipped because v1 was not selected for this run",
                    "aqi_health_connector_days_checked": 0,
                    "aqi_health_rebuilds_queued": 0,
                    "aqi_health_skipped_already_obs_repaired": 0,
                    "aqi_health_manifest_missing": 0,
                    "aqi_health_manifest_stale": 0,
                    "aqi_health_manifest_empty": 0,
                    "aqi_health_previous_rebuild_failed": 0,
                    "queued_aqi_only_connector_days": [],
                }
            else:
                aqi_health_metrics = run_aqi_health_checks(
                    conn=conn,
                    run_id=int(run_id),
                    env_name=args.env,
                    r2_history_root=resolve_r2_history_root(os.environ),
                    r2_aqilevels_prefix=v1_config_for_legacy_aqi.aqilevels_hourly_data_prefix,
                    dry_run=args.dry_run,
                    run_backfill=args.run_backfill,
                    log=log,
                )
            cross_check_metrics.update(aqi_health_metrics)
            if history_version_mode == "v2":
                existing_planned_aqi_rows = list(cross_check_metrics.get("planned_aqi_rebuild_connector_days") or [])
                existing_aqi_only_rows = list(cross_check_metrics.get("queued_aqi_only_connector_days") or [])
                observation_gap_keys = {
                    (str(gap.get("day_utc") or ""), int(gap.get("connector_id") or 0))
                    for gap in list((cross_check_metrics.get("v2_observations") or {}).get("gaps") or [])
                    if str(gap.get("day_utc") or "") and int(gap.get("connector_id") or 0) > 0
                }
                verified_repair_keys = {
                    (str(result.get("day_utc") or ""), int(result.get("connector_id") or 0))
                    for result in list(cross_check_metrics.get("v2_observation_repair_results") or [])
                    if result.get("status") == "ok"
                }
                v2_aqi_integrity_queue_metrics = queue_v2_aqi_rebuilds_from_integrity_gaps(
                    conn=conn,
                    run_id=int(run_id),
                    env_name=args.env,
                    env=env,
                    v2_aqilevels=cross_check_metrics.get("v2_aqilevels") or {},
                    dry_run=args.dry_run,
                    run_backfill=args.run_backfill,
                    log=log,
                    allowed_connector_ids=v2_allowed_connector_ids,
                    blocked_connector_days=observation_gap_keys - verified_repair_keys,
                )
                cross_check_metrics.update(v2_aqi_integrity_queue_metrics)
                cross_check_metrics["planned_aqi_rebuild_connector_days"] = [
                    *existing_planned_aqi_rows,
                    *(v2_aqi_integrity_queue_metrics.get("planned_aqi_rebuild_connector_days") or []),
                ]
                cross_check_metrics["queued_aqi_only_connector_days"] = [
                    *existing_aqi_only_rows,
                    *(v2_aqi_integrity_queue_metrics.get("queued_aqi_only_connector_days") or []),
                ]
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
                history_version="v2" if history_version_mode == "v2" else "v1",
            )
            cross_check_metrics.update(aqi_rebuild_metrics)
            if history_version_mode == "v2" and (
                int(cross_check_metrics.get("v2_observation_repairs_ok", 0) or 0) > 0
                or int(cross_check_metrics.get("aqi_rebuilds_complete", 0) or 0) > 0
                or int(cross_check_metrics.get("aqi_rebuilds_failed", 0) or 0) > 0
            ):
                pre_obs = cross_check_metrics.get("v2_observations") or {}
                pre_aqi = cross_check_metrics.get("v2_aqilevels") or {}
                post_repair = run_v2_post_repair_integrity_rechecks(
                    conn=conn,
                    env_name=args.env,
                    r2_history_root=resolve_r2_history_root(os.environ),
                    config=history_path_configs["v2"],
                    from_day=from_day,
                    to_day=to_day,
                    allowed_connector_ids=v2_allowed_connector_ids,
                    source_scope=v2_source_scope,
                    check_aqi_debug=bool(args.check_aqi_debug),
                    require_aqi_debug=bool(args.require_aqi_debug),
                    log=log,
                )
                cross_check_metrics["v2_pre_repair_observations"] = pre_obs
                cross_check_metrics["v2_pre_repair_aqilevels"] = pre_aqi
                cross_check_metrics["v2_post_repair"] = post_repair
                cross_check_metrics["v2_observations"] = post_repair["observations"]
                cross_check_metrics["v2_aqilevels"] = post_repair["aqilevels"]
                cross_check_metrics["v2_repair_status_message"] = post_repair["message"]
                post_obs = post_repair["observations"]
                post_aqi = post_repair["aqilevels"]
                post_total = int(post_obs.get("checked_partitions", 0) or 0) + int(post_aqi.get("checked_partitions", 0) or 0)
                post_gaps = (
                    int(post_obs.get("gap_count", 0) or 0)
                    + int(post_aqi.get("gap_count", 0) or 0)
                    + int((post_aqi.get("debug") or {}).get("gap_count", 0) or 0)
                )
                cross_check_metrics["cross_checks_total"] = post_total
                cross_check_metrics["cross_checks_ok"] = post_total if post_repair["status"] == "ok" else 0
                cross_check_metrics["cross_checks_mismatch"] = post_gaps
                cross_check_metrics["discrepancy_total"] = post_gaps

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
        v2_gap_count_for_status = (
            int((cross_check_metrics.get("v2_observations") or {}).get("gap_count", 0) or 0)
            + int((cross_check_metrics.get("v2_aqilevels") or {}).get("gap_count", 0) or 0)
            + int(((cross_check_metrics.get("v2_aqilevels") or {}).get("debug") or {}).get("gap_count", 0) or 0 if ((cross_check_metrics.get("v2_aqilevels") or {}).get("debug") or {}).get("required") else 0)
            + int(((cross_check_metrics.get("additional_history_versions") or {}).get("v2", {}).get("observations") or {}).get("gap_count", 0) or 0)
            + int(((cross_check_metrics.get("additional_history_versions") or {}).get("v2", {}).get("aqilevels") or {}).get("gap_count", 0) or 0)
            + int(((((cross_check_metrics.get("additional_history_versions") or {}).get("v2", {}).get("aqilevels") or {}).get("debug") or {}).get("gap_count", 0) or 0) if ((((cross_check_metrics.get("additional_history_versions") or {}).get("v2", {}).get("aqilevels") or {}).get("debug") or {}).get("required")) else 0)
        )
        if v2_gap_count_for_status > 0:
            status = "fail"

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
            ("sos", sos_metrics),
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
                if cross_check_metrics.get("v2_repair_status_message"):
                    notes_parts.append(
                        "v2-post-repair-check "
                        f"status={(cross_check_metrics.get('v2_post_repair') or {}).get('status')} "
                        f"message={cross_check_metrics.get('v2_repair_status_message')}"
                    )
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
            + v2_gap_count_for_status
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
            "sos_stopped_for": sos_metrics.get("stopped_for"),
            "sos_stations": sos_metrics.get("stations", 0),
            "sos_days": sos_metrics.get("days", 0),
            "sos_station_days_checked": sos_metrics.get("station_days_checked", 0),
            "sos_rows_counted": sos_metrics.get("rows_counted", 0),
            "sos_snapshots_successful": sos_metrics.get("snapshots_successful", 0),
            "sos_snapshots_no_data": sos_metrics.get("snapshots_no_data", 0),
            "sos_not_found": sos_metrics.get("not_found", 0),
            "sos_not_found_suppressed": sos_metrics.get("not_found_suppressed", 0),
            "sos_temporary_errors": sos_metrics.get("temporary_errors", 0),
            "sos_permanent_errors": sos_metrics.get("permanent_errors", 0),
            "sos_lookup_active_stations": int(sos_counts.get("active_stations", 0)),
            "sos_lookup_active_timeseries": int(sos_counts.get("active_timeseries", 0)),
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

        history_version_results: dict[str, Any] = {}
        for version, config in history_path_configs.items():
            if version == "v1":
                history_version_results[version] = {
                    "history_version": "v1",
                    "checks_implemented": True,
                    "status": "checked" if cross_check_metrics.get("ran") else "skipped",
                    "skipped_reason": None if cross_check_metrics.get("ran") else cross_check_metrics.get("skipped_reason"),
                }
            else:
                v2_obs = (
                    cross_check_metrics.get("v2_observations")
                    or (cross_check_metrics.get("additional_history_versions") or {}).get("v2", {}).get("observations")
                    or {"status": "not_implemented", "checked_partitions": 0, "gap_count": 0, "gaps": []}
                )
                v2_aqi = (
                    cross_check_metrics.get("v2_aqilevels")
                    or (cross_check_metrics.get("additional_history_versions") or {}).get("v2", {}).get("aqilevels")
                    or {"status": "not_implemented", "checked_partitions": 0, "gap_count": 0, "gaps": [], "debug": {"checked": False, "required": False, "status": "skipped", "gap_count": 0, "gaps": []}}
                )
                history_version_results[version] = {
                    "history_version": "v2",
                    "checks_implemented": True,
                    "status": "fail" if v2_obs.get("status") == "fail" or v2_aqi.get("status") == "fail" else "ok",
                    "observations": v2_obs,
                    "aqilevels": v2_aqi,
                }

        summary: dict[str, Any] = {
            "env": args.env,
            "profile": args.profile,
            "source": args.source,
            "history_integrity_schema_version": HISTORY_INTEGRITY_SCHEMA_VERSION,
            "history_version_mode": history_version_mode,
            "checked_versions": checked_history_versions,
            "history_path_configs": serialized_history_path_configs,
            "history_version_results": history_version_results,
            "source_scope": v2_source_scope if "v2" in checked_history_versions else None,
            "site_read_version": site_read_version,
            "backfill_env_file": LAST_BACKFILL_ENV_LOAD_RESULT,
            "from_day": from_day,
            "to_day": to_day,
            "dry_run": args.dry_run,
            "check_only": args.check_only,
            "run_backfill": args.run_backfill,
            "force_snapshot_import": args.force_snapshot_import,
            "skip_snapshot_import": args.skip_snapshot_import,
            "skip_cross_check": args.skip_cross_check,
            "allow_stale_dropbox": bool(args.allow_stale_dropbox),
            "backup_readiness": backup_gate_summary,
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
            "sos": sos_metrics,
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
                "allow_stale_dropbox": bool(args.allow_stale_dropbox),
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
                "backup_readiness": backup_gate_summary,
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
                "allow_stale_dropbox": bool(args.allow_stale_dropbox),
                "runtime_seconds": round(time.monotonic() - started_mono, 3),
                "backup_readiness": backup_gate_summary,
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
