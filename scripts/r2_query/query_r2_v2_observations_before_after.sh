#!/usr/bin/env bash
set -euo pipefail

REMOTE="uk_aq_r2_test"
BUCKET="${CFLARE_R2_BUCKET:-}"
OUT_DIR="/Users/mikehinford/uk-aq-work/r2_integrity_check"
CONNECTOR_ID=""
DAY=""
MODE=""

usage() {
  cat <<'USAGE'
Usage:
  query_r2_v2_observations_before_after.sh \
    --connector-id 1 \
    --day 2026-07-12 \
    --before

  query_r2_v2_observations_before_after.sh \
    --connector-id 1 \
    --day 2026-07-12 \
    --after

Required:
  --connector-id ID     Positive connector ID.
  --day YYYY-MM-DD      UTC day to export.
  --before              Write before_<UTC timestamp>.csv.
  --after               Write after_<UTC timestamp>.csv, then compare it with
                        the most recent matching before export.

Options:
  --remote NAME         rclone remote used to resolve R2 credentials.
                        Default: uk_aq_r2_test
  --bucket NAME         R2 bucket. Default: $CFLARE_R2_BUCKET
  --out-dir DIR         Output directory. Default:
                        /Users/mikehinford/uk-aq-work/r2_integrity_check
  -h, --help            Show this help.

R2 access:
  DuckDB queries the R2 S3-compatible API directly. Parquet objects are not
  copied to a local temporary directory. The rclone remote is used only to
  resolve its access key, secret key and endpoint.

  Credentials may instead be supplied through these environment variables:
    CFLARE_R2_ACCESS_KEY_ID
    CFLARE_R2_SECRET_ACCESS_KEY
    CFLARE_R2_ENDPOINT

  AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are also accepted. If the endpoint
  is not available, CFLARE_ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID or R2_ACCOUNT_ID
  can be used to construct the standard Cloudflare R2 endpoint.

Outputs:
  before_<timestamp>.csv
  before_<timestamp>.meta.json
  after_<timestamp>.csv
  after_<timestamp>.meta.json
  diff_<after timestamp>_vs_<before timestamp>.csv
  diff_<after timestamp>_vs_<before timestamp>.json

The CSV contains every observation row found below:
  history/v2/observations/day_utc=<day>/connector_id=<connector>

Three stable R2 context columns are added at the start of each CSV:
  r2_day_utc,r2_connector_id,r2_pollutant_code

The after comparison uses the newest before metadata file in --out-dir whose
connector ID and day match the requested export. Added and removed rows are
written to the diff CSV. Duplicate rows are counted correctly.
USAGE
}

need_value() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "Missing value for $1" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connector-id)
      need_value "$@"
      CONNECTOR_ID="$2"
      shift 2
      ;;
    --day)
      need_value "$@"
      DAY="$2"
      shift 2
      ;;
    --before)
      if [[ -n "$MODE" ]]; then
        echo "Use exactly one of --before or --after." >&2
        exit 2
      fi
      MODE="before"
      shift
      ;;
    --after)
      if [[ -n "$MODE" ]]; then
        echo "Use exactly one of --before or --after." >&2
        exit 2
      fi
      MODE="after"
      shift
      ;;
    --remote)
      need_value "$@"
      REMOTE="$2"
      shift 2
      ;;
    --bucket)
      need_value "$@"
      BUCKET="$2"
      shift 2
      ;;
    --out-dir)
      need_value "$@"
      OUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$CONNECTOR_ID" || -z "$DAY" || -z "$MODE" ]]; then
  echo "--connector-id, --day, and exactly one of --before or --after are required." >&2
  usage >&2
  exit 2
fi

if [[ ! "$CONNECTOR_ID" =~ ^[1-9][0-9]*$ ]]; then
  echo "--connector-id must be a positive integer: $CONNECTOR_ID" >&2
  exit 2
fi

if [[ -z "$BUCKET" ]]; then
  echo "R2 bucket is not set. Use --bucket or set CFLARE_R2_BUCKET." >&2
  exit 2
fi

for cmd in duckdb python3 date mktemp wc tr sed basename; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 2
  fi
done

python3 - "$DAY" <<'PY'
import datetime as dt
import sys

