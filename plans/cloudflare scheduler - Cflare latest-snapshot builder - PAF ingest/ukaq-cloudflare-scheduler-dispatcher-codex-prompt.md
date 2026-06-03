# Codex Prompt: Move UK AQ Fixed Scheduling to Cloudflare Dispatchers

You are working across the UK AQ ingest and ops repos.

## Goal

Reduce Google Cloud Scheduler costs and simplify fixed scheduling by moving most fixed cron-style triggers to Cloudflare Workers, while keeping the actual heavy processing in existing GCP Cloud Run services.

This is an implementation task, but please keep changes narrow and safe.

## Current direction / architecture decision

Use this model:

```text
Cloudflare = fixed schedule dispatcher / safety checks
GCP Cloud Run = actual ingest and ops processing
GCP Cloud Tasks = keep OpenAQ dynamic self-scheduling
Supabase = existing source of truth for run history / task health
```

Do **not** move the actual ingest processing into Cloudflare Workers.

Do **not** duplicate state unnecessarily.

## Important context

The current GCP Cloud Run services all have `maxScale=1`. They are intended to run one active request per service at a time.

Known Cloud Run services include:

```text
uk-aq-aqilevels-retention-service
uk-aq-breathelondon-ingest
uk-aq-db-size-logger
uk-aq-latest-snapshot-builder
uk-aq-observs-partition-maintenance-service
uk-aq-observs-pubsub-writer
uk-aq-openaq-ingest
uk-aq-prune-daily
uk-aq-scomm-ingest
uk-aq-sos-ingest
uk-aq-supabase-db-dump-backup-service
uk-aq-timeseries-aqi-hourly
```

OpenAQ already uses Cloud Tasks to schedule its next run dynamically. Keep that behaviour.

The existing OpenAQ GCP Scheduler job is mainly a safety trigger every 30 minutes in case the task chain fails. That safety trigger can move to Cloudflare.

Breathe London and OpenAQ run stats show that Cloudflare pre-gating is not worth doing as a main cost-saving strategy:

```json
[
  { "connector_code": "breathelondon", "run_status": "skipped", "count": 1 },
  { "connector_code": "breathelondon", "run_status": "succeeded", "count": 2114 },
  { "connector_code": "openaq", "run_status": "failed", "count": 6 },
  { "connector_code": "openaq", "run_status": "partial", "count": 10368 },
  { "connector_code": "openaq", "run_status": "skipped", "count": 1418 },
  { "connector_code": "openaq", "run_status": "succeeded", "count": 3179 }
]
```

So the aim is not complex gating to avoid lots of skipped runs. The aim is to replace fixed GCP Scheduler jobs with Cloudflare cron dispatching where it is safe and maintainable.

## Desired final scheduling model

### Keep as-is / GCP-native

Keep these GCP-native behaviours:

1. `uk-aq-openaq-ingest`
   - Keep normal next-run scheduling via Cloud Tasks.
   - Move only the safety trigger to Cloudflare.

2. `uk-aq-latest-snapshot-builder`
   - Keep GCP/native for now unless investigation clearly shows it is safe to move.
   - This service is Pub/Sub/freshness critical.

3. `uk-aq-observs-pubsub-writer`
   - Keep GCP/native for now unless investigation clearly shows it is safe to move.
   - This service is Pub/Sub pipeline critical.

4. `uk-aq-supabase-db-dump-backup-service`
   - Prefer keeping on GCP Scheduler unless there is a clear, safe reason to move it.
   - Backups are important enough that a small Scheduler cost may be worth it.

### Move fixed schedules to Cloudflare dispatcher workers

Move fixed schedule triggers to Cloudflare for:

#### Ingest dispatcher

Likely targets:

```text
uk-aq-breathelondon-ingest
uk-aq-scomm-ingest
uk-aq-sos-ingest
uk-aq-openaq-ingest safety check only
```

#### Ops dispatcher

Likely targets:

```text
uk-aq-db-size-logger
uk-aq-timeseries-aqi-hourly
uk-aq-prune-daily
uk-aq-observs-partition-maintenance-service
uk-aq-aqilevels-retention-service
```

