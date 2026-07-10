# UK AQ Scheduler Ops

Cloudflare Worker scheduler for ops jobs.

## Scope

This worker evaluates and logs Cloud Run decisions for the hourly ops jobs, and it dispatches the R2 core snapshot GitHub workflow at 12:05 UTC.

Tracked jobs:

- `ops.prune_daily`
- `ops.observs_partition_maintenance`
- `ops.r2_core_snapshot`

## State source

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `uk_aq_ops.daily_task_runs_dashboard`

## Logging

The worker logs one JSON decision record per job and a final summary record for each scheduled invocation. GitHub dispatch jobs also log the dispatch attempt and response status.

## Cron

- `0 * * * *`
- `5 12 * * *`

## GitHub dispatch

The core snapshot dispatch reuses the existing `UK_AQ_WORKFLOW_SCHEDULER_GITHUB_DISPATCH_TOKEN` repo secret and writes it to the Worker secret `GITHUB_WORKFLOW_DISPATCH_TOKEN`.
