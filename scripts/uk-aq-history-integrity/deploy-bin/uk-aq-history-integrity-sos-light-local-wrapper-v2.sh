#!/usr/bin/env bash
# Small local deployment wrapper. It selects a repository from one tiny,
# local selector file and never loads the selected repository .env itself.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  uk-aq-history-integrity-sos-light-local-wrapper-v2.sh --env TEST|LIVE [options]

This deployed local wrapper reads only:
  /Users/mikehinford/uk-aq-history-integrity/env/TEST.env
  /Users/mikehinford/uk-aq-history-integrity/env/LIVE.env

Each selector file contains only UK_AQ_OPS_REPO_ROOT. The selected repository
runner loads that repository's root .env and receives all Integrity arguments.

Local wrapper options (never forwarded to the runner):
  --launchd        Submit a one-off job to the current user's gui/<UID> domain.
  --follow         Follow the combined log from the beginning after submission.
  --log-file PATH  Absolute combined log path; existing non-empty logs are refused.
                   --follow and --log-file require --launchd.

Without --launchd, execution stays in the foreground. Generated plists are kept
under <LOCAL_ROOT>/state/<ENV>/launchd/ and default UTC logs under its logs/.
Jobs do not restart automatically or run again at login/reboot. The GUI login
must remain active. Ctrl+C stops log following only; tail continues until stopped.
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
ORIGINAL_ARGS=()
ENV_NAME=""
USE_LAUNCHD=false
FOLLOW_LOG=false
LOG_FILE=""
HAS_LOG_FILE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || error "--env requires TEST or LIVE"
      [[ -z "${ENV_NAME}" ]] || error "--env supplied more than once"
      ENV_NAME="$2"
      ORIGINAL_ARGS+=("$1" "$2")
      shift 2
      ;;
    --env=*)
      [[ -z "${ENV_NAME}" ]] || error "--env supplied more than once"
      ENV_NAME="${1#--env=}"
      ORIGINAL_ARGS+=("$1")
      shift
      ;;
    --launchd)
      USE_LAUNCHD=true
      shift
      ;;
    --follow)
      FOLLOW_LOG=true
      shift
      ;;
    --log-file)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || error "--log-file requires an absolute path"
      [[ "${HAS_LOG_FILE}" == false ]] || error "--log-file supplied more than once"
      LOG_FILE="$2"
      HAS_LOG_FILE=true
      shift 2
      ;;
    --log-file=*)
      [[ "${HAS_LOG_FILE}" == false ]] || error "--log-file supplied more than once"
      LOG_FILE="${1#--log-file=}"
      [[ -n "${LOG_FILE}" ]] || error "--log-file requires an absolute path"
      HAS_LOG_FILE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      ORIGINAL_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "${USE_LAUNCHD}" == false ]]; then
  [[ "${FOLLOW_LOG}" == false ]] || error "--follow requires --launchd"
  [[ "${HAS_LOG_FILE}" == false ]] || error "--log-file requires --launchd"
