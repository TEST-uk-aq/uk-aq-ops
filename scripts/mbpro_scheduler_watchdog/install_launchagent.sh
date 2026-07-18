#!/usr/bin/env bash
set -euo pipefail

LABEL="uk.co.ukaq.test-scheduler-watchdog"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPPORT_DIR="${HOME}/Library/Application Support/UK AQ/scheduler-watchdog"
INSTALL_DIR="${SUPPORT_DIR}/bin"
LOG_DIR="${HOME}/Library/Logs/UK AQ/scheduler-watchdog"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
CONFIG_SOURCE=""

usage() {
  echo "Usage: $0 --config /absolute/path/to/watchdog.env" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) CONFIG_SOURCE="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

if [ -z "${CONFIG_SOURCE}" ] || [ ! -f "${CONFIG_SOURCE}" ]; then
  usage
  exit 2
fi

PYTHON_BIN="$(command -v python3)"
if [ -z "${PYTHON_BIN}" ]; then
  echo "python3 is required." >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}" "${LOG_DIR}" "${HOME}/Library/LaunchAgents"
chmod 700 "${SUPPORT_DIR}" "${INSTALL_DIR}" "${LOG_DIR}"
install -m 700 "${SCRIPT_DIR}/uk_aq_scheduler_watchdog.py" "${INSTALL_DIR}/uk_aq_scheduler_watchdog.py"
install -m 600 "${CONFIG_SOURCE}" "${SUPPORT_DIR}/watchdog.env"

escape_sed() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

sed \
  -e "s|__PYTHON_BIN__|$(escape_sed "${PYTHON_BIN}")|g" \
  -e "s|__WATCHDOG_SCRIPT__|$(escape_sed "${INSTALL_DIR}/uk_aq_scheduler_watchdog.py")|g" \
  -e "s|__CONFIG_FILE__|$(escape_sed "${SUPPORT_DIR}/watchdog.env")|g" \
  -e "s|__LOG_FILE__|$(escape_sed "${LOG_DIR}/watchdog.jsonl")|g" \
  -e "s|__LAUNCHD_STDOUT__|$(escape_sed "${LOG_DIR}/launchd.stdout.log")|g" \
  -e "s|__LAUNCHD_STDERR__|$(escape_sed "${LOG_DIR}/launchd.stderr.log")|g" \
  "${SCRIPT_DIR}/${LABEL}.plist.template" > "${PLIST_PATH}"
chmod 600 "${PLIST_PATH}"
plutil -lint "${PLIST_PATH}"

USER_ID="$(id -u)"
launchctl bootout "gui/${USER_ID}" "${PLIST_PATH}" 2>/dev/null || true
launchctl bootstrap "gui/${USER_ID}" "${PLIST_PATH}"
launchctl kickstart -k "gui/${USER_ID}/${LABEL}"

echo "Installed ${LABEL}."
echo "Status: launchctl print gui/${USER_ID}/${LABEL}"
echo "Watchdog log: tail -f '${LOG_DIR}/watchdog.jsonl'"
echo "LaunchAgent errors: tail -f '${LOG_DIR}/launchd.stderr.log'"
