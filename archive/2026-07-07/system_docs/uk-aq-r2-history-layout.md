UK AQ R2 History Layout

Generated: 2026-06-09  
Repository checked: `ChronicChannel-test/uk-aq-ops`  
Primary code source: `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`  
Primary layout source: `system_docs/uk-aq-r2-history-layout.md`

## Important notes

This file is a practical R2 schema/reference file for local DuckDB checks and Codex prompts.

The canonical R2 layout document says the actual object tree, manifest shapes, and derived index payloads are defined by the ops writers and readers in `uk-aq-ops`.

For parquet columns, this file follows the current writer code in
`phase_b_history_r2.mjs` and `workers/uk_aq_backfill_local/run_job.ts`.

## Bucket selection

Bucket selection is deployment-specific.

Known bucket env/config names from the R2 layout docs:

- `R2_BUCKET`
- `CFLARE_R2_BUCKET`

Test and LIVE use separate Cloudflare/R2 accounts, so active R2 history code
uses the configured bucket directly. Do not use a deploy-env bucket selector or
per-environment bucket mapping.

## Stable top-level prefixes

```text
history/v1/observations
history/v1/aqilevels/hourly
history/v1/core
history/_index
history/_index_v2
```

## Operational prefixes

```text
history/v1/_ops/observations/runs
history/v1/_ops/observations/staging
```

## Object tree

```text
history/
  _index/
    observations_latest.json
    aqilevels_latest.json
    observations_timeseries_latest.json
    aqilevels_timeseries_latest.json
    observations_timeseries/
      day_utc=YYYY-MM-DD/
        connector_id=<id>/
          manifest.json
    aqilevels_timeseries/
      day_utc=YYYY-MM-DD/
        connector_id=<id>/
          manifest.json
  _index_v2/
    observations_timeseries_latest.json
    aqilevels_hourly_data_timeseries_latest.json
    observations_timeseries/
      day_utc=YYYY-MM-DD/
        connector_id=<id>/
          pollutant_code=<pollutant>/
            manifest.json
    aqilevels_hourly_data_timeseries/
      day_utc=YYYY-MM-DD/
        connector_id=<id>/
          pollutant_code=<pollutant>/
            manifest.json
  v1/
    observations/
      day_utc=YYYY-MM-DD/
        manifest.json
        connector_id=<id>/
          manifest.json
          part-00000.parquet
          part-00001.parquet
          ...
    aqilevels/
      hourly/
        day_utc=YYYY-MM-DD/
          manifest.json
          connector_id=<id>/
            manifest.json
            part-00000.parquet
            part-00001.parquet
            ...
    core/
      day_utc=YYYY-MM-DD/
        manifest.json
        checksums.sha256
        table=<table>/
          rows.ndjson.gz
    _ops/
      observations/
        runs/
          run_id=<uuid>/
            run_manifest.json
        staging/
          run_id=<uuid>/
            ...
```

---

# 1. Observations domain

## Object paths

```text
history/v1/observations/day_utc=YYYY-MM-DD/connector_id=<id>/part-xxxxx.parquet
history/v1/observations/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
history/v1/observations/day_utc=YYYY-MM-DD/manifest.json
```

R2 history v2 observations are written alongside v1 only when
`UK_AQ_R2_HISTORY_WRITE_VERSION=v2`:

```text
history/v2/observations/day_utc=YYYY-MM-DD/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
```

Dropbox R2 history backups are inventory-led. The inventory identifies changed
day/domain units, sync copies those units with `rclone copy`, and then performs
manifest-guided pruning inside inventory-listed Dropbox units. The current
manifest(s) are the source of truth for Parquet parts: only destination
`*.parquet` files inside the pruned unit that are absent from the
manifest-referenced set are deleted. JSON manifests, checkpoints, inventory
files, reports, logs, non-Parquet files, and files outside the unit are never
deleted by this prune step. In v2 mode, successful prune/audit results are
stored in Dropbox at `_ops/checkpoints/r2_history_backup_prune_state_v2.json`
and keyed by unit path plus inventory `manifest_hash`, so later default
`--prune-scope all` runs can skip units already proven clean. V1 has no prune
checkpoint. Use `--force-prune-recheck` for a deliberate full v2 re-audit and
`--dry-run` to inspect intended deletes without writing the prune checkpoint.
Dropbox destination manifest reads and file listings use five bounded retry
attempts for transient `path/not_folder`, rate-limit, timeout, server, and
network-style rclone errors. This read/list retry is separate from Dropbox
write-throttling retry. If attempts are exhausted, no deletion is planned from
the incomplete information and the unit is not marked clean. Inventory-wide
prune continues to later units to collect failures, then fails the overall run.

## Observations parquet schema

Metadata:

```text
history_schema_name: observations
history_schema_version: 2
writer_version: parquet-wasm-zstd-v2
writer_columns_constant: HISTORY_OBSERVATIONS_COLUMNS_V2
```

Columns, in writer order:

| Ordinal | Column | DuckDB-friendly type | Notes |
|---:|---|---|---|
| 1 | `connector_id` | INTEGER | Written from `Int32Array` |
| 2 | `timeseries_id` | INTEGER | Written from `Int32Array` |
| 3 | `observed_at` | TIMESTAMP | Written from JavaScript `Date` |
| 4 | `value` | DOUBLE | Numeric measurement value, nullable |

R2 history v2 observation columns:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
```

Daily prune v2 source:

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` uses
  `uk_aq_ops.uk_aq_phase_b_history_rows_v2(...)` only when
  `UK_AQ_R2_HISTORY_WRITE_VERSION=v2`.
- The v2 function resolves pollutant metadata in Postgres with the safe join
  `observations -> timeseries -> phenomena -> observed_properties`.
- `observed_properties.code` becomes `pollutant_code`; all rows with a known
  code are eligible, including non-AQI pollutants such as `o3`.
- The daily prune path remains Supabase/Postgres sourced. It does not read
  Dropbox or R2 core snapshots for pollutant resolution.

Legacy writer schema V1, archived/older only:

| Ordinal | Column |
|---:|---|
| 1 | `connector_id` |
| 2 | `timeseries_id` |
| 3 | `observed_at` |
| 4 | `value` |
| 5 | `status` |
| 6 | `created_at` |

## Observations connector manifest

Path:

```text
history/v1/observations/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

Top-level fields:

| Field | Type | Notes |
|---|---|---|
| `day_utc` | string date | `YYYY-MM-DD` |
| `connector_id` | integer | Connector id |
| `run_id` | string | Backup run id |
| `source_row_count` | integer | Source rows for this connector/day |
| `min_observed_at` | timestamp string/null | Earliest observation in source/files |
| `max_observed_at` | timestamp string/null | Latest observation in source/files |
| `parquet_object_keys` | string[] | List of parquet object keys |
| `file_count` | integer | Number of parquet parts |
| `total_bytes` | integer | Total parquet bytes |
| `files` | object[] | Per-file entries |
| `history_schema_name` | string | `observations` |
| `history_schema_version` | integer | `2` |
| `columns` | string[] | Observation parquet columns |
| `writer_version` | string | `parquet-wasm-zstd-v2` |
| `writer_git_sha` | string/null | Writer git SHA if available |
| `bytes_per_row_estimate` | number/null | Derived file-size stat |
| `avg_file_bytes` | number/null | Derived file-size stat |
| `min_file_bytes` | integer/null | Derived file-size stat |
| `max_file_bytes` | integer/null | Derived file-size stat |
| `backed_up_at_utc` | timestamp string | Backup timestamp |
| `manifest_hash` | string | SHA/hash over manifest payload |

`files[]` entry fields:

| Field | Type | Notes |
|---|---|---|
| `key` | string | Parquet object key |
| `row_count` | integer | Rows in this parquet part |
| `bytes` | integer | Object size |
| `etag_or_hash` | string/null | R2 etag or content hash |
| `min_timeseries_id` | integer/null | File range |
| `max_timeseries_id` | integer/null | File range |
| `min_observed_at` | timestamp string/null | File coverage |
| `max_observed_at` | timestamp string/null | File coverage |
| `timeseries_row_counts` | object/null | Optional per-timeseries row counts when present |

## Observations day manifest

Path:

```text
history/v1/observations/day_utc=YYYY-MM-DD/manifest.json
```

Top-level fields:

| Field | Type | Notes |
|---|---|---|
| `day_utc` | string date | `YYYY-MM-DD` |
| `connector_id` | null | Day-level manifest |
| `connector_ids` | integer[] | Connectors for the day |
| `run_id` | string | Backup run id |
| `source_row_count` | integer | Day total rows |
| `min_observed_at` | timestamp string/null | Day coverage |
| `max_observed_at` | timestamp string/null | Day coverage |
| `parquet_object_keys` | string[] | All parquet object keys for the day |
| `file_count` | integer | Total file count |
| `total_bytes` | integer | Total bytes |
| `files` | object[] | Flattened file entries |
| `connector_manifests` | object[] | Connector manifest summaries |
| `history_schema_name` | string | `observations` |
| `history_schema_version` | integer | `2` |
| `columns` | string[] | Observation parquet columns |
| `writer_version` | string | `parquet-wasm-zstd-v2` |
| `writer_git_sha` | string/null | Writer git SHA if available |
| `bytes_per_row_estimate` | number/null | Derived file-size stat |
| `avg_file_bytes` | number/null | Derived file-size stat |
| `min_file_bytes` | integer/null | Derived file-size stat |
| `max_file_bytes` | integer/null | Derived file-size stat |
| `backed_up_at_utc` | timestamp string | Backup timestamp |
| `manifest_hash` | string | SHA/hash over manifest payload |

`connector_manifests[]` entry fields:

| Field | Type |
|---|---|
| `connector_id` | integer |
| `manifest_key` | string |
| `source_row_count` | integer |
| `min_timeseries_id` | integer/null |
| `max_timeseries_id` | integer/null |
| `file_count` | integer |
| `total_bytes` | integer |

---

# 2. AQI levels domain

## Object paths

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/part-xxxxx.parquet
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/manifest.json
```

