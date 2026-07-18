# GCP services to GitHub workflows

**Date:** 18 July 2026  
**Target environment:** TEST only  
**Primary repository:** `TEST-uk-aq/uk-aq-ops`  
**Plan path:** `plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md`  
**Status:** Proposed phased implementation plan

## 1. Purpose

Move the two active once-daily operational workloads in scope from GCP Cloud Run execution to GitHub Actions execution, while retaining the existing Cloudflare Scheduler as the sole schedule authority.

The workloads in scope are:

1. `uk_aq_observs_partition_maintenance`
2. `uk_aq_prune_daily`

This is an execution-host migration. It is not a redesign of pruning, R2 backup, observation repair, partition retention, AQI generation, task health, or scheduling policy.

The intended end state is:

```text
Cloudflare Scheduler
  -> workflow_dispatch
  -> GitHub Actions workflow
  -> direct Node job entry point
  -> existing shared task implementation
  -> Supabase, ObsAQIDB, R2 and Dropbox as currently required
```

The work must be implemented and proven on TEST before any LIVE transfer is considered.

## 2. Scope

### 2.1 In scope

- Refactor Observs partition maintenance so the same core task can run from:
  - its current Cloud Run HTTP wrapper during transition;
  - a direct command-line job entry point for GitHub Actions.
- Add a manually dispatchable GitHub Actions workflow for Observs partition maintenance.
- Change the existing Cloudflare Scheduler job from `cloud_run` to `github_workflow` only after the GitHub execution path has been proven.
- Retire the Observs partition-maintenance Cloud Run service and deploy workflow after the scheduled GitHub run is accepted.
- Refactor Prune Daily so the same core task can run from:
  - its current Cloud Run HTTP wrapper during transition;
  - a direct command-line job entry point for GitHub Actions.
- Add a manually dispatchable GitHub Actions workflow for Prune Daily.
- Add or update the Cloudflare Scheduler job for Prune Daily to dispatch the GitHub workflow only after the GitHub execution path has been proven.
- Retire the Prune Daily Cloud Run service and deploy workflow after the scheduled GitHub run is accepted.
- Preserve the existing daily-task-health identities:
  - `ops.observs_partition_maintenance`
  - `ops.prune_daily`
- Preserve structured logs and add a small JSON report artefact for each workflow where this is not already available.
- Remove GCP-specific configuration for these two services only after it is no longer referenced.
- Update authoritative system documentation after implementation through ChatGPT in Chat mode.

### 2.2 Explicitly out of scope

- Ingest services.
- Any service that must remain continuously available as an HTTP endpoint.
- AQI-level retention. It is already removed from GCP and is expected to be retired separately.
- Observs outbox flushing. It is not assumed to be active and must not be recreated as part of this work.
- R2 core snapshot, R2-to-Dropbox backup and other jobs that already run as GitHub workflows.
- Changes to retention periods, deletion rules, backup requirements or data eligibility.
- Changes to the Phase B observations backup requirement.
- Changes to DAQI or EAQI calculations.
- Changes to the Cloudflare Scheduler minute loop, D1 schema or duplicate-claim design unless a genuine incompatibility is discovered.
- LIVE repositories, LIVE GCP resources, LIVE Supabase projects, LIVE R2 buckets or LIVE scheduler entries.
- General cleanup of every historical GCP, AQI-retention or outbox variable in the repository.

## 3. Current-state findings to preserve

### 3.1 Cloudflare Scheduler is already the schedule authority

The ops scheduler already supports both:

```text
target_type = "cloud_run"
target_type = "github_workflow"
```

It already dispatches GitHub workflows for other daily jobs and protects each due slot with a D1 claim before dispatch. This migration must reuse that mechanism rather than adding GitHub cron schedules.

### 3.2 Scheduler configuration is deployed from `jobs.toml`

The canonical schedule is:

```text
cloudflare/scheduler/jobs.toml
```

A push affecting that file can run the existing scheduler config-sync workflow and update remote D1. Therefore, implementation and scheduler cutover must not be combined into one unsafe step. The GitHub workflow must exist and be manually proven before `jobs.toml` is changed to dispatch it.

### 3.3 Existing GitHub batch workflow conventions

The repository already uses the following pattern for batch jobs:

- `workflow_dispatch` as the workflow trigger;
- `permissions: contents: read`;
- an explicit concurrency group;
- `cancel-in-progress: false`;
- Node.js 20;
- repository variables and secrets;
- started and final daily-task-health reporting;
- JSON report artefacts where useful.

The new workflows should follow this established pattern.

### 3.4 Observs partition maintenance behaviour

The current task:

- ensures current and future daily partitions;
- enforces hot and cold indexes;
- checks the default partition;
- identifies retention drop candidates;
- confirms R2 history safety before dropping populated partitions;
- permits an empty partition to be dropped safely when the database confirms the day has no rows;
- records skipped drops and errors;
- writes Dropbox diagnostic files where configured;
- records daily-task-health status.

All of those behaviours must remain unchanged.

### 3.5 Prune Daily behaviour

Prune Daily is a multi-stage destructive maintenance task. It currently includes:

