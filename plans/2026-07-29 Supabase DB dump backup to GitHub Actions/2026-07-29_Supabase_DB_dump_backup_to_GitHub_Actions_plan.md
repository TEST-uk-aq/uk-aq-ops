# Supabase DB dump backup to GitHub Actions

Date: 2026-07-29  
Repository: `TEST-uk-aq/uk-aq-ops`  
System: TEST only  
Recommended Codex model: **GPT-5.3-Codex, High reasoning**

## Objective

Replace the retired GCP execution path for the daily logical Supabase database backup with:

```text
Cloudflare cron scheduler
  -> GitHub workflow_dispatch
  -> GitHub Actions ubuntu-latest runner
  -> existing job.mjs and core.mjs backup implementation
  -> Dropbox
  -> daily task health
```

The GCP Cloud Scheduler job, Cloud Run Job and retained Cloud Run Service are being deleted immediately. They are not a fallback and the implementation must not depend on them remaining available.

The new authoritative contract has already been added by ChatGPT:

- `system_docs/backup_and_recovery/README.md`
- `system_docs/backup_and_recovery/contract.md`
- `system_docs/README.md`

Codex must read those files and must not edit anything under `system_docs/`.

## Why this is phased

This change combines three distinct risks:

1. changing the runtime and scheduler;
2. removing the old GCP execution artefacts;
3. correcting the SQL INSERT splitter that caused the 1 GiB out-of-memory failure.

The phases should be implemented in one Codex task, in order, with a review checkpoint in the final handover rather than separate deployments between phases.

A targeted deterministic splitter check is genuinely required. The splitter rewrites restore SQL, so an incorrect comma or semicolon can produce a backup that uploads successfully but is not restorable. No broad speculative test suite is required.

## Behaviour that must not change

Preserve all existing backup behaviour unless the active system contract explicitly changes it:

- scheduled runs back up `ingestdb` followed by `obs_aqidb`;
- manual runs may select one or both databases;
- each database produces `roles.sql.gz`, `schema.sql.gz`, `data.sql.gz` and `cron_jobs.sql.gz`;
- Dropbox paths and overwrite behaviour remain unchanged;
- retention remains independent per successfully completed database;
- `pg_cron`, `authenticator` PostgREST schema configuration and `cron.job` restore SQL remain preserved;
- task-health identity remains `ops.supabase_db_dump_backup`;
- failure of either requested database fails the overall run;
- logs must not expose secrets or connection strings.

## Phase 1: archive affected active code and bound splitter memory

### 1.1 Required reading

Read before editing:

- `AGENTS.md`
- `system_docs/README.md`
- `system_docs/backup_and_recovery/README.md`
- `system_docs/backup_and_recovery/contract.md`
- `cloudflare/scheduler/README.md`
- `cloudflare/scheduler/jobs.toml`
- `workers/uk_aq_supabase_db_dump_backup_service/README.md`
- `workers/uk_aq_supabase_db_dump_backup_service/core.mjs`
- `workers/uk_aq_supabase_db_dump_backup_service/health.mjs`
- `workers/uk_aq_supabase_db_dump_backup_service/job.mjs`
- `tests/uk_aq_supabase_db_dump_backup_service.test.mjs`

Use `grep`, not `rg`, for repository searches.

### 1.2 Archive requirement

Before changing or deleting active non-test code, follow the pre-change archive requirement in `AGENTS.md`.

Use a dated archive root such as:

```text
archive/2026-07-29_Supabase_DB_dump_backup_GitHub_Actions/
```

Archive each in-scope active non-test code file once, preserving its relative path where practical. This includes active JavaScript or shell files that will be changed or deleted. Do not archive documentation, tests, workflows, generated files or configuration catalogues.

### 1.3 Replace the unbounded INSERT splitter

The current `splitLargeDataInsertsInFile()` implementation keeps complete `rowLines` and `originalLines` arrays for the current INSERT. Replace that with a bounded-memory implementation.

Required approach:

- continue reading the source SQL through a line stream;
- retain only bounded state in memory;
- spool the current multi-line INSERT rows to a temporary file, or use an equivalent bounded design;
- count rows and validate the expected row-delimiter shape while spooling;
- when the statement ends:
  - replay it unchanged when it does not qualify for splitting;
  - replay it as correctly terminated chunks when it qualifies;
- determine chunk boundaries from row index and total row count without loading all rows into arrays;
- wait for writable-stream backpressure before continuing writes;
- preserve the existing atomic replacement behaviour for the final SQL file;
- clean up statement spool files and output temporary files in success and failure paths;
- preserve existing summary fields and structured events where practical;
- do not introduce a second SQL parser or change the accepted pg_dump statement format beyond what is needed for bounded processing.

The large-runner memory allowance is not a substitute for this fix.

### 1.4 Focused splitter validation

Use the existing splitter test file. Add or amend only the focused cases needed to prove:

- a 25,001-row statement becomes six statements at 5,000 rows per chunk;
- each generated chunk ends with exactly one semicolon;
- non-final rows use commas;
- row order and row count are unchanged;
- a threshold-sized statement remains unchanged;
- single-line INSERT statements remain unchanged;
- temporary spool files are removed after completion.

Do not add a broad memory benchmark or a large speculative fixture programme. If a small test seam is needed to verify spool cleanup or backpressure handling, keep it local to this component.

## Phase 2: add the GitHub Actions backup workflow

Create:

```text
.github/workflows/uk_aq_supabase_db_dump_backup.yml
```

### 2.1 Trigger and concurrency

Required workflow shape:

- `workflow_dispatch` only;
- optional string input `databases`;
- blank input means both databases;
- accepted non-blank values are `ingestdb`, `obs_aqidb`, or `ingestdb,obs_aqidb`;
- concurrency group `uk-aq-supabase-db-dump-backup`;
- `cancel-in-progress: false`;
- `runs-on: ubuntu-latest`;
- `timeout-minutes: 90`;
- `permissions.contents: read`.

Do not add a GitHub cron schedule. Cloudflare is the sole scheduled dispatcher.

### 2.2 Runtime dependencies

The workflow must install:

- Node.js 20;
- PostgreSQL client 17;
- Supabase CLI `2.79.0`;
- repository dependencies with `npm ci --ignore-scripts`.

Use the previous Dockerfile only as a reference for compatible installation steps. The Dockerfile itself is retired in Phase 4.

### 2.3 Environment

Read these GitHub repository secrets:

```text
SUPABASE_DB_URL
OBS_AQIDB_SUPABASE_DB_URL
OBS_AQIDB_SECRET_KEY
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
DROPBOX_REFRESH_TOKEN
```

Map the existing ingest database secret into the worker's current runtime environment name:

```yaml
UK_AQ_INGESTDB_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
```

Do not require or create a GitHub repository secret named `UK_AQ_INGESTDB_DB_URL`. That name remains internal to the worker runtime only.

Map the remaining secrets to their same-named worker environment variables.

Map these repository variables with the active contract defaults:

```text
UK_AQ_DROPBOX_ROOT
UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR
UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS
UK_AQ_DB_DUMP_SPLIT_LARGE_INSERTS
UK_AQ_DB_DUMP_INSERT_SPLIT_THRESHOLD_ROWS
UK_AQ_DB_DUMP_INSERT_CHUNK_ROWS
OBS_AQIDB_SUPABASE_URL
```

Set:

```text
UK_AQ_SUPABASE_DB_DUMP_JOB_DATABASES=${workflow_dispatch input}
```

Leave it blank for a normal Cloudflare dispatch so `job.mjs` retains scheduler mode and selects both databases.

Validate required values before starting the backup. Do not print secret values.

### 2.4 Execution

Run:

```bash
node workers/uk_aq_supabase_db_dump_backup_service/job.mjs
```

Preserve the process exit status. The workflow must fail when the job returns non-zero.

