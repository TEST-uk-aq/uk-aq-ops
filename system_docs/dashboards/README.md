# Dashboards

## Purpose

This area is the authoritative system documentation for the UK AQ Ops administrative dashboards.

It covers two supported delivery models:

- the hosted dashboard, with static assets on Cloudflare Pages and `/api/*` served by the dashboard API Worker;
- the local dashboard, with the Python backend serving the same front-end assets and compatibility API from a Mac.

The station snapshot is part of the dashboard estate but has its own front end and API routes.

## Reading order

1. [`hosted_dashboard.md`](hosted_dashboard.md) for the hosted architecture and trust boundary.
2. [`local_dashboard.md`](local_dashboard.md) for the local runtime and Cloudflare Tunnel model.
3. [`station_snapshot.md`](station_snapshot.md) for station snapshot behaviour.
4. [`data_sources.md`](data_sources.md) for route and panel ownership.
5. [`operations.md`](operations.md) for configuration and deployment.
6. [`validation.md`](validation.md) for structural checks and TEST acceptance.

## Implementation ownership

- `dashboard/`
- `station_snapshot/`
- `local/dashboard/server/uk_aq_dashboard_api.py`
- `local/station_snapshot/server/uk_aq_station_snapshot_local.py`
- `local/scripts/run_dashboard.sh`
- `local/cloudflared/config.yml`
- `workers/uk_aq_dashboard_online_api_worker/`
- `.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml`
- `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`

Worker-local README files remain implementation guides. This area is the authoritative description of cross-component dashboard behaviour.

## Compatibility rule

The hosted and local dashboards MUST preserve the compatibility `/api/*` contract used by the shared front end unless an intentional contract change is made and documented here.

Retired dashboard Cloud Run paths and old wrapper scripts are historical only and MUST NOT be presented as supported runtime entrypoints.
