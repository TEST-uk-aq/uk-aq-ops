# UK AQ Latest Snapshot Pipeline

## Purpose

This pipeline publishes deterministic latest-value snapshot JSON files to R2 and serves them through the cache proxy.

Phase A matrix:

- `pollutant`: `pm25`, `pm10`, `no2`
- `window`: `3h`, `6h`, `1d`, `7d`, `all`
- `network_group`: `all`

Build frequency is every minute via Cloud Scheduler.

## Components

1. Cloud Run builder service
- Path: `workers/uk_aq_latest_snapshot_cloud_run/`
- Runtime script: `run_job.ts`
- Deploy workflow: `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`
- Pulls observation messages from a dedicated Pub/Sub subscription.
- Maintains latest-per-timeseries state in R2 (`latest_snapshots_state/v1` by default).
- Refreshes metadata from daily R2 core snapshot (`history/v1/core` by default; daily refresh cadence).
- Writes snapshot objects + family manifest to R2.

2. Latest snapshot R2 API Worker
- Path: `workers/uk_aq_latest_snapshot_r2_api_worker/`
- Deploy workflow: `.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml`
- Reads snapshot objects from R2 and exposes:
  - `GET /v1/latest-snapshot`
  - `GET /v1/manifest`
  - `GET /v1/health`
- Requires upstream auth header: `x-uk-aq-upstream-auth`.

3. Cache proxy route
- Path: `workers/uk_aq_cache_proxy/src/index.ts`
- External route: `/api/aq/latest-snapshot`
- Upstream target configured by: `UK_AQ_LATEST_SNAPSHOT_R2_API_URL`.
- Returns `upstream_fetch_failed` when upstream is unreachable/failing.

## Request Flow

1. Cloud Scheduler triggers Cloud Run service every minute.
2. Cloud Run service pulls Pub/Sub observations from the latest-snapshot subscription.
3. Service updates R2 latest-state object.
4. Service acknowledges pulled Pub/Sub messages in bounded chunks to stay below Pub/Sub request-size limits during burst/backlog drains.
5. Service loads cached core metadata (refreshes from latest `history/v1/core/day_utc=...` snapshot once stale).
6. Service builds the matrix payloads and writes changed snapshot objects to R2.
7. Service writes/updates latest family manifest.
8. Browser calls cache proxy route: `/api/aq/latest-snapshot?...`.
9. Cache proxy forwards to latest snapshot R2 API worker URL from `UK_AQ_LATEST_SNAPSHOT_R2_API_URL`.
10. R2 API Worker validates upstream auth and serves object from R2.

## R2 Key Layout

Default snapshot prefix: `latest_snapshots/v1`

Snapshot object keys:

- `latest_snapshots/v1/network_group=all/pollutant=pm25/window=3h.json`
- `latest_snapshots/v1/network_group=all/pollutant=pm10/window=6h.json`
- `latest_snapshots/v1/network_group=all/pollutant=no2/window=1d.json`

Manifest key:

- `latest_snapshots/v1/manifest.json`

Optional run report keys:

- `latest_snapshots/v1/_runs/<UTC timestamp>.json`

Default state/metadata cache keys:

- `latest_snapshots_state/v1/latest_state.json`
- `latest_snapshots_state/v1/core_metadata_cache.json`

## Query Contract

R2 API Worker endpoint:

- `GET /v1/latest-snapshot?pollutant=pm25&window=6h&network_group=all`

Accepted alias:

- `scope=all` works as alias for `network_group=all`.

Valid values:

- `pollutant`: `pm25`, `pm10`, `no2`
- `window`: `3h`, `6h`, `1d`, `7d`, `all`
- `network_group`: `all`

## Environment Variables

Cloud Run builder controls:

- `GCP_LATEST_SNAPSHOT_SERVICE_NAME` (default `uk-aq-latest-snapshot-builder`)
- `GCP_LATEST_SNAPSHOT_SERVICE_ACCOUNT` (required or fallback `GCP_OPS_JOB_SERVICE_ACCOUNT`)
- `GCP_LATEST_SNAPSHOT_SERVICE_TIMEOUT_SECONDS` (default `300`)
- `GCP_LATEST_SNAPSHOT_SERVICE_CPU` (default `0.25`)
- `GCP_LATEST_SNAPSHOT_SERVICE_MEMORY` (default `256Mi`)
- `GCP_LATEST_SNAPSHOT_SERVICE_CONCURRENCY` (default `1`)
- `GCP_LATEST_SNAPSHOT_SERVICE_MAX_INSTANCES` (default `1`)
- `GCP_LATEST_SNAPSHOT_SERVICE_MIN_INSTANCES` (default `0`)
- `GCP_LATEST_SNAPSHOT_SCHEDULER_ENABLED` (default `true`)
- `GCP_LATEST_SNAPSHOT_SCHEDULER_JOB_NAME` (default `uk-aq-latest-snapshot-every-minute`)
- `GCP_LATEST_SNAPSHOT_SCHEDULER_CRON` (default `* * * * *`)
- `GCP_LATEST_SNAPSHOT_SCHEDULER_TIMEZONE` (default `Etc/UTC`)
- `GCP_LATEST_SNAPSHOT_SCHEDULER_MAX_RETRY_ATTEMPTS` (default `0`)
- `GCP_LATEST_SNAPSHOT_SCHEDULER_SERVICE_ACCOUNT` (optional; fallback to service account above)

