#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_FILE="${UKAQ_GCP_LOG_ARCHIVE_CONFIG:-$HOME/.config/uk-aq/gcp-logging-archive-test.json}"
PYTHON_BIN="${UKAQ_GCP_LOG_ARCHIVE_PYTHON:-$ROOT_DIR/.venv-gcp-logging/bin/python3}"
[[ -r "$CONFIG_FILE" ]] || { echo "Missing collector config: $CONFIG_FILE" >&2; exit 1; }
[[ -x "$PYTHON_BIN" ]] || { echo "Missing collector Python: $PYTHON_BIN" >&2; exit 1; }
exec "$PYTHON_BIN" "$ROOT_DIR/local/gcp_logging_archive/collector.py" --config "$CONFIG_FILE" "${@:-incremental}"
