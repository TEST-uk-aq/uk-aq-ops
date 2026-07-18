#!/usr/bin/env bash
set -euo pipefail

LABEL="uk.co.ukaq.test-scheduler-watchdog"
LOG_DIR="${HOME}/Library/Logs/UK AQ/scheduler-watchdog"
USER_ID="$(id -u)"

launchctl print "gui/${USER_ID}/${LABEL}"
echo "Watchdog log: ${LOG_DIR}/watchdog.jsonl"
echo "LaunchAgent stderr: ${LOG_DIR}/launchd.stderr.log"
