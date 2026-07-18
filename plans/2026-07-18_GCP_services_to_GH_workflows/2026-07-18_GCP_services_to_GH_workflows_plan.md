# GCP services to GitHub workflows

**Date:** 18 July 2026  
**Target environment:** TEST only  
**Primary repository:** `TEST-uk-aq/uk-aq-ops`  
**Plan path:** `plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md`  
**Status:** Revised implementation plan

## 1. Purpose

Move these two once-daily TEST operational tasks from GCP Cloud Run execution to GitHub Actions execution:

1. `uk_aq_observs_partition_maintenance`
2. `uk_aq_prune_daily`

Cloudflare Scheduler remains the sole schedule authority and dispatches the GitHub workflows through `workflow_dispatch`.

This is a TEST system. Pre-deployment testing must therefore be minimal. Functional validation should happen through real operation on TEST after the workflows have been added.

Both tasks may be implemented together. Prune Daily does not need to wait for Observs partition maintenance to run successfully before its code and workflow are written.

The intended end state is:

```text
Cloudflare Scheduler
  -> GitHub workflow_dispatch
  -> GitHub Actions workflow
  -> direct Node job
  -> existing task logic
  -> current TEST Supabase, ObsAQIDB, R2 and Dropbox resources
```

## 2. Scope

### 2.1 In scope

- Make the existing Observs partition-maintenance logic directly runnable without HTTP.
- Make the existing Prune Daily logic directly runnable without HTTP.
- Retain the existing Cloud Run HTTP wrappers temporarily so rollback remains simple during cutover.
- Add one manually dispatchable GitHub Actions workflow for each task.
- Preserve the existing task-health identities:
  - `ops.observs_partition_maintenance`
  - `ops.prune_daily`
- Preserve existing structured logging, Dropbox diagnostics and failure behaviour.
- Write a bounded JSON report from each direct job and upload it as a workflow artefact.
- After real TEST runs succeed, change both Cloudflare Scheduler jobs to dispatch GitHub workflows.
- After cutover is accepted, allow the user to remove the old TEST GCP triggers and Cloud Run services.
- Remove obsolete repository deployment files and GCP-only configuration only after the user confirms the GCP resources have been removed.
- Update authoritative `system_docs/` afterwards through ChatGPT in Chat mode.

### 2.2 Out of scope

- LIVE repositories or resources.
- Ingest services.
- Changes to retention periods, deletion rules, repair behaviour or backup requirements.
- Changes to Prune Daily Phase A or Phase B logic.
- Changes to R2 history formats, manifests, indexes or byte-stability rules.
- Changes to DAQI or EAQI calculations.
- AQI-level retention retirement.
- Observs outbox flushing.
- Redesign of Cloudflare Scheduler, its D1 claim protection or its minute loop.
- New GitHub cron schedules.
- Broad repository cleanup.
- Broad new test suites.

## 3. Fixed requirements

### 3.1 TEST only

All work is restricted to `TEST-uk-aq/uk-aq-ops` and TEST resources.

Do not inspect, modify, dispatch or delete LIVE resources.

### 3.2 Minimal testing

Follow `AGENTS.md` TEST System Validation Policy.

Before deployment, run only the smallest checks needed to establish structural viability:

- `node --check` for changed JavaScript files;
- YAML parsing or the repository's existing fast workflow validation;
- one narrow import or startup-guard check only if needed to prove that importing the shared execution path does not start an HTTP server.

Do not create a broad automated test suite, simulated prune suite, fixture programme, shadow comparison or soak test.

Real functional testing happens by running both workflows against the TEST system.

One successful normal TEST operation for each task, with a representative output and task-health check, is sufficient before scheduler cutover unless a real failure identifies a specific additional check.

### 3.3 Both tasks are implemented together

Codex should complete the code and workflow work for both tasks in one implementation pass.

Do not require an accepted Observs workflow run before implementing Prune Daily.

Do not deploy or change `cloudflare/scheduler/jobs.toml` during the implementation pass.

### 3.4 Cloudflare remains the schedule authority

The new GitHub workflows must use `workflow_dispatch` only.

Do not add:

```yaml
schedule:
```

Cloudflare Scheduler already handles due slots and duplicate-claim protection.

### 3.5 Preserve existing behaviour

