#!/usr/bin/env bash
set -euo pipefail

# Delete old TEST AQI R2 history objects for the AQI levels hard rebuild.
# This is intentionally AQI-only.
#
# Default is dry-run. Pass --execute to actually delete.

REMOTE="${UK_AQ_RCLONE_REMOTE:-uk_aq_r2_test}"
BUCKET="${CFLARE_R2_BUCKET:-uk-aq-history-cic-test}"
RUN_DATE="$(date -u +%F_%H%M%S)"
LOG_DIR="${LOG_DIR:-logs}"
EXECUTE="false"

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

if [[ "$BASE" == *"live"* || "$BASE" == *"LIVE"* || "$BASE" == *"Dropbox"* || "$BASE" == *"dropbox"* ]]; then
  echo "REFUSING: target looks unsafe: $BASE" >&2
  exit 1
fi

command -v rclone >/dev/null 2>&1 || {
  echo "REFUSING: rclone not found on PATH" >&2
  exit 1
}

echo "Remote: $REMOTE"
echo "Bucket: $BUCKET"
echo "Base:   $BASE"
echo "Mode:   $([[ "$EXECUTE" == "true" ]] && echo "EXECUTE" || echo "DRY RUN")"
echo

# Make sure the remote is usable before doing anything.
rclone lsd "${REMOTE}:" >/dev/null

AQI_LIST="${LOG_DIR}/aqilevels_r2_delete_candidates_TEST_${RUN_DATE}.txt"
INDEX_LIST="${LOG_DIR}/aqilevels_index_r2_delete_candidates_TEST_${RUN_DATE}.txt"
ALL_LIST="${LOG_DIR}/aqilevels_all_r2_delete_candidates_TEST_${RUN_DATE}.txt"

echo "Listing AQI history objects..."
rclone lsf "${BASE}/history/v1/aqilevels/" --recursive > "$AQI_LIST" || true

echo "Listing AQI index objects..."
rclone lsf "${BASE}/history/_index/" --recursive --files-only | grep 'aqilevels' > "$INDEX_LIST" || true

{
  sed 's#^#history/v1/aqilevels/#' "$AQI_LIST"
  sed 's#^#history/_index/#' "$INDEX_LIST"
} > "$ALL_LIST"

AQI_COUNT="$(wc -l < "$AQI_LIST" | tr -d ' ')"
INDEX_COUNT="$(wc -l < "$INDEX_LIST" | tr -d ' ')"
ALL_COUNT="$(wc -l < "$ALL_LIST" | tr -d ' ')"

echo
echo "Candidate files saved:"
echo "  $AQI_LIST"
echo "  $INDEX_LIST"
echo "  $ALL_LIST"
echo
echo "Counts:"
echo "  AQI history objects: $AQI_COUNT"
echo "  AQI index objects:   $INDEX_COUNT"
echo "  Total objects:       $ALL_COUNT"
echo

if [[ "$ALL_COUNT" == "0" ]]; then
  echo "Nothing to delete."
  exit 0
fi

echo "First 30 candidate keys:"
head -30 "$ALL_LIST"
echo

if [[ "$EXECUTE" != "true" ]]; then
  echo "Dry run only. Nothing deleted."
  echo
  echo "To actually delete, run:"
  echo "  $0 --execute"
  exit 0
fi

echo "About to DELETE $ALL_COUNT objects from TEST R2 only."
echo "Type exactly DELETE TEST AQI to continue:"
read -r CONFIRM

if [[ "$CONFIRM" != "DELETE TEST AQI" ]]; then
  echo "Confirmation did not match. Nothing deleted."
  exit 1
fi

echo
echo "Deleting history/v1/aqilevels/..."
rclone purge "${BASE}/history/v1/aqilevels/"

echo
echo "Deleting AQI index objects one by one..."
while IFS= read -r rel_key; do
  [[ -z "$rel_key" ]] && continue
  rclone deletefile "${BASE}/history/_index/${rel_key}"
done < "$INDEX_LIST"

echo
echo "Post-delete checks:"
echo "AQI history remaining:"
rclone lsf "${BASE}/history/v1/aqilevels/" --recursive || true

echo
echo "AQI index remaining:"
rclone lsf "${BASE}/history/_index/" --recursive | grep 'aqilevels' || true

echo
echo "Done. Candidate lists were saved in:"
echo "  $ALL_LIST"