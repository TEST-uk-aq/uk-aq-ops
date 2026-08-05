#!/bin/bash

set -euo pipefail

# Always provide a valid detached stdin to Python and child processes.
exec </dev/null

INTEGRITY="/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh"
LOG_ROOT="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/logs/integrity-run-monthly"
COOL_DOWN_SECONDS=300
PYTHON_BIN="${PYTHON_BIN:-python3}"

mkdir -p "$LOG_ROOT"

RUN_STARTED="$(date -u +%Y%m%dT%H%M%SZ)"
SUMMARY="$LOG_ROOT/run-summary-${RUN_STARTED}.log"

append_connector_totals() {
  LOG_FILE="$1"

  "$PYTHON_BIN" - "$LOG_FILE" <<'PY' | tee -a "$SUMMARY"
import json
import re
import sys
from pathlib import Path

log_path = Path(sys.argv[1])

try:
    log_text = log_path.read_text(encoding="utf-8", errors="replace")
except OSError:
    print("Connector observation totals unavailable")
    raise SystemExit(0)


def last_existing_report_path(field: str):
    candidates = re.findall(rf"\b{re.escape(field)}=(\S+)", log_text)
    for candidate in reversed(candidates):
        path = Path(candidate)
        if path.is_file():
            return path
    return None


def totals_from_json(report_path):
    if report_path is None:
        return None
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    totals = report.get("connector_observation_totals")
    return totals if isinstance(totals, dict) and totals else None


def totals_from_markdown(report_path):
    if report_path is None:
        return None
    try:
        lines = report_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return None

    try:
        start = lines.index("## Connector observation totals") + 1
    except ValueError:
        return None

    totals = {}
    connector_id = None
    labels = {
        "Total Observs before": "total_observations_before",
        "Total Observs added": "total_observations_added",
        "Total Observs after": "total_observations_after",
    }

    for line in lines[start:]:
        if line.startswith("## "):
            break
        connector_match = re.fullmatch(r"### Connector (.+)", line)
        if connector_match:
            connector_id = connector_match.group(1).strip()
            totals.setdefault(connector_id, {})
            continue
        value_match = re.fullmatch(
            r"- (Total Observs (?:before|added|after)): ([0-9,]+)",
            line,
        )
        if connector_id and value_match:
            totals[connector_id][labels[value_match.group(1)]] = int(
                value_match.group(2).replace(",", "")
            )

    return totals or None


report_json = last_existing_report_path("report_json")
report_md = last_existing_report_path("report_md")
totals = totals_from_json(report_json) or totals_from_markdown(report_md)

if not isinstance(totals, dict) or not totals:
    print("Connector observation totals unavailable")
    raise SystemExit(0)


def connector_sort_key(item):
    connector_id = str(item[0])
    try:
        return (0, int(connector_id))
    except ValueError:
        return (1, connector_id)


printed = False
for connector_id, values in sorted(totals.items(), key=connector_sort_key):
    if not isinstance(values, dict):
        continue

    before = values.get("total_observations_before")
    added = values.get("total_observations_added")
    after = values.get("total_observations_after")

    if not all(isinstance(value, int) and value >= 0 for value in (before, added, after)):
        continue

    print(f"Connector {connector_id}:")
    print(f"Total Observs before: {before:,}")
    print(f"Total Observs added: {added:,}")
    print(f"Total Observs after: {after:,}")
    printed = True

if not printed:
    print("Connector observation totals unavailable")
PY

  return 0
}

run_batch() {
  FROM_DAY="$1"
  TO_DAY="$2"
  LABEL="$3"

  LOG="$LOG_ROOT/${LABEL}-${RUN_STARTED}.log"
  OK_MARKER="$LOG_ROOT/${LABEL}.ok"

  if [ -f "$OK_MARKER" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "$(date -u +%FT%TZ) SKIP $LABEL already completed" | tee -a "$SUMMARY"
    return 0
  fi

  echo "$(date -u +%FT%TZ) START $LABEL $FROM_DAY to $TO_DAY" | tee -a "$SUMMARY"
  echo "Log: $LOG" | tee -a "$SUMMARY"

  if nice -n 10 "$INTEGRITY" \
    --env CIC-Test \
    --profile manual \
    --source sos \
    --from-day "$FROM_DAY" \
    --to-day "$TO_DAY" \
    --run-backfill \
    --repair-pollutants pm25,pm10,no2,o3 \
    --allow-stale-dropbox \
    --verbose \
    </dev/null \
    >"$LOG" 2>&1
  then
    touch "$OK_MARKER"
    echo "$(date -u +%FT%TZ) SUCCESS $LABEL" | tee -a "$SUMMARY"
    append_connector_totals "$LOG"
  else
    EXIT_CODE=$?
    rm -f "$OK_MARKER"
    echo "$(date -u +%FT%TZ) FAILED $LABEL exit=$EXIT_CODE" | tee -a "$SUMMARY"
  fi

  if [ "$COOL_DOWN_SECONDS" -gt 0 ]; then
    echo "$(date -u +%FT%TZ) Cooling down for ${COOL_DOWN_SECONDS}s" | tee -a "$SUMMARY"
    sleep "$COOL_DOWN_SECONDS"
  fi
}

run_batch 2026-02-01 2026-02-28 2026-02
run_batch 2026-03-01 2026-03-31 2026-03
run_batch 2026-04-01 2026-04-30 2026-04
run_batch 2026-05-01 2026-05-31 2026-05
run_batch 2026-06-01 2026-06-30 2026-06
run_batch 2026-07-01 2026-07-31 2026-07

echo "$(date -u +%FT%TZ) ALL BATCHES ATTEMPTED" | tee -a "$SUMMARY"
echo "Summary: $SUMMARY"
