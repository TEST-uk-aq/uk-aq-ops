# UK AQ R2 History v2 CIC-Test Build and Validation Runbook

Status: draft runbook  
Target environment: CIC-Test only  
Created: 2026-06-14  
Purpose: build and validate R2 history v2 alongside v1 before switching CIC-Test readers or scheduled writes.

## Scope and guardrails

This runbook is for CIC-Test. Do not run these commands against LIVE buckets,
LIVE GitHub variables, or LIVE Dropbox paths.

R2 history v2 is additive. Keep v1 available for rollback until v2 has passed
chart tests, API tests, soak checks, and an explicit delete decision.

Do not switch scheduled prune-daily writes to v2 until the v2 read path has
passed CIC-Test validation.

## Execution options

Option A: build all v2 history locally/manual from this repo.

Pros:
- Most direct control over date windows and connector filters.
- Good for targeted rebuilds and retrying failed day ranges.
- Supabase egress impact is limited to source rows fetched by the backfill runs.
- Database-size impact is none for the build itself; output is written to R2.

Cons:
- Long historical ranges can run for a long time on the local machine.
- Requires local secrets, R2 credentials, Deno, Node, and enough network stability.
- More manual checkpointing.

Option B: use GitHub workflows where available for core snapshots, inventory,
Dropbox sync, Worker deploys, and scheduled services.

Pros:
- Repeatable environment with artifact reports.
- Better audit trail for deploy/sync steps.
- Supabase egress impact is similar for equivalent build operations.
- Database-size impact is none for R2-only build/backup steps.

Cons:
- Historical v2 data backfill still needs careful windowing.
- First inventory builds can take 1-2 hours.
- GitHub variables must be checked before dispatching.

Recommended path: use Option A for the historical observations and AQI v2
builds because it gives tight control over date windows, then use workflows or
the same scripts for core snapshot, index, inventory, Dropbox sync, and Worker
deploys. This keeps Supabase egress bounded by explicit backfill ranges and
keeps database size unchanged while R2 storage grows by the v2 copy.

## Required tools

- `node` 20+
- `npm install` completed in this repo
- `deno` available for `scripts/uk_aq_backfill_local.sh`
- `rclone` configured for R2 and Dropbox when running local inventory/sync
- `duckdb` available for parquet validation
- `curl` and `jq` available for API checks

## Required env vars

Load the CIC-Test `.env` for this repo before running local commands.

Required R2/Supabase basics:

```bash
set -a
source .env
set +a

export UK_AQ_R2_HISTORY_WRITE_VERSION=v2
export UK_AQ_R2_HISTORY_READ_VERSION=v1
export UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX=history/v2/observations
export UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX=history/v2/aqilevels/hourly/data
export UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX=history/v2/aqilevels/hourly/debug
export UK_AQ_R2_HISTORY_CORE_PREFIX=history/v2/core
export UK_AQ_R2_HISTORY_V2_CORE_PREFIX=history/v2/core
export UK_AQ_R2_HISTORY_INDEX_V2_PREFIX=history/_index_v2
export UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX=history/_index_v2/observations_timeseries
export UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX=history/_index_v2/aqilevels_hourly_data_timeseries
```

Keep CIC-Test v1 prefixes available for comparison and rollback:

```bash
export UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX=history/v1/observations
export UK_AQ_R2_HISTORY_AQILEVELS_PREFIX=history/v1/aqilevels/hourly
export UK_AQ_R2_HISTORY_INDEX_PREFIX=history/_index
```

Environment-name note:

- `UKAQ_ENV_NAME` is the existing site/dashboard environment label in this
  repo. In CIC-Test it is usually `test`.
- `UK_AQ_DEPLOY_ENV` is the R2 writer/index bucket selector used by the
  backfill, prune-daily, and index-builder code. It chooses
  `R2_BUCKET_DEV`, `R2_BUCKET_STAGE`, or `R2_BUCKET_PROD`.
- For this CIC-Test runbook, derive `UK_AQ_DEPLOY_ENV=dev` from
  `UKAQ_ENV_NAME=test` rather than maintaining a second human-facing name.

