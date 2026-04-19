#!/usr/bin/env bash
# Starts the live dashboard API server on port 8001.
# Loaded by launchd plist or run directly.
set -euo pipefail

ROOT_DIR="/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops"
cd "$ROOT_DIR"

PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"
ENV_FILE="$ROOT_DIR/.env.live"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python venv not found: $PYTHON_BIN" >&2
  exit 1
fi

# Source live env so vars take precedence over the .env that Python also loads.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Clear hosted bearer auth for local run.
export DASHBOARD_UPSTREAM_BEARER_TOKEN=""

exec "$PYTHON_BIN" local/dashboard/server/uk_aq_dashboard_api.py \
  --host 127.0.0.1 \
  --port 8001
