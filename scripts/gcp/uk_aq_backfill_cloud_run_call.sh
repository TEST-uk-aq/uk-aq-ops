#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  export UK_AQ_BACKFILL_SERVICE_URL="https://<service>-<hash>-ew.a.run.app"
  export UK_AQ_BACKFILL_TRIGGER_MODE="manual"
  export UK_AQ_BACKFILL_RUN_MODE="local_to_aqilevels"
  export UK_AQ_BACKFILL_DRY_RUN="false"
  export UK_AQ_BACKFILL_FORCE_REPLACE="false"
  export UK_AQ_BACKFILL_FROM_DAY_UTC="2026-02-01"
  export UK_AQ_BACKFILL_TO_DAY_UTC="2026-02-05"
  export UK_AQ_BACKFILL_CONNECTOR_IDS="4,7"   # optional
  export UK_AQ_BACKFILL_ENABLE_R2_FALLBACK="false" # optional
  ./scripts/gcp/uk_aq_backfill_cloud_run_call.sh

Required env vars:
  UK_AQ_BACKFILL_SERVICE_URL
  UK_AQ_BACKFILL_TRIGGER_MODE   (manual|scheduler)
  UK_AQ_BACKFILL_RUN_MODE       (local_to_aqilevels|obs_aqi_to_r2|source_to_r2)
  UK_AQ_BACKFILL_DRY_RUN        (true|false)
  UK_AQ_BACKFILL_FORCE_REPLACE  (true|false)
  UK_AQ_BACKFILL_FROM_DAY_UTC   (YYYY-MM-DD)
  UK_AQ_BACKFILL_TO_DAY_UTC     (YYYY-MM-DD)

Optional env vars:
  UK_AQ_BACKFILL_CONNECTOR_IDS   (comma-separated positive integers)
  UK_AQ_BACKFILL_ENABLE_R2_FALLBACK  (true|false, default false)
  UK_AQ_BACKFILL_REQUEST_TIMEOUT_SECONDS (default 300)
  UK_AQ_BACKFILL_ID_TOKEN            (pre-generated bearer token; skips gcloud token call)

Notes:
  - The script fails fast if required parameters are missing/invalid.
  - If UK_AQ_BACKFILL_ID_TOKEN is unset, the script runs:
      gcloud auth print-identity-token --audiences "${UK_AQ_BACKFILL_SERVICE_URL}"
USAGE
}

trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

require_env() {
  local name="${1}"
  local value
  value="$(trim "${!name:-}")"
  if [[ -z "${value}" ]]; then
    echo "Missing required env var: ${name}" >&2
    exit 2
  fi
  printf '%s' "${value}"
}

parse_bool() {
  local raw
  raw="$(trim "${1:-}")"
  raw="$(printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]')"
  case "${raw}" in
    1|true|yes|y|on)
      printf 'true'
      ;;
    0|false|no|n|off)
      printf 'false'
      ;;
    *)
      return 1
      ;;
  esac
}

validate_day_utc() {
  local value="${1}"
  if ! [[ "${value}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    return 1
  fi
  if ! python3 - "${value}" <<'PY' >/dev/null 2>&1
import datetime
import sys

try:
    datetime.date.fromisoformat(sys.argv[1])
except Exception:
    raise SystemExit(1)
PY
  then
    return 1
  fi
  return 0
}

parse_connector_ids_list() {
  local raw
  raw="$(trim "${1:-}")"
  if [[ -z "${raw}" ]]; then
    printf ''
    return 0
  fi

  local parts=()
  local token
  IFS=',' read -r -a parts <<< "${raw}"

  local out=()
  for token in "${parts[@]}"; do
    token="$(trim "${token}")"
    if ! [[ "${token}" =~ ^[1-9][0-9]*$ ]]; then
      return 1
    fi
    out+=("${token}")
  done

  if [[ "${#out[@]}" -eq 0 ]]; then
    printf ''
    return 0
  fi

  local json='['
  local i
  for i in "${!out[@]}"; do
    if [[ "${i}" -gt 0 ]]; then
      json+=','
    fi
    json+="${out[${i}]}"
  done
  json+=']'
  printf '%s' "${json}"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

SERVICE_URL="$(require_env UK_AQ_BACKFILL_SERVICE_URL)"
TRIGGER_MODE="$(require_env UK_AQ_BACKFILL_TRIGGER_MODE)"
RUN_MODE="$(require_env UK_AQ_BACKFILL_RUN_MODE)"
DRY_RUN_RAW="$(require_env UK_AQ_BACKFILL_DRY_RUN)"
FORCE_REPLACE_RAW="$(require_env UK_AQ_BACKFILL_FORCE_REPLACE)"
FROM_DAY_UTC="$(require_env UK_AQ_BACKFILL_FROM_DAY_UTC)"
TO_DAY_UTC="$(require_env UK_AQ_BACKFILL_TO_DAY_UTC)"

case "${TRIGGER_MODE}" in
  manual|scheduler) ;;
  *)
    echo "Invalid UK_AQ_BACKFILL_TRIGGER_MODE: ${TRIGGER_MODE}" >&2
    exit 2
    ;;
esac

case "${RUN_MODE}" in
  local_to_aqilevels|obs_aqi_to_r2|source_to_r2) ;;
  *)
    echo "Invalid UK_AQ_BACKFILL_RUN_MODE: ${RUN_MODE}" >&2
    exit 2
    ;;
