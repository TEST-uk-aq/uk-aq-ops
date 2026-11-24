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

For GitHub workflow jobs, set the full `github_repo = "owner/repository"`
directly in the environment's `jobs.toml`. The sync generator copies the
configured value into scheduler D1 without environment-variable substitution.
TEST and LIVE may use different repository owners in their environment-specific
TOML files; application code and shared configuration templates remain identical.

The Daily Task Health email has two active TEST GitHub-workflow jobs at
07:00 UTC and 10:00 UTC. Both submit `send_email="true"` and
`trigger_mode="scheduler"`; the GitHub Actions setting
`UK_AQ_HEALTH_EMAIL_SEND_ENABLED=true` must also be configured in
each intended environment. The central scheduler dispatches GitHub Actions;
it does not send SMTP mail itself.

## Worker name

- `uk-aq-cron-scheduler-ops`

## D1 binding

- `SCHEDULER_DB`

## Required scheduler secrets

- `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT`
- `UK_AQ_SCHEDULER_TRIGGER_SECRET` for authenticated `POST /run-if-due`
- `UK_AQ_MEDIA_WORKER_HTTP_SECRET` for scheduler authentication to the UK AQ
  Media discovery Worker

## Deployment-managed Worker secrets

The normal scheduler deployment manages these four Worker secrets:

- `UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT`
- `UK_AQ_EDGE_UPSTREAM_SECRET`
- `UK_AQ_SCHEDULER_TRIGGER_SECRET`
- `UK_AQ_MEDIA_WORKER_HTTP_SECRET`

Their values are stored as encrypted GitHub Actions repository secrets. The
scheduler deployment workflow passes them through its in-memory `jq` payload to
`wrangler secret bulk`, which installs them on `uk-aq-cron-scheduler-ops` before
the workflow redeploys the Worker.

`UK_AQ_MEDIA_WORKER_HTTP_SECRET` authenticates scheduler requests to the UK AQ
Media discovery Worker. Its value must never be stored in `jobs.toml`, D1,
request bodies, repository source, or logs. The Media `worker_http` job refers
only to the binding name `UK_AQ_MEDIA_WORKER_HTTP_SECRET`.

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

### Media discovery job

`uk_aq_media_discovery` is configured as a live `worker_http` job calling the UK
AQ Media discovery receiver at
`https://uk-aq-media-discovery.uk-aq-media.workers.dev/scheduler/run`. It uses
the dedicated `UK_AQ_MEDIA_WORKER_HTTP_SECRET` binding.

The current steady-state cadence is `0 */2 * * *`. Before switching to that
cadence, repeated real dispatches were proven at a temporary `*/5 * * * *`
validation cadence. Those runs successfully reached the Media receiver, received
HTTP 202 responses, enqueued Media Queue work and completed the Queue consumer.

The Media account's native Cron trigger has been removed from Cloudflare and from
the Media Wrangler configuration, so the TEST central scheduler is the active
scheduling authority during standalone operation. When Media moves to public/LIVE
operation, this job moves to the LIVE central scheduler.

### Media GDELT job

`uk_aq_media_gdelt` is a live `github_workflow` job that dispatches
`TEST-uk-aq/uk-aq-media`'s `uk_aq_media_gdelt.yml` workflow on `main` at minutes
10, and 40  each hour. The GDELT acquisition runs on the GitHub Actions
runner; the scheduler only makes the workflow dispatch. The workflow has no native
GitHub Actions Cron, so this Ops job is its sole scheduling authority. This is
separate from `uk_aq_media_discovery`, which remains the two-hour `worker_http`
RSS discovery job.

## Deployment-managed Cloud Run URLs

Cloud Run service URLs are normally stable across revision deployments. Jobs that
set `cloud_run_url_managed_by_deploy = true` allow their service deployment
workflow to reconcile the current `${status.url}/run` value directly into D1.
Normal `jobs.toml` syncs preserve that runtime-owned field while continuing to own
the schedule, method, body, enabled state, and dry-run state.

The News email `worker_http` job similarly uses
`worker_http_url_managed_by_deploy = true` rather than committing an
environment-specific Worker URL. Configure `scheduler_jobs.worker_http_url`
in each environment's Ops scheduler D1 database to its own deployed email
Worker's HTTPS `/scheduler/run` endpoint before enabling the job.
Normal jobs sync preserves the runtime-owned URL and validates that enabled
jobs do not retain the deployment-pending placeholder. There is no fallback
to another environment's Worker. The separate
`UK_AQ_MEDIA_EMAIL_WORKER_HTTP_SECRET` binding must be present on the
Ops scheduler Worker and match the receiving email Worker before enabling
the five-minute Daily/recovery job.

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