R2 history v2 AQI hourly paths are split by profile and pollutant. A completed v2 AQI day is expected to have both `data` and `debug` day manifests under their separate profile prefixes:

```text
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
```

Because `connector_id` and `pollutant_code` are part of the v2 AQI path and
timeseries-index path, connector-filtered `r2_history_obs_to_aqilevels` repairs
may rebuild only the requested connector/day partitions. The v1 AQI writer keeps
the older full-day manifest guard.

R2 history v2 AQI hourly `data` columns:

```text
connector_id
station_id
timeseries_id
pollutant_code
timestamp_hour_utc
daqi_index_level
eaqi_index_level
daqi_calculation_status
daqi_missing_reason
eaqi_calculation_status
eaqi_missing_reason
```

R2 history v2 AQI hourly `debug` columns:

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

The v2 debug schema does not include old wide compatibility fields. Keep those in v1 only unless a validation script proves they are still required.

## AQI levels parquet schema

Metadata:

```text
history_schema_name: aqilevels_hourly
history_schema_version: 1
grain: hourly
writer_version: parquet-wasm-zstd-v1
writer_columns_constant: HISTORY_AQILEVELS_COLUMNS
```

Columns, in current writer order:

| Ordinal | Column | DuckDB-friendly type | Notes |
|---:|---|---|---|
| 1 | `connector_id` | INTEGER | Connector id |
| 2 | `station_id` | INTEGER | Nullable |
| 3 | `timeseries_id` | INTEGER | Timeseries id |
| 4 | `pollutant_code` | VARCHAR | Expected examples: `pm25`, `pm10`, `no2` |
| 5 | `timestamp_hour_utc` | TIMESTAMP | AQI hour |
| 6 | `daqi_input_value_ugm3` | DOUBLE | Nullable DAQI input value |
| 7 | `daqi_input_averaging_code` | VARCHAR | `hourly_mean` or `rolling_24h_mean` |
| 8 | `daqi_index_level` | INTEGER | Row DAQI level |
| 9 | `daqi_source_observation_count` | INTEGER | Nullable source count |
| 10 | `daqi_required_observation_count` | INTEGER | Required count for the DAQI input |
| 11 | `daqi_calculation_status` | VARCHAR | `ok`, `missing_input`, `insufficient_samples`, or `unsupported_pollutant` |
| 12 | `daqi_missing_reason` | VARCHAR | Nullable reason when DAQI is null |
| 13 | `eaqi_input_value_ugm3` | DOUBLE | Nullable EAQI input value |
| 14 | `eaqi_input_averaging_code` | VARCHAR | Initially `hourly_mean` |
| 15 | `eaqi_index_level` | INTEGER | Row EAQI level |
| 16 | `eaqi_source_observation_count` | INTEGER | Nullable source count |
| 17 | `eaqi_required_observation_count` | INTEGER | Required count for the EAQI input |
| 18 | `eaqi_calculation_status` | VARCHAR | `ok`, `missing_input`, `insufficient_samples`, or `unsupported_pollutant` |
| 19 | `eaqi_missing_reason` | VARCHAR | Nullable reason when EAQI is null |
| 20 | `hourly_sample_count` | INTEGER | Nullable hourly source sample count |
| 21 | `algorithm_version` | VARCHAR | Current value `aqilevels_hourly_v1` |
| 22 | `computed_at_utc` | TIMESTAMP | Nullable compute timestamp |
| 23 | `hourly_mean_ugm3` | DOUBLE | Compatibility hourly mean |
| 24 | `rolling24h_mean_ugm3` | DOUBLE | Compatibility rolling 24h mean for PM rows |
| 25 | `no2_hourly_mean_ugm3` | DOUBLE | Compatibility NO2 hourly mean |
| 26 | `pm25_hourly_mean_ugm3` | DOUBLE | Compatibility PM2.5 hourly mean |
| 27 | `pm10_hourly_mean_ugm3` | DOUBLE | Compatibility PM10 hourly mean |
| 28 | `pm25_rolling24h_mean_ugm3` | DOUBLE | Compatibility PM2.5 rolling 24h mean |
| 29 | `pm10_rolling24h_mean_ugm3` | DOUBLE | Compatibility PM10 rolling 24h mean |
| 30 | `daqi_no2_index_level` | INTEGER | Compatibility NO2 DAQI |
| 31 | `daqi_pm25_rolling24h_index_level` | INTEGER | Compatibility PM2.5 DAQI using 24h rolling mean |
| 32 | `daqi_pm10_rolling24h_index_level` | INTEGER | Compatibility PM10 DAQI using 24h rolling mean |
| 33 | `eaqi_no2_index_level` | INTEGER | Compatibility NO2 EAQI |
| 34 | `eaqi_pm25_index_level` | INTEGER | Compatibility PM2.5 EAQI |
| 35 | `eaqi_pm10_index_level` | INTEGER | Compatibility PM10 EAQI |
| 36 | `updated_at` | TIMESTAMP | Nullable source row timestamp |

