# uk_aq Supabase DB dump backup service

Private Cloud Run service for daily logical backups of:

- `ingestdb`
- `obs_aqidb`

Each run creates:

- `roles.sql.gz`
- `schema.sql.gz`
- `data.sql.gz`

for each database, uploads them to Dropbox, and prunes dated Dropbox folders older than the configured retention window.

## Runtime model

The service exposes:

- `GET /` or `GET /healthz`
- `POST /run-backup`

Cloud Scheduler should call `POST /run-backup` with authenticated OIDC.

Manual calls may optionally limit the run to one database:

```json
{
  "trigger_mode": "manual",
  "database": "ingestdb"
}
```

Scheduled calls always run both databases in order:

1. `ingestdb`
2. `obs_aqidb`

## Required environment variables / secrets

Secrets:

- `UK_AQ_INGESTDB_DB_URL`
- `OBS_AQIDB_SUPABASE_DB_URL`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Plain env:

- `UK_AQ_DROPBOX_ROOT`

Optional plain env:

- `UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR` default `Supabase_Backup_db_dump`
- `UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS` default `7`
- `UK_AQ_DB_DUMP_SPLIT_LARGE_INSERTS` default `true`
- `UK_AQ_DB_DUMP_INSERT_SPLIT_THRESHOLD_ROWS` default `10000`
- `UK_AQ_DB_DUMP_INSERT_CHUNK_ROWS` default `5000` (clamped to `100..100000`)
- `SUPABASE_BIN` default `supabase`
- `GZIP_BIN` default `gzip`
- `BASH_BIN` default `bash`

## Data dump post-processing

`data.sql` is post-processed before gzip/upload to reduce restore stalls through Supabase/session pooler paths:

- only `data` dumps are rewritten (`roles`/`schema` are untouched)
- large multi-row `INSERT INTO ... VALUES` statements are split into smaller INSERT statements
- per-row values are preserved; only trailing row delimiters are adjusted when chunking
- Supabase dry-run scripts are normalized so `cron` is not excluded from dump scope (preserves `cron.job` rows)
- Supabase dry-run scripts are also normalized so explicit `--schema` include lists contain `cron` when not using wildcard schema selection
- `schema.sql` is prefixed with `create extension if not exists pg_cron;` when missing
- `obs_aqidb` `schema.sql` is also prefixed with a guarded statement to set
  `authenticator` PostgREST schemas globally:
  `public,graphql_public,uk_aq_public,uk_aq_ops`

Output filenames and Dropbox paths are unchanged:

- `roles.sql.gz`
- `schema.sql.gz`
- `data.sql.gz`

## Restore note for cron jobs

To restore scheduled jobs from `data.sql.gz` into a new database, ensure the `pg_cron` extension is enabled on the target first so `cron.job` exists before running the data restore.

## Important implementation note

The worker uses `supabase db dump --dry-run` to emit the exact Supabase CLI dump script for each dump type, then executes that script locally with PostgreSQL client 17 inside the container. This keeps the dump behaviour aligned with Supabase CLI while remaining compatible with Cloud Run Service.
