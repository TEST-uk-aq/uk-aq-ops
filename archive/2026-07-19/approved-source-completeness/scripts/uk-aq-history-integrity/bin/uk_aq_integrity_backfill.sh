#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  uk_aq_integrity_backfill.sh [options]

Required:
  --env CIC-Test|LIVE
  --from-day YYYY-MM-DD
  --to-day YYYY-MM-DD

Mode flags (exactly one required):
  --observs-only          Run source_to_r2 with observations_only scope.
  --aqi-only              Run r2_history_obs_to_aqilevels with aqilevels_only scope.

Mode-specific requirements:
  --observs-only:
    --timeseries-ids CSV  Comma-separated positive integer timeseries IDs.
    --connector-id N      Optional connector filter for tighter scope.
  --aqi-only:
    --connector-id N      Optional connector filter for partial-day scope.

Optional:
  --history-version v2    Required v2 history layout (the only supported value).
  --dry-run               Set UK_AQ_BACKFILL_DRY_RUN=true (default false).
  -h, --help              Show this help.

Notes:
  - Derives the repository root from this script's own location.
  - Loads that repository's root .env; --env CIC-Test|LIVE is authoritative.
  - Reasserts UK_AQ_ENV_NAME and reads UK_AQ_BACKFILL_WRAPPER from the root .env.
  - Never reads the local CIC-Test.env or LIVE.env selector files.
  - Preserves observation-only and AQI-only modes.
  - Disables the nested full R2 history index rebuild; the Integrity coordinator
    owns targeted indexes after all manifests for the affected day are verified.
USAGE
}

trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
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
    echo "ERROR: ${label} points to an archive path." >&2
    exit 4
  fi
}

require_env() {
  local name="${1}"
  local value
  value="$(trim "${!name:-}")"
  if [[ -z "${value}" ]]; then
    echo "ERROR: required env var ${name} is not set." >&2
    exit 3
  fi
  printf '%s' "${value}"
}

load_env_file_safe() {
  local env_path="${1}"
  python3 - "${env_path}" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
name_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

def strip_inline_comment(value: str) -> str:
    in_single = False
    in_double = False
    escaped = False
    out = []
    prev = ""
    for i, ch in enumerate(value):
        if in_single:
            if ch == "'":
                in_single = False
            out.append(ch)
            prev = ch
            continue
        if in_double:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_double = False
            out.append(ch)
            prev = ch
            continue
        if ch == "'":
            in_single = True
            out.append(ch)
            prev = ch
            continue
        if ch == '"':
            in_double = True
            out.append(ch)
            prev = ch
            continue
        if ch == "#" and (i == 0 or prev.isspace()):
            break
        out.append(ch)
        prev = ch
    return "".join(out).strip()

for raw in path.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, _, val = line.partition("=")
    key = key.strip()
    if key.startswith("export "):
        key = key[len("export "):].strip()
    if not name_re.match(key):
        continue
    val = strip_inline_comment(val)
    if len(val) >= 2 and ((val[0] == '"' and val[-1] == '"') or (val[0] == "'" and val[-1] == "'")):
        val = val[1:-1]
    sys.stdout.buffer.write(key.encode("utf-8"))
    sys.stdout.buffer.write(b"\0")
    sys.stdout.buffer.write(val.encode("utf-8"))
    sys.stdout.buffer.write(b"\0")
PY
}

