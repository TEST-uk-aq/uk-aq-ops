# uk-aq-ops

Cloud Run operations services for:

- pruning verified ingest rows after parity checks against `obs_aqidb` (`uk_aq_observs`)
- flushing ingest outbox rows into `obs_aqidb` (`uk_aq_observs`)
- maintaining `uk_aq_observs` partitions/index policy/retention
- enforcing `uk_aq_aqilevels` retention with manifest-gated day cleanup
- logging ingest/obs_aqidb database size samples
- running operational backfill workflows across ingest/obs_aqidb

## Worker layout

Each gcloud-facing service now lives under `workers/`:

- `workers/uk_aq_prune_daily/server.mjs`
- `workers/uk_aq_observs_outbox_flush_service/server.mjs`
- `workers/uk_aq_observs_partition_maintenance_service/server.mjs`
- `workers/uk_aq_aqilevels_retention_service/server.mjs`
- `workers/uk_aq_db_size_logger_cloud_run/run_service.ts`
- `workers/uk_aq_station_aqi_hourly_cloud_run/run_service.ts`
- `workers/uk_aq_backfill_cloud_run/run_service.ts`

Cloudflare edge workers in this repo:

- `workers/uk_aq_db_size_metrics_api_worker/worker.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`
- `workers/uk_aq_cache_proxy/src/index.ts`

## Services

### 1) UK AQ Prune Daily (`workers/uk_aq_prune_daily/server.mjs`)

- `POST /run`
- verifies hourly fingerprints (ingest vs `obs_aqidb` `uk_aq_observs`)
- prunes only verified ingest hour buckets
- can repair mismatches through outbox replay before re-check
- Phase B R2 History export uses server-side projection + resume checkpoints so failed exports can continue without re-reading completed parts

Required env:

- `SUPABASE_URL`
- `OBS_AQIDB_SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SECRET_KEY`
- `SUPABASE_DB_URL` (direct Postgres URL for streaming Phase B history reads)
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
- `UK_AQ_R2_HISTORY_PHASE_B_ENABLED` (default `true`)
- `UK_AQ_R2_HISTORY_PART_MAX_ROWS` (default `1000000`)
- `UK_AQ_R2_HISTORY_CURSOR_FETCH_ROWS` (default `20000`)
- `UK_AQ_R2_HISTORY_ROW_GROUP_SIZE` (default `100000`)
- `UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN` (default `500`)
- `UK_AQ_R2_HISTORY_STAGING_RETENTION_DAYS` (default `7`)
- `UK_AQ_R2_HISTORY_STAGING_PREFIX` (default `history/v1/_ops/observations/staging`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` (default `history/v1/observations`)
- `UK_AQ_R2_HISTORY_RUNS_PREFIX` (default `history/v1/_ops/observations/runs`)
- `UK_AQ_DEPLOY_ENV` (`dev|stage|prod`, default `dev`)

### 2) Observs Outbox Flush (`workers/uk_aq_observs_outbox_flush_service/server.mjs`)

- `POST /run`
- claims outbox rows in ingest DB
- upserts to `obs_aqidb` (`uk_aq_observs`)
- writes receipts and resolves outbox rows

### 3) Observs Partition Maintenance (`workers/uk_aq_observs_partition_maintenance_service/server.mjs`)

- `POST /run`
- ensures daily partitions, enforces hot/cold indexes
- runs default partition diagnostics
- applies retention drops with R2 History manifest gate checks

### 4) DB Size Logger (`workers/uk_aq_db_size_logger_cloud_run/run_service.ts`)

- `GET /` health
- `POST /` executes logger job
- samples ingest + obs_aqidb DB cluster size via RPC
- upserts metrics and runs retention cleanup in each source DB's local metrics table
- degrades to warning on single-source DB-size failures; fails only if both DB sources fail
- default GitHub deploy keeps Cloud Scheduler disabled; Supabase `pg_cron` is the primary hourly scheduler

### 5) AQI Levels Retention (`workers/uk_aq_aqilevels_retention_service/server.mjs`)

- `POST /run`
- computes retention cutoff using Europe/London local-day policy
- lists AQI day candidates older than cutoff from `uk_aq_aqilevels`
- checks committed R2 History manifest per day:
  - `history/v1/aqilevels/day_utc=YYYY-MM-DD/manifest.json`
- deletes only days with confirmed committed manifest

### 6) DB + R2 Metrics API Worker (`workers/uk_aq_db_size_metrics_api_worker/worker.mjs`)

- `GET /v1/db-size-metrics`
- `GET /v1/r2-history-days`
- dashboard fan-in endpoint for DB size trend rows
- reads `uk_aq_public.uk_aq_db_size_metrics_hourly` from ingest + obs_aqidb
- scans committed R2 History day manifests for observations + aqilevels
- preserves null `oldest_observed_at` values for placeholder rendering in dashboard tooltips
- optional bearer token gate (`UK_AQ_DB_SIZE_API_TOKEN`)

### 7) Observs History R2 API Worker (`workers/uk_aq_observs_history_r2_api_worker/worker.mjs`)

- `GET /v1/observations` (alias: `GET /`)
- reads only committed R2 history days/manifests under `history/v1/observations/...`
- requires `x-uk-aq-upstream-auth` matching `UK_AQ_EDGE_UPSTREAM_SECRET`
- returns normalized `{observed_at,value}` rows for a single `timeseries_id` + `connector_id`
- consumed by ingest edge function `uk_aq_timeseries` for old-window reads

### 8) Station AQI Hourly Worker (`workers/uk_aq_station_aqi_hourly_cloud_run/run_service.ts`)

- `GET /` health
- `POST /` executes AQI run job
- reads station-hour pollutant means from ingest RPC
- computes pollutant-specific DAQI + EAQI levels (PM DAQI uses rolling 24h mean)
- upserts `station_aqi_hourly` and refreshes daily/monthly rollups in `uk_aq_aqilevels`
- logs run telemetry (`aqi_compute_runs`) with 7-day retention cleanup

### 9) Backfill Worker (`workers/uk_aq_backfill_cloud_run/run_service.ts`)

- `GET /` health
- `POST /` executes backfill job
- `POST /run` executes backfill job (alias)
- run modes:
  - `local_to_aqilevels` (Phase 1 implemented)
  - `obs_aqi_to_r2` (implemented: dry-run planning + non-dry R2 export for both `observations` and `aqilevels` domains)
  - `source_to_all` (Phase 1 stubbed)
- `local_to_aqilevels` behavior:
  - UTC-day backfill with newest day first
  - optional connector filter
  - source priority: ingest -> obs_aqidb -> explicit R2 History fallback
  - default skip if checkpoint already complete; `force_replace` bypasses skip
  - dry-run support with write estimates
- minimal run/day/checkpoint ledger wiring in `uk_aq_ops` (if schema is applied)

### 10) Cache Proxy Worker (`workers/uk_aq_cache_proxy/src/index.ts`)

- Cloudflare cache/auth proxy for website AQ read routes.
- Session endpoints:
  - `POST /api/aq/session/start`
  - `POST /api/aq/session/end`
- Proxied AQ routes:
  - `/api/aq/latest`
  - `/api/aq/timeseries`
  - `/api/aq/stations-chart`
  - `/api/aq/stations`
  - `/api/aq/la-hex`
  - `/api/aq/pcon-hex`
- Upstream auth header:
  - injects `X-UK-AQ-Upstream-Auth` using `UK_AQ_EDGE_UPSTREAM_SECRET`.

## Local run

```bash
npm install
npm run start:prune
npm run start:flush
npm run start:observs-partitions
npm run start:aqilevels-retention
deno run --allow-env --allow-net --allow-read --allow-write --allow-run workers/uk_aq_backfill_cloud_run/run_service.ts
```

Type-check quick validation:

```bash
npm run check
```

Download one R2 History UTC day (manifest-first, no Supabase reads):

```bash
node scripts/backup_r2/download_day.mjs --day 2026-02-20 --out ./tmp/backup_download
node scripts/backup_r2/download_day.mjs --day 2026-02-20 --connector 4 --out ./tmp/backup_download
```

Run manifest-aware incremental R2 History -> Dropbox backup:

```bash
node scripts/backup_r2/sync_history_to_dropbox.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --dest-root "uk_aq_dropbox:CIC-Test/R2_history_backup"
```

Notes:
- Dropbox layout mirrors R2 History layout exactly:
  - `history/v1/observations/day_utc=YYYY-MM-DD/...`
  - `history/v1/aqilevels/day_utc=YYYY-MM-DD/...`
- No `YYYY/YYYY-MM` reshaping is applied.
- Checkpoint file default:
  - `_ops/checkpoints/r2_history_backup_state_v1.json`

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

- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/ingest_db/ingest_db_ops_rpcs.sql` (ingest DB)
- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql` (obs_aqidb / `uk_aq_observs`)

## Deployment workflows

- `/.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_observs_outbox_flush_service_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_aqilevels_retention_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_db_size_logger_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_station_aqi_hourly_cloud_run_deploy.yml`
- `/.github/workflows/uk_aq_r2_history_dropbox_backup.yml`
- `/.github/workflows/uk_aq_cache_proxy_deploy.yml`

## Setup docs

- `system_docs/uk-aq-ingestdb-prune.md`
- `system_docs/uk-aq-observs-outbox-flush-service.md`
- `system_docs/uk-aq-observs-partition-maintenance.md`
- `system_docs/uk-aq-aqilevels-retention.md`
- `system_docs/uk-aq-station-aqi-hourly.md`
- `system_docs/uk-aq-backfill-cloud-run.md`
- `system_docs/uk-aq-r2-history-dropbox-backup.md`
- `system_docs/uk-aq-cache-proxy.md`