Builder data/object controls:

- `UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION` (default `uk-aq-latest-snapshot-sub`; must not match `OBSERVS_PUBSUB_SUBSCRIPTION`)
- `UK_AQ_LATEST_SNAPSHOT_POLLUTANTS` (default `pm25,pm10,no2`)
- `UK_AQ_LATEST_SNAPSHOT_WINDOWS` (default `3h,6h,1d,7d,all`)
- `UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP` (default `all`)
- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX` (default `latest_snapshots/v1`)
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY` (default `${prefix}/manifest.json`)
- `UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX` (default `${prefix}/_runs`)
- `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED` (default `true`)
- `UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX` (default `latest_snapshots_state/v1`)
- `UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX` (default `history/v1/core`)
- `UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS` (default `86400`)

R2 API Worker controls:

- `UK_AQ_LATEST_SNAPSHOT_R2_API_WORKER_NAME` (deploy target; default `uk-aq-latest-snapshot-r2-api`)
- `UK_AQ_LATEST_SNAPSHOT_R2_CACHE_MAX_AGE_SECONDS` (default `60`)
- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX` (default `latest_snapshots/v1`)
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY` (default `${prefix}/manifest.json`)

Cache proxy integration control:

- `UK_AQ_LATEST_SNAPSHOT_R2_API_URL` (required by cache proxy deploy)

## Deployment Touchpoints

- Cloud Run builder deploy:
  - `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`
- Latest snapshot R2 API worker deploy:
  - `.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml`
- Cache proxy deploy:
  - `.github/workflows/uk_aq_cache_proxy_deploy.yml`

When `UK_AQ_LATEST_SNAPSHOT_R2_API_URL` changes, redeploy cache proxy so Worker secrets are refreshed.

## Troubleshooting

`/api/aq/latest-snapshot` returns `502 {"error":"upstream_fetch_failed"}`:

1. Check `UK_AQ_LATEST_SNAPSHOT_R2_API_URL` value in GitHub vars for ops repo.
2. Redeploy `uk_aq_cache_proxy`.
3. Verify latest snapshot R2 API worker is deployed and reachable.
4. Confirm cache proxy has `UK_AQ_EDGE_UPSTREAM_SECRET` and upstream worker uses same value.
5. Check Cloudflare Worker logs for cache proxy and latest snapshot R2 API worker.

`404 snapshot_not_found` from latest snapshot R2 API worker:

1. Confirm Cloud Run builder has run successfully.
2. Check manifest at `latest_snapshots/v1/manifest.json`.
3. Check expected snapshot object key exists for requested `(pollutant, window, network_group)`.

Cloud Run builder fails with subscription safety error:

1. Check `UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION` is configured to a dedicated subscription.
2. Ensure it is not equal to `OBSERVS_PUBSUB_SUBSCRIPTION`.

Cloud Run builder fails with `Request payload size exceeds the limit: 524288 bytes` from Pub/Sub acknowledge:

1. Deploy the builder with ack chunking support from `workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`.
2. Re-check `subscription/num_undelivered_messages` for `uk-aq-latest-snapshot-sub`; it should fall once the next runs acknowledge the backlog in chunks.

## One-Off State Bootstrap

If the builder has just migrated from the old RPC source and you want immediate coverage,
seed state once from existing snapshot objects:

```bash
node scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_existing_r2.mjs \
  --report-out ./tmp/latest_snapshot_state_seed_report.json
```

Apply to R2:

```bash
node scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_existing_r2.mjs \
  --write-r2 \
  --report-out ./tmp/latest_snapshot_state_seed_report.json
```

This is normally a one-off operation. Re-run only if you intentionally reset
or replace the latest snapshot state object.

If snapshot coverage is stale and you need a one-off refresh from Supabase latest RPC:

```bash
node scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_supabase.mjs \
  --report-out ./tmp/latest_snapshot_state_from_supabase_report.json
```

Apply to R2:

```bash
node scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_supabase.mjs \
  --write-r2 \
  --report-out ./tmp/latest_snapshot_state_from_supabase_report.json
```

## Related Docs

- `system_docs/uk-aq-cache-proxy.md`
- `workers/uk_aq_latest_snapshot_cloud_run/README.md`
- `workers/uk_aq_latest_snapshot_r2_api_worker/README.md`
- `system_docs/uk-aq-r2-core-snapshot.md`