- recent Phase A fingerprint comparison and repair;
- Phase B R2 history backup and completion gates;
- R2 history index maintenance;
- chart-load metrics maintenance;
- normal retention-window comparison, repair and deletion;
- late-arrival discovery and cleanup;
- deletion caps and retry behaviour;
- Dropbox error reporting;
- daily-task-health reporting.

The host migration must not separate, reorder, weaken or silently skip these stages unless an authoritative system contract explicitly requires a different order.

## 4. Fixed implementation decisions

These are requirements, not options for redesign during implementation.

### 4.1 TEST only

All code, workflow, scheduler and operational work is for `TEST-uk-aq/uk-aq-ops` and TEST resources only.

Do not inspect, modify, dispatch or delete LIVE resources.

### 4.2 Cloudflare remains the sole schedule authority

The new workflows must use `workflow_dispatch` only.

Do not add a GitHub Actions `schedule:` trigger. There must be exactly one active schedule authority per task.

### 4.3 GitHub Actions becomes the execution host

Cloudflare Scheduler dispatches the workflow. GitHub Actions checks out the repository, installs the required dependencies and runs the direct job.

The GitHub workflow is not an HTTP service and does not need to start the existing server or send a request to localhost.

### 4.4 One shared business-logic path

Refactor each service into a reusable core execution path and thin wrappers.

Recommended shape:

```text
workers/uk_aq_observs_partition_maintenance_service/
  core.mjs
  server.mjs
  job.mjs

workers/uk_aq_prune_daily/
  core.mjs
  server.mjs
  job.mjs
```

Exact filenames may differ where a smaller safe refactor is clearer, but the direct job and HTTP server must call the same implementation function.

Do not copy the maintenance or pruning logic into workflow YAML or a second JavaScript implementation.

### 4.5 Preserve task-health identities and semantics

The same task keys must remain authoritative:

```text
ops.observs_partition_maintenance
ops.prune_daily
```

A host change must not create parallel task keys merely to identify GitHub Actions.

The task-health source metadata may identify the direct job or GitHub workflow, but existing dashboards and status consumers must continue to see one logical task history.

### 4.6 Direct jobs do not use HTTP authentication

The Cloud Run server must continue to validate its dispatch secret while it exists.

The direct command-line job must not invent or require an HTTP dispatch secret. Its trust boundary is GitHub Actions and repository secrets.

### 4.7 Preserve the current operational deadline

Both Cloud Run services currently use a 900-second service timeout. The GitHub workflows must preserve a 15-minute execution deadline initially rather than silently expanding the permitted runtime.

Use a job or step timeout that actually terminates the process, for example GNU `timeout`, while allowing a small workflow-level margin for setup and final reporting.

A suitable initial pattern is:

```text
workflow timeout: 25 minutes
maintenance command deadline: 15 minutes
```

If an ordinary TEST run cannot complete within the existing 15-minute operational contract, stop and report the measured stage and elapsed time. Do not increase the timeout merely because GitHub permits a longer job.

### 4.8 Do not allow overlapping runs

Use a stable task-specific concurrency group with:

```yaml
cancel-in-progress: false
```

The direct job should also preserve or add an application-level run lock only if the current code already has one or repository evidence shows it is required. Do not rely on a speculative new lock design.

### 4.9 Preserve outputs and diagnostics

The direct job must:

- print the same structured task logs as the Cloud Run path;
- return a non-zero exit code on task failure;
- write a bounded JSON summary to a known temporary path;
- retain existing Dropbox error-report behaviour where configured;
- allow the workflow to upload the JSON summary as an artefact with `if: always()`.

Do not log secrets, complete connection strings, access headers or observation payloads.

### 4.10 Separate workflow deployment from schedule cutover

For each task:

1. merge the code and workflow without changing the active scheduler target;
2. manually dispatch and accept the GitHub workflow;
3. change `jobs.toml` in a separate commit or pull request;
4. allow the scheduler config sync to update D1;
5. observe the first normal scheduled GitHub run;
6. only then remove the Cloud Run service and its deploy workflow.

### 4.11 Minimal pre-deployment checking

Before deployment, perform only:

- JavaScript syntax or import checks for changed files;
- YAML parsing or an existing workflow lint where already available;
- scheduler TOML-to-sync-payload validation when `jobs.toml` changes;
- one small deterministic check only where needed to prove the direct and HTTP wrappers invoke the same core path without running external operations.

Do not create a broad speculative test suite.

Functional validation must happen through real operations on the TEST system.

### 4.12 System documentation is updated by ChatGPT

Codex may read `system_docs/` but must not edit it.

After each implementation phase, Codex must provide a concise handover covering:

- implemented behaviour;
- files changed;
- configuration changes;
- deployment and cutover implications;
- checks run;
- real TEST validation results;
- rollback notes;
- affected authoritative documents.

ChatGPT in Chat mode will update `system_docs/` after reviewing the implemented repository state and the handover.

## 5. Required end state

### 5.1 Observs partition maintenance

```text
03:00 UTC
  Cloudflare Scheduler job uk_aq_observs_partition_maintenance
  target_type = github_workflow
  workflow = uk_aq_observs_partition_maintenance.yml
  direct job = workers/uk_aq_observs_partition_maintenance_service/job.mjs
  task health = ops.observs_partition_maintenance
```

There is no active Observs partition-maintenance Cloud Run service or GCP scheduler after acceptance.

