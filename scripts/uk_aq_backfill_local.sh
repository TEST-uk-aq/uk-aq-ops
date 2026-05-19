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
  ./scripts/uk_aq_backfill_local.sh

Source adapter export to R2:
  export UK_AQ_BACKFILL_RUN_MODE="source_to_r2"
  export UK_AQ_BACKFILL_DRY_RUN="false"
  export UK_AQ_BACKFILL_FORCE_REPLACE="false"
  export UK_AQ_BACKFILL_FROM_DAY_UTC="2025-01-01"
  export UK_AQ_BACKFILL_TO_DAY_UTC="2025-12-31"
  ./scripts/uk_aq_backfill_local.sh

Optional env vars:
  UK_AQ_BACKFILL_RUN_JOB_PATH               optional path override for run_job.ts
  UK_AQ_BACKFILL_ENABLE_R2_FALLBACK         default: false
  UK_AQ_BACKFILL_CONNECTOR_IDS              optional CSV filter (unset for all available adapters)
  UK_AQ_BACKFILL_TIMESERIES_IDS             optional CSV timeseries filter
  UK_AQ_BACKFILL_TIMESERIES_ID              optional single timeseries filter alias
  UK_AQ_BACKFILL_OUTPUT_SCOPE               default|observations_only|aqilevels_only (default: default)
  UK_AQ_BACKFILL_LOCAL_LOG_DIR              default: /Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/$UK_AQ_ENV_NAME/uk-aq-backfill-local-logs
  UK_AQ_BACKFILL_LOCAL_STOP_ON_ERROR        default: true
  UK_AQ_BACKFILL_RUN_INTERVAL_SECONDS       default: 0
  UK_AQ_BACKFILL_MAX_RUNS_PER_MINUTE        default: 0 (disabled)
  UK_AQ_BACKFILL_MAX_RUNS_PER_HOUR          default: 0 (disabled)
  UK_AQ_BACKFILL_PAUSE_SECONDS              legacy alias for run interval
  UK_AQ_BACKFILL_DENO_BIN                   optional full path override for deno binary
  UK_AQ_BACKFILL_NODE_BIN                   optional full path override for node binary

Notes:
  - This script is local/manual-only and always sets UK_AQ_BACKFILL_TRIGGER_MODE=manual.
  - This script calls the active local backfill run_job.ts in day windows (internally chunked for pacing).
  - Archive paths are retired and are never valid runner paths for active runs.
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

