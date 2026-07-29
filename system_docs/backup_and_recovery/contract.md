# Supabase logical database dump backup contract

## Authority and scope

This document is authoritative for the scheduled logical backups of:

- `ingestdb`
- `obs_aqidb`

It governs scheduling, GitHub Actions execution, concurrent per-database processing, backup contents, Dropbox layout, retention, task-health reporting, failure behaviour and the bounded-memory SQL post-processing requirement.

Where older code, workflows, plans or documentation conflict with this document, this document is authoritative for this backup path.

The historical GCP description in `system_docs_legacy/uk-aq-supabase-db-dump-backup-service.md` is superseded. The GCP Cloud Scheduler job, Cloud Run Job, retained Cloud Run Service, Artifact Registry image path and Secret Manager runtime are retired and MUST NOT remain an active or fallback execution path.

## Required runtime architecture

The scheduled production path MUST be:

```text
Cloudflare Worker cron scheduler
  -> D1 scheduler job claim
  -> GitHub workflow_dispatch
  -> .github/workflows/uk_aq_supabase_db_dump_backup.yml
  -> one GitHub-hosted ubuntu-latest job
  -> workers/uk_aq_supabase_db_dump_backup_service/job.mjs
  -> one daily task health lifecycle
  -> workers/uk_aq_supabase_db_dump_backup_service/core.mjs
  -> concurrent ingestdb and obs_aqidb backup branches
  -> dated Dropbox backup files
```

The authoritative scheduler job key MUST be:

```text
uk_aq_supabase_db_dump_backup
```

The normal schedule MUST be:

```text
55 0 * * *
```

All schedule times are UTC.

The GitHub workflow MUST expose `workflow_dispatch`. It MUST NOT add a separate GitHub `schedule` trigger. Cloudflare plus D1 is the sole scheduled dispatcher for this task.

## GitHub Actions execution contract

The workflow MUST:

- use `ubuntu-latest`;
- use Node.js 20;
- install PostgreSQL client 17;
- install Supabase CLI version `2.79.0`, matching the previously deployed runtime;
- install repository dependencies with `npm ci --ignore-scripts`;
- set `timeout-minutes: 150`;
- use a dedicated concurrency group;
- set `cancel-in-progress: false`;
- run `node workers/uk_aq_supabase_db_dump_backup_service/job.mjs`;
- fail when the job process returns a non-zero exit status;
- obtain database and Dropbox credentials directly from GitHub Actions secrets;
- obtain non-secret configuration from GitHub repository variables;
- preserve structured logs and the existing daily task-health lifecycle.

The concurrency group MUST prevent overlapping scheduled or manual backup workflow runs. A newly dispatched workflow run MUST queue rather than cancel an active run.

A normal two-database execution MUST run the `ingestdb` and `obs_aqidb` database backup branches concurrently inside the same Node.js process and the same GitHub Actions job. It MUST NOT use a GitHub Actions matrix or separate database jobs. This preserves one workflow result, one health lifecycle and one combined report.

Concurrent database execution MUST:

- be bounded to the requested databases, with a maximum concurrency of two;
- give each database its own temporary working directory and dated Dropbox path;
- keep the four dump stages within each individual database sequential;
- allow both database branches to reach a settled success or failure result before finalising the combined report;
- avoid shared mutable state that can corrupt credentials, temporary files, uploads, retention or summaries;
- preserve canonical database result order as `ingestdb`, then `obs_aqidb`, regardless of completion order.

## Required workflow inputs

Manual workflow dispatch MUST support an optional database selection with these accepted values:

```text
ingestdb
obs_aqidb
ingestdb,obs_aqidb
```

Blank database selection MUST back up both databases.

The workflow MUST also support an explicit trigger mode with exactly these accepted values:

```text
manual
scheduler
```

Manual workflow dispatch MUST default to `manual`. The Cloudflare scheduled dispatch MUST provide `trigger_mode = "scheduler"` through the existing scheduler `github_inputs` mechanism and MUST provide no database override. Blank database selection MUST NOT by itself be used to infer scheduler mode.

Unsupported trigger modes or database names MUST fail before backup work begins.

## Required secrets and variables

The GitHub workflow MUST read these repository secrets:

```text
SUPABASE_DB_URL
OBS_AQIDB_SUPABASE_DB_URL
OBS_AQIDB_SECRET_KEY
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
DROPBOX_REFRESH_TOKEN
```

The authoritative GitHub secret name for the `ingestdb` direct PostgreSQL connection is `SUPABASE_DB_URL`. The workflow MUST expose that secret to the existing worker through this runtime environment mapping:

```yaml
UK_AQ_INGESTDB_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
```

