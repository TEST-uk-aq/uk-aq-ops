# Cloudflare Workflow Scheduler (GitHub Actions)

This Worker replaces selected GitHub cron schedules by calling GitHub `workflow_dispatch`.

## One-Place Schedule Edits

Change schedule times only in:
- `cloudflare/workflow-scheduler/wrangler.toml`

Each cron line must include `job_key` comment:

```toml
[triggers]
crons = [
  "0 3 * * *",   # job_key: uk_aq_stations_daily | uk-aq-ingest/uk_aq_stations_daily.yml
  "15 4 * * *",  # job_key: uk_aq_r2_core_snapshot_v1 | uk-aq-ops/uk_aq_r2_core_snapshot.yml
  "20 4 * * *",  # job_key: uk_aq_r2_core_snapshot_v2 | uk-aq-ops/uk_aq_r2_core_snapshot.yml
  "35 4 * * *",  # job_key: uk_aq_r2_history_dropbox_backup_v1 | uk-aq-ops/uk_aq_r2_history_dropbox_backup.yml
  "45 4 * * *",  # job_key: uk_aq_r2_history_dropbox_backup_v2 | uk-aq-ops/uk_aq_r2_history_dropbox_backup.yml
  "49 5 * * *",  # job_key: uk_aq_dropbox_prune_raw | uk-aq-ops/uk_aq_dropbox_prune_raw.yml
]
```

`worker.js` does not store literal cron values in source. Deploy injects the cron map from `wrangler.toml` by `job_key`.

## How Routing Works

1. Cloudflare fires `scheduled()` and passes only the cron string (no job name).
2. Deploy workflow builds `job_key -> cron` map from `wrangler.toml` comments.
3. Worker matches received cron string to job keys, then dispatches matching workflows.
4. Version-specific R2 jobs pass explicit `workflow_dispatch` inputs instead of relying on workflow defaults: core snapshot uses `history_version`, and Dropbox backup uses `backup_version`.

## Required Secret

Worker secret:
- `GITHUB_WORKFLOW_DISPATCH_TOKEN`

Use a PAT or GitHub App token with repo access and Actions write permission for dispatch.

Optional Worker secret:
- `MANUAL_TRIGGER_KEY` (enables `GET /run?cron=...&key=...`)

## Deploy Workflow (Ops Repo)

Workflow:
- `.github/workflows/uk_aq_workflow_scheduler_deploy.yml`

Behavior:
- Runs on push to `main` for `cloudflare/workflow-scheduler/**` changes, or manual dispatch.
- Replaces `YOUR_GITHUB_OWNER` with `github.repository_owner` during deploy.
- Injects cron map into `worker.js` from `wrangler.toml`.
- Validates `job_key` coverage and map alignment before deploy.

Required GitHub repo secrets:
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `UK_AQ_WORKFLOW_SCHEDULER_GITHUB_DISPATCH_TOKEN`

Optional:
- Variable: `UK_AQ_WORKFLOW_SCHEDULER_WORKER_NAME` (default `uk-aq-workflow-scheduler`)
- Secret: `UK_AQ_WORKFLOW_SCHEDULER_MANUAL_TRIGGER_KEY`

## Logging

Configured R2 history jobs:
- `uk_aq_r2_core_snapshot_v1` at 04:15 UTC dispatches `uk_aq_r2_core_snapshot.yml` with `history_version=v1`.
- `uk_aq_r2_core_snapshot_v2` at 04:20 UTC dispatches `uk_aq_r2_core_snapshot.yml` with `history_version=v2`.
- `uk_aq_r2_history_dropbox_backup_v1` at 04:35 UTC dispatches `uk_aq_r2_history_dropbox_backup.yml` with `backup_version=v1`.
- `uk_aq_r2_history_dropbox_backup_v2` at 04:45 UTC dispatches `uk_aq_r2_history_dropbox_backup.yml` with `backup_version=v2`.

Worker logs include:
- received cron expression
- `job_key` and workflow being dispatched
- GitHub API response status
- GitHub error response body (if any)

## Ops Notes

- Keep `workflow_dispatch` enabled in scheduled workflows for manual fallback.
- CIC-Test and LIVE use separate Cloudflare accounts and separate Worker deployments.
