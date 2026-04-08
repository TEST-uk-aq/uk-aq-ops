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

