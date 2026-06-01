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
- optional test/live overrides used by deploy workflow:
  - `UKAQ_ENV_NAME_TEST`, `UKAQ_ENV_NAME_LIVE`
  - `UKAQ_API_BASE_URL_TEST`, `UKAQ_API_BASE_URL_LIVE`
  - `UKAQ_DASHBOARD_TITLE_TEST`, `UKAQ_DASHBOARD_TITLE_LIVE`
  - `UKAQ_DASHBOARD_SUBTITLE_TEST`, `UKAQ_DASHBOARD_SUBTITLE_LIVE`
  - `UKAQ_DEFAULT_REFRESH_SECONDS_TEST`, `UKAQ_DEFAULT_REFRESH_SECONDS_LIVE`

These values are safe to expose in shipped client assets.

## Server-side worker config and secrets

Worker runtime:

- `DASHBOARD_UPSTREAM_BASE_URL` (required)
- `DASHBOARD_UPSTREAM_BEARER_TOKEN` (optional)
- optional test/live overrides used by deploy workflow:
  - `DASHBOARD_UPSTREAM_BASE_URL_TEST`, `DASHBOARD_UPSTREAM_BASE_URL_LIVE`
  - `DASHBOARD_UPSTREAM_BEARER_TOKEN_TEST`, `DASHBOARD_UPSTREAM_BEARER_TOKEN_LIVE`

Store worker secrets in Cloudflare Worker secrets.

Dashboard upstream backend runtime (wherever hosted):

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
  - `DROPBOX_APP_KEY`
  - `DROPBOX_APP_SECRET`
  - `DROPBOX_REFRESH_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CFLARE_API_READ_TOKEN`

## Dashboard deploy credentials (GitHub Actions)

Dashboard Pages + dashboard API worker workflows use:

- var: `UK_AQ_CF_ACCOUNT_ID_UKAQ`
- secret: `UK_AQ_CF_API_TOKEN_UKAQ`

Dashboard routing/project vars:

- `UK_AQ_OPS_ADMIN_ZONE_NAME`
- `UK_AQ_OPS_ADMIN_TEST_HOSTNAME`
- `UK_AQ_OPS_ADMIN_LIVE_HOSTNAME`
- `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME_TEST`
- `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME_LIVE`
- `UK_AQ_OPS_DASHBOARD_PAGES_PROJECT_TEST`
- `UK_AQ_OPS_DASHBOARD_PAGES_PROJECT_LIVE`

Other repo workers still use their existing credential families (`UK_AQ_DOMAIN_CLOUDFLARE_*`, `UK_AQ_R2_CLOUDFLARE_*`, etc.).

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

- Generate config in GitHub Actions using test vars/overrides.
- Point test worker to `DASHBOARD_UPSTREAM_BASE_URL_TEST` (or fallback base var).

Live:

- Generate config in GitHub Actions using live vars/overrides.
- Point live worker to `DASHBOARD_UPSTREAM_BASE_URL_LIVE` (or fallback base var).
