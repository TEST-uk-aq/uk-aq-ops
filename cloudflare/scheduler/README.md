# UK AQ Cloudflare Cron Scheduler

This Worker runs once per minute and reads its schedule entirely from D1.

## Layout

- Canonical jobs: `cloudflare/scheduler/jobs.toml`
- Worker: `cloudflare/scheduler/worker.mjs`
- Shared runtime helpers: `cloudflare/scheduler/shared.mjs`
- Wrangler config: `cloudflare/scheduler/wrangler.toml`
- D1 migrations: `cloudflare/scheduler/migrations/0001_scheduler_schema.sql` through
  `cloudflare/scheduler/migrations/0003_worker_http_target.sql`
- Seed data: `cloudflare/scheduler/seeds/0001_github_jobs.sql`
- Sync script: `cloudflare/scheduler/scripts/sync_jobs.py`
- Tests: `cloudflare/scheduler/tests/scheduler.test.mjs`
- Config sync workflow: `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml`
- Deploy workflow: `.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml`

## CI sync and Wrangler version

Scheduler workflows pin Wrangler v4 at `4.130.0`. Pull requests and relevant
pushes validate the canonical scheduler configuration, but a push rewrites
remote `scheduler_jobs` only when `jobs.toml` changed; `workflow_dispatch`
remains an explicit manual sync. Script- or workflow-only pushes validate
without mutating D1. Before a remote sync, the config workflow waits briefly
for the remote table to contain every column required by the generated job
manifest. Scheduler migrations remain owned by the deployment workflow.

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

## Supported targets

The scheduler supports `github_workflow`, `cloud_run`, and `worker_http` jobs.
The first two retain their existing request and authentication behavior.

### Worker HTTP targets

`worker_http` is a narrow authenticated target for invoking another UK AQ
Worker. Its `jobs.toml` contract is:

```toml
[jobs.example_worker]
enabled = true
cron_expr = "5 * * * *"
target_type = "worker_http"
worker_http_url = "https://example-worker.example.workers.dev/run"
worker_http_secret_binding = "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET"
dry_run = true

[jobs.example_worker.worker_http_body]
source = "scheduler"
```

`worker_http_url` is required and must be an absolute HTTPS URL.
`worker_http_secret_binding` is required and stores only the scheduler Worker
environment binding name. It must match
`^UK_AQ_[A-Z0-9_]*WORKER_HTTP_SECRET$`; unrelated scheduler bindings are
rejected. `worker_http_body` is optional, must be a TOML child table, and is
stored as compact deterministic JSON. An omitted body becomes `{}`.

At runtime, the scheduler resolves the named binding with `readSecret()` and
sends exactly one HTTPS `POST` with:

```text
Accept: application/json
Content-Type: application/json; charset=utf-8
x-uk-aq-worker-http-secret: <resolved Worker secret>
```

The request body is `JSON.stringify(worker_http_body ?? {})`. Every HTTP 2xx
response is successful; non-2xx responses use the normal bounded response
preview and are recorded as failed scheduler dispatches. If a target echoes the
secret, its exact value is redacted before the preview is stored. Arbitrary
methods and arbitrary request headers are not supported for this target.

The actual secret value must be installed as a secret on the scheduler Worker.
Never store it in `jobs.toml`, D1, a configured request body, or logs. Different
`worker_http` jobs may name and use dedicated Worker secrets.

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
3. Apply the scheduler migrations in order, including
   `0002_scheduler_minute_slot_claim.sql` and
   `0003_worker_http_target.sql`.
4. Sync `cloudflare/scheduler/jobs.toml` into D1 with the config sync workflow or the local sync script.
5. Seed `cloudflare/scheduler/seeds/0001_github_jobs.sql` only if you need a bootstrap snapshot for a brand-new D1 database.
6. Install `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT` and
   `UK_AQ_SCHEDULER_TRIGGER_SECRET` on the Worker.
7. Deploy the Worker.
8. Verify one-minute `scheduler_runs` rows and dry-run dispatch records.

For each configured `worker_http` job, install the binding named in
`worker_http_secret_binding` before enabling live dispatch. For example:

```bash
cd cloudflare/scheduler
printf '%s' "${UK_AQ_EXAMPLE_WORKER_HTTP_SECRET}" | \
  npx --yes wrangler@4.130.0 secret put UK_AQ_EXAMPLE_WORKER_HTTP_SECRET \
    --name uk-aq-cron-scheduler-ops
```

Install the existing shared edge secret on the Worker:

```bash
cd cloudflare/scheduler
printf '%s' "${UK_AQ_EDGE_UPSTREAM_SECRET}" | \
  npx --yes wrangler@4.130.0 secret put UK_AQ_EDGE_UPSTREAM_SECRET \
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
- Each claimed ops minute evaluates only its preceding one-minute window. Ops
  does not replay missed maintenance, snapshot, or backup jobs after an outage;
  operators review and run missed work manually.
