# UK AQ Cloudflare Scheduler Ops

This document covers the ops-side scheduler worker that dispatches the R2 core snapshot GitHub workflow.

## Current scope

### Ops scheduler

- Worker: `uk-aq-scheduler-ops`
- Path: `cloudflare/scheduler/ops/`
- Crons:
  - `31 13 * * *`
- Jobs: `ops.r2_core_snapshot`

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

- The scheduler evaluates state and dispatches `workflow_dispatch` to GitHub for `ops.r2_core_snapshot`.
- Dispatch errors fail the scheduled run so they can be retried.

The ingest-side phase-2 scheduler now lives in the ingest repo alongside its own deploy workflow and docs.
