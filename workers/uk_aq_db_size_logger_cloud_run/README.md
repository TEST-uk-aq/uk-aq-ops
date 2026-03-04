# uk_aq DB size logger Cloud Run service

This Cloud Run service samples current Postgres database size for both ingest DB
and history DB once per run, then writes hourly points into
`uk_aq_raw.db_size_metrics_hourly` in ingest DB.
Agg Daily DB sampling is optional and enabled when its URL + secret are supplied.
Each sample also captures the oldest `observed_at` timestamp currently present in
that database's observations table.

Scheduler triggers the service with an authenticated POST request.

## Required env vars / secrets

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `HISTORY_SUPABASE_URL`
- `HISTORY_SECRET_KEY`

## Optional env vars

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `UK_AQ_DB_SIZE_RPC` (default `uk_aq_rpc_database_size_bytes`)
- `UK_AQ_DB_SIZE_UPSERT_RPC` (default `uk_aq_rpc_db_size_metric_upsert`)
- `UK_AQ_DB_SIZE_CLEANUP_RPC` (default `uk_aq_rpc_db_size_metric_cleanup`)
- `UK_AQ_DB_SIZE_RETENTION_DAYS` (default `120`)
- `UK_AQ_DB_SIZE_RPC_RETRIES` (default `3`)
- `UK_AQ_INGEST_DB_LABEL` (default `ingestdb`)
- `UK_AQ_HISTORY_DB_LABEL` (default `historydb`)
- `AGGDAILY_SUPABASE_URL` (optional; enable Agg Daily sampling when set with secret)
- `AGGDAILY_SECRET_KEY` (optional; must be set when `AGGDAILY_SUPABASE_URL` is set)
- `UK_AQ_AGGDAILY_DB_LABEL` (default `aggdailydb`)
