#!/usr/bin/env bash
set -euo pipefail

REMOTE="uk_aq_r2_test"
BUCKET="${CFLARE_R2_BUCKET:-}"
DAY=""
OUT_DIR=""
LABEL="snapshot"
CONNECTOR_ARGS=()

usage() {
  cat <<'USAGE'
Usage:
  query_r2_v2_day_snapshot.sh \
    --day YYYY-MM-DD \
    --connector-id 1 \
    [--label before|after] \
    [--out OUTPUT_DIR]

  query_r2_v2_day_snapshot.sh \
    --day YYYY-MM-DD \
    --connector-id all \
    [--label before|after]

Options:
  --day YYYY-MM-DD            Required UTC day.
  --connector-id ID[,ID...]   Connector ID, repeatable. Use "all" by itself
                              to include every connector discovered for the day.
  --connectors ID[,ID...]     Alias for --connector-id.
  --label TEXT                Snapshot label. Default: snapshot.
  --out DIR                   Output directory. A timestamped directory under
                              tmp/ is used by default.
  --remote NAME               rclone remote. Default: uk_aq_r2_test.
  --bucket NAME               R2 bucket. Default: $CFLARE_R2_BUCKET.
  -h, --help                  Show this help.

Purpose:
  Capture the live-R2 v2 manifests and object inventories relevant to one day,
  for one connector, several connectors, or all connectors. This is intended
  for before/after comparison around metadata/index repair runs.

Captured:
  - observation and AQI day manifests
  - observation and AQI connector manifests
  - observation and AQI pollutant manifests
  - observation and AQI per-pollutant index manifests
  - observation and AQI latest-index JSON files
  - object inventories for the selected connector/day prefixes
  - summary.csv, summary.json, and SHA-256 values for every captured JSON file

The script does not download Parquet contents and does not write to R2.
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
    --day)
      need_value "$@"
      DAY="$2"
      shift 2
      ;;
    --connector-id|--connectors)
      need_value "$@"
      CONNECTOR_ARGS+=("$2")
      shift 2
      ;;
    --label)
      need_value "$@"
      LABEL="$2"
      shift 2
      ;;
    --out)
      need_value "$@"
      OUT_DIR="$2"
      shift 2
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

if [[ -z "$DAY" ]]; then
  echo "--day is required." >&2
  usage >&2
  exit 2
fi