Do not add GCP authentication, Docker build, Artifact Registry, Secret Manager, Cloud Run or Cloud Scheduler steps.

## Phase 3: add the Cloudflare scheduler job

Modify:

```text
cloudflare/scheduler/jobs.toml
```

Add:

```toml
[jobs.uk_aq_supabase_db_dump_backup]
enabled = true
cron_expr = "55 0 * * *"
target_type = "github_workflow"
github_repo = "TEST-uk-aq/uk-aq-ops"
github_workflow_file = "uk_aq_supabase_db_dump_backup.yml"
github_ref = "main"
dry_run = false
notes = "Supabase logical database dumps to Dropbox"
```

Do not supply a `github_inputs` table for the scheduled run. It must dispatch the workflow with no database override.

Confirm the current scheduler implementation accepts the entry through the existing `jobs.toml` validation and D1 sync path. Do not change scheduler runtime code unless the existing generic GitHub workflow path cannot support this job. It should already support it.

## Phase 4: retire active GCP repository artefacts

Delete these active files after archiving applicable code files:

```text
.github/workflows/uk_aq_supabase_db_dump_backup_service_deploy.yml
workers/uk_aq_supabase_db_dump_backup_service/Dockerfile
workers/uk_aq_supabase_db_dump_backup_service/server.mjs
scripts/gcp/uk_aq_supabase_db_dump_backup_deploy.sh
scripts/gcp/uk_aq_supabase_db_dump_backup_scheduler.sh
```

Do not delete shared GCP helpers used by other systems.

Update active references, including as applicable:

- `package.json`:
  - remove the HTTP-service start script;
  - retain the job runner script;
  - remove the deleted `server.mjs` from `check`;
- `workers/uk_aq_supabase_db_dump_backup_service/README.md`:
  - describe Cloudflare to GitHub Actions execution;
  - remove Cloud Run, Scheduler, IAM and gcloud instructions;
  - retain backup contents, configuration, manual workflow use and TEST validation;
- `config/uk_aq_github_env_targets.csv`:
  - remove backup-specific GCP-only entries that no longer have another active consumer;
  - retain or add `SUPABASE_DB_URL` and the other GitHub secrets and variables needed by the new workflow;
- root README or active non-system operational docs only where they contain an active GCP description for this backup.

Do not edit `system_docs/` or `system_docs_legacy/`.

Do not rename `workers/uk_aq_supabase_db_dump_backup_service/` in this migration. The active contract permits the historical directory suffix to remain.

## Phase 5: minimal structural validation

Run only the smallest checks needed:

```bash
node --check workers/uk_aq_supabase_db_dump_backup_service/core.mjs
node --check workers/uk_aq_supabase_db_dump_backup_service/health.mjs
node --check workers/uk_aq_supabase_db_dump_backup_service/job.mjs
node --test tests/uk_aq_supabase_db_dump_backup_service.test.mjs
python3 cloudflare/scheduler/scripts/sync_jobs.py \
  --jobs-file cloudflare/scheduler/jobs.toml \
  --sql-file /tmp/scheduler_jobs_sync.sql \
  --json-file /tmp/scheduler_jobs_expected.json
```

Also parse or inspect the new workflow with the smallest existing repository mechanism available. Do not install a new validation framework solely for this workflow.

Confirm that the workflow maps:

```yaml
UK_AQ_INGESTDB_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
```

and does not reference `secrets.UK_AQ_INGESTDB_DB_URL`.

Use `grep` to confirm there are no active references to:

```text
uk-aq-supabase-db-dump-backup-job-trigger
uk-aq-supabase-db-dump-backup-trigger
uk-aq-supabase-db-dump-backup-job
uk-aq-supabase-db-dump-backup-service
```

Exclude `archive/`, `system_docs_legacy/` and historical plans from that check. The implementation directory name is an allowed remaining match.

Do not run the complete repository test suite.

## Codex permissions and stopping point

Use **Level 1, code only** from `AGENTS.md`.

Codex must:

- edit repository files;
- run only the focused local checks above;
- not commit or push;
- not edit GitHub repository secrets or variables;
- not sync remote D1;
- not deploy the Cloudflare Worker;
- not dispatch the workflow;
- not call Supabase, Dropbox, GCP or other external services.

Stop after implementation and provide:

1. files created, changed and deleted;
2. archive files created;
3. focused checks run and results;
4. any difference between implementation and the active system contract;
5. exact manual commands or GitHub UI actions required after commit;
6. the post-deployment TEST acceptance checklist;
7. a concise ChatGPT system-documentation handover, even if no further docs change appears necessary.

## Manual deployment and TEST acceptance after Codex

After reviewing and committing the changes:

1. push the changes to `main`;
2. allow the Cloudflare scheduler config-sync workflow to update remote D1;
3. confirm the new scheduler row is enabled, uses `55 0 * * *`, targets `uk_aq_supabase_db_dump_backup.yml`, and has `dry_run = false`;
4. manually dispatch `UK AQ Supabase DB Dump Backup` with a blank database input;
5. confirm all eight expected dated Dropbox files exist and have non-zero sizes;
6. confirm task health records `ops.supabase_db_dump_backup` as successful;
7. inspect the GitHub logs for both successful database summaries and four dumps per database;
8. inspect enough of the decompressed `data.sql` chunk boundaries to confirm valid commas and semicolons;
9. allow the next 00:55 UTC Cloudflare schedule to dispatch exactly one workflow;
10. confirm no active GCP backup resources or active repository deployment path remains.

The GCP runtime has already been retired. If the first GitHub run fails, disable the Cloudflare scheduler job, fix the workflow, and rerun manually. Do not recreate GCP as an automatic fallback.

# Ready-to-paste Codex prompt

Use **GPT-5.3-Codex with High reasoning**.

```text
Work in the TEST-uk-aq/uk-aq-ops repository.

Implement every phase of:

plans/2026-07-29 Supabase DB dump backup to GitHub Actions/2026-07-29_Supabase_DB_dump_backup_to_GitHub_Actions_plan.md

The GCP Cloud Scheduler job, Cloud Run Job and retained Cloud Run Service have already been retired. Do not preserve or recreate a GCP fallback.

Before editing, read AGENTS.md and the active system documentation listed by the plan, especially:

- system_docs/README.md
- system_docs/backup_and_recovery/README.md
- system_docs/backup_and_recovery/contract.md

Treat system_docs as read-only. Do not create, edit, move, rename or delete any file under system_docs.

Implement all phases in order:

1. follow the dated pre-change archive requirement for affected active non-test code;
2. replace the current unbounded large-INSERT arrays with a bounded-memory spool/stream implementation that honours write backpressure and preserves valid restore SQL;
3. create the workflow_dispatch-only GitHub Actions backup workflow using ubuntu-latest, Node 20, PostgreSQL client 17, Supabase CLI 2.79.0, a 90-minute timeout and queued concurrency;
4. use the existing GitHub secret SUPABASE_DB_URL and map it into the worker as UK_AQ_INGESTDB_DB_URL; do not require a GitHub secret named UK_AQ_INGESTDB_DB_URL;
5. add the 00:55 UTC GitHub workflow job to cloudflare/scheduler/jobs.toml with no scheduled database override;
6. delete the retired GCP workflow, Dockerfile, HTTP server and backup-specific GCP deploy/scheduler scripts;
7. update package.json, the worker README, the GitHub environment catalogue and any other active references required by the plan;
8. run only the focused structural checks listed in the plan.

Use grep, not rg. Use Level 1 only. Do not commit, push, deploy, sync remote D1, dispatch workflows, access cloud services or change repository settings.

Do not add broad speculative tests. The focused splitter test is required because SQL delimiter corruption could create an unrestorable backup. Functional testing will happen through a real TEST GitHub Actions backup after deployment.

At the end, provide the exact implementation handover required by the plan, including files changed, archives, checks, manual deployment steps, TEST acceptance and any contract discrepancy.
```