`UK_AQ_INGESTDB_DB_URL` is an internal worker environment-variable name, not a required GitHub repository secret. The workflow MUST NOT require a GitHub secret named `UK_AQ_INGESTDB_DB_URL`.

The workflow MUST read these variables:

```text
UK_AQ_DROPBOX_ROOT
UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR
UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS
UK_AQ_DB_DUMP_SPLIT_LARGE_INSERTS
UK_AQ_DB_DUMP_INSERT_SPLIT_THRESHOLD_ROWS
UK_AQ_DB_DUMP_INSERT_CHUNK_ROWS
OBS_AQIDB_SUPABASE_URL
```

Existing defaults remain authoritative unless explicitly changed by a later contract:

```text
UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR=Supabase_Backup_db_dump
UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS=7
UK_AQ_DB_DUMP_SPLIT_LARGE_INSERTS=true
UK_AQ_DB_DUMP_INSERT_SPLIT_THRESHOLD_ROWS=10000
UK_AQ_DB_DUMP_INSERT_CHUNK_ROWS=5000
```

No GCP authentication, project, service-account, Artifact Registry, Cloud Run or Secret Manager configuration is required by the active workflow.

## Backup contents and order

A normal scheduled run MUST request both databases in this canonical result order:

1. `ingestdb`
2. `obs_aqidb`

The two databases execute concurrently. Canonical order applies to selection, combined reporting and summaries, not to which database finishes first.

Within each database, the backup stages MUST remain sequential in this order:

1. roles
2. schema
3. data
4. cron jobs
5. retention

Each successful database backup MUST produce exactly these four gzip files:

```text
roles.sql.gz
schema.sql.gz
data.sql.gz
cron_jobs.sql.gz
```

The dated Dropbox layout MUST remain:

```text
/<UK_AQ_DROPBOX_ROOT>/<UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR>/<database>/YYYY-MM-DD/<file>
```

The workflow MUST preserve these established behaviours:

- roles, schema and data are generated through the Supabase CLI dump script;
- PostgreSQL client 17 executes the emitted dump script;
- `cron` remains included in dump scope;
- `schema.sql` enables `pg_cron` when required;
- the `obs_aqidb` schema preserves the required `authenticator` PostgREST schema configuration;
- `cron_jobs.sql` is generated separately from `cron.job`;
- gzip output is uploaded to Dropbox with overwrite semantics;
- a same-day rerun replaces the same dated files rather than creating duplicate names.

Restore order remains:

1. `roles.sql.gz`
2. `schema.sql.gz`
3. `data.sql.gz`
4. `cron_jobs.sql.gz`

## Bounded-memory data INSERT splitting

Large multi-row INSERT statements MUST continue to be split into restore-safe chunks before compression and upload.

The splitter MUST NOT retain an entire large INSERT statement in JavaScript arrays or otherwise scale heap use with the complete statement size.

The implementation MUST:

- process the source SQL as a stream;
- use bounded in-memory buffers;
- spool an INSERT to a temporary file or use an equivalent bounded approach when the complete row count must be known;
- preserve the original statement byte-for-byte when it does not qualify for splitting, apart from any unavoidable existing newline normalisation already covered by focused checks;
- write split statements with correct commas and terminating semicolons;
- honour writable-stream backpressure;
- remove temporary files on success and failure;
- leave the original dump file intact if rewriting fails before atomic replacement;
- preserve the existing summary fields and structured logging where practical.

Moving to a GitHub-hosted runner with more memory does not remove this requirement. Database growth MUST NOT make heap use proportional to a complete generated INSERT statement.

## Retention contract

Retention MUST be applied independently after each database backup completes successfully.

For each database, only date-named folders older than the configured inclusive retention window may be deleted. Non-date folders MUST be ignored.

With a retention value of `7`, the current run date plus the preceding six UTC dates are retained.

A database that fails before completion MUST NOT have its retention step reported as successful.

Concurrent retention operations are permitted because each database uses a separate Dropbox database root. They MUST NOT inspect or delete the other database's folders.

## Task-health contract

The task-health identity MUST remain:

```text
task_key: ops.supabase_db_dump_backup
source_repo: uk-aq-ops
source_worker: uk_aq_supabase_db_dump_backup_service
```

The task definition metadata MUST describe the active runtime as GitHub:

```text
platform: github
source_workflow: .github/workflows/uk_aq_supabase_db_dump_backup.yml
source_service: null
```

The health lifecycle MUST record one started state and one final success or failure state for the combined workflow. It MUST NOT create an independent daily task run for each database.

The compact summary MUST continue to report, where available:

- trigger mode;
- requested databases;
- successfully completed databases;
- successful and failed database counts;
- successful and failed dump counts, using four expected dumps per requested database;
- compressed bytes written;
- elapsed time;
- Dropbox destination root;
- errors and warnings.