This is an execution-host migration, not a business-logic rewrite.

Observs partition maintenance must continue to preserve:

- current and future partition creation;
- hot and cold index enforcement;
- default-partition diagnostics;
- retention candidate selection;
- R2 history safety checks before populated partition deletion;
- safe empty-partition deletion behaviour;
- skipped-drop and error reporting;
- Dropbox diagnostics;
- task-health reporting.

Prune Daily must continue to preserve this effective order and behaviour:

1. Phase A recent fingerprint comparison and repair.
2. Phase B R2 history backup.
3. R2 history index maintenance.
4. Chart-load metrics maintenance.
5. Normal retention-window comparison, repair and deletion.
6. Late-arrival discovery and cleanup.
7. Combined summary and task-health finalisation.

Do not split Prune Daily stages into separate GitHub jobs or workflows.

Do not alter:

- deletion eligibility;
- deletion caps;
- fingerprint logic;
- repair replay;
- Phase B completion gates;
- R2 manifest or index rules;
- AQI history generation;
- warning versus failure semantics;
- late-arrival handling;
- retention windows.

### 3.6 Keep one task-health run per task

The direct execution path must own the existing `withDailyTaskRun(...)` call.

Do not add a second task-health wrapper in workflow YAML.

The task keys remain:

```text
ops.observs_partition_maintenance
ops.prune_daily
```

### 3.7 Keep the current execution deadline

Initially preserve the existing 15-minute operational deadline for each task.

Use:

- a 15-minute command deadline that terminates the Node process;
- a workflow timeout with a small margin for checkout, dependency installation and artefact upload.

A suitable workflow timeout is 25 minutes.

Do not increase the task deadline during this migration unless a real TEST run proves the existing operational contract is already insufficient.

### 3.8 Prevent overlapping runs

Each workflow must have a stable task-specific concurrency group and:

```yaml
cancel-in-progress: false
```

Do not invent a second application lock unless current code or a real TEST failure shows it is needed.

### 3.9 Use existing GitHub secrets and variables

Codex must inspect the current Cloud Run deploy workflows and repository configuration, then map the same effective TEST runtime configuration into each GitHub workflow.

Use the actual GitHub secrets required by the task. Do not pass GCP Secret Manager secret-name variables into the direct jobs.

Do not rename, remove or consolidate compatibility variables during this migration unless a change is strictly required for the new execution path.

### 3.10 Minimum refactor

Both current workers contain their task logic and HTTP startup in `server.mjs`.

Prefer the smallest safe refactor:

- export the existing normal configuration builder;
- export one shared function that performs the complete task-health-wrapped execution;
- ensure importing the module does not start the HTTP server;
- retain the current HTTP endpoint, authentication, query overrides, responses and error handling while Cloud Run remains available;
- add a thin `job.mjs` that calls the shared execution function.

A separate `core.mjs` may be introduced only if it clearly produces a smaller or safer change. Do not move large amounts of working code merely to achieve a preferred file layout.

## 4. Phase 0: focused inspection and implementation map

**Owner:** Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1

This phase is part of the same Codex implementation pass as Phases 1 and 2.

Before editing:

1. Read:
   - `AGENTS.md`;
   - `system_docs/README.md`;
   - `system_docs/documentation_contract.md`;
   - the authoritative Prune Daily, retention, R2 history and Observs operations documents.
2. Inspect only the files needed for this migration, including:
   - `workers/uk_aq_observs_partition_maintenance_service/server.mjs`;
   - `workers/uk_aq_prune_daily/server.mjs`;
   - their current Cloud Run deploy workflows;
   - relevant existing GitHub batch workflows;
   - `cloudflare/scheduler/jobs.toml`;
   - scheduler config-sync code;
   - `config/uk_aq_github_env_targets.csv`;
   - relevant `package.json` scripts.
3. Use `grep`, not `rg`.
4. Confirm:
   - the current task-health wrappers and keys;
   - the existing configuration builders and direct task functions;
   - every runtime secret and variable used by each Cloud Run service;
   - the smallest safe method of preventing HTTP startup when imported;
   - the exact report summary available from each task;
   - the current active Prune Daily schedule from repository evidence.
5. Stop only for a genuine blocker that makes the requested execution-host migration structurally unsafe.

