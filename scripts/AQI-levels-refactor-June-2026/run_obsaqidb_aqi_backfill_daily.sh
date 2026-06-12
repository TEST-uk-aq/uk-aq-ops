#!/usr/bin/env bash
set -euo pipefail

# Runs the UK AQ Timeseries AQI Hourly Cloud Run backfill one UTC day at a time.
#
# Required env:
#   GCP_TIMESERIES_AQI_HOURLY_SERVICE_NAME
#   GCP_REGION
#   GCP_PROJECT_ID
#
# Usage:
#   ./scripts/run_obsaqidb_aqi_backfill_daily.sh \
#     2026-06-08T00:00:00Z \
#     2026-06-12T15:00:00Z
#
# Optional:
#   DRY_RUN=true ./scripts/run_obsaqidb_aqi_backfill_daily.sh ...
#   PAUSE_SECONDS=5 ./scripts/run_obsaqidb_aqi_backfill_daily.sh ...

FROM_HOUR_UTC="${1:-}"
TO_HOUR_UTC="${2:-}"

DRY_RUN="${DRY_RUN:-false}"
PAUSE_SECONDS="${PAUSE_SECONDS:-2}"

if [[ -z "$FROM_HOUR_UTC" || -z "$TO_HOUR_UTC" ]]; then
  echo "Usage: $0 FROM_HOUR_UTC TO_HOUR_UTC"
  echo "Example: $0 2026-06-08T00:00:00Z 2026-06-12T15:00:00Z"
  exit 1
fi

: "${GCP_TIMESERIES_AQI_HOURLY_SERVICE_NAME:?GCP_TIMESERIES_AQI_HOURLY_SERVICE_NAME is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

date_utc_epoch() {
  # macOS date
  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" "+%s"
}

epoch_to_iso_utc() {
  # macOS date
  date -u -r "$1" "+%Y-%m-%dT%H:%M:%SZ"
}

floor_to_day_start_epoch() {
  local iso="$1"
  local day
  day="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" "+%Y-%m-%d")"
  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "${day}T00:00:00Z" "+%s"
}

FROM_EPOCH="$(date_utc_epoch "$FROM_HOUR_UTC")"
TO_EPOCH="$(date_utc_epoch "$TO_HOUR_UTC")"

if (( TO_EPOCH < FROM_EPOCH )); then
  echo "TO_HOUR_UTC must be >= FROM_HOUR_UTC"
  exit 1
fi

SERVICE_URL="$(
  gcloud run services describe "$GCP_TIMESERIES_AQI_HOURLY_SERVICE_NAME" \
    --region "$GCP_REGION" \
    --project "$GCP_PROJECT_ID" \
    --format='value(status.url)'
)"

if [[ -z "$SERVICE_URL" ]]; then
  echo "Could not resolve Cloud Run service URL"
  exit 1
fi

TOKEN="$(gcloud auth print-identity-token)"

echo "Service: $SERVICE_URL"
echo "From:    $FROM_HOUR_UTC"
echo "To:      $TO_HOUR_UTC"
echo "Dry run: $DRY_RUN"
echo

CURRENT_EPOCH="$FROM_EPOCH"

while (( CURRENT_EPOCH <= TO_EPOCH )); do
  CURRENT_ISO="$(epoch_to_iso_utc "$CURRENT_EPOCH")"
  DAY_START_EPOCH="$(floor_to_day_start_epoch "$CURRENT_ISO")"
  NEXT_DAY_START_EPOCH=$(( DAY_START_EPOCH + 86400 ))
  CHUNK_END_EPOCH=$(( NEXT_DAY_START_EPOCH - 3600 ))

  if (( CHUNK_END_EPOCH > TO_EPOCH )); then
    CHUNK_END_EPOCH="$TO_EPOCH"
  fi

  CHUNK_FROM="$(epoch_to_iso_utc "$CURRENT_EPOCH")"
  CHUNK_TO="$(epoch_to_iso_utc "$CHUNK_END_EPOCH")"

  PAYLOAD="$(
    jq -n \
      --arg from "$CHUNK_FROM" \
      --arg to "$CHUNK_TO" \
      '{
        trigger_mode: "manual",
        run_mode: "backfill",
        from_hour_utc: $from,
        to_hour_utc: $to
      }'
  )"

  echo "Running chunk:"
  echo "$PAYLOAD" | jq .

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "DRY_RUN=true, not calling service"
  else
    RESPONSE="$(
      curl -sS -X POST "$SERVICE_URL" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD"
    )"

    echo "$RESPONSE" | jq . || echo "$RESPONSE"

    OK="$(echo "$RESPONSE" | jq -r '.ok // empty' 2>/dev/null || true)"
    if [[ "$OK" == "false" ]]; then
      echo "Backfill chunk failed: $CHUNK_FROM to $CHUNK_TO"
      exit 1
    fi
  fi

  echo

  CURRENT_EPOCH=$(( CHUNK_END_EPOCH + 3600 ))

  if (( CURRENT_EPOCH <= TO_EPOCH )) && [[ "$DRY_RUN" != "true" ]]; then
    sleep "$PAUSE_SECONDS"
  fi
done

echo "Done."