```bash
case "${UKAQ_ENV_NAME:-test}" in
  test|CIC-Test|cic-test)
    export UK_AQ_DEPLOY_ENV=dev
    export UK_AQ_ENV_NAME=CIC-Test
    ;;
  *)
    echo "Refusing CIC-Test runbook with UKAQ_ENV_NAME=${UKAQ_ENV_NAME:-unset}" >&2
    exit 1
    ;;
esac
```

If the local backfill needs source adapters, confirm the adapter credentials and
source flags already present in `.env` before starting a large run.

## Preflight checks

Confirm the repo is the CIC-Test ops repo:

```bash
pwd
git status --short
```

Confirm syntax and tests before build:

```bash
npm run check
node --test tests/*.test.mjs
```

Confirm v2 backup selectors resolve to v2 paths:

```bash
UK_AQ_R2_HISTORY_WRITE_VERSION=v2 \
node scripts/backup_r2/build_backup_inventory.mjs --show-version

UK_AQ_R2_HISTORY_WRITE_VERSION=v2 \
node scripts/backup_r2/sync_history_to_dropbox.mjs --show-version
```

Confirm no LIVE values are loaded:

```bash
env | grep -E 'LIVE|PROD|R2_BUCKET|CFLARE_R2_BUCKET|UK_AQ_DROPBOX_ROOT|UKAQ_ENV_NAME|UK_AQ_ENV_NAME|UK_AQ_DEPLOY_ENV' | sort
```

Expected CIC-Test bucket/root values must point at CIC-Test, not LIVE.

## Build historical v2 observations

Use `source_to_r2` with `observations_only` first. Start with a small target
window and known test connector before a full range.

Small smoke window:

```bash
export UK_AQ_R2_HISTORY_WRITE_VERSION=v2
export UK_AQ_BACKFILL_RUN_MODE=source_to_r2
export UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only
export UK_AQ_BACKFILL_DRY_RUN=false
export UK_AQ_BACKFILL_FORCE_REPLACE=false
export UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX=false
export UK_AQ_BACKFILL_FROM_DAY_UTC=2026-04-03
export UK_AQ_BACKFILL_TO_DAY_UTC=2026-04-10
export UK_AQ_BACKFILL_CONNECTOR_IDS=1,3,7

./scripts/uk_aq_backfill_local.sh
```

Full historical build template:

```bash
export UK_AQ_R2_HISTORY_WRITE_VERSION=v2
export UK_AQ_BACKFILL_RUN_MODE=source_to_r2
export UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only
export UK_AQ_BACKFILL_DRY_RUN=false
export UK_AQ_BACKFILL_FORCE_REPLACE=false
export UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX=false
export UK_AQ_BACKFILL_FROM_DAY_UTC=YYYY-MM-DD
export UK_AQ_BACKFILL_TO_DAY_UTC=YYYY-MM-DD
unset UK_AQ_BACKFILL_CONNECTOR_IDS

./scripts/uk_aq_backfill_local.sh
```

Expected R2 objects:

```text
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
```

## Build historical v2 AQI hourly data/debug

Use committed R2 observations as the source and write AQI v2 data/debug.

Small smoke window:

```bash
export UK_AQ_R2_HISTORY_WRITE_VERSION=v2
export UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels
export UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only
export UK_AQ_BACKFILL_DRY_RUN=false
export UK_AQ_BACKFILL_FORCE_REPLACE=false
export UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX=false
export UK_AQ_BACKFILL_FROM_DAY_UTC=2026-04-03
export UK_AQ_BACKFILL_TO_DAY_UTC=2026-04-10
export UK_AQ_BACKFILL_CONNECTOR_IDS=1,3,7

./scripts/uk_aq_backfill_local.sh
```

Full historical build template:

```bash
export UK_AQ_R2_HISTORY_WRITE_VERSION=v2
export UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels
export UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only
export UK_AQ_BACKFILL_DRY_RUN=false
export UK_AQ_BACKFILL_FORCE_REPLACE=false
export UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX=false
export UK_AQ_BACKFILL_FROM_DAY_UTC=YYYY-MM-DD
export UK_AQ_BACKFILL_TO_DAY_UTC=YYYY-MM-DD
unset UK_AQ_BACKFILL_CONNECTOR_IDS

./scripts/uk_aq_backfill_local.sh
```

