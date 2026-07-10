# UK AQ Cloudflare Scheduler Ops

This document covers the ops-side scheduler worker that evaluates fixed schedules, logs decisions, and dispatches the R2 core snapshot GitHub workflow.

## Current scope

### Ops scheduler

- Worker: `uk-aq-scheduler-ops`
- Path: `cloudflare/scheduler/ops/`
- Crons:
  - `0 * * * *`
  - `5 12 * * *`
- Jobs: `ops.prune_daily`, `ops.observs_partition_maintenance`, `ops.r2_core_snapshot`

GitHub dispatch secret:

- `UK_AQ_WORKFLOW_SCHEDULER_GITHUB_DISPATCH_TOKEN` from the ops repo, written into the Worker secret `GITHUB_WORKFLOW_DISPATCH_TOKEN` during deploy.

## Explicitly deferred

These jobs are intentionally not included yet:

- `uk-aq-db-size-logger`
- `uk-aq-aqilevels-retention-service`
- `uk-aq-timeseries-aqi-hourly`

Keep them out until the state model is ready for a safe trigger path.

## State source

- Ops decisions read `uk_aq_ops.daily_task_runs_dashboard` from `OBS_AQIDB_SUPABASE_URL` + `OBS_AQIDB_SECRET_KEY`.

## Behavior

- The hourly jobs only evaluate and log decisions.
- The `ops.r2_core_snapshot` job dispatches `workflow_dispatch` to GitHub at 12:05 UTC.
- `would_trigger` is still logged for the hourly jobs, and dispatch errors fail the scheduled run so they can be retried.

## Auth direction for later phases

- Cloudflare to Cloud Run should use a shared dispatch header or equivalent secret-based guard.
- Existing GCP Scheduler OIDC paths remain untouched for now.

The ingest-side phase-2 scheduler now lives in the ingest repo alongside its own deploy workflow and docs.
