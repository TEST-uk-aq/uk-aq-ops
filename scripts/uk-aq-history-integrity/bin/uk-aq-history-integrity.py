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
import datetime as dt
import gzip
import hashlib
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable


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
)

PATH_VARS_FOR_GUARDRAILS = (
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
    "UK_AQ_BACKFILL_WRAPPER",
    "UK_AQ_BACKFILL_ENV_FILE",
)

# (start_offset_back, end_offset_back) in days. The 4-day upper-bound buffer
# gives OpenAQ's 72-hour publication delay room to settle.
PROFILE_WINDOWS_DAYS = {
    "daily":   (21,  4),
    "weekly":  (120, 4),
    "monthly": (730, 4),
}

# ---------------------------------------------------------------------------
# Phase 2 — core snapshot import
# ---------------------------------------------------------------------------

# Source-key canonicalisation: maps the value of `connectors.connector_code`
# in the core snapshot to the source_key strings used by the source adapters
# (and by source_file_state / source_file_events).
SOURCE_KEY_BY_CONNECTOR_CODE = {
    "openaq": "openaq",
    "sensorcommunity": "sensor-community",
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


class LimitTracker:
    """Soft per-run limits: downloaded bytes and runtime minutes.

    The OpenAQ loop checks `should_stop()` before initiating each HEAD/GET.
    When a limit trips, the current file is allowed to finish — the loop
    exits cleanly on the next iteration and the run records status
    `stopped_limit`. Limit checks are advisory; nothing actually aborts an
    in-flight download mid-chunk.
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

    def add_bytes(self, n: int) -> None:
        self.bytes_downloaded += int(n)

    def should_stop(self) -> bool:
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
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            headers = dict(resp.headers)
            status = resp.status
    except urllib.error.HTTPError as e:
        headers = dict(e.headers or {})
        status = e.code

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
    bytes_written = 0
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise RuntimeError(f"GET {url} returned {resp.status}")
        with dest_path.open("wb") as fh:
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                fh.write(chunk)
                bytes_written += len(chunk)
    return bytes_written


def _sha256_uncompressed_gzip(path: Path, chunk_size: int = 65536) -> str:
    hasher = hashlib.sha256()
    with gzip.open(path, "rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


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


def _fetch_prior_state(
    conn: sqlite3.Connection, source_file_key: str
) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT exists_remote, content_length, etag, last_modified_utc,
               sha256_downloaded, sha256_uncompressed, last_status
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
    }


def _metadata_changed(prior: dict[str, Any], head: dict[str, Any]) -> bool:
    return (
        prior.get("etag") != head.get("etag")
        or prior.get("content_length") != head.get("content_length")
        or prior.get("last_modified_utc") != head.get("last_modified")
    )


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
    """Run HEAD + (optional) download + hash for a single OpenAQ file.

    Returns:
      {
        "outcome": one of "missing_first_seen" | "missing_disappeared"
                   | "still_missing" | "first_seen" | "reappeared"
                   | "unchanged_metadata" | "unchanged_content"
                   | "changed" | "error",
        "downloaded_bytes": int,
        "event_id": int | None,
        "event_type": str | None,
        "timeseries_ids": list[int],
      }
    """
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
) -> str:
    wrapper = os.environ.get("UK_AQ_BACKFILL_WRAPPER", "<UK_AQ_BACKFILL_WRAPPER unset>")
    env_file = os.environ.get("UK_AQ_BACKFILL_ENV_FILE", "<UK_AQ_BACKFILL_ENV_FILE unset>")
    ids_csv = ",".join(str(t) for t in timeseries_ids)
    iso = day.isoformat()
    return (
        f"UK_AQ_BACKFILL_RUN_MODE=source_to_r2 "
        f"UK_AQ_BACKFILL_DRY_RUN=false "
        f"UK_AQ_BACKFILL_FORCE_REPLACE=true "
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


def _load_env_file(path: Path) -> dict[str, str]:
    """Parse a bash-style KEY=VALUE env file. Strips matching surrounding
    single or double quotes. Skips blank lines and #-comments. Tolerates an
    optional leading 'export '."""
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
            val = val.strip()
            if len(val) >= 2 and (
                (val.startswith('"') and val.endswith('"'))
                or (val.startswith("'") and val.endswith("'"))
            ):
                val = val[1:-1]
            if key:
                out[key] = val
    return out


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
    timeseries_ids: list[int],
    day: dt.date,
    log: logging.Logger,
    timeout_seconds: int = BACKFILL_DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Invoke `uk_aq_backfill_local_monthly.sh` for one (timeseries-ids, day).

    Returns a result dict suitable for recording on the source_file_events
    row: status in {ok, error, no_wrapper, no_env_file, no_timeseries_ids,
    spawn_error, timeout}, plus exit_code/duration/stdout_tail/stderr_tail/error.
    """
    result: dict[str, Any] = {
        "status": None,
        "exit_code": None,
        "duration_seconds": 0.0,
        "wrapper_path": wrapper_path,
        "env_file_path": env_file_path,
        "stdout_tail": "",
        "stderr_tail": "",
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
        log.info(
            "backfill loading env_file=%s vars=%s",
            env_file_path, sorted(loaded.keys()),
        )
        sub_env.update(loaded)

    iso = day.isoformat()
    sub_env.update({
        "UK_AQ_BACKFILL_RUN_MODE": "source_to_r2",
        "UK_AQ_BACKFILL_DRY_RUN": "false",
        "UK_AQ_BACKFILL_FORCE_REPLACE": "true",
        "UK_AQ_BACKFILL_FROM_DAY_UTC": iso,
        "UK_AQ_BACKFILL_TO_DAY_UTC": iso,
        "UK_AQ_BACKFILL_TIMESERIES_IDS": ",".join(str(t) for t in timeseries_ids),
        # Always force trigger_mode=manual (wrapper enforces this anyway).
        "UK_AQ_BACKFILL_TRIGGER_MODE": "manual",
    })

    started = time.monotonic()
    log.info(
        "backfill invoke wrapper=%s day=%s timeseries_ids=%s",
        wrapper_path, iso, sub_env["UK_AQ_BACKFILL_TIMESERIES_IDS"],
    )
    try:
        proc = subprocess.run(
            ["bash", wrapper_path],
            env=sub_env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        result["exit_code"] = proc.returncode
        result["stdout_tail"] = _tail_bytes(proc.stdout)
        result["stderr_tail"] = _tail_bytes(proc.stderr)
        result["status"] = "ok" if proc.returncode == 0 else "error"
        if proc.returncode != 0:
            result["error"] = f"wrapper exit_code={proc.returncode}"
    except subprocess.TimeoutExpired as exc:
        result["status"] = "timeout"
        result["error"] = f"wrapper timed out after {timeout_seconds}s"
        result["stdout_tail"] = _tail_bytes(exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, (bytes, bytearray)) else (exc.stdout or ""))
        result["stderr_tail"] = _tail_bytes(exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, (bytes, bytearray)) else (exc.stderr or ""))
    except OSError as exc:
        result["status"] = "spawn_error"
        result["error"] = f"spawn failed: {exc}"

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
) -> None:
    """Update the source_file_events row with backfill outcome columns."""
    ids_csv = ",".join(str(t) for t in timeseries_ids) if timeseries_ids else None
    status = backfill.get("status") or "unknown"
    triggered_flag = 1 if status in {"ok", "error", "timeout"} else 0
    # Combine the run-level error with output tails into the notes column so
    # we can audit without keeping a separate logfile per backfill.
    notes_parts: list[str] = []
    if backfill.get("error"):
        notes_parts.append(f"error={backfill['error']}")
    if backfill.get("wrapper_path"):
        notes_parts.append(f"wrapper={backfill['wrapper_path']}")
    if backfill.get("exit_code") is not None:
        notes_parts.append(f"exit_code={backfill['exit_code']}")
    if backfill.get("duration_seconds"):
        notes_parts.append(f"duration_s={backfill['duration_seconds']}")
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
        "changed": 0,
        "unchanged_after_download": 0,
        "missing": 0,
        "errors": 0,
        "downloaded_bytes": 0,
        "changed_files": [],   # list of {location_id, day, event_id, timeseries_ids}
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

    for loc in locations:
        if limits.should_stop():
            break
        for day in days:
            if limits.should_stop():
                break
            try:
                result = _check_one_openaq_file(
                    conn, env_name, base_url, loc, day, tmp_dir, cache_root, log,
                )
                conn.commit()
                metrics["head_checked"] += 1
                outcome = result["outcome"]
                if outcome in {"missing_first_seen", "missing_disappeared", "still_missing"}:
                    metrics["missing"] += 1
                if outcome == "unchanged_content":
                    metrics["downloaded"] += 1
                    metrics["unchanged_after_download"] += 1
                if outcome in {"changed", "first_seen", "reappeared"}:
                    metrics["downloaded"] += 1
                    metrics["changed"] += 1
                    metrics["changed_files"].append({
                        "location_id": loc,
                        "day": day.isoformat(),
                        "event_id": result["event_id"],
                        "event_type": result["event_type"],
                        "timeseries_ids": result["timeseries_ids"],
                    })
                    if run_backfill:
                        cmd = _planned_backfill_command(env, result["timeseries_ids"], day)
                        metrics["planned_backfills"].append(cmd)
                        log.info("openaq planned backfill: %s", cmd)
                        if not dry_run and result.get("event_id"):
                            bf = run_narrow_backfill(
                                wrapper_path=os.environ.get("UK_AQ_BACKFILL_WRAPPER"),
                                env_file_path=os.environ.get("UK_AQ_BACKFILL_ENV_FILE"),
                                timeseries_ids=result["timeseries_ids"],
                                day=day,
                                log=log,
                            )
                            _record_backfill_on_event(
                                conn, int(result["event_id"]),
                                result["timeseries_ids"], bf,
                            )
                            conn.commit()
                            metrics["backfills_attempted"] += 1
                            if bf["status"] == "ok":
                                metrics["backfills_ok"] += 1
                            else:
                                metrics["backfills_failed"] += 1
                bytes_added = int(result.get("downloaded_bytes") or 0)
                if bytes_added:
                    metrics["downloaded_bytes"] += bytes_added
                    limits.add_bytes(bytes_added)
            except Exception as exc:
                conn.rollback()
                metrics["errors"] += 1
                log.warning(
                    "openaq error loc=%s day=%s url=%s: %s",
                    loc, day, _openaq_url(base_url, loc, day), exc,
                )

    if limits.should_stop():
        metrics["stopped_for"] = limits.stopped_for
        log.warning("openaq: stopped early due to limit=%s", limits.stopped_for)

    log.info("openaq: done %s", {k: v for k, v in metrics.items() if k not in ("changed_files", "planned_backfills", "sample_urls")})
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
        choices=["openaq", "sensor-community", "all"],
        help="Source adapter filter (Phase 1: recorded only; no checks yet).",
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