Important PM2.5 fieldnames:

```text
Correct:   daqi_pm25_rolling24h_index_level
Correct:   eaqi_pm25_index_level
Incorrect: daqi_pm25_index_level
```

## AQI connector manifest

Path:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

Top-level fields:

| Field | Type | Notes |
|---|---|---|
| `day_utc` | string date | `YYYY-MM-DD` |
| `connector_id` | integer | Connector id |
| `run_id` | string | Backup run id |
| `source_row_count` | integer | Source rows for this connector/day |
| `min_timeseries_id` | integer/null | Connector/day range |
| `max_timeseries_id` | integer/null | Connector/day range |
| `min_timestamp_hour_utc` | timestamp string/null | Earliest AQI hour |
| `max_timestamp_hour_utc` | timestamp string/null | Latest AQI hour |
| `parquet_object_keys` | string[] | List of parquet object keys |
| `file_count` | integer | Number of parquet parts |
| `total_bytes` | integer | Total parquet bytes |
| `files` | object[] | Per-file entries |
| `grain` | string | `hourly` |
| `history_schema_name` | string | `aqilevels_hourly` |
| `history_schema_version` | integer | `1` |
| `columns` | string[] | AQI parquet columns |
| `writer_version` | string | `parquet-wasm-zstd-v1` |
| `writer_git_sha` | string/null | Writer git SHA if available |
| `available_pollutants` | string[] | Pollutants represented in this connector/day |
| `bytes_per_row_estimate` | number/null | Derived file-size stat |
| `avg_file_bytes` | number/null | Derived file-size stat |
| `min_file_bytes` | integer/null | Derived file-size stat |
| `max_file_bytes` | integer/null | Derived file-size stat |
| `backed_up_at_utc` | timestamp string | Backup timestamp |
| `manifest_hash` | string | SHA/hash over manifest payload |

`files[]` entry fields:

| Field | Type | Notes |
|---|---|---|
| `key` | string | Parquet object key |
| `row_count` | integer | Rows in this parquet part |
| `bytes` | integer | Object size |
| `etag_or_hash` | string/null | R2 etag or content hash |
| `min_timeseries_id` | integer/null | File range |
| `max_timeseries_id` | integer/null | File range |
| `min_timestamp_hour_utc` | timestamp string/null | File coverage |
| `max_timestamp_hour_utc` | timestamp string/null | File coverage |
| `pollutant_codes` | string[] | Pollutants represented in this parquet file |

## AQI day manifest

Path:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/manifest.json
```

Top-level fields:

| Field | Type | Notes |
|---|---|---|
| `day_utc` | string date | `YYYY-MM-DD` |
| `connector_id` | null | Day-level manifest |
| `connector_ids` | integer[] | Connectors for the day |
| `run_id` | string | Backup run id |
| `source_row_count` | integer | Day total rows |
| `min_timeseries_id` | integer/null | Day range |
| `max_timeseries_id` | integer/null | Day range |
| `min_timestamp_hour_utc` | timestamp string/null | Day coverage |
| `max_timestamp_hour_utc` | timestamp string/null | Day coverage |
| `parquet_object_keys` | string[] | All parquet object keys for the day |
| `file_count` | integer | Total file count |
| `total_bytes` | integer | Total bytes |
| `files` | object[] | Flattened file entries |
| `connector_manifests` | object[] | Connector manifest summaries |
| `grain` | string | `hourly` |
| `history_schema_name` | string | `aqilevels_hourly` |
| `history_schema_version` | integer | `1` |
| `columns` | string[] | AQI parquet columns |
| `writer_version` | string | `parquet-wasm-zstd-v1` |
| `writer_git_sha` | string/null | Writer git SHA if available |
| `available_pollutants` | string[] | Pollutants represented in this day |
| `bytes_per_row_estimate` | number/null | Derived file-size stat |
| `avg_file_bytes` | number/null | Derived file-size stat |
| `min_file_bytes` | integer/null | Derived file-size stat |
| `max_file_bytes` | integer/null | Derived file-size stat |
| `backed_up_at_utc` | timestamp string | Backup timestamp |
| `manifest_hash` | string | SHA/hash over manifest payload |

`connector_manifests[]` entry fields:

| Field | Type |
|---|---|
| `connector_id` | integer |
| `manifest_key` | string |
| `source_row_count` | integer |
| `min_timeseries_id` | integer/null |
| `max_timeseries_id` | integer/null |
| `file_count` | integer |
| `total_bytes` | integer |

---

# 3. AQI history API worker response schema

The AQI history API worker reads from:

```text
history/v1/aqilevels/hourly
```

and can merge recent fallback rows from:

```text
uk_aq_public.uk_aq_timeseries_aqi_hourly
```

The default `format=compact` response returns:

| Field | Type | Notes |
|---|---|---|
| `ok` | boolean | Request status |
| `schema_version` | integer | Response schema version |
| `wire_format` | string | Usually `json` |
| `data_format` | string | `compact` or `objects` |
| `columns` | string[] | Column names for compact points |
| `points` | array[] | Compact row arrays |
| `source` | string | Source description |
| `cache_scope` | string | `recent` or `immutable` |
| `response_complete` | boolean | Whether required source windows completed |
| `generated_at_utc` | timestamp string | Generated timestamp |
| `history_prefix` | string | R2 prefix |
| `row_count` | integer | Point count |
| `coverage` | object | Diagnostics |

Each object-format row includes:

| Column |
|---|
| `period_start_utc` |
| `connector_id` |
| `timeseries_id` |
| `station_id` |
| `pollutant_code` |
| `daqi_index_level` |
| `eaqi_index_level` |
| `daqi_input_value_ugm3` |
| `daqi_input_averaging_code` |
| `eaqi_input_value_ugm3` |
| `eaqi_input_averaging_code` |
| `daqi_calculation_status` |
| `eaqi_calculation_status` |
| `source` |
| `source_coverage` |

The R2 parquet physical time field is `timestamp_hour_utc`. The API response field is `period_start_utc`.

---

# 4. Derived index objects

## Shared latest descriptors

Paths:

```text
history/_index/observations_latest.json
history/_index/aqilevels_latest.json
```

Payload fields:

| Field | Type |
|---|---|
| `schema_version` | integer |
| `generated_at` | timestamp string |
| `source` | string |
| `domain` | string |
| `bucket` | string |
| `prefix` | string |
| `min_day_utc` | string date/null |
| `max_day_utc` | string date/null |
| `day_count` | integer |
| `total_rows` | integer |
| `days` | string[] |
| `day_summaries` | object[] |

`day_summaries[]` fields:

| Field | Type |
|---|---|
| `day_utc` | string date |
| `total_rows` | integer |
| `connector_count` | integer |
| `file_count` | integer |
| `total_bytes` | integer |
| `connectors` | object[] |
| `run_id` | string/null |
| `backed_up_at_utc` | timestamp string/null |
| `manifest_hash` | string/null |
| `min_observed_at` | timestamp string/null, observations only |
| `max_observed_at` | timestamp string/null, observations only |
| `min_timestamp_hour_utc` | timestamp string/null, AQI only |
| `max_timestamp_hour_utc` | timestamp string/null, AQI only |

`connectors[]` fields:

| Field | Type |
|---|---|
| `connector_id` | integer |
| `row_count` | integer |
| `file_count` | integer |
| `total_bytes` | integer |
| `manifest_key` | string |

## Observations timeseries index

Latest descriptor path:

```text
history/_index/observations_timeseries_latest.json
```

Per-connector index path:

```text
history/_index/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

