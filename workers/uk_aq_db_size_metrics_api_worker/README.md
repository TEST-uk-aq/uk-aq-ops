# uk_aq DB size metrics API Worker

Cloudflare Worker that exposes one API endpoint for dashboard DB-size trend reads.

Endpoint:

- `GET /v1/db-size-metrics`
- aliases: `GET /db-size-metrics`, `GET /`

Query params:

- `lookback_days` (optional, default `28`, clamped `1..120`)
- `token` (optional; only used if `UK_AQ_DB_SIZE_API_TOKEN` is configured)

Response shape:

- `generated_at`
- `lookback_days`
- `db_size_metrics` (same row shape as `uk_aq_public.uk_aq_db_size_metrics_hourly`)
- `schema_size_metrics` (same row shape as `uk_aq_public.uk_aq_schema_size_metrics_hourly`)
- `r2_domain_size_metrics` (same row shape as `uk_aq_public.uk_aq_r2_domain_size_metrics_hourly`)
- `oldest_by_label`
- `db_size_metrics_error`
- `schema_size_metrics_error`
- `r2_domain_size_metrics_error`

Behavior:

- Reads from each configured DB view `uk_aq_public.uk_aq_db_size_metrics_hourly`:
  - ingest (`SUPABASE_URL` + `SB_SECRET_KEY`)
  - obs_aqidb (`OBS_AQIDB_SUPABASE_URL` + `OBS_AQIDB_SECRET_KEY`)
- Merges and sorts rows by `bucket_hour`.
- Preserves null `oldest_observed_at` values as null (dashboard can render placeholder `>=--/--/----`).
- Reads schema/R2 size rows from ingest public views:
  - `uk_aq_public.uk_aq_schema_size_metrics_hourly`
  - `uk_aq_public.uk_aq_r2_domain_size_metrics_hourly`

## Required secrets / vars

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

Optional:

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `UK_AQ_DB_SIZE_API_TOKEN` (if set, caller must send `Authorization: Bearer <token>`)

## Deploy (manual)

```bash
cd workers/uk_aq_db_size_metrics_api_worker
wrangler deploy
```

Set secrets:

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SB_SECRET_KEY
wrangler secret put OBS_AQIDB_SUPABASE_URL
wrangler secret put OBS_AQIDB_SECRET_KEY
wrangler secret put UK_AQ_DB_SIZE_API_TOKEN
```