try:
    parsed = dt.date.fromisoformat(sys.argv[1])
except ValueError as exc:
    raise SystemExit(f"--day must be YYYY-MM-DD: {sys.argv[1]!r}") from exc

if parsed.isoformat() != sys.argv[1]:
    raise SystemExit(f"--day must be canonical YYYY-MM-DD: {sys.argv[1]!r}")
PY

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CSV_FILE="$OUT_DIR/${MODE}_${STAMP}.csv"
META_FILE="$OUT_DIR/${MODE}_${STAMP}.meta.json"

# Avoid overwriting if two captures start within the same UTC second.
if [[ -e "$CSV_FILE" || -e "$META_FILE" ]]; then
  suffix=2
  while [[ -e "$OUT_DIR/${MODE}_${STAMP}_${suffix}.csv" || -e "$OUT_DIR/${MODE}_${STAMP}_${suffix}.meta.json" ]]; do
    suffix=$((suffix + 1))
  done
  STAMP="${STAMP}_${suffix}"
  CSV_FILE="$OUT_DIR/${MODE}_${STAMP}.csv"
  META_FILE="$OUT_DIR/${MODE}_${STAMP}.meta.json"
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/uk_aq_r2_observations.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
chmod 700 "$TMP_DIR"

RAW_CSV="$TMP_DIR/export_unsorted.csv"
SQL_FILE="$TMP_DIR/query.sql"
SOURCE_FILE="$TMP_DIR/source.json"
RCLONE_CONFIG_FILE="$TMP_DIR/rclone_config.json"
chmod 600 "$SQL_FILE" "$SOURCE_FILE" "$RCLONE_CONFIG_FILE" 2>/dev/null || true

R2_PREFIX="history/v2/observations/day_utc=${DAY}/connector_id=${CONNECTOR_ID}"
R2_GLOB="${R2_PREFIX}/pollutant_code=*/*.parquet"

# The rclone configuration is used only for credential discovery. No R2 object
# is listed or copied through rclone.
if command -v rclone >/dev/null 2>&1; then
  if ! rclone config dump > "$RCLONE_CONFIG_FILE" 2>/dev/null; then
    printf '{}\n' > "$RCLONE_CONFIG_FILE"
  fi
else
  printf '{}\n' > "$RCLONE_CONFIG_FILE"
fi

python3 - \
  "$RCLONE_CONFIG_FILE" \
  "$REMOTE" \
  "$BUCKET" \
  "$DAY" \
  "$CONNECTOR_ID" \
  "$R2_GLOB" \
  "$RAW_CSV" \
  "$SQL_FILE" \
  "$SOURCE_FILE" <<'PY'
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

(
    config_raw,
    remote,
    bucket,
    day,
    connector_id,
    r2_glob,
    raw_csv,
    sql_raw,
    source_raw,
) = sys.argv[1:]

