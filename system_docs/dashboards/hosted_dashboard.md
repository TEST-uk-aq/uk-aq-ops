# Hosted dashboard

## Purpose

The hosted UK AQ Ops dashboard provides the existing administrative user interface without placing privileged credentials in browser assets.

## Components

- `dashboard/`: static single-page front end deployed to Cloudflare Pages.
- `station_snapshot/`: static station snapshot front end included in the Pages artefact.
- `workers/uk_aq_dashboard_online_api_worker/`: Cloudflare Worker serving `/api/*`.
- Cloudflare Zero Trust: access control for the administrative hostname.

TEST defaults are:

- page and API hostname: `cic-test-uk-aq-admin.ukaq.co.uk`;
- Pages project: `uk-aq-ops-dashboard-test`;
- API Worker name: `uk-aq-ops-dashboard-api-test`.

LIVE values are supplied by the LIVE repository and must not be inferred from TEST defaults.

## Request flow

1. The browser requests `/` and static assets from Cloudflare Pages.
2. Requests to `/api/*` on the administrative hostname are routed to the dashboard API Worker.
3. The Worker either handles the request in direct mode or forwards it to a configured upstream backend.
4. The browser receives JSON that matches the relevant compatibility or structured route contract.

## Runtime modes

### Direct mode

Direct mode is used when `DASHBOARD_UPSTREAM_BASE_URL` is empty, or when the configured upstream would point back to the same request hostname.

The Worker reads its configured Supabase, Obs AQI DB, metrics, R2 and Dropbox sources directly.

### Upstream mode

When `DASHBOARD_UPSTREAM_BASE_URL` names a different reachable backend, the Worker may proxy compatibility requests to that backend. `DASHBOARD_UPSTREAM_BEARER_TOKEN` is optional and is sent only when configured.

The Worker MUST prevent a same-host upstream loop and fall back to direct mode when the upstream host equals the request host.

## Trust boundary

- The browser is untrusted.
- Browser assets may contain only the generated `UKAQ_*` display and routing configuration.
- Supabase service keys, bearer tokens, R2 credentials and other privileged values MUST remain in Worker or backend configuration.
- Cloudflare Zero Trust is the user authentication boundary. The dashboard front end does not provide a separate login system.

## Route families

The Worker maintains compatibility routes used by the dashboard front end, including:

- `GET /api/config`
- `GET /api/snapshot`
- `GET /api/dashboard`
- `GET /api/storage_coverage`
- `GET /api/r2_metrics`
- `GET /api/r2_connector_counts`
- `POST /api/connectors`
- `POST /api/dispatcher_settings`

It also provides structured status, history and station snapshot routes documented by the Worker-local README.

## Caching

Compatibility GET routes use route-specific edge TTLs. Supported explicit cache bypass parameters include `force=1`, `refresh=1`, `nocache=1`, `t=<timestamp>` and `ts=<timestamp>`.

Write routes MUST NOT be treated as cacheable GET compatibility routes.
