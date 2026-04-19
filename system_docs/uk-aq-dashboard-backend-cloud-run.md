# UK AQ Dashboard Backend Cloud Run

Repo owner: `uk-aq-ops`  
Service source: `local/dashboard/server/uk_aq_dashboard_api.py`  
Deploy workflow: `.github/workflows/uk_aq_dashboard_backend_cloud_run_deploy.yml`

## Purpose

Hosts the migrated Python dashboard backend API so the Cloudflare dashboard Worker can proxy `/api/*` routes without exposing Supabase service-role keys in the browser.

## Routes served

- `GET /api/dashboard`
- `GET /api/config`
- `GET /api/snapshot`
- `GET /api/storage_coverage`
- `GET /api/r2_metrics`
- `GET /api/r2_connector_counts`
- `POST /api/connectors`
- `POST /api/dispatcher_settings`

`/api/snapshot` behavior:

- Uses ingestdb service-role RPC (`uk_aq_station_snapshot`) for core station/timeseries/ingest observations.
- Enriches response with ObsAQIDB rows via `uk_aq_public.uk_aq_rpc_observs_history_day_rows` and views `uk_aq_public.uk_aq_timeseries_aqi_hourly` / `uk_aq_public.uk_aq_timeseries_aqi_daily` when `OBS_AQIDB_SUPABASE_URL` + `OBS_AQIDB_SECRET_KEY` are configured.

## Runtime requirements

Required env/secrets:

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

Common optional settings:

- `UK_AQ_DB_SIZE_API_URL`
- `UK_AQ_DB_SIZE_API_TOKEN`
- `UK_AQ_R2_HISTORY_DAYS_API_URL`
- `UK_AQ_R2_HISTORY_COUNTS_API_URL`
- `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` (preferred for `/api/r2_metrics`; fallback: `CLOUDFLARE_ACCOUNT_ID`)
- `UK_AQ_R2_CLOUDFLARE_API_TOKEN` (preferred for `/api/r2_metrics`; fallback: `CFLARE_API_READ_TOKEN`)
- `DASHBOARD_UPSTREAM_BEARER_TOKEN`
- `CLEANAIRSURB_ST_ID` (default station id for `/api/config` and snapshot page load)
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Optional secret binding behavior:

- The deploy workflow now mounts optional Secret Manager env bindings only when the
  corresponding value is configured in that deployment (for example API URL + token,
  bearer token enabled, or full Dropbox credential set).
- Required DB keys (`SB_SECRET_KEY`, `OBS_AQIDB_SECRET_KEY`) are always mounted.

Dropbox status note:

- If local checkpoint file discovery fails (for example in Cloud Run), the backend now fetches
  the checkpoint JSON directly from Dropbox using `DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN`.

## Auth model

- Cloud Run is deployed with `allow-unauthenticated` to permit Cloudflare Worker access.
- If `DASHBOARD_UPSTREAM_BEARER_TOKEN` is set, all `/api/*` requests require:
  - `Authorization: Bearer <token>`
- The same token should be configured in dashboard Worker secret `DASHBOARD_UPSTREAM_BEARER_TOKEN`.

## Deployment flow

1. Workflow builds and pushes `local/dashboard/server/Dockerfile`.
2. Workflow deploys service to Cloud Run.
3. Workflow logs show the deployed Cloud Run URL.
4. Set repo variable `DASHBOARD_UPSTREAM_BASE_URL` to that URL.
5. Re-deploy dashboard Worker (`uk_aq_ops_dashboard_api_worker_deploy.yml`).
