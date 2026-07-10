# UK AQ Cloudflare Scheduler Dispatchers

This document covers the phase-2 dry-run scheduler workers that evaluate fixed schedules and log decisions without triggering Cloud Run yet.

## Current phase-2 scope

### Ingest dispatcher

- Worker: `uk-aq-ingest-scheduler-dispatcher`
- Path: `cloudflare/scheduler-dispatchers/ingest/`
- Cron: `*/15 * * * *`
- Jobs:
  - `uk_aq_blondon_communities`
  - `uk_aq_blondon_nodes`
  - `uk_aq_scomm`
  - `uk_aq_sos`
  - `uk_aq_openaq_safety`

### Ops dispatcher

- Worker: `uk-aq-ops-scheduler-dispatcher`
- Path: `cloudflare/scheduler-dispatchers/ops/`
- Cron: `0 * * * *`
- Jobs:
  - `ops.prune_daily`
  - `ops.observs_partition_maintenance`

## Explicitly deferred

These jobs are intentionally not included in phase 2:

- `uk-aq-db-size-logger`
- `uk-aq-aqilevels-retention-service`
- `uk-aq-timeseries-aqi-hourly`

Keep them out until the state model is ready for a safe trigger path.

## State sources

- Ingest decisions read `uk_aq_core.uk_aq_ingest_runs` from `SUPABASE_URL` + `SB_SECRET_KEY`.
- Ops decisions read `uk_aq_ops.daily_task_runs_dashboard` from `OBS_AQIDB_SUPABASE_URL` + `OBS_AQIDB_SECRET_KEY`.

## Phase 2 behavior

- The workers only evaluate and log decisions.
- They do not send Cloud Run requests yet.
- `would_trigger` is logged for future use, but no trigger happens in this phase.

## Auth direction for later phases

- Cloudflare to Cloud Run should use a shared dispatch header or equivalent secret-based guard.
- Existing GCP Scheduler OIDC paths remain untouched for now.
