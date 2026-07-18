# 2026-07-18 Scheduler minute-slot watchdog

## Status

Implementation plan for the UK AQ TEST system.

- Plan repository: `TEST-uk-aq/uk-aq-ops`
- Implementation repositories:
  - `TEST-uk-aq/uk-aq-ops`
  - `TEST-uk-aq/uk-aq-ingest`
- Local watchdog host: always-on MacBook Pro used for the TEST system
- Scope: TEST only
- LIVE/Beta scheduling: unchanged and still uses GCP
- Plan date: 18 July 2026
- Recommended Codex configuration: **GPT-5.6 Codex with High reasoning**
- Default permission level: Level 1 code changes, followed by operator-run TEST deployment and operational validation

## Objective

Add a permanent independent trigger path for the two existing Cloudflare scheduler Workers without creating a second scheduler implementation.

The always-on MacBook Pro will run a small macOS `launchd`-managed watchdog. Once per UTC minute it will call an authenticated endpoint on:

- `uk-aq-cron-scheduler-ingest`
- `uk-aq-cron-scheduler-ops`

Both the normal Cloudflare Cron Trigger and the MacBook Pro watchdog will use the same atomic D1 minute-slot claim. Only the first trigger source to claim a UTC minute may execute that scheduler minute.

This must provide the following behaviour:

1. When Cloudflare Cron Triggers are unavailable, the MacBook Pro runs each scheduler once per minute.
2. When Cloudflare Cron Triggers recover, the MacBook Pro remains enabled as a fallback.
3. When both sources fire for the same minute, only one scheduler run is created and executed.
4. Existing D1 job-dispatch claims continue to prevent duplicate target dispatches across recovery windows.
5. A failed or abandoned scheduler run does not permanently lose later due jobs; a later completed run re-evaluates from the last completed evaluation window.
6. SOS remains disabled while the UK-AIR SOS service is still failing.
7. TEST GCP triggers can be turned off after the MacBook Pro path is operationally validated.
8. LIVE/Beta GCP schedules and LIVE repositories are not touched.

## Incident context

On 18 July 2026 both independent Cloudflare Cron Trigger Workers stopped receiving scheduled events at approximately 08:13 UTC while:

- their cron schedules remained visible;
- the displayed next-run time continued advancing;
- their production Worker versions remained deployed;
- their HTTP health handlers continued to work;
- their D1 bindings remained present;
- no new `scheduler_runs` rows appeared.

The TEST GCP triggers were restored and forced runs completed successfully. SOS was deliberately left disabled because the UK-AIR SOS dependency remains unhealthy.

This plan treats the MacBook Pro as a trigger-source fallback only. Cloudflare Workers and D1 remain authoritative for scheduler state, cron evaluation, due-job selection, target dispatch and audit history.

## Authoritative reading and operating constraints

Before changing code, Codex must work from the current local checkouts only and read, in this order:

1. `TEST-uk-aq-ops/AGENTS.md`
2. `TEST-uk-aq-ingest/AGENTS.md`
3. `TEST-uk-aq-ingest/AGENTS_BASE.md`
4. the current scheduler `README.md`, `jobs.toml`, migrations, deployment workflow and Worker code in both repositories
5. directly relevant existing scheduler checks only
6. relevant `system_docs/` pages for context only

Use `grep`, not `rg`, for repository discovery.

Do not inspect or modify any LIVE repository, service, database, schedule or secret.

Codex must treat every `system_docs/` directory as read-only. ChatGPT in Chat mode will update system documentation after implementation has been deployed and validated through real TEST operation.

Codex must not:

- deploy either Worker;
- apply remote D1 migrations;
- change Cloudflare settings;
- enable or disable GCP Scheduler jobs;
- install or load the MacBook Pro LaunchAgent;
- call the deployed scheduler endpoints;
- create or modify Git commits;
- run broad test suites;
- create speculative test coverage.

Follow each repository's archive policy. If the Worker changes are considered substantial enough to require an archive snapshot, archive active non-test code only, first check whether today's snapshot already exists, and never archive tests, plans, documentation or `system_docs/`.

## Existing behaviour that must not change

