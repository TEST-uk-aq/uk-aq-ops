#!/usr/bin/env python3
"""Local-only AQI gap checker for UK-AQ history integrity.

Compares expected hourly AQI presence derived from local observation history
against actual locally backed-up AQI hourly rows. It reports missing logical
AQI rows only; it does not validate stored AQI values and it does not repair
anything.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict, deque
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any


REQUIRED_ENV_VARS = (
    "UK_AQ_ENV_NAME",
    "UK_AQ_HISTORY_INTEGRITY_ROOT",
    "UK_AQ_HISTORY_INTEGRITY_STATE_DIR",
    "UK_AQ_HISTORY_INTEGRITY_DB_PATH",
    "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR",
    "UK_AQ_HISTORY_INTEGRITY_TMP_DIR",
    "UK_AQ_AQI_GAP_LOG_DIR",
    "UK_AQ_AQI_GAP_REPORT_DIR",
    "UK_AQ_HISTORY_INTEGRITY_LOCK_DIR",
    "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT",
)

PATH_VARS_FOR_GUARDRAILS = (
    "UK_AQ_HISTORY_INTEGRITY_ROOT",
    "UK_AQ_HISTORY_INTEGRITY_STATE_DIR",
    "UK_AQ_HISTORY_INTEGRITY_DB_PATH",
    "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR",
    "UK_AQ_HISTORY_INTEGRITY_TMP_DIR",
    "UK_AQ_AQI_GAP_LOG_DIR",
    "UK_AQ_AQI_GAP_REPORT_DIR",
    "UK_AQ_HISTORY_INTEGRITY_LOCK_DIR",
    "UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH",
    "UK_AQ_R2_HISTORY_DROPBOX_ROOT",
    "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT",
    "UK_AQ_BACKFILL_ENV_FILE",
)

PROFILE_START_WINDOWS_DAYS = {
    "daily": 21,
    "weekly": 120,
    "monthly": 730,
}

DEFAULT_INGESTDB_RETENTION_DAYS = 5
SCHEMA_REPO = Path(
    "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/"
    "CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema"
)
AQI_SCHEMA_SQL_PATH = SCHEMA_REPO / "schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql"
RELEVANT_POLLUTANTS = {"no2", "pm25", "pm10"}
DUMP_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
OBS_INSERT_RE = re.compile(
    r'^INSERT INTO "uk_aq_observs"\."observations_(\d{8})" '\
    r'\(([^)]*)\) VALUES$',
)
AQI_INSERT_PREFIX = 'INSERT INTO "uk_aq_aqilevels"."timeseries_aqi_hourly" '
LOGICAL_RULES = (
    {"standard_code": "daqi", "pollutant_code": "no2", "averaging_code": "hourly_mean", "metric_field": "hourly_mean_ugm3"},
    {"standard_code": "daqi", "pollutant_code": "pm25", "averaging_code": "rolling_24h_mean", "metric_field": "rolling24h_mean_ugm3"},
    {"standard_code": "daqi", "pollutant_code": "pm10", "averaging_code": "rolling_24h_mean", "metric_field": "rolling24h_mean_ugm3"},
    {"standard_code": "eaqi", "pollutant_code": "no2", "averaging_code": "hourly_mean", "metric_field": "hourly_mean_ugm3"},
    {"standard_code": "eaqi", "pollutant_code": "pm25", "averaging_code": "hourly_mean", "metric_field": "hourly_mean_ugm3"},
    {"standard_code": "eaqi", "pollutant_code": "pm10", "averaging_code": "hourly_mean", "metric_field": "hourly_mean_ugm3"},
)
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS aqi_gap_check_standard_versions (
  standard_code TEXT NOT NULL,
  version_code TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  notes TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (standard_code, version_code)
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_breakpoints (
  standard_code TEXT NOT NULL,
  version_code TEXT NOT NULL,
  pollutant_code TEXT NOT NULL,
  averaging_code TEXT NOT NULL,
  index_level INTEGER NOT NULL,
  index_label TEXT,
  index_band TEXT NOT NULL,
  color_hex TEXT,
  range_low REAL NOT NULL,
  range_high REAL,
  uom TEXT NOT NULL DEFAULT 'ug/m3',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (
    standard_code,
    version_code,
    pollutant_code,
    averaging_code,
    index_level
  ),
  FOREIGN KEY (standard_code, version_code)
    REFERENCES aqi_gap_check_standard_versions(standard_code, version_code)
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_rule_mirror_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_repo TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_commit_or_version TEXT,
  mirrored_at_utc TEXT NOT NULL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT,
  env_name TEXT NOT NULL,
  profile TEXT,
  source_mode TEXT NOT NULL,
  from_day_utc TEXT NOT NULL,
  to_day_utc TEXT NOT NULL,
  selected_day_count INTEGER DEFAULT 0,
  obs_aqidb_candidate_day_count INTEGER DEFAULT 0,
  r2_excluded_day_count INTEGER DEFAULT 0,
  include_r2_days INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  expected_row_count INTEGER DEFAULT 0,
  actual_row_count INTEGER DEFAULT 0,
  missing_row_count INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  report_json_path TEXT,
  error_message TEXT
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_day_summary (
  run_id INTEGER NOT NULL,
  day_utc TEXT NOT NULL,
  expected_row_count INTEGER DEFAULT 0,
  actual_row_count INTEGER DEFAULT 0,
  missing_row_count INTEGER DEFAULT 0,
  missing_daqi_count INTEGER DEFAULT 0,
  missing_eaqi_count INTEGER DEFAULT 0,
  missing_no2_count INTEGER DEFAULT 0,
  missing_pm25_count INTEGER DEFAULT 0,
  missing_pm10_count INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, day_utc),
  FOREIGN KEY (run_id) REFERENCES aqi_gap_check_runs(id)
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_day_connector_summary (
  run_id INTEGER NOT NULL,
  day_utc TEXT NOT NULL,
  connector_id INTEGER NOT NULL,
  expected_row_count INTEGER DEFAULT 0,
  actual_row_count INTEGER DEFAULT 0,
  missing_row_count INTEGER DEFAULT 0,
  missing_daqi_count INTEGER DEFAULT 0,
  missing_eaqi_count INTEGER DEFAULT 0,
  missing_no2_count INTEGER DEFAULT 0,
  missing_pm25_count INTEGER DEFAULT 0,
  missing_pm10_count INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, day_utc, connector_id),
  FOREIGN KEY (run_id) REFERENCES aqi_gap_check_runs(id)
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_source_files (
  run_id INTEGER NOT NULL,
  source_mode TEXT NOT NULL,
  source_file_path TEXT NOT NULL,
  source_file_role TEXT,
  day_utc TEXT,
  bytes_read INTEGER DEFAULT 0,
  row_count INTEGER DEFAULT 0,
  FOREIGN KEY (run_id) REFERENCES aqi_gap_check_runs(id)
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_report_files (
  run_id INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes_written INTEGER DEFAULT 0,
  FOREIGN KEY (run_id) REFERENCES aqi_gap_check_runs(id)
);
"""


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def fmt_iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def fmt_compact(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def parse_iso_day(value: str | None) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        return None


def shift_iso_day(day_utc: str, delta_days: int) -> str:
    return (dt.date.fromisoformat(day_utc) + dt.timedelta(days=delta_days)).isoformat()


def iter_iso_days(from_day: str, to_day: str) -> list[str]:
    start = dt.date.fromisoformat(from_day)
    end = dt.date.fromisoformat(to_day)
    days: list[str] = []
    cursor = start
    while cursor <= end:
        days.append(cursor.isoformat())
        cursor += dt.timedelta(days=1)
    return days


def normalize_iso_timestamp(raw: Any) -> str | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    text = text.replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$", text):
        text += "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def floor_to_hour_iso(iso_value: str) -> str | None:
    normalized = normalize_iso_timestamp(iso_value)
    if not normalized:
        return None
    parsed = dt.datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    parsed = parsed.replace(minute=0, second=0, microsecond=0)
    return parsed.isoformat().replace("+00:00", "Z")


def iso_to_day(iso_value: str) -> str:
    return normalize_iso_timestamp(iso_value)[:10]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_bool(raw: Any, default: bool = False) -> bool:
    if raw is None:
        return default
    text = str(raw).strip().lower()
    if not text:
        return default
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _load_env_file(path: Path) -> dict[str, str]:
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

    loaded: dict[str, str] = {}
    with path.open() as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            value = _strip_inline_comment(value)
            if len(value) >= 2 and ((value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'"))):
                value = value[1:-1]
            if key:
                loaded[key] = value
    return loaded


def resolve_integrity_root() -> Path:
    env_root = str(os.environ.get("UK_AQ_HISTORY_INTEGRITY_ROOT", "")).strip()
    if env_root:
        return Path(env_root)
    repo_root = Path(__file__).resolve().parents[1]
    deployed_root = Path("/Users/mikehinford/uk-aq-history-integrity")
    if (deployed_root / "env").is_dir():
        return deployed_root
    return repo_root


def load_env_context(args: argparse.Namespace) -> dict[str, str]:
    env_name = args.env or str(os.environ.get("UK_AQ_ENV_NAME", "CIC-Test")).strip() or "CIC-Test"
    env_file_candidates: list[Path] = []
    if args.env_file:
        env_file_candidates.append(Path(args.env_file).expanduser())
    else:
        root = resolve_integrity_root()
        env_file_candidates.append(root / "env" / f"{env_name}.env")
    for candidate in env_file_candidates:
        if candidate.is_file():
            loaded = _load_env_file(candidate)
            for key, value in loaded.items():
                os.environ.setdefault(key, value)
            break
    os.environ.setdefault("UK_AQ_ENV_NAME", env_name)
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        raise SystemExit(
            "ERROR: required env vars not set for AQI gap check. Missing: "
            + ", ".join(missing)
        )
    env = {name: os.environ[name] for name in REQUIRED_ENV_VARS}
    env["UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH"] = str(
        os.environ.get("UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH", "")
    ).strip()
    env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"] = str(
        os.environ.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT", "")
    ).strip()
    env["UK_AQ_BACKFILL_ENV_FILE"] = str(
        os.environ.get("UK_AQ_BACKFILL_ENV_FILE", "")
    ).strip()
    return env


def validate_guardrails(env_name: str, env: Mapping[str, str]) -> None:
    if env["UK_AQ_ENV_NAME"] != env_name:
        raise SystemExit(
            f"ERROR: --env={env_name} but UK_AQ_ENV_NAME={env['UK_AQ_ENV_NAME']}. Refusing to run."
        )
    other = "LIVE" if env_name == "CIC-Test" else "CIC-Test"
    fragment = f"/{other}/"
    for var_name in PATH_VARS_FOR_GUARDRAILS:
        value = str(os.environ.get(var_name, "")).strip()
        if value and fragment in value:
            raise SystemExit(
                f"ERROR: --env={env_name} but {var_name}={value} contains '{fragment}'. Refusing to run."
            )
    db_copy = str(os.environ.get("UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH", "")).strip()
    db_path = env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"]
    if db_copy and db_copy == db_path:
        raise SystemExit(
            "ERROR: UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH must differ from UK_AQ_HISTORY_INTEGRITY_DB_PATH."
        )


def ensure_dirs(env: Mapping[str, str]) -> None:
    for key in (
        "UK_AQ_HISTORY_INTEGRITY_STATE_DIR",
        "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR",
        "UK_AQ_HISTORY_INTEGRITY_TMP_DIR",
        "UK_AQ_AQI_GAP_LOG_DIR",
        "UK_AQ_AQI_GAP_REPORT_DIR",
        "UK_AQ_HISTORY_INTEGRITY_LOCK_DIR",
    ):
        Path(env[key]).mkdir(parents=True, exist_ok=True)


def resolve_integrity_end_back_days(env: Mapping[str, str] | None = None) -> int:
    source = env if env is not None else os.environ
    raw_retention = str(source.get("INGESTDB_RETENTION_DAYS", "")).strip()
    if not raw_retention:
        backfill_env_file = str(source.get("UK_AQ_BACKFILL_ENV_FILE", "")).strip()
        if backfill_env_file:
            try:
                loaded = _load_env_file(Path(backfill_env_file))
                raw_retention = str(loaded.get("INGESTDB_RETENTION_DAYS", "")).strip()
            except OSError:
                raw_retention = ""
    retention_days = DEFAULT_INGESTDB_RETENTION_DAYS
    if raw_retention:
        try:
            parsed = int(raw_retention)
            if parsed > 0:
                retention_days = parsed
        except ValueError:
            # Ignore malformed INGESTDB_RETENTION_DAYS and retain the default retention.
            pass
    return retention_days + 1


def compute_window(profile: str | None, from_day: str | None, to_day: str | None, env: Mapping[str, str]) -> tuple[str | None, str | None]:
    if from_day and to_day:
        return from_day, to_day
    if not profile:
        return from_day, to_day
    if profile == "obsaqidb":
        return from_day, to_day
    today = utc_now().date()
    start_back = PROFILE_START_WINDOWS_DAYS[profile]
    end_back = resolve_integrity_end_back_days(env)
    default_from = (today - dt.timedelta(days=start_back)).isoformat()
    default_to = (today - dt.timedelta(days=end_back)).isoformat()
    return from_day or default_from, to_day or default_to


def setup_logging(log_dir: str, run_compact: str, verbose: bool) -> Path:
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    log_path = Path(log_dir) / f"aqi-gap-check-{run_compact}.log"
    logger = logging.getLogger()
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    file_handler = logging.FileHandler(log_path)
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(file_handler)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.DEBUG if verbose else logging.INFO)
    console_handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(console_handler)
    return log_path


class RunLock:
    def __init__(self, lock_path: Path) -> None:
        self.lock_path = lock_path
        self.handle: Any | None = None

    def __enter__(self) -> "RunLock":
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.lock_path.open("w")
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SystemExit(f"ERROR: lock already held: {self.lock_path}") from exc
        self.handle.write(str(os.getpid()))
        self.handle.flush()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.handle is not None:
            try:
                self.handle.seek(0)
                self.handle.truncate(0)
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            finally:
                self.handle.close()


def open_db(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    return conn


def copy_db_to_dropbox(env: Mapping[str, str], conn: sqlite3.Connection, log: logging.Logger) -> dict[str, Any]:
    result = {
        "status": "skipped",
        "src": env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"],
        "dst": env.get("UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH") or "",
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
        return result
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.Error as exc:
        log.warning("dropbox db copy checkpoint warning: %s", exc)
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
    except Exception as exc:  # noqa: BLE001
        result["status"] = "error"
        result["error"] = str(exc)
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError as cleanup_exc:
            logging.debug("Ignoring non-fatal temporary DB cleanup failure: %s", cleanup_exc)
    return result


def decode_sql_token(token: str) -> Any:
    raw = token.strip()
    if not raw or raw.upper() == "NULL":
        return None
    lower = raw.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    date_match = re.match(r"^(date|timestamp(?:\s+with\s+time\s+zone)?)\s+(.+)$", raw, re.IGNORECASE)
    if date_match:
        return decode_sql_token(date_match.group(2))
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1].replace("''", "'")
    if re.match(r"^-?\d+$", raw):
        try:
            return int(raw)
        except ValueError:
            return raw
    if re.match(r"^-?\d+\.\d+(?:[eE][+-]?\d+)?$", raw) or re.match(r"^-?\d+[eE][+-]?\d+$", raw):
        try:
            return float(raw)
        except ValueError:
            return raw
    return raw


def split_sql_tuple_fields(tuple_text: str) -> list[str]:
    fields: list[str] = []
    current: list[str] = []
    in_single = False
    i = 0
    while i < len(tuple_text):
        ch = tuple_text[i]
        if in_single:
            current.append(ch)
            if ch == "'":
                if i + 1 < len(tuple_text) and tuple_text[i + 1] == "'":
                    current.append("'")
                    i += 2
                    continue
                in_single = False
            i += 1
            continue
        if ch == "'":
            in_single = True
            current.append(ch)
            i += 1
            continue
        if ch == ",":
            fields.append("".join(current).strip())
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    if current:
        fields.append("".join(current).strip())
    return fields


def iter_sql_tuple_dicts(values_block: str, columns: Sequence[str]) -> Iterable[dict[str, Any]]:
    in_single = False
    depth = 0
    start_index: int | None = None
    i = 0
    while i < len(values_block):
        ch = values_block[i]
        if in_single:
            if ch == "'":
                if i + 1 < len(values_block) and values_block[i + 1] == "'":
                    i += 2
                    continue
                in_single = False
            i += 1
            continue
        if ch == "'":
            in_single = True
            i += 1
            continue
        if ch == "(":
            if depth == 0:
                start_index = i + 1
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and start_index is not None:
                tuple_text = values_block[start_index:i]
                raw_fields = split_sql_tuple_fields(tuple_text)
                row = {
                    columns[idx]: decode_sql_token(raw_fields[idx])
                    for idx in range(min(len(columns), len(raw_fields)))
                }
                yield row
                start_index = None
        i += 1


def parse_schema_insert_rows(table_name: str) -> list[dict[str, Any]]:
    sql_text = AQI_SCHEMA_SQL_PATH.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"insert\s+into\s+uk_aq_aqilevels\.{table_name}\s*\((.*?)\)\s*values\s*(.*?)\s*on\s+conflict\b",
        re.IGNORECASE | re.DOTALL,
    )
    match = pattern.search(sql_text)
    if not match:
        raise RuntimeError(f"Unable to locate seed rows for {table_name} in {AQI_SCHEMA_SQL_PATH}")
    columns = [piece.strip() for piece in match.group(1).split(",") if piece.strip()]
    values_block = "\n".join(
        line for line in match.group(2).splitlines()
        if not line.lstrip().startswith("--")
    )
    return list(iter_sql_tuple_dicts(values_block, columns))


def mirror_rules(conn: sqlite3.Connection, log: logging.Logger) -> dict[str, Any]:
    mirrored_at = fmt_iso(utc_now())
    schema_hash = sha256_file(AQI_SCHEMA_SQL_PATH)
    standards = parse_schema_insert_rows("aqi_standard_versions")
    breakpoints = parse_schema_insert_rows("aqi_breakpoints")
    conn.execute("DELETE FROM aqi_gap_check_breakpoints")
    conn.execute("DELETE FROM aqi_gap_check_standard_versions")
    conn.executemany(
        """
        INSERT INTO aqi_gap_check_standard_versions (
          standard_code, version_code, source_name, source_url, notes,
          valid_from, valid_to, is_active, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                row["standard_code"],
                row["version_code"],
                row["source_name"],
                row.get("source_url"),
                row.get("notes"),
                row["valid_from"],
                row.get("valid_to"),
                1 if row.get("is_active") else 0,
                mirrored_at,
            )
            for row in standards
        ],
    )
    conn.executemany(
        """
        INSERT INTO aqi_gap_check_breakpoints (
          standard_code, version_code, pollutant_code, averaging_code,
          index_level, index_label, index_band, color_hex,
          range_low, range_high, uom, valid_from, valid_to, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                row["standard_code"],
                row["version_code"],
                row["pollutant_code"],
                row["averaging_code"],
                int(row["index_level"]),
                row.get("index_label"),
                row["index_band"],
                row.get("color_hex"),
                float(row["range_low"]),
                None if row.get("range_high") is None else float(row["range_high"]),
                row.get("uom") or "ug/m3",
                row["valid_from"],
                row.get("valid_to"),
                mirrored_at,
            )
            for row in breakpoints
        ],
    )
    conn.execute(
        """
        INSERT INTO aqi_gap_check_rule_mirror_state (
          id, source_repo, source_file, source_commit_or_version, mirrored_at_utc, notes
        ) VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_repo=excluded.source_repo,
          source_file=excluded.source_file,
          source_commit_or_version=excluded.source_commit_or_version,
          mirrored_at_utc=excluded.mirrored_at_utc,
          notes=excluded.notes
        """,
        (
            "CIC-test-uk-aq-schema",
            str(AQI_SCHEMA_SQL_PATH),
            schema_hash,
            mirrored_at,
            "Seeded from uk_aq_aqilevels_schema.sql current insert values.",
        ),
    )
    conn.commit()
    log.info("mirrored AQI rules: standards=%s breakpoints=%s", len(standards), len(breakpoints))
    return {
        "source_repo": "CIC-test-uk-aq-schema",
        "source_file": str(AQI_SCHEMA_SQL_PATH),
        "source_commit_or_version": schema_hash,
        "mirrored_at_utc": mirrored_at,
        "standard_row_count": len(standards),
        "breakpoint_row_count": len(breakpoints),
    }


