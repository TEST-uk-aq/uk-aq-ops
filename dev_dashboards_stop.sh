#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PID_FILE="$ROOT_DIR/.dashboards.pids"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file found: $PID_FILE"
  exit 0
fi

is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

stop_pid() {
  local label="$1"
  local pid="$2"

  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    return
  fi

  if ! is_running "$pid"; then
    echo "$label already stopped (pid $pid)."
    return
  fi

  kill "$pid" 2>/dev/null || true

  for _ in {1..30}; do
    if ! is_running "$pid"; then
      break
    fi
    sleep 0.1
  done

  if is_running "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  echo "Stopped $label (pid $pid)."
}

while IFS=':' read -r label pid; do
  [[ -n "$pid" ]] || continue
  stop_pid "${label:-process}" "$pid"
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "Removed PID file: $PID_FILE"
