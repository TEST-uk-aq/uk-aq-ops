# uk_aq DB size logger Cloud Run service

This Cloud Run service samples and persists hourly size metrics for:

- Databases: `ingestdb`, `obs_aqidb`
- R2 History domains: `observations`, `aqilevels`

Schema-size metrics for `obs_aqidb` are now primarily written by a separate
Supabase `pg_cron` job in `obs_aqidb` (`uk_aq_obs_aqidb_schema_size_metrics_hourly`).
Cloud Run schema-size sampling is disabled by default and kept only as an
optional fallback/manual path.

DB size metrics are written via `uk_aq_public.uk_aq_rpc_db_size_metric_upsert`.
R2 domain metrics are written via `uk_aq_public.uk_aq_rpc_r2_domain_size_metric_upsert`.
If Cloud Run schema sampling is explicitly enabled, schema metrics are written via
`uk_aq_public.uk_aq_rpc_schema_size_metric_upsert`.

Write targets:
- DB size metrics -> each database (`ingestdb`, `obs_aqidb`)
- R2 domain metrics (`observations`, `aqilevels`) -> `ingestdb`
- Schema metrics (`uk_aq_observs`, `uk_aq_aqilevels`) -> `obs_aqidb` via local `pg_cron`
  by default, or via Cloud Run only when explicitly enabled

Primary scheduling is now Supabase `pg_cron` in each DB (local sample/write).
Cloud Run service remains available for manual/on-demand runs or fallback scheduling.
When both Cloud Run DB-size and schema-size flags are disabled, the service can
still run only the R2 domain-size path.
If one DB source call fails (for example, statement timeout), the run records a warning
and continues; it only fails when both DB sources fail in the same run.

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
- `UK_AQ_DB_SIZE_CLOUD_RUN_ENABLED` (default `true`; set `false` to skip Cloud Run DB-size sampling/upserts and leave DB-size to local `pg_cron`)
- `UK_AQ_DB_SIZE_RETENTION_DAYS` (default `120`)
- `UK_AQ_DB_SIZE_RPC_RETRIES` (default `3`)
- `UK_AQ_SCHEMA_SIZE_SOURCE_RPC` (default `uk_aq_rpc_schema_size_bytes`)
- `UK_AQ_SCHEMA_SIZE_SOURCE_TIMEOUT_MS` (default `120000`)
- `UK_AQ_SCHEMA_SIZE_CLOUD_RUN_ENABLED` (default `false`; set `true` only to re-enable Cloud Run schema-size sampling/upserts)
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
