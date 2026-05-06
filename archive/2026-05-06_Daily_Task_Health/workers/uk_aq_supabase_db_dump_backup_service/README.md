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
- `UK_AQ_OBS_AQIDB_DB_URL`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Plain env:

- `UK_AQ_DROPBOX_ROOT`

Optional plain env:

- `UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR` default `Supabase_Backup_db_dump`
- `UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS` default `7`
- `SUPABASE_BIN` default `supabase`
- `GZIP_BIN` default `gzip`
- `BASH_BIN` default `bash`

## Important implementation note

The worker uses `supabase db dump --dry-run` to emit the exact Supabase CLI dump script for each dump type, then executes that script locally with PostgreSQL client 17 inside the container. This keeps the dump behaviour aligned with Supabase CLI while remaining compatible with Cloud Run Service.
