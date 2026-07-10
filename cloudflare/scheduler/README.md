# UK AQ Cloudflare Cron Scheduler

This Worker runs once per minute and reads its schedule entirely from D1.

## Layout

- Worker: `cloudflare/scheduler/worker.mjs`
- Wrangler config: `cloudflare/scheduler/wrangler.toml`
- D1 migration: `cloudflare/scheduler/migrations/0001_scheduler_schema.sql`
- Seed data: `cloudflare/scheduler/seeds/0001_github_jobs.sql`
- Tests: `cloudflare/scheduler/tests/scheduler.test.mjs`

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
node --test tests/cloudflare_scheduler_ops.test.mjs
```

## Manual deployment sequence

1. Create the D1 database for the ops scheduler.
2. Update `cloudflare/scheduler/wrangler.toml` with the new D1 database ID.
3. Apply `cloudflare/scheduler/migrations/0001_scheduler_schema.sql`.
4. Seed `cloudflare/scheduler/seeds/0001_github_jobs.sql`.
5. Install `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT` on the Worker.
6. Deploy the Worker.
7. Verify one-minute `scheduler_runs` rows and dry-run dispatch records.

## Notes

- Jobs are loaded from D1 at runtime.
- Individual schedules do not live in `wrangler.toml`.
- Dry-run is per job and defaults to enabled in the seed data.