`databases_backed_up` MUST include only database results with `ok === true`. `successful_dump_count` MUST include every completed dump present in database result `dumps` arrays, including completed uploads from a database that later fails. `failed_dump_count` MUST be the non-negative difference between four expected dumps per requested database and the completed dump count.

GitHub context may be added to the health summary, but it MUST NOT replace the stable task identity above.

## Failure and rerun behaviour

The overall workflow MUST fail if either requested database fails.

A failure in one database branch MUST NOT deliberately cancel the other branch. The implementation MUST wait for both requested database branches to settle, then retain each branch's success or failure result in canonical database order.

Either database may upload a complete or partial backup while the other database fails. This partial success MUST remain visible in structured logs and the combined task-health summary.

A rerun for the same UTC date MUST safely overwrite already uploaded files and complete any missing or failed database backup.

Automatic workflow retries MUST NOT be added by creating a second schedule or overlapping dispatch. Operational retries are manual workflow dispatches unless a later scheduler contract explicitly defines bounded retry behaviour.

Secrets, connection strings and Dropbox tokens MUST be redacted from errors and logs.

## Retired repository artefacts

The implementation phase MUST remove active repository artefacts whose only purpose was the retired GCP runtime, including:

- `.github/workflows/uk_aq_supabase_db_dump_backup_service_deploy.yml`;
- `workers/uk_aq_supabase_db_dump_backup_service/Dockerfile`;
- `workers/uk_aq_supabase_db_dump_backup_service/server.mjs`;
- `scripts/gcp/uk_aq_supabase_db_dump_backup_deploy.sh`;
- `scripts/gcp/uk_aq_supabase_db_dump_backup_scheduler.sh`.

References to those artefacts in active package scripts, checks, worker-local documentation, configuration catalogues and operational documentation MUST be removed or replaced.

Historical copies under `archive/` and `system_docs_legacy/` remain historical and MUST NOT be wired into active execution.

The implementation directory may retain the `_service` suffix to avoid an unnecessary broad path rename.

## Structural validation before deployment

Pre-deployment validation MUST remain minimal. It MUST establish only that:

- the workflow YAML is structurally valid and sets `timeout-minutes: 150`;
- the scheduler TOML and generated D1 sync payload are structurally valid;
- changed JavaScript parses;
- the focused INSERT-splitting checks pass;
- manual database selection maps correctly into `UK_AQ_SUPABASE_DB_DUMP_JOB_DATABASES`;
- trigger mode maps independently from database selection and the scheduler supplies `trigger_mode = "scheduler"`;
- a focused test proves that a two-database request starts both database operations before either is allowed to resolve, waits for both results and returns them in canonical order;
- `SUPABASE_DB_URL` is mapped into the worker runtime as `UK_AQ_INGESTDB_DB_URL`;
- obsolete active GCP references are absent from the retired backup path.

A targeted deterministic splitter check is required because malformed commas or semicolons can create an unrestorable backup while the backup run itself appears successful.

Do not add a broad speculative test suite or run the full repository test suite solely for this migration.

## Functional acceptance in TEST

After the code reaches `main` and the scheduler configuration is synced:

1. run the workflow manually for both databases;
2. confirm logs show both database branches start before either database branch finishes;
3. confirm the GitHub job completes within the 150-minute envelope;
4. confirm daily task health records one successful `ops.supabase_db_dump_backup` run;
5. confirm both database summaries report four dump files in canonical result order;
6. confirm all eight dated Dropbox files exist and have non-zero compressed sizes;
7. inspect the generated `data.sql.gz` files sufficiently to confirm split INSERT statements have valid chunk boundaries;
8. confirm the Cloudflare D1 scheduler row is enabled with cron `55 0 * * *`, `trigger_mode = "scheduler"` in `github_inputs_json` and `dry_run = false`;
9. allow the next scheduled operation to run and confirm it dispatches exactly one GitHub workflow;
10. confirm no active GCP backup scheduler, Cloud Run Job or Cloud Run Service remains.

A full restore exercise is not required for this TEST migration unless the focused SQL checks or real backup output reveal a specific restore-risk concern.

## Rollback

The retired GCP runtime is not the normal rollback path.

If the GitHub workflow fails after cutover:

1. disable the Cloudflare scheduler job in `cloudflare/scheduler/jobs.toml` and sync D1;
2. correct the workflow or backup code;
3. run the repaired workflow manually;
4. re-enable the Cloudflare scheduler job after successful TEST operation.

Do not recreate or resume the GCP schedule merely as a quick fallback. Any return to GCP requires an explicit new contract decision.
