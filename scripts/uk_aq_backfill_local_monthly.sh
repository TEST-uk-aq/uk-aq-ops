#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage (all available source adapters/connectors):
  export UK_AQ_BACKFILL_RUN_MODE="r2_history_obs_to_aqilevels"
  export UK_AQ_BACKFILL_DRY_RUN="false"
  export UK_AQ_BACKFILL_FORCE_REPLACE="true"
  export UK_AQ_BACKFILL_FROM_DAY_UTC="2025-01-01"
  export UK_AQ_BACKFILL_TO_DAY_UTC="2025-01-31"
  ./scripts/uk_aq_backfill_local_monthly.sh

Source adapter export to R2:
  export UK_AQ_BACKFILL_RUN_MODE="source_to_r2"
  export UK_AQ_BACKFILL_DRY_RUN="false"
  export UK_AQ_BACKFILL_FORCE_REPLACE="false"
  export UK_AQ_BACKFILL_FROM_DAY_UTC="2025-01-01"
  export UK_AQ_BACKFILL_TO_DAY_UTC="2025-12-31"
  ./scripts/uk_aq_backfill_local_monthly.sh

Optional env vars:
  UK_AQ_BACKFILL_TRIGGER_MODE               default: manual
  UK_AQ_BACKFILL_ENABLE_R2_FALLBACK         default: false
  UK_AQ_BACKFILL_CONNECTOR_IDS              optional CSV filter (unset for all available adapters)
  UK_AQ_BACKFILL_TIMESERIES_IDS             optional CSV timeseries filter
  UK_AQ_BACKFILL_TIMESERIES_ID              optional single timeseries filter alias
  UK_AQ_BACKFILL_MONTHLY_LOG_DIR            default: logs/backfill/monthly
  UK_AQ_BACKFILL_MONTHLY_STOP_ON_ERROR      default: true
  UK_AQ_BACKFILL_MONTH_RUN_INTERVAL_SECONDS default: 0
  UK_AQ_BACKFILL_MONTHLY_PAUSE_SECONDS      legacy alias for month run interval

Notes:
  - This script calls workers/uk_aq_backfill_cloud_run/run_job.ts once per month.
  - With UK_AQ_BACKFILL_FORCE_REPLACE=false, already-backed-up connector/day outputs are skipped.
  - r2_history_obs_to_aqilevels reads committed history/v1/observations manifests/parquet only and rewrites history/v1/aqilevels outputs.
  - Leave UK_AQ_BACKFILL_CONNECTOR_IDS unset to include all currently supported source adapters.
USAGE
}

trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

build_log_connector_segment() {
  local raw
  raw="$(trim "${1:-}")"
  if [[ -z "${raw}" ]]; then
    printf '%s' "all"
    return 0
  fi

  raw="$(printf '%s' "${raw}" | tr -d '[:space:]')"
  while [[ "${raw}" == *",,"* || "${raw}" == ,* || "${raw}" == *, ]]; do
    raw="${raw//,,/,}"
    raw="${raw#,}"
    raw="${raw%,}"
  done
  raw="${raw//,/_}"
  raw="${raw//[^A-Za-z0-9._-]/_}"
  if [[ -z "${raw}" ]]; then
    printf '%s' "all"
    return 0
  fi
  printf '%s' "${raw}"
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

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

RUN_MODE="$(require_env UK_AQ_BACKFILL_RUN_MODE)"
DRY_RUN_RAW="$(require_env UK_AQ_BACKFILL_DRY_RUN)"
FORCE_REPLACE_RAW="$(require_env UK_AQ_BACKFILL_FORCE_REPLACE)"
FROM_DAY_UTC="$(require_env UK_AQ_BACKFILL_FROM_DAY_UTC)"
TO_DAY_UTC="$(require_env UK_AQ_BACKFILL_TO_DAY_UTC)"
REQUESTED_FROM_DAY_UTC="${FROM_DAY_UTC}"
REQUESTED_TO_DAY_UTC="${TO_DAY_UTC}"

TRIGGER_MODE="$(trim "${UK_AQ_BACKFILL_TRIGGER_MODE:-manual}")"
ENABLE_R2_FALLBACK_RAW="$(trim "${UK_AQ_BACKFILL_ENABLE_R2_FALLBACK:-false}")"
LOG_DIR="$(trim "${UK_AQ_BACKFILL_MONTHLY_LOG_DIR:-logs/backfill/monthly}")"
STOP_ON_ERROR_RAW="$(trim "${UK_AQ_BACKFILL_MONTHLY_STOP_ON_ERROR:-true}")"
MONTH_RUN_INTERVAL_SECONDS_RAW="$(trim "${UK_AQ_BACKFILL_MONTH_RUN_INTERVAL_SECONDS:-${UK_AQ_BACKFILL_MONTHLY_PAUSE_SECONDS:-0}}")"

case "${RUN_MODE}" in
  local_to_aqilevels|obs_aqi_to_r2|source_to_r2|r2_history_obs_to_aqilevels) ;;
  *)
    echo "Invalid UK_AQ_BACKFILL_RUN_MODE: ${RUN_MODE}" >&2
    exit 2
    ;;
esac

case "${TRIGGER_MODE}" in
  manual|scheduler) ;;
  *)
    echo "Invalid UK_AQ_BACKFILL_TRIGGER_MODE: ${TRIGGER_MODE}" >&2
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

if ! ENABLE_R2_FALLBACK="$(parse_bool "${ENABLE_R2_FALLBACK_RAW}")"; then
  echo "Invalid UK_AQ_BACKFILL_ENABLE_R2_FALLBACK: ${ENABLE_R2_FALLBACK_RAW}" >&2
  exit 2
fi

