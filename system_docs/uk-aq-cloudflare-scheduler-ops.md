# UK AQ Cloudflare Scheduler Ops

This document covers the ops-side scheduler worker that dispatches the hourly Cloud Run jobs and the R2 core snapshot GitHub workflow.

## Current scope

### Ops scheduler

- Worker: `uk-aq-scheduler-ops`
- Path: `cloudflare/scheduler/ops/`
- Crons:
  - `0 * * * *`
  - `20 12 * * *`
- Jobs: `ops.prune_daily`, `ops.observs_partition_maintenance`, `ops.r2_core_snapshot`

GitHub dispatch secret:

- `UK_AQ_WORKFLOW_SCHEDULER_GITHUB_DISPATCH_TOKEN` from the ops repo, written into the Worker secret `GITHUB_WORKFLOW_DISPATCH_TOKEN` during deploy.

Cloud Run trigger secret and URLs:

- `UK_AQ_EDGE_UPSTREAM_SECRET`
- `UK_AQ_PRUNE_DAILY_SERVICE_URL`
- `UK_AQ_OBSERVS_PARTITION_MAINTENANCE_SERVICE_URL`

## Explicitly deferred

These jobs are intentionally not included yet:

- `uk-aq-db-size-logger`
- `uk-aq-aqilevels-retention-service`
- `uk-aq-timeseries-aqi-hourly`

Keep them out until the state model is ready for a safe trigger path.

## State source

- Ops decisions read `uk_aq_ops.daily_task_runs_dashboard` from `OBS_AQIDB_SUPABASE_URL` + `OBS_AQIDB_SECRET_KEY`.

## Behavior

- The hourly jobs evaluate state and then POST `/run` to their Cloud Run services with `X-UK-AQ-Upstream-Auth`.
- The `ops.r2_core_snapshot` job dispatches `workflow_dispatch` to GitHub.
- Dispatch errors fail the scheduled run so they can be retried.

## Auth direction for later phases

- Cloudflare to Cloud Run should use a shared dispatch header or equivalent secret-based guard.
- Existing GCP Scheduler OIDC paths remain untouched for now.

The ingest-side phase-2 scheduler now lives in the ingest repo alongside its own deploy workflow and docs.
