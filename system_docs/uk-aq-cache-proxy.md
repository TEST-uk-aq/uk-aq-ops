# UK AQ Cache Proxy Worker

Repo owner: `uk-aq-ops`
Worker path: `workers/uk_aq_cache_proxy/src/index.ts`
Deploy workflow: `.github/workflows/uk_aq_cache_proxy_deploy.yml`

## Purpose

Cloudflare edge cache + session/auth proxy for website AQ read routes.

- Provides browser session start/end endpoints.
- Applies origin checks, Turnstile-gated session minting, and cache policy.
- Proxies AQ read routes to Supabase edge functions.
- Injects upstream shared-secret header for edge-function allowlist.

## Routes

Session endpoints:

- `POST /api/aq/session/start`
- `POST /api/aq/session/end`

Read endpoints:

- `/api/aq/latest` -> `uk_aq_latest`
- `/api/aq/timeseries` -> `uk_aq_timeseries`
  - `v=2` path (gated by `UK_AQ_TIMESERIES_V2_ENABLED` + `UK_AQ_TIMESERIES_PROXY_FIRST`) now runs R2-first stitching in cache proxy:
    - fetches observations history first from `UK_AQ_OBSERVS_HISTORY_R2_API_URL`
    - computes tail from actual `r2_coverage_end`
    - fetches ingest tail/slices from `uk_aq_timeseries` origin
    - dedupes by `observed_at` with R2-preferred precedence by default
  - returns v2 envelope + metadata (`source_mode`, `r2_coverage_end`, `ingest_tail_start`, `has_gap`, row counts)
  - response headers include:
    - `X-UK-AQ-Timeseries-Source-Mode`
    - `X-UK-AQ-R2-Coverage-End`
    - `X-UK-AQ-Ingest-Tail-Start`
    - `X-UK-AQ-R2-Rows`
    - `X-UK-AQ-Ingest-Rows`
    - `X-UK-AQ-Has-Gap`
    - `X-UK-AQ-Cache-Key-Version: ts-v2`
- `/api/aq/stations-chart` -> `uk_aq_stations_chart`
- `/api/aq/stations` -> `uk_aq_stations`
- `/api/aq/la-hex` -> `uk_aq_la_hex`
- `/api/aq/pcon-hex` -> `uk_aq_pcon_hex`
- `/api/aq/aqi-history` -> external AQI history R2 API URL (`UK_AQ_AQI_HISTORY_R2_API_URL`)
  - canonicalizes AQI-history requests to `format=compact` unless the client explicitly asks for `format=objects` or `format=tsv`
  - cache policy is dynamic by requested end time:
    - requests ending within the last 24 hours use the short realtime profile
    - requests ending more than 24 hours ago use a long immutable-history profile
  - long-range request canonicalization:
    - for ranges >= 72 hours, `from_utc/start_utc` and `to_utc/end_utc` are rounded down to the hour before cache lookup/upstream fetch
    - this reduces cache-key churn from second-level timestamp differences on hourly AQI charts
  - upstream retry policy:
    - general read routes: up to 2 attempts
    - AQI history route: up to 6 attempts with linear backoff
    - retry statuses: `502`, `503`, `504`
- `/api/aq/postcode_lookup` -> external postcode lookup R2 API URL (`UK_AQ_POSTCODE_LOOKUP_R2_API_URL`)
  - uses the long-lived postcode cache profile (`max-age=86400`)
- `/api/aq/postcode_suggest` -> external postcode suggest R2 API URL (`UK_AQ_POSTCODE_SUGGEST_R2_API_URL`)
  - uses the long-lived postcode cache profile (`max-age=86400`)
- `/api/aq/latest-snapshot` -> external latest snapshot R2 API URL (`UK_AQ_LATEST_SNAPSHOT_R2_API_URL`)
  - serves deterministic latest snapshot objects from R2 (`pollutant/window/network_group`)
  - uses realtime cache profile (`max-age=60`)

## Required GitHub env/secret targets

Variables:

- `SUPABASE_URL`
- `UK_AQ_AQI_HISTORY_R2_API_URL`
- `UK_AQ_LATEST_SNAPSHOT_R2_API_URL`
- `UK_AQ_POSTCODE_LOOKUP_R2_API_URL`
- `UK_AQ_POSTCODE_SUGGEST_R2_API_URL`
- `UK_AQ_OBSERVS_HISTORY_R2_API_URL`
- `UK_AQ_CACHE_ALLOWED_ORIGINS`
- `UK_AQ_CACHE_WORKER_NAME` (recommended; e.g. `uk-aq-cache-test` / `uk-aq-cache-live`)
- `UK_AQ_EDGE_SESSION_MAX_AGE_SECONDS` (optional)
- `UK_AQ_LOCAL_DEV_BYPASS_ENABLED` (optional; set `true`/`1` in test only, leave unset in live)
- `UK_AQ_TIMESERIES_V2_ENABLED` (optional; defaults false)
- `UK_AQ_TIMESERIES_PROXY_FIRST` (optional; defaults false)
- `UK_AQ_TIMESERIES_R2_FIRST` (optional; defaults false)
- `UK_AQ_TIMESERIES_ALLOW_INGEST_OVERWRITE` (optional; defaults false)
- `UK_AQ_TIMESERIES_MAX_WINDOW_DAYS` (optional; default `90`)
- `UK_AQ_TIMESERIES_MAX_R2_OBJECTS_PER_REQUEST` (optional; default `120`)
- `UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS` (optional; default `168`)
- `UK_AQ_TIMESERIES_INCREMENTAL_OVERLAP_MINUTES` (optional; default `180`)
- `UK_AQ_TIMESERIES_PARTIAL_ON_R2_ERROR` (optional; default `true`)
- `UK_AQ_TIMESERIES_PARTIAL_ON_INGEST_ERROR` (optional; default `false`)
- `UK_AQ_TIMESERIES_RECENT_EDGE_TTL_SECONDS` (optional; default `60`)
- `UK_AQ_TIMESERIES_RECENT_BROWSER_TTL_SECONDS` (optional; default `60`)
- `UK_AQ_TIMESERIES_RECENT_SWR_SECONDS` (optional; default `60`)
- `UK_AQ_TIMESERIES_HISTORICAL_EDGE_TTL_SECONDS` (optional; default `86400`)
- `UK_AQ_TIMESERIES_HISTORICAL_BROWSER_TTL_SECONDS` (optional; default `86400`)
- `UK_AQ_TIMESERIES_HISTORICAL_SWR_SECONDS` (optional; default `86400`)
- `UK_AQ_TIMESERIES_STALE_IF_ERROR_SECONDS` (optional; default `300`)
- `UK_AQ_TIMESERIES_R2_MANIFEST_URL` (optional diagnostics)
- `UK_AQ_TIMESERIES_R2_INDEX_URL` (optional diagnostics)

Secrets:

- `UK_AQ_CACHE_CLOUDFLARE_API_TOKEN`
- `SB_PUBLISHABLE_DEFAULT_KEY`
- `SB_SECRET_KEY` (required for connector lookup in v2 stitch path)
- `UK_AQ_EDGE_ACCESS_TOKEN_SECRET`
- `UK_AQ_EDGE_UPSTREAM_SECRET`
- `UK_AQ_CACHE_BYPASS_SECRET`
- `UK_AQ_TURNSTILE_SECRET_KEY`

Cloudflare account variable:

- `UK_AQ_CACHE_CLOUDFLARE_ACCOUNT_ID`

## Deployment

Workflow `uk_aq_cache_proxy_deploy.yml`:

1. Deploys worker code.
2. Applies worker secrets/vars with `wrangler secret bulk`.
3. Deploys worker code again so latest config is active.
4. Fails fast if cache-specific Cloudflare credentials are missing.
5. Fails fast if required postcode upstream URL variables are missing:
   - `UK_AQ_POSTCODE_LOOKUP_R2_API_URL`
   - `UK_AQ_POSTCODE_SUGGEST_R2_API_URL`

Worker naming:

- Workflow deploy target defaults to `uk-aq-cache-proxy`.
- If `UK_AQ_CACHE_WORKER_NAME` is set, workflow deploys and writes secrets to that exact worker name.

## Notes

- Route binding is managed in Cloudflare (dashboard or Wrangler route config).
- Keep test/prod hostnames and origin allowlists separated by environment.
- Upstream edge functions must validate `X-UK-AQ-Upstream-Auth` with the same `UK_AQ_EDGE_UPSTREAM_SECRET`.
- Same-origin browser requests are accepted even when `Origin` is omitted (fallback uses `Sec-Fetch-Site: same-origin` or same-origin `Referer`).
- Response diagnostics include `X-UK-AQ-Upstream-Attempts` and (when retries were used) `X-UK-AQ-Upstream-Retry`.
- For full latest snapshot pipeline details (Cloud Run builder + latest snapshot R2 API worker + cache proxy handoff), see `system_docs/uk-aq-latest-snapshot.md`.