try:
    config = json.loads(Path(config_raw).read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    config = {}

remote_config = config.get(remote, {})
if not isinstance(remote_config, dict):
    remote_config = {}

env_remote = re.sub(r"[^A-Za-z0-9]", "_", remote).upper()


def first(*values: object) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


access_key = first(
    os.environ.get("CFLARE_R2_ACCESS_KEY_ID"),
    os.environ.get("R2_ACCESS_KEY_ID"),
    os.environ.get("AWS_ACCESS_KEY_ID"),
    os.environ.get(f"RCLONE_CONFIG_{env_remote}_ACCESS_KEY_ID"),
    remote_config.get("access_key_id"),
)
secret_key = first(
    os.environ.get("CFLARE_R2_SECRET_ACCESS_KEY"),
    os.environ.get("R2_SECRET_ACCESS_KEY"),
    os.environ.get("AWS_SECRET_ACCESS_KEY"),
    os.environ.get(f"RCLONE_CONFIG_{env_remote}_SECRET_ACCESS_KEY"),
    remote_config.get("secret_access_key"),
)
endpoint = first(
    os.environ.get("CFLARE_R2_ENDPOINT"),
    os.environ.get("R2_ENDPOINT"),
    os.environ.get(f"RCLONE_CONFIG_{env_remote}_ENDPOINT"),
    remote_config.get("endpoint"),
)
account_id = first(
    os.environ.get("CFLARE_ACCOUNT_ID"),
    os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
    os.environ.get("R2_ACCOUNT_ID"),
)

if not endpoint and account_id:
    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"

missing: list[str] = []
if not access_key:
    missing.append("access key")
if not secret_key:
    missing.append("secret key")
if not endpoint:
    missing.append("R2 endpoint or Cloudflare account ID")
if missing:
    raise SystemExit(
        "Unable to resolve "
        + ", ".join(missing)
        + f" from environment variables or rclone remote {remote!r}."
    )

endpoint_for_parse = endpoint if "://" in endpoint else f"https://{endpoint}"
parsed = urlparse(endpoint_for_parse)
endpoint_host = parsed.netloc
if not endpoint_host:
    raise SystemExit(f"Invalid R2 endpoint: {endpoint!r}")
if parsed.path not in ("", "/"):
    raise SystemExit(f"R2 endpoint must not contain a path: {endpoint!r}")
use_ssl = parsed.scheme.lower() != "http"


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


query_url = f"s3://{bucket}/{r2_glob}"
source = {
    "access_method": "duckdb_direct_s3_api",
    "endpoint": endpoint_host,
    "use_ssl": use_ssl,
    "query_url": query_url,
    "rclone_remote_for_credentials": remote,
}
Path(source_raw).write_text(json.dumps(source, indent=2, sort_keys=True) + "\n", encoding="utf-8")

sql = f"""
INSTALL httpfs;
LOAD httpfs;

CREATE OR REPLACE SECRET uk_aq_r2_direct (
  TYPE s3,
  PROVIDER config,
  KEY_ID {sql_string(access_key)},
  SECRET {sql_string(secret_key)},
  REGION 'auto',
  ENDPOINT {sql_string(endpoint_host)},
  URL_STYLE 'path',
  USE_SSL {'true' if use_ssl else 'false'},
  SCOPE {sql_string(f's3://{bucket}')}
);

COPY (
  SELECT
    {sql_string(day)} AS r2_day_utc,
    {int(connector_id)}::BIGINT AS r2_connector_id,
    regexp_extract(filename, 'pollutant_code=([^/]+)', 1) AS r2_pollutant_code,
    * EXCLUDE (filename),
    filename AS __uk_aq_internal_source_filename
  FROM read_parquet(
    {sql_string(query_url)},
    union_by_name = true,
    filename = true,
    hive_partitioning = false
  )
) TO {sql_string(raw_csv)} (FORMAT CSV, HEADER true);
"""
Path(sql_raw).write_text(sql, encoding="utf-8")
PY

echo "Mode:             $MODE"
echo "Connector:        $CONNECTOR_ID"
echo "UTC day:          $DAY"
echo "R2 query:         s3://${BUCKET}/${R2_GLOB}"
echo "Output directory: $OUT_DIR"
echo
echo "Querying observation Parquet objects directly in R2..."

if ! TERM=dumb NO_COLOR=1 duckdb < "$SQL_FILE"; then
  echo >&2
  echo "Direct R2 query failed. DuckDB's error above will indicate whether this" >&2
  echo "was caused by credentials, the endpoint, connectivity, or no matching files." >&2
  exit 3
fi

# Remove the internal source filename column, count distinct source objects,
# canonicalise line endings and sort complete CSV records deterministically.
STATS="$(python3 - "$RAW_CSV" "$CSV_FILE" <<'PY'
from __future__ import annotations

import csv
import sys
from pathlib import Path

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
internal_column = "__uk_aq_internal_source_filename"

with source.open("r", encoding="utf-8", newline="") as handle:
    reader = csv.reader(handle)
    try:
        raw_header = next(reader)
    except StopIteration:
        raise SystemExit("DuckDB produced an empty CSV without a header.")
    raw_rows = list(reader)

if len(raw_header) != len(set(raw_header)):
    duplicates = sorted({name for name in raw_header if raw_header.count(name) > 1})
    raise SystemExit(f"Duplicate CSV column names are not supported: {duplicates}")
if internal_column not in raw_header:
    raise SystemExit(f"DuckDB output is missing internal column {internal_column!r}.")

source_index = raw_header.index(internal_column)
header = [name for index, name in enumerate(raw_header) if index != source_index]
rows: list[list[str]] = []
source_files: set[str] = set()

for raw_row in raw_rows:
    if len(raw_row) != len(raw_header):
        raise SystemExit("CSV row length does not match its header.")
    source_files.add(raw_row[source_index])
    rows.append([value for index, value in enumerate(raw_row) if index != source_index])

rows.sort(key=lambda row: tuple(row))

with destination.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.writer(handle, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)

print(f"{len(rows)}\t{len(source_files)}")
PY
)"