Latest descriptor fields:

| Field | Type |
|---|---|
| `schema_version` | integer |
| `generated_at` | timestamp string |
| `source` | string, usually `r2_connector_manifests` |
| `domain` | string, `observations` |
| `index_kind` | string, `timeseries_file_ranges` |
| `bucket` | string |
| `observations_prefix` | string |
| `index_prefix` | string |
| `min_day_utc` | string date/null |
| `max_day_utc` | string date/null |
| `day_count` | integer |
| `connector_index_count` | integer |
| `file_count` | integer |
| `indexed_file_count` | integer |
| `days` | string[] |
| `key_layout.connector_index_manifest_key_template` | string |
| `key_layout.latest_key` | string |
| `day_summaries` | object[] |

`day_summaries[]` fields:

| Field | Type |
|---|---|
| `day_utc` | string date |
| `connector_count` | integer |
| `connector_ids` | integer[] |

Per-connector observations index manifest fields:

| Field | Type |
|---|---|
| `schema_version` | integer |
| `generated_at` | timestamp string |
| `source` | string, usually `r2_connector_manifest` |
| `domain` | string, `observations` |
| `index_kind` | string, `timeseries_file_ranges` |
| `bucket` | string |
| `observations_prefix` | string |
| `day_utc` | string date |
| `connector_id` | integer |
| `connector_manifest_key` | string |
| `connector_manifest_hash` | string/null |
| `source_row_count` | integer |
| `file_count` | integer |
| `indexed_file_count` | integer |
| `index_coverage` | string, `complete` or `partial` |
| `min_timeseries_id` | integer/null |
| `max_timeseries_id` | integer/null |
| `files` | object[] |
| `backed_up_at_utc` | timestamp string/null |

`files[]` fields:

| Field | Type |
|---|---|
| `key` | string |
| `row_count` | integer |
| `bytes` | integer |
| `etag_or_hash` | string/null |
| `min_timeseries_id` | integer/null |
| `max_timeseries_id` | integer/null |
| `min_observed_at` | timestamp string/null |
| `max_observed_at` | timestamp string/null |

## AQI levels timeseries index

Latest descriptor path:

```text
history/_index/aqilevels_timeseries_latest.json
```

Per-connector index path:

```text
history/_index/aqilevels_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

Per-connector AQI index manifest fields:

| Field | Type |
|---|---|
| `schema_version` | integer |
| `generated_at` | timestamp string |
| `source` | string, usually `r2_connector_manifest` |
| `domain` | string, `aqilevels` |
| `index_kind` | string, `timeseries_file_ranges` |
| `bucket` | string |
| `aqilevels_prefix` | string |
| `day_utc` | string date |
| `connector_id` | integer |
| `connector_manifest_key` | string |
| `connector_manifest_hash` | string/null |
| `source_row_count` | integer |
| `file_count` | integer |
| `indexed_file_count` | integer |
| `index_coverage` | string, `complete` or `partial` |
| `available_pollutants` | string[] |
| `min_timeseries_id` | integer/null |
| `max_timeseries_id` | integer/null |
| `files` | object[] |
| `backed_up_at_utc` | timestamp string/null |

`files[]` fields:

| Field | Type |
|---|---|
| `key` | string |
| `row_count` | integer |
| `bytes` | integer |
| `etag_or_hash` | string/null |
| `pollutant_codes` | string[] |

## R2 history v2 pollutant timeseries indexes

The v2 index builder is explicit: run
`scripts/backup_r2/uk_aq_build_r2_history_index.mjs --history-version v2`.
It does not change v1 runtime readers or v1 index paths.

Latest descriptor paths:

```text
history/_index_v2/observations_timeseries_latest.json
history/_index_v2/aqilevels_hourly_data_timeseries_latest.json
```

Per-pollutant index paths:

```text
history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
```

The index is built from v2 data manifests only:

- observations data: `history/v2/observations`
- AQI hourly compact data: `history/v2/aqilevels/hourly/data`

No debug AQI v2 indexes are built under `_index_v2`.

For v2 AQI hourly data, source pollutant manifests must include top-level
`timeseries_row_counts`: a JSON object mapping each valid positive
`timeseries_id` to the number of AQI hourly rows in that
day/connector/pollutant partition. New AQI v2 writer paths emit this map on the
pollutant and connector manifests while keeping duplicate per-file maps out of
final `files[]` entries.

If a non-empty v2 AQI pollutant manifest is missing usable
`timeseries_row_counts`, treat it as a manifest integrity issue. The index
builder warns by default, can fail with `--strict-missing-timeseries-counts`,
and can repair older affected manifests with
`--compute-missing-timeseries-counts`. Targeted v2 timeseries index updates
refresh the direct `history/_index_v2/timeseries` metadata objects after the
domain indexes are updated. That metadata rebuild is derived from existing v2
timeseries index manifests and does not read parquet.

The observations history API Worker reads this v2 layout only when
`UK_AQ_R2_HISTORY_READ_VERSION=v2`. In that mode, requests must include a
`pollutant` query parameter (`pm25`, `pm10`, or `no2`) so the Worker can read
the exact per-pollutant index and parquet partition. With the default
`UK_AQ_R2_HISTORY_READ_VERSION=v1`, the Worker keeps using the v1 observations
prefix and v1 observations timeseries index variables.

Latest descriptor fields:

| Field | Type |
|---|---|
| `schema_version` | integer, `3` |
| `generated_at` | timestamp string, data-driven |
| `source` | string, `r2_pollutant_manifests` |
| `history_version` | string, `v2` |
| `domain` | string, `observations` or `aqilevels` |
| `grain` | string/null, `hourly` for AQI |
| `profile` | string/null, `data` for AQI |
| `index_kind` | string, `timeseries_file_ranges` |
| `bucket` | string |
| `data_prefix` | string |
| `index_prefix` | string |
| `min_day_utc` | string date/null |
| `max_day_utc` | string date/null |
| `day_count` | integer |
| `total_rows` | integer, sum of `day_summaries[].connectors[].row_count` |
| `connector_index_count` | integer |
| `pollutant_index_count` | integer |
| `file_count` | integer |
| `indexed_file_count` | integer |
| `days` | string[] |
| `key_layout.pollutant_index_manifest_key_template` | string |
| `key_layout.latest_key` | string |
| `day_summaries` | object[] |

`day_summaries[]` fields:

| Field | Type |
|---|---|
| `day_utc` | string date |
| `connector_count` | integer |
| `connector_ids` | integer[] sorted ascending |
| `connectors` | object[] sorted by `connector_id` |
| `connectors[].connector_id` | integer |
| `connectors[].row_count` | integer, actual source row count summed from v2 pollutant manifests |
| `total_rows` | integer |
| `pollutant_codes` | string[] sorted ascending |
| `pollutant_index_count` | integer |
| `file_count` | integer |
| `indexed_file_count` | integer |
| `backed_up_at_utc` | timestamp string/null |

Per-pollutant index manifest fields:

| Field | Type |
|---|---|
| `schema_version` | integer, `2` |
| `generated_at` | timestamp string, data-driven from pollutant manifest |
| `source` | string, `r2_pollutant_manifest` |
| `history_version` | string, `v2` |
| `domain` | string |
| `grain` | string/null |
| `profile` | string/null |
| `index_kind` | string, `timeseries_file_ranges` |
| `bucket` | string |
| `day_utc` | string date |
| `connector_id` | integer |
| `pollutant_code` | string |
| `data_prefix` | string |
| `pollutant_manifest_key` | string |
| `connector_pollutant_manifest_key` | string |
| `pollutant_manifest_hash` | string/null |
| `source_row_count` | integer |
| `timeseries_row_counts` | object/null |
| `file_count` | integer |
| `indexed_file_count` | integer |
| `index_coverage` | string, `complete` or `partial` |
| `min_timeseries_id` | integer/null |
| `max_timeseries_id` | integer/null |
| `min_observed_at_utc` | timestamp string/null, observations only |
| `max_observed_at_utc` | timestamp string/null, observations only |
| `min_timestamp_hour_utc` | timestamp string/null, AQI only |
| `max_timestamp_hour_utc` | timestamp string/null, AQI only |
| `files` | object[] |
| `backed_up_at_utc` | timestamp string/null |
| `min_timeseries_id` | integer/null |
| `max_timeseries_id` | integer/null |
| `min_timestamp_hour_utc` | timestamp string/null |
| `max_timestamp_hour_utc` | timestamp string/null |

---

# 5. Core snapshot objects

Paths:

```text
history/v1/core/day_utc=YYYY-MM-DD/manifest.json
history/v1/core/day_utc=YYYY-MM-DD/checksums.sha256
history/v1/core/day_utc=YYYY-MM-DD/table=<table>/rows.ndjson.gz
```

For R2 history Dropbox backup v2 mode, core snapshots are expected under the
matching v2 backup prefix once v2 writes are active:

```text
history/v2/core/day_utc=YYYY-MM-DD/manifest.json
history/v2/core/day_utc=YYYY-MM-DD/checksums.sha256
history/v2/core/day_utc=YYYY-MM-DD/table=<table>/rows.ndjson.gz
```

The v2 backup inventory reports missing `history/v2/core` coverage as a warning
and does not silently fall back to `history/v1/core`.

Core manifest fields:

| Field | Type |
|---|---|
| `schema_name` | string, `uk_aq_core_snapshot` |
| `schema_version` | integer, `1` |
| `generated_at_utc` | timestamp string |
| `day_utc` | string date |
| `source_schema` | string |
| `prefix` | string |
| `file_format` | string |
| `tables` | object[] |
| `totals` | object |
| `checksums` | object |
| `manifest_hash` | string |

`tables[]` entry fields:

| Field | Type |
|---|---|
| `table` | string |
| `order_by` | string[] |
| `key` | string |
| `relative_path` | string |
| `row_count` | integer |
| `uncompressed_bytes` | integer |
| `compressed_bytes` | integer |
| `sha256` | string |
| `sha256_uncompressed` | string |

---

# 6. Operational objects

## Phase B run manifest

Path:

```text
history/v1/_ops/observations/runs/run_id=<uuid>/run_manifest.json
```

Fields:

| Field | Type |
|---|---|
| `run_id` | string |
| `backed_up_at_utc` | timestamp string |
| `summary` | object |
| `manifest_hash` | string |

---

# 7. DuckDB helper SQL

## Describe local observations parquet schema

```sql
DESCRIBE SELECT *
FROM read_parquet(
  '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/observations/day_utc=*/connector_id=*/*.parquet',
  union_by_name = true
);
```

## Describe local AQI levels parquet schema

```sql
DESCRIBE SELECT *
FROM read_parquet(
  '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=*/connector_id=*/*.parquet',
  union_by_name = true
);
```

## Create AQI levels view for March/April 2026

```sql
CREATE OR REPLACE VIEW r2_aqilevels_mar_apr_2026 AS
SELECT *
FROM read_parquet([
  '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-03-*/connector_id=*/*.parquet',
  '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-04-*/connector_id=*/*.parquet'
], union_by_name = true);
```

## Check PM2.5 AQI fallback for station 1575, timeseries 354

```sql
WITH src AS (
  SELECT *
  FROM read_parquet([
    '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-03-*/connector_id=*/*.parquet',
    '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-04-*/connector_id=*/*.parquet'
  ], union_by_name = true)
  WHERE station_id = 1575
    AND timeseries_id = 354
    AND pollutant_code = 'pm25'
)
SELECT
  timestamp_hour_utc,
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,

  daqi_pm25_rolling24h_index_level,
  daqi_index_level,
  COALESCE(daqi_pm25_rolling24h_index_level, daqi_index_level) AS resolved_daqi_for_pm25,

  eaqi_pm25_index_level,
  eaqi_index_level,
  COALESCE(eaqi_pm25_index_level, eaqi_index_level) AS resolved_eaqi_for_pm25,

  CASE
    WHEN daqi_pm25_rolling24h_index_level IS NULL
     AND daqi_index_level IS NOT NULL
    THEN 'DAQI fallback needed'
    ELSE ''
  END AS daqi_status,

  CASE
    WHEN eaqi_pm25_index_level IS NULL
     AND eaqi_index_level IS NOT NULL
    THEN 'EAQI fallback needed'
    ELSE ''
  END AS eaqi_status

