# uk-aq-ops

Cloud Run operations services for:

- pruning verified ingest rows after parity checks against history
- flushing ingest history outbox rows into history DB
- maintaining history DB partitions/index policy/retention
- logging ingest/history database size samples

## Worker layout

Each gcloud-facing service now lives under `workers/`:

- `workers/uk_aq_prune_daily/server.mjs`
- `workers/uk_aq_history_outbox_flush_service/server.mjs`
- `workers/uk_aq_history_partition_maintenance_service/server.mjs`
- `workers/uk_aq_db_size_logger_cloud_run/run_service.ts`

## Services

### 1) UK AQ Prune Daily (`workers/uk_aq_prune_daily/server.mjs`)

- `POST /run`
- verifies hourly fingerprints (ingest vs history)
- prunes only verified ingest hour buckets
- can repair mismatches through outbox replay before re-check

Required env:

- `SUPABASE_URL`
- `HISTORY_SUPABASE_URL`
- `SB_SECRET_KEY`
- `HISTORY_SECRET_KEY`
- `SUPABASE_DB_URL` (direct Postgres URL for streaming Phase B backup reads)
- `CFLARE_R2_ENDPOINT`
- one bucket mapping: `R2_BUCKET_PROD` / `R2_BUCKET_STAGE` / `R2_BUCKET_DEV` (or fallback `CFLARE_R2_BUCKET`)
- `CFLARE_R2_ACCESS_KEY_ID`
- `CFLARE_R2_SECRET_ACCESS_KEY`

Primary controls:

- `INGESTDB_PRUNE_DRY_RUN` (default `true`)
- `INGESTDB_RETENTION_DAYS` (default `7`)
- `INGESTDB_PRUNE_MAX_HOURS_PER_RUN` (default `48`)
- `INGESTDB_PRUNE_DELETE_BATCH_SIZE` (default `50000`)
- `INGESTDB_PRUNE_MAX_DELETE_BATCHES_PER_HOUR` (default `10`)
- `BACKUP_PHASE_B_ENABLED` (default `true`)
- `BACKUP_PART_MAX_ROWS` (default `1000000`)
- `BACKUP_CURSOR_FETCH_ROWS` (default `20000`)
- `BACKUP_ROW_GROUP_SIZE` (default `100000`)
- `BACKUP_MAX_CANDIDATES_PER_RUN` (default `500`)
- `BACKUP_STAGING_RETENTION_DAYS` (default `7`)
- `BACKUP_STAGING_PREFIX` (default `backup/staging`)
- `BACKUP_COMMITTED_PREFIX` (default `backup/observations`)
- `BACKUP_RUNS_PREFIX` (default `backup/runs`)
- `UK_AQ_DEPLOY_ENV` (`dev|stage|prod`, default `dev`)

### 2) History Outbox Flush (`workers/uk_aq_history_outbox_flush_service/server.mjs`)

- `POST /run`
- claims outbox rows in ingest DB
- upserts to history DB
- writes receipts and resolves outbox rows

### 3) History Partition Maintenance (`workers/uk_aq_history_partition_maintenance_service/server.mjs`)

- `POST /run`
- ensures daily partitions, enforces hot/cold indexes
- runs default partition diagnostics
- applies retention drops with backup gate checks

### 4) DB Size Logger (`workers/uk_aq_db_size_logger_cloud_run/run_service.ts`)

- `GET /` health
- `POST /` executes logger job
- samples ingest + history DB size via RPC
- upserts metrics and runs retention cleanup

## Local run

```bash
npm install
npm run start:prune
npm run start:flush
npm run start:history-partitions
```

Type-check quick validation:

```bash
npm run check
```

Download one backed-up UTC day from R2 (manifest-first, no Supabase reads):

```bash
node scripts/backup_r2/download_day.mjs --day 2026-02-20 --out ./tmp/backup_download
node scripts/backup_r2/download_day.mjs --day 2026-02-20 --connector 4 --out ./tmp/backup_download
```

## Env + GitHub sync

Repo-local files:

- `.env`
- `.env.supabase`
- `config/uk_aq_github_env_targets.csv`

Sync keys to GitHub repo secrets/variables using your alias to the shared sync script:

```bash
uk_aq_sync_github_secrets \
  --repo <owner/repo> \
  --env-file .env \
  --supabase-env-file .env.supabase \
  --targets-file config/uk_aq_github_env_targets.csv
```

To use a different CSV mapping:

```bash
uk_aq_sync_github_secrets \
  --repo <owner/repo> \
  --targets-file config/<your_targets>.csv
```

## SQL RPC scripts

Apply in Supabase SQL editor:

- `sql/ingest_db_ops_rpcs.sql` (ingest DB)
- `sql/history_db_ops_rpcs.sql` (history DB)

## Deployment workflows

- `/.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_history_outbox_flush_service_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_history_partition_maintenance_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_db_size_logger_cloud_run_deploy.yml`

## Setup docs

- `system_docs/setup/uk-aq-ingestdb-prune.md`
- `system_docs/setup/uk-aq-history-outbox-flush-service.md`
- `system_docs/setup/uk-aq-history-partition-maintenance.md`