Expected R2 objects:

```text
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
```

## Build core v2

Core is built with the existing core snapshot writer. The only v2-specific
change is the target prefix.

```bash
mkdir -p tmp

UK_AQ_R2_HISTORY_CORE_PREFIX=history/v2/core \
node scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs \
  --report-out ./tmp/uk_aq_core_snapshot_to_r2_v2_report.json
```

Optional dry-run:

```bash
UK_AQ_R2_HISTORY_CORE_PREFIX=history/v2/core \
node scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs \
  --dry-run \
  --report-out ./tmp/uk_aq_core_snapshot_to_r2_v2_dry_run_report.json
```

Expected R2 objects:

```text
history/v2/core/day_utc=YYYY-MM-DD/manifest.json
history/v2/core/day_utc=YYYY-MM-DD/checksums.sha256
history/v2/core/day_utc=YYYY-MM-DD/table=<table>/rows.ndjson.gz
```

## Build `_index_v2`

Build both observations and AQI v2 timeseries indexes after v2 data exists.

```bash
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \
  --history-version v2 \
  --domain both
```

Targeted rebuild template for a narrow retry:

```bash
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \
  --history-version v2 \
  --targeted \
  --from-day YYYY-MM-DD \
  --to-day YYYY-MM-DD \
  --connector-id CONNECTOR_ID \
  --kind both
```

Expected index objects:

```text
history/_index_v2/observations_timeseries_latest.json
history/_index_v2/aqilevels_hourly_data_timeseries_latest.json
history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
```

## Build or refresh backup inventory

The v2 inventory path should default to:

```text
history/_index_v2/backup_inventory_v2.json
```

Local build:

```bash
mkdir -p tmp

UK_AQ_R2_HISTORY_WRITE_VERSION=v2 \
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --backup-version v2 \
  --index-v2-prefix history/_index_v2 \
  --report-out tmp/r2_backup_inventory_v2_report.json
```

First full rebuild, if needed:

```bash
UK_AQ_R2_HISTORY_WRITE_VERSION=v2 \
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --backup-version v2 \
  --index-v2-prefix history/_index_v2 \
  --full-rebuild \
  --report-out tmp/r2_backup_inventory_v2_full_report.json
```

GitHub workflow alternative:

```text
Run "UK AQ R2 Initial Build Inventory" with CIC-Test variables and
UK_AQ_R2_HISTORY_WRITE_VERSION=v2.
```

## Sync v2 to Dropbox

The v2 Dropbox checkpoint path should default to:

```text
_ops/checkpoints/r2_history_backup_state_v2.json
```

Dry-run first:

```bash
UK_AQ_R2_HISTORY_WRITE_VERSION=v2 \
node scripts/backup_r2/sync_history_to_dropbox.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --dest-root "uk_aq_dropbox:${UK_AQ_DROPBOX_ROOT%/}/R2_history_backup" \
  --backup-version v2 \
  --dry-run \
  --report-out tmp/r2_history_dropbox_backup_v2_dry_run_report.json
```

Real sync:

```bash
UK_AQ_R2_HISTORY_WRITE_VERSION=v2 \
node scripts/backup_r2/sync_history_to_dropbox.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --dest-root "uk_aq_dropbox:${UK_AQ_DROPBOX_ROOT%/}/R2_history_backup" \
  --backup-version v2 \
  --report-out tmp/r2_history_dropbox_backup_v2_report.json
```

GitHub workflow alternative:

```text
Run "UK AQ R2 History Dropbox Backup" with CIC-Test variables,
UK_AQ_R2_HISTORY_WRITE_VERSION=v2, and dry_run=true first.
```

## Validate parquet schemas with DuckDB

Copy a small set of v2 parquet files locally, then inspect schemas.

