# AQI levels interfaces

## Purpose

This file protects the normalized AQI row, R2 object, private Worker and website-consumer interfaces used by the active AQI levels system.

A timestamp correction must be coordinated across these interfaces. It must not silently change only one producer or consumer.

## Shared normalized hourly row

The shared calculation library emits one normalized row per canonical AQI key.

Core columns are:

| Field | Type | Meaning |
|---|---|---|
| `connector_id` | positive integer | Connector identity |
| `station_id` | positive integer | Station identity |
| `timeseries_id` | positive integer | Timeseries identity |
| `pollutant_code` | `pm25`, `pm10`, `no2` | Canonical pollutant |
| `timestamp_hour_utc` | UTC timestamp | Canonical interval endpoint |
| `daqi_input_value_ugm3` | number or null | DAQI calculation input |
| `daqi_input_averaging_code` | string | `hourly_mean` or `rolling_24h_mean` |
| `daqi_index_level` | integer 1–10 or null | UK DAQI level |
| `daqi_source_observation_count` | integer or null | Source count used |
| `daqi_required_observation_count` | integer | Required count, normally 1 or 24 |
| `daqi_calculation_status` | string | Normalized status |
| `daqi_missing_reason` | string or null | Stable diagnostic reason |
| `eaqi_input_value_ugm3` | number or null | European AQI hourly input |
| `eaqi_input_averaging_code` | `hourly_mean` | European AQI averaging |
| `eaqi_index_level` | integer 1–6 or null | European AQI level |
| `eaqi_source_observation_count` | integer or null | Source count used |
| `eaqi_required_observation_count` | integer | Required count, normally 1 |
| `eaqi_calculation_status` | string | Normalized status |
| `eaqi_missing_reason` | string or null | Stable diagnostic reason |
| `hourly_sample_count` | integer or null | Samples contributing to hourly mean |
| `algorithm_version` | string | Calculation algorithm identifier |
| `computed_at_utc` | timestamp or null | Calculation time where persisted |

Compatibility fields for pollutant-specific hourly and rolling values may also exist in database/debug rows. They must remain consistent with the normalized fields.

## Required timestamp meaning

`timestamp_hour_utc` is not a period start.

```text
period_start_utc = timestamp_hour_utc - 1 hour
period_end_utc   = timestamp_hour_utc
```

Any interface that renames or projects the timestamp must preserve that meaning explicitly.

## Obs AQI database hourly table

Canonical table:

```text
uk_aq_aqilevels.timeseries_aqi_hourly
```

Current primary key:

```text
(timeseries_id, timestamp_hour_utc)
```

The table stores the normalized DAQI and European AQI fields plus compatibility columns.

The public service-role boundary includes:

```text
uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_upsert
```

The retired Cloud Run updater that called this RPC is not an active runtime component. The table remains a possible recent fallback/source only where current Workers explicitly query it.

## Prune Daily v2 data profile

Canonical prefix:

```text
history/v2/aqilevels/hourly/data
```

Canonical parquet columns:

- `connector_id`;
- `station_id`;
- `timeseries_id`;
- `pollutant_code`;
- `timestamp_hour_utc`;
- `daqi_index_level`;
- `eaqi_index_level`;
- `daqi_calculation_status`;
- `daqi_missing_reason`;
- `eaqi_calculation_status`;
- `eaqi_missing_reason`.

The data profile is the bounded history-read profile. Removing status or missing-reason fields would make null levels ambiguous and is a contract change.

## Prune Daily v2 debug profile

Canonical prefix:

```text
history/v2/aqilevels/hourly/debug
```

Canonical debug columns add:

- `daqi_input_value_ugm3`;
- `daqi_input_averaging_code`;
- `daqi_source_observation_count`;
- `daqi_required_observation_count`;
- `eaqi_input_value_ugm3`;
- `eaqi_input_averaging_code`;
- `eaqi_source_observation_count`;
- `eaqi_required_observation_count`;
- `hourly_sample_count`;
- `algorithm_version`;
- `computed_at_utc`.

Debug rows use the same canonical key and index outcomes as data rows.

## v2 object hierarchy

Typical pollutant-part path:

```text
history/v2/aqilevels/hourly/{profile}/day_utc=YYYY-MM-DD/connector_id=NN/pollutant_code={pollutant}/part-NNNNN.parquet
```

Required manifest hierarchy:

```text
history/v2/aqilevels/hourly/{profile}/day_utc=YYYY-MM-DD/connector_id=NN/pollutant_code={pollutant}/manifest.json
history/v2/aqilevels/hourly/{profile}/day_utc=YYYY-MM-DD/connector_id=NN/manifest.json
history/v2/aqilevels/hourly/{profile}/day_utc=YYYY-MM-DD/manifest.json
```

The exact part numbering is implementation detail. Prefixes, identity partitioning and manifest hierarchy are contract-bearing.

## v2 AQI indexes

Public data timeseries index prefix:

```text
history/_index_v2/aqilevels_hourly_data_timeseries
```

Typical scoped index:

```text
history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=NN/pollutant_code={pollutant}/manifest.json
```

Timeseries metadata prefix:

```text
history/_index_v2/timeseries
```

Typical metadata key:

```text
history/_index_v2/timeseries/timeseries_id=NN.json
```

Required-index mode must fail boundedly with structured partial diagnostics when index context is absent. It must not fall back to scanning every connector and parquet object.

## Private AQI History R2 API Worker

Component:

```text
workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
```

Canonical route:

```text
GET /v1/aqi-history
```

Alias:

```text
GET /
```

Required request identity:

- `timeseries_id`, with accepted legacy aliases where currently supported;
- `pollutant`, required and restricted to `pm25`, `pm10`, `no2`.

Fixed request semantics:

- `scope=timeseries`;
- `grain=hourly`;
- explicit `from_utc` and `to_utc`, accepted aliases, or a bounded `days` lookback;
- `row_limit` within the configured maximum;
- `format=compact`, `objects` or `tsv` where retained for compatibility.

Private authentication header:

```text
x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>
```

## AQI History response row

The current normalized response columns are:

- `period_start_utc`;
- `connector_id`;
- `station_id`;
- `timeseries_id`;
- `pollutant_code`;
- `daqi_index_level`;
- `eaqi_index_level`;
- `daqi_input_value_ugm3`;
- `daqi_input_averaging_code`;
- `eaqi_input_value_ugm3`;
- `eaqi_input_averaging_code`;
- `daqi_calculation_status`;
- `eaqi_calculation_status`;
- `source`;
- `source_coverage`.

### Known timestamp contract defect

The current Worker assigns stored `timestamp_hour_utc` directly to `period_start_utc`. Under the authoritative hour-ending contract, that value is actually `period_end_utc`.

The corrected interface must provide unambiguous boundaries:

```text
period_start_utc = timestamp_hour_utc - 1 hour
period_end_utc   = timestamp_hour_utc
```

The correction must be coordinated with station-history and website consumers. Adding, renaming or changing these fields without coordinated deployment is not permitted.

## AQI History response metadata

JSON responses retain explicit coverage information including:

- `response_complete`;
- `has_gap`;
- `coverage_state`;
- `partial_reasons`;
- source and source-coverage counts;
- row summaries;
- timeseries-index diagnostics;
- scan metrics and stop reasons;
- cache scope;
- cache hit/miss marker.

Clients must use completeness fields rather than infer completeness from HTTP 200 or row count.

## Private station-history Worker

Component:

```text
workers/uk_aq_station_history/
```

It has no public route or custom domain. The cache proxy reaches it through the `STATION_HISTORY` Service Binding.

Internal routes:

```text
GET /v1/station-series
GET /v1/aqi-history
GET /v1/observations-history
```

### Station-series request

Required or governed fields include:

- `timeseries_id`;
- optional supplied `connector_id`, which must agree with authoritative identity;
- `pollutant`, which must agree with authoritative identity;
- `start_utc`;
- `end_utc`;
- `format=objects`;
- `include_aqi`, enabled by default;
- current window label where supplied.

### Station-series response

Top-level sections include:

- `schema_version`;
- normalized authoritative `request` and `identity`;
- `source` diagnostics;
- `aqi`;
- `observations`.

The `aqi` section includes:

- `enabled`;
- `rows`;
- `response_complete`;
- `has_gap`;
- `gap_ranges`;
- stable-head boundaries;
- backwards pagination cursor;
- replacement policy;
- source counts;
- availability diagnostics;
- overlap and mismatch diagnostics.

The `observations` section has independent rows, completeness, gaps, source counts and pagination state.

AQI and observations must not be collapsed into one completeness flag internally.

## History chunk interface

Older AQI chunks:

- are bounded to the configured maximum hours;
- end at or before the stable-head start;
- are returned in ascending row order;
- paginate newest-first through `next_older_chunk_end_utc`;
- extend backwards only;
- are immutable or mutable according to the configured mutable horizon;
- remain non-cacheable when incomplete.

The expected endpoint set for a represented chunk is `start < n <= end`, even where current code still encodes the old boundary convention.

## Cache proxy boundary

The cache proxy owns:

- browser authentication;
- CORS;
- feature-flag routing;
- public cache keys and TTLs;
- stale-fallback policy;
- upstream error normalization.

The AQI timestamp correction must not bypass the private station-history Service Binding or create a second public AQI calculation path.

## Website loader interface

`station-history-loader.js` currently normalizes an AQI timestamp from:

1. `period_start_utc`;
2. `timestamp_hour_utc`;
3. `observed_at`.

After the interval correction, the loader must retain explicit start and end boundaries or derive them from the canonical endpoint. It must not continue treating the endpoint as the period start.

Stable-head precedence, older-chunk no-replacement behaviour and independent observation merging must remain unchanged.

## Website rendering interface

Both station chart implementations consume normalized DAQI and European AQI points.

Mandatory rendering contract:

```text
row endpoint n
rectangle x1 = n - 1 hour
rectangle x2 = n
```

A renderer must not calculate `x2=n+1 hour` for an hour-ending row.

## Compatibility rule

A change to any field, route, path, authentication header, source-precedence rule, completeness field, endpoint meaning or website interval boundary in this file requires an explicit compatibility review.

A coordinated timestamp correction may deliberately amend timestamp fields, but it must preserve all unrelated interface behaviour.