#!/usr/bin/env bash
set -euo pipefail

# Rebuild TEST AQI levels from the local R2 Dropbox backup.
# Source: local Dropbox R2 history backup observations.
# Output: AQI levels only, written back through the normal backfill script.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "$REPO_ROOT"

# ---- Hard-coded TEST safety settings ----

export CFLARE_R2_BUCKET="${CFLARE_R2_BUCKET:-uk-aq-history-cic-test}"

export UK_AQ_BACKFILL_RUN_MODE="r2_history_obs_to_aqilevels"
export UK_AQ_BACKFILL_OUTPUT_SCOPE="aqilevels_only"
export UK_AQ_BACKFILL_FORCE_REPLACE="true"
export UK_AQ_BACKFILL_DRY_RUN="false"

export UK_AQ_BACKFILL_FROM_DAY_UTC="2025-01-01"
export UK_AQ_BACKFILL_TO_DAY_UTC="2026-06-08"

# Leave blank to rebuild all connectors.
# Set this only if you want to restrict the rebuild, for example:
# export UK_AQ_BACKFILL_CONNECTOR_IDS="1"
unset UK_AQ_BACKFILL_CONNECTOR_IDS || true

# Local source observations from Dropbox backup.
export UK_AQ_R2_HISTORY_DROPBOX_ROOT="${UK_AQ_R2_HISTORY_DROPBOX_ROOT:-/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup}"

# Usually false during AQI parquet rebuild unless you know the current script
# also safely rebuilds the new AQI indexes.
export UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX="${UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX:-false}"

# ---- Safety checks ----

if [[ "$CFLARE_R2_BUCKET" != "uk-aq-history-cic-test" ]]; then
  echo "REFUSING: CFLARE_R2_BUCKET must be uk-aq-history-cic-test, got: $CFLARE_R2_BUCKET" >&2
  exit 1
fi

if [[ "$UK_AQ_R2_HISTORY_DROPBOX_ROOT" != *"CIC-Test/R2_history_backup"* ]]; then
  echo "REFUSING: Dropbox root does not look like CIC-Test/R2_history_backup:" >&2
  echo "  $UK_AQ_R2_HISTORY_DROPBOX_ROOT" >&2
  exit 1
fi

if [[ ! -d "$UK_AQ_R2_HISTORY_DROPBOX_ROOT/history/v1/observations" ]]; then
  echo "REFUSING: observations history folder not found:" >&2
  echo "  $UK_AQ_R2_HISTORY_DROPBOX_ROOT/history/v1/observations" >&2
  exit 1
fi

if [[ ! -x "./scripts/uk_aq_backfill_local.sh" ]]; then
  echo "REFUSING: ./scripts/uk_aq_backfill_local.sh not found or not executable" >&2
  exit 1
fi

echo "About to rebuild TEST AQI levels from local R2 Dropbox backup"
echo
echo "Source Dropbox root: $UK_AQ_R2_HISTORY_DROPBOX_ROOT"
echo "Source observations: $UK_AQ_R2_HISTORY_DROPBOX_ROOT/history/v1/observations"
echo "Output bucket:       $CFLARE_R2_BUCKET"
echo "Run mode:            $UK_AQ_BACKFILL_RUN_MODE"
echo "Output scope:        $UK_AQ_BACKFILL_OUTPUT_SCOPE"
echo "Force replace:       $UK_AQ_BACKFILL_FORCE_REPLACE"
echo "Dry run:             $UK_AQ_BACKFILL_DRY_RUN"
echo "From day UTC:        $UK_AQ_BACKFILL_FROM_DAY_UTC"
echo "To day UTC:          $UK_AQ_BACKFILL_TO_DAY_UTC"
echo

echo "Type exactly REBUILD TEST AQI to continue:"
read -r CONFIRM

if [[ "$CONFIRM" != "REBUILD TEST AQI" ]]; then
  echo "Confirmation did not match. Nothing run."
  exit 1
fi

echo
echo "Starting AQI rebuild..."
echo

./scripts/uk_aq_backfill_local.sh