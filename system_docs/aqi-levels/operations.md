# AQI levels operations

## Active runtime components

The active AQI levels components are:

- shared calculation library: `lib/aqi/aqi_levels.mjs`;
- private station-history Worker: `workers/uk_aq_station_history/`;
- private AQI History R2 API Worker: `workers/uk_aq_aqi_history_r2_api_worker/`;
- Prune Daily AQI writer: `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`;
- R2 index builder: `workers/shared/uk_aq_r2_history_index.mjs`;
- cache-proxy boundary: `workers/uk_aq_cache_proxy/src/index.ts`.

Deployment workflows:

- `.github/workflows/uk_aq_station_history_deploy.yml`;
- `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`;
- `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_cache_proxy_deploy.yml`.

## Inactive components

The previous `uk-aq-timeseries-aqi-hourly` Cloud Run implementation and deployment workflow were archived or removed on 13 July 2026.

Its daily and monthly roll-up calls are not part of current operations.

Do not use archived worker instructions as the normal AQI runbook.

## Normal operational sequence

### Recent website request

1. The cache proxy receives an authenticated station-history request.
2. It calls the private station-history Service Binding.
3. Station history resolves authoritative timeseries identity.
4. It performs one logical recent ingest observation read.
5. It uses ingest-only mode only when the requested output and PM context are complete.
6. Otherwise it reads bounded R2 AQI and R2 observations.
7. It calculates only R2-missing recent AQI endpoints.
8. It merges with R2 authoritative over live calculation.
9. It returns independent AQI and observation completeness.
10. The cache proxy applies public cache and stale-response policy.

### Historical persistence

1. Prune Daily Phase B selects a closed day and connector.
2. It writes or confirms observation history according to the active history version.
3. It obtains AQI rows through the configured observation-derived or legacy materialised branch.
4. It writes AQI data and debug parquet parts.
5. It writes pollutant, connector and day manifests.
6. It updates targeted AQI indexes. Stable timeseries bindings are published
   and reconciled separately from the core snapshot.
7. The private AQI API serves only committed manifest-backed history.

## Prune Daily schedule

Repository workflow defaults currently define:

- cron: `0 2 * * *`;
- timezone: `Etc/UTC`;
- request deadline: 15 minutes;
- maximum service instances: 1;
- concurrency: 1.

Repository variables may override defaults. Documentation must not claim a deployed value solely from a workflow fallback.

A timestamp-semantics correction must not change the Prune Daily schedule, deletion batches or observation-history gate unless separately approved.

## Required targeted configuration check

Before changing the AQI writer, determine the deployed TEST values for:

```text
UK_AQ_R2_HISTORY_VERSION
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED
```

This check is required because the two AQI writer branches share output contracts but take different inputs, and workflow defaults can be overridden by repository variables.

Also confirm the active v2 prefixes where v2 is deployed:

```text
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX
UK_AQ_R2_HISTORY_INDEX_V2_PREFIX
UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX
```

## Prune Daily writer configuration

Relevant configuration groups include:

### Branch selection

- `UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED`;
- `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED`.

### History version and prefixes

