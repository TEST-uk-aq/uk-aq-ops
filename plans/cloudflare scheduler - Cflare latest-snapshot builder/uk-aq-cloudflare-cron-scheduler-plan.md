# UK AQ Cloudflare Cron Scheduler Migration Plan

## 1. Goal

Move UK AQ fixed scheduling into two Cloudflare cron scheduler workers:

- `uk-aq-cron-scheduler-ingest`, owned by the `uk-aq-ingest` repo
- `uk-aq-cron-scheduler-ops`, owned by the `uk-aq-ops` repo

The Cloudflare workers should become the fixed schedule source of truth for both:

1. GitHub `workflow_dispatch` workflows
2. GCP Cloud Run service triggers

Cloudflare should only dispatch work. It must not perform the heavy ingest, AQI, backup, pruning, or ops processing itself.

The final model should be:

```text
Cloudflare cron scheduler
  every minute
  reads scheduler job config from D1
  decides which jobs are due since the previous scheduler run
  dispatches GitHub workflow_dispatch or Cloud Run HTTP targets
  records dispatch attempts only

GCP Cloud Run
  keeps doing the heavy ingest and ops processing

GitHub Actions
  keeps doing workflow-based jobs, triggered by workflow_dispatch

Supabase daily task health
  remains responsible for actual job started / succeeded / failed status

OpenAQ Cloud Tasks
  remains responsible for normal OpenAQ dynamic self-scheduling
```

## 2. Naming

Use the term **Cloudflare cron scheduler** throughout docs, code comments, and deployment notes.

Use these Cloudflare worker names:

```text
uk-aq-cron-scheduler-ingest
uk-aq-cron-scheduler-ops
```

Recommended repo paths:

```text
uk-aq-ingest/workers/uk_aq_cron_scheduler_ingest/
uk-aq-ops/workers/uk_aq_cron_scheduler_ops/
```

Use hyphenated names for deployed Cloudflare workers and underscore names for repo directories, matching the existing UK AQ worker style.

## 3. Scope

### In scope

- Create two Cloudflare cron scheduler workers.
- Create two Cloudflare D1 scheduler databases.
- Absorb the existing GitHub workflow scheduler jobs into the two new schedulers.
- Dispatch GitHub workflows using `workflow_dispatch`.
- Dispatch selected Cloud Run services by secure HTTP request.
- Add dry-run / log-only mode.
- Record dispatch attempts and scheduler decisions in D1.
- Keep daily task health as the source of truth for job success and failure.
- Leave existing GitHub schedules and GCP Scheduler jobs in place until the new scheduler is verified, then remove or pause them manually.

### Out of scope

- Moving actual processing into Cloudflare Workers.
- Replacing OpenAQ Cloud Tasks normal dynamic scheduling.
- Building a full job success/failure tracker in D1.
- Deleting GCP Scheduler jobs automatically.
- Removing GitHub schedules automatically before verification.
- Changing Cloud Run scaling settings.
- Adding a complex catch-up/backfill scheduler.

## 4. Existing GitHub workflow scheduler to absorb

The existing `uk-aq-workflow-scheduler` currently has five Cloudflare cron triggers and dispatches GitHub workflows:

```toml
name = "uk-aq-workflow-scheduler"
main = "worker.js"
compatibility_date = "2026-05-13"

[triggers]
crons = [
  "0 3 * * *",      # uk_aq_stations_daily | uk-aq-ingest/uk_aq_stations_daily.yml
  "15 4 * * *",     # uk_aq_r2_core_snapshot | uk-aq-ops/uk_aq_r2_core_snapshot.yml
  "35 4 * * *",     # uk_aq_r2_history_dropbox_backup | uk-aq-ops/uk_aq_r2_history_dropbox_backup.yml
  "0 22 * * SUN",   # uk_aq_r2_history_dropbox_backup_force_prune_recheck | uk-aq-ops/uk_aq_r2_history_dropbox_backup.yml force_prune_recheck=true
  "49 5 * * *",     # uk_aq_dropbox_prune_raw | uk-aq-ops/uk_aq_dropbox_prune_raw.yml
]
```

