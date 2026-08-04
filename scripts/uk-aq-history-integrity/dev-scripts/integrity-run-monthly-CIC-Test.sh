#!/bin/bash

set -u
set -o pipefail

INTEGRITY="/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh"
LOG_ROOT="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/logs/integrity-run-monthly"
COOL_DOWN_SECONDS=300
PYTHON_BIN="${PYTHON_BIN:-python3}"

mkdir -p "$LOG_ROOT"

RUN_STARTED="$(date -u +%Y%m%dT%H%M%SZ)"
SUMMARY="$LOG_ROOT/run-summary-${RUN_STARTED}.log"

append_connector_totals() {
  LOG_FILE="$1"

  REPORT_JSON="$(
    sed -n 's/^.*report_json=//p' "$LOG_FILE" 2>/dev/null | tail -n 1
  )"

  if [ -z "$REPORT_JSON" ] || [ ! -f "$REPORT_JSON" ]; then
    echo "Connector observation totals unavailable" | tee -a "$SUMMARY"
    return 0
  fi

  "$PYTHON_BIN" - "$REPORT_JSON" <<'PY' | tee -a "$SUMMARY"
import json
import sys
from pathlib import Path

report_path = Path(sys.argv[1])

try:
    report = json.loads(report_path.read_text(encoding="utf-8"))
except Exception:
    print("Connector observation totals unavailable")
    raise SystemExit(0)

totals = report.get("connector_observation_totals")
if not isinstance(totals, dict) or not totals:
    print("Connector observation totals unavailable")
    raise SystemExit(0)

printed = False

def connector_sort_key(item):
    connector_id = str(item[0])
    try:
        return (0, int(connector_id))
    except ValueError:
        return (1, connector_id)

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
    --verbose >"$LOG" 2>&1
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

run_batch 2025-01-01 2025-01-31 2025-01
run_batch 2025-02-01 2025-02-28 2025-02
run_batch 2025-03-01 2025-03-31 2025-03
run_batch 2025-04-01 2025-04-30 2025-04
run_batch 2025-05-01 2025-05-31 2025-05
run_batch 2025-06-01 2025-06-30 2025-06
run_batch 2025-07-01 2025-07-31 2025-07
run_batch 2025-08-01 2025-08-31 2025-08
run_batch 2025-09-01 2025-09-30 2025-09
run_batch 2025-10-01 2025-10-31 2025-10
run_batch 2025-11-01 2025-11-30 2025-11
run_batch 2025-12-01 2025-12-31 2025-12

# Required as the D+1 boundary for WHO calculations on 31/12/2025.
run_batch 2026-01-01 2026-01-31 2026-01

echo "$(date -u +%FT%TZ) ALL BATCHES ATTEMPTED" | tee -a "$SUMMARY"
echo "Summary: $SUMMARY"
