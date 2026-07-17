# Local dashboard

## Purpose

The local dashboard runs the UK AQ Ops administrative interface from a complete ops repository checkout on a Mac. The Python server serves both the front-end files and the compatibility `/api/*` routes from one port.

## Supported entrypoint

From the repository root:

```bash
local/scripts/run_dashboard.sh
```

The script:

1. loads the repository `.env`;
2. requires `.venv/bin/python3`;
3. regenerates `dashboard/assets/config.js` from browser-safe `UKAQ_*` values;
4. clears `DASHBOARD_UPSTREAM_BEARER_TOKEN` for the local direct backend;
5. starts `local/dashboard/server/uk_aq_dashboard_api.py`.

The default bind address is `127.0.0.1`. The default port is `8000`; the LIVE launchd configuration may set `PORT=8001`.

Old commands referring to `run_dashboard_local.sh`, `run_station_snapshot_local.sh`, `dev_dashboards.sh`, ports `8045` or `8046` are not supported unless those files and settings are reintroduced intentionally.

## Cloudflare Tunnel model

The checked-in `local/cloudflared/config.yml` template maps:

- `cic-test-uk-aq-admin.chronicillnesschannel.co.uk` to `http://127.0.0.1:8000`;
- `uk-aq-admin.chronicillnesschannel.co.uk` to `http://127.0.0.1:8001`.

Cloudflare Access remains outside the Python application and protects the external hostnames.

## Environment separation

TEST and LIVE use separate repository checkouts, `.env` files, Python virtual environments and ports. The shared tunnel may route both hostnames, but each backend MUST read only its own environment credentials.

A local dashboard must not silently fall back from missing TEST credentials to LIVE credentials or vice versa.

## Front-end configuration

The generated `dashboard/assets/config.js` may expose only:

- `UKAQ_ENV_NAME`
- `UKAQ_API_BASE_URL`
- `UKAQ_DASHBOARD_TITLE`
- `UKAQ_DASHBOARD_SUBTITLE`
- `UKAQ_DEFAULT_REFRESH_SECONDS`

Privileged configuration remains in `.env` and is read by the Python backend.

## Cloudflare Access expiry

A dormant browser tab may receive fetch or CORS-like failures when its Cloudflare Access session expires. The front end treats the recognised failure pattern as an authentication expiry and reloads the top-level page so Access can re-authenticate. Reload attempts are throttled to prevent loops.
