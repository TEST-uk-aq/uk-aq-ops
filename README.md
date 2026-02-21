# uk-aq-ops

Cloud Run operations services for:

- verifying and pruning old rows from ingest after content parity checks with history
- flushing the main DB history outbox into history DB

## What this service does

- Runs via `POST /run` (for Cloud Scheduler).
- Computes hourly fingerprints in both DBs via RPC only.
- Compares buckets by `(connector_id, hour_start)`.
- Deletes only buckets that fully match in count + fingerprint.
- In standard mode, repairs mismatches by enqueueing to outbox, flushes in-process, rechecks mismatches, then deletes buckets that became verified.
- Defaults to dry-run mode.

## Runtime environment

Required environment variables:

- `SUPABASE_URL` (ingest DB URL)
- `HISTORY_SUPABASE_URL` (history DB URL)
- `SB_SECRET_KEY` (ingest service role key)
- `HISTORY_SECRET_KEY` (history service role key)

Optional environment variables:

- `DRY_RUN` (default `true`)
- `INGESTDB_RETENTION_DAYS` (default `7`)
- `MAX_HOURS_PER_RUN` (default `48`)
- `DELETE_BATCH_SIZE` (default `50000`)
- `MAX_DELETE_BATCHES_PER_HOUR` (default `10`)
- `REPAIR_ONE_MISMATCH_BUCKET` (default `true`; dry-run pilot: enqueue+flush one mismatch bucket)
- `REPAIR_BUCKET_OUTBOX_CHUNK_SIZE` (default `1000`)
- `FLUSH_CLAIM_BATCH_LIMIT` (default `20`)
- `MAX_FLUSH_BATCHES` (default `30`)
- `PORT` (default `8080`)

Aliases are also supported for URLs: `SB_URL`, `HISTORY_URL`.

## Endpoints

- `GET /healthz`
- `POST /run`

Query params for `POST /run`:

- `dryRun=true|false`
- `retentionDays=<int>`
- `maxHours=<int>`
- `deleteBatchSize=<int>`
- `maxDeleteBatchesPerHour=<int>`
- `repairOneMismatchBucket=true|false`
- `repairChunkSize=<int>`
- `flushClaimBatchLimit=<int>`
- `maxFlushBatches=<int>`

## Local run

```bash
npm install
npm run start
```

Run prune service explicitly:

```bash
npm run start:prune
```

Run history outbox flush service:

```bash
npm run start:flush
```

Dry-run example:

```bash
curl -X POST "http://localhost:8080/run?dryRun=true"
```

## SQL RPC scripts

Apply these scripts in Supabase SQL editor:

- `sql/ingest_db_ops_rpcs.sql`
- `sql/history_db_ops_rpcs.sql`

## Deployment and scheduler setup

See:

- `system_docs/setup/uk-aq-ingestdb-prune.md`
- `system_docs/setup/uk-aq-history-outbox-flush-service.md`

## GitHub deploy workflow

Workflow file: `.github/workflows/uk_aq_ingestdb_prune_cloud_run_deploy.yml`

It uses the same deploy auth pattern as ingest:

- `GCP_WORKLOAD_IDENTITY_PROVIDER` + `GCP_SERVICE_ACCOUNT` (recommended)
- or fallback `GCP_SA_KEY` secret

Default runtime service account is `uk-aq-ops-job@<GCP_PROJECT_ID>.iam.gserviceaccount.com` unless `GCP_OPS_PRUNE_RUNTIME_SERVICE_ACCOUNT` is set.

History outbox flush service workflow:

- `.github/workflows/uk_aq_history_outbox_flush_service_cloud_run_deploy.yml`
