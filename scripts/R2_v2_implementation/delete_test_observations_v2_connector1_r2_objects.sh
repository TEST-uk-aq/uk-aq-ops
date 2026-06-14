#!/usr/bin/env bash
set -euo pipefail

# Delete TEST R2 v2 observation objects for connector_id=1 only.
#
# Intended use:
#   After fixing v2 observation pollutant metadata mapping, delete the known-bad
#   connector 1 v2 observation partitions from R2, then rebuild connector 1.
#
# This is intentionally:
#   - TEST only
#   - R2 only
#   - v2 observations only
#   - connector_id=1 only
#
# Default is dry-run. Pass --execute to actually delete.

REMOTE="${UK_AQ_RCLONE_REMOTE:-uk_aq_r2_test}"
BUCKET="${CFLARE_R2_BUCKET:-uk-aq-history-cic-test}"
RUN_DATE="$(date -u +%F_%H%M%S)"
LOG_DIR="${LOG_DIR:-logs}"
EXECUTE="false"

OBS_PREFIX="${UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX:-history/v2/observations}"
CONNECTOR_ID="${CONNECTOR_ID:-1}"

mkdir -p "$LOG_DIR"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      EXECUTE="true"
      shift
      ;;
    --dry-run)
      EXECUTE="false"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--dry-run|--execute]" >&2
      exit 2
      ;;
  esac
done

BASE="${REMOTE}:${BUCKET}"

# Hard safety guards.
if [[ "$REMOTE" != "uk_aq_r2_test" ]]; then
  echo "REFUSING: remote must be uk_aq_r2_test, got: $REMOTE" >&2
  exit 1
fi

if [[ "$BUCKET" != "uk-aq-history-cic-test" ]]; then
  echo "REFUSING: bucket must be uk-aq-history-cic-test, got: $BUCKET" >&2
  exit 1
fi

if [[ "$OBS_PREFIX" != "history/v2/observations" ]]; then
  echo "REFUSING: observations prefix must be history/v2/observations, got: $OBS_PREFIX" >&2
  exit 1
fi

if [[ "$CONNECTOR_ID" != "1" ]]; then
  echo "REFUSING: connector id must be 1, got: $CONNECTOR_ID" >&2
  exit 1
fi

if [[ "$BASE" == *"live"* || "$BASE" == *"LIVE"* || "$BASE" == *"Dropbox"* || "$BASE" == *"dropbox"* ]]; then
  echo "REFUSING: target looks unsafe: $BASE" >&2
  exit 1
fi

command -v rclone >/dev/null 2>&1 || {
  echo "REFUSING: rclone not found on PATH" >&2
  exit 1
}

echo "Remote:       $REMOTE"
echo "Bucket:       $BUCKET"
echo "Base:         $BASE"
echo "Prefix:       $OBS_PREFIX"
echo "Connector ID: $CONNECTOR_ID"
echo "Mode:         $([[ "$EXECUTE" == "true" ]] && echo "EXECUTE" || echo "DRY RUN")"
echo

# Make sure the remote is usable before doing anything.
rclone lsd "${REMOTE}:" >/dev/null

CONNECTOR_LIST="${LOG_DIR}/observations_v2_connector_${CONNECTOR_ID}_r2_delete_candidates_TEST_${RUN_DATE}.txt"
DAY_PREFIX_LIST="${LOG_DIR}/observations_v2_connector_${CONNECTOR_ID}_day_prefixes_TEST_${RUN_DATE}.txt"

echo "Listing v2 observation objects for connector_id=${CONNECTOR_ID}..."

# List all v2 observation files and keep only paths containing /connector_id=1/.
# The output keys are relative to OBS_PREFIX.
rclone lsf "${BASE}/${OBS_PREFIX}/" --recursive --files-only \
  | grep "/connector_id=${CONNECTOR_ID}/" \
  | sort > "$CONNECTOR_LIST" || true

# Derive the day-level connector prefixes that should be purged.
# Example candidate:
#   day_utc=2026-04-10/connector_id=1/pollutant_code=pm10/part-00000.parquet
#
# Derived purge prefix:
#   history/v2/observations/day_utc=2026-04-10/connector_id=1
awk -F/ -v prefix="$OBS_PREFIX" -v connector="connector_id=${CONNECTOR_ID}" '
  {
    for (i = 1; i <= NF; i++) {
      if ($i == connector && i > 1) {
        print prefix "/" $(i-1) "/" connector
      }
    }
  }
' "$CONNECTOR_LIST" | sort -u > "$DAY_PREFIX_LIST"

OBJECT_COUNT="$(wc -l < "$CONNECTOR_LIST" | tr -d ' ')"
DAY_PREFIX_COUNT="$(wc -l < "$DAY_PREFIX_LIST" | tr -d ' ')"

echo
echo "Candidate files saved:"
echo "  $CONNECTOR_LIST"
echo "  $DAY_PREFIX_LIST"
echo
echo "Counts:"
echo "  Objects under connector_id=${CONNECTOR_ID}: $OBJECT_COUNT"
echo "  Day connector prefixes:                 $DAY_PREFIX_COUNT"
echo

if [[ "$OBJECT_COUNT" == "0" ]]; then
  echo "Nothing to delete."
  exit 0
fi

echo "First 30 candidate object paths:"
head -30 "$CONNECTOR_LIST"
echo

echo "First 30 connector day prefixes:"
head -30 "$DAY_PREFIX_LIST"
echo

if [[ "$EXECUTE" != "true" ]]; then
  echo "Dry run only. Nothing deleted."
  echo
  echo "To actually delete, run:"
  echo "  $0 --execute"
  exit 0
fi

echo "About to DELETE connector_id=${CONNECTOR_ID} v2 observations from TEST R2 only."
echo "This will purge $DAY_PREFIX_COUNT day connector prefixes under:"
echo "  ${BASE}/${OBS_PREFIX}/day_utc=*/connector_id=${CONNECTOR_ID}/"
echo
echo "Type exactly DELETE TEST OBSERVATIONS CONNECTOR 1 to continue:"
read -r CONFIRM

if [[ "$CONFIRM" != "DELETE TEST OBSERVATIONS CONNECTOR 1" ]]; then
  echo "Confirmation did not match. Nothing deleted."
  exit 1
fi

echo
echo "Deleting connector_id=${CONNECTOR_ID} day prefixes..."
while IFS= read -r rel_prefix; do
  [[ -z "$rel_prefix" ]] && continue
  echo "Purging ${BASE}/${rel_prefix}/"
  rclone purge "${BASE}/${rel_prefix}/"
done < "$DAY_PREFIX_LIST"

echo
echo "Post-delete check:"
echo "Remaining v2 observation objects for connector_id=${CONNECTOR_ID}:"
rclone lsf "${BASE}/${OBS_PREFIX}/" --recursive --files-only \
  | grep "/connector_id=${CONNECTOR_ID}/" \
  | head -50 || true

echo
echo "Done. Candidate lists were saved in:"
echo "  $CONNECTOR_LIST"
echo "  $DAY_PREFIX_LIST"