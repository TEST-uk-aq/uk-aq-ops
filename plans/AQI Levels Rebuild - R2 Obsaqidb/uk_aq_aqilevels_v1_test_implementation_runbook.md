# UK AQ AQI Levels v1 Hard Rebuild TEST Implementation Runbook

Status: implementation runbook  
Target environment: TEST first  
Repeatable environment: LIVE after TEST is proven  
Created: 2026-06-09

## 1. Purpose

This runbook describes how to hard rebuild AQI levels in TEST using the new normalised hourly AQI layout.

The same runbook must be updated as TEST differences are discovered, then reused for LIVE.

This is a destructive AQI-only migration in the existing `history/v1/aqilevels` namespace.

## 2. Target R2 layout

New hourly path:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/manifest.json
```

Future reserved paths:

```text
history/v1/aqilevels/daily/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
history/v1/aqilevels/monthly/month_utc=YYYY-MM/connector_id=<id>/part-00000.parquet
```

Only hourly is implemented in this migration.

## 3. Target hourly parquet schema

Preferred schema:

```text
connector_id
station_id
timeseries_id
pollutant_code
timestamp_hour_utc

daqi_input_value_ugm3
daqi_input_averaging_code
daqi_index_level
daqi_source_observation_count
daqi_required_observation_count
daqi_calculation_status
daqi_missing_reason

eaqi_input_value_ugm3
eaqi_input_averaging_code
eaqi_index_level
eaqi_source_observation_count
eaqi_required_observation_count
eaqi_calculation_status
eaqi_missing_reason

