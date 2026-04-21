# UK AQ Dashboard System

This document describes how the local UK AQ dashboard works in ingest, where it gets data from, and how storage/backup status is derived.

## Scope

Dashboard components in this repo:

- Backend API server: `scripts/uk_aq_dashboard_local.py`
- Frontend UI: `data/uk_aq_dashboard/uk_aq_dashboard.html`
- Static assets: `data/uk_aq_dashboard/*` (for example `dropbox-icon.svg`, served via `/assets/...`)

This dashboard is a local service (typically run from `dev_dashboards.sh`), not a hosted production web service.

## Runtime Topology

Browser -> local Python server -> data sources:

1. Supabase PostgREST (ingestdb and obs_aqidb).
2. External DB size API (optional, if configured).
3. External R2 history-days API (optional, if configured).
  - Preferred implementation now reads derived R2 index manifests first:
    - `history/_index/observations_latest.json`
    - `history/_index/aqilevels_latest.json`
  - Falls back to direct R2 day-prefix scan only when index files are missing or invalid.
4. Supabase RPC fallback for R2 history window (`uk_aq_rpc_r2_history_window` by default).
5. Cloudflare APIs for R2 account usage.
6. Local Dropbox checkpoint JSON file (for Dropbox backup status badges).

## HTTP Endpoints

Served by `scripts/uk_aq_dashboard_local.py`:

- `GET /` and `GET /index.html`
  - Serves the dashboard HTML.
- `GET /assets/<file>`
  - Serves static files from `data/uk_aq_dashboard/`.
  - Path traversal is blocked; only files under that directory are served.
- `GET /api/dashboard`
  - Main payload for dashboard panels.
  - Query params:
    - `force=1|true|yes|on`: clear dashboard + storage coverage cache before rebuilding.
    - `dispatch_cursor=<timestamp>`: incremental dispatch feed fetch.
    - `include_storage_coverage=0|false|no|off`: skip `storage_coverage_days` in this response (used for faster initial UI render).
- `GET /api/storage_coverage`
  - Returns storage coverage calendar rows only.
  - Query params:
    - `force=1|true|yes|on`: clear storage coverage cache before rebuilding rows.
- `GET /api/r2_connector_counts`
  - Returns per-connector R2 row counts for the visible calendar period.
  - Proxy to external R2 history-counts API so browser does not carry the worker token.
  - Query params:
    - `from_day=<YYYY-MM-DD>`
    - `to_day=<YYYY-MM-DD>`
    - `grain=day|month`
- `GET /api/r2_metrics`
  - Returns R2 usage + R2 history window.
  - Query params:
    - `force=1|true|yes|on`: force R2 usage cache refresh.
- `POST /api/connectors`
  - Updates connector poll settings in `connectors`.
- `POST /api/dispatcher_settings`
  - Updates `dispatcher_settings` row (`id=1`).

## Data Sources by Panel

### 1) Pollutant freshness panels

Sources (ingestdb):

- `connectors`
- `stations`
- `station_metadata`
- `timeseries` (+ joined `phenomena`)

How:

- Uses `last_value_at` to bucket station freshness (`0-3h`, `3-6h`, `6-24h`, `1-7d`, `>7d`).
- Applies connector-specific exclusions (`pm10` excludes Breathe London, `no2` excludes Sensor.Community).
- Active-station rules include connector-specific logic (for Breathe London, checks metadata flags).

### 2) Dispatch runs panel

Sources (ingestdb):

- `uk_aq_ingest_runs`
- `connectors` fallback fields for in-flight display

How:

- Maintains incremental in-memory run cache with overlap window.
- Adds synthetic `in_flight` rows when a connector run has start time but no end time.

### 3) DB size and schema/domain size charts

Primary source (preferred):

- `UK_AQ_DB_SIZE_API_URL` endpoint returning:
  - `db_size_metrics`
  - `schema_size_metrics`
  - `r2_domain_size_metrics`

Fallback source (direct Supabase reads):

- Ingest DB view `uk_aq_public.uk_aq_db_size_metrics_hourly` for `ingestdb`.
- Obs AQI DB view `uk_aq_public.uk_aq_db_size_metrics_hourly` for `obs_aqidb`.
- Obs AQI DB view `uk_aq_public.uk_aq_schema_size_metrics_hourly` for:
  - `uk_aq_observs`
  - `uk_aq_aqilevels`
