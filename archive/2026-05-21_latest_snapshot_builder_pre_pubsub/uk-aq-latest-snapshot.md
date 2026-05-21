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
- Reads latest values from `uk_aq_public.uk_aq_latest_rpc`.
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
- Returns `upstream_fetch_failed` when the upstream URL is bad/unreachable or upstream returns a fetch failure path.

## Request Flow

1. Cloud Scheduler triggers Cloud Run service every minute.
2. Cloud Run service builds snapshot payloads for each matrix key.
3. Service writes changed snapshot objects to R2 and always writes/updates the latest family manifest.
4. Browser calls cache proxy route: `/api/aq/latest-snapshot?...`.
5. Cache proxy forwards to latest snapshot R2 API worker URL from `UK_AQ_LATEST_SNAPSHOT_R2_API_URL`.
6. R2 API Worker validates upstream auth and serves object from R2.

## R2 Key Layout

Default prefix: `latest_snapshots/v1`

Snapshot object keys:

- `latest_snapshots/v1/network_group=all/pollutant=pm25/window=3h.json`
- `latest_snapshots/v1/network_group=all/pollutant=pm10/window=6h.json`
- `latest_snapshots/v1/network_group=all/pollutant=no2/window=1d.json`

Manifest key:

- `latest_snapshots/v1/manifest.json`

Optional run report keys:

- `latest_snapshots/v1/_runs/<UTC timestamp>.json`

## Query Contract

R2 API Worker endpoint:

- `GET /v1/latest-snapshot?pollutant=pm25&window=6h&network_group=all`

Accepted alias:

- `scope=all` works as alias for `network_group=all`.

Valid values:

- `pollutant`: `pm25`, `pm10`, `no2`
- `window`: `3h`, `6h`, `1d`, `7d`, `all`
- `network_group`: `all`

Note:

- `limit` is relevant to builder-side RPC fetch limits, not to R2 API response selection.

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

- `UK_AQ_LATEST_SNAPSHOT_SOURCE_RPC` (default `uk_aq_latest_rpc`)
- `UK_AQ_LATEST_SNAPSHOT_LIMIT` (default `10000`; hard-capped in code at `10000`)
- `UK_AQ_LATEST_SNAPSHOT_POLLUTANTS` (default `pm25,pm10,no2`)
- `UK_AQ_LATEST_SNAPSHOT_WINDOWS` (default `3h,6h,1d,7d,all`)
- `UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP` (default `all`)
- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX` (default `latest_snapshots/v1`)
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY` (default `${prefix}/manifest.json`)
- `UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX` (default `${prefix}/_runs`)
- `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED` (default `true`)
- `UK_AQ_LATEST_SNAPSHOT_RPC_RETRIES` (default `3`)
- `UK_AQ_LATEST_SNAPSHOT_RPC_TIMEOUT_MS` (default `20000`)
- `UK_AQ_SERVICE_EGRESS_METRICS_ENABLED` (default `true`)
- `UK_AQ_SERVICE_EGRESS_METRICS_SUPABASE_URL` (optional metrics sink Supabase URL)
- `UK_AQ_SERVICE_EGRESS_METRICS_SB_SECRET_KEY` (optional metrics sink service key)
- `UK_AQ_SERVICE_EGRESS_METRICS_SCHEMA` (default `uk_aq_public`)
- `UK_AQ_SERVICE_EGRESS_METRICS_RPC` (default `uk_aq_rpc_service_egress_metrics_batch_upsert`)
- `UK_AQ_SERVICE_EGRESS_ENV` (environment label persisted with metric rows)
- `UK_AQ_SERVICE_EGRESS_PROJECT_REF` (optional project-ref label persisted with metric rows)

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

## Related Docs

- `system_docs/uk-aq-cache-proxy.md`
- `workers/uk_aq_latest_snapshot_cloud_run/README.md`
- `workers/uk_aq_latest_snapshot_r2_api_worker/README.md`