Preserve:

- `jobs.toml` as the canonical scheduler job definition source;
- UTC-only cron interpretation;
- the existing half-minute dispatch lead;
- D1 `scheduler_dispatches` uniqueness on `(job_key, due_at)`;
- current GitHub workflow dispatch behaviour;
- current Cloud Run request construction, secrets and response recording;
- ingest scheduler Breathe London Nodes staged-response and reconciliation behaviour;
- dry-run handling;
- bounded response previews and structured logs;
- scheduler health responses on `/` and `/health`;
- the normal Cloudflare `scheduled()` handler;
- existing job timings other than temporarily disabling SOS;
- existing GCP and Cloudflare deployment ownership;
- all LIVE/Beta behaviour.

Do not move scheduler execution onto the MacBook Pro. The Mac must not receive:

- the scheduler D1 API credentials;
- GitHub workflow dispatch PATs;
- downstream Cloud Run dispatch secrets;
- target URLs as an independently maintained schedule;
- Cloudflare API write access.

The Mac needs only the two Worker URLs and one dedicated scheduler-trigger secret.

## Options considered

### Option A: recreate scheduler execution locally on the MacBook Pro

The Mac would parse local schedules and call GitHub workflows and Cloud Run targets directly.

Pros:

- independent of Cloudflare Worker HTTP availability;
- could operate without any Worker change.

Cons:

- duplicates cron parsing, due-window calculation, dispatch logic and state;
- requires powerful GitHub and target credentials on the Mac;
- loses or duplicates D1 scheduler audit behaviour;
- creates configuration drift between the Mac and Workers;
- makes recovery and duplicate prevention harder;
- increases the impact of a compromised local machine.

Egress impact:

- target request volume is similar, but calls originate directly from the Mac;
- no meaningful Supabase billable egress benefit;
- more local-to-cloud network traffic and credential-bearing requests.

Database-size impact:

- no new D1 claim data, but scheduler run history becomes incomplete or requires a second store;
- duplicate dispatches could increase downstream operational records.

### Option B: authenticated Worker endpoint plus atomic D1 minute claim

The Mac calls each existing Worker once per minute. Both the HTTP endpoint and Cloudflare `scheduled()` handler atomically claim the same canonical UTC minute before running the existing scheduler.

Pros:

- one scheduler implementation and one job configuration per repository;
- Cloudflare and Mac trigger sources can coexist permanently;
- atomic duplicate prevention occurs before scheduler execution;
- existing dispatch claims remain a second safety layer;
- the Mac holds only a narrowly scoped trigger secret;
- D1 remains the authoritative audit and recovery store;
- Cloudflare Cron recovery requires no Mac reconfiguration.

Cons:

- requires a small D1 migration in both scheduler databases;
- requires equivalent focused Worker changes in both repositories;
- requires a persistent local watchdog process and local operational logs;
- still depends on the Worker HTTP endpoint and the Mac's internet connection.

Egress impact:

- two small HTTP watchdog requests per minute, approximately 2,880 requests per day across both Workers;
- response bodies are small and bounded;
- no material Supabase billable egress change;
- target request volume remains determined by the existing schedules;
- when Cloudflare cron is healthy, the losing Mac call performs only a small D1 claim/read and bounded response.

Database-size impact:

- no additional scheduler run row frequency: each scheduler still creates at most one run row per minute;
- two nullable metadata columns and one unique index are added to `scheduler_runs`;
- modest D1 index overhead only;
- no Supabase schema or data change.

### Option C: add another hosted scheduler or Cloudflare Queue/Workflow layer

Use another cloud scheduler, Queue consumer or Workflow as a redundant trigger/execution layer.

Pros:

- avoids dependence on the Mac being online;
- can provide managed retries and longer background execution.

Cons:

- duplicates the purpose of the restored GCP fallback;
- introduces more cloud configuration and cost for a TEST system;
- expands credentials and deployment paths;
- does not remove the need for duplicate claims;
- materially increases implementation and operational complexity.

Egress impact:

- extra hosted trigger and queue traffic;
- no Supabase billable egress advantage.

Database-size impact:

- likely additional queue/workflow state outside D1;
- D1 claims are still required for safe coexistence.

## Recommendation

Implement Option B.

It provides minute-level failover while preserving one authoritative scheduler implementation. It has negligible egress impact, does not add Supabase storage, adds only modest D1 index overhead, and allows Cloudflare cron and the MacBook Pro watchdog to coexist without duplicate scheduler runs.

## Target architecture

```text
Cloudflare Cron Trigger ─┐
                         ├─> claim UTC minute in scheduler D1
MBPro launchd watchdog ──┘               │
                                         ├─ claim won: run existing scheduler
                                         └─ already claimed: bounded no-op
```

The MacBook Pro watchdog should call each Worker shortly after the minute boundary, for example at `HH:MM:10`, so a healthy Cloudflare Cron Trigger normally has the first opportunity to claim the minute.

When Cloudflare cron is absent, the Mac claims every minute and becomes the effective primary trigger.

## D1 minute-slot contract

### Schema amendment

Add nullable fields to `scheduler_runs` in each scheduler database:

```text
minute_slot
trigger_source
```

Add a unique index on:

```text
(scheduler_name, minute_slot)
```

Existing rows may retain `NULL` for the new fields. SQLite permits multiple `NULL` values in a unique index, so no historical backfill is required.

Suggested migration numbering:

- ops: `cloudflare/scheduler/migrations/0002_scheduler_minute_slot_claim.sql`
- ingest: `cloudflare/scheduler/migrations/0003_scheduler_minute_slot_claim.sql`

Use the actual next available migration numbers after inspecting the local repositories.

### Canonical minute

Calculate the claim slot by flooring the supplied trigger time to the UTC minute:

```text
2026-07-18T10:45:00.000Z
```

The minute claim must be atomic, using D1 `insert or ignore`, `on conflict do nothing`, or an equivalent single-statement approach.

### Run metadata

For new scheduler runs:

- `minute_slot` records the canonical UTC minute;
- `trigger_source` is bounded and controlled by code;
- expected values include:
  - `cloudflare_cron`
  - `external_watchdog`
- `started_at` records the actual invocation/claim time;
- `evaluation_window_end` uses the canonical minute slot.

Do not accept an arbitrary unbounded trigger source from the HTTP request.

### Duplicate result

When another trigger source has already claimed the minute, return a bounded result such as:

```json
{
  "ok": true,
  "status": "already_claimed",
  "scheduler_name": "uk-aq-cron-scheduler-ingest",
  "minute_slot": "2026-07-18T10:45:00.000Z",
  "scheduler_run_id": 12345,
  "run_status": "started"
}
```

The duplicate path must not evaluate jobs or dispatch targets.

### Recovery baseline

Do not use a still-running or failed scheduler row as the authoritative completed evaluation baseline.

The next claimed run should derive its evaluation window start from the latest earlier run that completed successfully enough to close its scheduler evaluation, normally the latest row with `status = 'finished'` and a valid `evaluation_window_end`.

This allows a later run to recover slots after:

- an abandoned `started` row;
- a Worker exception;
- a failed HTTP watchdog request;
- a Mac restart;
- a temporary network outage.

Existing `(job_key, due_at)` dispatch uniqueness must remain the protection against repeating target jobs while a recovery run re-evaluates an earlier window.

## Authenticated Worker endpoint

Add to each scheduler Worker:

```text
POST /run-if-due
```

### Authentication

Use a dedicated Worker secret:

```text
UK_AQ_SCHEDULER_TRIGGER_SECRET
```

Suggested request header:

```text
X-UK-AQ-Scheduler-Trigger: <secret>
```

Requirements:

- missing or incorrect secret returns HTTP 401 or 403;
- compare only bounded strings;
- never log the secret or echo it in a response;
- do not reuse the Cloudflare API token;
- do not expose the endpoint without authentication;
- `GET /run-if-due` and unrelated methods return 404 or 405;
- `/` and `/health` remain unchanged.

### Execution

The HTTP request should remain connected while the claimed scheduler run executes and should return the bounded scheduler result when complete.