Do not produce a long cloud-resource inventory. Do not run GCP, database, R2, Dropbox, workflow or deployment operations.

## 5. Phase 1: implement both direct jobs and workflows

**Owner:** Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1, with Level 2 only for a narrow local structural check

### 5.1 Archive changed active code

Follow `AGENTS.md`.

Before changing substantial active non-test implementation code, archive the current version under:

```text
archive/2026-07-18/
```

Archive only active non-test code files that will be changed.

Do not archive workflows, plans, system documentation, tests, fixtures or generated files.

### 5.2 Observs partition-maintenance direct execution

Refactor the current worker minimally so the existing HTTP wrapper and the new direct job call one shared task-health-wrapped execution function.

Add:

```text
workers/uk_aq_observs_partition_maintenance_service/job.mjs
```

The direct job must:

- build the same normal environment-based configuration as an authenticated `/run` request without query overrides;
- call the same maintenance implementation and `withDailyTaskRun(...)` path;
- preserve `ops.observs_partition_maintenance`;
- not start an HTTP server;
- not require the Cloud Run dispatch secret;
- write its bounded JSON summary to:

```text
tmp/uk_aq_observs_partition_maintenance_report.json
```

- exit `0` on task success;
- exit non-zero on task failure according to current behaviour.

The transitional HTTP service must retain `/healthz`, `POST /run`, authentication, query overrides, response status and current error reporting.

### 5.3 Prune Daily direct execution

Refactor the current worker minimally so the existing HTTP wrapper and the new direct job call one shared task-health-wrapped execution function.

Add:

```text
workers/uk_aq_prune_daily/job.mjs
```

The direct job must:

- build the same normal environment-based configuration as an authenticated `/run` request without query overrides;
- support the workflow's explicit dry-run input without changing normal defaults;
- call the same complete `runPrune(config)` path and existing stage order;
- preserve `ops.prune_daily`;
- not start an HTTP server;
- not require the Cloud Run upstream secret;
- write its bounded JSON summary to:

```text
tmp/uk_aq_prune_daily_report.json
```

- exit `0` when the overall task succeeds;
- exit non-zero when current overall failure semantics require it;
- preserve current warning-only handling for non-fatal substages.

The transitional HTTP service must retain `/healthz`, `POST /run`, authentication, query overrides, response status and current error reporting.

### 5.4 Observs GitHub workflow

Add:

```text
.github/workflows/uk_aq_observs_partition_maintenance.yml
```

Required characteristics:

- `workflow_dispatch` only;
- optional boolean dry-run input for partition dropping;
- `permissions: contents: read`;
- stable Observs-specific concurrency group;
- `cancel-in-progress: false`;
- Node.js 20;
- `npm ci --ignore-scripts`;
- only the configuration validation needed for a clear missing-secret failure;
- the same effective TEST runtime variables and secrets as the current service;
- 15-minute direct-command deadline;
- workflow timeout with a small margin;
- upload `tmp/uk_aq_observs_partition_maintenance_report.json` with `if: always()`;
- no second task-health wrapper.

### 5.5 Prune Daily GitHub workflow

Add:

```text
.github/workflows/uk_aq_prune_daily.yml
```

Required characteristics:

- `workflow_dispatch` only;
- optional boolean `dry_run` input;
- `permissions: contents: read`;
- stable Prune-specific concurrency group;
- `cancel-in-progress: false`;
- Node.js 20;
- `npm ci --ignore-scripts`;
- only the configuration validation needed for a clear missing-secret failure;
- the same effective TEST runtime variables and secrets as the current service;
- 15-minute direct-command deadline;
- workflow timeout with a small margin;
- upload `tmp/uk_aq_prune_daily_report.json` with `if: always()`;
- no second task-health wrapper.

### 5.6 Do not cut over scheduling yet

During this phase, do not:

- edit `cloudflare/scheduler/jobs.toml`;
- dispatch either workflow;
- deploy anything;
- remove either Cloud Run deploy workflow;
- remove GCP variables;
- edit `system_docs/`.

## 6. Phase 2: minimal structural checks and Codex handover

**Owner:** Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning

Run only:

1. `node --check` on changed JavaScript files.
2. The existing fast YAML or workflow parse check, where available.
3. One narrow local import check only if required to prove that importing the task execution path does not start the HTTP server.