### 5.2 Prune Daily

Retain the currently intended operational ordering. Based on the old Cloud Run configuration, the default schedule should remain 02:00 UTC unless current TEST configuration or an authoritative document shows a different active time.

```text
02:00 UTC
  Cloudflare Scheduler job uk_aq_prune_daily
  target_type = github_workflow
  workflow = uk_aq_prune_daily.yml
  direct job = workers/uk_aq_prune_daily/job.mjs
  task health = ops.prune_daily
```

There is no active Prune Daily Cloud Run service or GCP scheduler after acceptance.

### 5.3 Ordering

Prune Daily should remain scheduled before Observs partition maintenance unless current system evidence proves a different dependency.

Do not change the times solely to make the migration convenient.

## 6. Phase 0: structural viability and active-resource inventory

**Owner:** Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1, code and repository inspection only

Before editing:

1. Read:
   - `AGENTS.md`;
   - `system_docs/README.md`;
   - `system_docs/documentation_contract.md`;
   - all current authoritative documents covering Prune Daily Phase B and retention safety;
   - relevant legacy evidence for scheduling, prune and Observs operations where no completed area contract exists.
2. Use `grep`, not `rg`, to identify:
   - every reference to the two Cloud Run service names;
   - both Cloud Run deploy workflows;
   - scheduler entries and sync behaviour;
   - task-health keys;
   - current package scripts;
   - current environment variables and secrets;
   - any external dashboard links or runbooks that assume a Cloud Run URL;
   - any active references to AQI-level retention or outbox flushing.
3. Confirm from repository code that GitHub-hosted runners already access:
   - IngestDB;
   - ObsAQIDB;
   - R2;
   - Dropbox.
4. Inspect current TEST GCP resources only through exact operator commands prepared for the user. Do not run cloud commands at Level 1.
5. Establish whether these resources currently exist:
   - `uk-aq-observs-partition-maintenance-service` or configured equivalent;
   - `uk-aq-prune-daily` or configured equivalent;
   - related Cloud Scheduler jobs;
   - AQI-level retention service or scheduler;
   - Observs outbox-flush service or scheduler.
6. Treat AQI-level retention and outbox flushing as inventory findings only. Do not add either to the migration scope.
7. Confirm whether Prune Daily is currently scheduled through Cloudflare, GCP, another caller, or only manual dispatch.
8. Confirm the current successful runtime of the two in-scope tasks from recent task-health records or logs, and whether either normally approaches 15 minutes.
9. Identify any code or documentation conflict before changing implementation.

Deliverable:

- exact implementation map;
- active-resource inventory commands;
- confirmed current scheduler authority for each task;
- runtime and dependency findings;
- list of authoritative behaviours that must not change;
- blockers, if any.

Do not edit code during Phase 0.

## 7. Phase 1: Observs partition-maintenance direct job

**Owner:** Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning

### 7.1 Archive active code

Before changing substantial active non-test code, follow the dated archive policy in `AGENTS.md`.

Archive only active code files that will be changed. Do not archive documentation, workflows, tests or generated files.

### 7.2 Extract the reusable execution path

Refactor the current server so the core exports can be called without opening an HTTP port.

The shared path must include:

- configuration parsing from environment and explicit overrides;
- `withDailyTaskRun(...)` using `ops.observs_partition_maintenance`;
- `runObservsPartitionMaintenance(...)`;
- compact finished summary generation;
- existing structured logging;
- existing Dropbox diagnostics and error upload behaviour.

The HTTP wrapper must retain:

- `/healthz`;
- `POST /run`;
- current run authentication;
- current query-parameter override semantics;
- current response payload and status behaviour.

### 7.3 Add the direct job

Add:

```text
workers/uk_aq_observs_partition_maintenance_service/job.mjs
```

The job must:

1. build the same effective configuration as a normal authenticated `/run` request without query overrides;
2. execute the shared task path;
3. write the full bounded summary to:

```text
tmp/uk_aq_observs_partition_maintenance_report.json
```

4. exit `0` only when the maintenance task completed successfully;
5. exit non-zero for configuration, RPC, R2 safety, Dropbox-critical or other task failures according to current behaviour;
6. not start an HTTP server;
7. not require the edge dispatch secret.

Do not alter partition, index, retention or drop safety logic.

### 7.4 Add the GitHub workflow

Add:

```text
.github/workflows/uk_aq_observs_partition_maintenance.yml
```

Required characteristics:

- `workflow_dispatch` only;
- optional `drop_dry_run` boolean input, defaulting to the repository variable when omitted or false only where GitHub input semantics require explicit handling;
- `permissions: contents: read`;
- task-specific concurrency group;
- `cancel-in-progress: false`;
- Node.js 20;
- `npm ci --ignore-scripts`;
- explicit required-config validation;
- the same TEST variables and secrets currently required by the service;
- a 15-minute command deadline;
- a workflow timeout with a small setup/reporting margin;
- report artefact upload with `if: always()`;
- daily-task-health reported exactly once through the shared implementation, not once in the workflow and again in the job.

Prefer the shared in-code `withDailyTaskRun` path for this workflow because it preserves the detailed task summary. Do not add the separate `report_daily_task_health.mjs` wrapper around a job that already records its own task run.

### 7.5 Configuration mapping