Do not return immediately and rely on `ctx.waitUntil()` for the full scheduler run. HTTP-triggered Worker `waitUntil()` work may continue for only a short post-response period, while scheduler target calls may legitimately run much longer.

The Mac watchdog must therefore allow the HTTP calls to remain in flight while still initiating later minute requests independently.

### Shared execution path

Both trigger sources must call the same implementation:

```text
Cloudflare scheduled() -> claim minute -> run scheduler
POST /run-if-due      -> claim minute -> run scheduler
```

Do not maintain separate due-job or dispatch logic for the HTTP endpoint.

### Response contract

A successful claimed run returns the existing bounded scheduler summary plus:

- `status: triggered` or equivalent;
- `trigger_source`;
- `minute_slot`.

A duplicate claim returns HTTP 200 with `status: already_claimed`.

An authentication failure returns 401/403.

A genuine scheduler execution failure returns a bounded HTTP 500 response and retains the failed D1 run evidence.

## MacBook Pro watchdog

### Ownership

Place the local watchdog implementation in the ops repository because it is cross-repository operational infrastructure.

Suggested directory:

```text
scripts/mbpro_scheduler_watchdog/
```

Suggested files:

```text
uk_aq_scheduler_watchdog.py
install_launchagent.sh
uninstall_launchagent.sh
status_launchagent.sh
uk.co.ukaq.test-scheduler-watchdog.plist.template
watchdog.env.example
README.md
```

These are suggestions. Codex must inspect existing script and launchd conventions before finalising names.

### Process model

Use a persistent Python process managed by a macOS LaunchAgent:

- `RunAtLoad = true`;
- `KeepAlive = true`;
- launchd restarts the process if it exits;
- the Python process aligns itself to each UTC minute plus a small offset, initially 10 seconds;
- it starts ingest and ops requests independently;
- a slow request must not block the next minute's calls;
- no third-party Python packages are required.

Do not use a simple `StartInterval=60` script that waits synchronously for the Worker response. macOS normally avoids launching another instance of the same launchd job while the previous process is still running, which could reduce the trigger cadence when a scheduler request takes more than one minute.

### Concurrency

The watchdog should support overlapping minute requests while bounding local resource use.

Suggested behaviour:

- submit one request per Worker per minute;
- maintain a bounded executor or bounded in-flight set;
- allow later minute slots while an earlier request remains connected;
- cap in-flight calls per Worker at a small number determined from the existing maximum scheduler/target duration;
- when the cap is reached, log a bounded warning and skip that local attempt;
- rely on the next successful Worker run's recovery window to catch missed due slots.

Codex must inspect current service timeouts before choosing the request timeout and in-flight cap. Do not guess values that are shorter than valid scheduler target durations.

### Local configuration

The watchdog needs only:

```text
UK_AQ_SCHEDULER_TRIGGER_SECRET
UK_AQ_INGEST_SCHEDULER_URL
UK_AQ_OPS_SCHEDULER_URL
```

Optional bounded settings may include:

```text
UK_AQ_SCHEDULER_WATCHDOG_OFFSET_SECONDS
UK_AQ_SCHEDULER_WATCHDOG_REQUEST_TIMEOUT_SECONDS
UK_AQ_SCHEDULER_WATCHDOG_MAX_IN_FLIGHT_PER_WORKER
```

Prefer stable defaults in the script and avoid unnecessary environment variables.

Store the dedicated secret in a local file outside the repository with mode `0600`, for example under:

```text
~/Library/Application Support/UK AQ/scheduler-watchdog/
```

The installer may copy only the dedicated trigger secret from the existing TEST `.env`. Do not expose the whole `.env` through the plist or logs.

Do not require Cloudflare API credentials on the Mac.

### Local logging

Use structured, bounded local logs recording:

- request start time;
- Worker name;
- minute slot;
- HTTP status;
- `triggered`, `already_claimed`, authentication failure or request failure;
- bounded response preview;
- elapsed time.

Use standard-library log rotation so logs cannot grow indefinitely. Never log the trigger secret or broad `.env` contents.

### Installation state

The installer should:

- create the local application-support and log directories;
- copy or reference the watchdog script predictably;
- create the local secret/config file with restrictive permissions;
- render the LaunchAgent plist without embedding the secret;
- validate the plist with `plutil`;
- use current `launchctl bootstrap`, `bootout` and `kickstart` commands appropriate to a user LaunchAgent;
- print exact status and log-inspection commands.

Start with a LaunchAgent for TEST. Do not install a system LaunchDaemon in this work.

## SOS temporary disablement

Before the ingest scheduler becomes active through the Mac, change the authoritative ingest scheduler manifest so:

```toml
[jobs.uk_aq_sos]
enabled = false
```

Do not delete the SOS job or its URL. This is a reversible temporary disablement.

Ensure the active ingest D1 `scheduler_jobs` row is synchronised from the canonical manifest before the Mac watchdog is enabled.

The implementation report must provide the exact existing local command for generating and applying the scheduler job sync SQL. Codex must not run the remote command.

Re-enabling SOS is a separate later operational decision after the upstream issue is resolved.

## Secret and deployment configuration

Add `UK_AQ_SCHEDULER_TRIGGER_SECRET` to the appropriate configuration ownership files required by the repository rules, including:

- `TEST-uk-aq-ops/env-vars-master.csv`;
- scheduler Worker deployment workflows in both repositories;
- ingest GitHub environment-target configuration where required;
- environment sync scripts/maps where required by the current local implementation.

The scheduler deployment workflows must:

- require the dedicated secret;
- set it as a Worker secret;
- include the new migration file in structural validation;
- apply D1 migrations before deploying code.

The ingest scheduler workflow already applies D1 migrations; preserve that behaviour.

The ops scheduler workflow must be updated to apply its scheduler D1 migrations if it does not already do so.

Do not add the secret to a public config file or Worker variable.

## Phased implementation

### Phase 0: local repository discovery

1. Start from the local `TEST-uk-aq-ops` checkout.
2. Read the required agent and scheduler files.
3. Confirm the current migration numbering in both repositories.
4. Confirm how each scheduler deployment workflow validates and applies migrations.
5. Confirm current environment-secret ownership and sync maps.
6. Locate existing scheduler checks and local D1 development conventions.
7. Confirm the current GCP TEST fallback job names for the later operator commands.
8. Confirm the current MacBook Pro repository path, Python path and launchd user context.
9. Record any conflict with this plan and stop before editing if established behaviour would be changed unintentionally.

### Phase 1: add atomic minute claims to the ops scheduler

1. Add the ops D1 migration.
2. Extend the ops scheduler store with an atomic scheduler-minute claim.
3. Record `minute_slot` and `trigger_source` on new rows.
4. Refactor the existing scheduler execution so the claim occurs before due-job evaluation.
5. Use the last finished evaluation window as the recovery baseline.
6. Preserve existing dispatch behaviour and logging.
7. Update the ops scheduler deployment workflow so the new migration is validated and applied.

### Phase 2: add atomic minute claims to the ingest scheduler

1. Add the ingest D1 migration using the next available number.
2. Implement the same minute-slot and trigger-source contract.
3. Preserve the ingest-only Breathe London Nodes staged response and reconciliation path.
4. Preserve concurrent target dispatch and all existing scheduler result semantics.
5. Update workflow file validation for the migration.
6. Do not change connector schedules or target URLs in this phase.

### Phase 3: add authenticated `/run-if-due` endpoints

In both Workers:

1. Add dedicated secret authentication.
2. Keep `/` and `/health` unchanged.
3. Route `POST /run-if-due` through the same minute claim and scheduler implementation used by `scheduled()`.
4. Return bounded `triggered`, `already_claimed` and failure results.
5. Add trigger-source and minute-slot fields to relevant structured logs.
6. Ensure secrets cannot appear in logs or response previews.
7. Update deployment workflow secret handling and required environment maps.

### Phase 4: disable SOS in the canonical TEST scheduler manifest

1. Set the ingest SOS job to `enabled = false`.
2. Preserve its cron, URL ownership and notes.
3. Prepare the exact remote D1 sync command for the operator.
4. Do not call or test SOS.

### Phase 5: implement the MacBook Pro watchdog package