def normalize_pollutant_code(raw: Any) -> str | None:
    value = str(raw or "").strip().lower()
    if not value:
        return None
    value = value.replace("₂", "2")
    if value in {"no2", "nitrogen dioxide (air)", "nitrogen dioxide", "no2 mass", "no₂ mass"}:
        return "no2"
    if value in {"pm2.5", "pm25", "particulate matter < 2.5 µm (aerosol)", "particulate matter < 2.5 um (aerosol)"}:
        return "pm25"
    if value in {"pm10", "particulate matter < 10 µm (aerosol)", "particulate matter < 10 um (aerosol)"}:
        return "pm10"
    if "pm2.5" in value or "pm25" in value:
        return "pm25"
    if "pm10" in value:
        return "pm10"
    if "no2" in value or "nitrogen dioxide" in value:
        return "no2"
    return None


def load_core_bindings(conn: sqlite3.Connection) -> dict[int, dict[str, Any]]:
    query = """
    SELECT
      t.id AS timeseries_id,
      t.station_id AS station_id,
      t.connector_id AS connector_id,
      COALESCE(p.pollutant_label, p.label, p.source_label) AS raw_pollutant
    FROM core_timeseries_snapshot t
    LEFT JOIN core_phenomena_snapshot p
      ON p.id = t.phenomenon_id
    """
    bindings: dict[int, dict[str, Any]] = {}
    for row in conn.execute(query):
        timeseries_id = int(row["timeseries_id"])
        station_id = int(row["station_id"]) if row["station_id"] is not None else 0
        connector_id = int(row["connector_id"]) if row["connector_id"] is not None else 0
        pollutant_code = normalize_pollutant_code(row["raw_pollutant"])
        if station_id <= 0 or connector_id <= 0 or pollutant_code not in RELEVANT_POLLUTANTS:
            continue
        bindings[timeseries_id] = {
            "timeseries_id": timeseries_id,
            "station_id": station_id,
            "connector_id": connector_id,
            "pollutant_code": pollutant_code,
        }
    return bindings


