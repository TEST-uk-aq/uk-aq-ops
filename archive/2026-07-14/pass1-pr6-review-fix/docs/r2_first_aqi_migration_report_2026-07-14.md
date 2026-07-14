# R2-first AQI migration report (2026-07-14)

## Completed Pass 1 work

### Cache groundwork from PR #5

- The AQI cache proxy groundwork is retained: proxy-owned recent/mixed cache keys, recent and immutable profiles, the shared `UK_AQ_AQI_MUTABLE_HOURS` horizon, and the `UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED` switch remain unchanged.
- Current TEST cache values remain an operational setting and are not modified by this PR:
  - `UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=true`
  - `UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED=false`
  - `UK_AQ_AQI_MUTABLE_HOURS=120`

### Phase B frozen-source AQI generation implemented by this PR

- Added a bounded frozen-observation summariser for Phase B D-1 plus D source rows.
- The helper normalises deterministic source order, counts source rows by pollutant, enforces `UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS` (default `2000000`), and feeds shared AQI calculation for day-D output only.
- The helper uses the shared AQI library (`buildAqilevelHistoryRowsForDayFromSourceObservations`) so PM2.5 and PM10 receive prior-day context while only day-D rows are returned.
- `no_supported_aqi_source` is an explicit successful status when a connector/day contains no supported PM2.5, PM10, or NO2 AQI source rows.
- Feature flags were added with rollback-safe defaults:
  - `UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false`
  - `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true`

### Live observation fallback implemented by this PR

- Added shared precedence helpers for canonical AQI rows and observation rows:
  - AQI: `R2 AQI > live-calculated AQI > no row`.
  - Observations: `R2 observation > ingest observation`.
- Added coalescing for missing-hour live-calculation windows with 23-hour PM context.
- Added `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false` with default legacy behaviour preserved.
- When the live flag is enabled, the AQI history worker no longer queries materialised Supabase AQI as a fill source. Missing rows are marked incomplete until raw-observation live reads are available for the requested window.

## Rollback dependencies deliberately retained

- Legacy Phase B AQI RPC export remains behind `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true`.
- Materialised Supabase AQI fallback remains behind `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false` as temporary rollback scaffolding.
- Materialised Supabase AQI tables, views, functions, indexes, and RPCs are deliberately retained. No database object is dropped or altered by this PR.

## Remaining materialised Supabase AQI dependencies in active repo code

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`: legacy rollback AQI export constants and RPC source config for `uk_aq_rpc_aqilevels_history_day_connector_counts` and `uk_aq_rpc_aqilevels_history_day_rows`.
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`: temporary legacy materialised AQI fallback/context reads from `uk_aq_public.uk_aq_timeseries_aqi_hourly` while `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false`.
- `workers/uk_aq_backfill_local/run_job.ts`: AQI day count/row RPC defaults for materialised AQI rebuild/export compatibility.
- `workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts`: Station Snapshot AQI consumer still reads `uk_aq_timeseries_aqi_hourly`.
- `local/dashboard/server/uk_aq_dashboard_api.py`, `local/station_snapshot/server/uk_aq_station_snapshot_local.py`, and `station_snapshot/index.html`: local/manual dashboard and station snapshot code still references materialised AQI sources or labels.

## Remaining Pass 2 work

- Station Snapshot migration.
- Website consumer migration where still required.
- Ingest-dashboard coverage migration.
- Schema object inventory across repositories.
- Guarded Supabase AQI retirement preparation after TEST validation.

## Manual TEST deployment plan

### Stage 1: deploy code with defaults

Deploy the branch without changing repository variables. Expected defaults:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
```

Existing cache settings remain unchanged.

### Stage 2: Phase B test

For a controlled eligible target day, set only in TEST:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=false
```

Run normal Phase B through the existing operational route and verify frozen-source counts, day-D observations, day-D AQI data/debug Parquet, manifests, indexes, PM midnight prior-day context, prune gate behaviour, and idempotent retry.

### Stage 3: live fallback test

Set only in TEST:

```text
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=true
```

Verify representative PM2.5, PM10, and NO2 series for R2 AQI precedence, recent missing R2 AQI handling, R2 observation overlap precedence, incomplete response cache prevention, and DAQI/EAQI rendering.

### Stage 4: rollback instructions

Return variables to:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
```

No destructive database rollback is required.

## Unresolved risk

The shared bounded helpers and feature-gated routing are in place, but the production raw-observation live reader still needs TEST wiring to transform R2/ingest observation API results into shared AQI library input for full live fill. Until that wiring is enabled, the live-enabled worker path deliberately reports incomplete rather than reading materialised AQI.
