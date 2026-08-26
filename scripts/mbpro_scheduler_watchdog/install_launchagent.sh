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

if [ -z "${CONFIG_SOURCE}" ] || [ ! -f "${CONFIG_SOURCE}" ]; then
  usage
  exit 2
fi

watchdog_load_identity "$CONFIG_SOURCE"

PYTHON_BIN="$(command -v python3)"
if [ -z "${PYTHON_BIN}" ]; then
  echo "python3 is required." >&2
  exit 1
fi

PYTHON_ENVIRONMENT="$(
  "$PYTHON_BIN" "${SCRIPT_DIR}/uk_aq_scheduler_watchdog.py" \
    --config "$CONFIG_SOURCE" \
    --validate-config
)"
if [ "$PYTHON_ENVIRONMENT" != "$WATCHDOG_ENVIRONMENT" ]; then
  echo "Shell/Python watchdog environment validation disagrees." >&2
  exit 1
fi

mkdir -p "$WATCHDOG_INSTALL_DIR" "$WATCHDOG_LOG_DIR" "${HOME}/Library/LaunchAgents"
chmod 700 "$WATCHDOG_SUPPORT_DIR" "$WATCHDOG_INSTALL_DIR" "$WATCHDOG_LOG_DIR"
install -m 700 \
  "${SCRIPT_DIR}/uk_aq_scheduler_watchdog.py" \
  "${WATCHDOG_INSTALL_DIR}/uk_aq_scheduler_watchdog.py"
install -m 600 "$CONFIG_SOURCE" "${WATCHDOG_SUPPORT_DIR}/watchdog.env"

escape_sed() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

escape_xml_text() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\\&apos;/g"
}

escape_plist_replacement() {
  escape_sed "$(escape_xml_text "$1")"
}

RENDERED_PLIST="$(mktemp "${WATCHDOG_PLIST_PATH}.tmp.XXXXXX")"
trap 'rm -f "$RENDERED_PLIST"' EXIT

sed \
  -e "s|__LABEL__|$(escape_plist_replacement "$WATCHDOG_LABEL")|g" \
  -e "s|__PYTHON_BIN__|$(escape_plist_replacement "${PYTHON_BIN}")|g" \
  -e "s|__WATCHDOG_SCRIPT__|$(escape_plist_replacement "${WATCHDOG_INSTALL_DIR}/uk_aq_scheduler_watchdog.py")|g" \
  -e "s|__CONFIG_FILE__|$(escape_plist_replacement "${WATCHDOG_SUPPORT_DIR}/watchdog.env")|g" \
  -e "s|__LOG_FILE__|$(escape_plist_replacement "${WATCHDOG_LOG_DIR}/watchdog.jsonl")|g" \
  -e "s|__LAUNCHD_STDOUT__|$(escape_plist_replacement "${WATCHDOG_LOG_DIR}/launchd.stdout.log")|g" \
  -e "s|__LAUNCHD_STDERR__|$(escape_plist_replacement "${WATCHDOG_LOG_DIR}/launchd.stderr.log")|g" \
  "${SCRIPT_DIR}/uk.co.ukaq.scheduler-watchdog.plist.template" > "$RENDERED_PLIST"
chmod 600 "$RENDERED_PLIST"
plutil -lint "$RENDERED_PLIST"

USER_ID="$(id -u)"
launchctl bootout "gui/${USER_ID}/${WATCHDOG_LABEL}" 2>/dev/null || true
install -m 600 "$RENDERED_PLIST" "$WATCHDOG_PLIST_PATH"
launchctl bootstrap "gui/${USER_ID}" "$WATCHDOG_PLIST_PATH"
launchctl kickstart -k "gui/${USER_ID}/${WATCHDOG_LABEL}"

rm -f "$RENDERED_PLIST"
trap - EXIT

echo "Installed ${WATCHDOG_LABEL} for ${WATCHDOG_ENVIRONMENT}."
echo "Status: launchctl print gui/${USER_ID}/${WATCHDOG_LABEL}"
echo "Watchdog log: tail -f '${WATCHDOG_LOG_DIR}/watchdog.jsonl'"
echo "LaunchAgent errors: tail -f '${WATCHDOG_LOG_DIR}/launchd.stderr.log'"