FROM src
WHERE daqi_pm25_rolling24h_index_level IS NULL
   OR eaqi_pm25_index_level IS NULL
   OR daqi_index_level IS NULL
   OR eaqi_index_level IS NULL
ORDER BY timestamp_hour_utc;
```

## Count PM2.5 AQI fallback patterns

```sql
WITH src AS (
  SELECT *
  FROM read_parquet([
    '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-03-*/connector_id=*/*.parquet',
    '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-04-*/connector_id=*/*.parquet'
  ], union_by_name = true)
  WHERE station_id = 1575
    AND timeseries_id = 354
    AND pollutant_code = 'pm25'
)
SELECT
  COUNT(*) AS total_rows,

  COUNT(*) FILTER (
    WHERE daqi_pm25_rolling24h_index_level IS NULL
      AND daqi_index_level IS NOT NULL
  ) AS daqi_pm25_specific_null_but_generic_populated,

  COUNT(*) FILTER (
    WHERE eaqi_pm25_index_level IS NULL
      AND eaqi_index_level IS NOT NULL
  ) AS eaqi_pm25_specific_null_but_generic_populated,

  COUNT(*) FILTER (
    WHERE daqi_pm25_rolling24h_index_level IS NULL
      AND daqi_index_level IS NULL
  ) AS daqi_specific_and_generic_both_null,

  COUNT(*) FILTER (
    WHERE eaqi_pm25_index_level IS NULL
      AND eaqi_index_level IS NULL
  ) AS eaqi_specific_and_generic_both_null,

  COUNT(*) FILTER (
    WHERE COALESCE(daqi_pm25_rolling24h_index_level, daqi_index_level) IS NULL
  ) AS resolved_daqi_null,

  COUNT(*) FILTER (
    WHERE COALESCE(eaqi_pm25_index_level, eaqi_index_level) IS NULL
  ) AS resolved_eaqi_null,

  MIN(timestamp_hour_utc) AS first_timestamp_hour_utc,
  MAX(timestamp_hour_utc) AS last_timestamp_hour_utc