This existing worker cannot be kept long term because it is already at five cron triggers and cannot absorb more schedules.

Move these jobs into the new schedulers as D1 job rows.

### Ingest scheduler GitHub jobs

```text
job_key: uk_aq_stations_daily
repo: TEST-uk-aq/uk-aq-ingest
workflow_file: uk_aq_stations_daily.yml
cron_expr: 0 3 * * *
target_type: github_workflow
```

### Ops scheduler GitHub jobs

```text
job_key: uk_aq_r2_core_snapshot
repo: TEST-uk-aq/uk-aq-ops
workflow_file: uk_aq_r2_core_snapshot.yml
cron_expr: 15 4 * * *
target_type: github_workflow
```

```text
job_key: uk_aq_r2_history_dropbox_backup
repo: TEST-uk-aq/uk-aq-ops
workflow_file: uk_aq_r2_history_dropbox_backup.yml
cron_expr: 35 4 * * *
target_type: github_workflow
```

```text
job_key: uk_aq_r2_history_dropbox_backup_force_prune_recheck
repo: TEST-uk-aq/uk-aq-ops
workflow_file: uk_aq_r2_history_dropbox_backup.yml
cron_expr: 0 22 * * SUN
target_type: github_workflow
workflow_inputs_json: { "force_prune_recheck": "true" }
```

```text
job_key: uk_aq_dropbox_prune_raw
repo: TEST-uk-aq/uk-aq-ops
workflow_file: uk_aq_dropbox_prune_raw.yml
cron_expr: 49 5 * * *
target_type: github_workflow
```

## 5. Cloudflare cron trigger strategy

Each new scheduler worker should have one Cloudflare cron trigger:

```toml
[triggers]
crons = ["* * * * *"]
```

The trigger schedule is UTC.

The worker should run once per minute and decide which jobs are due. This avoids using multiple Cloudflare cron lines for individual jobs and allows future schedule changes in D1 rather than in `wrangler.toml`.

No special catch-up logic is required. The scheduler should simply ask:

```text
Which enabled jobs became due since this scheduler last ran?
```

Then dispatch those jobs once.

## 6. D1 database decision

Use two separate D1 databases:

```text
uk_aq_cron_scheduler_ingest_db
uk_aq_cron_scheduler_ops_db
```

Reasons:

- Keeps ingest and ops ownership separate.
- Keeps each repo self-contained.
- Avoids accidental coupling between ingest and ops scheduling.
- Makes it easier to deploy, seed, and test each scheduler separately.

## 7. D1 responsibilities

D1 should store scheduler configuration and dispatch attempts only.

D1 should answer:

```text
What jobs exist?
Are they enabled?
When are they due?
Did the scheduler already dispatch this due slot?
What happened when the dispatch was attempted?
When did this scheduler last run?
```

D1 should not store:

```text
actual job success/failure
actual task duration
real ingest state
Cloud Run run state
OpenAQ next-run state
daily health status
long-term operational history
```

Supabase daily task health remains the source of truth for job started / succeeded / failed state.

## 8. Proposed D1 schema

### `scheduler_jobs`

```sql
create table if not exists scheduler_jobs (
  job_key text primary key,
  enabled integer not null default 1,

  target_type text not null check (target_type in ('github_workflow', 'cloud_run')),

  cron_expr text not null,
  timezone text not null default 'UTC',

  min_gap_seconds integer not null default 60,

  github_repo text,
  github_workflow_file text,
  github_ref text not null default 'main',
  github_inputs_json text,

  cloud_run_url_secret_name text,
  cloud_run_method text not null default 'POST',
  cloud_run_path text,
  cloud_run_headers_json text,
  cloud_run_body_json text,

  dry_run integer not null default 1,
  notes text,

  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);
```

### `scheduler_dispatches`

```sql
create table if not exists scheduler_dispatches (
  id integer primary key autoincrement,

  job_key text not null,
  due_at text not null,
  dispatched_at text not null default current_timestamp,

  target_type text not null,
  dry_run integer not null default 0,

  dispatch_status text not null check (dispatch_status in (
    'dry_run',
    'dispatched',
    'skipped',
    'failed'
  )),

  reason text,
  response_status integer,
  response_preview text,

  unique (job_key, due_at)
);

create index if not exists scheduler_dispatches_job_time_idx
on scheduler_dispatches(job_key, dispatched_at desc);
```