def find_dropbox_app_root(env_name: str) -> Path:
    root_name = str(os.environ.get("UK_AQ_DROPBOX_ROOT", "")).strip() or env_name
    return Path("/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks") / root_name


def find_r2_history_root(env_name: str) -> Path | None:
    candidates = [str(os.environ.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT", "")).strip()]
    base = find_dropbox_app_root(env_name)
    candidates.extend([
        str(base / "R2_history_backup"),
        str(base / "r2-history"),
    ])
    for raw in candidates:
        if not raw:
            continue
        candidate = Path(raw)
        if candidate.is_dir() and (candidate / "history").exists():
            return candidate
    return None


def find_latest_obs_aqidb_dump(env_name: str, warnings: list[str]) -> dict[str, Any]:
    dump_root = find_dropbox_app_root(env_name) / "Supabase_Backup_db_dump" / "obs_aqidb"
    if not dump_root.is_dir():
        raise RuntimeError(f"Obs AQI DB dump root not found: {dump_root}")
    dated_dirs = sorted(
        [path for path in dump_root.iterdir() if path.is_dir() and DUMP_DATE_RE.match(path.name)],
        key=lambda item: item.name,
        reverse=True,
    )
    required = ("schema.sql.gz", "data.sql.gz")
    for day_dir in dated_dirs:
        missing: list[str] = []
        for name in required:
            file_path = day_dir / name
            if not file_path.is_file() or file_path.stat().st_size <= 0:
                missing.append(name)
        if missing:
            warnings.append(
                f"Skipping dump snapshot {day_dir}: missing or placeholder files: {', '.join(missing)}"
            )
            continue
        return {
            "root": dump_root,
            "day_dir": day_dir,
            "schema_path": day_dir / "schema.sql.gz",
            "data_path": day_dir / "data.sql.gz",
            "roles_path": day_dir / "roles.sql.gz",
            "cron_jobs_path": day_dir / "cron_jobs.sql.gz",
        }
    raise RuntimeError(f"No usable obs_aqidb dump snapshot found under {dump_root}")


def scan_dump_observation_days(data_gz_path: Path) -> set[str]:
    days: set[str] = set()
    with gzip.open(data_gz_path, "rt", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            match = OBS_INSERT_RE.match(line)
            if not match:
                continue
            day_token = match.group(1)
            days.add(f"{day_token[:4]}-{day_token[4:6]}-{day_token[6:]}")
    return days


def parse_dump_insert_statement(statement: str) -> tuple[str, list[str], str]:
    match = re.match(
        r'^INSERT INTO "([^"]+)"\."([^"]+)" \(([^)]*)\) VALUES\s*(.*);\s*$',
        statement,
        re.DOTALL,
    )
    if not match:
        raise ValueError("Unsupported INSERT statement")
    table_name = match.group(2)
    columns = [piece.strip().strip('"') for piece in match.group(3).split(',') if piece.strip()]
    values_block = match.group(4)
    return table_name, columns, values_block


def parse_dump_rows(
    data_gz_path: Path,
    selected_days: set[str],
    warmup_days: set[str],
    bindings: Mapping[int, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[tuple[int, str, str, str], dict[str, Any]], list[dict[str, Any]]]:
    observations: list[dict[str, Any]] = []
    actual_rows: dict[tuple[int, str, str, str], dict[str, Any]] = {}
    source_files: list[dict[str, Any]] = []
    target_obs_tables = {
        f"observations_{day.replace('-', '')}": day
        for day in (selected_days | warmup_days)
    }
    current_statement: list[str] = []
    current_target: str | None = None
    rows_parsed_by_role: Counter[str] = Counter()

    with gzip.open(data_gz_path, "rt", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            stripped = raw_line.rstrip("\n")
            if current_target is None:
                obs_match = OBS_INSERT_RE.match(stripped.strip())
                if obs_match:
                    table_name = f"observations_{obs_match.group(1)}"
                    if table_name in target_obs_tables:
                        current_target = table_name
                        current_statement = [stripped]
                    continue
                if stripped.strip().startswith(AQI_INSERT_PREFIX):
                    current_target = "timeseries_aqi_hourly"
                    current_statement = [stripped]
                    continue
                continue
            current_statement.append(stripped)
            if stripped.strip().endswith(";"):
                statement_text = "\n".join(current_statement)
                table_name, columns, values_block = parse_dump_insert_statement(statement_text)
                if table_name.startswith("observations_"):
                    day_utc = target_obs_tables.get(table_name)
                    if day_utc:
                        row_count = 0
                        for row in iter_sql_tuple_dicts(values_block, columns):
                            timeseries_id = int(row.get("timeseries_id") or 0)
                            binding = bindings.get(timeseries_id)
                            if not binding:
                                continue
                            observed_at = normalize_iso_timestamp(row.get("observed_at"))
                            value = row.get("value")
                            if observed_at is None or value is None:
                                continue
                            try:
                                numeric_value = float(value)
                            except (TypeError, ValueError):
                                continue
                            if numeric_value < 0:
                                continue
                            connector_id = int(row.get("connector_id") or binding["connector_id"])
                            observations.append({
                                "connector_id": connector_id,
                                "timeseries_id": timeseries_id,
                                "station_id": int(binding["station_id"]),
                                "pollutant_code": binding["pollutant_code"],
                                "observed_at": observed_at,
                                "value": numeric_value,
                            })
                            row_count += 1
                        rows_parsed_by_role[f"observations:{day_utc}"] += row_count
                elif table_name == "timeseries_aqi_hourly":
                    row_count = 0
                    for row in iter_sql_tuple_dicts(values_block, columns):
                        timestamp_hour_utc = normalize_iso_timestamp(row.get("timestamp_hour_utc"))
                        if not timestamp_hour_utc:
                            continue
                        day_utc = timestamp_hour_utc[:10]
                        if day_utc not in selected_days:
                            continue
                        timeseries_id = int(row.get("timeseries_id") or 0)
                        pollutant_code = normalize_pollutant_code(row.get("pollutant_code"))
                        if timeseries_id <= 0 or pollutant_code not in RELEVANT_POLLUTANTS:
                            continue
                        base = {
                            "timeseries_id": timeseries_id,
                            "station_id": int(row.get("station_id") or 0),
                            "connector_id": int(row.get("connector_id") or 0),
                            "pollutant_code": pollutant_code,
                            "timestamp_hour_utc": timestamp_hour_utc,
                            "daqi_index_level": None if row.get("daqi_index_level") is None else int(row["daqi_index_level"]),
                            "eaqi_index_level": None if row.get("eaqi_index_level") is None else int(row["eaqi_index_level"]),
                        }
                        if base["daqi_index_level"] is not None:
                            actual_rows[(timeseries_id, timestamp_hour_utc, pollutant_code, "daqi")] = base
                        if base["eaqi_index_level"] is not None:
                            actual_rows[(timeseries_id, timestamp_hour_utc, pollutant_code, "eaqi")] = base
                        row_count += 1
                    rows_parsed_by_role["timeseries_aqi_hourly"] += row_count
                current_statement = []
                current_target = None

    for role, row_count in sorted(rows_parsed_by_role.items()):
        source_files.append({
            "source_file_path": str(data_gz_path),
            "source_file_role": role,
            "day_utc": role.split(":", 1)[1] if role.startswith("observations:") else None,
            "bytes_read": data_gz_path.stat().st_size,
            "row_count": row_count,
        })
    return observations, actual_rows, source_files


def build_r2_day_manifest_days(root: Path, warnings: list[str]) -> set[str]:
    days: set[str] = set()
    aqi_root = root / "history" / "v1" / "aqilevels"
    if not aqi_root.is_dir():
        warnings.append(f"Local R2 aqilevels root not found: {aqi_root}")
        return days
    placeholder_count = 0
    placeholder_examples: list[str] = []
    for day_dir in sorted(aqi_root.glob("day_utc=*")):
        day_utc = day_dir.name.split("=", 1)[-1]
        manifest = day_dir / "manifest.json"
        if manifest.is_file() and manifest.stat().st_size > 0:
            days.add(day_utc)
        elif manifest.exists():
            placeholder_count += 1
            if len(placeholder_examples) < 5:
                placeholder_examples.append(str(manifest))
    if placeholder_count:
        warnings.append(
            "R2 aqilevels day manifests unavailable locally "
            f"(placeholder/empty): {placeholder_count} days. "
            f"Examples: {', '.join(placeholder_examples)}"
        )
    return days


def discover_r2_parquet_files(root: Path, domain: str, days: set[str], warnings: list[str]) -> tuple[list[str], list[dict[str, Any]]]:
    files: list[str] = []
    source_files: list[dict[str, Any]] = []
    missing_day_dirs: list[str] = []
    placeholder_count = 0
    placeholder_examples: list[str] = []
    for day_utc in sorted(days):
        day_dir = root / "history" / "v1" / domain / f"day_utc={day_utc}"
        if not day_dir.is_dir():
            missing_day_dirs.append(str(day_dir))
            continue
        for connector_dir in sorted(day_dir.glob("connector_id=*")):
            for parquet_path in sorted(connector_dir.glob("*.parquet")):
                size = parquet_path.stat().st_size if parquet_path.exists() else 0
                if size <= 4:
                    placeholder_count += 1
                    if len(placeholder_examples) < 5:
                        placeholder_examples.append(str(parquet_path))
                    continue
                files.append(str(parquet_path))
                source_files.append({
                    "source_file_path": str(parquet_path),
                    "source_file_role": f"{domain}_parquet",
                    "day_utc": day_utc,
                    "bytes_read": size,
                    "row_count": 0,
                })
    if missing_day_dirs:
        warnings.append(
            f"R2 {domain} day dirs missing locally: {len(missing_day_dirs)}. "
            f"Examples: {', '.join(missing_day_dirs[:5])}"
        )
    if placeholder_count:
        warnings.append(
            f"R2 {domain} parquet files unavailable locally "
            f"(placeholder/empty): {placeholder_count}. "
            f"Examples: {', '.join(placeholder_examples)}"
        )
    return files, source_files


def run_duckdb_json(query: str) -> list[dict[str, Any]]:
    duckdb_bin = shutil.which("duckdb") or "/opt/homebrew/bin/duckdb"
    if not Path(duckdb_bin).exists():
        raise RuntimeError("duckdb CLI not found; required for --source r2-dropbox")
    proc = subprocess.run(
        [duckdb_bin, "-json", "-c", query],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.strip() or proc.stdout.strip()
        raise RuntimeError(f"duckdb query failed: {stderr}")
    payload = proc.stdout.strip()
    if not payload:
        return []
    parsed = json.loads(payload)
    if isinstance(parsed, list):
        return [dict(item) for item in parsed]
    if isinstance(parsed, dict):
        return [dict(parsed)]
    return []


def sql_quote_paths(paths: Sequence[str]) -> str:
    return ", ".join("'" + path.replace("'", "''") + "'" for path in paths)


def load_r2_rows(
    root: Path,
    selected_days: set[str],
    warmup_days: set[str],
    bindings: Mapping[int, Mapping[str, Any]],
    warnings: list[str],
) -> tuple[list[dict[str, Any]], dict[tuple[int, str, str, str], dict[str, Any]], list[dict[str, Any]]]:
    obs_files, obs_source_files = discover_r2_parquet_files(root, "observations", selected_days | warmup_days, warnings)
    aqi_files, aqi_source_files = discover_r2_parquet_files(root, "aqilevels", selected_days, warnings)
    observations: list[dict[str, Any]] = []
    actual_rows: dict[tuple[int, str, str, str], dict[str, Any]] = {}
    if obs_files:
        query = (
            "SELECT connector_id, timeseries_id, observed_at, value "
            f"FROM read_parquet([{sql_quote_paths(obs_files)}])"
        )
        for row in run_duckdb_json(query):
            timeseries_id = int(row.get("timeseries_id") or 0)
            binding = bindings.get(timeseries_id)
            if not binding:
                continue
            observed_at = normalize_iso_timestamp(row.get("observed_at"))
            if not observed_at:
                continue
            try:
                numeric_value = float(row.get("value"))
            except (TypeError, ValueError):
                continue
            if numeric_value < 0:
                continue
            observations.append({
                "connector_id": int(row.get("connector_id") or binding["connector_id"]),
                "timeseries_id": timeseries_id,
                "station_id": int(binding["station_id"]),
                "pollutant_code": binding["pollutant_code"],
                "observed_at": observed_at,
                "value": numeric_value,
            })
    if aqi_files:
        query = (
            "SELECT timeseries_id, station_id, connector_id, pollutant_code, "
            "timestamp_hour_utc, daqi_index_level, eaqi_index_level "
            f"FROM read_parquet([{sql_quote_paths(aqi_files)}])"
        )
        for row in run_duckdb_json(query):
            timestamp_hour_utc = normalize_iso_timestamp(row.get("timestamp_hour_utc"))
            if not timestamp_hour_utc or timestamp_hour_utc[:10] not in selected_days:
                continue
            timeseries_id = int(row.get("timeseries_id") or 0)
            pollutant_code = normalize_pollutant_code(row.get("pollutant_code"))
            if timeseries_id <= 0 or pollutant_code not in RELEVANT_POLLUTANTS:
                continue
            base = {
                "timeseries_id": timeseries_id,
                "station_id": int(row.get("station_id") or 0),
                "connector_id": int(row.get("connector_id") or 0),
                "pollutant_code": pollutant_code,
                "timestamp_hour_utc": timestamp_hour_utc,
                "daqi_index_level": None if row.get("daqi_index_level") is None else int(row["daqi_index_level"]),
                "eaqi_index_level": None if row.get("eaqi_index_level") is None else int(row["eaqi_index_level"]),
            }
            if base["daqi_index_level"] is not None:
                actual_rows[(timeseries_id, timestamp_hour_utc, pollutant_code, "daqi")] = base
            if base["eaqi_index_level"] is not None:
                actual_rows[(timeseries_id, timestamp_hour_utc, pollutant_code, "eaqi")] = base
    return observations, actual_rows, obs_source_files + aqi_source_files


def load_rule_set(conn: sqlite3.Connection) -> dict[tuple[str, str, str], list[dict[str, Any]]]:
    query = """
    SELECT
      b.standard_code,
      b.version_code,
      b.pollutant_code,
      b.averaging_code,
      b.index_level,
      b.index_label,
      b.index_band,
      b.color_hex,
      b.range_low,
      b.range_high,
      b.valid_from,
      b.valid_to,
      v.is_active
    FROM aqi_gap_check_breakpoints b
    JOIN aqi_gap_check_standard_versions v
      ON v.standard_code = b.standard_code
     AND v.version_code = b.version_code
    ORDER BY b.standard_code, b.pollutant_code, b.averaging_code, b.index_level
    """
    rules: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in conn.execute(query):
        key = (row["standard_code"], row["pollutant_code"], row["averaging_code"])
        rules[key].append({
            "standard_code": row["standard_code"],
            "version_code": row["version_code"],
            "pollutant_code": row["pollutant_code"],
            "averaging_code": row["averaging_code"],
            "index_level": int(row["index_level"]),
            "index_label": row["index_label"],
            "index_band": row["index_band"],
            "color_hex": row["color_hex"],
            "range_low": float(row["range_low"]),
            "range_high": None if row["range_high"] is None else float(row["range_high"]),
            "valid_from": row["valid_from"],
            "valid_to": row["valid_to"],
            "is_active": bool(row["is_active"]),
        })
    return rules


def lookup_rule(rules: Mapping[tuple[str, str, str], list[dict[str, Any]]], *, standard_code: str, pollutant_code: str, averaging_code: str, metric_value: float | None, effective_day: str) -> dict[str, Any] | None:
    if metric_value is None or metric_value < 0:
        return None
    candidates = [
        row for row in rules.get((standard_code, pollutant_code, averaging_code), [])
        if row["is_active"] and row["valid_from"] <= effective_day and (row["valid_to"] is None or row["valid_to"] >= effective_day)
    ]
    if not candidates:
        return None
    first_low = candidates[0]["range_low"]
    if metric_value < first_low:
        return None
    for row in candidates:
        high = row["range_high"]
        if high is None or metric_value <= high:
            return row
    return None


def build_expected_rows(
    observations: Sequence[Mapping[str, Any]],
    selected_days: set[str],
    rules: Mapping[tuple[str, str, str], list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    hourly_groups: dict[tuple[int, str], dict[str, Any]] = {}
    for row in observations:
        pollutant_code = str(row["pollutant_code"])
        if pollutant_code not in RELEVANT_POLLUTANTS:
            continue
        observed_at = normalize_iso_timestamp(row["observed_at"])
        if not observed_at:
            continue
        hour_iso = floor_to_hour_iso(observed_at)
        if not hour_iso:
            continue
        value = float(row["value"])
        if value < 0:
            continue
        key = (int(row["timeseries_id"]), hour_iso)
        current = hourly_groups.get(key)
        if current is None:
            current = {
                "timeseries_id": int(row["timeseries_id"]),
                "station_id": int(row["station_id"]),
                "connector_id": int(row["connector_id"]),
                "pollutant_code": pollutant_code,
                "timestamp_hour_utc": hour_iso,
                "sum": 0.0,
                "count": 0,
            }
            hourly_groups[key] = current
        current["sum"] += value
        current["count"] += 1

    hourly_rows = sorted(hourly_groups.values(), key=lambda item: (item["timeseries_id"], item["timestamp_hour_utc"]))
    rows_by_timeseries: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in hourly_rows:
        row["hourly_mean_ugm3"] = row["sum"] / row["count"] if row["count"] else None
        row["hourly_sample_count"] = row["count"] if row["count"] else None
        row["rolling24h_mean_ugm3"] = None
        rows_by_timeseries[row["timeseries_id"]].append(row)

    for rows in rows_by_timeseries.values():
        window: deque[dict[str, Any]] = deque()
        rolling_sum = 0.0
        for row in rows:
            current_ts = dt.datetime.fromisoformat(row["timestamp_hour_utc"].replace("Z", "+00:00"))
            while window:
                oldest_ts = dt.datetime.fromisoformat(window[0]["timestamp_hour_utc"].replace("Z", "+00:00"))
                if (current_ts - oldest_ts).total_seconds() / 3600 > 23:
                    popped = window.popleft()
                    rolling_sum -= float(popped["hourly_mean_ugm3"])
                else:
                    break
            if row["hourly_mean_ugm3"] is not None:
                window.append(row)
                rolling_sum += float(row["hourly_mean_ugm3"])
            if row["pollutant_code"] in {"pm25", "pm10"} and len(window) >= 18:
                row["rolling24h_mean_ugm3"] = rolling_sum / len(window)

    expected_rows: list[dict[str, Any]] = []
    for row in hourly_rows:
        day_utc = row["timestamp_hour_utc"][:10]
        if day_utc not in selected_days:
            continue
        for rule_def in LOGICAL_RULES:
            if rule_def["pollutant_code"] != row["pollutant_code"]:
                continue
            metric_value = row.get(rule_def["metric_field"])
            if metric_value is None:
                continue
            matched_rule = lookup_rule(
                rules,
                standard_code=rule_def["standard_code"],
                pollutant_code=rule_def["pollutant_code"],
                averaging_code=rule_def["averaging_code"],
                metric_value=float(metric_value),
                effective_day=day_utc,
            )
            if not matched_rule:
                continue
            expected_rows.append({
                "day_utc": day_utc,
                "timestamp_hour_utc": row["timestamp_hour_utc"],
                "timeseries_id": int(row["timeseries_id"]),
                "station_id": int(row["station_id"]),
                "connector_id": int(row["connector_id"]),
                "pollutant_code": row["pollutant_code"],
                "standard_code": rule_def["standard_code"],
                "averaging_code": rule_def["averaging_code"],
                "expected_metric_value": float(metric_value),
                "expected_index_level": int(matched_rule["index_level"]),
                "expected_index_band": matched_rule["index_band"],
                "reason": "missing_aqilevel_row",
            })
    expected_rows.sort(key=lambda item: (item["timestamp_hour_utc"], item["connector_id"], item["timeseries_id"], item["standard_code"]))
    return expected_rows


def compare_expected_vs_actual(expected_rows: Sequence[Mapping[str, Any]], actual_rows: Mapping[tuple[int, str, str, str], Mapping[str, Any]]) -> tuple[int, list[dict[str, Any]]]:
    actual_count = 0
    missing_rows: list[dict[str, Any]] = []
    for row in expected_rows:
        key = (
            int(row["timeseries_id"]),
            str(row["timestamp_hour_utc"]),
            str(row["pollutant_code"]),
            str(row["standard_code"]),
        )
        if key in actual_rows:
            actual_count += 1
            continue
        missing_rows.append(dict(row))
    return actual_count, missing_rows


def build_missing_summaries(missing_rows: Sequence[Mapping[str, Any]], expected_rows: Sequence[Mapping[str, Any]], actual_row_count: int) -> dict[str, Any]:
    day_expected_counter: Counter[str] = Counter(row["day_utc"] for row in expected_rows)
    day_missing_counter: Counter[str] = Counter(row["day_utc"] for row in missing_rows)
    by_day: dict[str, dict[str, Any]] = {}
    for day_utc in sorted(day_expected_counter):
        rows_for_day = [row for row in missing_rows if row["day_utc"] == day_utc]
        by_day[day_utc] = {
            "expected_row_count": int(day_expected_counter[day_utc]),
            "actual_row_count": int(day_expected_counter[day_utc] - day_missing_counter[day_utc]),
            "missing_row_count": int(day_missing_counter[day_utc]),
            "missing_daqi_count": sum(1 for row in rows_for_day if row["standard_code"] == "daqi"),
            "missing_eaqi_count": sum(1 for row in rows_for_day if row["standard_code"] == "eaqi"),
            "missing_no2_count": sum(1 for row in rows_for_day if row["pollutant_code"] == "no2"),
            "missing_pm25_count": sum(1 for row in rows_for_day if row["pollutant_code"] == "pm25"),
            "missing_pm10_count": sum(1 for row in rows_for_day if row["pollutant_code"] == "pm10"),
        }
    expected_by_day_connector: Counter[tuple[str, int]] = Counter((row["day_utc"], int(row["connector_id"])) for row in expected_rows)
    missing_by_day_connector: Counter[tuple[str, int]] = Counter((row["day_utc"], int(row["connector_id"])) for row in missing_rows)
    connector_entries: list[dict[str, Any]] = []
    for key in sorted(expected_by_day_connector):
        day_utc, connector_id = key
        rows_for_group = [row for row in missing_rows if row["day_utc"] == day_utc and int(row["connector_id"]) == connector_id]
        connector_entries.append({
            "day_utc": day_utc,
            "connector_id": connector_id,
            "expected_row_count": int(expected_by_day_connector[key]),
            "actual_row_count": int(expected_by_day_connector[key] - missing_by_day_connector[key]),
            "missing_row_count": int(missing_by_day_connector[key]),
            "missing_daqi_count": sum(1 for row in rows_for_group if row["standard_code"] == "daqi"),
            "missing_eaqi_count": sum(1 for row in rows_for_group if row["standard_code"] == "eaqi"),
            "missing_no2_count": sum(1 for row in rows_for_group if row["pollutant_code"] == "no2"),
            "missing_pm25_count": sum(1 for row in rows_for_group if row["pollutant_code"] == "pm25"),
            "missing_pm10_count": sum(1 for row in rows_for_group if row["pollutant_code"] == "pm10"),
        })
    return {
        "missing_by_day": by_day,
        "missing_by_day_connector": connector_entries,
        "missing_by_standard": dict(Counter(row["standard_code"] for row in missing_rows)),
        "missing_by_pollutant": dict(Counter(row["pollutant_code"] for row in missing_rows)),
        "expected_row_count": len(expected_rows),
        "actual_row_count": actual_row_count,
        "missing_row_count": len(missing_rows),
    }


def write_reports(output_dir: Path, base_name: str, report: Mapping[str, Any]) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"{base_name}.json"
    md_path = output_dir / f"{base_name}.md"
    json_path.write_text(json.dumps(report, indent=2, sort_keys=True))
    md_lines = [
        f"# UK-AQ AQI Gap Check — {report['source_mode']} / {report.get('profile') or 'manual'}",
        "",
        f"- Generated: {report['generated_at']}",
        f"- Source:    {report['source_mode']}",
        f"- Window:    {report['from_day']} -> {report['to_day']}",
        f"- Selected days: {len(report.get('selected_days') or [])}",
        f"- Expected rows: {report['expected_row_count']}",
        f"- Actual rows:   {report['actual_row_count']}",
        f"- Missing rows:  {report['missing_row_count']}",
        f"- Warnings:      {len(report.get('warnings') or [])}",
        "",
        "## Missing by day",
        "",
    ]
    missing_by_day = report.get("missing_by_day") or {}
    if missing_by_day:
        for day_utc, summary in missing_by_day.items():
            md_lines.append(
                f"- {day_utc}: missing={summary.get('missing_row_count', 0)} expected={summary.get('expected_row_count', 0)} actual={summary.get('actual_row_count', 0)}"
            )
    else:
        md_lines.append("- none")
    if report.get("warnings"):
        md_lines.extend(["", "## Warnings", ""])
        for warning in report["warnings"]:
            md_lines.append(f"- {warning}")
    md_lines.append("")
    md_path.write_text("\n".join(md_lines))
    return json_path, md_path


def resolve_output_dir(env: Mapping[str, str], args: argparse.Namespace) -> Path:
    if args.output_dir:
        return Path(args.output_dir).expanduser()
    return Path(env["UK_AQ_AQI_GAP_REPORT_DIR"])


def record_run_summaries(
    conn: sqlite3.Connection,
    run_id: int,
    report: Mapping[str, Any],
    source_files: Sequence[Mapping[str, Any]],
    report_files: Sequence[Mapping[str, Any]],
) -> None:
    conn.execute("DELETE FROM aqi_gap_check_day_summary WHERE run_id = ?", (run_id,))
    conn.execute("DELETE FROM aqi_gap_check_day_connector_summary WHERE run_id = ?", (run_id,))
    conn.execute("DELETE FROM aqi_gap_check_source_files WHERE run_id = ?", (run_id,))
    conn.execute("DELETE FROM aqi_gap_check_report_files WHERE run_id = ?", (run_id,))
    for day_utc, summary in (report.get("missing_by_day") or {}).items():
        conn.execute(
            """
            INSERT INTO aqi_gap_check_day_summary (
              run_id, day_utc, expected_row_count, actual_row_count, missing_row_count,
              missing_daqi_count, missing_eaqi_count, missing_no2_count,
              missing_pm25_count, missing_pm10_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                day_utc,
                int(summary.get("expected_row_count", 0)),
                int(summary.get("actual_row_count", 0)),
                int(summary.get("missing_row_count", 0)),
                int(summary.get("missing_daqi_count", 0)),
                int(summary.get("missing_eaqi_count", 0)),
                int(summary.get("missing_no2_count", 0)),
                int(summary.get("missing_pm25_count", 0)),
                int(summary.get("missing_pm10_count", 0)),
            ),
        )
    for summary in report.get("missing_by_day_connector") or []:
        conn.execute(
            """
            INSERT INTO aqi_gap_check_day_connector_summary (
              run_id, day_utc, connector_id, expected_row_count, actual_row_count,
              missing_row_count, missing_daqi_count, missing_eaqi_count,
              missing_no2_count, missing_pm25_count, missing_pm10_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                summary["day_utc"],
                int(summary["connector_id"]),
                int(summary.get("expected_row_count", 0)),
                int(summary.get("actual_row_count", 0)),
                int(summary.get("missing_row_count", 0)),
                int(summary.get("missing_daqi_count", 0)),
                int(summary.get("missing_eaqi_count", 0)),
                int(summary.get("missing_no2_count", 0)),
                int(summary.get("missing_pm25_count", 0)),
                int(summary.get("missing_pm10_count", 0)),
            ),
        )
    for entry in source_files:
        conn.execute(
            """
            INSERT INTO aqi_gap_check_source_files (
              run_id, source_mode, source_file_path, source_file_role, day_utc, bytes_read, row_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                report["source_mode"],
                entry.get("source_file_path"),
                entry.get("source_file_role"),
                entry.get("day_utc"),
                int(entry.get("bytes_read", 0) or 0),
                int(entry.get("row_count", 0) or 0),
            ),
        )
    for entry in report_files:
        conn.execute(
            """
            INSERT INTO aqi_gap_check_report_files (
              run_id, report_type, path, bytes_written
            ) VALUES (?, ?, ?, ?)
            """,
            (
                run_id,
                entry.get("report_type"),
                entry.get("path"),
                int(entry.get("bytes_written", 0) or 0),
            ),
        )
    conn.commit()


def pick_source_mode(args: argparse.Namespace) -> str:
    if args.source:
        return args.source
    if args.profile == "obsaqidb":
        return "db-dump"
    return "r2-dropbox"


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="uk-aq-aqi-gap-check",
        description="Local AQI gap checker for backed-up observations and AQI history.",
    )
    parser.add_argument("--env", choices=["CIC-Test", "LIVE"], default=os.environ.get("UK_AQ_ENV_NAME", "CIC-Test"))
    parser.add_argument("--env-file", default=None)
    parser.add_argument("--profile", choices=["daily", "weekly", "monthly", "obsaqidb"], default=None)
    parser.add_argument("--from-day", dest="from_day", default=None)
    parser.add_argument("--to-day", dest="to_day", default=None)
    parser.add_argument("--source", choices=["r2-dropbox", "db-dump"], default=None)
    parser.add_argument("--include-r2-days", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--limit-missing", type=int, default=0)
    parser.add_argument("--output-dir", default=None)
    args = parser.parse_args(list(argv))
    args.from_day = parse_iso_day(args.from_day)
    args.to_day = parse_iso_day(args.to_day)
    if any([args.from_day, args.to_day]) and not all([args.from_day, args.to_day]):
        parser.error("--from-day and --to-day must be supplied together")
    if args.from_day and args.to_day and args.from_day > args.to_day:
        parser.error("--from-day must be <= --to-day")
    if not args.profile and not (args.from_day and args.to_day):
        parser.error("Provide either --profile or both --from-day and --to-day")
    return args


def preview_missing_rows(missing_rows: Sequence[Mapping[str, Any]], limit: int) -> list[str]:
    if limit <= 0:
        return []
    preview: list[str] = []
    for row in list(missing_rows)[:limit]:
        preview.append(
            f"{row['timestamp_hour_utc']} connector={row['connector_id']} timeseries={row['timeseries_id']} "
            f"pollutant={row['pollutant_code']} standard={row['standard_code']} averaging={row['averaging_code']} "
            f"metric={row['expected_metric_value']} index={row['expected_index_level']}"
        )
    return preview


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    env = load_env_context(args)
    validate_guardrails(args.env, env)
    ensure_dirs(env)

    started_at = utc_now()
    run_compact = fmt_compact(started_at)
    lock_path = Path(env["UK_AQ_HISTORY_INTEGRITY_LOCK_DIR"]) / f"aqi-gap-check-{args.env}.lock"

    with RunLock(lock_path):
        log_path = setup_logging(env["UK_AQ_AQI_GAP_LOG_DIR"], run_compact, args.verbose)
        log = logging.getLogger("uk-aq-aqi-gap-check")
        log.info("start env=%s profile=%s source=%s", args.env, args.profile or "manual", args.source or "(default)")
        log.info("db=%s", env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"])
        conn = open_db(env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"])
        run_id: int | None = None
        report_json_path: Path | None = None
        warnings: list[str] = []
        source_files: list[dict[str, Any]] = []
        try:
            rules_state = mirror_rules(conn, log)
            source_mode = pick_source_mode(args)
            computed_from_day, computed_to_day = compute_window(args.profile, args.from_day, args.to_day, env)
            selected_days: list[str] = []
            obs_aqidb_candidate_day_count = 0
            r2_excluded_day_count = 0
            latest_dump: dict[str, Any] | None = None
            r2_root = find_r2_history_root(args.env)
            if source_mode == "db-dump" or args.profile == "obsaqidb":
                latest_dump = find_latest_obs_aqidb_dump(args.env, warnings)
            if args.profile == "obsaqidb" and not (args.from_day and args.to_day):
                if latest_dump is None:
                    raise RuntimeError("obsaqidb profile requires a usable local obs_aqidb dump")
                obs_candidate_days = scan_dump_observation_days(latest_dump["data_path"])
                today_utc = utc_now().date().isoformat()
                obs_candidate_days = {day for day in obs_candidate_days if day != today_utc}
                obs_aqidb_candidate_day_count = len(obs_candidate_days)
                r2_days = build_r2_day_manifest_days(r2_root, warnings) if r2_root else set()
                if not args.include_r2_days:
                    excluded_days = obs_candidate_days & r2_days
                    r2_excluded_day_count = len(excluded_days)
                    obs_candidate_days = obs_candidate_days - excluded_days
                selected_days = sorted(obs_candidate_days)
                if selected_days:
                    computed_from_day = selected_days[0]
                    computed_to_day = selected_days[-1]
                else:
                    computed_from_day = computed_from_day or ""
                    computed_to_day = computed_to_day or ""
            else:
                if not (computed_from_day and computed_to_day):
                    raise RuntimeError("Unable to resolve run day window")
                selected_days = iter_iso_days(computed_from_day, computed_to_day)

            cur = conn.execute(
                """
                INSERT INTO aqi_gap_check_runs (
                  started_at_utc, env_name, profile, source_mode, from_day_utc, to_day_utc,
                  selected_day_count, obs_aqidb_candidate_day_count, r2_excluded_day_count,
                  include_r2_days, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fmt_iso(started_at),
                    args.env,
                    args.profile or "manual",
                    source_mode,
                    computed_from_day or "",
                    computed_to_day or "",
                    len(selected_days),
                    obs_aqidb_candidate_day_count,
                    r2_excluded_day_count,
                    1 if args.include_r2_days else 0,
                    "running",
                ),
            )
            run_id = int(cur.lastrowid)
            conn.commit()

            bindings = load_core_bindings(conn)
            if not bindings:
                raise RuntimeError("No core timeseries bindings found in integrity SQLite DB")
            log.info("core bindings loaded: %s relevant timeseries", len(bindings))

            selected_day_set = set(selected_days)
            warmup_days = {shift_iso_day(day, -1) for day in selected_days}

            if source_mode == "db-dump":
                if latest_dump is None:
                    latest_dump = find_latest_obs_aqidb_dump(args.env, warnings)
                observations, actual_rows, dump_source_files = parse_dump_rows(
                    latest_dump["data_path"],
                    selected_day_set,
                    warmup_days,
                    bindings,
                )
                source_files.extend([
                    {
                        "source_file_path": str(latest_dump["schema_path"]),
                        "source_file_role": "dump_schema",
                        "day_utc": None,
                        "bytes_read": latest_dump["schema_path"].stat().st_size,
                        "row_count": 0,
                    },
                    {
                        "source_file_path": str(latest_dump["data_path"]),
                        "source_file_role": "dump_data",
                        "day_utc": None,
                        "bytes_read": latest_dump["data_path"].stat().st_size,
                        "row_count": 0,
                    },
                ])
                source_files.extend(dump_source_files)
                log.info("db-dump parsed observations=%s actual_logical_rows=%s", len(observations), len(actual_rows))
            else:
                if r2_root is None:
                    raise RuntimeError("Local R2 Dropbox root not found for --source r2-dropbox")
                observations, actual_rows, r2_source_files = load_r2_rows(
                    r2_root,
                    selected_day_set,
                    warmup_days,
                    bindings,
                    warnings,
                )
                source_files.extend(r2_source_files)
                log.info("r2-dropbox loaded observations=%s actual_logical_rows=%s", len(observations), len(actual_rows))

            expected_rows = build_expected_rows(observations, selected_day_set, load_rule_set(conn))
            actual_row_count, missing_rows = compare_expected_vs_actual(expected_rows, actual_rows)
            summary_counts = build_missing_summaries(missing_rows, expected_rows, actual_row_count)

            output_dir = resolve_output_dir(env, args)
            report_base = (
                f"aqi_gap_check_{source_mode}_{(args.profile or 'manual').replace('_', '-')}_"
                f"{(computed_from_day or 'none')}_{(computed_to_day or 'none')}_{run_compact}"
            )
            report = {
                "env": args.env,
                "source_mode": source_mode,
                "profile": args.profile or "manual",
                "from_day": computed_from_day or "",
                "to_day": computed_to_day or "",
                "selected_days": selected_days,
                "selected_day_count": len(selected_days),
                "obs_aqidb_candidate_day_count": obs_aqidb_candidate_day_count,
                "r2_excluded_day_count": r2_excluded_day_count,
                "include_r2_days": bool(args.include_r2_days),
                "generated_at": fmt_iso(utc_now()),
                "db_path": env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"],
                "log_path": str(log_path),
                "expected_row_count": summary_counts["expected_row_count"],
                "actual_row_count": summary_counts["actual_row_count"],
                "missing_row_count": summary_counts["missing_row_count"],
                "missing_by_day": summary_counts["missing_by_day"],
                "missing_by_day_connector": summary_counts["missing_by_day_connector"],
                "missing_by_standard": summary_counts["missing_by_standard"],
                "missing_by_pollutant": summary_counts["missing_by_pollutant"],
                "warnings": warnings,
                "source_files_inspected": source_files,
                "rules_version_or_source": rules_state,
                "missing_rows": missing_rows,
            }
            report_json_path, report_md_path = write_reports(output_dir, report_base, report)
            report_files = [
                {"report_type": "json", "path": str(report_json_path), "bytes_written": report_json_path.stat().st_size},
                {"report_type": "markdown", "path": str(report_md_path), "bytes_written": report_md_path.stat().st_size},
            ]
            record_run_summaries(conn, run_id, report, source_files, report_files)
            conn.execute(
                """
                UPDATE aqi_gap_check_runs
                SET finished_at_utc = ?,
                    status = ?,
                    expected_row_count = ?,
                    actual_row_count = ?,
                    missing_row_count = ?,
                    warning_count = ?,
                    report_json_path = ?,
                    error_message = NULL
                WHERE id = ?
                """,
                (
                    fmt_iso(utc_now()),
                    "ok",
                    int(report["expected_row_count"]),
                    int(report["actual_row_count"]),
                    int(report["missing_row_count"]),
                    len(warnings),
                    str(report_json_path),
                    run_id,
                ),
            )
            conn.commit()
            db_copy = copy_db_to_dropbox(env, conn, log)
            report["dropbox_db_copy"] = db_copy
            report_json_path.write_text(json.dumps(report, indent=2, sort_keys=True))
            logging.info(
                "AQI gap check complete: expected=%s actual=%s missing=%s warnings=%s report=%s",
                report["expected_row_count"],
                report["actual_row_count"],
                report["missing_row_count"],
                len(warnings),
                report_json_path,
            )
            if args.limit_missing > 0 and missing_rows:
                logging.info("Missing-row preview (first %s):", min(args.limit_missing, len(missing_rows)))
                for line in preview_missing_rows(missing_rows, args.limit_missing):
                    logging.info("  %s", line)
            return 0
        except Exception as exc:  # noqa: BLE001
            error_message = f"{type(exc).__name__}: {exc}"
            logging.exception("AQI gap check failed")
            if run_id is not None:
                conn.execute(
                    """
                    UPDATE aqi_gap_check_runs
                    SET finished_at_utc = ?, status = ?, warning_count = ?, error_message = ?
                    WHERE id = ?
                    """,
                    (fmt_iso(utc_now()), "error", len(warnings), error_message, run_id),
                )
                conn.commit()
            return 1
        finally:
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