apply_env_file_safe() {
  local env_path="${1}"
  local key=""
  local val=""
  while IFS= read -r -d '' key && IFS= read -r -d '' val; do
    printf -v "${key}" '%s' "${val}"
    export "${key}"
  done < <(load_env_file_safe "${env_path}")
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

normalize_positive_int_csv() {
  local raw="${1:-}"
  python3 - "${raw}" <<'PY'
import sys

raw = (sys.argv[1] or "").strip()
compact = "".join(raw.split())
if not compact:
    raise SystemExit(1)

tokens = compact.split(",")
seen = set()
ordered = []
for token in tokens:
    if not token or not token.isdigit():
        raise SystemExit(1)
    if int(token, 10) <= 0:
        raise SystemExit(1)
    if token not in seen:
        seen.add(token)
        ordered.append(token)

if not ordered:
    raise SystemExit(1)

print(",".join(ordered))
PY
}

normalize_connector_id() {
  local raw="${1:-}"
  if [[ -z "${raw}" || ! "${raw}" =~ ^[0-9]+$ || "${raw}" == "0" ]]; then
    return 1
  fi
  printf '%s' "${raw}"
}

resolve_abs_path() {
  local raw="${1:-}"
  python3 - "${raw}" <<'PY'
import sys
from pathlib import Path

value = (sys.argv[1] or "").strip()
if not value:
    print("")
else:
    print(str(Path(value).resolve(strict=False)))
PY
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

resolve_integrity_wrapper_var() {
  local value=""
  value="$(trim "${UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER:-}")"
  if [[ -n "${value}" ]]; then
    printf '%s' "${value}"
    return 0
  fi
  value="$(trim "${UK_AQ_INTEGRITY_BACKFILL_WRAPPER:-}")"
  if [[ -n "${value}" ]]; then
    printf '%s' "${value}"
    return 0
  fi
  printf ''
}

ENV_NAME=""
OBSERVS_ONLY=0
AQI_ONLY=0
CONNECTOR_ID_RAW=""
TIMESERIES_IDS_RAW=""
FROM_DAY_UTC=""
TO_DAY_UTC=""
DRY_RUN=false
HISTORY_VERSION="v2"

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
    --observs-only)
      OBSERVS_ONLY=1
      shift
      ;;
    --aqi-only)
      AQI_ONLY=1
      shift
      ;;
    --connector-id)
      CONNECTOR_ID_RAW="${2:-}"
      shift 2
      ;;
    --connector-id=*)
      CONNECTOR_ID_RAW="${1#--connector-id=}"
      shift
      ;;
    --timeseries-ids)
      TIMESERIES_IDS_RAW="${2:-}"
      shift 2
      ;;
    --timeseries-ids=*)
      TIMESERIES_IDS_RAW="${1#--timeseries-ids=}"
      shift
      ;;
    --from-day)
      FROM_DAY_UTC="${2:-}"
      shift 2
      ;;
    --from-day=*)
      FROM_DAY_UTC="${1#--from-day=}"
      shift
      ;;
    --to-day)
      TO_DAY_UTC="${2:-}"
      shift 2
      ;;
    --to-day=*)
      TO_DAY_UTC="${1#--to-day=}"
      shift
      ;;
    --history-version)
      HISTORY_VERSION="${2:-}"
      shift 2
      ;;
    --history-version=*)
      HISTORY_VERSION="${1#--history-version=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option ${1}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${ENV_NAME}" ]]; then
  echo "ERROR: --env is required." >&2
  exit 2
fi
case "${ENV_NAME}" in
  CIC-Test|LIVE) ;;
  *)
    echo "ERROR: --env must be CIC-Test or LIVE (got '${ENV_NAME}')." >&2
    exit 2
    ;;
esac

if [[ "${HISTORY_VERSION}" != "v2" ]]; then
    echo "ERROR: --history-version must be v2 for the Integrity specialist (got '${HISTORY_VERSION}')." >&2
    exit 2
fi

if (( OBSERVS_ONLY + AQI_ONLY != 1 )); then
  echo "ERROR: pass exactly one of --observs-only or --aqi-only." >&2
  exit 2
fi

if ! validate_day_utc "${FROM_DAY_UTC}"; then
  echo "ERROR: invalid --from-day '${FROM_DAY_UTC}'." >&2
  exit 2
fi
if ! validate_day_utc "${TO_DAY_UTC}"; then
  echo "ERROR: invalid --to-day '${TO_DAY_UTC}'." >&2
  exit 2
fi
if [[ "${TO_DAY_UTC}" < "${FROM_DAY_UTC}" ]]; then
  echo "ERROR: --to-day must be >= --from-day." >&2
  exit 2
fi

CONNECTOR_ID=""
if [[ -n "${CONNECTOR_ID_RAW}" ]]; then
  if ! CONNECTOR_ID="$(normalize_connector_id "${CONNECTOR_ID_RAW}")"; then
    echo "ERROR: invalid --connector-id '${CONNECTOR_ID_RAW}' (positive integer required)." >&2
    exit 2
  fi
fi

TIMESERIES_IDS=""
if [[ -n "${TIMESERIES_IDS_RAW}" ]]; then
  if ! TIMESERIES_IDS="$(normalize_positive_int_csv "${TIMESERIES_IDS_RAW}")"; then
    echo "ERROR: invalid --timeseries-ids '${TIMESERIES_IDS_RAW}' (CSV positive integers required)." >&2
    exit 2
  fi
fi

if (( OBSERVS_ONLY == 1 )) && [[ -z "${TIMESERIES_IDS}" ]]; then
  echo "ERROR: --observs-only requires --timeseries-ids." >&2
  exit 2