if ! STOP_ON_ERROR="$(parse_bool "${STOP_ON_ERROR_RAW}")"; then
  echo "Invalid UK_AQ_BACKFILL_MONTHLY_STOP_ON_ERROR: ${STOP_ON_ERROR_RAW}" >&2
  exit 2
fi

if ! [[ "${MONTH_RUN_INTERVAL_SECONDS_RAW}" =~ ^[0-9]+$ ]]; then
  echo "Invalid UK_AQ_BACKFILL_MONTH_RUN_INTERVAL_SECONDS: ${MONTH_RUN_INTERVAL_SECONDS_RAW}" >&2
  exit 2
fi
MONTH_RUN_INTERVAL_SECONDS="${MONTH_RUN_INTERVAL_SECONDS_RAW}"

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

mkdir -p "${LOG_DIR}"

RUN_STARTED_AT_UTC="$(date -u '+%Y-%m-%d_%H-%M-%S')"
LOG_CONNECTOR_SEGMENT="$(build_log_connector_segment "${UK_AQ_BACKFILL_CONNECTOR_IDS:-}")"

if [[ -n "$(trim "${UK_AQ_BACKFILL_CONNECTOR_IDS:-}")" ]]; then
  echo "Info: UK_AQ_BACKFILL_CONNECTOR_IDS is set (${UK_AQ_BACKFILL_CONNECTOR_IDS})."
  echo "Info: unset it to process all available source adapters/connectors."
fi

month_ranges="$(python3 - "${FROM_DAY_UTC}" "${TO_DAY_UTC}" <<'PY'
import calendar
import datetime as dt
import sys

from_day = dt.date.fromisoformat(sys.argv[1])
to_day = dt.date.fromisoformat(sys.argv[2])
cursor = dt.date(from_day.year, from_day.month, 1)

while cursor <= to_day:
    month_last = dt.date(cursor.year, cursor.month, calendar.monthrange(cursor.year, cursor.month)[1])
    start = max(cursor, from_day)
    end = min(month_last, to_day)
    print(f"{start.isoformat()} {end.isoformat()}")
    if cursor.month == 12:
        cursor = dt.date(cursor.year + 1, 1, 1)
    else:
        cursor = dt.date(cursor.year, cursor.month + 1, 1)
PY
)"

declare -a failures=()
month_count=0

while IFS=' ' read -r month_from month_to; do
  if [[ -z "${month_from:-}" || -z "${month_to:-}" ]]; then
    continue
  fi
  month_count=$((month_count + 1))
  log_file="${LOG_DIR}/${RUN_MODE}_${RUN_STARTED_AT_UTC}_${LOG_CONNECTOR_SEGMENT}_${month_from}_to_${month_to}.log"

  echo ""
  echo "=== Month ${month_count}: ${month_from} -> ${month_to} ==="
  echo "Log: ${log_file}"
  echo "Run mode: ${RUN_MODE}"
  echo "Requested window: ${REQUESTED_FROM_DAY_UTC} -> ${REQUESTED_TO_DAY_UTC}"
  echo "Actual month window: ${month_from} -> ${month_to}"
  echo "Connector filter: ${UK_AQ_BACKFILL_CONNECTOR_IDS:-all}"
  echo "Force replace: ${FORCE_REPLACE}"

  export UK_AQ_BACKFILL_TRIGGER_MODE="${TRIGGER_MODE}"
  export UK_AQ_BACKFILL_RUN_MODE="${RUN_MODE}"
  export UK_AQ_BACKFILL_DRY_RUN="${DRY_RUN}"
  export UK_AQ_BACKFILL_FORCE_REPLACE="${FORCE_REPLACE}"
  export UK_AQ_BACKFILL_ENABLE_R2_FALLBACK="${ENABLE_R2_FALLBACK}"
  export UK_AQ_BACKFILL_FROM_DAY_UTC="${month_from}"
  export UK_AQ_BACKFILL_TO_DAY_UTC="${month_to}"

  if deno run --allow-env --allow-net --allow-read --allow-write --allow-run \
    workers/uk_aq_backfill_cloud_run/run_job.ts | tee "${log_file}"; then
    echo "Month ${month_from} -> ${month_to}: ok"
  else
    echo "Month ${month_from} -> ${month_to}: failed" >&2
    failures+=("${month_from}..${month_to}")
    if [[ "${STOP_ON_ERROR}" == "true" ]]; then
      break
    fi
  fi

  if [[ "${MONTH_RUN_INTERVAL_SECONDS}" -gt 0 ]]; then
    sleep "${MONTH_RUN_INTERVAL_SECONDS}"
  fi
done <<< "${month_ranges}"

echo ""
echo "=== Monthly Backfill Summary ==="
echo "Months attempted: ${month_count}"
echo "Failures: ${#failures[@]}"
if [[ "${#failures[@]}" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" | sed 's/^/ - /'
  exit 1
fi

if [[ "${DRY_RUN}" == "false" && ( "${RUN_MODE}" == "source_to_r2" || "${RUN_MODE}" == "r2_history_obs_to_aqilevels" ) ]]; then
  index_log_file="${LOG_DIR}/r2_history_index_${RUN_STARTED_AT_UTC}_${LOG_CONNECTOR_SEGMENT}_${REQUESTED_FROM_DAY_UTC}_to_${REQUESTED_TO_DAY_UTC}.log"
  echo ""
  echo "=== Rebuild R2 History Index ==="
  echo "Log: ${index_log_file}"
  if node scripts/backup_r2/uk_aq_build_r2_history_index.mjs | tee "${index_log_file}"; then
    echo "R2 history index rebuild: ok"
  else
    echo "R2 history index rebuild: failed" >&2
    exit 1
  fi
fi

echo "All month windows completed successfully."