ROW_COUNT="${STATS%%$'\t'*}"
PARQUET_COUNT="${STATS#*$'\t'}"

python3 - \
  "$META_FILE" \
  "$MODE" \
  "$STAMP" \
  "$DAY" \
  "$CONNECTOR_ID" \
  "$REMOTE" \
  "$BUCKET" \
  "$R2_PREFIX" \
  "$CSV_FILE" \
  "$PARQUET_COUNT" \
  "$ROW_COUNT" \
  "$SOURCE_FILE" <<'PY'
from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

(
    meta_raw,
    mode,
    stamp,
    day,
    connector_id,
    remote,
    bucket,
    r2_prefix,
    csv_raw,
    parquet_count,
    row_count,
    source_raw,
) = sys.argv[1:]

csv_path = Path(csv_raw)
source = json.loads(Path(source_raw).read_text(encoding="utf-8"))
sha256 = hashlib.sha256(csv_path.read_bytes()).hexdigest()
metadata = {
    "format_version": 2,
    "mode": mode,
    "capture_id": stamp,
    "created_at_utc": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    "day_utc": day,
    "connector_id": int(connector_id),
    "rclone_remote_for_credentials": remote,
    "r2_bucket": bucket,
    "r2_prefix": r2_prefix,
    "r2_access_method": source["access_method"],
    "r2_endpoint": source["endpoint"],
    "r2_query_url": source["query_url"],
    "csv_filename": csv_path.name,
    "parquet_file_count": int(parquet_count),
    "row_count": int(row_count),
    "csv_sha256": sha256,
}
Path(meta_raw).write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo
echo "Wrote: $CSV_FILE"
echo "Rows:  $ROW_COUNT"
echo "Files: $PARQUET_COUNT Parquet object(s) queried directly"
echo "Meta:  $META_FILE"

if [[ "$MODE" == "before" ]]; then
  exit 0
fi

BEFORE_INFO="$(python3 - "$OUT_DIR" "$DAY" "$CONNECTOR_ID" "$CSV_FILE" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

out_dir = Path(sys.argv[1])
day = sys.argv[2]
connector_id = int(sys.argv[3])
after_csv = Path(sys.argv[4]).resolve()

matches: list[tuple[str, float, Path, Path]] = []
for meta_path in out_dir.glob("before_*.meta.json"):
    try:
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        continue

    if metadata.get("mode") != "before":
        continue
    if metadata.get("day_utc") != day:
        continue
    try:
        meta_connector = int(metadata.get("connector_id"))
    except (TypeError, ValueError):
        continue
    if meta_connector != connector_id:
        continue

    csv_name = metadata.get("csv_filename")
    if not isinstance(csv_name, str) or not csv_name:
        continue
    csv_path = out_dir / csv_name
    if not csv_path.is_file() or csv_path.resolve() == after_csv:
        continue

    created = str(metadata.get("created_at_utc") or "")
    matches.append((created, meta_path.stat().st_mtime, csv_path, meta_path))

if not matches:
    raise SystemExit(4)

matches.sort(key=lambda item: (item[0], item[1], item[2].name), reverse=True)
_, _, csv_path, meta_path = matches[0]
print(str(csv_path))
print(str(meta_path))
PY
)" || {
  status=$?
  if [[ "$status" == "4" ]]; then
    echo >&2
    echo "The after CSV was created, but no matching before capture was found." >&2
    echo "Run the same connector/day once with --before, then run --after." >&2
    exit 4
  fi
  exit "$status"
}

