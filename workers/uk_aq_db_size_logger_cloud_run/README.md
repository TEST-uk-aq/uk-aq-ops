# uk_aq DB size logger Cloud Run service

This Cloud Run service samples and persists hourly size metrics for:

- DB clusters: `ingestdb`, `obs_aqidb`
- obs_aqidb schemas: `uk_aq_observs`, `uk_aq_aqilevels`
- R2 History domains: `observations`, `aqilevels`

DB cluster metrics are written via `uk_aq_public.uk_aq_rpc_db_size_metric_upsert`.
Schema and R2 domain metrics are written via
`uk_aq_public.uk_aq_rpc_schema_size_metric_upsert` and
`uk_aq_public.uk_aq_rpc_r2_domain_size_metric_upsert`.

Write targets:
- DB cluster metrics -> each cluster (`ingestdb`, `obs_aqidb`)
- Schema metrics (`uk_aq_observs`, `uk_aq_aqilevels`) -> `obs_aqidb`
- R2 domain metrics (`observations`, `aqilevels`) -> `ingestdb`

Primary scheduling is now Supabase `pg_cron` in each DB (local sample/write).
Cloud Run service remains available for manual/on-demand runs or fallback scheduling.

## Required env vars / secrets

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

## Optional env vars

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `UK_AQ_DB_SIZE_RPC` (default `uk_aq_rpc_database_size_bytes`)
- `UK_AQ_DB_SIZE_UPSERT_RPC` (default `uk_aq_rpc_db_size_metric_upsert`)
- `UK_AQ_DB_SIZE_CLEANUP_RPC` (default `uk_aq_rpc_db_size_metric_cleanup`)
- `UK_AQ_DB_SIZE_RETENTION_DAYS` (default `120`)
- `UK_AQ_DB_SIZE_RPC_RETRIES` (default `3`)
- `UK_AQ_SCHEMA_SIZE_SOURCE_RPC` (default `uk_aq_rpc_schema_size_bytes`)
- `UK_AQ_SCHEMA_SIZE_UPSERT_RPC` (default `uk_aq_rpc_schema_size_metric_upsert`)
- `UK_AQ_SCHEMA_SIZE_CLEANUP_RPC` (default `uk_aq_rpc_schema_size_metric_cleanup`)
- `UK_AQ_SCHEMA_SIZE_RETENTION_DAYS` (default `120`)
- `UK_AQ_R2_DOMAIN_SIZE_UPSERT_RPC` (default `uk_aq_rpc_r2_domain_size_metric_upsert`)
- `UK_AQ_R2_DOMAIN_SIZE_CLEANUP_RPC` (default `uk_aq_rpc_r2_domain_size_metric_cleanup`)
- `UK_AQ_R2_DOMAIN_SIZE_RETENTION_DAYS` (default `120`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` (default `history/v1/observations`)
- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` (default `history/v1/aqilevels`)
- `CFLARE_R2_ENDPOINT` (fallback `R2_ENDPOINT`)
- `CFLARE_R2_BUCKET` (fallback `R2_BUCKET`)
- `CFLARE_R2_REGION` (fallback `R2_REGION`, default `auto`)
- `CFLARE_R2_ACCESS_KEY_ID` (fallback `R2_ACCESS_KEY_ID`)
- `CFLARE_R2_SECRET_ACCESS_KEY` (fallback `R2_SECRET_ACCESS_KEY`)
- `UK_AQ_INGEST_DB_LABEL` (default `ingestdb`)
- `UK_AQ_OBS_AQIDB_DB_LABEL` (default `obs_aqidb`)
