# UK AQ Cloudflare Cron Scheduler Ops

This document covers the new D1-backed ops scheduler worker.

## Scope

- Worker: `uk-aq-cron-scheduler-ops`
- Path: `cloudflare/scheduler/`
- Cron: `* * * * *`
- D1 binding: `SCHEDULER_DB`

The worker reads enabled jobs from D1, claims due slots once, and dispatches either GitHub `workflow_dispatch` or Cloud Run HTTP requests. It does not read Supabase to decide whether a job is due.

## Files

- `cloudflare/scheduler/worker.mjs`
- `cloudflare/scheduler/wrangler.toml`
- `cloudflare/scheduler/migrations/0001_scheduler_schema.sql`
- `cloudflare/scheduler/seeds/0001_github_jobs.sql`
- `cloudflare/scheduler/tests/scheduler.test.mjs`
- `.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml`

## Required secret

- `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT`

## Optional future secret

- `UK_AQ_CLOUD_RUN_DISPATCH_SECRET`

Cloud Run dispatch remains disabled by default until the matching services are ready.

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

### 4. Seed the initial jobs

```bash
cd cloudflare/scheduler && wrangler d1 execute uk_aq_cron_scheduler_ops_db --remote --file=seeds/0001_github_jobs.sql
```

### 5. Install the Worker secret

```bash
cd cloudflare/scheduler && printf '%s' "$UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT" | wrangler secret put UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT --name uk-aq-cron-scheduler-ops
```

### 6. Deploy

```bash
cd cloudflare/scheduler && wrangler deploy
```

### 7. Verify locally

```bash
node --check cloudflare/scheduler/worker.mjs
node --test tests/cloudflare_scheduler_ops.test.mjs
```

## Migration notes

- The initial seed keeps all jobs in `dry_run = 1`.
- The existing `uk-aq-workflow-scheduler` remains active until verification is complete.
- After the dry-run period, flip individual D1 rows to `dry_run = 0` one by one and confirm the expected GitHub workflow starts.
