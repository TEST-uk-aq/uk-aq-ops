#!/usr/bin/env bash
set -euo pipefail

# Runs the UK AQ Timeseries AQI Hourly Cloud Run backfill one UTC hour at a time.
# Includes retry/backoff for transient Cloud Run/Postgres timeouts.
#
# Required env:
#   GCP_TIMESERIES_AQI_HOURLY_SERVICE_NAME
#   GCP_REGION
#   GCP_PROJECT_ID
#
# Usage:
#   ./scripts/AQI-levels-refactor-June-2026/run_obsaqidb_aqi_backfill_hourly_retry.sh \
#     2026-06-08T00:00:00Z \
#     2026-06-12T15:00:00Z
#
# Optional env:
#   DRY_RUN=true
#   PAUSE_SECONDS=10
#   STOP_ON_ERROR=true
#   REFRESH_TOKEN_EVERY=12
#   MAX_RETRIES=3
#   RETRY_PAUSE_SECONDS=60
#   RETRY_BACKOFF_MULTIPLIER=2
#   MAX_RETRY_PAUSE_SECONDS=300
#   LOG_DIR=tmp/obsaqidb_aqi_backfill_hourly_logs

FROM_HOUR_UTC="${1:-}"
TO_HOUR_UTC="${2:-}"

DRY_RUN="${DRY_RUN:-false}"
PAUSE_SECONDS="${PAUSE_SECONDS:-10}"
STOP_ON_ERROR="${STOP_ON_ERROR:-true}"
REFRESH_TOKEN_EVERY="${REFRESH_TOKEN_EVERY:-12}"
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_PAUSE_SECONDS="${RETRY_PAUSE_SECONDS:-60}"
RETRY_BACKOFF_MULTIPLIER="${RETRY_BACKOFF_MULTIPLIER:-2}"
MAX_RETRY_PAUSE_SECONDS="${MAX_RETRY_PAUSE_SECONDS:-300}"

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

is_whole_hour_iso() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00Z$ ]]
}

if ! is_whole_hour_iso "$FROM_HOUR_UTC"; then
  echo "FROM_HOUR_UTC must be an exact UTC hour, e.g. 2026-06-08T00:00:00Z"
  exit 1
fi

if ! is_whole_hour_iso "$TO_HOUR_UTC"; then
  echo "TO_HOUR_UTC must be an exact UTC hour, e.g. 2026-06-12T15:00:00Z"
  exit 1
fi

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

FAILED_CHUNKS=()
CHUNK_INDEX=0
CURRENT_EPOCH="$FROM_EPOCH"
TOTAL_CHUNKS=$(( ((TO_EPOCH - FROM_EPOCH) / 3600) + 1 ))

LOG_DIR="${LOG_DIR:-tmp/obsaqidb_aqi_backfill_hourly_logs}"
mkdir -p "$LOG_DIR"
RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="${LOG_DIR}/obsaqidb_aqi_backfill_hourly_retry_${RUN_STAMP}.jsonl"

cat <<INFO
Service:                 $SERVICE_URL
From:                    $FROM_HOUR_UTC
To:                      $TO_HOUR_UTC
Chunk size:              1 hour
Chunks:                  $TOTAL_CHUNKS
Pause seconds:           $PAUSE_SECONDS
Stop on error:           $STOP_ON_ERROR
Dry run:                 $DRY_RUN
Refresh token every:     $REFRESH_TOKEN_EVERY chunks
Max retries per chunk:   $MAX_RETRIES
Retry pause seconds:     $RETRY_PAUSE_SECONDS
Retry backoff multiplier:$RETRY_BACKOFF_MULTIPLIER
Max retry pause seconds: $MAX_RETRY_PAUSE_SECONDS
Log file:                $LOG_FILE
INFO

echo

json_or_null() {
  local raw="$1"
  printf '%s' "$raw" | jq -c . 2>/dev/null || printf 'null'
}

call_service_once() {
  local payload="$1"
  local response_with_status
  local http_status
  local response

  if [[ "$DRY_RUN" == "true" ]]; then
    RESPONSE='{"ok":true,"dry_run":true,"code":0}'
    HTTP_STATUS="200"
    return 0
  fi

  response_with_status="$(
    curl -sS -X POST "$SERVICE_URL" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      -w '\n%{http_code}'
  )"

  http_status="$(printf '%s\n' "$response_with_status" | tail -n 1)"
  response="$(printf '%s\n' "$response_with_status" | sed '$d')"

  RESPONSE="$response"
  HTTP_STATUS="$http_status"
}