### `scheduler_runs`

```sql
create table if not exists scheduler_runs (
  id integer primary key autoincrement,
  scheduler_name text not null,
  started_at text not null default current_timestamp,
  finished_at text,
  status text not null default 'started',
  jobs_checked integer not null default 0,
  jobs_due integer not null default 0,
  jobs_dispatched integer not null default 0,
  jobs_failed integer not null default 0,
  error_message text
);

create index if not exists scheduler_runs_name_started_idx
on scheduler_runs(scheduler_name, started_at desc);
```

## 9. Duplicate prevention

Use `job_key + due_at` as the duplicate prevention key.

Flow:

```text
1. Scheduler determines a job is due for a specific due_at slot.
2. Scheduler attempts to insert a scheduler_dispatches row.
3. If insert succeeds, dispatch the target.
4. If insert conflicts on (job_key, due_at), skip because that slot was already handled.
```

This avoids duplicate dispatches if Cloudflare retries or if two scheduler invocations overlap.

## 10. How to decide what is due

The scheduler runs every minute.

For each enabled job:

```text
1. Read the most recent scheduler run time for this scheduler.
2. Compute whether the job's cron expression has a due time after the previous scheduler run and up to the current scheduler run.
3. If yes, create a due_at slot.
4. Try to insert a dispatch row for job_key + due_at.
5. Dispatch only if the insert succeeds.
```

No catch-up beyond the previous scheduler run window is required.

If there is no previous scheduler run, use a small startup lookback, for example 2 minutes.

## 11. GitHub workflow dispatch

For `target_type = github_workflow`, the scheduler should call GitHub's workflow dispatch API:

```text
POST /repos/{owner}/{repo}/actions/workflows/{workflow_file}/dispatches
```

Payload:

```json
{
  "ref": "main",
  "inputs": {}
}
```

Use `github_inputs_json` when set.

### GitHub token

Use one PAT for both repos.

Cloudflare secret name:

```text
UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT
```

Requirements:

- Token must be stored as a Cloudflare Worker secret.
- Do not log the token.
- Use the least permissions practical for dispatching workflows in `TEST-uk-aq/uk-aq-ingest` and `TEST-uk-aq/uk-aq-ops`.
- Workflows moved to Cloudflare must keep or add `workflow_dispatch`.

## 12. Cloud Run dispatch

For `target_type = cloud_run`, the scheduler should call a Cloud Run HTTP endpoint.

Recommended auth approach:

```text
Cloudflare Worker secret sends a shared dispatch header
Cloud Run service validates the same secret before doing work
```

Suggested header:

```text
x-uk-aq-dispatch-secret: <secret>
```

Suggested secret names:

Cloudflare:

```text
UK_AQ_CLOUD_RUN_DISPATCH_SECRET
```

Cloud Run / GCP Secret Manager:

```text
UK_AQ_CLOUD_RUN_DISPATCH_SECRET
```

Requirements:

- Do not make Cloud Run endpoints publicly triggerable without authentication.
- Do not log the dispatch secret.
- Keep existing GCP Scheduler/OIDC/manual invocation paths working where needed.
- Add dispatch secret validation before enabling Cloudflare dispatch for a Cloud Run service.

## 13. Initial Cloud Run migration candidates

### Ops scheduler candidates

Start with low-risk jobs:

```text
1. uk-aq-db-size-logger
2. uk-aq-timeseries-aqi-hourly
```

Then consider:

```text
uk-aq-observs-partition-maintenance-service
uk-aq-aqilevels-retention-service
```

Later, after verification:

```text
uk-aq-prune-daily
```

Keep out of the first Cloud Run migration unless explicitly reviewed:

```text
uk-aq-supabase-db-dump-backup-service
uk-aq-observs-outbox-flush-service
latest snapshot builder
observs pubsub writer
manual/backfill jobs
```