esac

if ! DRY_RUN="$(parse_bool "${DRY_RUN_RAW}")"; then
  echo "Invalid UK_AQ_BACKFILL_DRY_RUN: ${DRY_RUN_RAW}" >&2
  exit 2
fi

if ! FORCE_REPLACE="$(parse_bool "${FORCE_REPLACE_RAW}")"; then
  echo "Invalid UK_AQ_BACKFILL_FORCE_REPLACE: ${FORCE_REPLACE_RAW}" >&2
  exit 2
fi

if ! validate_day_utc "${FROM_DAY_UTC}"; then
  echo "Invalid UK_AQ_BACKFILL_FROM_DAY_UTC: ${FROM_DAY_UTC}" >&2
  exit 2
fi

if ! validate_day_utc "${TO_DAY_UTC}"; then
  echo "Invalid UK_AQ_BACKFILL_TO_DAY_UTC: ${TO_DAY_UTC}" >&2
  exit 2
fi

if [[ "${TO_DAY_UTC}" < "${FROM_DAY_UTC}" ]]; then
  echo "UK_AQ_BACKFILL_TO_DAY_UTC must be >= UK_AQ_BACKFILL_FROM_DAY_UTC" >&2
  exit 2
fi

ENABLE_R2_FALLBACK_RAW="$(trim "${UK_AQ_BACKFILL_ENABLE_R2_FALLBACK:-false}")"
if ! ENABLE_R2_FALLBACK="$(parse_bool "${ENABLE_R2_FALLBACK_RAW}")"; then
  echo "Invalid UK_AQ_BACKFILL_ENABLE_R2_FALLBACK: ${ENABLE_R2_FALLBACK_RAW}" >&2
  exit 2
fi

CONNECTOR_IDS_JSON=""
CONNECTOR_IDS_VALUE="$(trim "${UK_AQ_BACKFILL_CONNECTOR_IDS:-}")"
if [[ -n "${CONNECTOR_IDS_VALUE}" ]]; then
  if ! CONNECTOR_IDS_JSON="$(parse_connector_ids_list "${CONNECTOR_IDS_VALUE}")"; then
    echo "Invalid UK_AQ_BACKFILL_CONNECTOR_IDS: ${CONNECTOR_IDS_VALUE}" >&2
    exit 2
  fi
fi

REQUEST_TIMEOUT_SECONDS="$(trim "${UK_AQ_BACKFILL_REQUEST_TIMEOUT_SECONDS:-300}")"
if ! [[ "${REQUEST_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid UK_AQ_BACKFILL_REQUEST_TIMEOUT_SECONDS: ${REQUEST_TIMEOUT_SECONDS}" >&2
  exit 2
fi

ID_TOKEN="$(trim "${UK_AQ_BACKFILL_ID_TOKEN:-}")"
if [[ -z "${ID_TOKEN}" ]]; then
  if ID_TOKEN="$(gcloud auth print-identity-token --audiences "${SERVICE_URL}" 2>/dev/null)"; then
    :
  else
    echo "Warning: could not mint audience-bound ID token; retrying without --audiences." >&2
    if ! ID_TOKEN="$(gcloud auth print-identity-token 2>/dev/null)"; then
      echo "Failed to mint identity token with gcloud." >&2
      echo "Set UK_AQ_BACKFILL_ID_TOKEN manually, or use a service account for --audiences." >&2
      exit 2
    fi
  fi
fi

payload_parts=()
payload_parts+=("\"trigger_mode\":\"${TRIGGER_MODE}\"")
payload_parts+=("\"run_mode\":\"${RUN_MODE}\"")
payload_parts+=("\"dry_run\":${DRY_RUN}")
payload_parts+=("\"force_replace\":${FORCE_REPLACE}")
payload_parts+=("\"from_day_utc\":\"${FROM_DAY_UTC}\"")
payload_parts+=("\"to_day_utc\":\"${TO_DAY_UTC}\"")
payload_parts+=("\"enable_r2_fallback\":${ENABLE_R2_FALLBACK}")

if [[ -n "${CONNECTOR_IDS_JSON}" ]]; then
  payload_parts+=("\"connector_ids\":${CONNECTOR_IDS_JSON}")
fi

PAYLOAD='{'
for i in "${!payload_parts[@]}"; do
  if [[ "${i}" -gt 0 ]]; then
    PAYLOAD+=','
  fi
  PAYLOAD+="${payload_parts[${i}]}"
done
PAYLOAD+='}'

SERVICE_RUN_URL="${SERVICE_URL%/}/run"
TMP_BODY="$(mktemp)"
trap 'rm -f "${TMP_BODY}"' EXIT

HTTP_CODE="$(curl --silent --show-error \
  --max-time "${REQUEST_TIMEOUT_SECONDS}" \
  --output "${TMP_BODY}" \
  --write-out '%{http_code}' \
  --request POST "${SERVICE_RUN_URL}" \
  --header "authorization: Bearer ${ID_TOKEN}" \
  --header 'content-type: application/json' \
  --data "${PAYLOAD}")"

if command -v jq >/dev/null 2>&1; then
  jq . "${TMP_BODY}" || cat "${TMP_BODY}"
else
  cat "${TMP_BODY}"
fi

echo "HTTP ${HTTP_CODE}" >&2

if [[ "${HTTP_CODE}" -lt 200 || "${HTTP_CODE}" -ge 300 ]]; then
  exit 1
fi
