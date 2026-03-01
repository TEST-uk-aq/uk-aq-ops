# uk-aq-ops

Cloud Run operations services for:

- verifying and pruning old rows from ingest after content parity checks with history
- flushing the main DB history outbox into history DB
- maintaining history DB daily partitions, index policy, and retention drops

## Services

### 1) Ingest prune service (`src/server.mjs`)

What it does:
- Runs via `POST /run`.
- Computes hourly fingerprints in both DBs via RPC only.
- Compares buckets by `(connector_id, hour_start)`.
- Deletes only buckets that fully match in count + fingerprint.
- In standard mode, repairs mismatches by enqueueing to outbox, flushes in-process, rechecks mismatches, then deletes buckets that became verified.
- Defaults to dry-run mode.

Required environment variables:
- `SUPABASE_URL` (ingest DB URL)
- `HISTORY_SUPABASE_URL` (history DB URL)
- `SB_SECRET_KEY` (ingest service role key)
- `HISTORY_SECRET_KEY` (history service role key)

Optional environment variables:
- `INGESTDB_PRUNE_DRY_RUN` (default `true`)
- `INGESTDB_RETENTION_DAYS` (default `7`)
- `MAX_HOURS_PER_RUN` (default `48`)
- `DELETE_BATCH_SIZE` (default `50000`)
- `MAX_DELETE_BATCHES_PER_HOUR` (default `10`)
- `REPAIR_ONE_MISMATCH_BUCKET` (default `true`; dry-run pilot: enqueue+flush one mismatch bucket)
- `REPAIR_BUCKET_OUTBOX_CHUNK_SIZE` (default `1000`)
- `FLUSH_CLAIM_BATCH_LIMIT` (default `20`)
- `MAX_FLUSH_BATCHES` (default `30`)
- `UK_AQ_DROPBOX_ROOT` (optional Dropbox root prefix)
- `UK_AIR_ERROR_DROPBOX_FOLDER` (optional, default `/error_log`)
- `UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist gate for Dropbox error uploads)
- `PORT` (default `8080`)

Aliases are supported for URLs: `SB_URL`, `HISTORY_URL`.

### 2) History outbox flush service (`src/history_outbox_flush_service.mjs`)

What it does:
- Runs via `POST /run`.
- Claims outbox batches from ingest DB.
- Upserts to history DB via RPC.
- Writes daily receipt rows.
- Resolves outbox rows.

See setup guide:
- `system_docs/setup/uk-aq-history-outbox-flush-service.md`

### 3) History partition maintenance service (`src/history_partition_maintenance_service.mjs`)

What it does:
- Runs via `POST /run`.
- Ensures UTC-day partitions exist through `today + 7 days`.
- Enforces hot/cold index policy (hot = today + previous 2 UTC days).
- Logs diagnostics for `uk_aq_history.observations_default`.
- Computes retention cutoff using Europe/London local-day semantics (`31 complete local days + today`) and drops only eligible UTC-day partitions.
- Applies backup gate before each partition drop:
  - HEAD marker `uk_aq_history/observations/date=YYYY-MM-DD/_SUCCESS`
  - fallback list-prefix requiring at least one `.parquet`
  - if backup is not confirmed, skip drop and log `SKIP DROP — backup not confirmed`

Required environment variables:
- `HISTORY_SUPABASE_URL` (or `HISTORY_URL`)
- `HISTORY_SECRET_KEY`

Optional partition controls:
- `HISTORY_PARTITIONS_FUTURE_DAYS` (default `7`)
- `HISTORY_PARTITIONS_HOT_DAYS` (default `3`)
- `HISTORY_COMPLETE_LOCAL_DAYS` (default `31`)
- `HISTORY_DEFAULT_TOP_N` (default `20`)
- `HISTORY_PARTITION_DROP_DRY_RUN` (default `false`)

Optional R2 backup-check envs (placeholder wiring):
- `HISTORY_R2_ENDPOINT` (or `R2_ENDPOINT`)
- `HISTORY_R2_BUCKET` (or `R2_BUCKET`)
- `HISTORY_R2_ACCESS_KEY_ID` (or `R2_ACCESS_KEY_ID`)
- `HISTORY_R2_SECRET_ACCESS_KEY` (or `R2_SECRET_ACCESS_KEY`)
- `HISTORY_R2_REGION` (or `R2_REGION`, default `auto`)
- `HISTORY_R2_OBSERVATIONS_PREFIX` (or `R2_OBSERVATIONS_PREFIX`, default `uk_aq_history/observations`)

See setup guide:
- `system_docs/setup/uk-aq-history-partition-maintenance.md`

## Local run

```bash
npm install
```

Run prune service:

```bash
npm run start:prune
```

Run history outbox flush service:

```bash
npm run start:flush
```

Run history partition maintenance service:

```bash
npm run start:history-partitions
```

## SQL RPC scripts

Apply these scripts in Supabase SQL editor:

- `sql/ingest_db_ops_rpcs.sql` (ingest DB)
- `sql/history_db_ops_rpcs.sql` (history DB)

## Deployment and scheduler setup

See:

- `system_docs/setup/uk-aq-ingestdb-prune.md`
- `system_docs/setup/uk-aq-history-outbox-flush-service.md`
- `system_docs/setup/uk-aq-history-partition-maintenance.md`

## GitHub deploy workflows

- Prune service: `.github/workflows/uk_aq_ingestdb_prune_cloud_run_deploy.yml`
- History outbox flush service: `.github/workflows/uk_aq_history_outbox_flush_service_cloud_run_deploy.yml`
- History partition maintenance service: `.github/workflows/uk_aq_history_partition_maintenance_cloud_run_deploy.yml`