If any of these are not safe to move after inspection, explain why and leave them out.

## State / due checks

Do not create duplicate scheduler state if existing Supabase tables already contain the truth.

### Ingest checks

For ingest jobs, use existing Supabase run history / connector state, especially:

```text
ingest_runs
```

or the existing connector state tables if they are a better source of truth.

The Cloudflare ingest dispatcher should check things like:

```text
latest run for connector_code
latest run_status
last started_at
last finished_at
last succeeded_at
whether a run is currently active/in-progress
minimum recent-run gap
```

Prefer `last_started_at` for duplicate prevention, not only `last_success_at`, because a currently-running job may not have succeeded yet.

A dispatcher decision should roughly be:

```text
Do not trigger if:
- the latest run started less than X minutes ago
- the latest run is still in progress
- the latest success is recent enough for that connector

Trigger only if:
- the job is due
- it has not run too recently
- no run is currently in progress
- the job is enabled
```

### Ops checks

For ops jobs, use the existing task health table if it already tracks ops job status.

The dispatcher should check things like:

```text
task_name
last_started_at
last_success_at
last_failure_at
last_status
expected interval / stale threshold
```

A dispatcher decision should roughly be:

```text
Trigger only if:
- job is due or stale
- last_started_at is not too recent
- job is enabled
```

If the existing task health table is incomplete, add only the smallest safe additions needed, or document what is missing before making larger changes.

## Cloudflare config

Add two Cloudflare Worker dispatchers if that fits the repo structure:

```text
uk-aq-ingest-scheduler-dispatcher
uk-aq-ops-scheduler-dispatcher
```

Use the existing repo naming/style if different.

The workers should have a simple schedule/config layer defining:

```text
job name
connector/task name
Cloud Run endpoint
cron group / interval
minimum gap minutes
stale-after minutes
enabled/disabled
```

The config can initially be hard-coded in the Worker if that is simplest, but it should be easy to change.

If there is already a good Cloudflare dispatcher pattern in the repo, reuse it instead of inventing a separate style.

## Cloudflare cron strategy

Prefer a small number of Cloudflare cron triggers grouped by timing, for example:

```text
*/5 * * * *
*/15 * * * *
0 * * * *
0 2 * * *
```

Do not create one Cloudflare Worker per job.

Use one ingest dispatcher and one ops dispatcher unless the existing repo style strongly suggests otherwise.

## Cloud Run triggering / auth

Cloudflare must trigger Cloud Run securely.

Investigate the current Cloud Run auth model first:

```text
Are services private and invoked by GCP Scheduler OIDC?
Are any services public?
Do they already validate a shared secret/header?
```

Preferred practical pattern if Cloud Run must be callable from Cloudflare:

```text
Cloudflare Worker secret -> sends shared dispatch header
Cloud Run service -> validates shared secret/header before doing work
```

Requirements:

- Do not make unauthenticated public endpoints that can run jobs without protection.
- Do not expose secrets in logs.
- Use Cloudflare Worker secrets, not plain text config.
- Use GCP Secret Manager or environment variables on Cloud Run side for the expected dispatch secret.
- Keep existing GCP OIDC/IAM paths working where needed.
- Avoid breaking existing manual/safety invocation methods.

If preserving private Cloud Run + Google OIDC from Cloudflare is practical, document it. If it is too complex for this project, explain why and use the shared secret header approach.

## OpenAQ safety trigger

Do not replace OpenAQ Cloud Tasks self-scheduling.

Implement Cloudflare only as a safety backstop.

OpenAQ safety logic should roughly be:

```text
if OpenAQ next_due_at is overdue by a grace period
and no OpenAQ run is currently in progress
and last_started_at is older than the minimum safety gap:
    trigger OpenAQ safety/recovery endpoint
else:
    do nothing
```

Do not create competing normal OpenAQ schedules in Cloudflare.

## Avoiding duplicate runs

Because all target Cloud Run services have `maxScale=1`, do not add a heavy new lock system unless needed.

However, still implement dispatcher-side guards:

```text
is it due?
has it already run recently?
is a run currently in progress?
is the job enabled?
```

