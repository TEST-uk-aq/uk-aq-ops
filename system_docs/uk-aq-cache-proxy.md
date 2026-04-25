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
- `/api/aq/stations-chart` -> `uk_aq_stations_chart`
- `/api/aq/stations` -> `uk_aq_stations`
- `/api/aq/la-hex` -> `uk_aq_la_hex`
- `/api/aq/pcon-hex` -> `uk_aq_pcon_hex`
- `/api/aq/aqi-history` -> external AQI history R2 API URL (`UK_AQ_AQI_HISTORY_R2_API_URL`)
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

## Required GitHub env/secret targets

Variables:

- `SUPABASE_URL`
- `UK_AQ_AQI_HISTORY_R2_API_URL`
- `UK_AQ_CACHE_ALLOWED_ORIGINS`
- `UK_AQ_CACHE_WORKER_NAME` (recommended; e.g. `uk-aq-cache-test` / `uk-aq-cache-live`)
- `UK_AQ_EDGE_SESSION_MAX_AGE_SECONDS` (optional)
- `UK_AQ_LOCAL_DEV_BYPASS_ENABLED` (optional; set `true`/`1` in test only, leave unset in live)

Secrets:

- `UK_AQ_CACHE_CLOUDFLARE_API_TOKEN`
- `SB_PUBLISHABLE_DEFAULT_KEY`
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

Worker naming:

- Workflow deploy target defaults to `uk-aq-cache-proxy`.
- If `UK_AQ_CACHE_WORKER_NAME` is set, workflow deploys and writes secrets to that exact worker name.

## Notes

- Route binding is managed in Cloudflare (dashboard or Wrangler route config).
- Keep test/prod hostnames and origin allowlists separated by environment.
- Upstream edge functions must validate `X-UK-AQ-Upstream-Auth` with the same `UK_AQ_EDGE_UPSTREAM_SECRET`.
- Same-origin browser requests are accepted even when `Origin` is omitted (fallback uses `Sec-Fetch-Site: same-origin` or same-origin `Referer`).
- Response diagnostics include `X-UK-AQ-Upstream-Attempts` and (when retries were used) `X-UK-AQ-Upstream-Retry`.