1. Add the persistent standard-library Python watchdog under the ops repository.
2. Add LaunchAgent installer, uninstaller, status helper, plist template, env example and non-system README.
3. Align calls to UTC minute plus the selected offset.
4. Call the two Workers independently.
5. Allow bounded overlapping requests.
6. Add bounded rotating logs.
7. Keep secrets outside the repository and plist.
8. Add clear manual setup and rollback commands.

### Phase 6: minimal pre-deployment structural validation

Run only the smallest local checks required to establish structural viability:

- JavaScript syntax check for the changed scheduler modules in each repository;
- Python bytecode compilation for the watchdog;
- `plutil -lint` for the rendered or template plist where practical;
- local parsing of both canonical `jobs.toml` files;
- local D1 migration application against disposable/local scheduler databases.

One targeted local D1 check is genuinely required because the minute claim is the load-bearing duplicate-prevention mechanism:

1. apply the migration locally;
2. attempt two claims for the same `(scheduler_name, minute_slot)`;
3. confirm exactly one row is inserted;
4. confirm a different minute can be claimed normally.

Do not build a broad scheduler test suite. Do not call Cloudflare, GCP, GitHub workflow dispatch APIs, Supabase, Dropbox or any deployed target during pre-deployment checks.

### Phase 7: operator deployment and TEST rollout

Codex must provide exact commands but must not run them.

Recommended operational sequence:

1. Create/synchronise `UK_AQ_SCHEDULER_TRIGGER_SECRET` for both repositories and the MacBook Pro local config.
2. Deploy the ops scheduler Worker through its existing GitHub workflow.
3. Deploy the ingest scheduler Worker through its existing GitHub workflow.
4. Confirm both D1 migrations were applied.
5. Synchronise canonical ingest jobs into D1 and confirm SOS is disabled.
6. Make one authenticated manual `/run-if-due` call to each Worker.
7. Confirm one run row is created with the expected minute slot and `external_watchdog` source.
8. Make a second call for the same minute and confirm `already_claimed` with no second run row.
9. Install and start the MacBook Pro LaunchAgent.
10. Observe several consecutive one-minute rows in both scheduler D1 databases.
11. Confirm a representative due ingest job and a representative due ops job dispatch successfully through real TEST operation.
12. Turn off overlapping TEST GCP triggers.
13. Keep SOS disabled.
14. Leave LIVE/Beta GCP schedules unchanged.

If the Mac path fails at any point, unload the LaunchAgent and retain or restore the TEST GCP triggers.

### Phase 8: coexistence validation when Cloudflare cron recovers

No artificial Cloudflare failure or recovery test is required before rollout.

When Cloudflare scheduled events resume naturally:

1. leave the Mac watchdog enabled;
2. confirm there remains at most one `scheduler_runs` row per scheduler/minute;
3. confirm one source wins and the other reports `already_claimed`;
4. confirm no duplicate target dispatch rows are created;
5. record the observed trigger-source behaviour for documentation.

### Phase 9: ChatGPT system-documentation update

After real TEST validation, Codex must provide a handover to ChatGPT covering:

- the D1 schema amendment;
- minute-slot claim semantics;
- recovery baseline behaviour;
- authenticated endpoint contract;
- trigger-source values;
- Worker secret ownership;
- MacBook Pro LaunchAgent operation;
- install, status, log and rollback commands;
- SOS disabled state;
- GCP TEST fallback state;
- deployment and validation evidence;
- egress and database-size impact.

ChatGPT will then update the authoritative scheduler documents in the owning repositories without duplicating detailed contracts.

## Expected files

Codex must confirm exact ownership from the local repositories before editing. Likely files include:

### Ops repository

```text
cloudflare/scheduler/worker.mjs
cloudflare/scheduler/migrations/<next>_scheduler_minute_slot_claim.sql
.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml
env-vars-master.csv
scripts/mbpro_scheduler_watchdog/*
```

Potentially relevant non-system scheduler README/config files may be changed where necessary.

### Ingest repository