Do not add new tests unless a targeted check is genuinely required to prevent the direct job from accidentally starting the server or bypassing the shared execution function.

Do not call external services.

Codex must then provide:

- files changed;
- archive files created;
- exact behaviour preserved for each task;
- configuration and secret mapping used by each workflow;
- checks run;
- exact manual workflow-dispatch steps;
- expected workflow artefacts and task-health evidence;
- rollback notes;
- affected `system_docs/` files for ChatGPT.

Phases 0, 1 and 2 should be completed in one Codex request.

## 7. Phase 3: real TEST workflow validation

**Owner:** User/operator

After the implementation is available on the TEST repository default branch, manually dispatch both workflows.

They may be run independently or during the same validation period. Neither task needs to wait for the other to succeed first.

Because this is the TEST system, the minimum required functional validation is one normal run of each workflow.

A dry run is optional. Use it only if the user wants an extra safety preview or if the implementation handover identifies a specific unresolved configuration risk.

For each normal run, confirm only:

- checkout and dependency installation succeeded;
- the direct Node job ran rather than starting an HTTP service;
- one task-health run used the existing task key;
- the JSON report artefact was uploaded;
- the task completed within the 15-minute command deadline;
- the summary and representative output are credible for the existing task;
- no secrets appeared in logs or artefacts.

For Observs partition maintenance, also check that the existing R2 or empty-partition safety gate remains visible for any drop candidate.

For Prune Daily, also check that the combined summary contains Phase A, Phase B, history index, chart metrics, normal prune and late-arrival results in the existing order.

Do not require repeated successful runs before cutover unless a real failure needs investigation.

## 8. Phase 4: cut over both Cloudflare Scheduler jobs

**Owner:** Codex for repository edit, user/operator for config sync and operation  
**Recommended model:** GPT-5.6 Codex with High reasoning

Proceed after one accepted normal TEST workflow run for each task.

Update `cloudflare/scheduler/jobs.toml` for both tasks in one focused change.

### 8.1 Observs partition maintenance

Retain the current authoritative schedule:

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

Remove Cloud Run-only fields and its Cloud Run request body.

### 8.2 Prune Daily

Add or update the canonical scheduler entry:

```toml
[jobs.uk_aq_prune_daily]
enabled = true
cron_expr = "<confirmed current TEST UTC schedule>"
target_type = "github_workflow"
github_repo = "TEST-uk-aq/uk-aq-ops"
github_workflow_file = "uk_aq_prune_daily.yml"
github_ref = "main"
dry_run = false
notes = "Prune Daily via GitHub Actions"
```

Use the active TEST schedule confirmed from current repository configuration. The expected schedule is 02:00 UTC unless current authoritative evidence shows otherwise.

Run only the existing scheduler TOML parse or sync-payload generation check.

Codex must not sync D1 or dispatch workflows.

The user/operator will run the existing scheduler config-sync process and confirm that each next due slot produces one D1 claim and one GitHub workflow dispatch.

Both scheduler entries may be cut over together. There is no requirement to accept one scheduled migration before cutting over the other.

## 9. Phase 5: remove old TEST GCP resources and repository deployment paths

**Owner:** User/operator for GCP resources, Codex for repository cleanup

After the scheduled GitHub runs are accepted, the user may remove:

- the old TEST GCP Cloud Scheduler triggers for these two tasks, where they still exist;
- the TEST Observs partition-maintenance Cloud Run service;
- the TEST Prune Daily Cloud Run service.

Codex does not need to run or prepare GCP deletion commands unless the user asks for them.

After the user confirms the GCP resources are removed, Codex should make one focused repository cleanup change:

- remove the two obsolete Cloud Run deploy workflows;
- remove only GCP service, scheduler and Secret Manager-name configuration proven to be used solely by these two retired services;
- retain every runtime variable and secret used by the new GitHub workflows;
- retain generic GCP, Docker and deployment support used by other services;
- update package scripts or active non-system runbooks only where they incorrectly describe Cloud Run as the remaining execution path;
- use `grep` to confirm no active workflow still deploys either retired service;
- do not edit `system_docs/`;
- do not remove AQI-level retention or Observs outbox-flush code or configuration as part of this plan.

