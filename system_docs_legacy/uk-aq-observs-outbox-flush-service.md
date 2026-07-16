# uk-aq-observs-outbox-flush-service setup (Cloud Run + Scheduler)

This deploys a dedicated Cloud Run service that flushes the ingest DB observs outbox into `obs_aqidb` (`uk_aq_observs`).

Runtime behavior notes:

- Flush claims outbox entries, de-duplicates rows by `(connector_id, timeseries_id, observed_at)`, and upserts to `uk_aq_observs`.
- Observs upsert is timeout-safe: transient retry plus recursive split on statement timeout before marking an entry failed.

## 1) Set variables

```bash
export PROJECT_ID="your-project-id"
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export REGION="europe-west2"

export SERVICE_NAME="uk-aq-observs-outbox-flush-service"
export JOB_NAME="uk-aq-observs-outbox-flush-trigger"

export OPS_SA_NAME="uk-aq-ops-job"
export OPS_SA_EMAIL="${OPS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

export SUPABASE_URL="https://YOUR_INGEST_PROJECT.supabase.co"
export OBS_AQIDB_SUPABASE_URL="https://YOUR_OBS_AQIDB_PROJECT.supabase.co"
```

## 2) Ensure runtime service account exists

```bash
gcloud iam service-accounts create "$OPS_SA_NAME" \
  --project "$PROJECT_ID" \
  --display-name "UK AQ Ops Job"
```

If it already exists, this step will fail harmlessly and you can continue.

## 3) Grant secret access for runtime

```bash
gcloud secrets add-iam-policy-binding SB_SECRET_KEY \
  --project "$PROJECT_ID" \
  --member "serviceAccount:${OPS_SA_EMAIL}" \
  --role "roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding OBS_AQIDB_SECRET_KEY \
  --project "$PROJECT_ID" \
  --member "serviceAccount:${OPS_SA_EMAIL}" \
  --role "roles/secretmanager.secretAccessor"
```

## 4) Deploy Cloud Run service

From the `uk-aq-ops` repo root:

```bash
gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source . \
  --command node \
  --args workers/uk_aq_observs_outbox_flush_service/server.mjs \
  --service-account "$OPS_SA_EMAIL" \
  --no-allow-unauthenticated \
  --cpu 1 \
  --memory 256Mi \
  --min-instances 0 \
  --no-cpu-boost \
  --max-instances 1 \
  --set-env-vars "SUPABASE_URL=${SUPABASE_URL},OBS_AQIDB_SUPABASE_URL=${OBS_AQIDB_SUPABASE_URL},FLUSH_CLAIM_BATCH_LIMIT=20,MAX_FLUSH_BATCHES=30" \
  --set-secrets "SB_SECRET_KEY=SB_SECRET_KEY:latest,OBS_AQIDB_SECRET_KEY=OBS_AQIDB_SECRET_KEY:latest" \
  --labels "job_name=${SERVICE_NAME},service_name=${SERVICE_NAME}"
```

## 5) Allow scheduler invocation

```bash
gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --member "serviceAccount:${OPS_SA_EMAIL}" \
  --role "roles/run.invoker"
```

## 6) Allow Cloud Scheduler service agent to mint OIDC token for ops SA

```bash
gcloud iam service-accounts add-iam-policy-binding "$OPS_SA_EMAIL" \
  --project "$PROJECT_ID" \
  --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role "roles/iam.serviceAccountTokenCreator"
```

## 7) Create scheduler job (every 10 minutes, UTC)

```bash
export SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"

gcloud scheduler jobs create http "$JOB_NAME" \
  --project "$PROJECT_ID" \
  --location "$REGION" \
  --schedule "*/10 * * * *" \
  --time-zone "UTC" \
  --uri "${SERVICE_URL}/run" \
  --http-method POST \
  --oidc-service-account-email "$OPS_SA_EMAIL" \
  --oidc-token-audience "$SERVICE_URL" \
  --headers "Content-Type=application/json" \
  --message-body '{}'
```

If it already exists:

```bash
gcloud scheduler jobs update http "$JOB_NAME" \
  --project "$PROJECT_ID" \
  --location "$REGION" \
  --schedule "*/10 * * * *" \
  --time-zone "UTC" \
  --uri "${SERVICE_URL}/run" \
  --http-method POST \
  --oidc-service-account-email "$OPS_SA_EMAIL" \
  --oidc-token-audience "$SERVICE_URL" \
  --headers "Content-Type=application/json" \
  --message-body '{}'
```

## 8) Ad-hoc run

```bash
curl -X POST "${SERVICE_URL}/run" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=${SERVICE_URL})"
```

## 9) GitHub Actions deploy workflow

Workflow path:

- `.github/workflows/uk_aq_observs_outbox_flush_service_cloud_run_deploy.yml`

Required GitHub repo variables:

- `GCP_PROJECT_ID`
- `SUPABASE_URL`
- `OBS_AQIDB_SUPABASE_URL`
- `GCP_WORKLOAD_IDENTITY_PROVIDER` (recommended)
- `GCP_SERVICE_ACCOUNT` (recommended)

Optional GitHub repo variables:

- `GCP_REGION` (default `europe-west2`)
- `GCP_ARTIFACT_REPO` (default `uk-aq`)
- `OBSERVS_OUTBOX_FLUSH_SERVICE_NAME` (default `uk-aq-observs-outbox-flush-service`)
- `OBSERVS_OUTBOX_FLUSH_RUNTIME_SERVICE_ACCOUNT` (default `uk-aq-ops-job@<project>.iam.gserviceaccount.com`)
- `OBSERVS_OUTBOX_FLUSH_SCHEDULER_SERVICE_ACCOUNT` (default runtime SA)
- `GCP_OBSERVS_OUTBOX_SCHEDULER_ENABLED` (default `true`)
- `OBSERVS_OUTBOX_FLUSH_SCHEDULER_ENABLED` (default `true`, optional alternative to `GCP_OBSERVS_OUTBOX_SCHEDULER_ENABLED`)
- `OBSERVS_OUTBOX_FLUSH_SCHEDULER_JOB_NAME` (default `uk-aq-observs-outbox-flush-trigger`)
- `OBSERVS_OUTBOX_FLUSH_SCHEDULER_CRON` (default `*/10 * * * *`)
- `OBSERVS_OUTBOX_FLUSH_SCHEDULER_TIMEZONE` (default `Etc/UTC`)
- `OBSERVS_OUTBOX_FLUSH_SCHEDULER_MAX_RETRY_ATTEMPTS` (default `0`)
- `OBSERVS_OUTBOX_FLUSH_CLAIM_BATCH_LIMIT` (default `20`)
- `OBSERVS_OUTBOX_FLUSH_MAX_FLUSH_BATCHES` (default `30`)
- `SB_SECRET_KEY_SECRET_NAME` (default `SB_SECRET_KEY`)
- `OBS_AQIDB_SECRET_KEY_SECRET_NAME` (default `OBS_AQIDB_SECRET_KEY`)

Optional fallback GitHub secret:

- `GCP_SA_KEY` (only needed when not using Workload Identity Federation)
