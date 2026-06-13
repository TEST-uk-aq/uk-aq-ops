UK AQ R2 History Layout

Generated: 2026-06-09  
Repository checked: `ChronicChannel-test/uk-aq-ops`  
Primary code source: `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`  
Primary layout source: `system_docs/uk-aq-r2-history-layout.md`

## Important notes

This file is a practical R2 schema/reference file for local DuckDB checks and Codex prompts.

The canonical R2 layout document says the actual object tree, manifest shapes, and derived index payloads are defined by the ops writers and readers in `uk-aq-ops`.

For parquet columns, this file follows the current writer code in `phase_b_history_r2.mjs`.

The AQI section of `system_docs/uk-aq-r2-history-layout.md` appears older for AQI parquet columns because it lists generic `hourly_mean_ugm3` and `rolling24h_mean_ugm3`. The current writer code writes pollutant-expanded mean columns instead:

- `no2_hourly_mean_ugm3`
- `pm25_hourly_mean_ugm3`
- `pm10_hourly_mean_ugm3`
- `pm25_rolling24h_mean_ugm3`
- `pm10_rolling24h_mean_ugm3`

## Bucket selection

Bucket selection is deployment-specific.

Known bucket env/config names from the R2 layout docs:

- `R2_BUCKET`
- `CFLARE_R2_BUCKET`
- `R2_BUCKET_PROD`
- `R2_BUCKET_STAGE`
- `R2_BUCKET_DEV`

## Stable top-level prefixes

```text
history/v1/observations
history/v1/aqilevels/hourly
history/v1/core
history/_index
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

## AQI levels parquet schema

Metadata:

```text
history_schema_name: aqilevels
history_schema_version: 2
writer_version: parquet-wasm-zstd-v2
writer_columns_constant: HISTORY_AQILEVELS_COLUMNS
```

Columns, in current writer order:

| Ordinal | Column | DuckDB-friendly type | Notes |
|---:|---|---|---|
| 1 | `connector_id` | INTEGER | Connector id |
| 2 | `timeseries_id` | INTEGER | Timeseries id |
| 3 | `station_id` | INTEGER | Nullable |
| 4 | `pollutant_code` | VARCHAR | Expected examples: `pm25`, `pm10`, `no2` |
| 5 | `timestamp_hour_utc` | TIMESTAMP | AQI hour |
| 6 | `no2_hourly_mean_ugm3` | DOUBLE | Nullable |
| 7 | `pm25_hourly_mean_ugm3` | DOUBLE | Nullable |
| 8 | `pm10_hourly_mean_ugm3` | DOUBLE | Nullable |
| 9 | `pm25_rolling24h_mean_ugm3` | DOUBLE | Nullable |
| 10 | `pm10_rolling24h_mean_ugm3` | DOUBLE | Nullable |
| 11 | `hourly_sample_count` | INTEGER | Nullable |
| 12 | `daqi_index_level` | INTEGER | Generic DAQI for the row/pollutant context |
| 13 | `eaqi_index_level` | INTEGER | Generic EAQI for the row/pollutant context |
| 14 | `daqi_no2_index_level` | INTEGER | NO2-specific DAQI |
| 15 | `daqi_pm25_rolling24h_index_level` | INTEGER | PM2.5-specific DAQI using 24h rolling mean |
| 16 | `daqi_pm10_rolling24h_index_level` | INTEGER | PM10-specific DAQI using 24h rolling mean |
| 17 | `eaqi_no2_index_level` | INTEGER | NO2-specific EAQI |
| 18 | `eaqi_pm25_index_level` | INTEGER | PM2.5-specific EAQI |
| 19 | `eaqi_pm10_index_level` | INTEGER | PM10-specific EAQI |

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
| `history_schema_name` | string | `aqilevels` |
| `history_schema_version` | integer | `2` |
| `columns` | string[] | AQI parquet columns |
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
| `min_timestamp_hour_utc` | timestamp string/null | File coverage |
| `max_timestamp_hour_utc` | timestamp string/null | File coverage |

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
| `history_schema_name` | string | `aqilevels` |
| `history_schema_version` | integer | `2` |
| `columns` | string[] | AQI parquet columns |
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
| `timeseries_id` |
| `station_id` |
| `daqi_index_level` |
| `eaqi_index_level` |
| `daqi_no2_index_level` |
| `daqi_pm25_rolling24h_index_level` |
| `daqi_pm10_rolling24h_index_level` |
| `eaqi_no2_index_level` |
| `eaqi_pm25_index_level` |
| `eaqi_pm10_index_level` |

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
