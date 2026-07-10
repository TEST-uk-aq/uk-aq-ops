# UK AQ Scheduler Ops

Cloudflare Worker scheduler for ops jobs.

## Scope

This worker dispatches the hourly ops Cloud Run services and the R2 core snapshot GitHub workflow.

Tracked jobs:

- `ops.prune_daily`
- `ops.observs_partition_maintenance`
- `ops.r2_core_snapshot`

## State source

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `uk_aq_ops.daily_task_runs_dashboard`

## Logging

The worker logs one JSON decision record per job and a final summary record for each scheduled invocation. Cloud Run and GitHub dispatch jobs also log the dispatch attempt and response status.

## Cron

- `0 * * * *`
- `20 12 * * *`

## Required config

- `UK_AQ_EDGE_UPSTREAM_SECRET` is written to the Worker secret `UK_AQ_EDGE_UPSTREAM_SECRET`.
- `UK_AQ_PRUNE_DAILY_SERVICE_URL` points at the prune Cloud Run service URL.
- `UK_AQ_OBSERVS_PARTITION_MAINTENANCE_SERVICE_URL` points at the observs partition maintenance Cloud Run service URL.
- `UK_AQ_WORKFLOW_SCHEDULER_GITHUB_DISPATCH_TOKEN` is written to the Worker secret `GITHUB_WORKFLOW_DISPATCH_TOKEN`.
