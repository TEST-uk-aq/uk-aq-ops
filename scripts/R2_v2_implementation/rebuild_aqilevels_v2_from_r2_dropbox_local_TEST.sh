#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

export CFLARE_R2_BUCKET="${CFLARE_R2_BUCKET:-uk-aq-history-cic-test}"
export UK_AQ_R2_HISTORY_VERSION="v2"
export UK_AQ_LOCAL_AQI_V2_SOURCE_ROOT="${UK_AQ_LOCAL_AQI_V2_SOURCE_ROOT:-/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup}"
export UK_AQ_LOCAL_AQI_V2_WORK_ROOT="${UK_AQ_LOCAL_AQI_V2_WORK_ROOT:-$HOME/uk-aq-work/aqilevels-v2-rebuild}"
export UK_AQ_LOCAL_AQI_V2_R2_TARGET="${UK_AQ_LOCAL_AQI_V2_R2_TARGET:-uk_aq_r2:${CFLARE_R2_BUCKET}}"

node scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs "$@"
