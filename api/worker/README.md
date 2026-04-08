# UK AQ Ops Dashboard API Worker

Cloudflare Worker API/proxy for the hosted UK AQ ops dashboard.

## Purpose

- Keep browser code static and secret-free.
- Proxy the existing dashboard backend API contract used by the local UI.
- Provide additional structured status/history routes for hosted monitoring clients.

## Route sets

Compatibility routes (for existing dashboard parity):

- `GET /api/dashboard`
- `GET /api/storage_coverage`
- `GET /api/r2_metrics`
- `GET /api/r2_connector_counts`
- `POST /api/connectors`
- `POST /api/dispatcher_settings`

Structured routes (JSON envelope):

- `GET /api/health`
- `GET /api/status/summary`
- `GET /api/status/feeds`
- `GET /api/status/db`
- `GET /api/status/history`
- `GET /api/history/manifests`
- `GET /api/history/runs`

Envelope response shape:

```json
{
  "ok": true,
  "generatedAt": "2026-04-08T12:00:00Z",
  "data": {}
}
```

Failure shape:

```json
{
  "ok": false,
  "generatedAt": "2026-04-08T12:00:00Z",
  "error": {
    "code": "UPSTREAM_UNREACHABLE",
    "message": "Failed to reach upstream API"
  }
}
```

## Required environment

- `DASHBOARD_UPSTREAM_BASE_URL`
  - Base URL for the migrated dashboard backend service that exposes `/api/dashboard` and related routes.
- `DASHBOARD_UPSTREAM_BEARER_TOKEN` (optional)
  - Bearer token sent to upstream for API auth.

## Local check

```bash
cd api/worker
npm install
npm run check
```

## Deploy

```bash
cd api/worker
npx wrangler deploy
```