1. Create the D1 database for the Ops scheduler.
2. Set its environment-owned database ID in `cloudflare/scheduler/wrangler.toml`.
3. For a new database, apply `schemas/cloudflare_d1/ops_scheduler.sql` from
   `uk-aq-schema`. The Ops numbered migrations are the historical deployed
   baseline. For an existing database at 0001–0003, use the upgrade below.
4. Sync its own `cloudflare/scheduler/jobs.toml` through the config sync workflow.
5. Deploy the Worker and verify minute rows and dispatch receipts.

Normal GitHub-managed deployment installs the four secrets above automatically.
For manual bootstrap or recovery, an operator may still install a binding with
Wrangler. For each configured `worker_http` job, install the binding named in
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

## TEST scheduler reliability rollout

These are operator steps. Merging the Ops change into `main` triggers its
existing deployment and job-sync workflows. Authorise the merge with that
effect in mind. Authorise database changes, workflow dispatches, controlled
fault injection and email sends separately.

1. Record the deployed Worker version and current TEST job manifest. Confirm
   TEST D1 has the historical Ops migrations 0001–0003, then apply the
   companion TEST Schema migration once. From the Ops repository root, with
   TEST Cloudflare credentials and a checkout of the approved Schema revision:

   ```bash
   npx --yes wrangler@4.130.0 d1 execute uk_aq_cron_scheduler_ops_db \
     --remote --config cloudflare/scheduler/wrangler.toml \
     --file ../uk-aq-schema/schemas/migrations/20261124_001_cloudflare_d1_ops_scheduler_reliability.sql
   ```

   Check `pragma table_info(scheduler_jobs)`, `pragma table_info(scheduler_runs)`
   and `pragma table_info(scheduler_dispatches)`, and check
   `pragma index_list(scheduler_dispatches)`. Expect the new look-back column
   defaulting to 0, nullable claim tokens and the due-time index. If application
   is interrupted, inspect this state and apply only missing changes. Keep all
   existing minute and dispatch records.

2. Set the Ops Actions variable `UK_AQ_OPS_SCHEDULER_URL` to the existing TEST
   Worker's HTTPS origin, the same setting used by the watchdog. Use the
   existing TEST `UK_AQ_SCHEDULER_TRIGGER_SECRET`. Confirm the existing GitHub
   dispatch PAT can list runs for the configured Black Carbon workflow as
   well as dispatch it. The health read requires the trigger secret and
   returns only bounded scheduler diagnostics. A failed or truncated read
   is identified in the email and report artifacts.

3. Before syncing the recovery opt-in, deploy the reviewed Ops PR branch
   through the existing `uk_aq_cloudflare_scheduler_ops_deploy.yml` workflow
   using its branch ref. The additive D1 defaults keep recovery off. Observe
   a real 08:00 UTC TEST minute. Check one `scheduler_runs` row, one receipt
   per due job, and the independent outcomes of both Media jobs and Black
   Carbon. For Black Carbon, expect one HTTP 204 receipt and one matching
   Actions run. Confirm actual workflow and Task Health results separately.
   Inspect the 14-day reconciliation, canonical R2 safety checks and the
   2024-onwards diurnal publication in that run. Do not resend either email.

4. After normal-dispatch acceptance and separate activation approval, merge
   the reviewed Ops change. Verify the deployment and config-sync workflow
   results and confirm that only `uk_aq_ukair_bc_daily` has
   `recovery_lookback_minutes = 360`. Keep the policy enabled before the next
   test slot. A config change around a slot can make it ineligible for
   automatic recovery. Use the following query shapes with the selected UTC
   day substituted for `YYYY-MM-DD`. The first query checks minute
   ownership and errors. The second checks original due time and receipts.

   ```sql
   select id, minute_slot, trigger_source, status, jobs_due, jobs_claimed,
          jobs_dispatched, jobs_failed, error_message
   from scheduler_runs
   where minute_slot >= 'YYYY-MM-DDT08:00:00.000Z'
     and minute_slot < 'YYYY-MM-DDT08:15:00.000Z'
   order by minute_slot;

   select id, job_key, due_at, claimed_at, dispatched_at, dispatch_status,
          response_status, reason
   from scheduler_dispatches
   where due_at = 'YYYY-MM-DDT08:00:00.000Z'
   order by job_key;
   ```

