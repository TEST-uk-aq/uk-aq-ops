# uk-aq-observs-partition-maintenance setup (Cloud Run + Scheduler)

This deploys a dedicated Cloud Run service that maintains `uk_aq_observs.observations` partitions in `obs_aqidb`.

## Runtime behavior

`POST /run` performs:
- create/ensure UTC-day partitions through `today + 3 days`
- enforce hot/cold index policy
  - hot: previous 2 UTC days + today + next 3 UTC days -> unique btree on `(connector_id, timeseries_id, observed_at)` + BRIN(observed_at)
  - cold: BRIN(observed_at) only
- default partition diagnostics (`count`, min/max observed_at, top offenders)
- retention drops based on strict UTC-day cutoff (keeps the last `OBS_AQIDB_OBSERVS_RETENTION_DAYS` full UTC days)
- R2 History manifest gate before each drop:
  - HEAD `history/v2/observations/day_utc=YYYY-MM-DD/manifest.json` in Cloudflare R2
  - GET the same `manifest.json` and validate:
    - `day_utc` matches the partition day
    - `manifest_hash` matches SHA-256 of manifest content excluding `manifest_hash`
  - if manifest is missing, check `uk_aq_observs` day presence via RPC:
    - if the day has rows: skip drop
    - if the day has no rows: drop the empty partition
    - if `uk_aq_rpc_observs_day_has_rows` is missing from PostgREST schema cache, fallback check uses `uk_aq_rpc_observations_hourly_fingerprint` for that UTC day
  - if not confirmed, skip drop and log `SKIP DROP — history manifest not confirmed`
  - the Cloud Run deploy workflow maps the worker's `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` env to `vars.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || 'history/v2/observations'` for this service
- after a successful partition drop, best-effort delete the matching row from `uk_aq_ops.obs_aqidb_day_counts_current` via `uk_aq_rpc_obs_aqidb_day_count_delete('observs', day_utc)`
  - failures are logged as warnings only because hourly/daily day-count refresh jobs will reconcile later

## Required environment variables

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `UK_AQ_EDGE_UPSTREAM_SECRET`

## HTTP authentication

`POST /run` accepts either existing upstream authentication with
`x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>` or Cloudflare scheduler
authentication with
`x-uk-aq-dispatch-secret: <UK_AQ_EDGE_UPSTREAM_SECRET>`. A caller needs one
valid route, not both. Missing or invalid credentials return HTTP 403.

The service remains deployed with `--allow-unauthenticated` because the
Cloudflare Worker does not mint a Google OIDC token. This only permits the request
through Cloud Run IAM; the application authentication above still protects
maintenance execution. `/healthz` remains unauthenticated and does not run
maintenance. `GET /run` remains HTTP 405.

## Optional environment variables

Partition policy controls:
- `OBSERVS_PARTITIONS_FUTURE_DAYS` (policy-fixed to `3`)
- `OBSERVS_PARTITIONS_HOT_DAYS` (default `3`)
- `OBS_AQIDB_OBSERVS_RETENTION_DAYS` (default `14`)
- `OBSERVS_DEFAULT_TOP_N` (default `20`)
- `OBSERVS_PARTITION_DROP_DRY_RUN` (default `false`)

Dropbox logging:
- `UK_AQ_DROPBOX_ROOT` (optional)
- `UK_AQ_OBSERVS_PARTITION_DROPBOX_FOLDER` (default `/observs_partition_maintenance`)
- `UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist)
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Cloudflare R2 history-check placeholders (S3-compatible API):
- `CFLARE_R2_ENDPOINT` (or `R2_ENDPOINT`)
- `CFLARE_R2_BUCKET` (or `R2_BUCKET`)
- `CFLARE_R2_ACCESS_KEY_ID` (or `R2_ACCESS_KEY_ID`)
- `CFLARE_R2_SECRET_ACCESS_KEY` (or `R2_SECRET_ACCESS_KEY`)
- `CFLARE_R2_REGION` (or `R2_REGION`, default `auto`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` (default `history/v1/observations`; the Cloud Run deploy workflow for this service overrides it from the v2 repo variable so production resolves to `history/v2/observations`)

## Local run

```bash
npm install
npm run start:observs-partitions
```

Run once:

```bash
curl -X POST \
  -H "x-uk-aq-dispatch-secret: ${UK_AQ_EDGE_UPSTREAM_SECRET}" \
  "http://localhost:8080/run"
```

