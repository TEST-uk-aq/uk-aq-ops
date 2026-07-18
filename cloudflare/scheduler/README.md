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
- `UK_AQ_SCHEDULER_TRIGGER_SECRET` for authenticated `POST /run-if-due`

## Cloud Run authentication secret

- `UK_AQ_EDGE_UPSTREAM_SECRET`

The Worker sends the shared edge secret as `x-uk-aq-dispatch-secret`. Target
services may also accept the same value through `x-uk-aq-upstream-auth`. Never
put the value in `jobs.toml`, D1 headers, or D1 request bodies.

## Deployment-managed Cloud Run URLs

Cloud Run service URLs are normally stable across revision deployments. Jobs that
set `cloud_run_url_managed_by_deploy = true` allow their service deployment
workflow to reconcile the current `${status.url}/run` value directly into D1.
Normal `jobs.toml` syncs preserve that runtime-owned field while continuing to own
the schedule, method, body, enabled state, and dry-run state.

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
3. Apply the scheduler migrations, including `0002_scheduler_minute_slot_claim.sql`.
4. Sync `cloudflare/scheduler/jobs.toml` into D1 with the config sync workflow or the local sync script.
5. Seed `cloudflare/scheduler/seeds/0001_github_jobs.sql` only if you need a bootstrap snapshot for a brand-new D1 database.
6. Install `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT` and
   `UK_AQ_SCHEDULER_TRIGGER_SECRET` on the Worker.
7. Deploy the Worker.
8. Verify one-minute `scheduler_runs` rows and dry-run dispatch records.

Install the existing shared edge secret on the Worker:

```bash
cd cloudflare/scheduler
printf '%s' "${UK_AQ_EDGE_UPSTREAM_SECRET}" | \
  npx --yes wrangler@4 secret put UK_AQ_EDGE_UPSTREAM_SECRET \
    --name uk-aq-cron-scheduler-ops
```

Do not rotate this value only for the scheduler; it is shared with existing edge
and upstream callers and must be rotated across all consumers together.

## Notes

- Jobs are loaded from D1 at runtime.
- Individual schedules live in `jobs.toml`, not `wrangler.toml`.
- `jobs.toml` changes sync to D1 through `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml`.
- Dry-run is per job and defaults to enabled in `jobs.toml` and the seed snapshot.
- Cloudflare cron and authenticated `POST /run-if-due` calls share an atomic D1
  UTC-minute claim. The first source records and runs the minute; later calls
  receive a bounded `already_claimed` result without evaluating jobs.
