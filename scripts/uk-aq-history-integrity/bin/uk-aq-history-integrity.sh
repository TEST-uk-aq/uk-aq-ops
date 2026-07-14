#!/usr/bin/env bash
# Small local deployment dispatcher. It selects a repository from one tiny,
# local selector file and never loads the selected repository .env itself.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  uk-aq-history-integrity.sh --env CIC-Test|LIVE [options]

This deployed dispatcher reads only:
  /Users/mikehinford/uk-aq-history-integrity/env/CIC-Test.env
  /Users/mikehinford/uk-aq-history-integrity/env/LIVE.env

Each selector file contains only UK_AQ_OPS_REPO_ROOT. The selected repository
runner loads that repository's root .env and receives all remaining arguments.
USAGE
}

error() {
  echo "ERROR: $*" >&2
  exit 2
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
LOCAL_ROOT="$(cd -P -- "${SCRIPT_DIR}/.." && pwd -P)"
reject_archive_path "local dispatcher root" "${LOCAL_ROOT}"
ORIGINAL_ARGS=("$@")
ENV_NAME=""

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
      shift
      ;;
  esac
done

[[ "${ENV_NAME}" == "CIC-Test" || "${ENV_NAME}" == "LIVE" ]] || error "--env must be CIC-Test or LIVE"
SELECTOR_FILE="${LOCAL_ROOT}/env/${ENV_NAME}.env"
[[ -f "${SELECTOR_FILE}" && -r "${SELECTOR_FILE}" ]] || error "selector file not found: ${SELECTOR_FILE}"

# Parse exactly one assignment without executing selector-file shell syntax.
OPS_REPO_ROOT=""
while IFS= read -r line || [[ -n "${line}" ]]; do
  line="${line#${line%%[![:space:]]*}}"
  line="${line%${line##*[![:space:]]}}"
  [[ -z "${line}" || "${line}" == \#* ]] && continue
  if [[ "${line}" =~ ^UK_AQ_OPS_REPO_ROOT[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    [[ -z "${OPS_REPO_ROOT}" ]] || error "selector contains duplicate UK_AQ_OPS_REPO_ROOT"
    value="${BASH_REMATCH[1]}"
    value="${value%%[[:space:]]#*}"
    value="${value#${value%%[![:space:]]*}}"
    value="${value%${value##*[![:space:]]}}"
    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    [[ -n "${value}" && "${value}" != *'$('* && "${value}" != *'`'* ]] || error "invalid repository selector value"
    OPS_REPO_ROOT="${value}"
  else
    error "selector may contain only UK_AQ_OPS_REPO_ROOT"
  fi
done < "${SELECTOR_FILE}"

[[ -n "${OPS_REPO_ROOT}" && "${OPS_REPO_ROOT}" = /* ]] || error "UK_AQ_OPS_REPO_ROOT must be a non-empty absolute path"
reject_archive_path "UK_AQ_OPS_REPO_ROOT" "${OPS_REPO_ROOT}"
[[ -d "${OPS_REPO_ROOT}" ]] || error "selected repository does not exist: ${OPS_REPO_ROOT}"
OPS_REPO_ROOT="$(cd -P -- "${OPS_REPO_ROOT}" && pwd -P)"
reject_archive_path "resolved UK_AQ_OPS_REPO_ROOT" "${OPS_REPO_ROOT}"
RUNNER="${OPS_REPO_ROOT}/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-runner.sh"
[[ -f "${RUNNER}" && -x "${RUNNER}" ]] || error "selected repository runner is unavailable or not executable: ${RUNNER}"

export UK_AQ_ENV_NAME="${ENV_NAME}"
export UK_AQ_OPS_REPO_ROOT="${OPS_REPO_ROOT}"
export UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT="${LOCAL_ROOT}"
exec "${RUNNER}" "${ORIGINAL_ARGS[@]}"