FROM src;
```

## Exact hourly gap check after fallback

```sql
WITH src AS (
  SELECT
    timestamp_hour_utc,
    COALESCE(daqi_pm25_rolling24h_index_level, daqi_index_level) AS resolved_daqi_for_pm25,
    COALESCE(eaqi_pm25_index_level, eaqi_index_level) AS resolved_eaqi_for_pm25
  FROM read_parquet([
    '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-03-*/connector_id=*/*.parquet',
    '/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v1/aqilevels/hourly/day_utc=2026-04-*/connector_id=*/*.parquet'
  ], union_by_name = true)
  WHERE station_id = 1575
    AND timeseries_id = 354
    AND pollutant_code = 'pm25'
),
bounds AS (
  SELECT
    MIN(timestamp_hour_utc) AS min_ts,
    MAX(timestamp_hour_utc) AS max_ts
  FROM src
),
expected_hours AS (
  SELECT hour_utc
  FROM bounds,
       generate_series(min_ts, max_ts, INTERVAL 1 HOUR) AS t(hour_utc)
)
SELECT
  e.hour_utc,
  s.resolved_daqi_for_pm25,
  s.resolved_eaqi_for_pm25,
  CASE
    WHEN s.timestamp_hour_utc IS NULL THEN 'missing row'
    WHEN s.resolved_daqi_for_pm25 IS NULL AND s.resolved_eaqi_for_pm25 IS NULL THEN 'resolved DAQI and EAQI null'
    WHEN s.resolved_daqi_for_pm25 IS NULL THEN 'resolved DAQI null'
    WHEN s.resolved_eaqi_for_pm25 IS NULL THEN 'resolved EAQI null'
    ELSE ''
  END AS gap_status
FROM expected_hours e
LEFT JOIN src s
  ON s.timestamp_hour_utc = e.hour_utc
WHERE s.timestamp_hour_utc IS NULL
   OR s.resolved_daqi_for_pm25 IS NULL
   OR s.resolved_eaqi_for_pm25 IS NULL
ORDER BY e.hour_utc;
```

---

# 8. Quick fieldname checklist

## Physical R2 observations parquet

```text
connector_id
timeseries_id
observed_at
value
```

## Physical R2 AQI parquet

```text
connector_id
timeseries_id
station_id
pollutant_code
timestamp_hour_utc
no2_hourly_mean_ugm3
pm25_hourly_mean_ugm3
pm10_hourly_mean_ugm3
pm25_rolling24h_mean_ugm3
pm10_rolling24h_mean_ugm3
hourly_sample_count
daqi_index_level
eaqi_index_level
daqi_no2_index_level
daqi_pm25_rolling24h_index_level
daqi_pm10_rolling24h_index_level
eaqi_no2_index_level
eaqi_pm25_index_level
eaqi_pm10_index_level
```

## AQI API response object fields

```text
period_start_utc
timeseries_id
station_id
daqi_index_level
eaqi_index_level
daqi_no2_index_level
daqi_pm25_rolling24h_index_level
daqi_pm10_rolling24h_index_level
eaqi_no2_index_level
eaqi_pm25_index_level
eaqi_pm10_index_level
```
