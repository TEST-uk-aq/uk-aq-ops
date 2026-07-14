# R2-first AQI migration report (2026-07-14)

## Completed in PR #6

### Bounded frozen Phase B observation source

- Phase B v2 candidate processing can now use a local NDJSON frozen source for `D-1 <= observed_at < D+1` when `UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true`.
- The source is produced by deterministic cursor reads from the existing Phase B history rows RPC, written sequentially to a temporary local file, and cleaned up after the candidate finishes or fails.
- Bounds are enforced by row count and staged bytes:
  - `UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS` default `250000`.
  - `UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_BYTES` default `268435456`.
- Day-D observation output and day-D AQI calculation consume this same frozen file; the AQI path does not write observations and reread them from R2.

### Permanent AQI data/debug output

- Observation-derived AQI uses the shared `lib/aqi/aqi_levels.mjs` implementation.
- PM2.5 and PM10 receive D-1 plus D context; only day-D AQI rows are written.
- The existing v2 AQI data/debug Parquet writers and v2 manifest contracts are reused.
- Connector/day AQI data and debug manifests are written for supported AQI source rows.
- `no_supported_aqi_source` is a successful explicit connector outcome and does not block the day.

### AQI manifests, indexes, and prune gate

- Day-level AQI data/debug manifests are assembled from connector AQI manifests before the Phase B day gate is marked complete.
- If AQI calculation, AQI write, manifest creation, or verification fails, candidate completion is not recorded and the existing Phase B failure path blocks pruning.
- R2 history index rebuild remains the existing post-Phase-B operation in the prune service; it now sees the AQI v2 data/debug manifests written by the candidate path.

### Live observation fallback

- `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false` preserves the legacy materialised AQI fallback.
- When the flag is true, v2 AQI history responses use `R2 AQI > live calculated AQI > no row`; materialised calculated AQI rows are not queried as a fill source.
- Live calculation reads raw observations from the configured R2 observations history API and recent ingest observations, merges with `R2 observation > ingest observation`, calculates AQI using the shared library, and merges live rows only under absent R2 AQI keys.
- Missing PM windows are coalesced with 23 hours of context.
- Observation-read or calculation failure marks the response incomplete so proxy caching remains safe.

### Deployment-variable wiring

- Prune daily Cloud Run workflow now passes:
  - `UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED`
  - `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED`
  - `UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS`
  - `UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_BYTES`
- AQI Worker workflow and Wrangler config now pass:
  - `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED`
- Defaults are rollback-safe and no repository variable values are changed by this PR.

## Deliberately retained rollback dependencies

- Legacy Phase B AQI RPC export remains behind `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true`.
- Materialised Supabase AQI fallback remains available while `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false`.
- Existing Supabase AQI tables, views, functions, indexes, and RPCs are retained; this PR does not drop or alter them.

## Remaining materialised Supabase AQI dependencies in active repo code

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`: legacy rollback AQI export constants and RPC source config for `uk_aq_rpc_aqilevels_history_day_connector_counts` and `uk_aq_rpc_aqilevels_history_day_rows`.
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`: temporary legacy materialised AQI fallback/context reads from `uk_aq_public.uk_aq_timeseries_aqi_hourly` when `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false`.
- `workers/uk_aq_backfill_local/run_job.ts`: AQI day count/row RPC defaults for materialised AQI rebuild/export compatibility.
- `workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts`: Station Snapshot AQI consumer still reads `uk_aq_timeseries_aqi_hourly`.
- `local/dashboard/server/uk_aq_dashboard_api.py`, `local/station_snapshot/server/uk_aq_station_snapshot_local.py`, and `station_snapshot/index.html`: local/manual dashboard and station snapshot code still references materialised AQI sources or labels.

## Remaining Pass 2 work

- Station Snapshot migration.
- Remaining website/API consumer migration where still required.
- Ingest-dashboard coverage migration.
- Cross-repository dependency inventory.
- Guarded Supabase AQI retirement preparation after TEST validation.

## Manual TEST rollout plan

### Stage 1: deploy code with safe defaults

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
```

Verify legacy Phase B AQI export and legacy AQI Worker fallback remain unchanged.

### Stage 2: enable new Phase B only

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=false
```

Run one controlled eligible day and verify the frozen source, observation output, AQI data, AQI debug, manifests, indexes, PM prior-day context, prune gate, and idempotent retry.

### Stage 3: enable live fallback

```text
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=true
```

Test representative PM2.5, PM10, and NO2 series. Verify R2 AQI wins, recent missing AQI is calculated, R2 observations win overlaps, ingest fills distinct gaps, incomplete responses are not cached, and DAQI/EAQI bands still render.

### Stage 4: rollback

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
```

No destructive database rollback is required.
