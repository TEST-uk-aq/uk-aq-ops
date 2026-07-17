# AQI history write pipeline

## Purpose

This document defines the current required behaviour of the R2 v2 AQI history writer used by Prune Daily Phase B.

It covers:

- target-day observation source ownership;
- the separate ObsAQIDB PM rolling-context read;
- AQI calculation and output boundaries;
- v2 data and debug objects;
- manifests, targeted indexes and completion gates;
- failure, retry and recovery behaviour.

AQI formulae and public read behaviour remain owned by their respective AQI and API components.

## Implementation ownership

The main implementation files are:

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`;
- `lib/aqi/aqi_levels.mjs`;
- `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`;
- `config/uk_aq_github_env_targets.csv`.

The ObsAQIDB PM context RPC is owned by `TEST-uk-aq/uk-aq-schema` and is version-controlled in:

- `schemas/migrations/20260717_001_obs_aqidb_pm_hourly_context_rpc.sql`;
- `schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql`;
- `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`.

## Source ownership

Phase B deliberately uses two observation sources for different purposes.

### Target-day source

IngestDB is authoritative for the connector and UTC day being archived.

The frozen target-day source covers:

```text
D 00:00 inclusive to D+1 00:00 exclusive
```

The same frozen rows feed:

- the permanent R2 observation write for D;
- the target-day hourly inputs used by the AQI calculation.

ObsAQIDB MUST NOT replace this target-day source. This preserves the existing fingerprint-repair, candidate row-count, checkpoint, manifest and prune-gate contract.

### PM rolling-context source

ObsAQIDB supplies only the older PM2.5 and PM10 hourly aggregates required to start D with a complete rolling window.

For target day D, the context window is:

```text
D-1 01:00 inclusive to D 00:00 exclusive
```

This is exactly 23 older UTC hours. Combined with the target hour, it permits the shared AQI library to calculate PM DAQI for D 00:00.

NO2 does not use this context. NO2 DAQI and EAQI continue to use the target hour's hourly mean.

### Context is calculation-only

ObsAQIDB context rows MUST NOT:

- be written to the target day's R2 observation partition;
- increase the target-day observation candidate count;
- alter observation checkpoints or manifests;
- produce AQI output rows before D 00:00;
- make a connector/day a supported AQI source when D contains no supported target-day observations.

## Writer selection

Exactly one Phase B AQI writer mode MUST be enabled:

- observation-derived AQI; or
- the legacy materialised-AQI RPC export.

Both enabled and both disabled are invalid and fail closed.

The current R2-first TEST configuration is expected to use:

```text
UK_AQ_R2_HISTORY_VERSION=v2
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=false
```

## Observation-derived calculation flow

For each target connector/day, Phase B MUST:

1. stream and freeze target-day observations from IngestDB;
2. write only those target-day observations to the canonical v2 observation layout;
3. select supported target-day PM2.5, PM10 and NO2 rows;
4. aggregate target-day observations to hourly rows through `lib/aqi/aqi_levels.mjs`;
5. identify target-day PM timeseries requiring older context;
6. fetch the preceding 23 hourly PM aggregates from ObsAQIDB;
7. discard context rows that do not match a target-day PM timeseries and pollutant;
8. merge context and target-day rows by `timeseries_id + pollutant_code + timestamp_hour_utc`;
9. prefer the target-day IngestDB-derived row if an overlap occurs;
10. calculate DAQI and EAQI through the shared AQI library;
11. restrict final AQI output to target day D;
12. write canonical v2 AQI data and debug objects;
13. write connector and day manifests;
14. build and verify the required targeted indexes;
15. set `history_done=true` only after every required gate succeeds.

The writer MUST compose the shared AQI helpers. It MUST NOT copy breakpoints or implement a second rolling-average algorithm.

## Shared AQI behaviour

The shared AQI library remains authoritative for:

- pollutant normalisation;
- raw observation hourly aggregation;
- PM rolling 24-hour calculations;
- DAQI and EAQI breakpoints;
- required source-hour counts;
- calculation statuses and missing reasons;
- algorithm version.

PM DAQI requires 24 available hourly values in:

```text
H-23 hours through H
```

A complete source read with genuine missing hours is not an infrastructure failure. The affected row uses:

```text
daqi_calculation_status=insufficient_samples
daqi_missing_reason=insufficient_rolling_24h_hours
daqi_index_level=null
```

EAQI continues to use the current hourly mean and may therefore be available when PM DAQI is not.

## ObsAQIDB PM context RPC

The default RPC is:

```text
uk_aq_public.uk_aq_rpc_observs_aqi_pm_hourly_context
```

It is called through PostgREST with the ObsAQIDB service-role key.

### Inputs

```text
p_connector_id
p_start_utc
p_end_utc
p_after_timeseries_id
p_after_timestamp_hour_utc
p_limit
```

### Output

Rows are ordered by `timeseries_id, timestamp_hour_utc` and contain:

```text
connector_id
station_id
timeseries_id
pollutant_code
timestamp_hour_utc
hourly_mean_ugm3
sample_count
```

### Required interface behaviour

The RPC MUST:

- require `service_role`;
- read ObsAQIDB observations and authoritative timeseries metadata;
- accept only a positive connector ID;
- require hour-aligned start and end timestamps;
- reject an empty, reversed or longer-than-24-hour window;
- require both cursor fields together or neither;
- return only `pm25` and `pm10`;
- ignore null and negative observation values;
- use UTC hourly buckets matching the JavaScript AQI library;
- aggregate an hourly mean and sample count;
- order output for stable keyset pagination;
- clamp `p_limit` to the range 1 to 5000;
- return an empty array when no qualifying rows exist;
- remain unavailable to `public`, `anon` and `authenticated` roles.

The caller validates returned identifiers, pollutant, UTC hour alignment, requested window, hourly mean, sample count, order and uniqueness. Invalid output fails the candidate.

## Pagination and bounded reads

The caller uses keyset pagination with:

```text
after timeseries_id
after timestamp_hour_utc
```

The default runtime limits are:

```text
UK_AQ_PHASE_B_PM_CONTEXT_PAGE_SIZE=1000
UK_AQ_PHASE_B_PM_CONTEXT_MAX_PAGES=100
UK_AQ_PHASE_B_PM_CONTEXT_MAX_ROWS=50000
```

These limits bound PostgREST calls and memory use. Reaching a page or row cap before a complete response is a failure, not a partial success.

The current RPC reads the connector/window PM scope. The service then accepts only rows matching target-day PM timeseries. Operators should monitor:

```text
pm_context_rows_fetched
pm_context_rows_accepted
pm_context_rows_discarded
```

A cap failure requires either a safe configuration adjustment or a more selective RPC contract. It MUST NOT be bypassed by accepting a truncated response.

## ObsAQIDB retention guard

Before requesting context, Phase B calculates the ObsAQIDB retention boundary from:

```text
OBS_AQIDB_OBSERVS_RETENTION_DAYS
```

The default is 14 days. The boundary calculation matches the daily partition-maintenance retention semantics.

If the required context start is older than the UTC retention boundary, the candidate fails. Phase B does not attempt an incomplete calculation and the day remains blocked from pruning.

A normal Phase B candidate should be inside this boundary because ObsAQIDB retains observations longer than IngestDB. An older pending candidate requires rebuild from another authoritative retained source, normally R2 observations or an approved backfill source.

## Fail-closed context contract

The candidate MUST fail and pruning MUST remain blocked when:

- ObsAQIDB configuration is missing;
- the context RPC request fails;
- the response is not an array;
- pagination does not advance monotonically;
- duplicate hourly keys are returned;
- a page or row cap is reached before completion;
- a row cannot be normalised safely;
- a row is outside the requested window;
- the context start is outside ObsAQIDB retention;
- a complete empty result cannot be distinguished from an incomplete read.

A context failure follows the normal retry-safe path. The candidate is marked failed, the day gate remains incomplete and partial connector output is cleaned up where the existing v2 cleanup contract requires it.

## Target-day precedence

Context and target-day hourly values are merged by:

```text
timeseries_id + pollutant_code + timestamp_hour_utc
```

The target-day value derived from frozen IngestDB observations MUST win over an ObsAQIDB context value for the same key.

The intended windows do not overlap, but this rule protects the source boundary if an upstream query returns an unexpected edge row.

## No-supported-source state

A target connector/day with no supported PM2.5, PM10 or NO2 target-day rows is a successful `no_supported_aqi_source` state.

In this state:

- the PM context RPC is not called;
- previous-day context cannot create target-day AQI output;
- canonical empty connector manifests are written;
- fake Parquet files are not created;
- stale pollutant indexes or metadata do not remain authoritative.

## R2 outputs

Observation-derived AQI writes:

```text
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
```

The data profile contains DAQI and EAQI levels, statuses and missing reasons required by the public history path.

The debug profile contains calculation inputs, source counts, required counts, algorithm version and computation timestamp.

Context rows are never published as a separate R2 product.

## Structured diagnostics

Successful candidate logs and run summaries expose:

```text
pm_context_source
pm_context_window_start_utc
pm_context_window_end_utc
pm_context_requested_connector_id
pm_context_target_timeseries_count
pm_context_rows_fetched
pm_context_rows_accepted
pm_context_rows_discarded
pm_context_page_count
pm_context_complete
context_supported_aqi_hour_count
daqi_status_counts
eaqi_status_counts
```

Candidate failures attach available diagnostics to `phase_b_history_candidate_failed`.

These fields distinguish:

- a complete context read with genuine missing source hours;
- a complete read with full rolling context;
- irrelevant connector/window rows discarded by the target-timeseries filter;
- an incomplete or invalid read that failed closed.

## Index and manifest safety

The writer uses the established targeted v2 updater. It MUST NOT run a target-day-filtered full rebuild that drops unrelated days.

The targeted update must:

- start from the existing global latest payload;
- replace or insert only the affected day summary;
- preserve unrelated older days;
- update only affected pollutant indexes and timeseries metadata;
- use byte-stable put-if-changed behaviour;
- verify that every required index refers to the current pollutant manifest and hash.

Object existence alone is insufficient. Warnings, missing generated indexes, unreadable payloads or source-manifest mismatches block completion.

Observation-manifest adoption is disabled for the observation-derived AQI path because an observation manifest alone cannot satisfy the AQI gate.

## Idempotency and retries

Rewriting the same canonical state must be idempotent.

If supported target-day rows exist but normalisation or hourly calculation produces no AQI rows, the writer fails closed rather than publishing a successful empty result.

A PM context failure is retry-safe while the required context remains inside ObsAQIDB retention.

## Existing defective days

Deploying this fix does not automatically replace AQI objects already committed with insufficient prior-day context.

A previously affected day, including 12 July 2026 on TEST, requires an explicit targeted AQI rebuild from authoritative observation history. The repair must replace affected data and debug manifests and update targeted indexes without changing unrelated days.

For an old day no longer available in IngestDB or ObsAQIDB, use the existing R2-observation-to-AQI integrity/backfill route after confirming it supplies the same preceding 23-hour PM context.

## Validation policy

Pre-deployment validation is limited to structural viability and small deterministic checks needed for the known boundary defect.

Functional acceptance is through a real TEST Phase B operation. Confirm:

1. `pm_context_source=obs_aqidb` is reported for PM-capable candidates.
2. The context window is D-1 01:00 through D 00:00.
3. `pm_context_complete=true` and pagination remains within configured caps.
4. PM DAQI is available at D 00:00 when 23 valid older hours plus the target hour exist.
5. Genuine missing hours still produce `insufficient_samples` rather than invented values.
6. EAQI and NO2 behaviour remain unchanged.
7. The R2 observation partition contains only D observations.
8. AQI data and debug manifests contain only D output rows.
9. Targeted indexes point to the current manifests and unrelated days remain unchanged.
10. `history_done` is set only after all observation, AQI, manifest and index gates succeed.

The dated rollout material under `system_docs_legacy/` is historical evidence and does not override this contract.