build_default_log_dir() {
  local env_root
  env_root="$(trim "${UK_AQ_ENV_NAME:-}")"
  if [[ -z "${env_root}" ]]; then
    env_root="$(trim "${UK_AQ_DROPBOX_ROOT:-}")"
  fi
  while [[ "${env_root}" == /* ]]; do
    env_root="${env_root#/}"
  done
  while [[ "${env_root}" == */ ]]; do
    env_root="${env_root%/}"
  done

  if [[ -z "${env_root}" ]]; then
    env_root="local"
  fi
  printf '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/%s/uk-aq-backfill-local-logs' "${env_root}"
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

normalize_output_scope() {
  local raw
  raw="$(trim "${1:-default}")"
  raw="$(printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]')"
  case "${raw}" in
    default|observations_only|aqilevels_only)
      printf '%s' "${raw}"
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

resolve_run_job_path() {
  local repo_root="${1}"
  local override_raw
  override_raw="$(trim "${UK_AQ_BACKFILL_RUN_JOB_PATH:-}")"
  if [[ -n "${override_raw}" ]]; then
    local override_path="${override_raw}"
    if [[ "${override_path}" != /* ]]; then
      override_path="${repo_root}/${override_path}"
    fi
    if [[ "${override_path}" == *"/archive/"* || "${override_path}" == */archive/* ]]; then
      echo "Invalid UK_AQ_BACKFILL_RUN_JOB_PATH (archive paths are retired): ${override_raw}" >&2
      return 1
    fi
    if [[ ! -f "${override_path}" ]]; then
      echo "Invalid UK_AQ_BACKFILL_RUN_JOB_PATH (file not found): ${override_raw}" >&2
      return 1
    fi
    printf '%s' "${override_path}"
    return 0
  fi

  local active_runner="${repo_root}/workers/uk_aq_backfill_local/run_job.ts"
  if [[ ! -f "${active_runner}" ]]; then
    echo "Active backfill runner not found: ${active_runner}" >&2
    return 1
  fi
  printf '%s' "${active_runner}"
  return 0
}

resolve_deno_bin() {
  local override_raw
  override_raw="$(trim "${UK_AQ_BACKFILL_DENO_BIN:-}")"
  if [[ -n "${override_raw}" ]]; then
    if [[ ! -x "${override_raw}" ]]; then
      echo "Invalid UK_AQ_BACKFILL_DENO_BIN (not executable): ${override_raw}" >&2
      return 1
    fi
    printf '%s' "${override_raw}"
    return 0
  fi

  local candidate=""
  candidate="$(command -v deno 2>/dev/null || true)"
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    printf '%s' "${candidate}"
    return 0
  fi

  for candidate in \
    "/usr/local/bin/deno" \
    "/opt/homebrew/bin/deno" \
    "/usr/bin/deno" \
    "/bin/deno"
  do
    if [[ -x "${candidate}" ]]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done

  echo "deno executable not found. Install deno or set UK_AQ_BACKFILL_DENO_BIN to a full executable path." >&2
  return 1
}

resolve_node_bin() {
  local override_raw
  override_raw="$(trim "${UK_AQ_BACKFILL_NODE_BIN:-}")"
  if [[ -n "${override_raw}" ]]; then
    if [[ ! -x "${override_raw}" ]]; then
      echo "Invalid UK_AQ_BACKFILL_NODE_BIN (not executable): ${override_raw}" >&2
      return 1
    fi
    printf '%s' "${override_raw}"
    return 0
  fi

  local candidate=""
  candidate="$(command -v node 2>/dev/null || true)"
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    printf '%s' "${candidate}"
    return 0
  fi

  for candidate in \
    "/usr/local/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/bin/node" \
    "/bin/node"
  do
    if [[ -x "${candidate}" ]]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done

  echo "node executable not found. Install node or set UK_AQ_BACKFILL_NODE_BIN to a full executable path." >&2
  return 1
}

prune_recent_run_starts() {
  local now_epoch="${1}"
  local cutoff=$((now_epoch - 3599))
  local pruned=()
  local ts
  for ts in "${RUN_START_EPOCHS[@]:-}"; do
    if (( ts >= cutoff )); then
      pruned+=("${ts}")
    fi
  done
  if [[ "${#pruned[@]}" -gt 0 ]]; then
    RUN_START_EPOCHS=("${pruned[@]}")
  else
    RUN_START_EPOCHS=()
  fi
}

count_recent_run_starts() {
  local now_epoch="${1}"
  local window_seconds="${2}"
  local cutoff=$((now_epoch - window_seconds + 1))
  local count=0
  local ts
  for ts in "${RUN_START_EPOCHS[@]:-}"; do
    if (( ts >= cutoff )); then
      count=$((count + 1))
    fi
  done
  printf '%s' "${count}"
}

oldest_recent_run_start() {
  local now_epoch="${1}"
  local window_seconds="${2}"
  local cutoff=$((now_epoch - window_seconds + 1))
  local ts
  for ts in "${RUN_START_EPOCHS[@]:-}"; do
    if (( ts >= cutoff )); then
      printf '%s' "${ts}"
      return 0
    fi
  done
  printf ''
}

enforce_run_rate_limit() {
  local limit="${1}"
  local window_seconds="${2}"
  local label="${3}"
  if (( limit <= 0 )); then
    return 0
  fi

  while true; do
    local now_epoch
    now_epoch="$(date +%s)"
    prune_recent_run_starts "${now_epoch}"
    local current_count
    current_count="$(count_recent_run_starts "${now_epoch}" "${window_seconds}")"
    if (( current_count < limit )); then
      return 0
    fi

    local oldest_ts
    oldest_ts="$(oldest_recent_run_start "${now_epoch}" "${window_seconds}")"
    local wait_seconds=1
    if [[ -n "${oldest_ts}" ]]; then
      wait_seconds=$((window_seconds - (now_epoch - oldest_ts) + 1))
      if (( wait_seconds < 1 )); then
        wait_seconds=1
      fi
    fi
    echo "Rate limit (${label}) reached (${current_count}/${limit} in ${window_seconds}s). Sleeping ${wait_seconds}s..."
    sleep "${wait_seconds}"
  done
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
REQUESTED_TRIGGER_MODE="$(trim "${UK_AQ_BACKFILL_TRIGGER_MODE:-manual}")"

ENABLE_R2_FALLBACK_RAW="$(trim "${UK_AQ_BACKFILL_ENABLE_R2_FALLBACK:-false}")"
DEFAULT_LOG_DIR="$(build_default_log_dir)"
LOG_DIR="$(trim "${UK_AQ_BACKFILL_LOCAL_LOG_DIR:-${DEFAULT_LOG_DIR}}")"
STOP_ON_ERROR_RAW="$(trim "${UK_AQ_BACKFILL_LOCAL_STOP_ON_ERROR:-true}")"
RUN_INTERVAL_SECONDS_RAW="$(trim "${UK_AQ_BACKFILL_RUN_INTERVAL_SECONDS:-${UK_AQ_BACKFILL_PAUSE_SECONDS:-0}}")"
MAX_RUNS_PER_MINUTE_RAW="$(trim "${UK_AQ_BACKFILL_MAX_RUNS_PER_MINUTE:-0}")"
MAX_RUNS_PER_HOUR_RAW="$(trim "${UK_AQ_BACKFILL_MAX_RUNS_PER_HOUR:-0}")"
OUTPUT_SCOPE_RAW="$(trim "${UK_AQ_BACKFILL_OUTPUT_SCOPE:-default}")"

case "${RUN_MODE}" in
  local_to_aqilevels|obs_aqi_to_r2|source_to_r2|r2_history_obs_to_aqilevels) ;;
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

if ! ENABLE_R2_FALLBACK="$(parse_bool "${ENABLE_R2_FALLBACK_RAW}")"; then
  echo "Invalid UK_AQ_BACKFILL_ENABLE_R2_FALLBACK: ${ENABLE_R2_FALLBACK_RAW}" >&2
  exit 2
fi

if ! STOP_ON_ERROR="$(parse_bool "${STOP_ON_ERROR_RAW}")"; then
  echo "Invalid UK_AQ_BACKFILL_LOCAL_STOP_ON_ERROR: ${STOP_ON_ERROR_RAW}" >&2
  exit 2
fi

if ! [[ "${RUN_INTERVAL_SECONDS_RAW}" =~ ^[0-9]+$ ]]; then
  echo "Invalid UK_AQ_BACKFILL_RUN_INTERVAL_SECONDS: ${RUN_INTERVAL_SECONDS_RAW}" >&2
  exit 2
fi
RUN_INTERVAL_SECONDS="${RUN_INTERVAL_SECONDS_RAW}"

if ! [[ "${MAX_RUNS_PER_MINUTE_RAW}" =~ ^[0-9]+$ ]]; then
  echo "Invalid UK_AQ_BACKFILL_MAX_RUNS_PER_MINUTE: ${MAX_RUNS_PER_MINUTE_RAW}" >&2
  exit 2
fi
MAX_RUNS_PER_MINUTE="${MAX_RUNS_PER_MINUTE_RAW}"

if ! [[ "${MAX_RUNS_PER_HOUR_RAW}" =~ ^[0-9]+$ ]]; then
  echo "Invalid UK_AQ_BACKFILL_MAX_RUNS_PER_HOUR: ${MAX_RUNS_PER_HOUR_RAW}" >&2
  exit 2
fi
MAX_RUNS_PER_HOUR="${MAX_RUNS_PER_HOUR_RAW}"

if ! OUTPUT_SCOPE="$(normalize_output_scope "${OUTPUT_SCOPE_RAW}")"; then
  echo "Invalid UK_AQ_BACKFILL_OUTPUT_SCOPE: ${OUTPUT_SCOPE_RAW}" >&2
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"
if [[ -n "${REQUESTED_TRIGGER_MODE}" && "${REQUESTED_TRIGGER_MODE}" != "manual" ]]; then
  echo "Info: ignoring UK_AQ_BACKFILL_TRIGGER_MODE=${REQUESTED_TRIGGER_MODE}; local script always runs with trigger_mode=manual." >&2
fi
TRIGGER_MODE="manual"
RUN_JOB_PATH="$(resolve_run_job_path "${REPO_ROOT}")"
DENO_BIN="$(resolve_deno_bin)"
NODE_BIN="$(resolve_node_bin)"

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
declare -a RUN_START_EPOCHS=()
month_count=0

while IFS=' ' read -r month_from month_to; do
  if [[ -z "${month_from:-}" || -z "${month_to:-}" ]]; then
    continue
  fi
  month_count=$((month_count + 1))
  log_file="${LOG_DIR}/${RUN_MODE}_${RUN_STARTED_AT_UTC}_${LOG_CONNECTOR_SEGMENT}_${month_from}_to_${month_to}.log"

  echo ""
  echo "=== Window ${month_count}: ${month_from} -> ${month_to} ==="
  echo "Log: ${log_file}"
  echo "Run mode: ${RUN_MODE}"
  echo "Requested window: ${REQUESTED_FROM_DAY_UTC} -> ${REQUESTED_TO_DAY_UTC}"
  echo "Actual window: ${month_from} -> ${month_to}"
  echo "Connector filter: ${UK_AQ_BACKFILL_CONNECTOR_IDS:-all}"
  echo "Force replace: ${FORCE_REPLACE}"
  echo "Output scope: ${OUTPUT_SCOPE}"
  echo "Runner: ${RUN_JOB_PATH}"
  echo "Deno bin: ${DENO_BIN}"
  echo "Node bin: ${NODE_BIN}"

  export UK_AQ_BACKFILL_TRIGGER_MODE="${TRIGGER_MODE}"
  export UK_AQ_BACKFILL_RUN_MODE="${RUN_MODE}"
  export UK_AQ_BACKFILL_DRY_RUN="${DRY_RUN}"
  export UK_AQ_BACKFILL_FORCE_REPLACE="${FORCE_REPLACE}"
  export UK_AQ_BACKFILL_OUTPUT_SCOPE="${OUTPUT_SCOPE}"
  export UK_AQ_BACKFILL_ENABLE_R2_FALLBACK="${ENABLE_R2_FALLBACK}"
  export UK_AQ_BACKFILL_FROM_DAY_UTC="${month_from}"
  export UK_AQ_BACKFILL_TO_DAY_UTC="${month_to}"

  enforce_run_rate_limit "${MAX_RUNS_PER_MINUTE}" 60 "local-backfill per-minute"
  enforce_run_rate_limit "${MAX_RUNS_PER_HOUR}" 3600 "local-backfill per-hour"
  RUN_START_EPOCHS+=("$(date +%s)")

  if "${DENO_BIN}" run --allow-env --allow-net --allow-read --allow-write --allow-run \
    "${RUN_JOB_PATH}" | tee "${log_file}"; then
    echo "Window ${month_from} -> ${month_to}: ok"
  else
    echo "Window ${month_from} -> ${month_to}: failed" >&2
    failures+=("${month_from}..${month_to}")
    if [[ "${STOP_ON_ERROR}" == "true" ]]; then
      break
    fi
  fi

  if [[ "${RUN_INTERVAL_SECONDS}" -gt 0 ]]; then
    sleep "${RUN_INTERVAL_SECONDS}"
  fi
done <<< "${month_ranges}"

echo ""
echo "=== Local Backfill Summary ==="
echo "Windows attempted: ${month_count}"
echo "Failures: ${#failures[@]}"
if [[ "${#failures[@]}" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" | sed 's/^/ - /'
  exit 1
fi

if [[ "${DRY_RUN}" == "false" && ( "${RUN_MODE}" == "source_to_r2" || "${RUN_MODE}" == "obs_aqi_to_r2" || "${RUN_MODE}" == "r2_history_obs_to_aqilevels" ) ]]; then
  index_log_file="${LOG_DIR}/r2_history_index_${RUN_STARTED_AT_UTC}_${LOG_CONNECTOR_SEGMENT}_${REQUESTED_FROM_DAY_UTC}_to_${REQUESTED_TO_DAY_UTC}.log"
  index_rebuild_max_attempts=3
  index_rebuild_retry_sleep_seconds=5
  echo ""
  echo "=== Rebuild R2 History Index ==="
  echo "Log: ${index_log_file}"
  : > "${index_log_file}"
  index_rebuild_ok="false"
  for ((index_rebuild_attempt=1; index_rebuild_attempt<=index_rebuild_max_attempts; index_rebuild_attempt++)); do
    echo "R2 history index rebuild attempt ${index_rebuild_attempt}/${index_rebuild_max_attempts}" | tee -a "${index_log_file}"
    if "${NODE_BIN}" scripts/backup_r2/uk_aq_build_r2_history_index.mjs 2>&1 | tee -a "${index_log_file}"; then
      index_rebuild_ok="true"
      break
    fi
    index_rebuild_exit_code=$?
    echo "R2 history index rebuild attempt ${index_rebuild_attempt}/${index_rebuild_max_attempts} failed (exit=${index_rebuild_exit_code})." | tee -a "${index_log_file}" >&2
    if (( index_rebuild_attempt < index_rebuild_max_attempts )); then
      echo "Retrying R2 history index rebuild in ${index_rebuild_retry_sleep_seconds}s..." | tee -a "${index_log_file}"
      sleep "${index_rebuild_retry_sleep_seconds}"
    fi
  done

  if [[ "${index_rebuild_ok}" == "true" ]]; then
    echo "R2 history index rebuild: ok"
  else
    echo "R2 history index rebuild: failed" >&2
    exit 1
  fi
fi

echo "All windows completed successfully."