fi
if [[ "${HAS_LOG_FILE}" == true ]]; then
  [[ "${LOG_FILE}" = /* ]] || error "--log-file must be an absolute path"
fi

[[ "${ENV_NAME}" == "TEST" || "${ENV_NAME}" == "LIVE" ]] || error "--env must be TEST or LIVE"
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
RUNNER="${OPS_REPO_ROOT}/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v2.sh"
[[ -f "${RUNNER}" && -x "${RUNNER}" ]] || error "selected repository runner is unavailable or not executable: ${RUNNER}"

export UK_AQ_ENV_NAME="${ENV_NAME}"
export UK_AQ_OPS_REPO_ROOT="${OPS_REPO_ROOT}"
export UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT="${LOCAL_ROOT}"
if [[ "${USE_LAUNCHD}" == false ]]; then
  # Foreground invocations must not reuse provenance inherited from another job.
  unset UK_AQ_HISTORY_INTEGRITY_LAUNCHD_JOB_LABEL \
    UK_AQ_HISTORY_INTEGRITY_LAUNCHD_DOMAIN \
    UK_AQ_HISTORY_INTEGRITY_LAUNCHD_LOG_PATH
  exec "${RUNNER}" "${ORIGINAL_ARGS[@]}"
fi

[[ "$(uname -s)" == Darwin ]] || error "--launchd requires macOS"
[[ -x /bin/launchctl && -x /usr/bin/plutil ]] || error "launchctl or plutil is unavailable"
LAUNCH_DOMAIN="gui/$(id -u)"
/bin/launchctl print "${LAUNCH_DOMAIN}" >/dev/null 2>&1 || error "launchd domain ${LAUNCH_DOMAIN} is unavailable; the current user must be logged in at the GUI"

# Keep absolute caller PATH entries (e.g. Rscript), omitting cwd-relative ones.
LAUNCH_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
IFS=: read -r -a CALLER_PATH_ENTRIES <<< "${PATH:-}"
for entry in "${CALLER_PATH_ENTRIES[@]}"; do
  [[ "${entry}" = /* ]] || continue
  case ":${LAUNCH_PATH}:" in
    *":${entry}:"*) ;;
    *) LAUNCH_PATH="${LAUNCH_PATH}:${entry}" ;;
  esac
done
[[ -x /bin/bash ]] || error "launchd Bash is unavailable: /bin/bash"
for executable in python3 node; do
  EXECUTABLE_PATH="$(PATH="${LAUNCH_PATH}" /bin/bash --noprofile --norc -c 'type -P "$1"' bash "${executable}")" || error "${executable} cannot be resolved using the launchd PATH: ${LAUNCH_PATH}"
  [[ -x "${EXECUTABLE_PATH}" ]] || error "${executable} is not executable: ${EXECUTABLE_PATH}"
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
UNIQUE_ID="$(/usr/bin/uuidgen)" || error "could not generate a unique launchd identity"
ENV_LOWER="$(printf '%s' "${ENV_NAME}" | tr '[:upper:]' '[:lower:]')"
JOB_LABEL="co.uk.ukaq.integrity.${ENV_LOWER}.v2.${STAMP}.$$.$UNIQUE_ID"
JOB_TARGET="${LAUNCH_DOMAIN}/${JOB_LABEL}"
PLIST_DIR="${LOCAL_ROOT}/state/${ENV_NAME}/launchd"
PLIST_FILE="${PLIST_DIR}/${JOB_LABEL}.plist"
if [[ "${HAS_LOG_FILE}" == false ]]; then
  LOG_FILE="${LOCAL_ROOT}/state/${ENV_NAME}/logs/uk-aq-history-integrity-${ENV_NAME}-v2-${STAMP}-$$-${UNIQUE_ID}.log"
fi
reject_archive_path "launchd directory" "${PLIST_DIR}"
reject_archive_path "launchd log" "${LOG_FILE}"
/bin/launchctl print "${JOB_TARGET}" >/dev/null 2>&1 && error "duplicate launchd job label: ${JOB_LABEL}"

LOG_CREATED=false
PLIST_CREATED=false
SUBMITTING=false
cleanup_launch_preparation() {
  # Once bootstrap begins, an interrupted caller cannot know whether launchd
  # accepted the job. Preserve its files rather than disturb a possible run.
  [[ "${SUBMITTING}" == false ]] || return 0
  if [[ "${PLIST_CREATED}" == true ]]; then
    rm -f -- "${PLIST_FILE}"
  fi
  if [[ "${LOG_CREATED}" == true && -f "${LOG_FILE}" && ! -s "${LOG_FILE}" ]]; then
    rm -f -- "${LOG_FILE}"
  fi
}
trap cleanup_launch_preparation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# plistlib escapes XML and preserves each argument, including spaces/quotes.
# Only a small non-secret environment allowlist is written to disk.
generate_launch_plist() {
  PATH="${LAUNCH_PATH}" python3 - "${PLIST_FILE}" "${LOG_FILE}" "${JOB_LABEL}" \
  "${RUNNER}" "${ENV_NAME}" "${OPS_REPO_ROOT}" "${LOCAL_ROOT}" \
  "${LAUNCH_PATH}" "${LAUNCH_DOMAIN}" "${ORIGINAL_ARGS[@]}" <<'PYLAUNCH'
import os
from pathlib import Path
import plistlib
import stat
import sys

plist_path, log_path, label, runner, env, repo, local_root, path, domain = sys.argv[1:10]
job = {
    "Label": label,
    # Static shell code only: $0 is a descriptive name; $1 is the log path.
    # exec preserves the runner's PID as the launchd job PID. One append-open
    # stdout descriptor is duplicated to stderr before the runner starts.
    "ProgramArguments": ["/bin/bash", "--noprofile", "--norc", "-c",
                         'exec >>"$1" 2>&1; shift; exec "$@"',
                         "uk-aq-integrity-launchd", log_path, runner, *sys.argv[10:]],
    "EnvironmentVariables": {
        "PATH": path,
        "UK_AQ_ENV_NAME": env,
        "UK_AQ_OPS_REPO_ROOT": repo,
        "UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT": local_root,
        # Invocation-only provenance; never populate these from repository .env.
        "UK_AQ_HISTORY_INTEGRITY_LAUNCHD_JOB_LABEL": label,
        "UK_AQ_HISTORY_INTEGRITY_LAUNCHD_DOMAIN": domain,
        "UK_AQ_HISTORY_INTEGRITY_LAUNCHD_LOG_PATH": log_path,
    },
    "WorkingDirectory": repo,
    "RunAtLoad": True,
    "KeepAlive": False,
}
created_log = False
created_plist = False
try:
    payload = plistlib.dumps(job, fmt=plistlib.FMT_XML)
    plistlib.loads(payload)
    for directory in (Path(plist_path).parent, Path(log_path).parent):
        directory.mkdir(parents=True, exist_ok=True)
        if not directory.is_dir() or not os.access(directory, os.W_OK | os.X_OK):
            raise ValueError(f"directory is unavailable or not writable: {directory}")
    try:
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created_log = True
    except FileExistsError:
        fd = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "ab") as log:
        info = os.fstat(log.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size:
            raise ValueError(f"log must be a writable empty regular file: {log_path}")
    fd = os.open(plist_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    created_plist = True
    with os.fdopen(fd, "wb") as plist:
        plist.write(payload)
    print("true" if created_log else "false")
except (OSError, ValueError, TypeError) as exc:
    if created_plist:
        Path(plist_path).unlink()
    if created_log:
        Path(log_path).unlink()
    print(f"ERROR: launchd preparation failed: {exc}", file=sys.stderr)
    raise SystemExit(2)
PYLAUNCH
}
LOG_CREATED="$(generate_launch_plist)" || error "could not prepare launchd plist and log"
PLIST_CREATED=true
/usr/bin/plutil -lint "${PLIST_FILE}" || error "generated launchd plist is invalid"

SUBMITTING=true
if ! /bin/launchctl bootstrap "${LAUNCH_DOMAIN}" "${PLIST_FILE}"; then
  if /bin/launchctl print "${JOB_TARGET}" >/dev/null 2>&1; then
    error "bootstrap reported failure but ${JOB_TARGET} is registered; inspect it before taking further action. Plist and log retained: ${PLIST_FILE}, ${LOG_FILE}"
  fi
  SUBMITTING=false
  error "launchctl bootstrap failed for ${JOB_TARGET}; no fallback or retry attempted"
fi
# From here no terminal signal or exit may clean up the submitted job's files.
trap - EXIT INT TERM HUP
JOB_PID="$(/bin/launchctl print "${JOB_TARGET}" 2>/dev/null | awk '$1 == "pid" && $2 == "=" && $3 ~ /^[0-9]+$/ {print $3; exit}' || true)"
printf '\nIntegrity launched via launchd\n\nEnvironment: %s\nJob: %s\nPID: %s\nLog: %s\nPlist: %s\n' \
  "${ENV_NAME}" "${JOB_LABEL}" "${JOB_PID:-not yet available (or job already exited)}" "${LOG_FILE}" "${PLIST_FILE}"
printf '\nFollow log:\n  tail -n +1 -f %q\n\nInspect job:\n  launchctl print %q\n' "${LOG_FILE}" "${JOB_TARGET}"
if [[ "${FOLLOW_LOG}" == true ]]; then
  exec /usr/bin/tail -n +1 -f "${LOG_FILE}"
fi
