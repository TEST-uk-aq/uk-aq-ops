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





Docs/runbook update note: only one v2 core snapshot is required

Update the v2 R2 history docs and runbooks to say that the v2 observations builder should use the latest available v2 core snapshot, not a date-matched core snapshot.

Only one current v2 core snapshot is required under:

history/v2/core/day_utc=YYYY-MM-DD/

Reason:
The v2 observations builder only needs core as reference metadata for mapping timeseries IDs to station IDs, connector IDs and pollutant codes. It does not need a separate historical core snapshot for every observation day.

The runbook should not imply that history/v2/core must exist for every historical day being rebuilt. Build one current v2 core snapshot, then use that latest snapshot for v2 observation rebuilding.

Also note that the observations builder was updated to use the newest available core snapshot rather than filtering core snapshots to day_utc <= --to-day.




## v2 observations build: partial R2 write after fetch failed

The full v2 observations write command returned:

{
  "ok": false,
  "error": "fetch failed"
}

However, Cloudflare R2 shows v2 observation day folders under:

history/v2/observations/

Conclusion:
The script partly wrote v2 observations to R2 before failing. Treat the build as incomplete until manifests and reports are verified.

Action:
Rerun the same observations build without `--replace`, with `--report-out`. Existing pollutant manifests should be skipped, and missing objects/manifests should be filled where possible.

If the retry fails again, split the build into monthly chunks to reduce the impact of network/R2 fetch failures.

Runbook update:
For large v2 observations builds, prefer chunked date ranges, for example monthly, and always use `--report-out`. If a large run ends with `fetch failed`, do not assume failure means no data was written. Check R2 for partial output, then rerun without `--replace` or retry the affected date range.



Runbook update note: move v2 observations inventory after v1-to-v2 observations build

The v2 observations backup inventory must be built after the v1-to-v2 observations build has completed.

Move the observations-only inventory step so it comes immediately after:

Build historical v2 observations

and before:

Sync v2 observations to Dropbox

Reason:
The inventory builder reads the committed v2 observation manifests and object metadata from R2. If it runs before the v1-to-v2 observations build, the inventory will be missing the newly created v2 observation files or will represent an incomplete state.

Updated order:

1. Build core v2
2. Build historical v2 observations from v1 observations
3. Build v2 observations inventory
4. Sync v2 observations to Dropbox
5. Validate local v2 observations files
6. Build historical v2 AQI hourly data/debug from local v2 observations
7. Build v2 AQI inventory/sync later
8. Build _index_v2 after the v2 data needed by the index exists

For observations only, use:

UK_AQ_R2_HISTORY_WRITE_VERSION=v2 \
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --backup-version v2 \
  --domain observations \
  --index-v2-prefix history/_index_v2 \
  --full-rebuild \
  --report-out tmp/r2_backup_inventory_v2_observations_report.json
  
  
  
  
  ## V2 observations inventory completed

  The observations-only v2 backup inventory completed successfully.

  Important result:
  - Inventory path: history/_index_v2/backup_inventory_v2.json
  - Domain: observations only
  - Observation days: 525
  - Committed connector units: 2,080
  - Observation objects: 4,217
  - Observation bytes: 947,517,190
  - Metadata warnings: 0
  - Backup warnings: 0
  - Missing domain prefixes: 0

  The report shows index files missing, but that is expected at this stage because _index_v2 has not been built yet. This inventory is being used now only to sync v2 observations to Dropbox so the AQI levels rebuild can use local v2 observations.

  Next step:
  Run observations-only v2 Dropbox sync.  
  
  
  
  
  Checked and fixed the two v2 scripts.

  Files changed:
  - `scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs`
  - `scripts/R2_v2_implementation/rebuild_aqilevels_v2_from_r2_dropbox_local_TEST.sh`

  What I fixed:
  - The shell wrapper was calling a non-existent script path. It now calls `scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs`.
  - The v2 builder was writing the old wide AQI schema to both `data` and `debug`. It now reuses the existing worker v2 parquet helpers:
    - `data`: compact v2 AQI columns
    - `debug`: richer v2 AQI debug columns
  - The builder was hand-rolling manifests without the full v2 manifest shape. It now uses the existing v2 manifest builders for pollutant, connector, and day manifests.
  - The local report now includes pollutant manifest paths as well as connector manifests and parquet files.

  Checks run:
  - `node --check scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs`
  - `bash -n scripts/R2_v2_implementation/rebuild_aqilevels_v2_from_r2_dropbox_local_TEST.sh`
  - `npm run check`
  - Wrapper `--help`
  - Local-only smoke run for `2026-04-10`, connector `1`, writing only to `/tmp/uk-aq-aqi-v2-smoke`

  Smoke result:
  - No R2 upload.
  - Wrote v2 data/debug local outputs.
  - Data schema is compact v2 columns.
  - Debug schema is richer v2 debug columns.
  - Manifests now show `history_version: v2`, `domain: aqilevels`, and correct `profile: data/debug`.

  Note: these two scripts are currently untracked in git, so `git diff` does not show a normal patch for them.