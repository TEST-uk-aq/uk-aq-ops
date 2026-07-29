# UK AQ Supabase DB dump backup

This worker creates daily logical backups of `ingestdb` and `obs_aqidb` in
Dropbox. The implementation directory retains its `_service` suffix for path
continuity; there is no active HTTP service.

## Runtime model

Scheduled production execution uses:

```text
Cloudflare cron scheduler
  -> D1 job: uk_aq_supabase_db_dump_backup
  -> GitHub workflow_dispatch
  -> .github/workflows/uk_aq_supabase_db_dump_backup.yml
  -> job.mjs
  -> daily task health lifecycle
  -> core.mjs
  -> Dropbox
```

The scheduler entry in `cloudflare/scheduler/jobs.toml` runs at `00:55 UTC`,
provides `trigger_mode=scheduler`, and does not provide a database input. The
workflow defaults `trigger_mode` to `manual` for UI dispatches. Trigger source
is resolved independently of database selection, and a blank selection backs up
both databases in this order:

1. `ingestdb`
2. `obs_aqidb`

Manual workflow dispatch keeps the default trigger mode and accepts `ingestdb`,
`obs_aqidb`, `ingestdb,obs_aqidb`, or a blank value for both. GitHub Actions
concurrency queues overlapping scheduled or manual runs rather than cancelling
either run.

The retired GCP scheduler and compute runtimes are not a fallback. If the
GitHub path fails, disable the Cloudflare scheduler job, fix and manually rerun
the workflow, then re-enable the scheduler after successful TEST operation.

## Backup contents

Each successful database backup writes these four gzip files:

- `roles.sql.gz`
- `schema.sql.gz`
- `data.sql.gz`
- `cron_jobs.sql.gz`

The Dropbox layout is:

```text
/<UK_AQ_DROPBOX_ROOT>/<UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR>/<database>/YYYY-MM-DD/<file>
```

Same-day reruns overwrite the dated files. Restore order is roles, schema,
data, then cron jobs. The implementation retains `cron` in dump scope, enables
`pg_cron` in schema output, preserves the `obs_aqidb` `authenticator` PostgREST
schemas, and serializes `cron.job` separately.

Large multi-row data INSERTs are streamed through bounded temporary spools.
Statements over the configured threshold are replayed as restore-safe chunks;
smaller, single-line, and unrecognized statements are replayed unchanged.
Temporary output replaces the source atomically only after a successful rewrite.

Retention runs independently after each successfully completed database. With
the default value `7`, the current UTC date and preceding six dated folders are
kept; non-date folders are ignored.

## GitHub configuration

Required secrets:

- `SUPABASE_DB_URL` (mapped to worker environment variable `UK_AQ_INGESTDB_DB_URL`)
- `OBS_AQIDB_SUPABASE_DB_URL`
- `OBS_AQIDB_SECRET_KEY`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Required repository variables:

- `UK_AQ_DROPBOX_ROOT`
- `OBS_AQIDB_SUPABASE_URL`

Optional repository variables and workflow defaults:

- `UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR`, default `Supabase_Backup_db_dump`
- `UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS`, default `7`
- `UK_AQ_DB_DUMP_SPLIT_LARGE_INSERTS`, default `true`
- `UK_AQ_DB_DUMP_INSERT_SPLIT_THRESHOLD_ROWS`, default `10000`
- `UK_AQ_DB_DUMP_INSERT_CHUNK_ROWS`, default `5000`

Local command overrides remain available for `SUPABASE_BIN`, `GZIP_BIN`, and
`BASH_BIN`. The GitHub runner installs Node.js 20, PostgreSQL client 17, and
Supabase CLI 2.79.0.

## Task health and failure behavior

The stable task identity is:

- task key `ops.supabase_db_dump_backup`
- source repo `uk-aq-ops`
- source worker `uk_aq_supabase_db_dump_backup_service`

Started and final success/failure states include the trigger mode, requested
databases, dump and database counts, bytes, elapsed time, destination, errors,
and warnings. The process exits non-zero if any requested database fails. A
same-date manual rerun safely overwrites files already uploaded by a partial run.

## Manual TEST operation

From GitHub Actions, dispatch **UK AQ Supabase DB Dump Backup**. Leave
`databases` blank to exercise the normal two-database path, or enter one of the
accepted values for a targeted rerun.

After deployment, verify:

1. the workflow succeeds within 90 minutes;
2. task health records a successful `ops.supabase_db_dump_backup` run;
3. both database summaries contain four dumps;
4. all eight dated Dropbox files exist and have non-zero compressed sizes;
5. decompressed data SQL has valid INSERT chunk delimiters;
6. the D1 job is enabled at `55 0 * * *`, has `dry_run = false`, and dispatches
   exactly one workflow on the next scheduled operation.
