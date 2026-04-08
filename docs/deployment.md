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

## GitHub Pages deployment

Workflow:

- `.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml`

What it does:

1. Generates `dashboard/assets/config.js` from GitHub variables.
2. Uploads `dashboard/` as the GitHub Pages artifact.
3. Deploys to GitHub Pages.

## Worker deployment

Workflow:

- `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`

What it does:

1. Installs and type-checks `api/worker`.
2. Deploys Worker code with Wrangler.
3. Pushes worker secrets for upstream URL/token.
4. Deploys Worker again with updated secret state.

## Dashboard backend Cloud Run deployment

Workflow:

- `.github/workflows/uk_aq_dashboard_backend_cloud_run_deploy.yml`

What it does:

1. Builds `local/dashboard/server/Dockerfile`.
2. Pushes the image to Artifact Registry.
3. Deploys `local/dashboard/server/uk_aq_dashboard_local.py` to Cloud Run.
4. Prints the Cloud Run service URL in logs.

After deploy:

1. Copy the service URL from workflow logs.
2. Set/update repo variable `DASHBOARD_UPSTREAM_BASE_URL` to that URL.
3. Re-run `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`.

## Cloudflare account split (Option A)

Use two account credential sets in GitHub:

- Domain workers (route-bound on `*.chronicillnesschannel.co.uk`):
  - var: `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID`
  - secret: `UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN`
- R2 workers (workers with `[[r2_buckets]]` bindings):
  - var: `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID`
  - secret: `UK_AQ_R2_CLOUDFLARE_API_TOKEN`

Domain-class workflows:

- `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`
- `.github/workflows/uk_aq_cache_proxy_deploy.yml`
- `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml`

R2-class workflows:

- `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`
- `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`

Optional worker-name vars (recommended for test/live side-by-side in one account):

- `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME`
- `UK_AQ_CACHE_WORKER_NAME`
- `UK_AQ_DB_R2_METRICS_API_WORKER_NAME`
- `UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME`
- `UK_AQ_AQI_HISTORY_R2_API_WORKER_NAME`

## Cloudflare routing notes for /api/*

Configure Cloudflare route so that:

- `https://<admin-subdomain>/api/*` -> worker name from `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME`
  (default: `uk-aq-ops-dashboard-api`)

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

- Cloudflare route binding for `/api/*`.
- Cloudflare Zero Trust policy assignment for admin subdomain.
- Worker secret values (`DASHBOARD_UPSTREAM_BASE_URL`, optional bearer token).
- Cloud Run dashboard backend deploy (workflow above) before setting `DASHBOARD_UPSTREAM_BASE_URL`.
- GitHub vars/secrets for Worker deploy credentials:
  - `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID` / `UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN`
  - `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` / `UK_AQ_R2_CLOUDFLARE_API_TOKEN`
- GitHub repo variables for dashboard config generation.
