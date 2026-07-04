# UK AQ Supabase DB dump backup Job and service

Cloud Run Job for daily logical backups of:

- `ingestdb`
- `obs_aqidb`

Each run creates `roles.sql.gz`, `schema.sql.gz`, `data.sql.gz` and
`cron_jobs.sql.gz` for each database, uploads them to Dropbox, and prunes dated
Dropbox folders older than the configured retention window.

## Runtime model

Scheduled production execution uses:

```text
Cloud Scheduler: uk-aq-supabase-db-dump-backup-job-trigger
  -> Cloud Run Jobs API
  -> Cloud Run Job: uk-aq-supabase-db-dump-backup-job
  -> job.mjs
  -> daily task health lifecycle
  -> core.mjs backup workflow
```

The Job runs one task with parallelism one, an explicit 30-minute task timeout,
and zero automatic task retries. It exits successfully only when every requested
database backup succeeds.

The previous Scheduler target held one HTTP request open for the whole backup.
That request could produce a Scheduler 502 even when the container subsequently
completed successfully. The old Scheduler job
`uk-aq-supabase-db-dump-backup-trigger` must remain paused.

The existing private Cloud Run Service remains deployed for manual comparison:

- `GET /` or `GET /healthz`
- `POST /run-backup`

Do not schedule the Service endpoint. Scheduled execution must use the Cloud Run Job.

Scheduled Job executions back up both databases in order:

1. `ingestdb`
2. `obs_aqidb`

A manual Job execution may set `UK_AQ_SUPABASE_DB_DUMP_JOB_DATABASES` to
`ingestdb`, `obs_aqidb`, or a comma-separated list through execution overrides.
Scheduled executions must leave this variable unset.

## Daily task health

Both the Job and retained Service use the same health wrapper and preserve:

- task key `ops.supabase_db_dump_backup`
- source worker `uk_aq_supabase_db_dump_backup_service`
- started, finished and failed lifecycle calls
- requested databases
- dump counts
- bytes written
- elapsed time
- errors and warnings

For Job executions, the shared health client records the Cloud Run execution
identifier from `CLOUD_RUN_EXECUTION`.

## Required environment variables and secrets

Secrets:

- `UK_AQ_INGESTDB_DB_URL`
- `OBS_AQIDB_SUPABASE_DB_URL`
- `OBS_AQIDB_SECRET_KEY`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Plain environment:

- `UK_AQ_DROPBOX_ROOT`
- `OBS_AQIDB_SUPABASE_URL`

Optional plain environment:

- `UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR`, default `Supabase_Backup_db_dump`
- `UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS`, default `7`
- `UK_AQ_DB_DUMP_SPLIT_LARGE_INSERTS`, default `true`
- `UK_AQ_DB_DUMP_INSERT_SPLIT_THRESHOLD_ROWS`, default `10000`
- `UK_AQ_DB_DUMP_INSERT_CHUNK_ROWS`, default `5000`
- `SUPABASE_BIN`, default `supabase`
- `GZIP_BIN`, default `gzip`
- `BASH_BIN`, default `bash`

## Data dump behaviour

The worker uses `supabase db dump --dry-run` to emit the Supabase CLI dump
script, then executes it locally with PostgreSQL client 17.

Data dumps are post-processed before compression and upload:

- large multi-row inserts are split into smaller statements
- cron is retained in dump scope
- `schema.sql` enables `pg_cron` when needed
- the `obs_aqidb` schema sets the required PostgREST schemas for `authenticator`
- `cron_jobs.sql` is generated separately from `cron.job`

Output filenames and Dropbox paths are unchanged.

Restore order:

1. `roles.sql.gz`
2. `schema.sql.gz`
3. `data.sql.gz`
4. `cron_jobs.sql.gz`

## Deployment and IAM

The workflow builds one image and deploys it in two forms:

- Service Docker command:
  `node workers/uk_aq_supabase_db_dump_backup_service/server.mjs`
- Job command override:
  `node workers/uk_aq_supabase_db_dump_backup_service/job.mjs`

Service account responsibilities:

- The GitHub Actions deployment account deploys the image, Service, Job and Scheduler configuration.
- The Job runtime account reads Secret Manager values and performs the backup.
- The Scheduler account has `roles/run.invoker` on the Job and uses OAuth to call the Cloud Run Jobs API.
- The Cloud Scheduler service agent can mint a token for the Scheduler account.

The workflow rejects the default compute service account.

## Manual operations

Describe the Job:

```bash
gcloud run jobs describe uk-aq-supabase-db-dump-backup-job \
  --region europe-west2
```

Execute and wait:

```bash
gcloud run jobs execute uk-aq-supabase-db-dump-backup-job \
  --region europe-west2 \
  --wait
```

Describe the Scheduler:

```bash
gcloud scheduler jobs describe uk-aq-supabase-db-dump-backup-job-trigger \
  --location europe-west2
```

Read Job logs:

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="uk-aq-supabase-db-dump-backup-job"' \
  --project "$GCP_PROJECT_ID" \
  --limit 100 \
  --order desc \
  --format json
```

After execution, verify:

1. The Cloud Run Job execution succeeded.
2. Daily task health shows `ops.supabase_db_dump_backup` as successful.
3. Both database summaries show four dumps.
4. Dropbox contains all four dated files for both databases.

## Rollback

Never leave both Scheduler jobs active.

1. Pause `uk-aq-supabase-db-dump-backup-job-trigger`.
2. Confirm there is no running Cloud Run Job execution.
3. Manually test the retained Service.
4. Resume `uk-aq-supabase-db-dump-backup-trigger` only after confirming the
   Job Scheduler is paused.

The deployment workflow refuses to proceed if the old Service Scheduler exists
and is not paused.
