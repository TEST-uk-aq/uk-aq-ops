# Supabase logical database dump backup contract

## Authority and scope

This document is authoritative for the scheduled logical backups of:

- `ingestdb`
- `obs_aqidb`

It governs scheduling, GitHub Actions execution, backup contents, Dropbox layout, retention, task-health reporting, failure behaviour and the bounded-memory SQL post-processing requirement.

Where older code, workflows, plans or documentation conflict with this document, this document is authoritative for this backup path.

The historical GCP description in `system_docs_legacy/uk-aq-supabase-db-dump-backup-service.md` is superseded. The GCP Cloud Scheduler job, Cloud Run Job, retained Cloud Run Service, Artifact Registry image path and Secret Manager runtime are retired and MUST NOT remain an active or fallback execution path.

## Required runtime architecture

The scheduled production path MUST be:

```text
Cloudflare Worker cron scheduler
  -> D1 scheduler job claim
  -> GitHub workflow_dispatch
  -> .github/workflows/uk_aq_supabase_db_dump_backup.yml
  -> GitHub-hosted ubuntu-latest runner
  -> workers/uk_aq_supabase_db_dump_backup_service/job.mjs
  -> daily task health lifecycle
  -> workers/uk_aq_supabase_db_dump_backup_service/core.mjs
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
- set `timeout-minutes: 90`;
- use a dedicated concurrency group;
- set `cancel-in-progress: false`;
- run `node workers/uk_aq_supabase_db_dump_backup_service/job.mjs`;
- fail when the job process returns a non-zero exit status;
- obtain database and Dropbox credentials directly from GitHub Actions secrets;
- obtain non-secret configuration from GitHub repository variables;
- preserve structured logs and the existing daily task-health lifecycle.

The concurrency group MUST prevent overlapping scheduled or manual backup runs. A newly dispatched run MUST queue rather than cancel an active run.

## Required workflow inputs

Manual workflow dispatch MUST support an optional database selection with these accepted values:

```text
ingestdb
obs_aqidb
ingestdb,obs_aqidb
```

Blank selection MUST back up both databases in the canonical order.

The Cloudflare scheduled dispatch MUST provide no database override so that `job.mjs` identifies the execution as a scheduler run and selects both databases.

Unsupported database names MUST fail before backup work begins.

## Required secrets and variables

The GitHub workflow MUST read these secrets:

```text
UK_AQ_INGESTDB_DB_URL
OBS_AQIDB_SUPABASE_DB_URL
OBS_AQIDB_SECRET_KEY
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
DROPBOX_REFRESH_TOKEN
```

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

A normal scheduled run MUST back up both databases sequentially in this order:

1. `ingestdb`
2. `obs_aqidb`

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

## Task-health contract

The task-health identity MUST remain:

```text
task_key: ops.supabase_db_dump_backup
source_repo: uk-aq-ops
source_worker: uk_aq_supabase_db_dump_backup_service
```

The health lifecycle MUST record started and final success or failure states. The compact summary MUST continue to report, where available:

- trigger mode;
- requested databases;
- databases backed up;
- successful and failed database counts;
- dump counts;
- compressed bytes written;
- elapsed time;
- Dropbox destination root;
- errors and warnings.

GitHub context may be added to the health summary, but it MUST NOT replace the stable task identity above.

## Failure and rerun behaviour

The overall workflow MUST fail if either requested database fails.

A run may have already uploaded a complete backup for the first database when the second database fails. This partial success MUST remain visible in structured logs and task-health summary.

A rerun for the same UTC date MUST safely overwrite already uploaded files and complete the missing or failed database backup.

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

- the workflow YAML is structurally valid;
- the scheduler TOML and generated D1 sync payload are structurally valid;
- changed JavaScript parses;
- the focused INSERT-splitting checks pass;
- manual database selection maps correctly into `UK_AQ_SUPABASE_DB_DUMP_JOB_DATABASES`;
- obsolete active GCP references are absent from the retired backup path.

A targeted deterministic splitter check is required because malformed commas or semicolons can create an unrestorable backup while the backup run itself appears successful.

Do not add a broad speculative test suite or run the full repository test suite solely for this migration.

## Functional acceptance in TEST

After the code reaches `main` and the scheduler configuration is synced:

1. run the workflow manually for both databases;
2. confirm the GitHub job completes within the 90-minute envelope;
3. confirm daily task health records a successful `ops.supabase_db_dump_backup` run;
4. confirm both database summaries report four dump files;
5. confirm all eight dated Dropbox files exist and have non-zero compressed sizes;
6. inspect the generated `data.sql.gz` files sufficiently to confirm split INSERT statements have valid chunk boundaries;
7. confirm the Cloudflare D1 scheduler row is enabled with cron `55 0 * * *` and `dry_run = false`;
8. allow the next scheduled operation to run and confirm it dispatches exactly one GitHub workflow;
9. confirm no active GCP backup scheduler, Cloud Run Job or Cloud Run Service remains.

A full restore exercise is not required for this TEST migration unless the focused SQL checks or real backup output reveal a specific restore-risk concern.

## Rollback

The retired GCP runtime is not the normal rollback path.

If the GitHub workflow fails after cutover:

1. disable the Cloudflare scheduler job in `cloudflare/scheduler/jobs.toml` and sync D1;
2. correct the workflow or backup code;
3. run the repaired workflow manually;
4. re-enable the Cloudflare scheduler job after successful TEST operation.

Do not recreate or resume the GCP schedule merely as a quick fallback. Any return to GCP requires an explicit new contract decision.