#!/usr/bin/env bash
# Repository-owned UK-AQ History Integrity runner.
# The local deployed dispatcher selects this repository; this runner loads only
# the repository root .env, derives runtime paths, takes the per-env lock and
# invokes the repository Python coordinator.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  uk-aq-history-integrity-runner.sh --env CIC-Test|LIVE [options]

This repository runner loads the selected repository root .env and derives
non-Dropbox state under /Users/mikehinford/uk-aq-history-integrity/state/<ENV>.
The local dispatcher is a separate deployed file at:
  /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh

All options after --env are forwarded unchanged to the Python coordinator.
USAGE
}

error() {
  echo "ERROR: $*" >&2
  exit 3
}

path_is_archive() {
  python3 - "${1:-}" <<'PY'
from pathlib import Path
import sys

raw = sys.argv[1]
try:
    candidates = (Path(raw), Path(raw).resolve(strict=False))
except (OSError, RuntimeError, ValueError):
    raise SystemExit(0)
raise SystemExit(0 if any("archive" in candidate.parts for candidate in candidates) else 1)
PY
}

reject_archive_path() {
  local label="$1"
  local value="${2:-}"
  if [[ "${value}" =~ (^|/)archive(/|$) ]] || path_is_archive "${value}"; then
    error "${label} points to an archive path"
  fi
}

SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -P -- "${SCRIPT_DIR}/../../.." && pwd -P)"
EXPECTED_REPO_ROOT="${REPO_ROOT}"
reject_archive_path "repository runner" "${REPO_ROOT}"

