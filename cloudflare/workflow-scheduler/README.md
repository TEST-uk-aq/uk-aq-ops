# Cloudflare Workflow Scheduler (GitHub Actions)

This Worker replaces selected GitHub cron schedules by calling GitHub `workflow_dispatch` via API.

## What It Schedules

Configured in `worker.js` (`JOBS` array):
- `0 3 * * *` -> ingest `uk_aq_stations_daily.yml`
- `15 4 * * *` -> ops `uk_aq_r2_core_snapshot.yml`
- `35 4 * * *` -> ops `uk_aq_r2_history_dropbox_backup.yml`
- `49 5 * * *` -> ops `uk_aq_dropbox_prune_raw.yml`

Each deployment/account should edit `owner`, `repo`, and `ref` values for its own environment.

## Required Secret

Set a Worker secret (never hard-code in source):
- `GITHUB_WORKFLOW_DISPATCH_TOKEN`

Token options:
- Fine-grained PAT with repository access and **Actions: Read and write** for the target repos.
- Or GitHub App installation token with equivalent workflow dispatch capability.

Optional secret for manual HTTP trigger endpoint:
- `MANUAL_TRIGGER_KEY` (enables `GET /run?cron=...&key=...`)

## Setup

1. Copy config:
```bash
cd cloudflare/workflow-scheduler
cp wrangler.toml.example wrangler.toml
```
2. Edit `worker.js` `JOBS` entries (`owner`, `repo`, `ref`) for this account/environment.
3. Deploy secret:
```bash
wrangler secret put GITHUB_WORKFLOW_DISPATCH_TOKEN
```
4. Deploy Worker:
```bash
wrangler deploy
```
5. Confirm cron triggers in `wrangler.toml`:
- `0 3 * * *`
- `15 4 * * *`
- `35 4 * * *`
- `49 5 * * *`

## Testing

1. Trigger a scheduled event manually from Cloudflare Worker dashboard (`Run` on a scheduled trigger), temporarily set a near-future cron, or call `/run` if `MANUAL_TRIGGER_KEY` is configured.
2. Check Worker logs for:
- received cron expression
- workflow dispatch target
- GitHub response status
- GitHub error response body (if any)
3. Verify run appears in GitHub Actions for the target workflow.

## Operational Notes

- Keep `workflow_dispatch` enabled in the workflow files for manual fallback.
- If Cloudflare scheduling fails, run the workflow manually in GitHub Actions (`Run workflow`).
- CIC-Test and LIVE should use separate Cloudflare accounts and separate Worker deployments/tokens.
