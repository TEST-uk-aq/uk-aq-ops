# R2-first AQI migration report (2026-07-14)

## Scope of this PR

This PR is cache groundwork only. It does not implement the full R2-first AQI architecture, does not change Supabase database objects, does not deploy anything, and does not replace the current materialised Supabase AQI fallback.

Implemented in this PR:

- Proxy-owned AQI cache-key groundwork for recent/mixed requests.
- Dedicated recent and immutable AQI proxy cache profiles.
- Configurable AQI mutable horizon shared by the cache proxy and AQI history worker.
- AQI worker internal response-cache disable switch.
- Narrow proxy exception for caching complete AQI upstream `no-store` responses only when the AQI worker explicitly reports its internal response cache is disabled.

## Active dependencies removed in this pass

- None removed. This pass is intentionally non-destructive cache groundwork; no Supabase AQI objects were dropped or dereferenced from active data paths.

## Active dependencies remaining

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` still contains the legacy AQI export RPC constants `uk_aq_rpc_aqilevels_history_day_connector_counts` and `uk_aq_rpc_aqilevels_history_day_rows`.
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` still contains materialised AQI fallback/context reads from `uk_aq_public.uk_aq_timeseries_aqi_hourly`.
- `workers/uk_aq_backfill_local/run_job.ts` still defaults AQI day row/count RPC names to the materialised Supabase AQI RPCs.
- `workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts` still reads `uk_aq_timeseries_aqi_hourly` for station snapshot AQI data.
- `local/dashboard/server/uk_aq_dashboard_api.py`, `local/station_snapshot/server/uk_aq_station_snapshot_local.py`, and `station_snapshot/index.html` still contain local/manual snapshot AQI reads or labels for materialised AQI tables/views.
- Documentation and plans still describe the retired Cloud Run AQI hourly service and materialised Supabase AQI objects.

## Unfinished Pass 1 core R2-first AQI work

The following are still core Pass 1 implementation tasks, not Pass 2 cleanup:

- Freeze the Phase B D-1 and D canonical observation source for each target day.
- Calculate permanent AQI during Phase B from the same frozen normalised observations that feed day-D observation output.
- Write AQI data/debug Parquet and all required AQI manifests/indexes to R2.
- Block prune completion when AQI calculation, AQI R2 writes, manifests, indexes, or verification fail.
- Replace the AQI worker materialised Supabase AQI fallback with raw-observation calculation using the shared AQI library.

## Pass 2 cross-repository and retirement work

Pass 2 remains consumer migration and guarded Supabase retirement work after Pass 1 is validated in TEST:

- Update Station Snapshot consumers.
- Update website consumers.
- Update ingest dashboard consumers.
- Complete schema dependency inventory in the schema repository.
- Prepare guarded retirement migrations for materialised Supabase AQI-only objects.

## Database objects that appear removable later

Subject to Pass 1 completion, cross-repository confirmation, and TEST validation, the following AQI-only objects appear candidates for a later removal pass:

- `uk_aq_aqilevels.timeseries_aqi_hourly`
- `uk_aq_aqilevels.timeseries_aqi_daily`
- `uk_aq_aqilevels.timeseries_aqi_monthly`
- `uk_aq_public.uk_aq_timeseries_aqi_hourly` if no non-AQI metadata consumers remain
- `uk_aq_rpc_aqilevels_history_day_connector_counts`
- `uk_aq_rpc_aqilevels_history_day_rows`
- AQI-only helper/staging/rollup/reconciliation objects used solely to maintain the materialised Supabase AQI tables

## Database objects that must remain

- Observation tables, observation history/R2 repair helpers, metadata tables/views, station/timeseries metadata, ingest-retention objects, ops/audit/health objects, and integrity/backfill objects that repair R2 observations or rebuild affected R2 AQI.
- Any AQI shared-library-independent metadata object used to resolve connector/station/timeseries identity until equivalent R2 metadata coverage is validated.