- `UK_AQ_R2_HISTORY_VERSION`;
- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX`;
- `UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX`;
- `UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX`;
- `UK_AQ_R2_HISTORY_INDEX_V2_PREFIX`.

### Resource limits

- AQI part row limits;
- row-group size;
- cursor fetch size;
- observation snapshot row and byte caps;
- maximum candidates and run-time budget.

These limits are safety controls. A timestamp fix must not relax them to hide an endpoint or partition-selection defect.

## AQI History R2 API configuration

Required or load-bearing settings include:

- `UK_AQ_R2_HISTORY_VERSION`;
- `CFLARE_R2_BUCKET`;
- `UK_AQ_EDGE_UPSTREAM_SECRET`;
- `OBS_AQIDB_SUPABASE_URL` and `OBS_AQIDB_SECRET_KEY` where the configured read mode requires them;
- `INGESTDB_RETENTION_DAYS`;
- v1 or v2 AQI history prefixes;
- AQI timeseries-index prefix;
- index enabled and required flags;
- mutable-hours setting;
- internal response-cache setting;
- bounded parquet and scan budgets;
- live-observation fallback flag and observations API URL where enabled.

The deployment workflow requires an explicit valid `UK_AQ_R2_HISTORY_VERSION`. Missing version configuration must fail deployment rather than select a history version implicitly.

## Station-history configuration

Required data-path settings include:

- `SUPABASE_URL`;
- the configured privileged ingest key;
- `UK_AQ_EDGE_UPSTREAM_SECRET`;
- `UK_AQ_AQI_HISTORY_R2_API_URL`;
- `UK_AQ_OBSERVS_HISTORY_R2_API_URL`;
- `UK_AQ_PUBLIC_SCHEMA`;
- `INGESTDB_RETENTION_DAYS`.

Bounded policy settings include:

- stable AQI head maximum hours;
- AQI history chunk maximum hours;
- observation history chunk maximum hours;
- one-to-three-hour observation overlap;
- Obs AQI database timeout.

The Worker must remain private and reachable only through the cache proxy Service Binding.

## Source-precedence operations

For the same AQI endpoint:

- committed R2 wins;
- live calculation fills only missing R2 endpoints;
- disagreements are logged with bounded mismatch details;
- older history chunks do not replace the stable head.

For observations used in calculation:

- R2 wins for an exact timestamp;
- direct ingest fills recent missing timestamps;
- overlap counts are reported.

Operators must not resolve a mismatch by deleting committed R2 data merely because a current live calculation differs. Diagnose source observations, algorithm version, rolling context and manifest integrity first.

## Cache behaviour

### AQI History R2 API

The Worker distinguishes recent/mutable and immutable request ranges.

It may use an internal response cache where enabled. Responses expose a cache hit/miss marker.

Incomplete or scan-budget-stopped responses must not be presented as complete cached history.

### Station history and cache proxy

Complete recent station-series responses may use the short configured TTL.

Partial or gap-bearing station-history responses use `Cache-Control: no-store` before any separately governed stale-fallback decision at the cache proxy.

A timestamp correction must not be implemented by cache-key manipulation or by serving stale forward-extended bands.

## Operational telemetry

### Shared and live calculation

Monitor or retain diagnostics for:

- source observation row count;
- accepted and rejected source rows;
- hourly sample counts;
- PM rolling counts;
- DAQI and European AQI status counts;
- R2 and live source counts;
- overlap and mismatch counts;
- missing endpoint ranges;
- response completeness.

### Prune Daily

Monitor:

- candidate day and connector;
- AQI source branch;
- target-day and context source counts;
- written data/debug row and file counts;
- manifest keys;
- index update result;
- failed days and retry state;
- run-budget exhaustion.

### R2 API

Monitor:

- target identity resolution source;
- required-index status;
- R2 object reads;
- parquet files, row groups and chunks scanned;
- scan elapsed time;
- stop reason;
- returned source counts;
- null DAQI and European AQI counts;
- partial reasons.

## Failure behaviour

### Missing required index

When required index context is missing or invalid:

- stop the affected broad read;
- return structured partial JSON;
- identify the missing index or connector context;
- do not scan every connector/day as a fallback.

### Missing manifest

A day or connector without its required committed manifest is not readable committed history.

Do not discover and serve loose parquet objects as an implicit repair.

### Incomplete PM context

Return the hourly row with independent statuses. Preserve a valid European AQI result while DAQI reports insufficient samples.

### Partial observation source

Do not certify AQI completeness from a partial observation source. Return available rows with gaps and non-cacheable status.

### Source mismatch

Keep R2 authoritative, record the mismatch endpoint and investigate. Do not use last-write-wins merging.

## Routine checks

When AQI bands are missing, shifted or stale, check in this order:

1. authoritative timeseries identity and pollutant;
2. raw observation timestamps and values;
3. expected endpoint set using `start < n <= end`;
4. shared calculation input and rolling counts;
5. R2 data/debug row for the endpoint;
6. pollutant, connector and day manifests;
7. AQI timeseries index and stable timeseries binding;
8. AQI History API completeness and scan stop reason;
9. station-history source mode, overlap and mismatch diagnostics;
10. cache-proxy response and feature flags;
11. website loader's timestamp normalization;
12. renderer rectangle start and end.

## Normal repair ownership

Use [`recovery.md`](recovery.md) for targeted data, manifest and index repair.

Do not hand-edit R2 parquet, manifests, API responses or website cache objects.

## Daily and monthly roll-ups

No routine job should be expected to refresh:

```text
uk_aq_aqilevels.timeseries_aqi_daily
uk_aq_aqilevels.timeseries_aqi_monthly
```

Do not alert merely because those tables are not advancing unless a new approved service explicitly reactivates them.

Before reactivation, update this directory and correct calendar grouping to use the represented interval start date.
