# UK AQ Ops Dashboard Config

## Front-end browser-safe config

Generated file:

- `dashboard/assets/config.js`

Generation script:

- `scripts/dashboard/generate_dashboard_config.mjs`

Browser-safe variables:

- `UKAQ_ENV_NAME`
- `UKAQ_API_BASE_URL` (typically `/api`)
- `UKAQ_DASHBOARD_TITLE`
- `UKAQ_DASHBOARD_SUBTITLE`
- `UKAQ_DEFAULT_REFRESH_SECONDS`

These values are safe to expose in shipped client assets.

## Server-side worker config and secrets

Worker runtime:

- `DASHBOARD_UPSTREAM_BASE_URL` (required)
- `DASHBOARD_UPSTREAM_BEARER_TOKEN` (optional)

Store worker secrets in Cloudflare Worker secrets.

Dashboard backend Cloud Run runtime:

- required:
  - `SUPABASE_URL`
  - `SB_SECRET_KEY`
  - `OBS_AQIDB_SUPABASE_URL`
  - `OBS_AQIDB_SECRET_KEY`
- commonly used:
  - `UK_AQ_DB_SIZE_API_URL`
  - `UK_AQ_DB_SIZE_API_TOKEN` (optional; for external DB size API auth)
  - `DASHBOARD_UPSTREAM_BEARER_TOKEN` (optional; when set, `/api/*` requires bearer auth)
- optional:
  - `UK_AQ_R2_HISTORY_DAYS_API_URL`
  - `UK_AQ_R2_HISTORY_COUNTS_API_URL`
  - `UK_AQ_R2_HISTORY_DAYS_API_TOKEN`
  - `UK_AQ_R2_HISTORY_COUNTS_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CFLARE_API_READ_TOKEN`

## Worker deploy credentials (GitHub Actions)

Option A split used in this repo:

- Domain workers:
  - var: `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID`
  - secret: `UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN`
- R2 workers:
  - var: `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID`
  - secret: `UK_AQ_R2_CLOUDFLARE_API_TOKEN`

Recommended worker-name vars for test/live side-by-side deployments:

- `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME`
- `UK_AQ_CACHE_WORKER_NAME`
- `UK_AQ_DB_R2_METRICS_API_WORKER_NAME`
- `UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME`
- `UK_AQ_AQI_HISTORY_R2_API_WORKER_NAME`

## What belongs where

Browser config (`config.js`):

- display labels
- API base path
- refresh defaults

Worker/server config:

- upstream service URLs
- bearer tokens
- Supabase service role keys
- R2 credentials
- any write-capable or privileged credentials

## Local vs test vs live notes

Local:

- Use `dashboard/assets/config.js` generated locally.
- Typical `apiBaseUrl` is `/api`.
- Run local backend with `local/scripts/run_dashboard_local.sh`.

Test:

- Generate config in GitHub Actions using test repo variables.
- Point Worker to test upstream backend.

Live:

- Generate config in live repo using live variables.
- Point Worker to live upstream backend.