if [[ ${#CONNECTOR_ARGS[@]} -eq 0 ]]; then
  echo "At least one --connector-id is required." >&2
  usage >&2
  exit 2
fi

if [[ -z "$BUCKET" ]]; then
  echo "R2 bucket is not set. Use --bucket or set CFLARE_R2_BUCKET." >&2
  exit 2
fi

for cmd in rclone python3 awk sed sort grep; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 2
  fi
done

python3 - "$DAY" <<'PY'
import datetime as dt
import sys

try:
    dt.date.fromisoformat(sys.argv[1])
except ValueError as exc:
    raise SystemExit(f"--day must be YYYY-MM-DD: {sys.argv[1]!r}") from exc
PY

LABEL_SAFE="$(printf '%s' "$LABEL" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g')"
[[ -n "$LABEL_SAFE" ]] || LABEL_SAFE="snapshot"

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="tmp/r2_v2_day_snapshot_${DAY}_${LABEL_SAFE}_$(date -u +%Y%m%dT%H%M%SZ)"
fi

mkdir -p "$OUT_DIR/manifests" "$OUT_DIR/inventory" "$OUT_DIR/object_inventory"
SOURCE_TSV="$OUT_DIR/manifest_sources.tsv"
printf 'family\tlevel\tconnector_id\tpollutant_code\tremote_key\tlocal_path\tstatus\n' > "$SOURCE_TSV"

OBS_DATA_PREFIX="history/v2/observations/day_utc=${DAY}"
AQI_DATA_PREFIX="history/v2/aqilevels/hourly/data/day_utc=${DAY}"
OBS_INDEX_PREFIX="history/_index_v2/observations_timeseries/day_utc=${DAY}"
AQI_INDEX_PREFIX="history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=${DAY}"

remote_path() {
  printf '%s:%s/%s' "$REMOTE" "$BUCKET" "$1"
}

list_family() {
  local family="$1"
  local prefix="$2"
  local destination="$OUT_DIR/inventory/${family}.paths.txt"

  if ! rclone lsf -R --files-only "$(remote_path "$prefix")/" > "$destination" 2>"$OUT_DIR/inventory/${family}.stderr.txt"; then
    : > "$destination"
  fi
}

list_family "observations_data" "$OBS_DATA_PREFIX"
list_family "aqilevels_data" "$AQI_DATA_PREFIX"
list_family "observations_index" "$OBS_INDEX_PREFIX"
list_family "aqilevels_index" "$AQI_INDEX_PREFIX"

CONNECTOR_JOINED="$(IFS=,; printf '%s' "${CONNECTOR_ARGS[*]}")"
CONNECTOR_FILE="$OUT_DIR/connectors.txt"

python3 - "$CONNECTOR_JOINED" "$OUT_DIR/inventory" "$CONNECTOR_FILE" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

raw, inventory_raw, output_raw = sys.argv[1:]
inventory = Path(inventory_raw)
output = Path(output_raw)

values: list[str] = []
for chunk in raw.split(","):
    chunk = chunk.strip()
    if chunk:
        values.append(chunk)

all_requested = any(value.lower() == "all" for value in values)
if all_requested and len(values) != 1:
    raise SystemExit('Use "--connector-id all" by itself.')

if all_requested:
    found: set[int] = set()
    pattern = re.compile(r"(?:^|/)connector_id=(\d+)(?:/|$)")
    for path in inventory.glob("*.paths.txt"):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            match = pattern.search(line.strip())
            if match:
                found.add(int(match.group(1)))
    connectors = sorted(found)
    if not connectors:
        raise SystemExit("No connector IDs were discovered for the selected day.")
else:
    connectors_set: set[int] = set()
    for value in values:
        if not value.isdigit() or int(value) <= 0:
            raise SystemExit(f"Invalid connector ID: {value!r}")
        connectors_set.add(int(value))
    connectors = sorted(connectors_set)

output.write_text("".join(f"{value}\n" for value in connectors), encoding="utf-8")
PY

CONNECTORS=()
while IFS= read -r connector_id; do
  [[ -n "$connector_id" ]] && CONNECTORS+=("$connector_id")
done < "$CONNECTOR_FILE"

fetch_json() {
  local family="$1"
  local level="$2"
  local connector_id="$3"
  local pollutant_code="$4"
  local key="$5"
  local local_rel="$6"
  local destination="$OUT_DIR/manifests/$local_rel"
  local tmp_file="${destination}.tmp"

  mkdir -p "$(dirname "$destination")"
  if rclone cat "$(remote_path "$key")" > "$tmp_file" 2>"${tmp_file}.stderr"; then
    mv "$tmp_file" "$destination"
    rm -f "${tmp_file}.stderr"
    printf '%s\t%s\t%s\t%s\t%s\t%s\tfound\n' \
      "$family" "$level" "$connector_id" "$pollutant_code" "$key" "manifests/$local_rel" >> "$SOURCE_TSV"
  else
    rm -f "$tmp_file"
    mv "${tmp_file}.stderr" "${destination}.missing.txt" 2>/dev/null || true
    printf '%s\t%s\t%s\t%s\t%s\t%s\tmissing\n' \
      "$family" "$level" "$connector_id" "$pollutant_code" "$key" "manifests/$local_rel" >> "$SOURCE_TSV"
  fi
}

capture_object_inventory() {
  local family="$1"
  local prefix="$2"
  local connector_id="$3"
  local destination="$OUT_DIR/object_inventory/${family}_connector_id=${connector_id}.json"

  if ! rclone lsjson -R --files-only "$(remote_path "$prefix/connector_id=${connector_id}")/" \
      > "$destination" 2>"${destination}.stderr.txt"; then
    printf '[]\n' > "$destination"
  fi
}

# Day-level manifests are global for the day and are captured once.
fetch_json "observations_data" "day" "" "" \
  "$OBS_DATA_PREFIX/manifest.json" \
  "observations/data/day_utc=${DAY}/manifest.json"
fetch_json "aqilevels_data" "day" "" "" \
  "$AQI_DATA_PREFIX/manifest.json" \
  "aqilevels/data/day_utc=${DAY}/manifest.json"

# Latest indexes are global, but may be changed by a targeted index rebuild.
fetch_json "observations_index" "latest" "" "" \
  "history/_index_v2/observations_timeseries_latest.json" \
  "observations/index/latest.json"
fetch_json "aqilevels_index" "latest" "" "" \
  "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json" \
  "aqilevels/index/latest.json"

pollutants_for() {
  local connector_id="$1"
  shift
  local inventory_file

  for inventory_file in "$@"; do
    awk -F/ -v connector="connector_id=${connector_id}" '
      $1 == connector && $2 ~ /^pollutant_code=/ {
        sub(/^pollutant_code=/, "", $2)
        print $2
      }
    ' "$inventory_file"
  done | sort -u
}

for connector_id in "${CONNECTORS[@]}"; do
  capture_object_inventory "observations_data" "$OBS_DATA_PREFIX" "$connector_id"
  capture_object_inventory "aqilevels_data" "$AQI_DATA_PREFIX" "$connector_id"
  capture_object_inventory "observations_index" "$OBS_INDEX_PREFIX" "$connector_id"
  capture_object_inventory "aqilevels_index" "$AQI_INDEX_PREFIX" "$connector_id"

  fetch_json "observations_data" "connector" "$connector_id" "" \
    "$OBS_DATA_PREFIX/connector_id=${connector_id}/manifest.json" \
    "observations/data/day_utc=${DAY}/connector_id=${connector_id}/manifest.json"
  fetch_json "aqilevels_data" "connector" "$connector_id" "" \
    "$AQI_DATA_PREFIX/connector_id=${connector_id}/manifest.json" \
    "aqilevels/data/day_utc=${DAY}/connector_id=${connector_id}/manifest.json"

  OBS_POLLUTANTS=()
  while IFS= read -r pollutant; do
    [[ -n "$pollutant" ]] && OBS_POLLUTANTS+=("$pollutant")
  done < <(pollutants_for "$connector_id" \
    "$OUT_DIR/inventory/observations_data.paths.txt" \
    "$OUT_DIR/inventory/observations_index.paths.txt")

  for pollutant in "${OBS_POLLUTANTS[@]}"; do
    fetch_json "observations_data" "pollutant" "$connector_id" "$pollutant" \
      "$OBS_DATA_PREFIX/connector_id=${connector_id}/pollutant_code=${pollutant}/manifest.json" \
      "observations/data/day_utc=${DAY}/connector_id=${connector_id}/pollutant_code=${pollutant}/manifest.json"
    fetch_json "observations_index" "pollutant" "$connector_id" "$pollutant" \
      "$OBS_INDEX_PREFIX/connector_id=${connector_id}/pollutant_code=${pollutant}/manifest.json" \
      "observations/index/day_utc=${DAY}/connector_id=${connector_id}/pollutant_code=${pollutant}/manifest.json"
  done

  AQI_POLLUTANTS=()
  while IFS= read -r pollutant; do
    [[ -n "$pollutant" ]] && AQI_POLLUTANTS+=("$pollutant")
  done < <(pollutants_for "$connector_id" \
    "$OUT_DIR/inventory/aqilevels_data.paths.txt" \
    "$OUT_DIR/inventory/aqilevels_index.paths.txt")

  for pollutant in "${AQI_POLLUTANTS[@]}"; do
    fetch_json "aqilevels_data" "pollutant" "$connector_id" "$pollutant" \
      "$AQI_DATA_PREFIX/connector_id=${connector_id}/pollutant_code=${pollutant}/manifest.json" \
      "aqilevels/data/day_utc=${DAY}/connector_id=${connector_id}/pollutant_code=${pollutant}/manifest.json"
    fetch_json "aqilevels_index" "pollutant" "$connector_id" "$pollutant" \
      "$AQI_INDEX_PREFIX/connector_id=${connector_id}/pollutant_code=${pollutant}/manifest.json" \
      "aqilevels/index/day_utc=${DAY}/connector_id=${connector_id}/pollutant_code=${pollutant}/manifest.json"
  done
done

CONNECTOR_CSV="$(IFS=,; printf '%s' "${CONNECTORS[*]}")"

python3 - "$OUT_DIR" "$DAY" "$REMOTE" "$BUCKET" "$LABEL" "$CONNECTOR_CSV" <<'PY'
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

out_raw, day, remote, bucket, label, connector_csv = sys.argv[1:]
out = Path(out_raw)
source_tsv = out / "manifest_sources.tsv"


def scalar(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return ""


def list_values(payload: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            result: list[str] = []
            for item in value:
                if isinstance(item, dict):
                    for candidate in ("connector_id", "pollutant_code", "key", "manifest_key"):
                        if candidate in item:
                            result.append(str(item[candidate]))
                            break
                elif item is not None:
                    result.append(str(item))
            return ",".join(result)
    return ""


columns = [
    "family",
    "level",
    "day_utc",
    "connector_id",
    "pollutant_code",
    "status",
    "remote_key",
    "local_path",
    "sha256",
    "bytes",
    "manifest_kind",
    "history_version",
    "domain",
    "grain",
    "profile",
    "row_count",
    "source_row_count",
    "file_count",
    "files_array_count",
    "total_bytes",
    "indexed_file_count",
    "index_coverage",
    "timeseries_row_counts_count",
    "min_timeseries_id",
    "max_timeseries_id",
    "min_observed_at_utc",
    "max_observed_at_utc",
    "min_timestamp_hour_utc",
    "max_timestamp_hour_utc",
    "connector_ids",
    "pollutant_codes",
]

rows: list[dict[str, Any]] = []
with source_tsv.open(newline="", encoding="utf-8") as handle:
    reader = csv.DictReader(handle, delimiter="\t")
    for source in reader:
        row: dict[str, Any] = {key: "" for key in columns}
        row.update(
            {
                "family": source["family"],
                "level": source["level"],
                "day_utc": day if source["level"] != "latest" else "",
                "connector_id": source["connector_id"],
                "pollutant_code": source["pollutant_code"],
                "status": source["status"],
                "remote_key": source["remote_key"],
                "local_path": source["local_path"],
            }
        )

        local_path = out / source["local_path"]
        if source["status"] == "found" and local_path.is_file():
            raw = local_path.read_bytes()
            row["sha256"] = hashlib.sha256(raw).hexdigest()
            row["bytes"] = len(raw)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                row["status"] = "invalid_json"
                rows.append(row)
                continue

            if isinstance(payload, dict):
                for key in (
                    "manifest_kind",
                    "history_version",
                    "domain",
                    "grain",
                    "profile",
                    "row_count",
                    "source_row_count",
                    "file_count",
                    "total_bytes",
                    "indexed_file_count",
                    "index_coverage",
                    "min_timeseries_id",
                    "max_timeseries_id",
                    "min_observed_at_utc",
                    "max_observed_at_utc",
                    "min_timestamp_hour_utc",
                    "max_timestamp_hour_utc",
                ):
                    row[key] = scalar(payload.get(key))

                files = payload.get("files")
                row["files_array_count"] = len(files) if isinstance(files, list) else ""
                ts_counts = payload.get("timeseries_row_counts")
                row["timeseries_row_counts_count"] = len(ts_counts) if isinstance(ts_counts, dict) else ""
                row["connector_ids"] = list_values(payload, "connector_ids", "connectors", "connector_manifests", "child_manifests")
                row["pollutant_codes"] = list_values(payload, "pollutant_codes", "pollutants", "pollutant_manifests", "child_manifests")

        rows.append(row)

with (out / "summary.csv").open("w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)

metadata = {
    "captured_at_utc": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    "day_utc": day,
    "connectors": [int(value) for value in connector_csv.split(",") if value],
    "label": label,
    "remote": remote,
    "bucket": bucket,
    "manifest_count": len(rows),
    "found_manifest_count": sum(1 for row in rows if row["status"] == "found"),
    "missing_manifest_count": sum(1 for row in rows if row["status"] == "missing"),
    "invalid_json_count": sum(1 for row in rows if row["status"] == "invalid_json"),
    "manifests": rows,
}
(out / "summary.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")

with (out / "manifest_sha256s.txt").open("w", encoding="utf-8") as handle:
    for row in sorted(rows, key=lambda item: item["local_path"]):
        if row["sha256"]:
            handle.write(f"{row['sha256']}  {row['local_path']}\n")

readme = f"""UK-AQ live R2 v2 day snapshot

Day: {day}
Connectors: {connector_csv}
Label: {label}
Remote: {remote}
Bucket: {bucket}

This directory is read-only evidence captured from R2. No Parquet content was downloaded.

Useful comparison after taking a second snapshot:
  diff -ru BEFORE_DIR/manifests AFTER_DIR/manifests
  diff -u BEFORE_DIR/summary.csv AFTER_DIR/summary.csv
  diff -u BEFORE_DIR/manifest_sha256s.txt AFTER_DIR/manifest_sha256s.txt

Object inventory JSON files include the selected connector/day object paths, sizes,
and modification times. Compare those as an additional guard that Parquet objects were
not unexpectedly rewritten.
"""
(out / "README.txt").write_text(readme, encoding="utf-8")

print(f"Snapshot directory: {out}")
print(f"Connectors: {connector_csv}")
print(f"Captured manifests: {metadata['found_manifest_count']}")
print(f"Missing manifests: {metadata['missing_manifest_count']}")
print(f"Invalid JSON: {metadata['invalid_json_count']}")
print(f"Summary CSV: {out / 'summary.csv'}")
PY

echo
echo "Live R2 day snapshot complete. No R2 writes were made."
echo "Output: $OUT_DIR"