- Ingest DB view `uk_aq_public.uk_aq_r2_domain_size_metrics_hourly` for:
  - `observations`
  - `aqilevels`
- Direct fallback metric reads are paginated with `offset`/`limit` so windows larger than the PostgREST row cap still include the newest buckets.

If primary source fails or is stale, backend reports warning fields and uses fallback.
Primary payload guardrails:
- DB-size payload must include a recent `db_size_metrics` latest bucket (within 6 hours of current UTC time).
- `schema_size_metrics` and `r2_domain_size_metrics` latest buckets are checked against the DB latest bucket (6-hour max lag). If either lags, dashboard performs targeted direct-Supabase top-up for only that lagging series instead of full all-series fallback.

R2 domain chart consistency rule:

- `r2_domain_size_metrics` rows are filtered against committed day sets from the R2 history-days API.
- If no committed days exist in the configured history bucket, the chart is intentionally suppressed (with a source warning) instead of showing stale/mismatched rows.
- Size chart units are decimal MB (`1 MB = 1,000,000 bytes`) for DB/schema and R2 domain charts.

### 4) R2 account usage panel

Source:

- Cloudflare account APIs using:
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CFLARE_API_READ_TOKEN`

How:

- Gets operation usage (Class A/B) from Cloudflare GraphQL.
- Gets storage usage from GraphQL first, then falls back to Cloudflare R2 metrics REST endpoint if storage analytics are empty/zero.
- If GraphQL is not authorized for the token/account, dashboard surfaces the Cloudflare error detail in the warning text.

### 5) Storage coverage calendar (monthly/yearly)

Inputs:

- Latest `oldest_observed_at` from DB/schema metrics.
- Obs AQI DB exact day-count view (preferred):
  - `uk_aq_public.uk_aq_obs_aqidb_day_counts_current`
  - `obs_aqidb` day is present when `dataset='observs'` and `row_count > 0`
  - `obs_aqi_aqilevels` day is present when `dataset='aqilevels'` and `row_count > 0`
- Obs AQI DB RPC fallbacks:
  - `uk_aq_rpc_observs_drop_candidates` + per-day `uk_aq_rpc_observations_hourly_fingerprint`
  - `uk_aq_rpc_aqilevels_drop_candidates`
- R2 committed-day API (preferred):
  - endpoint: `UK_AQ_R2_HISTORY_DAYS_API_URL` (or derived from `UK_AQ_DB_SIZE_API_URL` as `/v1/r2-history-days`)
  - bucket is fixed by the Worker environment (`CFLARE_R2_BUCKET`)
  - prefers derived index manifests:
    - `history/_index/observations_latest.json`
    - `history/_index/aqilevels_latest.json`
  - index files are built from committed top-level day manifests and carry per-day connector row counts
  - only days with committed top-level manifests are considered present
- R2 window RPC fallback (when R2 committed-day API is unavailable):
  - default RPC name: `uk_aq_rpc_r2_history_window`
  - env override: `UK_AQ_R2_HISTORY_WINDOW_RPC`
- Dropbox checkpoint day maps (local JSON file; details below).

Rules:

- Calendar `obs_aqidb` day presence is based on exact per-day `row_count > 0` from `uk_aq_obs_aqidb_day_counts_current`.
- If the current day-count view is unavailable, Observs day presence falls back to the older RPC loop (`drop_candidates` + per-day `observations_hourly_fingerprint`) and then oldest-day range logic only if that fallback also fails.
- Calendar `obs_aqi_aqilevels` day presence is based on exact per-day `row_count > 0` from `uk_aq_obs_aqidb_day_counts_current`.
- If the current day-count view is unavailable, AQI day presence falls back to `uk_aq_rpc_aqilevels_drop_candidates` and then oldest-day range logic only if that fallback fails.
- Calendar `r2_observs` / `r2_aqilevels` day presence is only taken from committed-day API per-day lists.
- If committed-day API is unavailable, calendar does not infer per-day R2 presence from RPC min/max windows.
- Backend caches committed-day API payloads in-memory for 5 minutes to avoid repeated network fetches across dashboard/calendar/R2 metrics requests.
- R2 history window day count uses explicit committed-day overlap:
  - `day_count = |observations_days ∩ aqilevels_days|`
  - only days with both domain manifests are counted.
- If committed-day API is unavailable, R2 window falls back to RPC min/max and day count is not explicit.
- Today rendering differs by view:
  - Monthly: today shown as half-width bars.
  - Yearly: today excluded (complete-day model).

UI loading behavior:

- Frontend first requests `/api/dashboard?include_storage_coverage=0` so non-calendar panels render without waiting for storage-coverage recompute.
- After initial render, frontend requests `/api/storage_coverage` and swaps in the calendar panel when rows are ready.
- `force=1` still rebuilds the full storage-coverage payload, but both major expensive paths are reduced:
  - R2 history reads prefer derived index manifests instead of live day-prefix scans.
  - ObsAQIDB presence reads prefer `uk_aq_obs_aqidb_day_counts_current` instead of per-day fingerprint RPC loops.

### 6) R2 connector row-count charts (under calendar)

Source:

- External R2 history-counts API (preferred):
  - endpoint: `UK_AQ_R2_HISTORY_COUNTS_API_URL` or derived from the DB-size/History-days worker origin as `/v1/r2-history-counts`
  - token: `UK_AQ_R2_HISTORY_COUNTS_API_TOKEN` or fallback `UK_AQ_R2_HISTORY_DAYS_API_TOKEN`
  - reads the same derived R2 index manifests:
    - `history/_index/observations_latest.json`
    - `history/_index/aqilevels_latest.json`

Behavior:

- Monthly calendar view:
  - charts request `grain=day`
  - bars show daily row totals per connector
  - x-axis shows every visible day label for the selected month
- Year calendar view:
  - charts request `grain=month`
  - bars show monthly average rows per day per connector
  - x-axis shows every month label
  - tooltips still show monthly total rows and calendar day counts
- Chart mode toggle:
  - `Stacked`: AQI bottom, Observs top
  - `Observs`
  - `AQI`
- Frontend cache:
  - chart payloads are cached in-memory for up to 6 hours per visible period
  - `Force Refresh` bypasses that cache and refetches the current chart payload immediately
- Each connector chart uses its own y-axis scale.
- Dashboard keeps this separate from storage-coverage booleans; it is purely an R2 history row-count view.

## Dropbox Status in Monthly Calendar

Monthly bars can show backup state from checkpoint data:

- If R2 history exists and backup exists for that same day/domain:
  - bar keeps normal R2 color and adds second line (`Backup` + icon).
- For striped AQI bars (`R2 AQI + ObsAQI AQI`), the Dropbox badge is shown only when both backup domains are present on that day:
  - `dropbox_observs = true` and `dropbox_aqilevels = true`.
- If backup exists but R2 history does not for that day/domain:
  - bar is white with orange/yellow border and primary label is Dropbox icon + `Backup - Obs` / `Backup - AQI`.

Checkpoint schema used:

- `domains.observations.days.<YYYY-MM-DD>`
- `domains.aqilevels.days.<YYYY-MM-DD>`

If a day key exists for a domain, that domain bar on that day gets Dropbox second line.

Important:

- Dashboard does not call Dropbox API directly.
- It reads a local JSON checkpoint file only.

### Local vs GH behavior

- Local machine:
  - Works if checkpoint file exists in local filesystem (for example synced Dropbox folder).
- GitHub runner:
  - No automatic Dropbox read.
  - To show Dropbox status in GH-run dashboard, provide the checkpoint file on runner filesystem and point dashboard env to it.
  - Otherwise, dashboard runs normally but without Dropbox second-line labels.

## Dropbox Checkpoint Path Resolution

Resolution order:

1. `UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE` (explicit absolute or relative path).
2. Derived path:
   - `<UK_AQ_DROPBOX_LOCAL_ROOT>/<UK_AQ_DROPBOX_ROOT>/<UK_AQ_R2_HISTORY_DROPBOX_DIR>/<UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH>`
3. Dropbox app-folder derived path(s):
   - `<UK_AQ_DROPBOX_LOCAL_ROOT>/Apps/<UK_AQ_DROPBOX_APP_FOLDER>/<UK_AQ_DROPBOX_ROOT>/<UK_AQ_R2_HISTORY_DROPBOX_DIR>/<UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH>`
   - If `UK_AQ_DROPBOX_APP_FOLDER` is unset, dashboard scans `.../Apps/*/` (prefers `github-uk-air-quality-networks` first).
4. If `UK_AQ_DROPBOX_LOCAL_ROOT` is unset, default local root candidate:
   - `~/Dropbox`

Defaults:

- `UK_AQ_DROPBOX_ROOT=CIC-Test`
- `UK_AQ_R2_HISTORY_DROPBOX_DIR=R2_history_backup`
- `UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH=_ops/checkpoints/r2_history_backup_state_v1.json`

## Caching Model

- Dashboard payload cache (`/api/dashboard`):
  - `CACHE_TTL_SECONDS=20`.
  - Separate cache entries are maintained for `include_storage_coverage=true` and `include_storage_coverage=false`.
- R2 usage cache:
  - `R2_CACHE_TTL_SECONDS=3600` (1 hour).
- Storage coverage cache:
  - `STORAGE_COVERAGE_CACHE_TTL_SECONDS=21600` (6 hours).
  - `force` refresh clears cache immediately.
- Dispatch runs:
  - Incremental in-memory merge with overlap and max-row cap.

## Security and Guardrails

- Requires service-role key (`SB_SECRET_KEY` role must be `service_role`).
- Base URL host restricted to:
  - `localhost` / `127.0.0.1`
  - `*.supabase.co`
  - `*.supabase.in`
- PostgREST writes are limited to known endpoints (`connectors`, `dispatcher_settings`) in this server code path.

## Environment Variables

Required:

- `SUPABASE_URL`
- `SB_SECRET_KEY` (service role)

DB size / metrics:

- `UK_AQ_DB_SIZE_LOOKBACK_DAYS` (default `28`)
- `UK_AQ_DB_SIZE_API_URL` (optional)
- `UK_AQ_DB_SIZE_API_TOKEN` (optional)
- `OBS_AQIDB_SUPABASE_URL` (optional fallback)
- `OBS_AQIDB_SECRET_KEY` (optional fallback)
- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)

R2 committed-day API (exact day presence):

- `UK_AQ_R2_HISTORY_DAYS_API_URL` (optional; if unset and `UK_AQ_DB_SIZE_API_URL` is set, dashboard derives `<origin>/v1/r2-history-days`)
- `UK_AQ_R2_HISTORY_DAYS_API_TOKEN` (optional; defaults to `UK_AQ_DB_SIZE_API_TOKEN`)
- `UK_AQ_R2_HISTORY_DAYS_API_MAX_DAYS` (default `3660`)

R2 window / usage:

- `UK_AQ_R2_HISTORY_WINDOW_RPC` (default `uk_aq_rpc_r2_history_window`)
- `CLOUDFLARE_ACCOUNT_ID`
- `CFLARE_API_READ_TOKEN`
- `UK_AQ_R2_FREE_TIER_GB` (default `10`)
- `UK_AQ_R2_FREE_TIER_CLASS_A_REQUESTS` (default `1000000`)
- `UK_AQ_R2_FREE_TIER_CLASS_B_REQUESTS` (default `10000000`)

Dropbox checkpoint (monthly backup second-line labels):

- `UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE` (explicit path; preferred when set)
- `UK_AQ_DROPBOX_LOCAL_ROOT` (optional local root override)
- `UK_AQ_DROPBOX_APP_FOLDER` (optional app-folder name under `.../Dropbox/Apps/` for app-folder tokens)
- `UK_AQ_DROPBOX_ROOT` (default `CIC-Test`)
- `UK_AQ_R2_HISTORY_DROPBOX_DIR` (default `R2_history_backup`)
- `UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH` (default `_ops/checkpoints/r2_history_backup_state_v1.json`)

Dispatch feed behavior:

- `DISPATCH_OBSERVS_WINDOW_MINUTES` (default `240`)
- `DISPATCH_FETCH_LIMIT` (default `1000`)
- `DISPATCH_INCREMENTAL_OVERLAP_SECONDS` (default `120`)
- `DISPATCH_MAX_ROWS` (default `5000`)

## Operational Notes

- `dev_dashboards.sh` exports `.env` and `.env.supabase` before launching Python, prefers `./.venv/bin/python3` when present, and fails fast if the selected interpreter is missing dashboard dependencies.
- If the DB size API is down, dashboard falls back to direct Supabase metric reads and emits warning strings in payload.
- If Dropbox checkpoint is missing, unreadable, or malformed, only Dropbox status labels are affected; core dashboard remains available.
