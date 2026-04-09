#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PID_FILE="$ROOT_DIR/.dashboards.pids"
LOG_DIR="$ROOT_DIR/logs"
SCHED_LOG="$LOG_DIR/scheduler.log"
SNAP_LOG="$LOG_DIR/station_snapshot.log"

if [[ -x "$ROOT_DIR/.venv/bin/python3" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  PYTHON_BIN=""
fi

if [[ -z "$PYTHON_BIN" ]]; then
  echo "A Python 3 interpreter is required." >&2
  exit 1
fi

if ! "$PYTHON_BIN" -c "import requests" >/dev/null 2>&1; then
  echo "The selected Python interpreter is missing the required 'requests' package: $PYTHON_BIN" >&2
  exit 1
fi

set -a
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi
if [[ -f "$ROOT_DIR/.env.supabase" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.supabase"
fi
set +a

if [[ -z "${SUPABASE_URL:-}" && -n "${SB_SUPABASE_URL:-}" ]]; then
  export SUPABASE_URL="$SB_SUPABASE_URL"
fi

# Local dashboard should not require upstream bearer auth by default, even if
# the token exists in .env for hosted deployments.
if [[ "${DASHBOARD_LOCAL_ENFORCE_BEARER_AUTH:-false}" != "true" ]]; then
  export DASHBOARD_UPSTREAM_BEARER_TOKEN=""
fi

missing_vars=()
[[ -n "${SUPABASE_URL:-}" ]] || missing_vars+=("SUPABASE_URL")
[[ -n "${SB_SECRET_KEY:-}" ]] || missing_vars+=("SB_SECRET_KEY")
if (( ${#missing_vars[@]} > 0 )); then
  echo "Missing required environment variables: ${missing_vars[*]}" >&2
  exit 1
fi

HOST="${HOST:-127.0.0.1}"
SCHEDULER_PORT="${SCHEDULER_PORT:-8045}"
SNAPSHOT_PORT="${SNAPSHOT_PORT:-8046}"

is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

if [[ -f "$PID_FILE" ]]; then
  already_running=0
  while IFS=':' read -r _label pid; do
    [[ -n "$pid" ]] || continue
    if is_running "$pid"; then
      already_running=1
    fi
  done < "$PID_FILE"
  if [[ "$already_running" -eq 1 ]]; then
    echo "Dashboards appear to be already running. Stop first with ./dev_dashboards_stop.sh" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

mkdir -p "$LOG_DIR"

"$PYTHON_BIN" local/dashboard/server/uk_aq_dashboard_local.py --host "$HOST" --port "$SCHEDULER_PORT" >>"$SCHED_LOG" 2>&1 &
SCHED_PID=$!

"$PYTHON_BIN" local/station_snapshot/server/uk_aq_station_snapshot_local.py --host "$HOST" --port "$SNAPSHOT_PORT" >>"$SNAP_LOG" 2>&1 &
SNAP_PID=$!

cat > "$PID_FILE" <<EOF2
scheduler:$SCHED_PID
station_snapshot:$SNAP_PID
EOF2

cleanup() {
  local pid
  for pid in "$SCHED_PID" "$SNAP_PID"; do
    if is_running "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$SCHED_PID" 2>/dev/null || true
  wait "$SNAP_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
}

trap cleanup INT TERM EXIT

sleep 1

startup_failures=()
if ! is_running "$SCHED_PID"; then
  wait "$SCHED_PID" 2>/dev/null || true
  startup_failures+=("scheduler")
fi
if ! is_running "$SNAP_PID"; then
  wait "$SNAP_PID" 2>/dev/null || true
  startup_failures+=("station_snapshot")
fi
if (( ${#startup_failures[@]} > 0 )); then
  echo "Failed to start: ${startup_failures[*]}. Check logs: $SCHED_LOG, $SNAP_LOG" >&2
  exit 1
fi

echo "Scheduler dashboard: http://$HOST:$SCHEDULER_PORT"
echo "Station snapshot dashboard: http://$HOST:$SNAPSHOT_PORT"
echo "Python: $PYTHON_BIN"
echo "Logs: $SCHED_LOG, $SNAP_LOG"

exit_code=0
while true; do
  sched_running=0
  snap_running=0
  if is_running "$SCHED_PID"; then
    sched_running=1
  fi
  if is_running "$SNAP_PID"; then
    snap_running=1
  fi

  if [[ "$sched_running" -eq 1 && "$snap_running" -eq 1 ]]; then
    sleep 1
    continue
  fi

  if [[ "$sched_running" -eq 0 ]]; then
    if ! wait "$SCHED_PID" 2>/dev/null; then
      exit_code=$?
    fi
    echo "Scheduler dashboard exited. Check $SCHED_LOG" >&2
  fi

  if [[ "$snap_running" -eq 0 ]]; then
    if ! wait "$SNAP_PID" 2>/dev/null; then
      status=$?
      if [[ "$exit_code" -eq 0 ]]; then
        exit_code=$status
      fi
    fi
    echo "Station snapshot dashboard exited. Check $SNAP_LOG" >&2
  fi

  exit "$exit_code"
done
