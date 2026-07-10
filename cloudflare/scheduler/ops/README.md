# UK AQ Scheduler Ops

Cloudflare Worker scheduler for ops jobs.

## Scope

This worker dispatches the R2 core snapshot GitHub workflow.

Tracked jobs:

- `ops.r2_core_snapshot`

## State source

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `uk_aq_ops.daily_task_runs_dashboard`

## Logging

The worker logs one JSON decision record per job and a final summary record for each scheduled invocation. The GitHub dispatch path also logs the dispatch attempt and response status.

## Cron

- `31 13 * * *`

## Required config

- `OBS_AQIDB_SUPABASE_URL` is written to the Worker secret `OBS_AQIDB_SUPABASE_URL`.
- `OBS_AQIDB_SECRET_KEY` is written to the Worker secret `OBS_AQIDB_SECRET_KEY`.
- `UK_AQ_WORKFLOW_SCHEDULER_GITHUB_DISPATCH_TOKEN` is written to the Worker secret `GITHUB_WORKFLOW_DISPATCH_TOKEN`.
