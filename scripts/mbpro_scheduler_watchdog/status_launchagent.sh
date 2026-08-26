#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "${SCRIPT_DIR}/watchdog_launchagent_common.sh"

CONFIG_SOURCE=""

usage() {
  echo "Usage: $0 --config /absolute/path/to/watchdog.env" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      CONFIG_SOURCE="$2"
      shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done

if [ -z "$CONFIG_SOURCE" ] || [ ! -f "$CONFIG_SOURCE" ]; then
  usage
  exit 2
fi

watchdog_load_identity "$CONFIG_SOURCE"
USER_ID="$(id -u)"

watchdog_print_identity
launchctl print "gui/${USER_ID}/${WATCHDOG_LABEL}"
echo "Watchdog log: ${WATCHDOG_LOG_DIR}/watchdog.jsonl"
echo "LaunchAgent stderr: ${WATCHDOG_LOG_DIR}/launchd.stderr.log"