Map current runtime variables directly. Preserve defaults unless current TEST repository variables override them:

```text
OBS_AQIDB_SUPABASE_URL
OBS_AQIDB_SECRET_KEY
OBSERVS_PARTITIONS_FUTURE_DAYS
OBSERVS_PARTITIONS_HOT_DAYS
OBS_AQIDB_OBSERVS_RETENTION_DAYS
OBSERVS_DEFAULT_TOP_N
OBSERVS_PARTITION_DROP_DRY_RUN
CFLARE_R2_ENDPOINT
CFLARE_R2_BUCKET
CFLARE_R2_REGION
CFLARE_R2_ACCESS_KEY_ID
CFLARE_R2_SECRET_ACCESS_KEY
UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX
UK_AQ_DROPBOX_ROOT
UK_AQ_OBSERVS_PARTITION_DROPBOX_FOLDER
UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
DROPBOX_REFRESH_TOKEN
```

Do not copy Secret Manager secret-name variables into the direct job. GitHub Actions should consume the actual GitHub secrets already present.

### 7.6 Pre-deployment checks

Run only:

- `node --check` on changed JavaScript;
- the repository's normal focused `npm run check` only if it remains fast and does not call external systems;
- YAML parsing or action syntax validation through the normal pull-request checks.

A small direct-wrapper check is justified only if the refactor otherwise leaves a material risk that importing the core starts the HTTP server. It must not call Supabase, R2 or Dropbox.

Deliverable:

- code and workflow ready for manual TEST dispatch;
- exact manual dispatch and validation instructions;
- no scheduler cutover yet;
- no GCP deletion yet;
- Codex handover for ChatGPT documentation.

## 8. Phase 2: prove Observs workflow and cut over scheduling

### 8.1 Manual dry-run operation

After Phase 1 is merged, manually dispatch the workflow with partition dropping in dry-run mode.

This targeted pre-cutover operational check is genuinely required because the task can drop database partitions. It is not a speculative test suite.

Confirm:

- workflow checkout and dependency installation succeed;
- required secrets and variables are present;
- the job reaches ObsAQIDB and R2;
- partitions and index actions are planned correctly;
- no partition is dropped in dry-run mode;
- the JSON artefact is uploaded;
- `ops.observs_partition_maintenance` records one started and one final result;
- the summary is equivalent in shape and meaning to the current Cloud Run path;
- elapsed task time remains below 15 minutes.

### 8.2 Manual normal operation

Run one normal manual workflow operation at an operator-selected safe time.

Confirm:

- partition creation and index enforcement succeed;
- the default-partition diagnostic is unchanged;
- any drop candidate requires the existing R2 or empty-partition safety gate;
- dropped and skipped counts are credible;
- no unexpected partition is removed;
- daily task health reports success;
- the report artefact and logs contain no secrets.

### 8.3 Scheduler cutover

In a separate change, update `cloudflare/scheduler/jobs.toml`:

```toml
[jobs.uk_aq_observs_partition_maintenance]
enabled = true
cron_expr = "0 3 * * *"
target_type = "github_workflow"
github_repo = "TEST-uk-aq/uk-aq-ops"
github_workflow_file = "uk_aq_observs_partition_maintenance.yml"
github_ref = "main"
dry_run = false
notes = "Observations partition maintenance via GitHub Actions"
```

Remove Cloud Run-only fields from this job.

Do not change the cron expression unless Phase 0 found a different currently authoritative TEST schedule.

Validate the generated scheduler sync payload locally, then allow the existing config-sync workflow to update remote D1.

### 8.4 First scheduled run acceptance

On the next 03:00 UTC due slot, confirm:

- one D1 dispatch claim exists;
- the dispatch target is `github_workflow`;
- GitHub accepted one workflow dispatch;
- only one workflow run executed;
- no Cloud Run invocation occurred;
- the task-health record succeeded;
- the functional summary matches normal behaviour;
- elapsed task time remained inside the deadline.

Keep the old Cloud Run service deployed but unscheduled until this acceptance is complete.

## 9. Phase 3: retire Observs partition-maintenance GCP resources

After Phase 2 acceptance:

1. Prepare exact operator commands to confirm the Cloud Run service and any GCP Scheduler job names.
2. Delete the TEST Cloud Scheduler job for this task if it still exists.
3. Delete the TEST Cloud Run service.
4. Confirm there is no remaining IAM-only dependency used solely by this service before proposing service-account deletion.
5. Remove:

```text
.github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml
```

6. Remove obsolete Observs partition-maintenance GCP service and scheduler variables from `config/uk_aq_github_env_targets.csv` only after `grep` proves there are no active references.
7. Preserve generic GCP variables used by other services.
8. Preserve runtime variables still used by the new GitHub workflow.
9. Update package scripts only where they inaccurately imply that the HTTP service is the only execution path.

Do not remove AQI-level retention or outbox-flush configuration in this phase.

Rollback remains the ability to restore the Cloud Run deploy workflow from Git history, redeploy the service and switch the scheduler job back to `cloud_run`.

## 10. Phase 4: Prune Daily direct job

**Owner:** Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning

Prune Daily is higher risk and must not begin until Observs partition maintenance has completed at least one accepted scheduled GitHub run.