Dry-run partition drop gate:

```bash
curl -X POST \
  -H "x-uk-aq-dispatch-secret: ${UK_AQ_EDGE_UPSTREAM_SECRET}" \
  "http://localhost:8080/run?dropDryRun=true"
```

## Scheduler

Recommended schedule: `0 3 * * *` with timezone `UTC`.

Target service endpoint:
- `POST /run`

The `uk_aq_observs_partition_maintenance` job is tracked in
`cloudflare/scheduler/jobs.toml`. Its Cloud Run URL is deployment-managed: the
service deploy workflow reads `status.url`, appends `/run`, syncs the Git-tracked
job configuration, updates that URL in D1, and verifies the resulting row. The
current `dry_run` behavior is controlled by `cloudflare/scheduler/jobs.toml`.

## Secret rotation and deployment

Use the existing GitHub Actions edge secret for both deploy workflows. If it
needs to be restored from the local environment:

```bash
printf '%s' "${UK_AQ_EDGE_UPSTREAM_SECRET}" | \
  gh secret set UK_AQ_EDGE_UPSTREAM_SECRET --repo TEST-uk-aq/uk-aq-ops
```

The Cloud Run deploy workflow upserts the value into GCP Secret Manager, maps it
to `UK_AQ_EDGE_UPSTREAM_SECRET`, deploys the service, and reconciles the D1 URL.
The Cloudflare Worker deploy workflow installs the same GitHub secret on
`uk-aq-cron-scheduler-ops`. Do not rotate this shared value only for the
scheduler; all edge and upstream consumers must be updated together.

```bash
gh workflow run uk_aq_observs_partition_maintenance_cloud_run_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref main
gh workflow run uk_aq_cloudflare_scheduler_ops_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref main
```

Verify health after obtaining the deployed URL from the workflow output or GCP:

```bash
SERVICE_URL="$(gcloud run services describe uk-aq-observs-partition-maintenance-service \
  --project "${GCP_PROJECT_ID}" --region "${GCP_REGION:-europe-west2}" \
  --format='value(status.url)')"
curl --fail --silent --show-error "${SERVICE_URL}/healthz"
```

For the first controlled real run, temporarily set `dry_run = false` in the job,
set its cron a few minutes ahead in UTC, commit to `main`, and let the config sync
workflow update D1. Do not enable both GCP Cloud Scheduler and Cloudflare for real
dispatch at the same time. After the test, restore `cron_expr = "0 3 * * *"`; keep
`dry_run = false` only when Cloudflare is the selected production trigger.

Inspect the dispatch and Cloud Run result:

```bash
npx --yes wrangler@4 d1 execute uk_aq_cron_scheduler_ops_db --remote \
  --config cloudflare/scheduler/wrangler.toml --command \
  "select job_key, due_at, dispatch_status, response_status, response_preview from scheduler_dispatches where job_key = 'uk_aq_observs_partition_maintenance' order by due_at desc limit 10"
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="uk-aq-observs-partition-maintenance-service"' \
  --project "${GCP_PROJECT_ID}" --limit 50 --format json
```

## SQL prerequisites

Apply in obs_aqidb:
- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql`

The service expects these RPCs to exist:
- `uk_aq_public.uk_aq_rpc_observs_ensure_daily_partitions`
- `uk_aq_public.uk_aq_rpc_observs_enforce_hot_cold_indexes`
- `uk_aq_public.uk_aq_rpc_observs_observations_default_diagnostics`
- `uk_aq_public.uk_aq_rpc_observs_drop_candidates`
- `uk_aq_public.uk_aq_rpc_observs_drop_partition`
- `uk_aq_public.uk_aq_rpc_obs_aqidb_day_count_delete`
- `uk_aq_public.uk_aq_rpc_observs_day_has_rows`
- `uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint` (fallback when `day_has_rows` is unavailable in schema cache)

Partition DDL RPCs should run with explicit SQL timeouts:
- `uk_aq_rpc_observs_ensure_daily_partitions`
- `uk_aq_rpc_observs_enforce_hot_cold_indexes`
- `statement_timeout = '15min'`
- `lock_timeout = '5s'`

Worker retry behavior:
- transient DDL lock conflicts (`lock timeout`, `deadlock detected`, serialization retries, statement-timeout cancellation) are retried up to `3` times
- retry delay is linear backoff starting at `1500 ms`
