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

## Cloudflare routing notes for /api/*

Configure Cloudflare route so that:

- `https://<admin-subdomain>/api/*` -> `uk-aq-ops-dashboard-api` worker

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
- GitHub repo variables for dashboard config generation.
