# UK AQ Ops Dashboard Architecture

## System overview

This implementation keeps the existing UK AQ local dashboard UI and behaviour, and adds a hosted path using a static front end plus a proxy API.

Main components:

- `dashboard/` static single-page front end (GitHub Pages)
- `api/worker/` Cloudflare Worker API/proxy (`/api/*`)
- `local/dashboard/server/uk_aq_dashboard_api.py` migrated backend API (source-compatible with existing local dashboard contract)
  - hosted target: Cloud Run service deployed by `.github/workflows/uk_aq_dashboard_backend_cloud_run_deploy.yml`
- `station_snapshot/` local station snapshot front end
- `local/station_snapshot/server/uk_aq_station_snapshot_local.py` migrated local station snapshot backend API

## Hosting layout

Test target URL:

- `https://cic-test-uk-aq-admin.chronicillnesschannel.co.uk/`

Live target URL:

- `https://uk-aq-admin.chronicillnesschannel.co.uk/`

Expected request routing:

1. Browser requests `/` and static assets from GitHub Pages.
2. Browser requests `/api/*` on the same subdomain.
3. Cloudflare routes `/api/*` to the Worker.
4. Worker proxies compatibility routes to the migrated dashboard backend API.

## Trust boundaries

- Browser is untrusted.
- Cloudflare Zero Trust protects access to the admin subdomain.
- Worker boundary holds server-side config and optional upstream bearer token.
- Upstream dashboard backend holds Supabase service-role and other sensitive data source credentials.
- Browser receives only browser-safe config from `dashboard/assets/config.js`.

## Data flow

Compatibility data flow (parity path):

1. Front end calls `/api/dashboard`, `/api/storage_coverage`, `/api/r2_metrics`, `/api/r2_connector_counts`, and update routes.
2. Worker forwards to upstream dashboard backend API.
3. Upstream backend reads Supabase and related ops data sources.
4. Worker returns JSON to the browser.

Structured API flow (new routes):

1. Front end or tooling calls `/api/status/*` and `/api/history/*`.
2. Worker fetches dashboard payload from upstream and returns a standard envelope.

## Cloudflare Zero Trust position

Zero Trust is outside the app code.

- No in-app login UI is included.
- Access control is enforced at the Cloudflare layer for the subdomain.