while (( CURRENT_EPOCH <= TO_EPOCH )); do
  CHUNK_INDEX=$(( CHUNK_INDEX + 1 ))

  if (( REFRESH_TOKEN_EVERY > 0 )) && (( CHUNK_INDEX > 1 )) && (( (CHUNK_INDEX - 1) % REFRESH_TOKEN_EVERY == 0 )); then
    echo "Refreshing identity token..."
    TOKEN="$(gcloud auth print-identity-token)"
  fi

  CHUNK_FROM="$(epoch_to_iso_utc "$CURRENT_EPOCH")"
  CHUNK_TO="$CHUNK_FROM"

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

  echo "Running chunk ${CHUNK_INDEX}/${TOTAL_CHUNKS}: ${CHUNK_FROM} to ${CHUNK_TO}"
  echo "$PAYLOAD" | jq .

  ATTEMPT=1
  CHUNK_OK="false"
  WAIT_SECONDS="$RETRY_PAUSE_SECONDS"
  LAST_FAILURE=""

  while (( ATTEMPT <= MAX_RETRIES + 1 )); do
    if (( ATTEMPT > 1 )); then
      echo "Retry attempt ${ATTEMPT}/$((MAX_RETRIES + 1)) for ${CHUNK_FROM} after ${WAIT_SECONDS}s pause..."
      sleep "$WAIT_SECONDS"
      TOKEN="$(gcloud auth print-identity-token)"
    fi

    RESPONSE=""
    HTTP_STATUS=""
    call_service_once "$PAYLOAD"

    echo "$RESPONSE" | jq . || printf '%s\n' "$RESPONSE"

    OK="$(printf '%s' "$RESPONSE" | jq -r '.ok // empty' 2>/dev/null || true)"
    CODE="$(printf '%s' "$RESPONSE" | jq -r '.code // empty' 2>/dev/null || true)"

    printf '%s\n' "$(
      jq -n \
        --arg chunk_index "$CHUNK_INDEX" \
        --arg total_chunks "$TOTAL_CHUNKS" \
        --arg attempt "$ATTEMPT" \
        --arg max_attempts "$((MAX_RETRIES + 1))" \
        --arg chunk_from "$CHUNK_FROM" \
        --arg chunk_to "$CHUNK_TO" \
        --arg http_status "$HTTP_STATUS" \
        --arg ok "${OK:-}" \
        --arg code "${CODE:-}" \
        --argjson response "$(json_or_null "$RESPONSE")" \
        '{
          chunk_index: ($chunk_index | tonumber),
          total_chunks: ($total_chunks | tonumber),
          attempt: ($attempt | tonumber),
          max_attempts: ($max_attempts | tonumber),
          chunk_from: $chunk_from,
          chunk_to: $chunk_to,
          http_status: $http_status,
          ok: $ok,
          code: $code,
          response: $response
        }'
    )" >> "$LOG_FILE"

    if [[ "$HTTP_STATUS" == "200" && "$OK" == "true" && ( -z "$CODE" || "$CODE" == "0" ) ]]; then
      CHUNK_OK="true"
      echo "Chunk succeeded: ${CHUNK_FROM} on attempt ${ATTEMPT}"
      break
    fi

    LAST_FAILURE="HTTP ${HTTP_STATUS}, ok=${OK:-missing}, code=${CODE:-missing}"

    if (( ATTEMPT > MAX_RETRIES )); then
      break
    fi

    WAIT_SECONDS=$(( WAIT_SECONDS * RETRY_BACKOFF_MULTIPLIER ))
    if (( WAIT_SECONDS > MAX_RETRY_PAUSE_SECONDS )); then
      WAIT_SECONDS="$MAX_RETRY_PAUSE_SECONDS"
    fi

    ATTEMPT=$(( ATTEMPT + 1 ))
  done

  if [[ "$CHUNK_OK" != "true" ]]; then
    FAILED_CHUNKS+=("${CHUNK_FROM} to ${CHUNK_TO} ${LAST_FAILURE}")
    echo "Backfill chunk failed after $((MAX_RETRIES + 1)) attempts: ${CHUNK_FROM} to ${CHUNK_TO}"
    echo "Last failure: ${LAST_FAILURE}"
    if [[ "$STOP_ON_ERROR" == "true" ]]; then
      echo "Log file: $LOG_FILE"
      exit 1
    fi
  fi

  echo

  CURRENT_EPOCH=$(( CURRENT_EPOCH + 3600 ))

  if (( CURRENT_EPOCH <= TO_EPOCH )) && [[ "$DRY_RUN" != "true" ]]; then
    sleep "$PAUSE_SECONDS"
  fi
done

if (( ${#FAILED_CHUNKS[@]} > 0 )); then
  echo "Completed with failed chunks:"
  printf '  - %s\n' "${FAILED_CHUNKS[@]}"
  echo "Log file: $LOG_FILE"
  exit 1
fi

echo "Done."
echo "Log file: $LOG_FILE"
