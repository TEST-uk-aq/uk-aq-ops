# UK AQ AQI Levels v1 Hard Rebuild Plan

Status: planning and implementation design  
Target first environment: TEST  
Repeatable target environment: LIVE after TEST is proven  
Created: 2026-06-09

## 1. Purpose

This plan replaces the current hybrid AQI levels design with a cleaner normalised AQI levels design.

The current R2 AQI levels layout mixes two concepts:

1. A wide station-hour style model, with pollutant-specific columns such as `daqi_pm25_rolling24h_index_level`, `eaqi_pm25_index_level`, and equivalent NO2/PM10 columns.
2. A normalised timeseries-pollutant-hour model, with `timeseries_id`, `pollutant_code`, `timestamp_hour_utc`, `daqi_index_level`, and `eaqi_index_level`.

Because the current rows already include `pollutant_code`, the wide pollutant-specific columns are unnecessary and create sparse rows with many nulls. This has already caused AQI band gaps in the website because the frontend/parser can choose the wrong column path.

The goal is to hard migrate the existing `history/v1/aqilevels` area while the website is still beta.

## 2. Decided migration approach

### 2.1 Hard migration

Use a hard migration in the existing version path:

```text
history/v1/aqilevels
```

Do not create `history/v2/aqilevels` for this migration.

Rationale:

- The website is beta and not public.
- It is better to fix the schema fully now.
- The website will support only the new layout after the TEST cutover.
- LIVE repeatability will be documented and run only after TEST validation.

### 2.2 Redesign ObsAQIDB to match

ObsAQIDB must be updated to use the same normalised AQI hourly contract as R2.

Rationale:

- The AQI history endpoint merges historical R2 AQI levels and recent ObsAQIDB AQI levels.
- Keeping different shapes would preserve the translation layer and the same class of bugs.
- The website should consume one stable AQI contract, regardless of whether the source is R2 or ObsAQIDB.

### 2.3 Hourly now, daily/monthly later

This migration implements hourly AQI levels now, but the R2 object layout must allow daily and monthly outputs later.

Use this path layout:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
history/v1/aqilevels/daily/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
history/v1/aqilevels/monthly/month_utc=YYYY-MM/connector_id=<id>/part-00000.parquet
```

Only the hourly path is implemented in this migration.

### 2.4 Schema version

The new schema is the current schema after migration.

Set the current hourly AQI history schema version to the new version used by the implementation. The recommendation is:

```text
history_schema_name = aqilevels_hourly
history_schema_version = 1
```

This is the canonical schema identity for the rebuild. Do not use `history_schema_name = aqilevels` or `history_schema_version = 3` for this migration.

The preferred interpretation is that the new hourly layout is a new schema family under `aqilevels/hourly`, so its current version starts at 1.

## 3. New hourly AQI row meaning

One row means:

```text
one connector
one station
one timeseries
one pollutant
one UTC hour
one DAQI result
one EAQI result
```

This is not a station-wide row and not a multi-pollutant row.

## 4. New hourly AQI parquet schema

Recommended physical column order:

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

source_observation_count
required_observation_count
hourly_sample_count

calculation_status
missing_reason
algorithm_version
computed_at_utc
```

## 5. Column definitions