BEFORE_CSV="$(printf '%s\n' "$BEFORE_INFO" | sed -n '1p')"
BEFORE_META="$(printf '%s\n' "$BEFORE_INFO" | sed -n '2p')"
BEFORE_STAMP="$(basename "$BEFORE_CSV" .csv)"
BEFORE_STAMP="${BEFORE_STAMP#before_}"
AFTER_STAMP="$(basename "$CSV_FILE" .csv)"
AFTER_STAMP="${AFTER_STAMP#after_}"
DIFF_CSV="$OUT_DIR/diff_${AFTER_STAMP}_vs_${BEFORE_STAMP}.csv"
DIFF_JSON="$OUT_DIR/diff_${AFTER_STAMP}_vs_${BEFORE_STAMP}.json"

python3 - \
  "$BEFORE_CSV" \
  "$CSV_FILE" \
  "$DIFF_CSV" \
  "$DIFF_JSON" \
  "$BEFORE_META" \
  "$META_FILE" \
  "$DAY" \
  "$CONNECTOR_ID" <<'PY'
from __future__ import annotations

import csv
import datetime as dt
import json
import sys
from collections import Counter
from pathlib import Path

(
    before_raw,
    after_raw,
    diff_csv_raw,
    diff_json_raw,
    before_meta_raw,
    after_meta_raw,
    day,
    connector_id,
) = sys.argv[1:]

before_path = Path(before_raw)
after_path = Path(after_raw)
diff_csv_path = Path(diff_csv_raw)
diff_json_path = Path(diff_json_raw)


def load_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration:
            raise SystemExit(f"CSV has no header: {path}")
        rows = list(reader)
    if len(header) != len(set(header)):
        raise SystemExit(f"CSV has duplicate column names: {path}")
    return header, rows


before_header, before_rows_raw = load_csv(before_path)
after_header, after_rows_raw = load_csv(after_path)
union_header = before_header + [name for name in after_header if name not in before_header]


def project(header: list[str], rows: list[list[str]]) -> list[tuple[str, ...]]:
    positions = {name: index for index, name in enumerate(header)}
    projected: list[tuple[str, ...]] = []
    for row in rows:
        if len(row) != len(header):
            raise SystemExit("CSV row length does not match its header.")
        projected.append(tuple(row[positions[name]] if name in positions else "" for name in union_header))
    return projected


before_rows = project(before_header, before_rows_raw)
after_rows = project(after_header, after_rows_raw)
before_counter = Counter(before_rows)
after_counter = Counter(after_rows)
removed_counter = before_counter - after_counter
added_counter = after_counter - before_counter
unchanged_counter = before_counter & after_counter

removed_rows = sorted(removed_counter.elements())
added_rows = sorted(added_counter.elements())

with diff_csv_path.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.writer(handle, lineterminator="\n")
    writer.writerow(["change", *union_header])
    for row in removed_rows:
        writer.writerow(["removed", *row])
    for row in added_rows:
        writer.writerow(["added", *row])

summary = {
    "format_version": 1,
    "created_at_utc": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    "day_utc": day,
    "connector_id": int(connector_id),
    "before_csv": before_path.name,
    "before_meta": Path(before_meta_raw).name,
    "after_csv": after_path.name,
    "after_meta": Path(after_meta_raw).name,
    "diff_csv": diff_csv_path.name,
    "before_row_count": len(before_rows),
    "after_row_count": len(after_rows),
    "unchanged_row_count": sum(unchanged_counter.values()),
    "removed_row_count": len(removed_rows),
    "added_row_count": len(added_rows),
    "before_columns": before_header,
    "after_columns": after_header,
    "columns_added_after": [name for name in after_header if name not in before_header],
    "columns_missing_after": [name for name in before_header if name not in after_header],
    "identical": not removed_rows and not added_rows and before_header == after_header,
}
diff_json_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

print(f"Before:    {before_path}")
print(f"After:     {after_path}")
print(f"Unchanged: {summary['unchanged_row_count']}")
print(f"Removed:   {summary['removed_row_count']}")
print(f"Added:     {summary['added_row_count']}")
print(f"Identical: {'yes' if summary['identical'] else 'no'}")
print(f"Diff CSV:  {diff_csv_path}")
print(f"Summary:   {diff_json_path}")
PY
