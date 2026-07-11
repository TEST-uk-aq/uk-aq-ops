#!/usr/bin/env bash
set -euo pipefail

REMOTE="uk_aq_r2_test"
BUCKET="${CFLARE_R2_BUCKET:-}"
FROM_DAY=""
TO_DAY=""
OUT_FILE=""
CONNECTOR_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  query_r2_v2_day_counts.sh \
    --connector-id 1 \
    [--connector-id 2] \
    [--from-day YYYY-MM-DD] \
    [--to-day YYYY-MM-DD] \
    [--out output.csv]

  query_r2_v2_day_counts.sh \
    --connector-id all \
    [--from-day YYYY-MM-DD] \
    [--to-day YYYY-MM-DD]

Options:
  --connector-id ID[,ID...]  Connector id. Repeatable. Use "all" for all
                             connector ids found in either manifest tree.
  --connectors ID[,ID...]    Alias for --connector-id.
  --from-day YYYY-MM-DD      Optional inclusive start day. Defaults to all.
  --to-day YYYY-MM-DD        Optional inclusive end day. Defaults to all.
  --out FILE                 Write CSV to FILE instead of stdout.
  --remote NAME              rclone remote. Default: uk_aq_r2_test
  --bucket NAME              R2 bucket. Default: $CFLARE_R2_BUCKET
  -h, --help                 Show this help.

Output columns:
  day_utc,connector_id,observs_row_count,aqilevel_row_count

Notes:
  - Counts come only from manifest.json files.
  - Connector-level manifests are preferred.
  - If a connector-level manifest is absent, pollutant manifest row_count
    values are summed for that day and connector.
  - A blank count means no usable manifest was found for that dataset.
EOF
}

need_value() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "Missing value for $1" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connector-id|--connectors)
      need_value "$@"
      CONNECTOR_ARGS+=("$2")
      shift 2
      ;;
    --from-day)
      need_value "$@"
      FROM_DAY="$2"
      shift 2
      ;;
    --to-day)
      need_value "$@"
      TO_DAY="$2"
      shift 2
      ;;
    --out)
      need_value "$@"
      OUT_FILE="$2"
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

