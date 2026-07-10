# UK AQ Cloudflare Cron Scheduler

This Worker runs once per minute and reads its schedule entirely from D1.

## Layout

- Canonical jobs: `cloudflare/scheduler/jobs.toml`
- Worker: `cloudflare/scheduler/worker.mjs`
- Shared runtime helpers: `cloudflare/scheduler/shared.mjs`
- Wrangler config: `cloudflare/scheduler/wrangler.toml`
- D1 migration: `cloudflare/scheduler/migrations/0001_scheduler_schema.sql`
- Seed data: `cloudflare/scheduler/seeds/0001_github_jobs.sql`
- Sync script: `cloudflare/scheduler/scripts/sync_jobs.py`
- Tests: `cloudflare/scheduler/tests/scheduler.test.mjs`
- Config sync workflow: `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml`
- Deploy workflow: `.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml`

## Worker name

- `uk-aq-cron-scheduler-ops`

## D1 binding

- `SCHEDULER_DB`

## Required secret

- `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT`

## Optional future secret

- `UK_AQ_CLOUD_RUN_DISPATCH_SECRET`

The Cloud Run secret is not required for the initial GitHub workflow migration.

## Local checks

```bash
node --check cloudflare/scheduler/worker.mjs
node --check cloudflare/scheduler/shared.mjs
python3 cloudflare/scheduler/scripts/sync_jobs.py \
  --jobs-file cloudflare/scheduler/jobs.toml \
  --sql-file /tmp/scheduler_jobs_sync.sql \
  --json-file /tmp/scheduler_jobs_expected.json
node --test tests/cloudflare_scheduler_ops.test.mjs
python3 -m unittest discover -s tests -p 'test*.py'
```

## Manual deployment sequence

1. Create the D1 database for the ops scheduler.
2. Update `cloudflare/scheduler/wrangler.toml` with the new D1 database ID.
3. Apply `cloudflare/scheduler/migrations/0001_scheduler_schema.sql`.
4. Sync `cloudflare/scheduler/jobs.toml` into D1 with the config sync workflow or the local sync script.
5. Seed `cloudflare/scheduler/seeds/0001_github_jobs.sql` only if you need a bootstrap snapshot for a brand-new D1 database.
6. Install `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT` on the Worker.
7. Deploy the Worker.
8. Verify one-minute `scheduler_runs` rows and dry-run dispatch records.

## Notes

- Jobs are loaded from D1 at runtime.
- Individual schedules live in `jobs.toml`, not `wrangler.toml`.
- `jobs.toml` changes sync to D1 through `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml`.
- Dry-run is per job and defaults to enabled in `jobs.toml` and the seed snapshot.