This prevents back-to-back duplicate runs even though Cloud Run prevents simultaneous ones.

## What not to do

Do not:

- Move full ingest processing into Cloudflare Workers.
- Remove OpenAQ Cloud Tasks scheduling.
- Add duplicate scheduler state if `ingest_runs` / task health already has the truth.
- Make Cloud Run endpoints publicly triggerable without auth.
- Remove GCP Scheduler jobs until the Cloudflare dispatcher is tested.
- Delete existing Scheduler jobs immediately.
- Change Cloud Run maxScale settings.
- Change unrelated ingest/ops business logic.
- Expose secrets.

## Deployment / migration approach

Implement in phases.

### Phase 1: Inventory and plan inside the repo

Produce a short markdown note/report before large changes, covering:

- current GCP Scheduler jobs found in scripts/config/docs
- target Cloud Run service for each
- proposed destination:
  - keep GCP Scheduler
  - Cloudflare ingest dispatcher
  - Cloudflare ops dispatcher
  - OpenAQ Cloud Tasks / Cloudflare safety only
- data source for due/recent-run checks
- auth approach

### Phase 2: Add Cloudflare dispatchers in dry-run/log-only mode

The dispatchers should be able to run and log decisions without triggering Cloud Run.

For each due check, log safe metadata only:

```text
job name
due/not due
reason
last_started_at
last_success_at
would_trigger true/false
```

Do not log secret values.

### Phase 3: Enable triggering for one low-risk job

Start with a low-risk ops job such as:

```text
uk-aq-db-size-logger
```

Confirm:

- Cloudflare cron fires
- Supabase state check works
- Cloud Run auth works
- Cloud Run service receives exactly one trigger
- task health updates normally
- no duplicate run occurs

### Phase 4: Migrate remaining fixed schedules

Move jobs gradually.

For each migrated job:

1. Enable Cloudflare dispatch.
2. Leave the GCP Scheduler job paused, not deleted, for a short verification period.
3. Confirm successful Cloudflare-triggered runs.
4. Only then document that the GCP Scheduler job can be deleted later.

### Phase 5: Cleanup recommendation only

Do not delete GCP Scheduler jobs automatically.

At the end, provide a list of GCP Scheduler jobs that are safe to delete manually after verification.

## Testing requirements

Add tests or at least clear local/manual verification steps for:

- due job triggers
- not-due job skips
- recent-run skips
- in-progress skips
- disabled job skips
- failed Supabase check fails safely
- failed Cloud Run trigger logs error and does not mark success incorrectly
- OpenAQ safety trigger does not fire when Cloud Tasks chain is healthy
- OpenAQ safety trigger would fire when overdue/stale

## Deliverables

1. Markdown migration plan/report.
2. Cloudflare ingest dispatcher Worker.
3. Cloudflare ops dispatcher Worker.
4. Safe Supabase query/RPC/view usage for ingest state and ops task health.
5. Secure Cloudflare -> Cloud Run auth implementation or documented setup steps.
6. Dry-run/log-only mode.
7. Usage/deployment docs.
8. Manual verification checklist.
9. List of GCP Scheduler jobs to keep, pause, or eventually delete.

## Final desired result

After successful migration, the intended scheduling model should be:

```text
OpenAQ normal scheduling:
  Cloud Tasks self-scheduling remains unchanged

OpenAQ safety:
  Cloudflare ingest dispatcher

Other ingest fixed schedules:
  Cloudflare ingest dispatcher -> existing Cloud Run ingest services

Ops fixed schedules:
  Cloudflare ops dispatcher -> existing Cloud Run ops services

Critical GCP-native jobs:
  latest snapshot builder, observs pubsub writer, and possibly DB backup remain GCP/native for now
```

## Cost goal

The direct cost saving is expected to be small, roughly under £1/month from reduced GCP Scheduler job count, but the goal is still worthwhile because it:

- keeps GCP Scheduler within/free-tier range where possible
- centralises fixed scheduling in Cloudflare
- keeps Cloud Run only for actual processing
- avoids unnecessary duplicate or stale runs
- preserves OpenAQ's dynamic Cloud Tasks behaviour
