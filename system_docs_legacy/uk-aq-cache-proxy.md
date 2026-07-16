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

Diagnostics endpoints:

- `POST /api/aq/debug-log`
  - accepts structured website debug payloads from `hex_map.html` only after normal origin/session validation
  - uploads JSON server-side to Dropbox under `error_log/YYYY-MM-DD/`
  - normalizes filenames as `uk_aq_error_hex_map_html_YYYYMMDDTHHMMSSZ_<shortid>.json`
  - keeps Dropbox app credentials in the Worker only; the browser receives no Dropbox secrets

Read endpoints:

- `/api/aq/latest` -> `uk_aq_latest`
- `/api/aq/timeseries` -> `uk_aq_timeseries`
  - `v=2` path (gated by `UK_AQ_TIMESERIES_V2_ENABLED` + `UK_AQ_TIMESERIES_PROXY_FIRST`) performs central source routing in the cache proxy
  - `connector_id` is part of the canonical v2 cache key when supplied by the caller
  - caller-supplied `connector_id` is used for R2 observations history reads without any connector lookup
  - if older callers omit `connector_id`, the proxy tries the observations R2 API metadata route (`/v1/timeseries-metadata`) before the compatibility Supabase connector lookup
  - when `UK_AQ_TIMESERIES_R2_FIRST=true` and `UK_AQ_OBSERVS_HISTORY_R2_API_URL` is configured, the proxy requests R2 observations for the full resolved chart range, including recent windows inside the Supabase retention period
  - Supabase/IngestDB is then queried only for ranges not covered by R2 rows or R2 coverage diagnostics, capped by `UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS`; skipped fill ranges are reported in `meta.skipped_ingest_slices`
  - source modes:
    - `r2_only`: R2 observations satisfied the request without a Supabase/IngestDB fill
    - `r2_first_full_range`: recent or mixed-window request satisfied from the full-range R2 read without a Supabase/IngestDB fill
    - `r2_plus_ingest_tail`: R2 rows were used first and Supabase/IngestDB filled only the uncovered tail
    - `r2_plus_ingest_repairs`: R2 rows were used first and Supabase/IngestDB filled missing diagnostic/head slices
    - `ingest_only_fallback`: R2 returned no usable rows and the origin path supplied the response
    - `ingest_only_on_r2_error`: R2 failed and the origin path supplied the response under partial-error fallback rules
  - the proxy does not use ObsAQIDB for observation line data
  - response metadata includes `source_mode`, `used_r2`, `used_supabase`, `connector_id_source`, `used_r2_timeseries_metadata_lookup`, `r2_row_count`, `ingest_row_count`, `response_complete`, `has_gap`, `partial_reasons`, `ingest_slices`, and `skipped_ingest_slices`
  - `source_routing_decision` is returned only when the caller sends `debug=1`
  - incomplete `v=2` responses are returned with `Cache-Control: no-store` and are not written to the Worker cache when origin metadata reports `response_complete=false`, `has_gap=true`, or upstream R2/ingest errors
  - response headers include `X-UK-AQ-Timeseries-Cacheable`, `X-UK-AQ-Timeseries-Source-Mode`, `X-UK-AQ-Used-R2`, `X-UK-AQ-Used-Supabase`, and, when present in origin metadata, `X-UK-AQ-Response-Complete`
  - response headers still include the cache key version and the usual cache headers for the returned payload
- `/api/aq/stations-chart` -> `uk_aq_stations_chart`
- `/api/aq/stations` -> `uk_aq_stations`
- `/api/aq/la-hex` -> `uk_aq_la_hex`
- `/api/aq/pcon-hex` -> `uk_aq_pcon_hex`
- `/api/aq/networks` -> `uk_aq_public_networks`
  - reads the canonical `uk_aq_public.networks` source through the Supabase edge function
  - uses the metadata cache profile (`max-age=60`)
  - returns the v2 public catalog contract with `contract_version: 2` and enabled public-network rows containing `network_id`, `network_code`, `network_label`, `network_type`, and `public_display_enabled: true` where supported by the upstream
  - disabled networks such as OpenAQ remain excluded by the upstream `uk_aq_public_networks` function while `public_display_enabled=false`
  - network and snapshot URLs remain stable; do not add routine cache-buster parameters for normal website traffic
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
    - AQI history route: up to 2 attempts with linear backoff
    - retry statuses: `502`, `503`, `504`
    - AQI history `503` responses with Cloudflare Error 1102 / "Worker exceeded resource limits" HTML are not retried, because retrying repeats the same CPU/R2-heavy upstream work inside the same browser request path
  - in v2 mode, AQI history requests require `pollutant` and are handled R2-first by the AQI history worker across the full requested range; ObsAQIDB is queried only as fill when R2 expected-hour coverage is incomplete or R2 is unavailable
  - the upstream AQI history worker reports R2-only and merged expected-hour coverage separately, bases `response_complete` on merged coverage plus scan/fill errors, and sets `X-UK-AQ-Response-Complete=false` and `Cache-Control: no-store` when incomplete so the cache proxy receives a non-cacheable response
