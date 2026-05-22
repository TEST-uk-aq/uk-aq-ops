# uk_aq Latest Snapshot Cloud Run service

Builds latest map snapshots from a dedicated Pub/Sub observation subscription and publishes deterministic JSON to Cloudflare R2.

## Purpose

- Pull latest observation messages every 60 seconds (via Cloud Scheduler + dedicated Pub/Sub subscription).
- Acknowledge pulled Pub/Sub messages in bounded chunks so backlog bursts do not exceed the Pub/Sub acknowledge request size limit.
- Maintain latest-per-timeseries state in R2.
- Refresh metadata from daily R2 core snapshot (default once per day).
- Snapshot matrix (Phase A):
  - `pollutant`: `pm25`, `pm10`, `no2`
  - `window`: `3h`, `6h`, `1d`, `7d`, `all`
  - `network_group`: `all`
- Write per-key snapshot JSON objects with stable keys.
- Write per-family manifest with hashes, row counts, observed-at bounds, and build metadata.
- Skip snapshot object writes when payload hash is unchanged.
- Preserve previous manifest entry for failed keys (partial-failure safe).

## Required env vars / secrets

- `CFLARE_R2_ENDPOINT` (fallback `R2_ENDPOINT`)
- `CFLARE_R2_BUCKET` (fallback `R2_BUCKET`)
- `CFLARE_R2_REGION` (fallback `R2_REGION`, default `auto`)
- `CFLARE_R2_ACCESS_KEY_ID` (fallback `R2_ACCESS_KEY_ID`)
- `CFLARE_R2_SECRET_ACCESS_KEY` (fallback `R2_SECRET_ACCESS_KEY`)
- `GCP_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`)

## Optional env vars

- `UK_AQ_LATEST_SNAPSHOT_POLLUTANTS` (default `pm25,pm10,no2`)
- `UK_AQ_LATEST_SNAPSHOT_WINDOWS` (default `3h,6h,1d,7d,all`)
- `UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP` (default `all`)
- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX` (default `latest_snapshots/v1`)
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY` (default `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/manifest.json`)
- `UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX` (default `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/_runs`)
- `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED` (default `true`)
- `UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX` (default `latest_snapshots_state/v1`)
- `UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX` (default `history/v1/core`)
- `UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS` (default `86400`)
- `UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION` (default `uk-aq-latest-snapshot-sub`; must be dedicated and not equal to `OBSERVS_PUBSUB_SUBSCRIPTION`)
- `UK_AQ_SERVICE_EGRESS_METRICS_ENABLED` (default `false`)
- `UK_AQ_SERVICE_EGRESS_METRICS_SUPABASE_URL` (optional metrics sink URL; default disabled if empty)
- `UK_AQ_SERVICE_EGRESS_METRICS_SB_SECRET_KEY` (optional metrics sink service key)
- `UK_AQ_SERVICE_EGRESS_METRICS_SCHEMA` (default `uk_aq_public`)
- `UK_AQ_SERVICE_EGRESS_METRICS_RPC` (default `uk_aq_rpc_service_egress_metrics_batch_upsert`)
- `UK_AQ_SERVICE_EGRESS_ENV` (default `UK_AQ_ENV` or `unknown`)
- `UK_AQ_SERVICE_EGRESS_PROJECT_REF` (optional project ref override for attribution rows)

## Trigger mode

The service accepts `POST` and sets:

- `UK_AQ_LATEST_SNAPSHOT_TRIGGER_MODE=scheduler` when called by Cloud Scheduler
- `UK_AQ_LATEST_SNAPSHOT_TRIGGER_MODE=manual` for manual invocations

The run report includes this trigger mode.
