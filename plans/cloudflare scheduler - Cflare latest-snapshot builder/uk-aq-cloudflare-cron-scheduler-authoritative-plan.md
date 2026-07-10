# UK AQ Cloudflare Cron Scheduler
## Authoritative Implementation Plan

**Status:** Approved architecture  
**Purpose:** Replace the existing five-cron GitHub workflow scheduler and later replace selected GCP Scheduler jobs with two D1-backed Cloudflare cron schedulers.

This document is the single source of truth for the implementation.

Any earlier design based on multiple Cloudflare cron expressions, hard-coded job arrays, grouped cron triggers, or Supabase due checks is superseded by this plan.

---

## 1. Final architecture

Create one Cloudflare cron scheduler in each repository:

| Repository | Worker name | D1 database |
|---|---|---|
| `TEST-uk-aq/uk-aq-ingest` | `uk-aq-cron-scheduler-ingest` | `uk_aq_cron_scheduler_ingest_db` |
| `TEST-uk-aq/uk-aq-ops` | `uk-aq-cron-scheduler-ops` | `uk_aq_cron_scheduler_ops_db` |

Each Worker must:

1. Run once per minute from one Cloudflare cron trigger.
2. Read enabled job definitions from its own D1 database.
3. Determine which jobs became due since the previous scheduler invocation.
4. Claim each due slot once using a D1 uniqueness constraint.
5. Dispatch the target.
6. Record only the dispatch attempt and response.
7. Leave actual job success and failure reporting to the existing Supabase daily task health system.

The schedulers support two target types:

- GitHub `workflow_dispatch`
- GCP Cloud Run HTTP dispatch

Cloudflare only dispatches work. It must not perform ingest, AQI, pruning, backup, snapshot, retention, or other heavy processing itself.

---

## 2. Exact repository layout

Do not create nested `ops` or `ingest` directories inside `cloudflare/scheduler`.

### `uk-aq-ingest`

```text
cloudflare/
  scheduler/
    worker.mjs
    wrangler.toml
    README.md
    migrations/
      0001_scheduler_schema.sql
    seeds/
      0001_github_jobs.sql
    tests/
      scheduler.test.mjs
```

### `uk-aq-ops`

```text
cloudflare/
  scheduler/
    worker.mjs
    wrangler.toml
    README.md
    migrations/
      0001_scheduler_schema.sql
    seeds/
      0001_github_jobs.sql
    tests/
      scheduler.test.mjs
```

Shared helper files may be added inside each repository's `cloudflare/scheduler/` folder if needed, for example:

```text
cron.mjs
dispatch.mjs
db.mjs
```

Do not add:

```text
cloudflare/scheduler/ops/
cloudflare/scheduler/ingest/
```

---

## 3. Worker naming

### Ingest repository

```toml
name = "uk-aq-cron-scheduler-ingest"
```

### Ops repository

```toml
name = "uk-aq-cron-scheduler-ops"
```

Use these names consistently in:

- `wrangler.toml`
- logs
- D1 `scheduler_runs.scheduler_name`
- deployment documentation
- tests
- Cloudflare dashboard references

---

## 4. Cloudflare cron configuration

Each Worker must have exactly one cron trigger:

```toml
[triggers]
crons = ["* * * * *"]
```

The trigger runs every minute in UTC.

Individual job schedules must not appear in `wrangler.toml`.

Do not add one Cloudflare cron line per job.

Do not derive jobs from `controller.cron`.

D1 is the only runtime source of individual job schedules.

---

## 5. Wrangler configuration

### Ingest

```toml
name = "uk-aq-cron-scheduler-ingest"
main = "worker.mjs"
compatibility_date = "2026-07-10"

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "SCHEDULER_DB"
database_name = "uk_aq_cron_scheduler_ingest_db"
database_id = "__INGEST_D1_DATABASE_ID__"

[observability]
enabled = true

[observability.logs]
enabled = true
invocation_logs = true
```

### Ops

```toml
name = "uk-aq-cron-scheduler-ops"
main = "worker.mjs"
compatibility_date = "2026-07-10"

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "SCHEDULER_DB"
database_name = "uk_aq_cron_scheduler_ops_db"
database_id = "__OPS_D1_DATABASE_ID__"

[observability]
enabled = true

[observability.logs]
enabled = true
invocation_logs = true
```

