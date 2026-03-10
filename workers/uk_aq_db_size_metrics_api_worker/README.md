# uk_aq DB + R2 metrics API Worker

Cloudflare Worker (`uk-aq-db-r2-metrics-api`) that exposes:

- DB size metrics API for dashboard trend reads.
- R2 History committed-day API (manifest-based).

Endpoint:

- `GET /v1/db-size-metrics`
- aliases: `GET /db-size-metrics`, `GET /`
- `GET /v1/r2-history-days`
- alias: `GET /r2-history-days`

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

R2 history-days query params:

- `max_days` (optional; default `120`, clamped `0..3660`; `0` = no lookback filter)
- `max_keys` (optional; default `1000`, clamped `100..1000`)
- `strict_manifests` (optional; default `false`; when `true`, verifies top-level day manifest exists with `HEAD` per day)
- `token` (optional; only used if `UK_AQ_DB_SIZE_API_TOKEN` is configured)

R2 history-days response shape:

- `generated_at`
- `bucket`
- `max_days`
- `max_keys`
- `strict_manifests`
- `prefixes.observations`
- `prefixes.aqilevels`
- `domains.observations.days` (`YYYY-MM-DD` day list from R2 domain day prefixes)
- `domains.aqilevels.days`
- `domains.<domain>.min_day_utc`
- `domains.<domain>.max_day_utc`
- `domains.<domain>.day_count`

Behavior:

- Reads from each configured DB view `uk_aq_public.uk_aq_db_size_metrics_hourly`:
  - ingest (`SUPABASE_URL` + `SB_SECRET_KEY`)
  - obs_aqidb (`OBS_AQIDB_SUPABASE_URL` + `OBS_AQIDB_SECRET_KEY`)
- Merges and sorts rows by `bucket_hour`.
- Preserves null `oldest_observed_at` values as null (dashboard can render placeholder `>=--/--/----`).
- Reads schema-size rows from obs_aqidb public view:
  - `uk_aq_public.uk_aq_schema_size_metrics_hourly`
- Reads R2-domain size rows from ingestdb public view:
  - `uk_aq_public.uk_aq_r2_domain_size_metrics_hourly`
- For `/v1/r2-history-days`, defaults to low-subrequest domain day-prefix scan:
  - lists `day_utc=YYYY-MM-DD/` common prefixes under each domain;
  - filters by `max_days` and excludes future dates.
- Optional strict mode (`strict_manifests=true`):
  - verifies `<prefix>/day_utc=YYYY-MM-DD/manifest.json` exists via `HEAD` per day;
  - use for diagnostics when you need strict committed-manifest confirmation.

## Required secrets / vars

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

Optional:

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `UK_AQ_DB_SIZE_API_TOKEN` (if set, caller must send `Authorization: Bearer <token>`)
- `CFLARE_R2_ENDPOINT` (required for `/v1/r2-history-days`)
- `CFLARE_R2_BUCKET` (default bucket for `/v1/r2-history-days`)
- `CFLARE_R2_REGION` (default `auto`)
- `CFLARE_R2_ACCESS_KEY_ID` (required for `/v1/r2-history-days`)
- `CFLARE_R2_SECRET_ACCESS_KEY` (required for `/v1/r2-history-days`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` (default `history/v1/observations`)
- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` (default `history/v1/aqilevels`)

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
wrangler secret put CFLARE_R2_ENDPOINT
wrangler secret put CFLARE_R2_BUCKET
wrangler secret put CFLARE_R2_REGION
wrangler secret put CFLARE_R2_ACCESS_KEY_ID
wrangler secret put CFLARE_R2_SECRET_ACCESS_KEY
wrangler secret put UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX
wrangler secret put UK_AQ_R2_HISTORY_AQILEVELS_PREFIX
```