### 10.1 Archive active code

Follow the dated archive policy for every active non-test code file expected to change.

### 10.2 Extract the reusable execution path

Move the runtime logic out of the HTTP-only bottom section while preserving:

- configuration defaults and validation;
- URL query overrides for the transitional server;
- `withDailyTaskRun(...)` with `ops.prune_daily`;
- `runPrune(config)` stage order;
- compact task-health summary;
- structured logging;
- Dropbox error reporting;
- current failure and warning behaviour.

The direct and HTTP wrappers must both invoke the same core function.

### 10.3 Preserve stage order

The normal direct job must retain this effective order:

1. Phase A recent fingerprint check and repair.
2. Phase B history backup.
3. Required R2 history index maintenance.
4. Chart-load metrics maintenance.
5. Normal retention-window comparison, repair and deletion.
6. Late-arrival discovery and cleanup.
7. Combined summary and task-health finalisation.

Do not split these stages into independent GitHub jobs or workflows in this migration. Doing so would change failure, ordering and completion semantics.

### 10.4 Add direct job

Add:

```text
workers/uk_aq_prune_daily/job.mjs
```

The job must:

- use the same environment-based normal configuration as `/run` without query overrides;
- support a narrow command-line or environment dry-run override for manual workflow dispatch;
- run the same shared task path;
- write:

```text
tmp/uk_aq_prune_daily_report.json
```

- exit non-zero when the overall task fails;
- preserve warning-only substage handling exactly where current code treats a failure as a warning rather than an overall failure;
- not start an HTTP server;
- not require the edge dispatch secret.

Do not change deletion eligibility, fingerprint logic, repair replay, R2 history gates, AQI generation, index byte-stability or retention windows.

### 10.5 Add GitHub workflow

Add:

```text
.github/workflows/uk_aq_prune_daily.yml
```

Required characteristics:

- `workflow_dispatch` only;
- optional `dry_run` boolean input;
- `permissions: contents: read`;
- concurrency group `uk-aq-prune-daily` or equivalent stable name;
- `cancel-in-progress: false`;
- Node.js 20;
- `npm ci --ignore-scripts`;
- explicit required-config validation;
- all existing runtime variables and direct GitHub secrets;
- 15-minute command deadline initially;
- report artefact upload with `if: always()`;
- one logical daily-task-health run from the shared implementation.

### 10.6 Environment and secret mapping

Map the effective current Cloud Run runtime, including:

- main Supabase URL and privileged key;
- IngestDB PostgreSQL URL where Phase B requires it;
- ObsAQIDB URL and privileged key;
- R2 endpoint, bucket, region and credentials;
- Dropbox credentials and paths;
- retention, batch, repair and Phase A settings;
- complete Phase B history settings;
- PM context RPC settings;
- chart-load metrics settings;
- history-version and all canonical prefixes;
- current AQI writer-mode settings.

Use actual GitHub secrets rather than GCP Secret Manager secret names.

Do not delete compatibility variable aliases during the execution-host migration unless they are proven unused and their removal is explicitly included in the later hygiene phase.

### 10.7 Report artefact

The report must include the existing combined summary and enough workflow metadata to identify:

```text
execution_host=github_actions
repository
workflow
workflow_run_id
workflow_run_attempt
commit_sha
```

These fields are operational metadata only. They must not alter business decisions or R2 object content.

### 10.8 Minimal pre-deployment checks

Run only:

- syntax and import checks;
- existing small deterministic checks directly affected by the extraction;
- workflow parsing through normal repository checks.

A small wrapper equivalence check is justified because Prune Daily is destructive. It should prove only that both wrappers build the same normal configuration and call the same exported execution function. It must use injected stubs and must not call external systems.

Do not add a broad simulated prune suite.

## 11. Phase 5: prove Prune Daily and cut over scheduling

### 11.1 Manual dry-run operation

The first GitHub execution must be a dry run.

Confirm:

- all required configuration is present;
- Phase A executes in its current repair-only semantics;
- Phase B discovers and processes the expected candidate scope;
- R2 writes are suppressed only where the existing dry-run contract suppresses them;
- deletion is not performed;
- fingerprint and history-gate summaries are credible;
- the report artefact is complete;
- task-health identity remains `ops.prune_daily`;
- the process completes inside 15 minutes.

Because dry-run semantics may still perform some safe reads or existing idempotent operations, validate against the current implementation rather than assuming dry run means no external calls.

### 11.2 Manual normal operation

At an operator-selected safe time, run one normal GitHub workflow operation.

Validate through real TEST state:

- expected Phase B R2 observation and AQI outputs are present;
- required manifests and indexes pass the existing completion gates;
- Phase A repair behaviour is unchanged;
- eligible IngestDB buckets are deleted only after fingerprint and history safety checks;
- mismatches remain blocked or repaired according to current rules;
- late-arrival handling is unchanged;
- chart-load metrics maintenance remains present;
- task-health reports success or the same meaningful warning/failure state as Cloud Run would have reported;
- R2 history indexes remain byte-stable when source state is unchanged;
- the run completes inside 15 minutes.

### 11.3 Scheduler cutover

In a separate change, add or update the canonical job in `cloudflare/scheduler/jobs.toml`:

```toml
[jobs.uk_aq_prune_daily]
enabled = true
cron_expr = "0 2 * * *"
target_type = "github_workflow"
github_repo = "TEST-uk-aq/uk-aq-ops"
github_workflow_file = "uk_aq_prune_daily.yml"
github_ref = "main"
dry_run = false
notes = "Prune Daily via GitHub Actions"
```

Use the actual authoritative current UTC schedule found in Phase 0 if it differs.

Ensure there is no separate active GCP schedule or other scheduler that would cause a duplicate run.

### 11.4 First scheduled run acceptance

For the first scheduled run, confirm:

- one Cloudflare D1 claim and one GitHub dispatch;
- one GitHub workflow run;
- no Cloud Run invocation;
- the complete Prune Daily stage order ran;
- task health succeeded or produced an understood existing operational state;
- outputs and deletion counts are credible;
- the runtime remained inside the preserved deadline.

Keep the Cloud Run service dormant and unscheduled until acceptance is complete.

## 12. Phase 6: retire Prune Daily GCP resources

After Phase 5 acceptance:

1. Confirm exact TEST Cloud Run and Cloud Scheduler resource names.
2. Delete any remaining TEST GCP Scheduler job for Prune Daily.
3. Delete the TEST Prune Daily Cloud Run service.
4. Confirm whether its service account is shared before considering deletion.
5. Remove:

```text
.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml
```

6. Remove Prune Daily GCP-only service, resource, scheduler and Secret Manager name variables from `config/uk_aq_github_env_targets.csv` only where they are proven unused.
7. Retain all runtime variables and secrets required by the GitHub workflow.
8. Update any dashboard or operational links that still point to the Cloud Run service.
9. Do not remove Docker support used by other services.
10. Do not remove the shared Dockerfile solely because these two services no longer need it unless `grep` proves no active deployment uses it and that cleanup is separately reviewed.

Rollback is to restore and run the Cloud Run deploy workflow from Git history, then change the Cloudflare scheduler entry back to `cloud_run`.

## 13. Phase 7: focused repository hygiene

After both migrations are accepted:

1. Use `grep` to find stale references to the two retired Cloud Run services.
2. Remove only references that are now definitively obsolete.
3. Keep historical plans and legacy records clearly historical rather than rewriting them as current behaviour.
4. Inspect AQI-level retention references and Observs outbox-flush references.
5. Report them as separate retirement candidates.
6. Do not delete their workers, SQL, variables or history in this migration unless the user starts a separate retirement task.
7. Ensure `package.json` scripts accurately distinguish direct jobs from HTTP servers.
8. Ensure repository checks include the new direct job files.
9. Confirm no active workflow attempts to deploy either retired service.
10. Confirm the scheduler has exactly one enabled job per migrated task.

## 14. Security requirements

- GitHub workflow permissions remain least privilege, normally `contents: read`.
- The Cloudflare dispatch PAT remains restricted to the TEST ops repository and Actions workflow dispatch.
- Repository secrets hold actual runtime credentials.
- Do not pass secrets through workflow inputs, command arguments, artefacts or logs.
- Do not use pull-request workflows from untrusted forks to run either maintenance task.
- Do not expose the direct jobs through a public endpoint.
- Do not add `pull_request_target` execution.
- Preserve the existing Dropbox allow-list behaviour.
- Keep R2 credentials scoped to the TEST bucket where current credentials permit it.
- Do not use LIVE credentials as fallbacks.

## 15. Monitoring and operational evidence

For each workflow, retain three separate sources of evidence:

1. **Cloudflare Scheduler D1**
   - due slot;
   - duplicate claim protection;
   - dispatch status.
2. **GitHub Actions**
   - workflow run and attempt;
   - step logs;
   - job conclusion;
   - JSON report artefact.
3. **UK AQ daily-task health**
   - logical task started and final state;
   - compact domain summary used by the operations dashboard.

The scheduler records dispatch acceptance, not job completion. Daily-task health remains the system-level record of task completion.

Do not add polling from Cloudflare to GitHub as part of this migration.

## 16. Rollback strategy

### 16.1 Before scheduler cutover

No runtime rollback is needed. The existing Cloud Run scheduler path remains active.

### 16.2 After scheduler cutover but before GCP deletion

1. Set the scheduler job back to `cloud_run` using the previously managed Cloud Run URL.
2. Sync `jobs.toml` to D1.
3. Confirm the next due slot dispatches Cloud Run.
4. Leave the GitHub workflow available for investigation but do not schedule it.

### 16.3 After GCP deletion

1. Restore the deleted Cloud Run deploy workflow from Git history.
2. Redeploy the service to TEST using the documented manual workflow dispatch.
3. Confirm the `/healthz` and authenticated `/run` endpoints.
4. Change the Cloudflare scheduler job back to `cloud_run`.
5. Sync D1 and confirm one dispatch path.

A rollback must not weaken retention or history gates, disable Phase B backup, or bypass partition-drop safeguards.

## 17. Codex implementation prompts

### Prompt A: structural viability and inventory

