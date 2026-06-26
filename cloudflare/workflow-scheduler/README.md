# Cloudflare Workflow Scheduler (GitHub Actions)

This Worker replaces selected GitHub cron schedules by calling GitHub `workflow_dispatch`.

## One-Place Schedule Edits

Change schedule times only in:
- `cloudflare/workflow-scheduler/wrangler.toml`

Each cron line must include a `job_keys` comment with one or more comma-separated logical job keys:

```toml
[triggers]
crons = [
  "0 3 * * *",   # job_keys: uk_aq_stations_daily | uk-aq-ingest/uk_aq_stations_daily.yml
  "15 4 * * *",  # job_keys: uk_aq_r2_core_snapshot | uk-aq-ops/uk_aq_r2_core_snapshot.yml
  "35 4 * * *",  # job_keys: uk_aq_r2_history_dropbox_backup | uk-aq-ops/uk_aq_r2_history_dropbox_backup.yml
  "0 22 * * SUN",  # job_keys: uk_aq_r2_history_dropbox_backup_force_prune_recheck | uk-aq-ops/uk_aq_r2_history_dropbox_backup.yml force_prune_recheck=true
  "49 5 * * *",  # job_keys: uk_aq_dropbox_prune_raw | uk-aq-ops/uk_aq_dropbox_prune_raw.yml
]
```

`worker.js` does not store literal cron values in source. Deploy injects the cron-to-logical-job map from `wrangler.toml` by `job_keys`.

## How Routing Works

1. Cloudflare fires `scheduled()` and passes only the cron string (no job name).
2. Deploy workflow builds a `cron -> [job_key, ...]` map from `wrangler.toml` comments.
3. Worker matches the received cron string to one or more logical job keys, then dispatches matching workflows.
4. R2 jobs pass one explicit `history_version` input derived from the Worker `UK_AQ_R2_HISTORY_VERSION` config, merged with any static workflow inputs declared for the logical job. The Worker does not dispatch separate v1/v2 job variants.
5. The weekly Dropbox force-prune recheck job is v2-only. A Worker deployed with `UK_AQ_R2_HISTORY_VERSION=v1` logs a skip for that job and does not fail the cron event.

The tracked `wrangler.toml` must not hard-code `UK_AQ_R2_HISTORY_VERSION`.
The deploy workflow reads `UK_AQ_R2_HISTORY_VERSION` from the current repo's
GitHub variable, validates it is `v1` or `v2`, and injects it into the
generated Worker config used for `wrangler deploy`.

## Required Secret

Worker secret:
- `GITHUB_WORKFLOW_DISPATCH_TOKEN`

Use a PAT or GitHub App token with repo access and Actions write permission for dispatch.

Optional Worker secret:
- `MANUAL_TRIGGER_KEY` (enables `GET /run?cron=...&key=...`)

Required Worker variable injected at deploy:
- `UK_AQ_R2_HISTORY_VERSION` (`v1` or `v2`)

## Deploy Workflow (Ops Repo)

Workflow:
- `.github/workflows/uk_aq_workflow_scheduler_deploy.yml`

Behavior:
- Runs on push to `main` for `cloudflare/workflow-scheduler/**` changes, or manual dispatch.
- Replaces `YOUR_GITHUB_OWNER` with `github.repository_owner` during deploy.
- Validates `UK_AQ_R2_HISTORY_VERSION` from repo variables and injects it into the generated Worker config.
- Injects cron map into `worker.js` from `wrangler.toml`.
- Validates `job_key` coverage and map alignment before deploy.

Required GitHub repo variable:
- `UK_AQ_R2_HISTORY_VERSION` (`v1` or `v2`; TEST repo should be `v2`, LIVE repo should remain `v1` until explicitly switched)

Required GitHub repo secrets:
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `UK_AQ_WORKFLOW_SCHEDULER_GITHUB_DISPATCH_TOKEN`

Optional:
- Variable: `UK_AQ_WORKFLOW_SCHEDULER_WORKER_NAME` (default `uk-aq-workflow-scheduler`)
- Secret: `UK_AQ_WORKFLOW_SCHEDULER_MANUAL_TRIGGER_KEY`

## Logging

Configured R2 history jobs:
- `15 4 * * *` dispatches `uk_aq_r2_core_snapshot` once to `uk_aq_r2_core_snapshot.yml` with `history_version` set from `UK_AQ_R2_HISTORY_VERSION`.
- `35 4 * * *` dispatches `uk_aq_r2_history_dropbox_backup` once to `uk_aq_r2_history_dropbox_backup.yml` with `history_version` set from `UK_AQ_R2_HISTORY_VERSION`. This is the normal daily v2 Dropbox backup and uses the v2 prune checkpoint for speed.
- `0 22 * * SUN` dispatches `uk_aq_r2_history_dropbox_backup_force_prune_recheck` once to `uk_aq_r2_history_dropbox_backup.yml` with `history_version` set from `UK_AQ_R2_HISTORY_VERSION` and `force_prune_recheck=true`. This weekly Sunday run forces a full v2 prune recheck, refreshes the v2 prune checkpoint, and catches unexpected Dropbox-only stale Parquet files.

Worker logs include:
- received cron expression
- cron expression, `job_key`, workflow, and non-secret workflow inputs being dispatched
- skip reason for jobs gated by active history version
- GitHub API response status
- grouped summary for cron events that dispatch multiple logical jobs
- GitHub error response body (if any)

## Ops Notes

- Keep `workflow_dispatch` enabled in scheduled workflows for manual fallback.
- CIC-Test and LIVE use separate Cloudflare accounts and separate Worker deployments.