```text
cloudflare/scheduler/worker.mjs
cloudflare/scheduler/migrations/<next>_scheduler_minute_slot_claim.sql
cloudflare/scheduler/jobs.toml
.github/workflows/uk_aq_cloudflare_scheduler_ingest_deploy.yml
config/uk_aq_github_env_targets.csv
```

Environment-sync files may also require focused changes under the repository rules.

Do not edit `system_docs/`.

## Operational validation queries

The implementation report should provide final exact D1 queries equivalent to:

```sql
select
  id,
  scheduler_name,
  minute_slot,
  trigger_source,
  started_at,
  finished_at,
  status,
  jobs_due,
  jobs_dispatched,
  jobs_failed,
  error_message
from scheduler_runs
order by id desc
limit 20;
```

And a duplicate check equivalent to:

```sql
select scheduler_name, minute_slot, count(*) as run_count
from scheduler_runs
where minute_slot is not null
group by scheduler_name, minute_slot
having count(*) > 1;
```

Expected duplicate-check result:

```text
no rows
```

## Rollback

### Immediate operational rollback

1. Unload the MacBook Pro LaunchAgent.
2. Re-enable the known-working TEST GCP Scheduler jobs.
3. Keep SOS disabled.
4. Confirm GCP forced runs work.

### Worker rollback

1. Redeploy the previous Worker versions or revert the focused code changes.
2. The added D1 columns and unique index may remain; they are backwards-compatible with older Worker code.
3. Do not delete scheduler run or dispatch history.
4. Remove the dedicated Worker secret only after the endpoint is no longer deployed.

### Local cleanup

1. Use the repository uninstall helper.
2. Remove the local LaunchAgent plist and copied watchdog files.
3. Retain logs until the incident and rollout are understood.
4. Remove the dedicated local secret file after rollback is complete.

## Security assessment

- The Mac receives no Cloudflare API token for this feature.
- The dedicated secret can trigger scheduler evaluation but cannot directly alter Worker deployments, D1 schemas or Cloudflare settings.
- D1 minute claims make replaying a request for an already claimed minute a bounded no-op.
- The endpoint remains capable of causing due jobs to run, so the secret must still be treated as sensitive and rotated if exposed.
- The local secret file must be mode `0600` and excluded from Git/Dropbox publication where practical.
- Logs must never contain the secret or broad environment contents.

## Egress impact

### Supabase billable egress

No material change is expected.

The new calls are between the Mac and Cloudflare Workers. Existing target jobs continue to determine Supabase endpoint response egress. The minute claim itself uses D1 and does not call Supabase.

### Other network traffic

With both watchdog endpoints called once per minute:

- approximately 2,880 small HTTP requests per day across both Workers;
- small bounded JSON request/response payloads;
- no extra target calls when the minute was already claimed;
- no Cloudflare API polling;
- no change to healthy target job cadence.

### Cloudflare/D1 operations

When the Mac is the only working trigger, D1 run and dispatch activity is broadly equivalent to the former one-minute Cron Trigger activity.

When both trigger sources work, the losing source adds one small claim attempt and bounded existing-run lookup per minute.

## Database-size impact

### D1

- existing scheduler run frequency remains at most one row per scheduler per minute;
- two small metadata fields are added to new run rows;
- one unique index is added per scheduler database;
- no historical backfill is required;
- no new permanent claim table is required;
- local rotating watchdog logs are outside D1.

### Supabase

- no schema migration;
- no new rows caused by the watchdog itself;
- no material storage change;
- target jobs continue to create their normal operational data only when due.

## Completion criteria

The work is complete when:

1. both scheduler Workers share the atomic minute-slot claim between cron and HTTP triggers;
2. duplicate same-minute calls create only one scheduler run;
3. the authenticated endpoint is protected by a dedicated secret;
4. the MacBook Pro LaunchAgent starts automatically and calls both Workers every minute;
5. several consecutive TEST scheduler rows are produced by the Mac path;
6. representative ingest and ops jobs execute successfully;
7. overlapping TEST GCP triggers are disabled after validation;
8. SOS remains disabled;
9. Cloudflare cron can later coexist without duplicates;
10. ChatGPT updates the relevant system documentation from real operational evidence.