5. Validate a genuine missed slot when one occurs, or use the separately
   authorised TEST-only fault injection below. Pick a future 08:00 UTC slot.
   Coordinate with anyone who can manually launch Black Carbon. Leave the
   other 08:00 jobs on their regular paths. Observe the absent Black Carbon
   receipt after the 08:00 minute and the other jobs' recorded outcomes.
   Starting at 08:10 UTC, expect one recovery claim, one
   `recovery_accepted` HTTP 204 receipt with the original 08:00 `due_at`
   and a later `dispatched_at`, and a single real Actions run. Observe a later
   minute and verify the same dispatch ID and no second run. If GitHub
   history is inconclusive or shows a recent run, expect `skipped` with a
   `recovery_review_*` reason and investigate before authorising a manual run.

6. For a real outstanding claim, confirm the scheduler holds it past the
   ten-minute grace period. To exercise this safely in TEST with authorisation,
   use the second fixture below on a different day. It prevents the Black
   Carbon terminal write after its ordinary request. Confirm the original
   Actions run and one `claimed` D1 row. Past 08:10 and in subsequent
   invocations, verify neither the scheduler nor watchdog submits it again.
   Preserve the evidence for operator review.

7. Inspect the private 10:00 UTC supplement or dispatch its existing preview
   from the reviewed revision with `report_type=supplement` and
   `send_email=false`. Expect the same 07:00–10:00 task window, status
   meanings and counts. Verify scheduler diagnostics for the recovered or
   uncertain 08:00 slot, including time and D1 ID. For a genuinely unstarted
   Black Carbon workflow, confirm the existing Missing entry and check that
   scheduler evidence adds no task failure to the counts. With unavailable
   scheduler evidence, the preview should explicitly say so and still
   render the available task results. Confirm the normal authorised email
   delivery through the existing SMTP workflow.

### Optional controlled TEST failures

With separate authorisation, save one fixture as `test-bc-fixture.sql` with
the agreed future UTC date. Run from the Ops repository root:

```bash
npx --yes wrangler@4.130.0 d1 execute uk_aq_cron_scheduler_ops_db \
  --remote --config cloudflare/scheduler/wrangler.toml --file ./test-bc-fixture.sql
```

Apply one fixture at a time. These triggers match one Black Carbon slot only.

For a missing claim, install before 08:00 UTC. The trigger blocks the
ordinary claim and allows a recovery claim.

```sql
create trigger test_bc_missed_slot
before insert on scheduler_dispatches
when new.job_key = 'uk_aq_ukair_bc_daily'
 and new.due_at = 'YYYY-MM-DDT08:00:00.000Z'
 and new.reason is null
begin
  select raise(abort, 'TEST Black Carbon normal claim blocked');
end;
```

For an uncertain receipt, install before a different 08:00 UTC slot.

```sql
create trigger test_bc_uncertain_receipt
before update on scheduler_dispatches
when old.job_key = 'uk_aq_ukair_bc_daily'
 and old.due_at = 'YYYY-MM-DDT08:00:00.000Z'
 and old.dispatch_status = 'claimed'
begin
  select raise(abort, 'TEST Black Carbon terminal receipt blocked');
end;
```

Drop the installed trigger after capturing the expected evidence, including
when validation fails. Execute `drop trigger if exists test_bc_missed_slot;`
or `drop trigger if exists test_bc_uncertain_receipt;` on the same TEST D1.
Keep the dispatch rows. Treat GitHub visibility and dispatch as separate
requests that cannot arbitrate concurrent manual starts. Before an operator
dispatches a replacement, disable the recovery policy, allow in-flight
scheduler work to settle and reconcile the D1 receipt against Actions
history and existing task health. A failed workflow needs its normal
operator recovery decision.

### Rollback

To stop recovery, use the current job sync with the TEST Black Carbon
look-back set to zero. If a config sync is unavailable and the operator
authorises a direct change, update just that job's
`recovery_lookback_minutes` to `0` and `updated_at` to `current_timestamp`
in D1, then align TEST `jobs.toml`. Confirm zero before another sync and
allow any already claimed recovery to settle. If necessary, roll back to the
recorded deployed Worker version and revert the Ops code/workflows through
the normal TEST release process. Keep the additive columns and indexes,
and retain all dispatch/minute receipts for operator reconciliation.