- `/api/aq/postcode_lookup` -> external postcode lookup R2 API URL (`UK_AQ_POSTCODE_LOOKUP_R2_API_URL`)
  - uses the long-lived postcode cache profile (`max-age=86400`)
- `/api/aq/postcode_suggest` -> external postcode suggest R2 API URL (`UK_AQ_POSTCODE_SUGGEST_R2_API_URL`)
  - uses the long-lived postcode cache profile (`max-age=86400`)
- `/api/aq/latest-snapshot` -> external latest snapshot R2 API URL (`UK_AQ_LATEST_SNAPSHOT_R2_API_URL`)
  - serves deterministic latest snapshot objects from R2 (`pollutant/window/network_group`)
  - uses realtime cache profile (`max-age=60`)
  - isolates v2 responses in an internal cache-key namespace without changing
    the stable browser URL
  - requires upstream header `X-UK-AQ-Snapshot-Contract: v2`; mismatches fail
    with `502 latest_snapshot_contract_mismatch` and are not cached

### AQI history cache profiles

- Recent or mixed AQI history requests keep the existing `realtime` cache profile while `UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=false` (the default).
- Recent or mixed AQI history requests use `aqi_history_recent` only when `UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=true`: browser `max-age=300`, edge `s-maxage=3900`, `stale-while-revalidate=0`, and `stale-if-error=300`.
- Explicit AQI history requests ending older than `UK_AQ_AQI_MUTABLE_HOURS` use `aqi_history_immutable` regardless of the hourly-generation flag: browser `max-age=86400`, edge `s-maxage=86400`, `stale-while-revalidate=86400`, and `stale-if-error=604800`.
- When `UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=true`, recent/mixed AQI cache keys receive an internal UTC-hour generation component that is stripped before upstream fetches.
- AQI proxy responses expose `X-UK-AQ-AQI-Cache-Scope` (`recent_legacy`, `recent_hourly`, or `immutable`), `X-UK-AQ-AQI-Generation` when applicable, and `X-UK-AQ-AQI-Mutable-Hours` for TEST diagnostics.
- The intended coordinated TEST cutover is `UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=true`, `UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED=false`, and `UK_AQ_AQI_MUTABLE_HOURS=120`.

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
- `UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED` (optional; default `false`)
- `UK_AQ_AQI_MUTABLE_HOURS` (optional; default `120`, bounded `1`-`720`)
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
- `UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX` (optional on the observations R2 API worker; default `history/_index_v2/timeseries`)
- `UK_AQ_TIMESERIES_R2_MANIFEST_URL` (optional diagnostics)
- `UK_AQ_TIMESERIES_R2_INDEX_URL` (optional diagnostics)
- `UK_AQ_WEBSITE_DEBUG_LOG_ENABLED` (website build variable; optional; default `false`)
- `UK_AQ_WEBSITE_DEBUG_LOG_MAX_BODY_BYTES` (Worker variable; optional; default `262144`, clamped `4096`-`1048576`)
- `UK_AQ_DROPBOX_ROOT` (optional; root folder for Dropbox uploads, e.g. `/CIC-Test`)
- `UK_AIR_ERROR_DROPBOX_FOLDER` (optional; normalized to `error_log` for website debug uploads)

Secrets:

- `UK_AQ_CACHE_CLOUDFLARE_API_TOKEN`
- `SB_PUBLISHABLE_DEFAULT_KEY`
- `SB_SECRET_KEY` (required for connector lookup in v2 stitch path)
- `UK_AQ_EDGE_ACCESS_TOKEN_SECRET`
- `UK_AQ_EDGE_UPSTREAM_SECRET`
- `UK_AQ_CACHE_BYPASS_SECRET`
- `UK_AQ_TURNSTILE_SECRET_KEY`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

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


### AQI history row limits and cache safety

`row_limit`/`limit` on AQI history limits only the returned `points`. The upstream worker calculates expected-hour coverage before applying the limit, so intentionally truncated payloads do not create false data-gap diagnostics. Incomplete upstream AQI history responses remain non-cacheable and must not be stored by the proxy.