| Column | Meaning |
|---|---|
| `connector_id` | Connector id for the timeseries/source. |
| `station_id` | Station id, nullable only if the source data genuinely cannot resolve it. |
| `timeseries_id` | Timeseries id. |
| `pollutant_code` | Normalised pollutant code, initially `pm25`, `pm10`, `no2`. |
| `timestamp_hour_utc` | UTC hour start timestamp for the AQI row. |
| `daqi_input_value_ugm3` | Concentration value used to calculate DAQI. |
| `daqi_input_averaging_code` | Averaging basis used for DAQI. |
| `daqi_index_level` | UK DAQI numeric index level, nullable when not calculable. |
| `eaqi_input_value_ugm3` | Concentration value used to calculate EAQI. |
| `eaqi_input_averaging_code` | Averaging basis used for EAQI. |
| `eaqi_index_level` | EAQI numeric index level, nullable when not calculable. |
| `source_observation_count` | Number of source observations contributing to the current hourly value. |
| `required_observation_count` | Number of observations required to pass completeness. |
| `hourly_sample_count` | Backwards-compatible or summary hourly sample count. May equal `source_observation_count` for hourly rows. |
| `calculation_status` | `ok`, `insufficient_samples`, `missing_input`, or `unsupported_pollutant`. |
| `missing_reason` | More detailed reason when an index cannot be calculated. |
| `algorithm_version` | AQI calculation algorithm version. |
| `computed_at_utc` | Timestamp when the AQI row was computed. |

## 6. DAQI and EAQI input basis

DAQI and EAQI must be treated as separate calculators.

Do not use a single shared `aqi_input_value_ugm3`.

From the uploaded threshold/reference files:

- PM2.5 UK DAQI uses 24-hour running mean or daily mean.
- PM10 UK DAQI uses 24-hour running mean or daily mean.
- NO2 UK DAQI uses hourly mean.
- PM2.5 EAQI uses 1-hour concentration thresholds.
- PM10 EAQI uses 1-hour concentration thresholds.
- NO2 EAQI uses 1-hour concentration thresholds.

Therefore PM2.5 and PM10 need different DAQI and EAQI input values for hourly bands.

Use separate fields:

```text
daqi_input_value_ugm3
daqi_input_averaging_code
daqi_index_level

eaqi_input_value_ugm3
eaqi_input_averaging_code
eaqi_index_level
```

Recommended averaging codes:

```text
hourly_mean
rolling_24h_mean
daily_mean
running_8h_mean
fifteen_min_mean
not_applicable
```

Initial supported averaging codes for this migration:

```text
hourly_mean
rolling_24h_mean
```

Future codes are reserved for daily/monthly or future pollutants such as O3 and SO2.

## 7. Null rows and status

Store evaluated rows even when DAQI and/or EAQI are null.

This is important because it lets checks distinguish:

```text
No AQI row exists in R2
```

from:

```text
The AQI row exists, but the value is null because there was insufficient input data
```

Recommended `calculation_status` values:

```text
ok
insufficient_samples
missing_input
unsupported_pollutant
```

Recommended `missing_reason` examples:

```text
no_observations_in_hour
insufficient_hourly_samples
insufficient_rolling_24h_hours
missing_station_link
unsupported_pollutant
breakpoint_not_found
```

If one index is calculable and the other is not, keep the row and set the calculable index. The row-level `calculation_status` may still be `ok_partial` if Codex finds that a single status field is not expressive enough. Simpler option: keep `calculation_status = ok` when at least one index exists, and put the missing side in `missing_reason`.

Codex should assess whether separate status fields are better:

```text
daqi_calculation_status
daqi_missing_reason
eaqi_calculation_status
eaqi_missing_reason
```

Recommended if implementation complexity is acceptable: use separate DAQI and EAQI status fields. This is cleaner because DAQI and EAQI use different inputs.

If using separate status fields, the schema becomes:

```text
daqi_calculation_status
daqi_missing_reason
eaqi_calculation_status
eaqi_missing_reason
```

instead of:

```text
calculation_status
missing_reason
```

## 8. Preferred final hourly schema

Because DAQI and EAQI can fail independently, the preferred final schema is:

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

This is the recommended schema unless Codex finds a strong reason to keep shared source counts/status.

## 9. Website/API contract

The website must not know about wide pollutant-specific AQI columns.

For AQI bands, the website should consume only:

```text
period_start_utc
connector_id
station_id
timeseries_id
pollutant_code
daqi_index_level
eaqi_index_level
```

Optional debug fields may include:

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

The website should not parse these old fields after cutover:

```text
daqi_no2_index_level
daqi_pm25_rolling24h_index_level
daqi_pm10_rolling24h_index_level
eaqi_no2_index_level
eaqi_pm25_index_level
eaqi_pm10_index_level
```

## 10. R2 deletion scope for TEST

For TEST, delete all old AQI R2 history outputs before rebuilding.

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

Also delete any old AQI path objects that conflict with the new layout.

Do not delete:

```text
history/v1/observations/**
history/_index/observations_latest.json
history/_index/observations_timeseries_latest.json
history/_index/observations_timeseries/**
history/v1/core/**
```

## 11. Rebuild source of truth

The rebuild source should be the robust AQI rebuild/backfill logic, updated for the new layout.

Historical rebuild:

- Use R2 Dropbox observation history where practical.
- Recompute AQI hourly rows into the new normalised layout.
- Write new hourly AQI parquet and manifests under `history/v1/aqilevels/hourly/...`.

Recent catch-up:

- Stop AQI compute first.
- After the new code is deployed, check that restarting AQI compute can rebuild missing recent AQI levels.
- The restarted compute must fill any gap created while AQI compute was stopped.

## 12. Jobs to pause

Pause AQI compute and AQI history export/update jobs only.

Initial list to confirm in TEST:

```text
uk-aq-timeseries-aqi-hourly
uk-aq-aqilevels-retention
any prune/export job mode that writes history/v1/aqilevels
any AQI history worker cache writes if they can write old band cache objects
```

Do not stop ordinary observation ingest unless Codex proves that it is necessary.

## 13. Code areas that must change

### uk-aq-ops

Expected areas:

```text
workers/uk_aq_timeseries_aqi_hourly_cloud_run/
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/uk_aq_aqi_history_r2_api_worker/
scripts/backup_r2/
scripts/uk-aq-history-integrity/
system_docs/
plans/
```

Key changes:

- Update hourly AQI helper row type.
- Update ObsAQIDB upsert RPC contract.
- Update R2 AQI rows RPC/export query.
- Update parquet writer schema.
- Update R2 path builder to use `aqilevels/hourly`.
- Update manifests/indexes to include the new schema and new grain path.
- Remove old pollutant-specific wide fields from new output.
- Add validation for DAQI/EAQI separate inputs and statuses.
- Update AQI history API response to the clean contract.
- Update band cache logic or remove old band cache use until rebuilt in the new contract.

### uk-aq-ingest

Expected areas:

```text
AQI helper RPCs
AQI breakpoint tables/views
helper-window RPCs
backfill/rebuild support if hosted here
system docs
```

Key changes:

- Ensure helper computation outputs separate DAQI and EAQI input values.
- Ensure PM2.5/PM10 DAQI uses rolling 24h mean for hourly bands.
- Ensure PM2.5/PM10 EAQI uses hourly mean.
- Ensure NO2 DAQI and EAQI use hourly mean.
- Add source and required observation counts.
- Add separate DAQI/EAQI status/missing reason if adopted.

### uk-aq

Expected areas:

```text
hex_map.html
plans/
possibly sensors_chart.html if still used
```

Key changes:

- Website AQI band parser consumes only `daqi_index_level` and `eaqi_index_level`.
- Remove fallback reliance on old wide pollutant-specific fields.
- Update debug output to show clean API fields and status.
- Ensure chart gaps reflect real missing/null rows, not parser field-name failures.


## 14. R2 Dropbox backup and inventory implications

The R2 Dropbox backup tooling has already been updated to use the new AQI hourly prefix as the default AQI domain prefix:

```text
history/v1/aqilevels/hourly
```

This means the normal inventory builder and Dropbox sync can pick up the rebuilt hourly AQI parquet and manifests without another layout change, provided the environment variable is not overriding the prefix back to the old value. Confirm the following before running the backup after the rebuild:

```text
UK_AQ_R2_HISTORY_AQILEVELS_PREFIX=history/v1/aqilevels/hourly
UK_AQ_R2_HISTORY_INDEX_PREFIX=history/_index
UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH=history/_index/backup_inventory_v1.json
```

Important behaviour: the Dropbox backup sync is inventory-driven and uses copy semantics. It copies changed or missing inventory units from R2 to Dropbox, but it does not remove stale files from Dropbox that no longer exist in R2.

Therefore, after the hard rebuild, the old Dropbox AQI folder must be archived or removed from the active backup tree before the first post-rebuild AQI backup sync. Otherwise the local Dropbox backup may contain both the old layout:

```text
history/v1/aqilevels/day_utc=YYYY-MM-DD/...
history/v1/aqilevels/bands/v1/...
```

and the new layout:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/...
```

Recommended TEST cleanup before the first post-rebuild AQI Dropbox sync:

```bash
DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup"
STAMP="$(date -u +%F_%H%M%S)"

mkdir -p "${DROPBOX_ROOT}/_archive/pre-aqilevels-v1-hard-rebuild"

mv \
  "${DROPBOX_ROOT}/history/v1/aqilevels" \
  "${DROPBOX_ROOT}/_archive/pre-aqilevels-v1-hard-rebuild/aqilevels_old_layout_${STAMP}"
```

Then rebuild the backup inventory from R2 and run the AQI-only Dropbox sync. The post-sync active Dropbox backup should contain hourly AQI files only under `history/v1/aqilevels/hourly`.

Post-sync checks:

```bash
find "${DROPBOX_ROOT}/history/v1/aqilevels/hourly" -type f | head -50

find "${DROPBOX_ROOT}/history/v1/aqilevels" \
  -type f \
  | grep -v "/hourly/" \
  | head -50
```

The second command should return no old-layout AQI files.

## 15. Validation goals

After TEST rebuild:

1. R2 has no old AQI parquet under the previous day-level path.
2. R2 has new hourly parquet under:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
```

3. New parquet schema contains no old wide AQI columns.
4. ObsAQIDB recent AQI rows match the new contract.
5. AQI history API returns clean rows with generic `daqi_index_level` and `eaqi_index_level`.
6. Website AQI bands render from the clean fields.
7. Missing bands only occur when:
   - no row exists, or
   - the row exists with null AQI and an explicit missing reason.
8. Restarting AQI compute fills the gap created while AQI compute was paused.
9. The existing problem timeseries, `station_id=1575`, `timeseries_id=354`, `pollutant_code=pm25`, has no parser-created AQI band gaps.
10. The post-rebuild Dropbox backup has no active old-layout AQI files outside `history/v1/aqilevels/hourly`.

## 16. TEST to LIVE repeatability

The TEST implementation runbook must be updated as differences are found.

Before LIVE:

- Copy the final TEST runbook to a LIVE runbook section.
- Replace TEST paths, buckets, env vars, and project identifiers with LIVE equivalents.
- Add a LIVE pause point before deletion.
- Require inventory exports before deletion.
- Require validation queries before restarting AQI compute.

## 17. Open implementation checks for Codex

Codex must confirm:

1. Exact current ObsAQIDB table/view/RPC names for AQI hourly rows.
2. Exact current backfill/rebuild script that writes AQI bands/history.
3. Whether R2 Dropbox observation history is enough for full historical rebuild.
4. Whether recent retention hours must be rebuilt from ingest DB after restart.
5. Whether old AQI band cache writes must be disabled until new cache objects exist.
6. Whether separate DAQI/EAQI status fields are practical.
7. Confirm `history_schema_name = aqilevels_hourly` and `history_schema_version = 1` are used consistently by manifest and index tooling.
8. Confirm the R2 Dropbox backup inventory and sync are using `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX=history/v1/aqilevels/hourly`, and that stale old-layout AQI Dropbox files have been archived before post-rebuild validation.
