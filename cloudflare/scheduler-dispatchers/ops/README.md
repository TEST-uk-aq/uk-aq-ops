# UK AQ Ops Scheduler Dispatcher

Cloudflare Worker dry-run scheduler for ops jobs.

## Scope in phase 2

This worker only evaluates and logs decisions. It does not trigger Cloud Run yet.

Tracked jobs:

- `ops.prune_daily`
- `ops.observs_partition_maintenance`

Excluded for now:

- `uk-aq-db-size-logger`
- `uk-aq-aqilevels-retention-service`
- `uk-aq-timeseries-aqi-hourly`
- `uk-aq-latest-snapshot-builder`
- `uk-aq-observs-pubsub-writer`
- `uk-aq-supabase-db-dump-backup-service`

## State source

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `uk_aq_ops.daily_task_runs_dashboard`

## Logging

The worker logs one JSON decision record per job and a final summary record for each scheduled invocation.

## Cron

- `0 * * * *`
