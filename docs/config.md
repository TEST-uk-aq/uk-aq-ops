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

- `DASHBOARD_UPSTREAM_BASE_URL` (optional; only for upstream proxy mode)
- `DASHBOARD_UPSTREAM_BEARER_TOKEN` (optional)

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
- `UK_AQ_OPS_ADMIN_HOSTNAME`
- `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME`
- `UK_AQ_OPS_DASHBOARD_PAGES_PROJECT`

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

Test/Live:

- Generate config in each repo using that repo's `UKAQ_*` values.
- Keep `DASHBOARD_UPSTREAM_BASE_URL` empty for direct online mode unless you explicitly want upstream proxy mode.