```text
Use GPT-5.6 Codex with High reasoning.

Work in TEST-uk-aq/uk-aq-ops only. This is Phase 0 of:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Read AGENTS.md, system_docs/README.md, system_docs/documentation_contract.md and all relevant authoritative system documents first. Use grep, not rg.

Do not edit files. Do not run cloud, database, R2, Dropbox or deployment operations.

Investigate the structural viability of moving these two once-daily tasks from Cloud Run execution to GitHub Actions while retaining Cloudflare Scheduler:
- uk_aq_observs_partition_maintenance
- uk_aq_prune_daily

Confirm:
1. current implementation files and task-health keys;
2. current scheduler authority and configured UTC times;
3. every required GitHub variable and secret;
4. whether existing GitHub workflows already prove access to IngestDB, ObsAQIDB, R2 and Dropbox;
5. current 15-minute timeout assumptions and recent task runtimes where repository evidence is available;
6. all Cloud Run deploy workflows and GCP-only variables in scope;
7. whether AQI-level retention or Observs outbox flushing has any active scheduler or deploy path, but keep both out of scope;
8. authoritative behaviour that must remain unchanged;
9. code/documentation conflicts or blockers.

Prepare exact read-only operator commands to inventory TEST GCP Cloud Run and Cloud Scheduler resources, but do not run them.

Return:
- findings;
- implementation map;
- active-resource inventory commands;
- minimum file scope for the Observs first phase;
- any blocker that should stop implementation.
```

### Prompt B: implement Observs direct job and workflow

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 1 of:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Work in TEST-uk-aq/uk-aq-ops only. Follow AGENTS.md. Use Level 1 unless a local-only structural check needs Level 2. Do not deploy, dispatch workflows, call external services, apply SQL or edit system_docs/.

Before changing substantial active code, create the required dated archive copies under archive/2026-07-18/.

Refactor Observs partition maintenance so server.mjs and a new direct job.mjs call one shared execution path. Preserve every partition, index, retention, R2-manifest, empty-partition, Dropbox, logging and daily-task-health behaviour.

Add:
- workers/uk_aq_observs_partition_maintenance_service/job.mjs
- .github/workflows/uk_aq_observs_partition_maintenance.yml

The workflow must:
- use workflow_dispatch only;
- use Node 20 and npm ci --ignore-scripts;
- have contents: read permissions;
- prevent overlap with cancel-in-progress: false;
- expose a safe manual dry-run input;
- use the current TEST variables and secrets directly;
- enforce the existing 15-minute task deadline;
- upload tmp/uk_aq_observs_partition_maintenance_report.json with if: always();
- preserve one task-health run under ops.observs_partition_maintenance.

Do not edit cloudflare/scheduler/jobs.toml yet. Do not remove the Cloud Run deploy workflow yet.

Run only minimal structural checks. Add a targeted local wrapper check only if genuinely required to prove that importing the core does not start the HTTP server or that both wrappers invoke the same core.

At the end provide:
1. files changed;
2. archive files created;
3. behaviours preserved;
4. checks run;
5. exact manual workflow-dispatch and TEST validation steps;
6. rollback notes;
7. a concise ChatGPT system-doc handover. Do not edit system_docs/.
```

### Prompt C: Observs scheduler cutover and GCP retirement

```text
Use GPT-5.6 Codex with High reasoning.

Continue the plan at:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Proceed only after the user confirms that the manual dry-run and normal Observs GitHub workflow runs succeeded on TEST.

First implement the scheduler cutover as a focused change:
- change jobs.uk_aq_observs_partition_maintenance in cloudflare/scheduler/jobs.toml from cloud_run to github_workflow;
- retain its authoritative UTC schedule;
- target TEST-uk-aq/uk-aq-ops and uk_aq_observs_partition_maintenance.yml on main;
- remove Cloud Run-only fields from that job;
- run only the existing local scheduler config generation/parse check.

Do not deploy or sync D1. Give the user exact operator steps and expected evidence.

After the user separately confirms the first scheduled GitHub run succeeded, prepare the retirement change:
- remove .github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml;
- remove only proven-unused Observs partition-maintenance GCP service and scheduler variables;
- retain runtime variables used by GitHub Actions;
- do not touch AQI-level retention or outbox flushing;
- prepare exact TEST gcloud deletion and verification commands, but do not run them.

Return a ChatGPT system-doc handover for each accepted change. Do not edit system_docs/.
```

### Prompt D: implement Prune Daily direct job and workflow

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 4 of:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Proceed only after Observs partition maintenance has completed an accepted scheduled GitHub Actions run.

Work in TEST-uk-aq/uk-aq-ops only. Follow AGENTS.md. Do not deploy, dispatch workflows, call external systems or edit system_docs/.

Read the current authoritative R2-history and Prune Daily documents. Preserve all Phase A, Phase B, AQI, manifest, index, repair, deletion, late-arrival, chart-metrics, Dropbox and daily-task-health semantics.

Create required dated archive copies before changing active code.

Refactor Prune Daily so the HTTP server and a new direct job call one shared execution function. Keep the current stage order and failure semantics.

Add:
- workers/uk_aq_prune_daily/job.mjs
- .github/workflows/uk_aq_prune_daily.yml

The workflow must:
- use workflow_dispatch only;
- expose a dry_run input;
- use Node 20 and npm ci --ignore-scripts;
- use contents: read;
- prevent overlapping runs with cancel-in-progress: false;
- map all current runtime variables and actual GitHub secrets;
- enforce the current 15-minute task deadline initially;
- upload tmp/uk_aq_prune_daily_report.json with if: always();
- preserve one task-health run under ops.prune_daily.

Do not change jobs.toml or remove the Cloud Run deploy workflow yet.

Run only minimal structural checks. A small injected wrapper-equivalence check is permitted because the task is destructive, but it must make no external calls.

At the end provide:
1. files changed;
2. archives created;
3. exact preserved behaviours and stage order;
4. checks run;
5. exact dry-run and normal TEST workflow steps;
6. expected report and task-health evidence;
7. rollback notes;
8. ChatGPT system-doc handover. Do not edit system_docs/.
```