Run only syntax or configuration parsing checks directly relevant to the cleanup.

## 10. Phase 6: update authoritative system documentation

**Owner:** ChatGPT in Chat mode using Thinking

After implementation, real TEST validation, scheduler cutover and GCP removal are complete, update the relevant authoritative files under `system_docs/`.

Document:

- Cloudflare Scheduler and D1 as the schedule and dispatch authority;
- GitHub Actions as the execution host for both tasks;
- workflow names and direct job entry points;
- current UTC schedules;
- concurrency behaviour;
- task-health ownership;
- the 15-minute task deadline;
- Observs partition and R2 deletion safeguards;
- Prune Daily stage order and unchanged completion gates;
- monitoring and rollback;
- removal of the two TEST Cloud Run services and deploy workflows.

Do not create duplicate authority across multiple system documents.

## 11. Rollback

### 11.1 Before scheduler cutover

No runtime rollback is needed. The current Cloud Run execution path remains active.

### 11.2 After scheduler cutover but before GCP removal

- change the affected scheduler entry back to `cloud_run`;
- restore its managed Cloud Run target fields;
- sync scheduler configuration;
- leave the GitHub workflow available but unscheduled.

Either task may be rolled back independently.

### 11.3 After GCP removal

Restore the relevant Cloud Run deploy workflow from Git history, redeploy the TEST service, then change only that task's scheduler entry back to `cloud_run`.

Rollback must not bypass retention, backup, R2 history or partition-drop safeguards.

## 12. Codex prompts

### Prompt A: implement both direct jobs and workflows

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phases 0, 1 and 2 of:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Work only in TEST-uk-aq/uk-aq-ops. Follow AGENTS.md. Use grep, not rg. Do not inspect or modify LIVE.

This is a TEST system. Perform minimal pre-deployment checking. Do not create broad new tests. Do not deploy, dispatch workflows, call external services, edit cloudflare/scheduler/jobs.toml or edit system_docs/.

Implement both tasks in this request:
- uk_aq_observs_partition_maintenance
- uk_aq_prune_daily

Do not wait for one task to run successfully before implementing the other.

First inspect only the relevant workers, current Cloud Run deploy workflows, existing GitHub batch workflow conventions, scheduler configuration, environment mapping and authoritative system documents.

For each current server.mjs, make the smallest safe refactor so:
1. its existing normal configuration builder is reusable;
2. one shared function owns the complete withDailyTaskRun execution;
3. importing the module does not start the HTTP server;
4. the current HTTP endpoint, auth, overrides, responses and error behaviour remain available during transition;
5. a new job.mjs runs the same shared path without HTTP or the edge dispatch secret.

Add:
- workers/uk_aq_observs_partition_maintenance_service/job.mjs
- workers/uk_aq_prune_daily/job.mjs
- .github/workflows/uk_aq_observs_partition_maintenance.yml
- .github/workflows/uk_aq_prune_daily.yml

The Observs job must preserve task key ops.observs_partition_maintenance and write:
tmp/uk_aq_observs_partition_maintenance_report.json

The Prune Daily job must preserve task key ops.prune_daily, preserve the complete existing stage order and write:
tmp/uk_aq_prune_daily_report.json

Each workflow must:
- use workflow_dispatch only;
- use Node 20 and npm ci --ignore-scripts;
- use contents: read;
- have a stable task-specific concurrency group with cancel-in-progress: false;
- map the same effective TEST runtime variables and actual GitHub secrets as the current service;
- provide a manual dry-run input;
- enforce the existing 15-minute command deadline;
- upload its JSON report with if: always();
- rely on the shared in-code task-health wrapper, with no duplicate workflow wrapper.

Preserve all existing Observs partition, R2 safety, retention, Dropbox, logging and failure behaviour.

Preserve all existing Prune Daily Phase A, Phase B, R2 history, index byte-stability, AQI, chart metrics, repair, deletion, late-arrival, Dropbox, logging and failure behaviour. Do not split its stages into separate jobs or workflows.

Before changing substantial active non-test code, create the required dated archive copies under archive/2026-07-18/. Do not archive workflows, documentation or tests.

Run only:
- node --check on changed JavaScript;
- existing fast YAML/workflow parsing where available;
- one narrow local import/startup-guard check only if genuinely needed.

