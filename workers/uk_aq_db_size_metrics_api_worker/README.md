# uk_aq DB + R2 metrics API Worker

Cloudflare Worker (`uk-aq-db-r2-metrics-api`) that exposes:

- DB size metrics API for dashboard trend reads.
- R2 History committed-day API (manifest-based).

Endpoint:

- `GET /v1/db-size-metrics`
- aliases: `GET /db-size-metrics`, `GET /`
- `GET /v1/r2-history-days`
- alias: `GET /r2-history-days`
- `GET /v1/r2-history-counts`
- alias: `GET /r2-history-counts`

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
- `sources.<domain>` (`cloudflare_r2_history_index` or `cloudflare_r2_manifest_scan`)

R2 history-counts query params:

- `from_day` (`YYYY-MM-DD`, optional; defaults to last 31 days ending today UTC)
- `to_day` (`YYYY-MM-DD`, optional; defaults to today UTC)
- `grain` (`day` or `month`, default `day`)
- `connector_ids` (optional CSV filter, for example `1,3,6,7`)
- `token` (optional; only used if `UK_AQ_DB_SIZE_API_TOKEN` is configured)

R2 history-counts response shape:

- `generated_at`
- `bucket`
- `from_day_utc`
- `to_day_utc`
- `grain`
- `connector_ids_requested`
- `bucket_count`
- `range_day_count`
- `index_prefix`
- `index_keys.observations`
- `index_keys.aqilevels`
- `connectors[]`
  - `connector_id`
  - `observations_total_rows`
  - `aqilevels_total_rows`
  - `total_rows`
  - `buckets[]`
    - `bucket_key`
    - `bucket_start_day_utc`
    - `bucket_end_day_utc`
    - `calendar_day_count`
    - `observations_rows`
    - `observations_present_days`
    - `observations_avg_rows_per_day`
    - `aqilevels_rows`
    - `aqilevels_present_days`
    - `aqilevels_avg_rows_per_day`
    - `total_rows`
    - `total_avg_rows_per_day`

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
- PostgREST reads are paginated (`limit`/`offset`, 1000 rows per page) so larger lookback windows still include newest buckets when the project row cap is 1000.
- For `/v1/r2-history-days`, first tries derived R2 history index files:
  - `history/_index/observations_latest.json`
  - `history/_index/aqilevels_latest.json`
  - index prefix is configurable via `UK_AQ_R2_HISTORY_INDEX_PREFIX`
- For `/v1/r2-history-counts`, reads the same derived R2 history index files and aggregates
  connector row counts by day or month entirely in-memory.
- If an index file is missing or invalid for a domain, falls back to low-subrequest domain day-prefix scan for that domain only:
  - lists `day_utc=YYYY-MM-DD/` common prefixes under the domain;
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
- `UK_AQ_R2_HISTORY_INDEX_PREFIX` (default `history/_index`)

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
