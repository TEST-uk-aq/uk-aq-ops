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
- `UK_AQ_LATEST_SNAPSHOT_CONTRACT_VERSION` (default `v2`; set `v1` only for compatibility rebuilds)
- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX` (default `latest_snapshots/${UK_AQ_LATEST_SNAPSHOT_CONTRACT_VERSION}`; currently `latest_snapshots/v2`)
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY` (default `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/manifest.json`)
- `UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX` (default `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/_runs`)
- `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED` (default `true`)
- `UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX` (default `latest_snapshots_state/v1`)
- `UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX` (default `history/v2/core`)
- `UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS` (default `86400`)
- `UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION` (default `uk-aq-latest-snapshot-sub`; must be dedicated and not equal to `OBSERVS_PUBSUB_SUBSCRIPTION`)
- `UK_AQ_LATEST_SNAPSHOT_JOB_TIMEOUT_MS` (default `240000`; must leave at least 30 seconds before the Cloud Run request timeout)

## Trigger mode

The service accepts `POST` and sets:

- `UK_AQ_LATEST_SNAPSHOT_TRIGGER_MODE=scheduler` when called by Cloud Scheduler
- `UK_AQ_LATEST_SNAPSHOT_TRIGGER_MODE=manual` for manual invocations

The run report includes this trigger mode.

## Runtime and overlap safety

- Cloud Run must use exactly one maximum instance. The overlap lock is deliberately in memory and is authoritative only with `max-instances=1`.
- Container concurrency defaults to `1` because the service uses `0.25` CPU. Cloud Run requires concurrency `1` when total CPU is below `1`.
- The every-minute scheduler remains enabled. With concurrency `1`, overlap requests may wait at Cloud Run instead of reaching the application skip response, but the hard child timeout prevents an indefinite block.
- If CPU is raised to at least `1`, concurrency can be raised to `2`; overlap requests can then return HTTP `200` with `skipped: true`, the active trigger mode, start time, and age.
- The service terminates a child that exceeds `UK_AQ_LATEST_SNAPSHOT_JOB_TIMEOUT_MS`: `SIGTERM` first, then `SIGKILL` after a 10-second grace period.
- Metadata, Pub/Sub, and shared R2 HTTP calls have a 30-second per-attempt timeout.
- Structured logs identify accepted, skipped, completed, failed, timed-out, and force-killed child runs.

## Latest row contracts

- v2 rows derive network identity from `station.network_id -> networks.id` and emit scalar `network_id`, `network_code`, and `network_label` fields. `network_label` uses the canonical network display name from the core metadata snapshot.
- v2 rows intentionally omit `station_network_memberships`, `network_memberships`, `network_name`, and `network_type`. Connector provenance fields such as `connector_code` and `connector_label` remain present.
- v1 compatibility remains available by setting `UK_AQ_LATEST_SNAPSHOT_CONTRACT_VERSION=v1` and an explicit v1 prefix; v1 rows continue to emit `station_network_memberships`.
- Missing station/network metadata is counted as `missing_metadata_rows` and skipped instead of falling back to connector-derived network fields. Networks with `public_display_enabled=false` are skipped.

- Runtime and deploy workflow validation reject obvious cross-version standard paths: v2 cannot use `latest_snapshots/v1` for the snapshot prefix, manifest key, or runs prefix, and v1 cannot use `latest_snapshots/v2`. Custom non-versioned prefixes are still allowed.