fi
SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -P -- "${SCRIPT_DIR}/../../.." && pwd -P)"
reject_archive_path "specialist wrapper repository" "${REPO_ROOT}"
if [[ -n "${UK_AQ_OPS_REPO_ROOT:-}" ]]; then
  reject_archive_path "UK_AQ_OPS_REPO_ROOT" "${UK_AQ_OPS_REPO_ROOT}"
  EXPORTED_REPO_ROOT="$(resolve_abs_path "${UK_AQ_OPS_REPO_ROOT}")"
  ACTUAL_REPO_ROOT="$(resolve_abs_path "${REPO_ROOT}")"
  reject_archive_path "resolved UK_AQ_OPS_REPO_ROOT" "${EXPORTED_REPO_ROOT}"
  if [[ "${EXPORTED_REPO_ROOT}" != "${ACTUAL_REPO_ROOT}" ]]; then
    echo "ERROR: UK_AQ_OPS_REPO_ROOT points to a different repository." >&2
    exit 4
  fi
fi

ENV_FILE="${REPO_ROOT}/.env"
if [[ ! -f "${ENV_FILE}" || ! -r "${ENV_FILE}" ]]; then
  echo "ERROR: repository root .env not found or unreadable: ${ENV_FILE}" >&2
  exit 3
fi

set -a
# The shared repository .env is the only environment source for this wrapper.
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ "$(trim "${UKAQ_ENV_NAME:-}")" != "${ENV_NAME}" ]]; then
  echo "ERROR: UKAQ_ENV_NAME in the selected repository root .env does not match --env=${ENV_NAME}." >&2
  exit 4
fi

export UK_AQ_ENV_NAME="${ENV_NAME}"
export UK_AQ_OPS_REPO_ROOT="${REPO_ROOT}"
export UK_AQ_BACKFILL_ENV_FILE="${ENV_FILE}"

if [[ "$(trim "${UK_AQ_ENV_NAME:-}")" != "${ENV_NAME}" ]]; then
  echo "ERROR: failed to set authoritative UK_AQ_ENV_NAME=${ENV_NAME}." >&2
  exit 4
fi

if [[ "${ENV_NAME}" == "LIVE" ]]; then
  OTHER_ENV="CIC-Test"
else
  OTHER_ENV="LIVE"
fi

for var_name in \
  UK_AQ_HISTORY_INTEGRITY_STATE_DIR \
  UK_AQ_HISTORY_INTEGRITY_DB_PATH \
  UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR \
  UK_AQ_HISTORY_INTEGRITY_TMP_DIR \
  UK_AQ_HISTORY_INTEGRITY_LOG_DIR \
  UK_AQ_HISTORY_INTEGRITY_REPORT_DIR \
  UK_AQ_HISTORY_INTEGRITY_LOCK_DIR \
  UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER \
  UK_AQ_INTEGRITY_BACKFILL_WRAPPER \
  UK_AQ_BACKFILL_WRAPPER \
  UK_AQ_BACKFILL_ENV_FILE; do
  var_value="$(trim "${!var_name:-}")"
  if [[ -n "${var_value}" && "${var_value}" == *"/${OTHER_ENV}/"* ]]; then
    echo "ERROR: ${var_name} contains /${OTHER_ENV}/ while --env=${ENV_NAME}. Refusing to run." >&2
    exit 4
  fi
  if [[ -n "${var_value}" ]]; then
    reject_archive_path "${var_name}" "${var_value}"
  fi
done

INTEGRITY_WRAPPER="${SCRIPT_DIR}/uk_aq_integrity_backfill.sh"
BACKFILL_ENV_FILE="${ENV_FILE}"
SELF_PATH="$(resolve_abs_path "${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")")"

reject_archive_path "integrity wrapper" "${INTEGRITY_WRAPPER}"
if [[ ! -f "${INTEGRITY_WRAPPER}" || ! -x "${INTEGRITY_WRAPPER}" ]]; then
  echo "ERROR: integrity wrapper not found: ${INTEGRITY_WRAPPER}" >&2
  exit 4
