#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "${SCRIPT_DIR}/watchdog_launchagent_common.sh"

CONFIG_SOURCE=""
PURGE=0

usage() {
  echo "Usage: $0 --config /absolute/path/to/watchdog.env [--purge]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      CONFIG_SOURCE="$2"
      shift 2
      ;;
    --purge) PURGE=1; shift ;;
    *) usage; exit 2 ;;
  esac
done

if [ -z "$CONFIG_SOURCE" ] || [ ! -f "$CONFIG_SOURCE" ]; then
  usage
  exit 2
fi

watchdog_load_identity "$CONFIG_SOURCE"

USER_ID="$(id -u)"
launchctl bootout "gui/${USER_ID}/${WATCHDOG_LABEL}" 2>/dev/null || true
rm -f "$WATCHDOG_PLIST_PATH"

if [ "${PURGE}" -eq 1 ]; then
  case "$WATCHDOG_SUPPORT_DIR" in
    "${HOME}/Library/Application Support/UK AQ/scheduler-watchdog-test"|\
    "${HOME}/Library/Application Support/UK AQ/scheduler-watchdog-live") ;;
    *) echo "Refusing to purge unexpected support path." >&2; exit 1 ;;
  esac
  rm -rf "$WATCHDOG_SUPPORT_DIR"
  echo "Removed installed ${WATCHDOG_ENVIRONMENT} watchdog files and local configuration."
  echo "Logs were retained at ${WATCHDOG_LOG_DIR}."
else
  echo "Unloaded ${WATCHDOG_LABEL}; local configuration and logs were retained."
  echo "Run '$0 --config \"$CONFIG_SOURCE\" --purge' only after the rollback is complete and the secret may be removed."
fi
