# uk_aq Latest Snapshot Cloud Run service

Builds latest map snapshots from `uk_aq_public.uk_aq_latest_rpc` and publishes deterministic JSON to Cloudflare R2.

## Purpose

- Build snapshot matrix every 60 seconds (via Cloud Scheduler).
- Snapshot matrix (Phase A):
  - `pollutant`: `pm25`, `pm10`, `no2`
  - `window`: `3h`, `6h`, `1d`, `7d`, `all`
  - `network_group`: `all`
- Write per-key snapshot JSON objects with stable keys.
- Write per-family manifest with hashes, row counts, observed-at bounds, and build metadata.
- Skip snapshot object writes when payload hash is unchanged.
- Preserve previous manifest entry for failed keys (partial-failure safe).

## Required env vars / secrets

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `CFLARE_R2_ENDPOINT` (fallback `R2_ENDPOINT`)
- `CFLARE_R2_BUCKET` (fallback `R2_BUCKET`)
- `CFLARE_R2_REGION` (fallback `R2_REGION`, default `auto`)
- `CFLARE_R2_ACCESS_KEY_ID` (fallback `R2_ACCESS_KEY_ID`)
- `CFLARE_R2_SECRET_ACCESS_KEY` (fallback `R2_SECRET_ACCESS_KEY`)

## Optional env vars

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `UK_AQ_LATEST_SNAPSHOT_SOURCE_RPC` (default `uk_aq_latest_rpc`)
- `UK_AQ_LATEST_SNAPSHOT_LIMIT` (default `10000`)
- `UK_AQ_LATEST_SNAPSHOT_POLLUTANTS` (default `pm25,pm10,no2`)
- `UK_AQ_LATEST_SNAPSHOT_WINDOWS` (default `3h,6h,1d,7d,all`)
- `UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP` (default `all`)
- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX` (default `latest_snapshots/v1`)
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY` (default `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/manifest.json`)
- `UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX` (default `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/_runs`)
- `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED` (default `true`)
- `UK_AQ_LATEST_SNAPSHOT_RPC_RETRIES` (default `3`)
- `UK_AQ_LATEST_SNAPSHOT_RPC_TIMEOUT_MS` (default `20000`)

## Trigger mode

The service accepts `POST` and sets:

- `UK_AQ_LATEST_SNAPSHOT_TRIGGER_MODE=scheduler` when called by Cloud Scheduler
- `UK_AQ_LATEST_SNAPSHOT_TRIGGER_MODE=manual` for manual invocations

The run report includes this trigger mode.