```bash
mkdir -p tmp/r2_v2_samples

rclone copy \
  "uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/aqilevels/hourly/data/day_utc=2026-04-03/connector_id=1/pollutant_code=pm25" \
  tmp/r2_v2_samples/aqi_data_pm25

rclone copy \
  "uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/aqilevels/hourly/debug/day_utc=2026-04-03/connector_id=1/pollutant_code=pm25" \
  tmp/r2_v2_samples/aqi_debug_pm25

rclone copy \
  "uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/observations/day_utc=2026-04-03/connector_id=1/pollutant_code=pm25" \
  tmp/r2_v2_samples/observations_pm25
```

Schema checks:

```bash
duckdb -c "DESCRIBE SELECT * FROM read_parquet('tmp/r2_v2_samples/aqi_data_pm25/*.parquet');"
duckdb -c "DESCRIBE SELECT * FROM read_parquet('tmp/r2_v2_samples/aqi_debug_pm25/*.parquet');"
duckdb -c "DESCRIBE SELECT * FROM read_parquet('tmp/r2_v2_samples/observations_pm25/*.parquet');"
```

Minimum AQI data columns:

```bash
duckdb -c "
SELECT count(*) AS rows,
       count_if(pollutant_code = 'pm25') AS pm25_rows,
       min(timestamp_hour_utc) AS min_hour,
       max(timestamp_hour_utc) AS max_hour
FROM read_parquet('tmp/r2_v2_samples/aqi_data_pm25/*.parquet');
"
```

Minimum observations columns:

```bash
duckdb -c "
SELECT count(*) AS rows,
       count_if(pollutant_code = 'pm25') AS pm25_rows,
       min(observed_at_utc) AS min_observed_at_utc,
       max(observed_at_utc) AS max_observed_at_utc
FROM read_parquet('tmp/r2_v2_samples/observations_pm25/*.parquet');
"
```

Pass criteria:

- AQI data contains `connector_id`, `station_id`, `timeseries_id`,
  `pollutant_code`, `timestamp_hour_utc`, `daqi_index_level`,
  `eaqi_index_level`, DAQI/EAQI status and missing-reason fields.
- AQI debug contains diagnostic calculation fields and excludes old wide
  compatibility fields unless deliberately retained.
- Observations contains `connector_id`, `station_id`, `timeseries_id`,
  `pollutant_code`, `observed_at_utc`, `value`.
- All sampled rows in a pollutant-partitioned file have the matching
  `pollutant_code`.

## Validate manifests

Fetch representative manifests:

```bash
rclone cat "uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/aqilevels/hourly/data/day_utc=2026-04-03/connector_id=1/pollutant_code=pm25/manifest.json" | jq .
rclone cat "uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/aqilevels/hourly/debug/day_utc=2026-04-03/connector_id=1/pollutant_code=pm25/manifest.json" | jq .
rclone cat "uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/observations/day_utc=2026-04-03/connector_id=1/pollutant_code=pm25/manifest.json" | jq .
```

Pass criteria:

- `history_schema_version` is `2`.
- Manifests include the expected day, connector, pollutant, columns, file list,
  row counts, byte counts, and manifest hash fields.
- Day and connector manifests exist above pollutant-level manifests.
- No v2 object is written under a v1 prefix.

## Validate indexes

Check latest index files:

```bash
rclone cat "uk_aq_r2:${CFLARE_R2_BUCKET}/history/_index_v2/observations_timeseries_latest.json" | jq .
rclone cat "uk_aq_r2:${CFLARE_R2_BUCKET}/history/_index_v2/aqilevels_hourly_data_timeseries_latest.json" | jq .
```

Check known pollutant index units:

```bash
rclone cat "uk_aq_r2:${CFLARE_R2_BUCKET}/history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-04-03/connector_id=1/pollutant_code=pm25/manifest.json" | jq .
rclone cat "uk_aq_r2:${CFLARE_R2_BUCKET}/history/_index_v2/observations_timeseries/day_utc=2026-04-03/connector_id=1/pollutant_code=pm25/manifest.json" | jq .
```

Pass criteria:

- Index manifests are under `history/_index_v2`.
- AQI latest file names use `aqilevels_hourly_data`.
- Index unit manifests include pollutant partition metadata.
- Known test timeseries appear in the expected day/connector/pollutant index
  unit.

## Compare v1 and v2 for selected timeseries

Known test cases:

| timeseries_id | station_id | pollutant |
|---:|---:|---|
| 354 | 1575 | pm25 |
| 327 | 661 | pm25 |
| 396 | 7609 | pm25 |

Known failing windows to retest:

- `2026-04-10` -> `2026-04-17`
- `2026-04-17` -> `2026-04-24`
- `2026-04-24` -> `2026-05-01`
- `2026-05-01` -> `2026-05-08`

Before switching Worker read mode, compare R2 object contents directly with
DuckDB samples, or deploy a temporary branch Worker only in CIC-Test if needed.
After switching read mode, use the API checks below.

AQI API template:

```bash
AQI_API_BASE="https://uk-aq-aqi-history-r2-api.cic-test.workers.dev/v1/aqi-history"

curl -fsS "${AQI_API_BASE}?scope=timeseries&grain=hourly&timeseries_id=396&entity=396&pollutant=pm25&row_limit=20000&from_utc=2026-04-10T00:00:00.000Z&to_utc=2026-04-17T00:00:00.000Z" \
  | tee tmp/aqi_v2_396_2026-04-10_2026-04-17.json \
  | jq '{read_version:.read_version, coverage:.coverage, response_complete:.response_complete, partial_reasons:.partial_reasons, row_count:.row_count, data_count:(.data|length)}'
```

Observation API template:

```bash
OBS_API_BASE="https://uk-aq-observs-history-r2-api.cic-test.workers.dev/v1/observations"
CONNECTOR_ID_FOR_396="<connector_id from core/index for timeseries 396>"

curl -fsS "${OBS_API_BASE}?timeseries_id=396&connector_id=${CONNECTOR_ID_FOR_396}&pollutant=pm25&row_limit=20000&from_utc=2026-04-10T00:00:00.000Z&to_utc=2026-04-17T00:00:00.000Z" \
  | tee tmp/observations_v2_396_2026-04-10_2026-04-17.json \
  | jq '{read_version:.read_version, coverage:.coverage, response_complete:.response_complete, partial_reasons:.partial_reasons, row_count:.row_count, data_count:(.data|length)}'
```

Pass criteria:

- No Cloudflare HTML error page.
- No 1102.
- HTTP status is 200 for complete or structured partial responses.
- JSON includes useful coverage metadata.
- `read_version` or coverage metadata reports v2 after the Worker switch.
- `response_complete=false` cases include `partial_reasons`.
- Core fields are present in AQI rows: `period_start_utc` or equivalent hour
  timestamp, `connector_id`, `station_id`, `timeseries_id`, `pollutant_code`,
  `daqi_index_level`, `eaqi_index_level`.

## Enable Worker v2 read mode in CIC-Test

Deploy Worker code that supports v1/v2, then set CIC-Test variables only:

```text
UK_AQ_R2_HISTORY_READ_VERSION=v2
UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX=history/v2/observations
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX=history/v2/aqilevels/hourly/data
UK_AQ_R2_HISTORY_INDEX_V2_PREFIX=history/_index_v2
UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX=history/_index_v2/observations_timeseries
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX=history/_index_v2/aqilevels_hourly_data_timeseries
```

Keep v1 prefix values unchanged for rollback:

```text
UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX=history/v1/observations
UK_AQ_R2_HISTORY_AQILEVELS_PREFIX=history/v1/aqilevels/hourly
```

Deploy:

```bash
# GitHub workflow path is preferred for CIC-Test deploys.
# If deploying manually, use the existing Worker deploy workflow commands and
# do not point at LIVE account/bucket values.
```

## Test website chart ranges

Open the CIC-Test website with debug logging enabled and test:

- 24h
- 7d
- 31d
- 90d

Expected debug evidence:

- AQI band chunks have `history.read_version` or `coverage.read_version` equal
  to `v2`.
- Observation chunks have v2 coverage metadata after the observations Worker
  read switch.
- Debug logs include R2 object read counts, parquet byte counts, matched rows,
  `response_complete`, and `partial_reasons` where available.
- 90-day chart does not produce Cloudflare 1102/503 HTML responses.

Retest the known failing AQI windows for `timeseries_id=396`,
`station_id=7609`, `pollutant=pm25`:

```bash
for from_to in \
  "2026-04-10T00:00:00.000Z 2026-04-17T00:00:00.000Z" \
  "2026-04-17T00:00:00.000Z 2026-04-24T00:00:00.000Z" \
  "2026-04-24T00:00:00.000Z 2026-05-01T00:00:00.000Z" \
  "2026-05-01T00:00:00.000Z 2026-05-08T00:00:00.000Z"
do
  set -- ${from_to}
  curl -fsS "${AQI_API_BASE}?scope=timeseries&grain=hourly&timeseries_id=396&entity=396&pollutant=pm25&row_limit=20000&from_utc=${1}&to_utc=${2}" \
    | jq '{read_version:.read_version, status:.status, response_complete:.response_complete, partial_reasons:.partial_reasons, row_count:.row_count, data_count:(.data|length)}'
done
```

## Confirm no Cloudflare 1102

Check all of these:

- Browser console has no Cloudflare 1102 HTML responses.
- Website debug `error_log` upload has no `aqi_history_503_count`.
- Worker logs do not show resource-limit failures.
- API responses are JSON, including missing/partial history cases.

If a request cannot be fully served, it should fail gracefully as structured JSON
with `response_complete=false` and clear `partial_reasons`.

## Switch prune daily write mode to v2

Only after v2 read testing passes:

```text
UK_AQ_R2_HISTORY_WRITE_VERSION=v2
```

Keep `UK_AQ_R2_HISTORY_READ_VERSION=v2` only if read soak is healthy. If read
soak is not healthy, keep scheduled writes on v1 until the issue is resolved.

After the first v2 prune daily run:

```bash
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \
  --history-version v2 \
  --targeted \
  --from-day YYYY-MM-DD \
  --to-day YYYY-MM-DD \
  --kind both
```

Then rebuild the v2 inventory and run the v2 Dropbox sync.

## Rollback

Reader rollback:

```text
UK_AQ_R2_HISTORY_READ_VERSION=v1
```

Writer rollback, if scheduled writes were switched:

```text
UK_AQ_R2_HISTORY_WRITE_VERSION=v1
```

Do not delete v2 outputs during rollback. Keep them for diagnosis and retry.

Rollback validation:

```bash
curl -fsS "${AQI_API_BASE}?scope=timeseries&grain=hourly&timeseries_id=396&entity=396&pollutant=pm25&row_limit=20000&from_utc=2026-04-10T00:00:00.000Z&to_utc=2026-04-17T00:00:00.000Z" \
  | jq '{read_version:.read_version, coverage:.coverage, response_complete:.response_complete, row_count:.row_count, data_count:(.data|length)}'
```

Expected: read metadata reports v1, and v1 response contract remains unchanged.

## Soak period checks

Run for at least several daily cycles before deleting any v1 data:

- 24h, 7d, 31d, and 90d chart loads remain stable.
- No Cloudflare 1102/503 spikes.
- Website debug logs show v2 metadata for AQI bands and observation history.
- R2 Class A/B operation counts stay within expected limits.
- Dropbox v2 backup inventory and checkpoint advance normally.
- AQI band gaps do not increase versus v1.
- Manual API checks for the known failing windows continue to return JSON.

Supabase egress impact during soak:

- Website history reads should be served from R2/Workers, not Supabase.
- Backfill/build operations can read from Supabase or upstream sources depending
  on mode; treat those as planned one-off build egress.
- Do not claim Supabase egress reduction until endpoint response egress metrics
  confirm it.

Database-size impact during soak:

- R2 v2 build does not add Supabase tables or rows.
- R2 storage increases because v2 is stored alongside v1.
- Dropbox backup storage increases by the v2 copy.

## Criteria for deleting v1 later

Do not delete v1 until all are true:

- CIC-Test has passed soak with `UK_AQ_R2_HISTORY_READ_VERSION=v2`.
- Scheduled writes have run successfully with `UK_AQ_R2_HISTORY_WRITE_VERSION=v2`.
- v2 Dropbox backup has a current inventory and checkpoint.
- Known test cases and known failing windows pass.
- Rollback to v1 is no longer required by the project owner.
- A separate explicit deletion plan has been approved.

Deletion is out of scope for this runbook.
