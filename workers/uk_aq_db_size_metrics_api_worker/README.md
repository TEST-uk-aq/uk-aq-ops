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
- `oldest_by_label`
- `db_size_metrics_error`

Behavior:

- Reads from each configured DB view `uk_aq_public.uk_aq_db_size_metrics_hourly`:
  - ingest (`SUPABASE_URL` + `SB_SECRET_KEY`)
  - history (`HISTORY_SUPABASE_URL` + `HISTORY_SECRET_KEY`)
  - aggdaily (optional: `AGGDAILY_SUPABASE_URL` + `AGGDAILY_SECRET_KEY`)
- Merges and sorts rows by `bucket_hour`.
- Preserves null `oldest_observed_at` values as null (dashboard can render placeholder `>=--/--/----`).

## Required secrets / vars

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `HISTORY_SUPABASE_URL`
- `HISTORY_SECRET_KEY`

Optional:

- `AGGDAILY_SUPABASE_URL`
- `AGGDAILY_SECRET_KEY` (required if `AGGDAILY_SUPABASE_URL` is set)
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
wrangler secret put HISTORY_SUPABASE_URL
wrangler secret put HISTORY_SECRET_KEY
wrangler secret put AGGDAILY_SUPABASE_URL
wrangler secret put AGGDAILY_SECRET_KEY
wrangler secret put UK_AQ_DB_SIZE_API_TOKEN
```
