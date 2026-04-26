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

generate_dashboard_config() {
  "$PYTHON_BIN" - <<'PY'
import json
import os
from pathlib import Path

try:
    refresh_seconds = int(str(os.getenv("UKAQ_DEFAULT_REFRESH_SECONDS", "300")).strip())
except ValueError:
    refresh_seconds = 300
if refresh_seconds <= 0:
    refresh_seconds = 300

config = {
    "envName": str(os.getenv("UKAQ_ENV_NAME", "local")),
    "apiBaseUrl": str(os.getenv("UKAQ_API_BASE_URL", "/api")),
    "dashboardTitle": str(os.getenv("UKAQ_DASHBOARD_TITLE", "UK AQ Dashboard")),
    "dashboardSubtitle": str(
        os.getenv(
            "UKAQ_DASHBOARD_SUBTITLE",
            "Live snapshot of PM2.5, PM10, and NO2 freshness using timeseries last_value_at. Data updates from your local API.",
        )
    ),
    "defaultRefreshSeconds": refresh_seconds,
}

out_path = Path(str(os.getenv("UKAQ_CONFIG_OUT_PATH", "dashboard/assets/config.js")))
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(
    "window.UKAQ_OPS_CONFIG = " + json.dumps(config, indent=2) + ";\n",
    encoding="utf-8",
)
print(f"Wrote dashboard config: {out_path.resolve()}")
PY
}

generate_dashboard_config

export DASHBOARD_UPSTREAM_BEARER_TOKEN=""

exec "$PYTHON_BIN" local/dashboard/server/uk_aq_dashboard_api.py \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-8000}"
