Runbook tracking note: build v2 core first, then seed local Dropbox v2 core

Date: 2026-06-14
Stage: CIC-Test R2 history v2 build
Repo: https://github.com/ChronicChannel-test/uk-aq-ops
Environment: CIC-Test

Preflight completed:

* npm run check passed.
* build_backup_inventory.mjs --show-version selected backup version v2.
* sync_history_to_dropbox.mjs --show-version selected backup version v2.
* Environment check showed CIC-Test bucket/root, not LIVE:
    * CFLARE_R2_BUCKET=uk-aq-history-cic-test
    * UK_AQ_DROPBOX_ROOT=CIC-Test
    * UKAQ_ENV_NAME=test

Configured v2 vars:

* UK_AQ_R2_HISTORY_WRITE_VERSION=v2
* UK_AQ_R2_HISTORY_READ_VERSION=v1
* UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX=history/v2/observations
* UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX=history/v2/aqilevels/hourly/data
* UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX=history/v2/aqilevels/hourly/debug
* UK_AQ_R2_HISTORY_CORE_PREFIX=history/v2/core
* UK_AQ_R2_HISTORY_V2_CORE_PREFIX=history/v2/core
* UK_AQ_R2_HISTORY_INDEX_V2_PREFIX=history/_index_v2
* UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX=history/_index_v2/observations_timeseries
* UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX=history/_index_v2/aqilevels_hourly_data_timeseries

Issue found:
The first dry-run for building v2 observations from Dropbox v1 failed because the local Dropbox backup did not yet contain history/v2/core.

Command that failed:

node scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs \
  --from-day 2026-04-03 \
  --to-day 2026-04-10 \
  --connector-id 1 \
  --connector-id 3 \
  --connector-id 6 \
  --connector-id 7 \
  --dry-run

Error:

{
  "ok": false,
  "error": "Core prefix not found in Dropbox root: /Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v2/core"
}

Conclusion:
The observations v2 builder reads core metadata from the local Dropbox R2 history backup. Therefore history/v2/core must exist locally before the observations v2 builder can run.

What was done:

1. Built v2 core first.
2. The v2 core build worked.
3. Because the v2 Dropbox backup has not yet run, seed the local Dropbox backup by copying existing local v1 core to local v2 core.

Commands used / to record:

mkdir -p tmp
UK_AQ_R2_HISTORY_CORE_PREFIX=history/v2/core \
node scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs \
  --report-out ./tmp/uk_aq_core_snapshot_to_r2_v2_report.json

Then seed local Dropbox v2 core from local Dropbox v1 core:

DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup"
mkdir -p "${DROPBOX_ROOT}/history/v2"
if [ -d "${DROPBOX_ROOT}/history/v2/core" ]; then
  STAMP="$(date -u +%F_%H%M%S)"
  mkdir -p "${DROPBOX_ROOT}/_archive/pre-v2-core-seed"
  mv "${DROPBOX_ROOT}/history/v2/core" \
     "${DROPBOX_ROOT}/_archive/pre-v2-core-seed/core_${STAMP}"
fi
cp -a \
  "${DROPBOX_ROOT}/history/v1/core" \
  "${DROPBOX_ROOT}/history/v2/core"

Verification:

DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup"
find "${DROPBOX_ROOT}/history/v2/core" -maxdepth 3 -type f | head -20
du -sh "${DROPBOX_ROOT}/history/v1/core" "${DROPBOX_ROOT}/history/v2/core"

Runbook change needed:
Move the “Build core v2” section above “Build historical v2 observations”.

Also add a note after “Build core v2”:

The observations v2 builder reads core metadata from the local Dropbox R2 history backup. If the v2 Dropbox backup has not yet run, seed local Dropbox history/v2/core before building observations. For CIC-Test this can be done by copying local history/v1/core to local history/v2/core, because the core metadata contract is being used as lookup/reference input for the v2 observations build.

Revised runbook order:

1. Preflight checks
2. Build core v2 to R2
3. Ensure local Dropbox backup contains history/v2/core
4. Build historical v2 observations
5. Build historical v2 AQI hourly data/debug
6. Build _index_v2
7. Build/refresh backup inventory
8. Sync v2 to Dropbox
9. Validate schemas, manifests, indexes and API/website behaviour

Next action:
Retry the observations v2 dry-run after confirming local Dropbox has history/v2/core.