hourly_sample_count
algorithm_version
computed_at_utc
```

Accepted status values:

```text
ok
insufficient_samples
missing_input
unsupported_pollutant
```

Accepted initial averaging codes:

```text
hourly_mean
rolling_24h_mean
```

Reserved future averaging codes:

```text
daily_mean
running_8h_mean
fifteen_min_mean
not_applicable
```

## 4. TEST preflight

### 4.1 Confirm branches and repos

Repos:

```text
https://github.com/ChronicChannel-test/uk-aq-ingest
https://github.com/ChronicChannel-test/uk-aq-ops
https://github.com/ChronicChannel-test/uk-aq
```

Confirm the branch to use for TEST.

Record:

```text
uk-aq-ingest branch:
uk-aq-ops branch:
uk-aq branch:
```

### 4.2 Confirm environment values

Record TEST values:

```text
GCP project:
GCP region:
R2 bucket:
R2 backup Dropbox root: `CIC-Test/R2_history_backup` (offline copy preferred)
OBS_AQIDB_SUPABASE_URL:
SUPABASE_URL:
INGESTDB_RETENTION_DAYS:
AQI hourly Cloud Run service name:
AQI retention service name:
Prune/export service name:
AQI history worker route:
Website beta URL:
```

### 4.3 Inventory current AQI R2 objects

Create an inventory before deletion.
Use the offline Dropbox copy at `CIC-Test/R2_history_backup` for all validation queries, inventories, and rebuild inputs in TEST.

Inventory scope:

```text
history/v1/aqilevels/**
history/_index/aqilevels_latest.json
history/_index/aqilevels_timeseries_latest.json
history/_index/aqilevels_timeseries/**
```

Output file:

```text
logs/aqilevels_pre_rebuild_inventory_TEST_YYYY-MM-DD.json
```

Inventory should include:

```text
object_count
total_bytes
prefix_counts
sample_keys
old_parquet_count
old_manifest_count
old_band_cache_count
old_index_count
min_day_utc
max_day_utc
```

### 4.4 Inventory current ObsAQIDB AQI rows

Export row counts by day, connector, pollutant, and timeseries.

Suggested output:

```text
logs/obsaqidb_aqilevels_pre_rebuild_TEST_YYYY-MM-DD.csv
```

Suggested checks:

```sql
select
  date_trunc('day', timestamp_hour_utc)::date as day_utc,
  connector_id,
  pollutant_code,
  count(*) as row_count,
  count(*) filter (where daqi_index_level is not null) as daqi_rows,
  count(*) filter (where eaqi_index_level is not null) as eaqi_rows,
  min(timestamp_hour_utc) as first_hour,
  max(timestamp_hour_utc) as last_hour
from uk_aq_public.uk_aq_timeseries_aqi_hourly
group by 1, 2, 3
order by 1, 2, 3;
```

Codex must adjust table/view names if the actual names differ.

## 5. Pause AQI compute

Pause AQI-related jobs only.

Likely AQI jobs:

```text
uk-aq-timeseries-aqi-hourly service
uk-aq-timeseries-aqi-hourly-trigger scheduler
uk-aq-aqilevels-retention-service
uk-aq-aqilevels-retention-daily scheduler
prune/export path that writes history/v1/aqilevels
AQI history worker band cache writes, if they can write old-shape cache objects
```

Do not pause ordinary observation ingest unless required.

Record paused jobs:

```text
job/service:
previous schedule/setting:
pause time UTC:
operator:
```

## 6. Archive current code and docs

Before changing code, archive files that will be changed.

Suggested archive path in each repo:

```text
archive/2026-06-09-aqilevels-v1-hard-rebuild/
```

Archive likely files in `uk-aq-ops`:

```text
workers/uk_aq_timeseries_aqi_hourly_cloud_run/
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/uk_aq_aqi_history_r2_api_worker/
system_docs/uk-aq-r2-history-layout.md
system_docs/uk-aq-aqi-history-r2-api-worker.md
system_docs/uk-aq-timeseries-aqi-hourly.md
scripts/backup_r2/
scripts/uk-aq-history-integrity/
```

Archive likely files in `uk-aq-ingest`:

```text
AQI helper SQL/RPC files
AQI breakpoint files
system_docs/
```

Archive likely files in `uk-aq`:

```text
hex_map.html
plans/
```

Codex must identify exact files before archiving.

## 7. Implement ObsAQIDB schema and RPC changes

Goal: ObsAQIDB hourly AQI rows match the new normalised contract.

Required changes:

1. Add or replace the AQI hourly table/view with the new columns.
2. Update upsert RPC to accept the new row shape.
3. Update retention cleanup to use the new table/path.
4. Update rollup refresh only if it depends on old wide columns.
5. Update public view `uk_aq_timeseries_aqi_hourly` or equivalent to expose the new contract.
6. Ensure existing recent AQI history endpoint can read recent rows from the new shape.

Suggested validation:

```sql
select *
from uk_aq_public.uk_aq_timeseries_aqi_hourly
limit 10;
```

Expected columns include:

```text
connector_id
station_id
timeseries_id
pollutant_code
timestamp_hour_utc
daqi_input_value_ugm3
daqi_input_averaging_code
daqi_index_level
eaqi_input_value_ugm3
eaqi_input_averaging_code
eaqi_index_level
daqi_source_observation_count
daqi_required_observation_count
eaqi_source_observation_count
eaqi_required_observation_count
daqi_calculation_status
eaqi_calculation_status
algorithm_version
computed_at_utc
```

## 8. Implement ingest helper changes

Goal: helper rows produce separate DAQI and EAQI inputs.

Rules:

```text
PM2.5 DAQI: rolling_24h_mean
PM10 DAQI: rolling_24h_mean
NO2 DAQI: hourly_mean

PM2.5 EAQI: hourly_mean
PM10 EAQI: hourly_mean
NO2 EAQI: hourly_mean
```

Required outputs:

```text
daqi_input_value_ugm3
daqi_input_averaging_code
daqi_index_level
daqi_source_observation_count
daqi_required_observation_count
daqi_calculation_status
daqi_missing_reason

eaqi_input_value_ugm3
eaqi_input_averaging_code
eaqi_index_level
eaqi_source_observation_count
eaqi_required_observation_count
eaqi_calculation_status
eaqi_missing_reason
```

Validation:

1. Pick PM2.5 rows and confirm DAQI input is rolling 24h mean.
2. Pick PM2.5 rows and confirm EAQI input is hourly mean.
3. Pick PM10 rows and confirm DAQI input is rolling 24h mean.
4. Pick PM10 rows and confirm EAQI input is hourly mean.
5. Pick NO2 rows and confirm both inputs are hourly mean.

## 9. Implement AQI hourly Cloud Run changes

Update:

```text
workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_job.ts
workers/uk_aq_timeseries_aqi_hourly_cloud_run/README.md
system_docs/uk-aq-timeseries-aqi-hourly.md
```

Required changes:

1. Update `HelperRow` type.
2. Update parse helper row logic.
3. Update upsert payload.
4. Update run logging if needed.
5. Ensure `sync_hourly`, `reconcile_short`, `reconcile_deep`, and `backfill` work with the new shape.
6. Ensure `UK_AQ_AQI_TIMESERIES_IDS_CSV` still scopes rebuilds.

Validation:

```json
{"trigger_mode":"manual","run_mode":"reconcile_short","timeseries_ids":[354]}
```

Expected:

```text
rows_changed > 0 or clean no-op
no old wide AQI fields used
new ObsAQIDB rows inserted/updated
```

## 10. Implement R2 writer changes

Update:

```text
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
```

Required changes:

1. Change AQI prefix from:

```text
history/v1/aqilevels
```

to:

```text
history/v1/aqilevels/hourly
```

for hourly output.

2. Replace old AQI parquet columns with the new normalised schema.
3. Update AQI connector manifest shape.
4. Update AQI day manifest shape.
5. Include `grain = hourly` in manifests.
6. Include new schema name/version in manifests.
7. Update source row summaries to use `timestamp_hour_utc`, `timeseries_id`, `pollutant_code`, and connector id.
8. Update file entries to include pollutant coverage and time coverage.

Recommended manifest metadata:

```text
history_schema_name = aqilevels_hourly
history_schema_version = 1
grain = hourly
writer_version = parquet-wasm-zstd-v1
columns = [new hourly columns]
```

If existing code requires `writer_version = parquet-wasm-zstd-v2`, keep it but document why.

## 11. Implement AQI R2 history API worker changes

Update:

```text
workers/uk_aq_aqi_history_r2_api_worker/
system_docs/uk-aq-aqi-history-r2-api-worker.md
```

Required changes:

1. Read new hourly path:

```text
history/v1/aqilevels/hourly
```

2. Read new parquet columns only.
3. Remove dependency on old wide pollutant-specific fields.
4. Return clean AQI rows:

```text
period_start_utc
connector_id
station_id
timeseries_id
pollutant_code
daqi_index_level
eaqi_index_level
```

5. Include optional debug fields:

```text
daqi_input_value_ugm3
daqi_input_averaging_code
eaqi_input_value_ugm3
eaqi_input_averaging_code
daqi_calculation_status
eaqi_calculation_status
source
source_coverage
```

6. Update response coverage metadata for missing/null rows.
7. Disable or rebuild old band cache logic so no old cached output is served.

## 12. Implement website changes

Update:

```text
hex_map.html
```

Required changes:

1. AQI band parser consumes only:

```text
daqi_index_level
eaqi_index_level
```

2. Remove old wide-field fallback logic unless Codex needs a temporary TEST-only diagnostic branch.
3. AQI gaps are rendered only when:
   - row missing, or
   - DAQI/EAQI null with explicit missing reason.
4. Debug mode `?debug_aqi=1` logs:
   - requested URL
   - row count
   - parsed DAQI count
   - parsed EAQI count
   - rows with null DAQI
   - rows with null EAQI
   - missing reason counts
   - rendered DAQI segment count
   - rendered EAQI segment count

## 13. Delete TEST AQI R2 objects

After code changes are ready but before rebuild, delete only old AQI objects.

Delete:

```text
history/v1/aqilevels/day_utc=*/manifest.json
history/v1/aqilevels/day_utc=*/connector_id=*/manifest.json
history/v1/aqilevels/day_utc=*/connector_id=*/*.parquet
history/v1/aqilevels/bands/v1/**
history/_index/aqilevels_latest.json
history/_index/aqilevels_timeseries_latest.json
history/_index/aqilevels_timeseries/day_utc=*/connector_id=*/manifest.json
```

Do not delete:

```text
history/v1/observations/**
history/_index/observations*
history/v1/core/**
```

After deletion, re-run inventory and save:

```text
logs/aqilevels_post_delete_inventory_TEST_YYYY-MM-DD.json
```

Expected:

```text
old AQI parquet count = 0
old AQI manifest count = 0
old AQI band cache count = 0
old AQI index count = 0
observation object count unchanged
```

## 14. Rebuild historical AQI levels

Update the robust AQI rebuild/backfill script to write the new layout.

The rebuild must:

1. Read source observations from R2 Dropbox history or the chosen local source.
2. Compute hourly AQI rows using separate DAQI/EAQI inputs.
3. Write hourly parquet to:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
```

4. Write connector manifests.
5. Write day manifests.
6. Rebuild AQI latest descriptors and timeseries index objects for the new path.
7. Avoid writing old band cache objects unless the cache format is also rebuilt.

Suggested rebuild command:

This wrapper already runs `r2_history_obs_to_aqilevels` from Dropbox observation history and rewrites AQI-only outputs in place.

```bash
export UK_AQ_BACKFILL_RUN_MODE="r2_history_obs_to_aqilevels"
export UK_AQ_BACKFILL_OUTPUT_SCOPE="aqilevels_only"
export UK_AQ_BACKFILL_FORCE_REPLACE="true"
export UK_AQ_BACKFILL_DRY_RUN="false"
export UK_AQ_BACKFILL_FROM_DAY_UTC="2026-03-28"
export UK_AQ_BACKFILL_TO_DAY_UTC="2026-04-10"
export UK_AQ_BACKFILL_CONNECTOR_IDS="1"
export UK_AQ_R2_HISTORY_DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup"
export UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX="false"
./scripts/uk_aq_backfill_local.sh
```

## 15. Rebuild recent missing AQI levels after restart

After the historical rebuild:

1. Deploy new AQI hourly compute.
2. Restart AQI compute.
3. Run targeted reconcile/backfill for the downtime window.
4. Confirm the compute fills missing recent hours.

Suggested manual payload:

```json
{
  "trigger_mode": "manual",
  "run_mode": "backfill",
  "from_hour_utc": "<pause_start_hour_utc>",
  "to_hour_utc": "<restart_hour_utc>"
}
```

Also run targeted test:

```json
{
  "trigger_mode": "manual",
  "run_mode": "reconcile_short",
  "timeseries_ids": [354]
}
```

## 16. Validation queries

### 16.1 DuckDB schema check

```sql
DESCRIBE SELECT *
FROM read_parquet(
  '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=*/connector_id=*/*.parquet',
  union_by_name = true
);
```

Expected: no old wide columns.

### 16.2 Timeseries 354 PM2.5 check

```sql
SELECT
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,
  timestamp_hour_utc,
  daqi_input_value_ugm3,
  daqi_input_averaging_code,
  daqi_index_level,
  daqi_source_observation_count,
  daqi_required_observation_count,
  daqi_calculation_status,
  daqi_missing_reason,
  eaqi_input_value_ugm3,
  eaqi_input_averaging_code,
  eaqi_index_level,
  eaqi_source_observation_count,
  eaqi_required_observation_count,
  eaqi_calculation_status,
  eaqi_missing_reason,
  hourly_sample_count,
  algorithm_version,
  computed_at_utc
FROM read_parquet([
  '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-03-*/connector_id=*/*.parquet',
  '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-04-*/connector_id=*/*.parquet'
], union_by_name = true)
WHERE station_id = 1575
  AND timeseries_id = 354
  AND pollutant_code = 'pm25'
ORDER BY timestamp_hour_utc;
```

### 16.3 PM2.5 input-basis check

```sql
SELECT
  pollutant_code,
  daqi_input_averaging_code,
  eaqi_input_averaging_code,
  count(*) as row_count
FROM read_parquet(
  '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=*/connector_id=*/*.parquet',
  union_by_name = true
)
WHERE pollutant_code in ('pm25', 'pm10', 'no2')
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```

Expected initial pattern:

```text
pm25 | rolling_24h_mean | hourly_mean
pm10 | rolling_24h_mean | hourly_mean
no2  | hourly_mean      | hourly_mean
```

### 16.4 Gap check

```sql
WITH src AS (
  SELECT
    timestamp_hour_utc,
    daqi_index_level,
    eaqi_index_level,
    daqi_calculation_status,
    eaqi_calculation_status,
    daqi_missing_reason,
    eaqi_missing_reason
  FROM read_parquet([
    '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-03-*/connector_id=*/*.parquet',
    '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-04-*/connector_id=*/*.parquet'
  ], union_by_name = true)
  WHERE station_id = 1575
    AND timeseries_id = 354
    AND pollutant_code = 'pm25'
),
bounds AS (
  SELECT min(timestamp_hour_utc) AS min_ts, max(timestamp_hour_utc) AS max_ts
  FROM src
),
expected_hours AS (
  SELECT hour_utc
  FROM bounds,
       generate_series(min_ts, max_ts, INTERVAL 1 HOUR) AS t(hour_utc)
),
joined AS (
  SELECT
    e.hour_utc,
    s.timestamp_hour_utc,
    s.daqi_index_level,
    s.eaqi_index_level,
    s.daqi_calculation_status,
    s.eaqi_calculation_status,
    s.daqi_missing_reason,
    s.eaqi_missing_reason,
    coalesce(
      nullif(trim(s.daqi_missing_reason), ''),
      CASE
        WHEN lower(coalesce(trim(s.daqi_calculation_status), '')) = 'ok' THEN NULL
        ELSE nullif(trim(s.daqi_calculation_status), '')
      END
    ) AS daqi_reason,
    coalesce(
      nullif(trim(s.eaqi_missing_reason), ''),
      CASE
        WHEN lower(coalesce(trim(s.eaqi_calculation_status), '')) = 'ok' THEN NULL
        ELSE nullif(trim(s.eaqi_calculation_status), '')
      END
    ) AS eaqi_reason
  FROM expected_hours e
  LEFT JOIN src s
    ON s.timestamp_hour_utc = e.hour_utc
)
SELECT
  hour_utc,
  daqi_index_level,
  eaqi_index_level,
  daqi_calculation_status,
  eaqi_calculation_status,
  daqi_missing_reason,
  eaqi_missing_reason,
  CASE
    WHEN timestamp_hour_utc IS NULL THEN 'missing row'
    WHEN daqi_index_level IS NULL AND daqi_reason IS NULL THEN 'DAQI null without reason'
    WHEN eaqi_index_level IS NULL AND eaqi_reason IS NULL THEN 'EAQI null without reason'
    ELSE ''
  END AS gap_status
FROM joined
WHERE timestamp_hour_utc IS NULL
   OR (daqi_index_level IS NULL AND daqi_reason IS NULL)
   OR (eaqi_index_level IS NULL AND eaqi_reason IS NULL)
ORDER BY hour_utc;
```

## 17. Browser validation

Use TEST website with:

```text
?debug_aqi=1
```

Check:

1. Open the known affected hex/chart.
2. Select PM2.5.
3. Confirm the AQI history request uses the new endpoint/output.
4. Confirm rows parse from `daqi_index_level` and `eaqi_index_level`.
5. Confirm no old wide fields are needed.
6. Confirm AQI gaps match missing rows or explicit null statuses.
7. Check 24h, 7d, 31d, and 90d.
8. Switch AQI source sensor.
9. Switch pollutant.
10. Confirm debug logs explain gaps.

## 18. Restart AQI schedules

After validation:

1. Restart AQI compute schedule.
2. Restart retention/cleanup if updated.
3. Restart export/prune jobs that write AQI history.
4. Confirm no job writes old layout objects.
5. Monitor the next scheduled AQI cycle.

Record:

```text
job/service:
restart time UTC:
new schedule/setting:
operator:
first successful run id:
```

## 19. TEST monitoring

Monitor for at least one full rebuild plus several scheduled AQI cycles.

Checks:

```text
new AQI rows appearing in ObsAQIDB
new hourly R2 AQI parquet appearing under aqilevels/hourly
no old AQI parquet paths reappearing
AQI history endpoint response_complete true where expected
website AQI bands stable
no parser-created gaps
no unexpected Cloud Run errors
no unexpected R2 read/write spike
```

## 20. Update this runbook after TEST

Before LIVE:

1. Replace TEST-specific paths with LIVE paths.
2. Add all discovered differences.
3. Add exact commands used.
4. Add exact validation outputs.
5. Add rollback notes.
6. Add a mandatory LIVE pause point before deletion.

## 21. LIVE repeat notes

LIVE should follow the same steps, but with extra safeguards:

1. Take inventory.
2. Export current AQI object list.
3. Pause before deletion.
4. Confirm with operator before deleting LIVE AQI objects.
5. Rebuild.
6. Validate with DuckDB and website.
7. Restart AQI compute.
8. Monitor.

Because this is a hard migration in `history/v1/aqilevels`, LIVE should not be attempted until TEST has passed.