fi
BACKFILL_WRAPPER="$(require_env UK_AQ_BACKFILL_WRAPPER)"
reject_archive_path "UK_AQ_BACKFILL_WRAPPER" "${BACKFILL_WRAPPER}"
BACKFILL_WRAPPER_PATH="$(resolve_abs_path "${BACKFILL_WRAPPER}")"
reject_archive_path "resolved UK_AQ_BACKFILL_WRAPPER" "${BACKFILL_WRAPPER_PATH}"
INTEGRITY_WRAPPER_PATH="$(resolve_abs_path "${INTEGRITY_WRAPPER}")"
reject_archive_path "resolved integrity wrapper" "${INTEGRITY_WRAPPER_PATH}"
if [[ "${BACKFILL_WRAPPER_PATH}" == "${SELF_PATH}" || "${BACKFILL_WRAPPER_PATH}" == "${INTEGRITY_WRAPPER_PATH}" ]]; then
  echo "ERROR: nested UK_AQ_BACKFILL_WRAPPER resolves to integrity wrapper (${BACKFILL_WRAPPER_PATH}); this would recurse." >&2
  echo "ERROR: set UK_AQ_BACKFILL_WRAPPER in ${BACKFILL_ENV_FILE} to the real backfill runner (for example scripts/uk_aq_backfill_local.sh)." >&2
  exit 4
fi
if [[ ! -f "${BACKFILL_WRAPPER}" ]]; then
  echo "ERROR: nested UK_AQ_BACKFILL_WRAPPER not found: ${BACKFILL_WRAPPER}" >&2
  exit 4
fi

if ! NODE_BIN="$(resolve_node_bin)"; then
  echo "ERROR: unable to resolve node binary for integrity backfill." >&2
  exit 4
fi
export UK_AQ_BACKFILL_NODE_BIN="${NODE_BIN}"

if (( OBSERVS_ONLY == 1 )); then
  export UK_AQ_BACKFILL_RUN_MODE="source_to_r2"
  export UK_AQ_BACKFILL_OUTPUT_SCOPE="observations_only"
else
  export UK_AQ_BACKFILL_RUN_MODE="r2_history_obs_to_aqilevels"
  export UK_AQ_BACKFILL_OUTPUT_SCOPE="aqilevels_only"
fi


export UK_AQ_R2_HISTORY_VERSION="${HISTORY_VERSION}"
export UK_AQ_R2_HISTORY_INDEX_VERSION="${HISTORY_VERSION}"
export UK_AQ_BACKFILL_TRIGGER_MODE="manual"
export UK_AQ_BACKFILL_DRY_RUN="${DRY_RUN}"
export UK_AQ_BACKFILL_FORCE_REPLACE="true"
export UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX="false"
export UK_AQ_BACKFILL_FROM_DAY_UTC="${FROM_DAY_UTC}"
export UK_AQ_BACKFILL_TO_DAY_UTC="${TO_DAY_UTC}"

if [[ -n "${CONNECTOR_ID}" ]]; then
  export UK_AQ_BACKFILL_CONNECTOR_IDS="${CONNECTOR_ID}"
else
  unset UK_AQ_BACKFILL_CONNECTOR_IDS || true
fi

if (( OBSERVS_ONLY == 1 )); then
  export UK_AQ_BACKFILL_TIMESERIES_IDS="${TIMESERIES_IDS}"
else
  unset UK_AQ_BACKFILL_TIMESERIES_IDS || true
  unset UK_AQ_BACKFILL_TIMESERIES_ID || true
fi

echo "=== UK AQ Integrity Backfill ==="
echo "env: ${ENV_NAME}"
echo "mode: ${UK_AQ_BACKFILL_RUN_MODE}"
echo "output_scope: ${UK_AQ_BACKFILL_OUTPUT_SCOPE}"
echo "history_version: ${HISTORY_VERSION}"
echo "r2_history_version: ${UK_AQ_R2_HISTORY_VERSION}"
echo "dry_run: ${UK_AQ_BACKFILL_DRY_RUN}"
echo "force_replace: ${UK_AQ_BACKFILL_FORCE_REPLACE}"
echo "full_r2_history_index_rebuild: ${UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX}"
echo "from_day_utc: ${UK_AQ_BACKFILL_FROM_DAY_UTC}"
echo "to_day_utc: ${UK_AQ_BACKFILL_TO_DAY_UTC}"
echo "connector_ids: ${UK_AQ_BACKFILL_CONNECTOR_IDS:-all}"
echo "timeseries_ids: ${UK_AQ_BACKFILL_TIMESERIES_IDS:-n/a}"
echo "integrity_wrapper: ${INTEGRITY_WRAPPER}"
echo "backfill_wrapper: ${BACKFILL_WRAPPER}"
echo "backfill_env_file: ${BACKFILL_ENV_FILE}"

set +e
bash "${BACKFILL_WRAPPER}"
status=$?
set -e
if [[ "${status}" -ne 0 ]]; then
  exit "${status}"
fi

exit 0
