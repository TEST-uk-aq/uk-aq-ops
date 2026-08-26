#!/usr/bin/env bash
set -euo pipefail

LABEL="uk.co.ukaq.test-scheduler-watchdog"
SUPPORT_DIR="${HOME}/Library/Application Support/UK AQ/scheduler-watchdog"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PURGE=0

if [ "${1:-}" = "--purge" ]; then
  PURGE=1
elif [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--purge]" >&2
  exit 2
fi

USER_ID="$(id -u)"
launchctl bootout "gui/${USER_ID}" "${PLIST_PATH}" 2>/dev/null || true
rm -f "${PLIST_PATH}"

if [ "${PURGE}" -eq 1 ]; then
  rm -rf "${SUPPORT_DIR}"
  echo "Removed installed watchdog files and local configuration. Logs were retained."
else
  echo "Unloaded ${LABEL}; local configuration and logs were retained."
  echo "Run '$0 --purge' only after the rollback is complete and the secret may be removed."
fi