---

## 6. D1 responsibilities

D1 is responsible for:

- job definitions
- enabled or disabled state
- individual cron expressions
- target configuration
- per-job dry-run state
- scheduler invocation history
- dispatch claims
- dispatch response status
- duplicate prevention

D1 is not responsible for:

- actual job completion
- job success or failure
- job duration
- ingest state
- Cloud Run execution state
- OpenAQ dynamic next-run state
- daily operational health

Supabase daily task health remains responsible for actual job started, succeeded, and failed status.

The scheduler must not query Supabase to decide whether a job is due.

---

## 7. D1 schema

Use the same schema in both D1 databases.

### `scheduler_jobs`

```sql
create table if not exists scheduler_jobs (
  job_key text primary key,

  enabled integer not null default 1
    check (enabled in (0, 1)),

  target_type text not null
    check (target_type in ('github_workflow', 'cloud_run')),

  cron_expr text not null,
  timezone text not null default 'UTC',

  github_repo text,
  github_workflow_file text,
  github_ref text not null default 'main',
  github_inputs_json text,

  cloud_run_url text,
  cloud_run_method text not null default 'POST',
  cloud_run_headers_json text,
  cloud_run_body_json text,

  dry_run integer not null default 1
    check (dry_run in (0, 1)),

  notes text,

  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);
```

Validation rules:

- `github_workflow` jobs require:
  - `github_repo`
  - `github_workflow_file`
  - `github_ref`
- `cloud_run` jobs require:
  - `cloud_run_url`
- `github_inputs_json`, `cloud_run_headers_json`, and `cloud_run_body_json` must contain valid JSON when populated.

### `scheduler_dispatches`

```sql
create table if not exists scheduler_dispatches (
  id integer primary key autoincrement,

  job_key text not null,
  due_at text not null,

  claimed_at text not null default current_timestamp,
  dispatched_at text,

  target_type text not null,
  dry_run integer not null default 0
    check (dry_run in (0, 1)),

  dispatch_status text not null
    check (dispatch_status in (
      'claimed',
      'dry_run',
      'dispatched',
      'failed',
      'skipped'
    )),

  reason text,
  response_status integer,
  response_preview text,

  unique (job_key, due_at),

  foreign key (job_key)
    references scheduler_jobs(job_key)
);
```

```sql
create index if not exists scheduler_dispatches_job_time_idx
on scheduler_dispatches(job_key, due_at desc);
```

### `scheduler_runs`

```sql
create table if not exists scheduler_runs (
  id integer primary key autoincrement,

  scheduler_name text not null,
  started_at text not null,
  finished_at text,

  status text not null
    check (status in ('started', 'finished', 'failed')),

  previous_run_started_at text,
  evaluation_window_start text,
  evaluation_window_end text,

  jobs_checked integer not null default 0,
  jobs_due integer not null default 0,
  jobs_claimed integer not null default 0,
  jobs_dispatched integer not null default 0,
  jobs_failed integer not null default 0,

  error_message text
);
```

```sql
create index if not exists scheduler_runs_name_started_idx
on scheduler_runs(scheduler_name, started_at desc);
```

---

## 8. Scheduler invocation algorithm

Every minute, the Worker must perform this sequence.

### Step 1: Capture the invocation time

Capture one UTC timestamp at the beginning of the invocation:

```text
current_run_started_at
```

Use that same value as the upper boundary for all due calculations in the invocation.

### Step 2: Read the previous scheduler invocation

Read the most recent earlier `scheduler_runs` row for the same scheduler name.

Use its `started_at` value as:

```text
evaluation_window_start
```

Use the current invocation time as:

```text
evaluation_window_end
```

The due interval is:

```text
(previous_run_started_at, current_run_started_at]
```

If no previous run exists, use a two-minute startup lookback:

```text
(current_run_started_at - 2 minutes, current_run_started_at]
```

There is no separate catch-up subsystem.

The scheduler simply evaluates the interval since it last ran.

### Step 3: Insert the current scheduler run

