# R2-first AQI migration report (2026-07-14)

## Active dependencies removed in this pass

- None removed. This pass added cache-control and direct-worker cache-disabling controls only; no Supabase AQI objects were dropped or dereferenced from active data paths.

## Active dependencies remaining

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` still contains the legacy AQI export RPC constants `uk_aq_rpc_aqilevels_history_day_connector_counts` and `uk_aq_rpc_aqilevels_history_day_rows`.
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` still contains materialised AQI fallback/context reads from `uk_aq_public.uk_aq_timeseries_aqi_hourly`.
- `workers/uk_aq_backfill_local/run_job.ts` still defaults AQI day row/count RPC names to the materialised Supabase AQI RPCs.
- `workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts` still reads `uk_aq_timeseries_aqi_hourly` for station snapshot AQI data.
- `local/dashboard/server/uk_aq_dashboard_api.py`, `local/station_snapshot/server/uk_aq_station_snapshot_local.py`, and `station_snapshot/index.html` still contain local/manual snapshot AQI reads or labels for materialised AQI tables/views.
- Documentation and plans still describe the retired Cloud Run AQI hourly service and materialised Supabase AQI objects.

## Database objects that appear removable later

Subject to cross-repository confirmation and TEST validation, the following AQI-only objects appear candidates for a later removal pass:

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

## Cross-repository Pass 2 work required

- Update schema-repo canonical DDL and targeted SQL apply files before dropping or replacing AQI-only Supabase objects.
- Update website/station snapshot consumers to read AQI through the cache proxy and R2-first AQI worker rather than materialised Supabase AQI rows.
- Retire the legacy AQI hourly Cloud Run workflow/docs only after R2-first Phase B AQI generation is validated in TEST.
- Replace Phase B legacy RPC export with frozen-observation AQI generation and R2 v2 data/debug writes.
- Replace AQI worker live fallback reads from materialised AQI rows with live observation reads plus shared AQI-library calculation.