resolve_existing_dir() {
  local raw="${1:-}"
  [[ -n "${raw}" && "${raw}" = /* ]] || return 1
  [[ -d "${raw}" ]] || return 1
  (cd -P -- "${raw}" && pwd -P)
}

EXPORTED_REPO_ROOT="${UK_AQ_OPS_REPO_ROOT:-}"
if [[ -n "${EXPORTED_REPO_ROOT}" ]]; then
  reject_archive_path "UK_AQ_OPS_REPO_ROOT" "${EXPORTED_REPO_ROOT}"
  EXPORTED_REPO_ROOT="$(resolve_existing_dir "${EXPORTED_REPO_ROOT}")" || error "UK_AQ_OPS_REPO_ROOT is not an existing absolute directory"
  reject_archive_path "resolved UK_AQ_OPS_REPO_ROOT" "${EXPORTED_REPO_ROOT}"
  [[ "${EXPORTED_REPO_ROOT}" == "${EXPECTED_REPO_ROOT}" ]] || error "UK_AQ_OPS_REPO_ROOT points to a different repository"
fi

ENV_NAME=""
REMAINING_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || error "--env requires CIC-Test or LIVE"
      [[ -z "${ENV_NAME}" ]] || error "--env supplied more than once"
      ENV_NAME="$2"
      shift 2
      ;;
    --env=*)
      [[ -z "${ENV_NAME}" ]] || error "--env supplied more than once"
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

[[ "${ENV_NAME}" == "CIC-Test" || "${ENV_NAME}" == "LIVE" ]] || error "--env must be CIC-Test or LIVE"

ROOT_ENV_FILE="${REPO_ROOT}/.env"
[[ -f "${ROOT_ENV_FILE}" && -r "${ROOT_ENV_FILE}" ]] || error "repository root .env is unavailable: ${ROOT_ENV_FILE}"

# The repository .env is the established shared environment source. Preserve
# the dispatcher-provided local root across loading, then reassert all runner
# ownership values below.
LOCAL_ROOT="${UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT:-/Users/mikehinford/uk-aq-history-integrity}"
[[ "${LOCAL_ROOT}" = /* ]] || error "UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT must be absolute"
reject_archive_path "UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT" "${LOCAL_ROOT}"

set -a
# shellcheck disable=SC1090
source "${ROOT_ENV_FILE}"
set +a

if [[ "$(printf '%s' "${UKAQ_ENV_NAME:-}" | sed 's/[[:space:]]*$//')" != "${ENV_NAME}" ]]; then
  error "UKAQ_ENV_NAME in the selected repository root .env does not match --env=${ENV_NAME}"
fi

UK_AQ_ENV_NAME="${ENV_NAME}"
UK_AQ_OPS_REPO_ROOT="${REPO_ROOT}"
UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT="${LOCAL_ROOT}"
UK_AQ_HISTORY_INTEGRITY_ROOT="${REPO_ROOT}/scripts/uk-aq-history-integrity"
UK_AQ_BACKFILL_ENV_FILE="${ROOT_ENV_FILE}"
UK_AQ_HISTORY_INTEGRITY_PYTHON="${REPO_ROOT}/.venv/bin/python"

export UK_AQ_ENV_NAME UK_AQ_OPS_REPO_ROOT UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT
export UK_AQ_HISTORY_INTEGRITY_ROOT UK_AQ_BACKFILL_ENV_FILE UK_AQ_HISTORY_INTEGRITY_PYTHON

[[ -x "${UK_AQ_HISTORY_INTEGRITY_PYTHON}" ]] || error "repository Python interpreter is unavailable: ${UK_AQ_HISTORY_INTEGRITY_PYTHON}"
PY_ENTRY="${UK_AQ_HISTORY_INTEGRITY_ROOT}/bin/uk-aq-history-integrity.py"
[[ -f "${PY_ENTRY}" && -r "${PY_ENTRY}" ]] || error "Python entrypoint is unavailable: ${PY_ENTRY}"

DROPBOX_APP_ROOT="${UK_AQ_DROPBOX_APP_ROOT:-/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks}"
reject_archive_path "UK_AQ_DROPBOX_APP_ROOT" "${DROPBOX_APP_ROOT}"
DROPBOX_ROOT_RAW="${UK_AQ_DROPBOX_ROOT:-}"
[[ -n "${DROPBOX_ROOT_RAW}" ]] || error "UK_AQ_DROPBOX_ROOT is missing from ${ROOT_ENV_FILE}"
reject_archive_path "UK_AQ_DROPBOX_ROOT" "${DROPBOX_ROOT_RAW}"
if [[ "${DROPBOX_ROOT_RAW}" = /* ]]; then
  DROPBOX_ROOT="${DROPBOX_ROOT_RAW}"
else
  DROPBOX_ROOT="${DROPBOX_APP_ROOT%/}/${DROPBOX_ROOT_RAW#/}"
fi
DROPBOX_ROOT="$(cd -P -- "${DROPBOX_ROOT}" 2>/dev/null && pwd -P)" || error "Dropbox environment root is unavailable: ${DROPBOX_ROOT}"
reject_archive_path "Dropbox environment root" "${DROPBOX_ROOT}"

STATE_DIR="${LOCAL_ROOT%/}/state/${ENV_NAME}"
export UK_AQ_HISTORY_INTEGRITY_STATE_DIR="${STATE_DIR}"
export UK_AQ_HISTORY_INTEGRITY_DB_PATH="${STATE_DIR}/uk_aq_history_integrity.sqlite"
export UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR="${STATE_DIR}/source-cache"
export UK_AQ_HISTORY_INTEGRITY_TMP_DIR="${STATE_DIR}/tmp"
export UK_AQ_HISTORY_INTEGRITY_LOCK_DIR="${STATE_DIR}/locks"
export UK_AQ_HISTORY_INTEGRITY_LOG_DIR="${DROPBOX_ROOT}/uk-aq-history-integrity/logs"
export UK_AQ_HISTORY_INTEGRITY_REPORT_DIR="${DROPBOX_ROOT}/uk-aq-history-integrity/reports"
export UK_AQ_AQI_GAP_LOG_DIR="${DROPBOX_ROOT}/uk-aq-history-integrity/aqi_gap_check/logs"
export UK_AQ_AQI_GAP_REPORT_DIR="${DROPBOX_ROOT}/uk-aq-history-integrity/aqi_gap_check/reports"
export UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH="${DROPBOX_ROOT}/uk-aq-history-integrity/uk_aq_history_integrity.sqlite"

R2_ROOT_RAW="${UK_AQ_R2_HISTORY_DROPBOX_ROOT:-}"
if [[ -n "${R2_ROOT_RAW}" ]]; then
  [[ "${R2_ROOT_RAW}" = /* ]] || error "UK_AQ_R2_HISTORY_DROPBOX_ROOT must be absolute when configured"
  R2_ROOT="${R2_ROOT_RAW}"
else
  R2_DIR="${UK_AQ_R2_HISTORY_DROPBOX_DIR:-R2_history_backup}"
  reject_archive_path "UK_AQ_R2_HISTORY_DROPBOX_DIR" "${R2_DIR}"
  if [[ "${R2_DIR}" = /* ]]; then
    R2_ROOT="${R2_DIR}"
  else
    R2_ROOT="${DROPBOX_ROOT%/}/${R2_DIR#/}"
  fi
fi
reject_archive_path "UK_AQ_R2_HISTORY_DROPBOX_ROOT" "${R2_ROOT}"
R2_ROOT="$(cd -P -- "${R2_ROOT}" 2>/dev/null && pwd -P)" || error "R2 history Dropbox root is unavailable: ${R2_ROOT}"
reject_archive_path "R2 history Dropbox root" "${R2_ROOT}"
export UK_AQ_R2_HISTORY_DROPBOX_ROOT="${R2_ROOT}"
export UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT="${R2_ROOT}/history/v2/core"
export UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER="${REPO_ROOT}/scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh"

for dir in \
  "${UK_AQ_HISTORY_INTEGRITY_STATE_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_TMP_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_LOCK_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_LOG_DIR}" \
  "${UK_AQ_HISTORY_INTEGRITY_REPORT_DIR}" \
  "${UK_AQ_AQI_GAP_LOG_DIR}" \
  "${UK_AQ_AQI_GAP_REPORT_DIR}"; do
  mkdir -p -- "${dir}"
  [[ -d "${dir}" && -w "${dir}" ]] || error "required runtime directory is unavailable or not writable: ${dir}"
done

[[ "${UK_AQ_HISTORY_INTEGRITY_DB_PATH}" != *"/Dropbox/"* ]] || error "active SQLite DB must remain outside Dropbox"
RUNNER_LOCK="${UK_AQ_HISTORY_INTEGRITY_LOCK_DIR%/}/uk-aq-history-integrity.lock"
if [[ -e "${RUNNER_LOCK}" ]]; then
  EXISTING_PID="$(cat "${RUNNER_LOCK}" 2>/dev/null || true)"
  if [[ -n "${EXISTING_PID}" ]] && kill -0 "${EXISTING_PID}" 2>/dev/null; then
    error "another ${ENV_NAME} run is in progress (pid ${EXISTING_PID})"
  fi
  error "stale lock file ${RUNNER_LOCK}; manual cleanup required"
fi
printf '%s\n' "$$" > "${RUNNER_LOCK}"
cleanup() { rm -f -- "${RUNNER_LOCK}"; }
trap cleanup EXIT INT TERM

HAS_CHECK_ONLY=false
HAS_RUN_BACKFILL=false
for ((i = 0; i < ${#REMAINING_ARGS[@]}; i++)); do
  case "${REMAINING_ARGS[i]}" in
    --check-only) HAS_CHECK_ONLY=true ;;
    --run-backfill) HAS_RUN_BACKFILL=true ;;
    --history-version)
      [[ "${REMAINING_ARGS[i + 1]:-}" == "v2" ]] || error "--history-version must be v2"
      ((i += 1))
      ;;
    --history-version=*) [[ "${REMAINING_ARGS[i]#--history-version=}" == "v2" ]] || error "--history-version must be v2" ;;
  esac
done
[[ "${HAS_CHECK_ONLY}" == true && "${HAS_RUN_BACKFILL}" == true ]] && error "--check-only and --run-backfill cannot be used together"

set +e
"${UK_AQ_HISTORY_INTEGRITY_PYTHON}" "${PY_ENTRY}" --env "${ENV_NAME}" "${REMAINING_ARGS[@]}"
PY_STATUS=$?
set -e
exit "${PY_STATUS}"