### Prompt E: Prune scheduler cutover, retirement and focused cleanup

```text
Use GPT-5.6 Codex with High reasoning.

Continue:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Proceed only after the user confirms successful manual dry-run and normal Prune Daily GitHub workflow operations.

Implement the scheduler change separately:
- add or change jobs.uk_aq_prune_daily in cloudflare/scheduler/jobs.toml to target github_workflow;
- retain the authoritative TEST UTC schedule identified in Phase 0;
- target uk_aq_prune_daily.yml on main;
- ensure there is no second active scheduler path;
- run only the existing scheduler config parse/generation check.

Do not sync D1 or run the workflow. Provide exact operator steps and acceptance evidence.

After the user confirms the first scheduled GitHub run succeeded, implement repository retirement cleanup:
- remove .github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml;
- remove only proven-unused Prune Daily GCP service, scheduler and Secret Manager-name variables;
- retain every runtime variable and secret used by the GitHub workflow;
- update package scripts and active runbooks only where required;
- do not remove generic Docker or GCP support used elsewhere;
- do not remove AQI-level retention or Observs outbox-flush code/configuration;
- report those two as separate retirement candidates only.

Prepare exact TEST gcloud deletion and verification commands, but do not run them.

Return a final ChatGPT system-doc handover. Do not edit system_docs/.
```

## 18. ChatGPT system-documentation prompt

Use this after the implementation and real TEST validation are complete.

```text
Use Chat mode and Thinking.

Update the authoritative system documentation in TEST-uk-aq/uk-aq-ops for the completed migration described by:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Review:
- the implemented repository changes;
- the Codex handovers from each phase;
- actual TEST workflow and scheduler validation results;
- AGENTS.md;
- system_docs/README.md;
- system_docs/documentation_contract.md;
- all current relevant system_docs and legacy evidence.

The implemented end state is expected to be:
- Cloudflare Scheduler is the sole schedule authority;
- GitHub Actions is the execution host for Observs partition maintenance and Prune Daily;
- workflow_dispatch is used, with no GitHub cron;
- task keys remain ops.observs_partition_maintenance and ops.prune_daily;
- the direct jobs and any transitional HTTP wrappers share the same core implementation;
- all retention, backup, R2, repair, deletion and failure gates are unchanged;
- GCP Cloud Run services and deploy workflows for these two tasks are retired after accepted TEST scheduled runs.

Create or complete the appropriate authoritative areas without creating duplicate authority:
- system_docs/scheduling/
- system_docs/prune_and_retention/
- system_docs/observs_operations/

Update where needed:
- system_docs/r2_history/aqi_history_write_pipeline.md, especially implementation ownership and execution-host references;
- system_docs/r2_history/README.md if its reading order or ownership links change;
- system_docs/README.md area status and current implementation map;
- system_docs/documentation_contract.md only if its general rules genuinely changed, which is not expected.

Document:
1. Cloudflare Scheduler and D1 as schedule and dispatch authority;
2. GitHub workflow names, direct job entry points and UTC schedules;
3. concurrency and duplicate-dispatch protection;
4. task-health ownership and completion evidence;
5. secrets and least-privilege boundary at an operational level without exposing values;
6. the 15-minute initial execution deadline and how timeout failures appear;
7. Observs partition and R2 safety gates;
8. Prune Daily stage order and all unchanged completion/deletion gates;
9. deployment, cutover, monitoring and rollback procedures;
10. TEST operational validation evidence;
11. explicit non-goals, including ingests, AQI-level retention and outbox flushing.

Migrate still-current legacy material into the correct authoritative file, but do not copy rules into multiple editable homes. Mark superseded legacy material clearly where appropriate.

Create a focused scheduling ADR only if it prevents the rationale being duplicated across contracts.

At the end report:
1. documentation files created, updated or intentionally left unchanged;
2. which file is authoritative for each major rule;
3. legacy material migrated or superseded;
4. any implementation/documentation conflict that remains.
```

## 19. Completion criteria

This plan is complete when:

- Observs partition maintenance runs normally from GitHub Actions on the Cloudflare schedule;
- Prune Daily runs normally from GitHub Actions on the Cloudflare schedule;
- there is exactly one active schedule authority for each;
- both existing daily-task-health keys remain intact;
- all safety, retention, backup and deletion behaviour remains unchanged;
- both Cloud Run services and their GCP scheduler resources are removed or confirmed absent;
- the two obsolete Cloud Run deploy workflows are removed;
- no unrelated service is changed;
- AQI-level retention and Observs outbox flushing remain excluded;
- authoritative `system_docs/` describes the implemented end state;
- rollback instructions are documented and viable.