At the end provide:
1. files changed;
2. archive files created;
3. exact preserved behaviour for each task;
4. secrets and variables mapped for each workflow;
5. checks run;
6. exact manual dispatch steps for both workflows;
7. expected artefacts and task-health evidence;
8. rollback notes;
9. concise handover for ChatGPT to update system_docs later.
```

### Prompt B: cut over both scheduler entries

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 4 of:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Proceed because the user has confirmed one accepted normal TEST GitHub workflow run for both Observs partition maintenance and Prune Daily.

Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, sync D1, dispatch workflows, call external services or edit system_docs/.

Update both jobs in cloudflare/scheduler/jobs.toml in one focused change:
- Observs partition maintenance becomes github_workflow targeting uk_aq_observs_partition_maintenance.yml on main and retains 03:00 UTC unless current authoritative configuration has changed.
- Prune Daily becomes github_workflow targeting uk_aq_prune_daily.yml on main and uses the confirmed current TEST UTC schedule, expected to be 02:00 UTC unless authoritative evidence differs.

Remove Cloud Run-only fields from the migrated scheduler entries. Do not add GitHub schedule triggers.

Run only the existing scheduler TOML parse or sync-payload generation check.

Return:
1. exact file change;
2. confirmed schedules;
3. check run;
4. exact user steps to run the existing scheduler config sync;
5. expected D1 claim and GitHub dispatch evidence;
6. rollback edit for each task.
```

### Prompt C: repository cleanup after user removes GCP resources

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 5 of:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

The user has confirmed that the old TEST GCP triggers and Cloud Run services for Observs partition maintenance and Prune Daily have been removed.

Work only in TEST-uk-aq/uk-aq-ops. Use grep, not rg. Do not run GCP commands, deploy, call external services or edit system_docs/.

Remove the two obsolete Cloud Run deploy workflows and only the GCP-specific configuration proven to be used solely by those two retired services.

Retain:
- all runtime variables and secrets used by the GitHub workflows;
- generic GCP or Docker support used elsewhere;
- AQI-level retention and Observs outbox-flush code and configuration;
- historical plans and legacy evidence.

Update package scripts or active non-system runbooks only where they incorrectly describe Cloud Run as the active execution path.

Run only directly relevant syntax or configuration parsing checks.

Return:
1. files changed or removed;
2. obsolete references removed;
3. shared configuration deliberately retained;
4. checks run;
5. rollback notes;
6. final ChatGPT system-doc handover.
```

## 13. ChatGPT system-documentation prompt

```text
Use Chat mode and Thinking.

Update the authoritative system documentation in TEST-uk-aq/uk-aq-ops for the completed migration described by:
plans/2026-07-18_GCP_services_to_GH_workflows/2026-07-18_GCP_services_to_GH_workflows_plan.md

Review the implemented repository state, Codex handovers and real TEST validation evidence.

The completed end state should be:
- Cloudflare Scheduler is the sole schedule authority;
- GitHub Actions executes Observs partition maintenance and Prune Daily;
- both workflows use workflow_dispatch only;
- task keys remain ops.observs_partition_maintenance and ops.prune_daily;
- the direct jobs and transitional HTTP wrappers use the same execution logic;
- retention, backup, R2, repair, deletion and failure gates remain unchanged;
- the two TEST Cloud Run services, old triggers and deploy workflows are retired.

Update the relevant authoritative scheduling, prune and retention, Observs operations and R2 history documents without creating duplicate authority.

At the end report:
1. documentation files changed;
2. the authoritative file for each major rule;
3. legacy material migrated or superseded;
4. any remaining implementation and documentation conflict.
```

## 14. Completion criteria

This plan is complete when:

- both direct jobs and GitHub workflows are implemented together;
- one normal TEST workflow operation for each task is accepted;
- Cloudflare Scheduler dispatches both GitHub workflows;
- each task has exactly one active schedule path;
- both existing task-health keys remain intact;
- all retention, backup, repair, R2 and deletion behaviour remains unchanged;
- the user has removed the old TEST GCP triggers and Cloud Run services;
- obsolete Cloud Run deploy workflows and task-specific GCP-only repository configuration are removed;
- no unrelated service is changed;
- authoritative `system_docs/` describes the implemented end state;
- rollback remains viable from Git history.