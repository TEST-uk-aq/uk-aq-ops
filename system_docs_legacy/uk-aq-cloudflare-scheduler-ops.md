# UK AQ Cloudflare Cron Scheduler Ops

This document covers the new D1-backed ops scheduler worker.

## Scope

- Worker: `uk-aq-cron-scheduler-ops`
- Path: `cloudflare/scheduler/`
- Cron: `* * * * *`
- D1 binding: `SCHEDULER_DB`

The worker reads enabled jobs from D1, claims due slots once, and dispatches either GitHub `workflow_dispatch` or Cloud Run HTTP requests. It does not read Supabase to decide whether a job is due.

## Config source of truth

- Edit `cloudflare/scheduler/jobs.toml` to change schedules or job metadata.
- `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml` validates the file on pull requests.
- The same workflow syncs the file into D1 on pushes to `main` and on manual dispatch.
- The deploy workflow watches runtime files only, so `jobs.toml` changes do not redeploy the Worker.
- The config sync workflow only needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; the GitHub dispatch PAT remains a Worker runtime secret.

## Files

- `cloudflare/scheduler/jobs.toml`
- `cloudflare/scheduler/worker.mjs`
- `cloudflare/scheduler/shared.mjs`
- `cloudflare/scheduler/wrangler.toml`
- `cloudflare/scheduler/migrations/0001_scheduler_schema.sql`
- `cloudflare/scheduler/seeds/0001_github_jobs.sql`
- `cloudflare/scheduler/scripts/sync_jobs.py`
- `cloudflare/scheduler/tests/scheduler.test.mjs`
- `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml`
- `.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml`

## Required secret

- `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT`

## Cloud Run authentication secret

- `UK_AQ_EDGE_UPSTREAM_SECRET`

The Worker adds this value as `x-uk-aq-dispatch-secret` for Cloud Run targets. It
must match the target service's Secret Manager-backed environment value and must
not be stored in D1 job headers or bodies. The value is shared with existing
edge/upstream callers, so rotation must be coordinated across all consumers.

The `uk_aq_observs_partition_maintenance` target uses a deployment-managed URL.
Its Cloud Run deploy workflow resolves the current service URL and writes the
`/run` endpoint to D1. Config syncs preserve that URL while syncing all other job
fields from `jobs.toml`.

## Manual setup

### 1. Create the D1 database

```bash
cd cloudflare/scheduler && wrangler d1 create uk_aq_cron_scheduler_ops_db
```

### 2. Update `wrangler.toml`

- Replace `__OPS_D1_DATABASE_ID__` in `cloudflare/scheduler/wrangler.toml` with the new D1 database ID.

### 3. Apply the schema migration

```bash
cd cloudflare/scheduler && wrangler d1 migrations apply uk_aq_cron_scheduler_ops_db --remote
```

### 4. Sync `jobs.toml` into D1

```bash
python3 cloudflare/scheduler/scripts/sync_jobs.py \
  --jobs-file cloudflare/scheduler/jobs.toml \
  --sql-file /tmp/scheduler_jobs_sync.sql \
  --json-file /tmp/scheduler_jobs_expected.json
npx --yes wrangler@4 d1 execute uk_aq_cron_scheduler_ops_db \
  --remote \
  --config cloudflare/scheduler/wrangler.toml \
  --file /tmp/scheduler_jobs_sync.sql
```

### 5. Seed the initial jobs only if you need a bootstrap snapshot

```bash
cd cloudflare/scheduler && wrangler d1 execute uk_aq_cron_scheduler_ops_db --remote --file=seeds/0001_github_jobs.sql
```

### 6. Install the Worker secret

```bash
cd cloudflare/scheduler && printf '%s' "$UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT" | wrangler secret put UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT --name uk-aq-cron-scheduler-ops
```

### 7. Deploy

```bash
cd cloudflare/scheduler && wrangler deploy
```

Install the existing shared edge secret before deploying:

```bash
cd cloudflare/scheduler
printf '%s' "${UK_AQ_EDGE_UPSTREAM_SECRET}" | \
  wrangler secret put UK_AQ_EDGE_UPSTREAM_SECRET \
    --name uk-aq-cron-scheduler-ops
```

### 8. Verify locally

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

## Migration notes

- The initial seed keeps all jobs in `dry_run = 1`.
- The existing `uk-aq-workflow-scheduler` remains active until verification is complete.
- After the sync workflow is in place, `jobs.toml` is the source of truth and D1 is the runtime store.
- `jobs.toml` keeps dry-run enabled by default for the current ops jobs; the seed file mirrors that bootstrap state.
- After the dry-run period, flip individual D1 rows to `dry_run = 0` one by one and confirm the expected GitHub workflow starts.
