# UK AQ Ops Dashboard Deployment

## Local run after migration

From repo root:

```bash
node scripts/dashboard/generate_dashboard_config.mjs
local/scripts/run_dashboard_local.sh
local/scripts/run_station_snapshot_local.sh
```

Dashboard URLs (default):

- Scheduler dashboard: `http://127.0.0.1:8045`
- Station snapshot dashboard: `http://127.0.0.1:8046`

Or run both with wrappers:

```bash
./dev_dashboards.sh
./dev_dashboards_stop.sh
```

## Cloudflare Pages deployment

Workflow:

- `.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml`

What it does:

1. Generates `dashboard/assets/config.js` from GitHub variables.
2. Assembles `_pages/` with `dashboard/` and `station_snapshot/`.
3. Deploys static assets to Cloudflare Pages.

Default project vars:

- test: `UK_AQ_OPS_DASHBOARD_PAGES_PROJECT_TEST` (default `uk-aq-ops-dashboard-test`)
- live: `UK_AQ_OPS_DASHBOARD_PAGES_PROJECT_LIVE` (default `uk-aq-ops-dashboard-live`)

Deploy credentials:

- var: `UK_AQ_CF_ACCOUNT_ID_UKAQ`
- secret: `UK_AQ_CF_API_TOKEN_UKAQ`

## Worker deployment

Workflow:

- `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`

What it does:

1. Installs and type-checks `api/worker`.
2. Builds an environment-specific Wrangler config with hostname + zone substitution.
3. Deploys Worker code with Wrangler.
4. Pushes worker secrets for upstream URL/token.
5. Deploys Worker again with updated secret state.

Default route vars:

- zone: `UK_AQ_OPS_ADMIN_ZONE_NAME` (default `ukaq.co.uk`)
- test host: `UK_AQ_OPS_ADMIN_TEST_HOSTNAME` (default `cic-test-uk-aq-admin.ukaq.co.uk`)
- live host: `UK_AQ_OPS_ADMIN_LIVE_HOSTNAME` (default `uk-aq-admin.ukaq.co.uk`)
- test worker name: `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME_TEST` (default `uk-aq-ops-dashboard-api-test`)
- live worker name: `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME_LIVE` (default `uk-aq-ops-dashboard-api-live`)

## Dashboard backend Cloud Run deployment

Workflow:

- `.github/workflows/uk_aq_dashboard_backend_cloud_run_deploy.yml`

What it does:

1. Builds `local/dashboard/server/Dockerfile`.
2. Pushes the image to Artifact Registry.
3. Deploys `local/dashboard/server/uk_aq_dashboard_api.py` to Cloud Run.
4. Prints the Cloud Run service URL in logs.

Current default Cloud Run sizing (overridable by repo vars):

- `SERVICE_CPU=0.25`
- `SERVICE_MEMORY=512Mi`
- `SERVICE_CONCURRENCY=10`
- `SERVICE_MAX_INSTANCES=1`
- `SERVICE_MIN_INSTANCES=0`

R2 metrics auth inputs for backend:

- account id: `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` (fallback `CLOUDFLARE_ACCOUNT_ID`)
- token: `UK_AQ_R2_CLOUDFLARE_API_TOKEN` (fallback `CFLARE_API_READ_TOKEN`)

After deploy:

1. Copy the service URL from workflow logs.
2. Set/update repo variable `DASHBOARD_UPSTREAM_BASE_URL_TEST` and/or `DASHBOARD_UPSTREAM_BASE_URL_LIVE`.
3. Optional: set `DASHBOARD_UPSTREAM_BEARER_TOKEN_TEST` and/or `DASHBOARD_UPSTREAM_BEARER_TOKEN_LIVE`.
4. Re-run `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`.

## Cloudflare account model

Dashboard workflows (Pages + API worker) use:

- var: `UK_AQ_CF_ACCOUNT_ID_UKAQ`
- secret: `UK_AQ_CF_API_TOKEN_UKAQ`

Other workers in this repo still use their existing credential families (`UK_AQ_DOMAIN_CLOUDFLARE_*`, `UK_AQ_R2_CLOUDFLARE_*`, etc.) unless migrated separately.

Domain-class workflows:

- `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`
- `.github/workflows/uk_aq_cache_proxy_deploy.yml`
- `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml`

R2-class workflows:

- `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`
- `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`

## Cloudflare routing notes for /api/*

Configure Cloudflare route so that:

- `https://cic-test-uk-aq-admin.ukaq.co.uk/api/*` -> test worker
- `https://uk-aq-admin.ukaq.co.uk/api/*` -> live worker

Keep dashboard pages and assets served from the root path (`/`).

## Zero Trust notes

- Apply Zero Trust access policy at the admin subdomain level.
- Do not add app-level auth UI in the dashboard front end.

## Validation checklist

Migration validation:

- [ ] Local dashboard runs from ops repo using migrated backend and frontend.
- [ ] Existing cards/panels/controls render in local mode.
- [ ] Local station snapshot runs from ops repo using migrated backend and frontend.

Front-end parity validation:

- [ ] Hosted page keeps same layout and labels as local dashboard.
- [ ] Refresh controls and polling behaviour match existing local behaviour.

API contract validation:

- [ ] Compatibility routes return expected JSON shapes.
- [ ] `/api/status/*` and `/api/history/*` return envelope responses.

End-to-end smoke test:

- [ ] Dashboard loads behind Zero Trust.
- [ ] Browser calls `/api/*` successfully.
- [ ] No service-role keys or other secrets appear in page source or browser network payloads.

## Manual setup required outside repo

- Cloudflare Pages custom domain bindings for the test/live projects.
- Cloudflare Zero Trust policy assignment for admin subdomain.
- Worker secret values (`DASHBOARD_UPSTREAM_BASE_URL_TEST`/`_LIVE`, optional bearer token variants).
- Cloud Run dashboard backend deploy (workflow above) before setting dashboard upstream URLs.
- GitHub vars/secrets for Worker deploy credentials:
  - `UK_AQ_CF_ACCOUNT_ID_UKAQ` / `UK_AQ_CF_API_TOKEN_UKAQ`
- GitHub repo variables for dashboard config generation.