### Ingest scheduler candidates

Likely fixed Cloud Run targets:

```text
uk-aq-breathelondon-ingest
uk-aq-scomm-ingest
uk-aq-sos-ingest
```

OpenAQ:

```text
normal scheduling: keep Cloud Tasks
safety trigger only: Cloudflare cron scheduler ingest
```

## 14. Dry-run mode

Both schedulers must support dry-run mode.

In dry-run mode:

- Read D1 jobs.
- Determine due jobs.
- Insert dispatch rows with `dispatch_status = 'dry_run'`.
- Log what would have been dispatched.
- Do not call GitHub or Cloud Run.

Dry-run should be enabled by default for new jobs:

```sql
dry_run integer not null default 1
```

Enable real dispatch per job only after confirming the dry-run decisions are correct.

## 15. Migration phases

### Phase 1: Inventory

Produce inventories for:

```text
uk-aq-ingest GitHub scheduled workflows
uk-aq-ops GitHub scheduled workflows
existing uk-aq-workflow-scheduler jobs
GCP Scheduler jobs
Cloud Run services and URLs
```

For each job, classify:

```text
Cloudflare cron scheduler ingest
Cloudflare cron scheduler ops
keep native
manual only
out of scope
```

### Phase 2: Add D1 schema and seed jobs

Add D1 migrations for both repos.

Seed the existing GitHub workflow scheduler jobs into the appropriate D1 databases.

Initial seeded jobs should be `dry_run = 1`.

### Phase 3: Add scheduler workers in dry-run mode

Add:

```text
uk-aq-ingest/workers/uk_aq_cron_scheduler_ingest/
uk-aq-ops/workers/uk_aq_cron_scheduler_ops/
```

Each worker should:

- Run every minute.
- Read D1 job config.
- Check due jobs since the previous scheduler run.
- Insert dispatch records.
- Log safe metadata only.
- Avoid logging secrets.

### Phase 4: Enable GitHub dispatch

Fix/update the PAT used for workflow dispatch.

Set Cloudflare secret:

```text
UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT
```

Enable real dispatch for the existing GitHub workflow jobs, one scheduler at a time.

Recommended order:

```text
1. uk-aq-cron-scheduler-ingest: uk_aq_stations_daily
2. uk-aq-cron-scheduler-ops: uk_aq_r2_core_snapshot
3. uk-aq-cron-scheduler-ops: uk_aq_r2_history_dropbox_backup
4. uk-aq-cron-scheduler-ops: force prune recheck weekly job
5. uk-aq-cron-scheduler-ops: uk_aq_dropbox_prune_raw
```

After verification, retire the old `uk-aq-workflow-scheduler`.

### Phase 5: Add Cloud Run auth support

Before enabling Cloud Run dispatch, update selected Cloud Run services to validate the shared dispatch secret header.

Start with:

```text
uk-aq-db-size-logger
```

Then:

```text
uk-aq-timeseries-aqi-hourly
```

### Phase 6: Enable first Cloud Run dispatch

Add Cloud Run job rows to the ops D1 database with `dry_run = 1`.

Verify decisions.

Set `dry_run = 0` for `uk-aq-db-size-logger` only.

Confirm:

- Cloudflare cron fires.
- D1 due decision works.
- Cloud Run auth works.
- Cloud Run receives exactly one trigger for each due slot.
- Daily task health records the actual job result.
- No duplicate dispatch occurs.

### Phase 7: Gradual Cloud Run migration

Move additional fixed schedules gradually.

For each job:

```text
1. Add D1 row with dry_run = 1.
2. Observe dry-run decisions.
3. Add/confirm Cloud Run dispatch auth.
4. Enable real dispatch.
5. Leave old GCP Scheduler paused, not deleted, during verification.
6. Document that the old Scheduler job can be deleted later.
```

## 16. Logging requirements

Log safe scheduler metadata:

```text
scheduler_name
job_key
target_type
due_at
dispatch_status
reason
response_status
```

Do not log:

```text
GitHub PAT
Cloud Run dispatch secret
Supabase service keys
full response bodies that may contain secrets
```

Response previews should be truncated.