if [[ ${#CONNECTOR_ARGS[@]} -eq 0 ]]; then
  echo "At least one --connector-id is required." >&2
  usage >&2
  exit 2
fi

if [[ -z "$BUCKET" ]]; then
  echo "R2 bucket is not set. Use --bucket or set CFLARE_R2_BUCKET." >&2
  exit 2
fi

for cmd in rclone python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 2
  fi
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/uk_aq_r2_day_counts.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

OBS_ROOT="${REMOTE}:${BUCKET}/history/v2/observations"
AQI_ROOT="${REMOTE}:${BUCKET}/history/v2/aqilevels/hourly/data"

echo "Listing observation manifests..." >&2
rclone lsf -R \
  --files-only \
  --include "day_utc=*/connector_id=*/manifest.json" \
  --include "day_utc=*/connector_id=*/pollutant_code=*/manifest.json" \
  "${OBS_ROOT}/" > "${TMP_DIR}/observs_paths.txt"

echo "Listing AQI-level manifests..." >&2
rclone lsf -R \
  --files-only \
  --include "day_utc=*/connector_id=*/manifest.json" \
  --include "day_utc=*/connector_id=*/pollutant_code=*/manifest.json" \
  "${AQI_ROOT}/" > "${TMP_DIR}/aqilevel_paths.txt"

CONNECTOR_JOINED="$(IFS=,; echo "${CONNECTOR_ARGS[*]}")"

python3 - \
  "$REMOTE" \
  "$BUCKET" \
  "$FROM_DAY" \
  "$TO_DAY" \
  "$OUT_FILE" \
  "$CONNECTOR_JOINED" \
  "${TMP_DIR}/observs_paths.txt" \
  "${TMP_DIR}/aqilevel_paths.txt" <<'PY'
from __future__ import annotations

import csv
import datetime as dt
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

(
    remote,
    bucket,
    from_day_raw,
    to_day_raw,
    out_file,
    connector_raw,
    obs_paths_file,
    aqi_paths_file,
) = sys.argv[1:]


def parse_day(value: str, flag: str) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise SystemExit(f"{flag} must be YYYY-MM-DD: {value!r}") from exc


from_day = parse_day(from_day_raw, "--from-day")
to_day = parse_day(to_day_raw, "--to-day")
if from_day and to_day and to_day < from_day:
    raise SystemExit("--to-day must be on or after --from-day")


def parse_connector_args(raw: str) -> tuple[bool, set[int]]:
    values: list[str] = []
    for chunk in raw.split(","):
        item = chunk.strip()
        if item:
            values.append(item)

    if any(item.lower() == "all" for item in values):
        if len(values) != 1:
            raise SystemExit('Use "--connector-id all" by itself.')
        return True, set()

    result: set[int] = set()
    for item in values:
        if not item.isdigit() or int(item) < 0:
            raise SystemExit(f"Invalid connector id: {item!r}")
        result.add(int(item))
    if not result:
        raise SystemExit("No connector ids were supplied.")
    return False, result


all_connectors, requested_connectors = parse_connector_args(connector_raw)

PATH_RE = re.compile(
    r"^day_utc=(?P<day>\d{4}-\d{2}-\d{2})/"
    r"connector_id=(?P<connector>\d+)/"
    r"(?:(?:pollutant_code=(?P<pollutant>[^/]+)/))?"
    r"manifest\.json$"
)


def load_paths(path: str, dataset: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw_line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        rel = raw_line.strip()
        if not rel:
            continue
        match = PATH_RE.match(rel)
        if not match:
            continue
        day = dt.date.fromisoformat(match.group("day"))
        if from_day and day < from_day:
            continue
        if to_day and day > to_day:
            continue
        connector = int(match.group("connector"))
        rows.append(
            {
                "dataset": dataset,
                "relative_path": rel,
                "day": day.isoformat(),
                "connector_id": connector,
                "pollutant": match.group("pollutant"),
            }
        )
    return rows


entries = load_paths(obs_paths_file, "observs") + load_paths(aqi_paths_file, "aqilevel")

found_connectors = {int(entry["connector_id"]) for entry in entries}
selected_connectors = found_connectors if all_connectors else requested_connectors

if not selected_connectors:
    raise SystemExit("No matching connector ids were found in the manifest listings.")

entries = [entry for entry in entries if int(entry["connector_id"]) in selected_connectors]


def manifest_remote(entry: dict[str, Any]) -> str:
    dataset_root = (
        "history/v2/observations"
        if entry["dataset"] == "observs"
        else "history/v2/aqilevels/hourly/data"
    )
    return f"{remote}:{bucket}/{dataset_root}/{entry['relative_path']}"


def parse_row_count(payload: Any) -> int | None:
    if not isinstance(payload, dict):
        return None

    for key in ("row_count", "rows", "total_row_count"):
        value = payload.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.isdigit():
                return int(stripped)

    return None


def fetch_manifest(entry: dict[str, Any]) -> tuple[dict[str, Any], int | None, str | None]:
    remote_path = manifest_remote(entry)
    proc = subprocess.run(
        ["rclone", "cat", remote_path],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        return entry, None, proc.stderr.strip() or f"rclone exited {proc.returncode}"
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return entry, None, f"invalid JSON: {exc}"
    return entry, parse_row_count(payload), None


results: list[tuple[dict[str, Any], int | None, str | None]] = []
max_workers = min(16, max(1, len(entries)))
with ThreadPoolExecutor(max_workers=max_workers) as pool:
    futures = [pool.submit(fetch_manifest, entry) for entry in entries]
    for future in as_completed(futures):
        results.append(future.result())

# key -> connector-level count or pollutant counts
manifest_counts: dict[tuple[str, str, int], dict[str, Any]] = {}
errors: list[str] = []

for entry, count, error in results:
    key = (entry["dataset"], entry["day"], int(entry["connector_id"]))
    bucket_counts = manifest_counts.setdefault(
        key,
        {"connector_count": None, "pollutant_counts": []},
    )

    if error:
        errors.append(f"{manifest_remote(entry)}: {error}")
        continue

    if count is None:
        errors.append(f"{manifest_remote(entry)}: no recognised row_count field")
        continue

    if entry["pollutant"] is None:
        bucket_counts["connector_count"] = count
    else:
        bucket_counts["pollutant_counts"].append(count)


def resolved_count(dataset: str, day: str, connector_id: int) -> int | None:
    values = manifest_counts.get((dataset, day, connector_id))
    if not values:
        return None
    if values["connector_count"] is not None:
        return int(values["connector_count"])
    pollutant_counts = values["pollutant_counts"]
    if pollutant_counts:
        return int(sum(pollutant_counts))
    return None


days_by_connector: dict[int, set[str]] = {connector: set() for connector in selected_connectors}
for _, day, connector in manifest_counts:
    if connector in selected_connectors:
        days_by_connector.setdefault(connector, set()).add(day)

rows: list[dict[str, Any]] = []
for connector in sorted(selected_connectors):
    for day in sorted(days_by_connector.get(connector, set())):
        rows.append(
            {
                "day_utc": day,
                "connector_id": connector,
                "observs_row_count": resolved_count("observs", day, connector),
                "aqilevel_row_count": resolved_count("aqilevel", day, connector),
            }
        )

fieldnames = [
    "day_utc",
    "connector_id",
    "observs_row_count",
    "aqilevel_row_count",
]

if out_file:
    output_path = Path(out_file).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    handle = output_path.open("w", encoding="utf-8", newline="")
else:
    handle = sys.stdout

try:
    writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
finally:
    if out_file:
        handle.close()

if errors:
    print(
        f"Warning: {len(errors)} manifest(s) could not be read or had no row_count.",
        file=sys.stderr,
    )
    for message in errors[:20]:
        print(f"  {message}", file=sys.stderr)
    if len(errors) > 20:
        print(f"  ... and {len(errors) - 20} more", file=sys.stderr)

if out_file:
    print(f"Wrote {len(rows)} CSV row(s) to {Path(out_file).expanduser()}", file=sys.stderr)
PY
