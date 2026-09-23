#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --env-file PATH --runtime-root PATH [incremental|range|backfill] [collector options...]" >&2
  exit 64
}

ENV_FILE=""
RUNTIME_BASE=""
while (($#)); do
  case "$1" in
    --env-file)
      (($# >= 2)) || usage
      ENV_FILE=$2
      shift 2
      ;;
    --runtime-root)
      (($# >= 2)) || usage
      RUNTIME_BASE=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done
[[ -n "$ENV_FILE" && -n "$RUNTIME_BASE" ]] || usage
[[ -r "$ENV_FILE" ]] || { echo "Missing or unreadable ingest environment file: $ENV_FILE" >&2; exit 78; }

# Read only the authority key. Do not source the ingest file or expose its other values.
ENV_LINES=()
while IFS= read -r line; do
  ENV_LINES+=("$line")
done < <(sed -n -E '/^[[:space:]]*(export[[:space:]]+)?UK_AQ_ENV_NAME[[:space:]]*=/p' "$ENV_FILE")
((${#ENV_LINES[@]} == 1)) || {
  echo "UK_AQ_ENV_NAME must occur exactly once in $ENV_FILE" >&2
  exit 78
}
ENV_NAME=$(printf '%s\n' "${ENV_LINES[0]}" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?UK_AQ_ENV_NAME[[:space:]]*=[[:space:]]*//; s/[[:space:]]+$//')
if [[ "$ENV_NAME" =~ ^\"(.*)\"$ ]]; then ENV_NAME=${BASH_REMATCH[1]}; fi
if [[ "$ENV_NAME" =~ ^\'(.*)\'$ ]]; then ENV_NAME=${BASH_REMATCH[1]}; fi
[[ "$ENV_NAME" == TEST || "$ENV_NAME" == LIVE ]] || {
  echo "UK_AQ_ENV_NAME must be exactly TEST or LIVE in $ENV_FILE" >&2
  exit 78
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_BASE="$(cd "$(dirname "$RUNTIME_BASE")" 2>/dev/null && pwd)/$(basename "$RUNTIME_BASE")"
ENV_RUNTIME="$RUNTIME_BASE/$ENV_NAME"
CONFIG_FILE="$ENV_RUNTIME/config.json"
CREDENTIAL_FILE="$ENV_RUNTIME/credentials/google-application-credentials.json"
PYTHON_BIN="${UKAQ_GCP_LOG_ARCHIVE_PYTHON:-$ROOT_DIR/.venv-gcp-logging/bin/python3}"

[[ -r "$CONFIG_FILE" ]] || { echo "Missing collector config: $CONFIG_FILE" >&2; exit 78; }
[[ -r "$CREDENTIAL_FILE" ]] || { echo "Missing environment-specific Google credentials: $CREDENTIAL_FILE" >&2; exit 78; }
[[ -x "$PYTHON_BIN" ]] || { echo "Missing collector Python: $PYTHON_BIN" >&2; exit 78; }

export UK_AQ_ENV_NAME="$ENV_NAME"
export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIAL_FILE"
exec "$PYTHON_BIN" "$ROOT_DIR/local/gcp_logging_archive/collector.py" \
  --config "$CONFIG_FILE" --runtime-root "$ENV_RUNTIME" "${@:-incremental}"
