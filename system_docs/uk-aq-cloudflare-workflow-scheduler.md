# Cloudflare Workflow Scheduler

## Why GitHub Cron Was Disabled For These Jobs

GitHub-hosted cron has shown late or inconsistent starts for daily operational workflows. These specific daily workflows are now externally scheduled via Cloudflare Workers Cron Triggers and dispatched through GitHub `workflow_dispatch` API calls.

Scheduler implementation location in the ops repo:

- `cloudflare/workflow-scheduler/worker.js`
- `cloudflare/workflow-scheduler/wrangler.toml`
- `cloudflare/workflow-scheduler/wrangler.toml.example`
- `cloudflare/workflow-scheduler/README.md`
- deploy workflow: `.github/workflows/uk_aq_workflow_scheduler_deploy.yml`
  - auto-runs on pushes to `main` when `cloudflare/workflow-scheduler/**` changes
  - also supports manual `workflow_dispatch`
  - deploy run auto-replaces `YOUR_GITHUB_OWNER` with `${{ github.repository_owner }}`
  - deploy run injects cron mapping into `worker.js` from `wrangler.toml` by `job_key`
  - deploy run validates `job_key`/cron alignment after injection

## Workflows Scheduled Externally

| Repo | Workflow File | Intended UTC Schedule | Cloudflare Cron |
|---|---|---:|---|
| ingest | `uk_aq_stations_daily.yml` | 03:00 daily | `0 3 * * *` |
| ops | `uk_aq_r2_history_dropbox_backup.yml` | 04:35 daily | `35 4 * * *` |
| ops | `uk_aq_r2_history_dropbox_backup.yml` | 22:00 Sunday, force v2 prune recheck | `0 22 * * SUN` |
| ops | `uk_aq_dropbox_prune_raw.yml` | 09:22 daily | `22 9 * * *` |

Cron edit rule:
1. Change only `cloudflare/workflow-scheduler/wrangler.toml`.
2. Keep `# job_keys: ...` comments on each cron line.
3. Worker routing uses `job_key` mapping, not list position.

`uk_aq_r2_core_snapshot.yml` has moved to `cloudflare/scheduler/ops` and now runs at `5 12 * * *` from that scheduler instead of this one.

Dropbox history backup scheduling:
- The daily `35 4 * * *` dispatch runs the normal v2 Dropbox backup. It passes the active Worker `UK_AQ_R2_HISTORY_VERSION` as `history_version` and uses the v2 prune checkpoint for speed.
- The Sunday `0 22 * * SUN` dispatch runs the same workflow with `force_prune_recheck=true`. It is v2-only, forces a full v2 prune recheck, refreshes the v2 prune checkpoint, and catches unexpected Dropbox-only stale Parquet files.
- If this Worker is deployed with `UK_AQ_R2_HISTORY_VERSION=v1`, the Sunday force-prune job logs a skip and does not fail the cron event.

## Workflows Intentionally Kept On GitHub Cron

These were not moved to Cloudflare by design:
- `codeql-noarchive.yml`
- Monthly workflows (for example UK-AIR SOS monthly and monthly index maintenance)
- 5-minute egress monitor workflows
- Deploy workflows that only contain cron-like env-var strings without a real GitHub `on.schedule` trigger

## Manual Recovery Process

If an expected run does not appear:
1. Check Cloudflare Worker logs for the scheduled event time and GitHub API status.
2. Check GitHub Actions for the target workflow and confirm no repo/token permission errors.
3. Manually run the workflow from GitHub Actions using `workflow_dispatch` (`Run workflow`).
4. Fix token/config issues in the Worker deployment, then re-run missed workflows manually if needed.

## Deploy Prerequisites (GitHub Actions)

- Secret: `CLOUDFLARE_ACCOUNT_ID`
- Secret: `CLOUDFLARE_API_TOKEN`
- Secret: `UK_AQ_WORKFLOW_SCHEDULER_GITHUB_DISPATCH_TOKEN`
- Optional variable: `UK_AQ_WORKFLOW_SCHEDULER_WORKER_NAME` (default `uk-aq-workflow-scheduler`)
- Optional secret: `UK_AQ_WORKFLOW_SCHEDULER_MANUAL_TRIGGER_KEY`

## Environment Separation

CIC-Test and LIVE use separate Cloudflare accounts and separate Worker deployments. The scheduler Worker is intentionally simple and not environment-aware; each deployment owns its own job config and GitHub token.
