#!/usr/bin/env bash
set -euo pipefail

REMOTE="uk_aq_r2_test:uk-aq-history-cic-test"
DAY_PREFIX="history/v2/observations/day_utc=2026-06-12"
CONNECTOR_PREFIX="$DAY_PREFIX/connector_id=1"
ALLOWED_REGEX='^(no2|pm10|pm25)$'

WORKDIR="tmp_r2_manifest_rebuild_2026-06-12_connector1_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$WORKDIR"

echo "Working directory: $WORKDIR"

echo
echo "1) Backing up current manifests locally..."
mkdir -p "$WORKDIR/original"

rclone copyto "$REMOTE/$DAY_PREFIX/manifest.json" \
  "$WORKDIR/original/day_manifest.original.json"

rclone copyto "$REMOTE/$CONNECTOR_PREFIX/manifest.json" \
  "$WORKDIR/original/connector_1_manifest.original.json"

rclone copy "$REMOTE/$CONNECTOR_PREFIX" \
  "$WORKDIR/original/connector_1_tree" \
  --include "**/manifest.json"

echo
echo "2) Current connector_id=1 pollutant folders:"
rclone lsf "$REMOTE/$CONNECTOR_PREFIX/" --dirs-only \
  | sed 's#pollutant_code=##; s#/$##' \
  | sort

echo
echo "3) Deleting unwanted connector_id=1 pollutant folders..."
rclone lsf "$REMOTE/$CONNECTOR_PREFIX/" --dirs-only \
  | sed 's#pollutant_code=##; s#/$##' \
  | sort \
  | grep -vE "$ALLOWED_REGEX" \
  | while read -r pollutant; do
      [ -z "$pollutant" ] && continue
      echo "Deleting pollutant_code=$pollutant"
      rclone purge "$REMOTE/$CONNECTOR_PREFIX/pollutant_code=$pollutant"
    done

echo
echo "4) Downloading remaining allowed pollutant manifests..."
mkdir -p "$WORKDIR/allowed_pollutants"
for p in no2 pm10 pm25; do
  if rclone lsf "$REMOTE/$CONNECTOR_PREFIX/pollutant_code=$p/manifest.json" >/dev/null 2>&1; then
    echo "Downloading $p manifest"
    rclone copyto "$REMOTE/$CONNECTOR_PREFIX/pollutant_code=$p/manifest.json" \
      "$WORKDIR/allowed_pollutants/$p.manifest.json"
  else
    echo "WARNING: no manifest found for $p"
  fi
done

echo
echo "5) Rebuilding connector_id=1 and day manifests..."
python3 - "$WORKDIR" <<'PY'
import copy
import hashlib
import json
import pathlib
import sys
from datetime import datetime, timezone

workdir = pathlib.Path(sys.argv[1])
allowed_dir = workdir / "allowed_pollutants"

connector_manifest_path = workdir / "original" / "connector_1_manifest.original.json"
day_manifest_path = workdir / "original" / "day_manifest.original.json"

out_connector_path = workdir / "connector_1_manifest.rebuilt.json"
out_day_path = workdir / "day_manifest.rebuilt.json"

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def write_json(path, obj):
    path.write_text(
        json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )

def canonical_hash(obj):
    clone = copy.deepcopy(obj)
    clone.pop("manifest_hash", None)
    payload = json.dumps(clone, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()

def min_non_null(values):
    vals = [v for v in values if v is not None]
    return min(vals) if vals else None

def max_non_null(values):
    vals = [v for v in values if v is not None]
    return max(vals) if vals else None

def merge_timeseries_counts(manifests):
    merged = {}
    for m in manifests:
        for k, v in (m.get("timeseries_row_counts") or {}).items():
            merged[str(k)] = merged.get(str(k), 0) + int(v)
    return dict(sorted(merged.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else kv[0]))

pollutant_manifests = []
for path in sorted(allowed_dir.glob("*.manifest.json")):
    pollutant_manifests.append(load_json(path))

if not pollutant_manifests:
    raise SystemExit("No allowed pollutant manifests found. Refusing to rebuild.")

allowed_codes = [m.get("pollutant_code") for m in pollutant_manifests]
allowed_codes = [c for c in ["no2", "pm10", "pm25"] if c in allowed_codes]

connector = load_json(connector_manifest_path)

# Keep existing structure, but replace aggregate fields from allowed pollutant manifests.
connector["manifest_kind"] = connector.get("manifest_kind", "connector")
connector["pollutant_codes"] = allowed_codes
connector["source_row_count"] = sum(int(m.get("source_row_count") or m.get("row_count") or 0) for m in pollutant_manifests)
connector["row_count"] = sum(int(m.get("row_count") or 0) for m in pollutant_manifests)
connector["file_count"] = sum(int(m.get("file_count") or 0) for m in pollutant_manifests)
connector["total_bytes"] = sum(int(m.get("total_bytes") or 0) for m in pollutant_manifests)

all_keys = []
all_files = []
for m in pollutant_manifests:
    all_keys.extend(m.get("parquet_object_keys") or [])
    all_files.extend(m.get("files") or [])

connector["parquet_object_keys"] = all_keys
if "files" in connector:
    connector["files"] = all_files

connector["child_manifests"] = [
    {
        "key": m.get("manifest_key"),
        "manifest_kind": m.get("manifest_kind", "pollutant"),
        "pollutant_code": m.get("pollutant_code"),
        "row_count": m.get("row_count"),
        "file_count": m.get("file_count"),
        "total_bytes": m.get("total_bytes"),
        "manifest_hash": m.get("manifest_hash"),
    }
    for m in pollutant_manifests
]

connector["min_timeseries_id"] = min_non_null([m.get("min_timeseries_id") for m in pollutant_manifests])
connector["max_timeseries_id"] = max_non_null([m.get("max_timeseries_id") for m in pollutant_manifests])
connector["min_observed_at_utc"] = min_non_null([m.get("min_observed_at_utc") for m in pollutant_manifests])
connector["max_observed_at_utc"] = max_non_null([m.get("max_observed_at_utc") for m in pollutant_manifests])
connector["min_timestamp_hour_utc"] = min_non_null([m.get("min_timestamp_hour_utc") for m in pollutant_manifests])
connector["max_timestamp_hour_utc"] = max_non_null([m.get("max_timestamp_hour_utc") for m in pollutant_manifests])
connector["timeseries_row_counts"] = merge_timeseries_counts(pollutant_manifests)

if connector.get("row_count"):
    connector["bytes_per_row_estimate"] = connector["total_bytes"] / connector["row_count"]
else:
    connector["bytes_per_row_estimate"] = None

file_bytes = [int(f.get("bytes") or 0) for f in all_files]
connector["avg_file_bytes"] = (sum(file_bytes) / len(file_bytes)) if file_bytes else 0
connector["min_file_bytes"] = min(file_bytes) if file_bytes else 0
connector["max_file_bytes"] = max(file_bytes) if file_bytes else 0

connector["backed_up_at_utc"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
connector["manifest_hash"] = canonical_hash(connector)

write_json(out_connector_path, connector)

day = load_json(day_manifest_path)

# Replace connector 1 child manifest summary, preserve other connectors.
new_connector_child = {
    "key": connector.get("manifest_key"),
    "manifest_kind": connector.get("manifest_kind", "connector"),
    "connector_id": connector.get("connector_id", 1),
    "row_count": connector.get("row_count"),
    "file_count": connector.get("file_count"),
    "total_bytes": connector.get("total_bytes"),
    "manifest_hash": connector.get("manifest_hash"),
    "pollutant_codes": connector.get("pollutant_codes"),
}

children = day.get("child_manifests") or []
new_children = []
replaced = False
for child in children:
    if child.get("connector_id") == 1 or "connector_id=1/manifest.json" in str(child.get("key", "")):
        new_children.append(new_connector_child)
        replaced = True
    else:
        new_children.append(child)

if not replaced:
    new_children.append(new_connector_child)

day["child_manifests"] = new_children

# Recalculate day aggregates from child summaries where possible.
day["row_count"] = sum(int(c.get("row_count") or 0) for c in new_children)
day["source_row_count"] = day["row_count"]
day["file_count"] = sum(int(c.get("file_count") or 0) for c in new_children)
day["total_bytes"] = sum(int(c.get("total_bytes") or 0) for c in new_children)

# For top-level pollutant_codes, use union from child summaries where available.
pollutants = set()
for c in new_children:
    for p in c.get("pollutant_codes") or []:
        pollutants.add(p)
day["pollutant_codes"] = sorted(pollutants)

day["backed_up_at_utc"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
day["manifest_hash"] = canonical_hash(day)

write_json(out_day_path, day)

print(f"Wrote {out_connector_path}")
print(f"Wrote {out_day_path}")
print("Connector 1 row_count:", connector.get("row_count"))
print("Connector 1 pollutant_codes:", connector.get("pollutant_codes"))
print("Day row_count:", day.get("row_count"))
print("Day pollutant_codes:", day.get("pollutant_codes"))
PY

echo
echo "6) Uploading rebuilt manifests..."
rclone copyto "$WORKDIR/connector_1_manifest.rebuilt.json" \
  "$REMOTE/$CONNECTOR_PREFIX/manifest.json"

rclone copyto "$WORKDIR/day_manifest.rebuilt.json" \
  "$REMOTE/$DAY_PREFIX/manifest.json"

echo
echo "7) Final connector_id=1 pollutant folders:"
rclone lsf "$REMOTE/$CONNECTOR_PREFIX/" --dirs-only \
  | sed 's#pollutant_code=##; s#/$##' \
  | sort

echo
echo "8) Remaining connector_id=1 objects:"
rclone lsf "$REMOTE/$CONNECTOR_PREFIX/" --recursive --files-only | sort

echo
echo "Done. Local backups are in: $WORKDIR/original"
