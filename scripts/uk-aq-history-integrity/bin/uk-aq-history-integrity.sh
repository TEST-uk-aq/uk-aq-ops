#!/usr/bin/env bash
#
# uk-aq-history-integrity.sh
#
# Thin shell launcher for the UK-AQ History Integrity system (Phase 1).
# - Parses --env.
# - Loads the matching <ENV>.env file.
# - Validates environment/path guardrails (CIC-Test/LIVE crossover).
# - Creates required state directories.
# - Acquires a per-environment PID lock.
# - Calls the Python implementation with the remaining args.
#
# Intended deploy root on the MacBook Pro:
#   /Users/mikehinford/uk-aq-history-integrity/
#
# In-repo location:
#   uk-aq-ops/scripts/uk-aq-history-integrity/bin/
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  uk-aq-history-integrity.sh --env CIC-Test|LIVE [options]

Required:
  --env CIC-Test|LIVE                     Environment to run against.

Forwarded options:
  --profile daily|weekly|monthly|manual   Run profile (default: manual).
  --source openaq|sensorcommunity|sos|all
                                           Source filter (includes sos station/day source checks).
  --from-day YYYY-MM-DD                   Manual lower bound.
  --to-day YYYY-MM-DD                     Manual upper bound.
  --history-version v2                    R2 history layout version to check.
                                           Current integrity is v2 only.
  --dry-run                               Plan only; no remote calls.
  --check-only                            Detect changes; do not backfill.
  --run-backfill                          Rejected: v2 repair orchestration is not enabled here.
  --max-download-mb N                     Soft cap on downloaded MB.
  --max-runtime-minutes N                 Soft cap on runtime minutes.
  --verbose                               More detailed logging.
  -h, --help                              Show this help.

Environment:
  UK_AQ_HISTORY_INTEGRITY_ROOT
    Optional override for the deploy root. Defaults to the parent of bin/
    relative to this script. The launcher loads <ROOT>/env/<ENV>.env.

  UK_AQ_HISTORY_INTEGRITY_PYTHON
    Optional python interpreter override (default: python3).

  UK_AQ_R2_HISTORY_INTEGRITY_VERSION
    Optional default for --history-version; it must be v2.

  UK_AQ_BACKFILL_ENV_FILE
    If set in the integrity env, the Python runner loads this .env file and
    uses existing shared UK_AQ_R2_HISTORY_* vars from it for path/version config.
USAGE
}

preflight_error() {
  echo "ERROR preflight: $*" >&2
}

ensure_parent_writable() {
  local target="$1"
  local parent
  parent="$(dirname "${target}")"
  mkdir -p "${parent}" 2>/dev/null || {
    preflight_error "cannot create parent directory for ${target}: ${parent}"
    exit 3
  }
  if [[ ! -w "${parent}" ]]; then
    preflight_error "parent directory is not writable for ${target}: ${parent}"
    exit 3
  fi
}

ENV_NAME=""
REMAINING_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_NAME="${2:-}"
      shift 2
      ;;
    --env=*)
      ENV_NAME="${1#--env=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      REMAINING_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "${ENV_NAME}" ]]; then
  echo "ERROR: --env is required (CIC-Test or LIVE)" >&2
  usage >&2
  exit 2
fi

case "${ENV_NAME}" in
  CIC-Test|LIVE) ;;
  *)
    echo "ERROR: --env must be CIC-Test or LIVE (got '${ENV_NAME}')" >&2
    exit 2
    ;;
esac

for ((i = 0; i < ${#REMAINING_ARGS[@]}; i++)); do
  arg="${REMAINING_ARGS[i]}"
  case "${arg}" in
    --run-backfill)
      preflight_error "--run-backfill is temporarily disabled for current v2 integrity; use the approved v2 orchestrator when it is introduced."
      exit 2
      ;;
    --history-version)
      version="${REMAINING_ARGS[i + 1]:-}"
      if [[ "${version}" != "v2" ]]; then
        preflight_error "--history-version must be v2 for current history integrity (got '${version}')."
        exit 2
      fi
      ((i += 1))
      ;;
    --history-version=*)
      version="${arg#--history-version=}"
      if [[ "${version}" != "v2" ]]; then
        preflight_error "--history-version must be v2 for current history integrity (got '${version}')."
        exit 2
      fi
      ;;
  esac
done

ROOT="${UK_AQ_HISTORY_INTEGRITY_ROOT:-${DEFAULT_ROOT}}"
ENV_FILE="${ROOT}/env/${ENV_NAME}.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: env file not found: ${ENV_FILE}" >&2
  echo "       Copy ${ROOT}/env/${ENV_NAME}.env.example and edit before running." >&2
  exit 3
fi

# Source env file, auto-exporting its assignments.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

REQUIRED_VARS=(
  UK_AQ_ENV_NAME
  UK_AQ_HISTORY_INTEGRITY_ROOT
  UK_AQ_HISTORY_INTEGRITY_STATE_DIR
  UK_AQ_HISTORY_INTEGRITY_DB_PATH
  UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR
  UK_AQ_HISTORY_INTEGRITY_TMP_DIR
  UK_AQ_HISTORY_INTEGRITY_LOG_DIR
  UK_AQ_HISTORY_INTEGRITY_REPORT_DIR
  UK_AQ_HISTORY_INTEGRITY_LOCK_DIR
  UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT
)
for v in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    preflight_error "required env var ${v} is not set in ${ENV_FILE}"
    exit 3
  fi
done

