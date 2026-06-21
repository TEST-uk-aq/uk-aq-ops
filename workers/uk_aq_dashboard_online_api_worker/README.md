# UK AQ Ops Dashboard API Worker

Cloudflare Worker API for the hosted UK AQ ops dashboard.

## Purpose

- Keep browser code static and secret-free.
- Preserve the existing dashboard `/api/*` contract used by the local UI.
- Support two runtime modes:
  - `upstream` proxy mode (when `DASHBOARD_UPSTREAM_BASE_URL` points to another backend)
  - `direct` online mode (when upstream is unset, or when upstream points to the same hostname)
- Provide additional structured status/history routes for hosted monitoring clients.

## Route sets

Compatibility routes (for existing dashboard parity):

- `GET /api/config`
- `GET /api/snapshot`
- `GET /api/dashboard`
- `GET /api/storage_coverage`
- `GET /api/r2_metrics`
- `GET /api/r2_connector_counts`
- `POST /api/connectors`
- `POST /api/dispatcher_settings`

Edge caching is enabled for compatibility `GET` routes to reduce upstream backend hits:

- `/api/config`: 10 minutes
- `/api/snapshot`: 30 seconds
- `/api/dashboard`: 60 seconds
- `/api/storage_coverage`: 5 minutes
- `/api/r2_metrics`: 5 minutes
- `/api/r2_connector_counts`: 5 minutes

Cache bypass:

- add `?force=1` (or `refresh=1` / `nocache=1`) to bypass edge cache
- `t=<timestamp>` or `ts=<timestamp>` also bypasses cache

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

Direct online mode:

- `SUPABASE_URL`
- `SB_SECRET_KEY`

Optional direct-mode data sources:

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `UK_AQ_DB_SIZE_API_URL`
- `UK_AQ_DB_SIZE_API_TOKEN`
- `UK_AQ_R2_HISTORY_DAYS_API_URL`
- `UK_AQ_R2_HISTORY_DAYS_API_TOKEN`
- `UK_AQ_R2_HISTORY_COUNTS_API_URL`
- `UK_AQ_R2_HISTORY_COUNTS_API_TOKEN`
- `UK_AQ_R2_HISTORY_VERSION` (required `v1` or `v2`; canonical active selector deployed as a Worker secret by `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`; TEST uses `v2`. Note: old `UK_AQ_R2_HISTORY_READ_VERSION` is deprecated and rejected by active runtime guards.)
- `UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH` (optional; defaults by read version to `_ops/checkpoints/r2_history_backup_state_v1.json` or `_ops/checkpoints/r2_history_backup_state_v2.json`)
- `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID`
- `UK_AQ_R2_CLOUDFLARE_API_TOKEN` or `CFLARE_API_READ_TOKEN`
- Dropbox optional fields (`DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`) for `/api/operations_dropbox_mtime`

R2 history API fallback behavior:

- If `UK_AQ_R2_HISTORY_DAYS_API_URL` is unset, the worker derives it from `UK_AQ_DB_SIZE_API_URL` origin as `/v1/r2-history-days`.
- If `UK_AQ_R2_HISTORY_COUNTS_API_URL` is unset, the worker derives it from `UK_AQ_R2_HISTORY_DAYS_API_URL` (or `UK_AQ_DB_SIZE_API_URL`) origin as `/v1/r2-history-counts`.
- `UK_AQ_R2_HISTORY_DAYS_API_TOKEN` falls back to `UK_AQ_DB_SIZE_API_TOKEN`.
- `UK_AQ_R2_HISTORY_COUNTS_API_TOKEN` falls back to `UK_AQ_R2_HISTORY_DAYS_API_TOKEN`, then `UK_AQ_DB_SIZE_API_TOKEN`.
- `/api/storage_coverage` includes `r2_history_read_version`, `dropbox_backup_state_path`, `dropbox_backup_state_source`, `dropbox_backup_state_cache_key`, and related warning fields so the hosted dashboard can show `R2_v1` or `R2_v2`.
- `/api/r2_connector_counts` forwards the active read version to the R2 metrics API as `read_version`.

Optional upstream proxy mode:

- `DASHBOARD_UPSTREAM_BASE_URL`
- `DASHBOARD_UPSTREAM_BEARER_TOKEN`

## Local check

```bash
cd workers/uk_aq_dashboard_online_api_worker
npm install
npm run check
```

## Deploy

```bash
cd workers/uk_aq_dashboard_online_api_worker
npx wrangler deploy
```