def compute_window(
    profile: str,
    from_day: str | None,
    to_day: str | None,
) -> tuple[str | None, str | None]:
    if profile == "manual":
        return (from_day, to_day)
    today = utc_now().date()
    start_back, end_back = PROFILE_WINDOWS_DAYS[profile]
    default_from = (today - dt.timedelta(days=start_back)).isoformat()
    default_to = (today - dt.timedelta(days=end_back)).isoformat()
    return (from_day or default_from, to_day or default_to)


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
    conn.commit()
    return conn


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
    validate_guardrails(args.env, env)
    ensure_dirs(env)

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

    from_day, to_day = compute_window(args.profile, args.from_day, args.to_day)
    log.info("window from=%s to=%s", from_day, to_day)
    if args.profile == "manual" and (not from_day or not to_day):
        log.warning(
            "manual profile without --from-day/--to-day; window is open-ended"
        )

    conn = open_db(env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"])
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
                "phase2: core snapshot import; no source adapters yet.",
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

        # Phase 3: OpenAQ adapter (Sensor.Community lands in Phase 5).
        limits = LimitTracker(
            max_download_mb=args.max_download_mb,
            max_runtime_minutes=args.max_runtime_minutes,
            started_mono=started_mono,
        )
        openaq_metrics: dict[str, Any] = {"ran": False, "skipped_reason": None}
        run_openaq = (
            args.source in {"openaq", "all"}
            and snapshot_result["status"] in {"imported", "reused"}
        )
        if args.source in {"openaq", "all"} and not run_openaq:
            log.warning(
                "openaq: skipped because core snapshot status=%s (need imported/reused)",
                snapshot_result["status"],
            )

        if run_openaq:
            openaq_metrics = check_openaq(
                conn=conn,
                env_name=args.env,
                env=env,
                from_day=from_day,
                to_day=to_day,
                dry_run=args.dry_run,
                run_backfill=args.run_backfill,
                limits=limits,
                log=log,
            )

        # Decide top-level run status.
        snapshot_ok = snapshot_result["status"] in {"imported", "reused"}
        if openaq_metrics.get("stopped_for"):
            status = "stopped_limit"
        elif openaq_metrics.get("ran"):
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

        if openaq_metrics.get("ran"):
            notes_parts.append(
                f"openaq head_checked={openaq_metrics['head_checked']} "
                f"changed={openaq_metrics['changed']} missing={openaq_metrics['missing']} "
                f"downloaded_bytes={openaq_metrics['downloaded_bytes']} "
                f"errors={openaq_metrics['errors']} "
                f"backfills_attempted={openaq_metrics.get('backfills_attempted', 0)} "
                f"backfills_ok={openaq_metrics.get('backfills_ok', 0)} "
                f"backfills_failed={openaq_metrics.get('backfills_failed', 0)}"
            )
            if openaq_metrics.get("stopped_for"):
                notes_parts.append(f"openaq stopped_for={openaq_metrics['stopped_for']}")
        elif args.source in {"openaq", "all"} and openaq_metrics.get("skipped_reason"):
            notes_parts.append(f"openaq skipped: {openaq_metrics['skipped_reason']}")

        notes = "; ".join(notes_parts) + "."

        # File-checker counters come from the OpenAQ adapter (Sensor.Community
        # will add to these in Phase 5; this is a sum rather than per-source).
        downloaded_bytes_total = int(openaq_metrics.get("downloaded_bytes", 0))
        errors_count = int(openaq_metrics.get("errors", 0)) + int(
            openaq_metrics.get("backfills_failed", 0)
        )
        warnings_count_total = warnings_delta + (
            1 if openaq_metrics.get("skipped_reason") else 0
        )
        if openaq_metrics.get("stopped_for"):
            warnings_count_total += 1

        metrics: dict[str, Any] = {
            "files_head_checked": int(openaq_metrics.get("head_checked", 0)),
            "files_downloaded": int(openaq_metrics.get("downloaded", 0)),
            "files_changed": int(openaq_metrics.get("changed", 0)),
            "files_unchanged_after_download": int(
                openaq_metrics.get("unchanged_after_download", 0)
            ),
            "files_missing": int(openaq_metrics.get("missing", 0)),
            "downloaded_bytes": downloaded_bytes_total,
            "downloaded_mb": round(downloaded_bytes_total / (1024 * 1024), 4),
            "runtime_seconds": 0.0,
            "backfills_triggered": int(openaq_metrics.get("backfills_attempted", 0)),
            "backfills_ok": int(openaq_metrics.get("backfills_ok", 0)),
            "backfills_failed": int(openaq_metrics.get("backfills_failed", 0)),
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
            "max_download_mb": args.max_download_mb,
            "max_runtime_minutes": args.max_runtime_minutes,
            "started_at_utc": started_iso,
            "finished_at_utc": finished_iso,
            "status": status,
            "run_id": run_id,
            "db_path": env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"],
            "log_path": str(log_path),
            "snapshot": snapshot_result,
            "openaq": openaq_metrics,
            "metrics": metrics,
            "notes": notes,
        }
        json_path, md_path = write_reports(
            env["UK_AQ_HISTORY_INTEGRITY_REPORT_DIR"], run_compact, summary
        )
        log.info("report_json=%s", json_path)
        log.info("report_md=%s", md_path)
        log.info("done status=%s runtime_seconds=%s", status, runtime_seconds)
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
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