# Guardrail 1: env file's declared env name must match --env.
if [[ "${UK_AQ_ENV_NAME}" != "${ENV_NAME}" ]]; then
  preflight_error "--env=${ENV_NAME} but UK_AQ_ENV_NAME=${UK_AQ_ENV_NAME} in ${ENV_FILE}. Refusing to run."
  exit 4
fi

# Guardrail 2: no configured path may reference the *other* environment.
if [[ "${ENV_NAME}" == "LIVE" ]]; then
  OTHER_ENV="CIC-Test"
else
  OTHER_ENV="LIVE"
fi
PATH_VARS=(
  UK_AQ_HISTORY_INTEGRITY_ROOT
  UK_AQ_HISTORY_INTEGRITY_STATE_DIR
  UK_AQ_HISTORY_INTEGRITY_DB_PATH
  UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR
  UK_AQ_HISTORY_INTEGRITY_TMP_DIR
  UK_AQ_HISTORY_INTEGRITY_LOG_DIR
  UK_AQ_HISTORY_INTEGRITY_REPORT_DIR
  UK_AQ_HISTORY_INTEGRITY_LOCK_DIR
  UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH
  UK_AQ_R2_HISTORY_DROPBOX_ROOT
  UK_AQ_DROPBOX_ROOT
  UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT
  UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER
  UK_AQ_INTEGRITY_BACKFILL_WRAPPER
  UK_AQ_BACKFILL_WRAPPER
  UK_AQ_BACKFILL_ENV_FILE
)
for v in "${PATH_VARS[@]}"; do
  val="${!v:-}"
  if [[ -n "${val}" && "${val}" == *"/${OTHER_ENV}/"* ]]; then
    preflight_error "--env=${ENV_NAME} but ${v}=${val} contains '/${OTHER_ENV}/'. Refusing to run."
    exit 4
  fi
done

# Guardrail 3: DB path must live inside the env state dir.
STATE_DIR_TRIMMED="${UK_AQ_HISTORY_INTEGRITY_STATE_DIR%/}"
if [[ "${UK_AQ_HISTORY_INTEGRITY_DB_PATH}" != "${STATE_DIR_TRIMMED}/"* ]]; then
  preflight_error "UK_AQ_HISTORY_INTEGRITY_DB_PATH=${UK_AQ_HISTORY_INTEGRITY_DB_PATH} is not inside UK_AQ_HISTORY_INTEGRITY_STATE_DIR=${UK_AQ_HISTORY_INTEGRITY_STATE_DIR}. Refusing to run."
  exit 4
fi

# Create required directories (defense in depth; python also ensures these).
mkdir -p \
  "${UK_AQ_HISTORY_INTEGRITY_STATE_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_TMP_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_LOG_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_REPORT_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_LOCK_DIR}"

for dir in \
  "${UK_AQ_HISTORY_INTEGRITY_STATE_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_TMP_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_LOG_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_REPORT_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_LOCK_DIR}"; do
  if [[ ! -d "${dir}" ]]; then
    preflight_error "required directory is missing after mkdir: ${dir}"
    exit 3
  fi
  if [[ ! -w "${dir}" ]]; then
    preflight_error "required directory is not writable: ${dir}"
    exit 3
  fi
done

if [[ "${UK_AQ_HISTORY_INTEGRITY_DB_PATH}" == *"/Dropbox/"* ]]; then
  preflight_error "UK_AQ_HISTORY_INTEGRITY_DB_PATH must be local (non-Dropbox), got ${UK_AQ_HISTORY_INTEGRITY_DB_PATH}"
  exit 4
fi

ensure_parent_writable "${UK_AQ_HISTORY_INTEGRITY_DB_PATH}"

if [[ -n "${UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH:-}" ]]; then
  ensure_parent_writable "${UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH}"
  if [[ "${UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH}" == "${UK_AQ_HISTORY_INTEGRITY_DB_PATH}" ]]; then
    preflight_error "UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH must differ from UK_AQ_HISTORY_INTEGRITY_DB_PATH"
    exit 4
  fi
fi

# Per-environment PID lock.
LOCK_FILE="${UK_AQ_HISTORY_INTEGRITY_LOCK_DIR%/}/uk-aq-history-integrity.lock"
if [[ -e "${LOCK_FILE}" ]]; then
  EXISTING_PID="$(cat "${LOCK_FILE}" 2>/dev/null || true)"
  if [[ -n "${EXISTING_PID}" ]] && kill -0 "${EXISTING_PID}" 2>/dev/null; then
    echo "ERROR: another ${ENV_NAME} run is in progress (pid ${EXISTING_PID}, lock ${LOCK_FILE})" >&2
    exit 5
  fi
  echo "ERROR: stale lock file ${LOCK_FILE} (pid ${EXISTING_PID:-unknown} not running). Manual cleanup required." >&2
  exit 5
fi
echo "$$" > "${LOCK_FILE}"
cleanup() {
  rm -f "${LOCK_FILE}"
}
trap cleanup EXIT INT TERM

PY_ENTRY="${SCRIPT_DIR}/uk-aq-history-integrity.py"
if [[ ! -f "${PY_ENTRY}" ]]; then
  echo "ERROR: python entrypoint not found: ${PY_ENTRY}" >&2
  exit 6
fi

PYTHON_BIN="${UK_AQ_HISTORY_INTEGRITY_PYTHON:-python3}"

# Note: do not exec; we want the EXIT trap to clean the lock when python returns.
set +e
"${PYTHON_BIN}" "${PY_ENTRY}" --env "${ENV_NAME}" ${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}
PY_STATUS=$?
set -e
exit "${PY_STATUS}"
