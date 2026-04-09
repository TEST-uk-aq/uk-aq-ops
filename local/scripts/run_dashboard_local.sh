#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -x "$ROOT_DIR/.venv/bin/python3" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  echo "python3 is required." >&2
  exit 1
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8045}"
HTML_PATH="${UKAQ_DASHBOARD_HTML:-dashboard/index.html}"

# Local run should not enforce hosted bearer auth unless explicitly requested.
if [[ "${DASHBOARD_LOCAL_ENFORCE_BEARER_AUTH:-false}" != "true" ]]; then
  export DASHBOARD_UPSTREAM_BEARER_TOKEN=""
fi

exec "$PYTHON_BIN" local/dashboard/server/uk_aq_dashboard_api.py \
  --host "$HOST" \
  --port "$PORT" \
  --html "$HTML_PATH"
