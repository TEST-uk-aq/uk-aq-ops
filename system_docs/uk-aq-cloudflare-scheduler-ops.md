# UK AQ Cloudflare Scheduler Ops

This document covers the ops-side phase-2 dry-run scheduler worker that evaluates fixed schedules and logs decisions without triggering Cloud Run yet.

## Current phase-2 scope

### Ops scheduler

- Worker: `uk-aq-scheduler-ops`
- Path: `cloudflare/scheduler/ops/`
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

## State source

- Ops decisions read `uk_aq_ops.daily_task_runs_dashboard` from `OBS_AQIDB_SUPABASE_URL` + `OBS_AQIDB_SECRET_KEY`.

## Phase 2 behavior

- The workers only evaluate and log decisions.
- They do not send Cloud Run requests yet.
- `would_trigger` is logged for future use, but no trigger happens in this phase.

## Auth direction for later phases

- Cloudflare to Cloud Run should use a shared dispatch header or equivalent secret-based guard.
- Existing GCP Scheduler OIDC paths remain untouched for now.

The ingest-side phase-2 scheduler now lives in the ingest repo alongside its own deploy workflow and docs.