## 17. Testing and verification

Manual verification checklist:

```text
D1 migrations apply cleanly.
D1 seed jobs are present.
Scheduler cron fires every minute.
Scheduler records scheduler_runs rows.
Scheduler identifies due GitHub jobs.
Scheduler does not dispatch in dry-run mode.
Scheduler dispatches GitHub workflow_dispatch when dry_run = 0.
GitHub workflows start successfully.
GitHub workflows still record their own daily task health.
Duplicate job_key + due_at dispatch is prevented.
Failed GitHub dispatch is recorded as failed.
Cloud Run jobs are skipped until auth is configured.
Cloud Run shared dispatch secret works.
Cloud Run dispatch records response status.
Cloud Run service records actual success/failure through daily task health.
Old uk-aq-workflow-scheduler can be retired after verification.
Old GCP Scheduler jobs can be paused after verification.
```

## 18. Deployment notes

### Required Cloudflare bindings per scheduler

Ingest:

```toml
name = "uk-aq-cron-scheduler-ingest"
main = "worker.js"
compatibility_date = "2026-07-07"

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "SCHEDULER_DB"
database_name = "uk_aq_cron_scheduler_ingest_db"
database_id = "__D1_DATABASE_ID__"
```

Ops:

```toml
name = "uk-aq-cron-scheduler-ops"
main = "worker.js"
compatibility_date = "2026-07-07"

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "SCHEDULER_DB"
database_name = "uk_aq_cron_scheduler_ops_db"
database_id = "__D1_DATABASE_ID__"
```

### Required secrets

For GitHub workflow dispatch:

```text
UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT
```

For Cloud Run dispatch:

```text
UK_AQ_CLOUD_RUN_DISPATCH_SECRET
```

Optional per-target URL secrets may be used for Cloud Run URLs if preferred.

## 19. Final desired state

```text
uk-aq-cron-scheduler-ingest
  Cloudflare cron: every minute
  D1: uk_aq_cron_scheduler_ingest_db
  dispatches:
    GitHub ingest workflows
    fixed ingest Cloud Run services
    OpenAQ safety trigger only

uk-aq-cron-scheduler-ops
  Cloudflare cron: every minute
  D1: uk_aq_cron_scheduler_ops_db
  dispatches:
    GitHub ops workflows
    fixed ops Cloud Run services

Supabase daily task health
  tracks actual job started / success / failure

D1 scheduler tables
  track scheduler decisions and dispatch attempts only

Old uk-aq-workflow-scheduler
  retired after both new schedulers are verified

Old GitHub schedules
  removed after Cloudflare dispatch is verified

Old GCP Scheduler jobs
  paused after Cloudflare dispatch is verified
  deleted later manually if no longer needed
```

## 20. Codex implementation prompt summary

Use this condensed instruction when asking Codex to implement:

```text
Implement the UK AQ Cloudflare cron scheduler migration.

Create two workers:

- uk-aq-cron-scheduler-ingest in uk-aq-ingest
- uk-aq-cron-scheduler-ops in uk-aq-ops

Each worker runs every minute from a single Cloudflare cron trigger.

Each worker uses its own D1 database:

- uk_aq_cron_scheduler_ingest_db
- uk_aq_cron_scheduler_ops_db

D1 is the runtime source of scheduler job config and dispatch attempts.

The scheduler must support two target types:

- github_workflow, using workflow_dispatch
- cloud_run, using HTTP dispatch with shared secret header

Absorb the existing uk-aq-workflow-scheduler jobs into the two new schedulers.

Use one Cloudflare secret for GitHub workflow dispatch:

- UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT

Use one Cloudflare secret for Cloud Run dispatch:

- UK_AQ_CLOUD_RUN_DISPATCH_SECRET

Do not use D1 for job success/failure. Supabase daily task health remains responsible for that.

Do not implement complex catch-up. On each minute tick, dispatch jobs that became due since the previous scheduler run.

Implement dry-run mode by default. Do not remove old GitHub schedules, old Cloudflare worker, or old GCP Scheduler jobs automatically. Provide manual verification steps and cleanup recommendations.
```