Insert a `scheduler_runs` row with:

```text
status = started
scheduler_name
started_at
previous_run_started_at
evaluation_window_start
evaluation_window_end
```

### Step 4: Read enabled jobs

Load all rows from `scheduler_jobs` where:

```sql
enabled = 1
```

Do not use a hard-coded job array in `worker.mjs`.

### Step 5: Calculate due slots

For each enabled job:

1. Parse `cron_expr`.
2. Evaluate it in UTC.
3. Find cron occurrence times inside:

```text
(evaluation_window_start, evaluation_window_end]
```

Normally this returns zero or one due slot because the Worker runs every minute.

The implementation must still behave correctly if the interval is slightly longer than one minute.

### Step 6: Claim the due slot

Before making any external request, insert:

```text
job_key
due_at
target_type
dry_run
dispatch_status = claimed
```

into `scheduler_dispatches`.

The unique constraint on:

```text
(job_key, due_at)
```

is the duplicate-prevention mechanism.

If the insert conflicts, another invocation already handled that slot. Record or log the duplicate and do not dispatch it again.

### Step 7: Dispatch or dry-run

If `dry_run = 1`:

- do not call GitHub or Cloud Run
- update `dispatch_status` to `dry_run`
- record a safe reason
- log what would have been dispatched

If `dry_run = 0`:

- dispatch according to `target_type`
- update the dispatch row with the result

### Step 8: Finish the scheduler run

Update the `scheduler_runs` row with:

```text
finished_at
status
jobs_checked
jobs_due
jobs_claimed
jobs_dispatched
jobs_failed
error_message
```

One failed target dispatch must not prevent other due jobs from being evaluated and dispatched.

---

## 9. Cron expression support

The scheduler must support the cron expressions already in use:

```text
0 3 * * *
15 4 * * *
35 4 * * *
0 22 * * SUN
49 5 * * *
```

Use a cron parser that works in Cloudflare Workers.

Required behaviour:

- UTC schedules
- named weekdays such as `SUN`
- five-field cron expressions
- exact due timestamps rounded to the minute
- no dependence on Node-only APIs unavailable in Cloudflare Workers

The parser and due-window logic must be covered by tests.

---

## 10. GitHub workflow dispatch

For:

```text
target_type = github_workflow
```

call:

```text
POST https://api.github.com/repos/{github_repo}/actions/workflows/{github_workflow_file}/dispatches
```

Request body:

```json
{
  "ref": "main",
  "inputs": {}
}
```

Use:

- `github_ref` for `ref`
- parsed `github_inputs_json` for `inputs`

### GitHub secret

Use one PAT value for both repositories.

Install it separately on both Cloudflare Workers using the same secret name:

```text
UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT
```

Required headers:

```text
Authorization: Bearer <PAT>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json
User-Agent: uk-aq-cloudflare-cron-scheduler
```

Treat GitHub HTTP `204` as successful dispatch.

Never log the PAT.

Do not include the PAT in D1.

All migrated workflows must retain `workflow_dispatch`.

---

## 11. Cloud Run dispatch

For:

```text
target_type = cloud_run
```

send an HTTP request to `cloud_run_url`.

Use:

```text
cloud_run_method
cloud_run_headers_json
cloud_run_body_json
```

### Cloud Run dispatch secret

Use this Cloudflare Worker secret:

```text
UK_AQ_CLOUD_RUN_DISPATCH_SECRET
```

Send it using:

```text
x-uk-aq-dispatch-secret
```

The matching Cloud Run service must validate the secret before real dispatch is enabled.

Do not log the secret.

Do not enable real Cloud Run jobs in the first GitHub migration phase.

---

## 12. Initial D1 seed data

All initial jobs must be inserted with:

```text
enabled = 1
dry_run = 1
```

### Ingest D1 seed

```sql
insert into scheduler_jobs (
  job_key,
  enabled,
  target_type,
  cron_expr,
  timezone,
  github_repo,
  github_workflow_file,
  github_ref,
  github_inputs_json,
  dry_run,
  notes
) values (
  'uk_aq_stations_daily',
  1,
  'github_workflow',
  '0 3 * * *',
  'UTC',
  'TEST-uk-aq/uk-aq-ingest',
  'uk_aq_stations_daily.yml',
  'main',
  '{}',
  1,
  'Migrated from uk-aq-workflow-scheduler'
);
```

