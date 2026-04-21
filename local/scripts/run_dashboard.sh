#!/usr/bin/env bash
# Starts the UK AQ dashboard API server.
# Sources .env from this repo's root. Set PORT env var to override port (default: 8000).
# The live dashboard launchd plist sets PORT=8001.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python venv not found: $PYTHON_BIN" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export DASHBOARD_UPSTREAM_BEARER_TOKEN=""

exec "$PYTHON_BIN" local/dashboard/server/uk_aq_dashboard_api.py \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-8000}"