### Ops D1 seed

```sql
insert into scheduler_jobs (
  job_key,
  enabled,
  target_type,
  cron_expr,
  timezone,
  github_repo,
  github_workflow_file,
  github_ref,
  github_inputs_json,
  dry_run,
  notes
) values
(
  'uk_aq_r2_core_snapshot',
  1,
  'github_workflow',
  '15 4 * * *',
  'UTC',
  'TEST-uk-aq/uk-aq-ops',
  'uk_aq_r2_core_snapshot.yml',
  'main',
  '{}',
  1,
  'Migrated from uk-aq-workflow-scheduler'
),
(
  'uk_aq_r2_history_dropbox_backup',
  1,
  'github_workflow',
  '35 4 * * *',
  'UTC',
  'TEST-uk-aq/uk-aq-ops',
  'uk_aq_r2_history_dropbox_backup.yml',
  'main',
  '{}',
  1,
  'Migrated from uk-aq-workflow-scheduler'
),
(
  'uk_aq_r2_history_dropbox_backup_force_prune_recheck',
  1,
  'github_workflow',
  '0 22 * * SUN',
  'UTC',
  'TEST-uk-aq/uk-aq-ops',
  'uk_aq_r2_history_dropbox_backup.yml',
  'main',
  '{"force_prune_recheck":"true"}',
  1,
  'Migrated from uk-aq-workflow-scheduler'
),
(
  'uk_aq_dropbox_prune_raw',
  1,
  'github_workflow',
  '49 5 * * *',
  'UTC',
  'TEST-uk-aq/uk-aq-ops',
  'uk_aq_dropbox_prune_raw.yml',
  'main',
  '{}',
  1,
  'Migrated from uk-aq-workflow-scheduler'
);
```

Seed scripts must be idempotent.

Use `insert or ignore`, `on conflict`, or an equivalent safe approach so rerunning the seed does not duplicate or unexpectedly overwrite manually changed schedules.

---

## 13. Dry-run behaviour

Dry-run is per job and stored in D1.

When `dry_run = 1`:

- calculate due slots normally
- claim the due slot normally
- insert a dispatch row
- do not call the target
- set `dispatch_status = dry_run`
- log safe target metadata
- allow verification of the complete scheduling path

Dry-run must not be controlled by a second Worker-wide hard-coded job list.

New jobs must default to dry-run.

---

## 14. Existing scheduler migration

The existing `uk-aq-workflow-scheduler` currently dispatches five GitHub jobs.

It remains active during implementation and initial dry-run testing.

Do not delete it during the implementation task.

Do not retire it until:

1. Both new Workers are deployed.
2. Both D1 databases are created and seeded.
3. Every migrated job has produced correct dry-run dispatch records.
4. The GitHub PAT is installed on both Workers.
5. Each migrated job has been tested individually with `dry_run = 0`.
6. GitHub returned `204`.
7. The expected GitHub Actions workflow started.
8. The workflow continued to report daily task health.
9. No duplicate workflow dispatch occurred.

### Cutover rule

To avoid duplicate real runs:

1. Keep the existing scheduler active while all new D1 jobs are dry-run.
2. Test one migrated D1 job using a temporary cron time not used by the old scheduler.
3. Restore its production cron after the test.
4. Once all jobs have been tested, disable or retire the old scheduler.
5. Set the migrated D1 jobs to `dry_run = 0`.
6. Monitor the first production runs.

Do not run the old scheduler and new scheduler in real-dispatch mode for the same production due slot.

---

## 15. Testing R2 core snapshot

Use `uk_aq_r2_core_snapshot` as the first ops real-dispatch test.

### Test process

1. Confirm the ops scheduler is deployed and running every minute.
2. Confirm the ops D1 seed row exists.
3. Confirm the PAT secret is installed on `uk-aq-cron-scheduler-ops`.
4. Set a temporary test cron in D1 a few minutes ahead in UTC.
5. Keep the old scheduler's production time unchanged.
6. Set only this D1 row to:

```text
dry_run = 0
```

7. Wait for the due minute.
8. Confirm:
   - one scheduler run row was created
   - one dispatch row was created
   - `dispatch_status = dispatched`
   - `response_status = 204`
   - the GitHub workflow started
   - daily task health recorded the workflow run
9. Set the job back to `dry_run = 1` if further development remains.
10. Restore the production cron:

```text
15 4 * * *
```

---

## 16. Logging

Log structured JSON containing safe fields such as:

```text
scheduler_name
scheduler_run_id
job_key
target_type
due_at
dry_run
dispatch_status
reason
response_status
```

Do not log:

```text
GitHub PAT
Cloud Run dispatch secret
full Authorization headers
Supabase keys
secret-bearing URLs
untruncated error response bodies
```

Limit response previews to a small size, for example 1,000 characters.

---

## 17. Error handling

Required behaviour:

- Invalid job config fails that job only.
- Invalid JSON fails that job only.
- Unsupported cron syntax fails that job only.
- Failed GitHub dispatch records `failed`.
- Failed Cloud Run dispatch records `failed`.
- One target failure must not stop other due jobs.
- A fatal scheduler error updates `scheduler_runs.status = failed`.
- Claimed rows must not be silently left ambiguous.
- Logs must include enough safe metadata to diagnose failures.

---

## 18. Required tests

Add automated tests for:

### Configuration

- `wrangler.toml` contains exactly one cron expression.
- That cron expression is `* * * * *`.
- The Worker loads jobs from D1.
- No hard-coded production job array exists.

### Due calculation

- daily cron due inside the previous-run window
- daily cron not due outside the window
- weekly `SUN` cron due calculation
- two-minute startup lookback
- interval boundary behaviour:
  - start boundary exclusive
  - end boundary inclusive
- no duplicate due slot for repeated evaluation

### Duplicate prevention

- first `job_key + due_at` claim succeeds
- second identical claim does not dispatch

### GitHub dispatch

- dry-run makes no network request
- `204` records `dispatched`
- non-`204` records `failed`
- workflow inputs are parsed and sent
- malformed input JSON fails safely
- PAT does not appear in logs

### Cloud Run dispatch

- dry-run makes no request
- secret header is present in the outgoing request
- secret does not appear in logs
- successful response records `dispatched`
- failed response records `failed`

---

## 19. Deployment sequence

Perform the implementation in this order.

### Phase 1: Code and tests

In both repos:

1. Add the scheduler folder files.
2. Add D1 migrations.
3. Add seed SQL.
4. Add tests.
5. Add deployment documentation.
6. Confirm local checks pass.

No production Worker or D1 changes are required in this phase.

### Phase 2: Create D1 databases

Create:

```text
uk_aq_cron_scheduler_ingest_db
uk_aq_cron_scheduler_ops_db
```

Record each database ID in its repository's `wrangler.toml`.

### Phase 3: Apply migrations and seeds

Apply the schema migration remotely.

Apply the seed SQL remotely.

Verify `scheduler_jobs` contains:

- one ingest GitHub job
- four ops GitHub jobs

### Phase 4: Configure secrets

Install this secret on both Workers:

```text
UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT
```

Install this later when Cloud Run dispatch is introduced:

```text
UK_AQ_CLOUD_RUN_DISPATCH_SECRET
```

### Phase 5: Deploy in dry-run mode

Deploy both Workers.

Verify:

- the Worker fires every minute
- `scheduler_runs` grows every minute
- due jobs produce `dry_run` dispatch rows
- no GitHub workflows are called

### Phase 6: Test GitHub dispatch

Test one job at a time with a temporary D1 cron.

Recommended order:

1. `uk_aq_r2_core_snapshot`
2. `uk_aq_stations_daily`
3. `uk_aq_r2_history_dropbox_backup`
4. `uk_aq_r2_history_dropbox_backup_force_prune_recheck`
5. `uk_aq_dropbox_prune_raw`

### Phase 7: Retire the old workflow scheduler

After all five jobs are verified:

1. Ensure old and new schedulers will not dispatch the same production slot.
2. Disable or retire `uk-aq-workflow-scheduler`.
3. Set the five D1 jobs to `dry_run = 0`.
4. Monitor the first production runs.

### Phase 8: Add Cloud Run jobs

Only after the GitHub migration is stable:

1. Add shared-secret validation to selected Cloud Run services.
2. Seed Cloud Run jobs with `dry_run = 1`.
3. Verify due decisions.
4. Enable one low-risk job at a time.
5. Pause the corresponding GCP Scheduler job after verification.
6. Do not delete GCP Scheduler jobs immediately.

---

## 20. Initial Cloud Run order

### Ops

Recommended order:

1. `uk-aq-db-size-logger`
2. `uk-aq-timeseries-aqi-hourly`
3. `uk-aq-observs-partition-maintenance-service`
4. `uk-aq-aqilevels-retention-service`
5. `uk-aq-prune-daily`

Keep out of the first Cloud Run phase:

- `uk-aq-supabase-db-dump-backup-service`
- `uk-aq-observs-outbox-flush-service`
- latest snapshot builder
- observs Pub/Sub writer
- manual or backfill jobs

### Ingest

Likely fixed targets:

- `uk-aq-breathelondon-ingest`
- `uk-aq-scomm-ingest`
- `uk-aq-sos-ingest`

OpenAQ:

- keep normal Cloud Tasks self-scheduling
- add only a Cloudflare safety trigger later

---

## 21. Explicitly prohibited designs

The implementation must not:

- create individual Cloudflare cron triggers for jobs
- create five or more cron lines in `wrangler.toml`
- use grouped cron triggers
- use `controller.cron` to select jobs
- hard-code production jobs in `worker.mjs`
- query Supabase to determine whether a schedule is due
- use daily task health as scheduler state
- create nested `cloudflare/scheduler/ops/` or `cloudflare/scheduler/ingest/` folders
- move processing into Cloudflare
- replace OpenAQ Cloud Tasks
- automatically delete GCP Scheduler jobs
- automatically retire the old scheduler before verification
- enable new jobs in real-dispatch mode by default
- log secrets

---

## 22. Acceptance criteria

The implementation is complete only when all of these are true.

### Structure

- `uk-aq-ingest/cloudflare/scheduler/` exists.
- `uk-aq-ops/cloudflare/scheduler/` exists.
- Neither contains a nested `ingest` or `ops` scheduler directory.

### Worker configuration

- Ingest Worker is named `uk-aq-cron-scheduler-ingest`.
- Ops Worker is named `uk-aq-cron-scheduler-ops`.
- Each has exactly one cron trigger.
- Each trigger is `* * * * *`.
- Each binds to its own D1 database as `SCHEDULER_DB`.

### Runtime

- Jobs are loaded from D1.
- Due slots are calculated since the previous scheduler invocation.
- First-run lookback is two minutes.
- Duplicate `job_key + due_at` dispatches are prevented.
- Dry-run is per job.
- GitHub dispatch supports inputs.
- GitHub `204` is treated as success.
- Cloud Run dispatch support exists but is not initially enabled.
- Supabase is not queried by the scheduler.

### Migration

- The existing five GitHub jobs are seeded.
- All five start in dry-run.
- The old scheduler remains until verification.
- R2 core snapshot can be tested with a temporary D1 cron.
- Documentation includes create, migrate, seed, secret, deploy, test, and cutover commands.

---

## 23. Codex implementation instruction

Use this plan as the only scheduler architecture specification.

Before coding, Codex must state that it understands these non-negotiable points:

```text
One scheduler folder at cloudflare/scheduler in each repo.
No nested ops or ingest scheduler folders.
One Worker cron per repo: * * * * *.
Individual schedules live only in D1.
Jobs are loaded from D1.
No hard-coded production job arrays.
No Supabase due checks.
D1 stores dispatch attempts, not actual job success.
Existing GitHub jobs start in dry-run.
Old scheduler remains until verified.
```

If the existing repo structure conflicts with a detail, Codex should preserve the architecture above and adapt only file naming or package scripts to the repository's established conventions.

It must not substitute the earlier multi-cron or Supabase scheduler design.
