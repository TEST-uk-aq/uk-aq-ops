#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Build and deploy the uk_aq Supabase DB dump backup Cloud Run service.

Required environment variables:
  PROJECT_ID
  UK_AQ_DROPBOX_ROOT

Optional environment variables:
  REGION                               Default: europe-west2
  SERVICE_NAME                         Default: uk-aq-supabase-db-dump-backup-service
  ARTIFACT_REPO                        Default: uk-aq
  IMAGE_NAME                           Default: uk-aq-supabase-db-dump-backup-service
  IMAGE_TAG                            Default: UTC timestamp
  RUNTIME_SA_NAME                      Default: uk-aq-db-dump-backup-runtime
  INVOKER_SA_NAME                      Default: uk-aq-db-dump-backup-invoker
  SERVICE_CPU                          Default: 2
  SERVICE_MEMORY                       Default: 2Gi
  SERVICE_TIMEOUT_SECONDS              Default: 1800
  SERVICE_MAX_INSTANCES                Default: 1
  SERVICE_MIN_INSTANCES                Default: 0
  SERVICE_CONCURRENCY                  Default: 1
  SERVICE_INGRESS                      Default: internal
  UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR    Default: Supabase_Backup_db_dump
  UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS Default: 7

Optional secret name overrides:
  UK_AQ_INGESTDB_DB_URL_SECRET_NAME    Default: UK_AQ_INGESTDB_DB_URL
  UK_AQ_OBS_AQIDB_DB_URL_SECRET_NAME   Default: UK_AQ_OBS_AQIDB_DB_URL
  DROPBOX_APP_KEY_SECRET_NAME          Default: DROPBOX_APP_KEY
  DROPBOX_APP_SECRET_SECRET_NAME       Default: DROPBOX_APP_SECRET
  DROPBOX_REFRESH_TOKEN_SECRET_NAME    Default: DROPBOX_REFRESH_TOKEN
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PROJECT_ID="${PROJECT_ID:-}"
UK_AQ_DROPBOX_ROOT="${UK_AQ_DROPBOX_ROOT:-}"

if [[ -z "${PROJECT_ID}" || -z "${UK_AQ_DROPBOX_ROOT}" ]]; then
  echo "PROJECT_ID and UK_AQ_DROPBOX_ROOT are required." >&2
  usage >&2
  exit 2
fi

REGION="${REGION:-europe-west2}"
SERVICE_NAME="${SERVICE_NAME:-uk-aq-supabase-db-dump-backup-service}"
ARTIFACT_REPO="${ARTIFACT_REPO:-uk-aq}"
IMAGE_NAME="${IMAGE_NAME:-uk-aq-supabase-db-dump-backup-service}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-uk-aq-db-dump-backup-runtime}"
INVOKER_SA_NAME="${INVOKER_SA_NAME:-uk-aq-db-dump-backup-invoker}"
SERVICE_CPU="${SERVICE_CPU:-2}"
SERVICE_MEMORY="${SERVICE_MEMORY:-2Gi}"
SERVICE_TIMEOUT_SECONDS="${SERVICE_TIMEOUT_SECONDS:-1800}"
SERVICE_MAX_INSTANCES="${SERVICE_MAX_INSTANCES:-1}"
SERVICE_MIN_INSTANCES="${SERVICE_MIN_INSTANCES:-0}"
SERVICE_CONCURRENCY="${SERVICE_CONCURRENCY:-1}"
SERVICE_INGRESS="${SERVICE_INGRESS:-internal}"
UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR="${UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR:-Supabase_Backup_db_dump}"
UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS="${UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS:-7}"

UK_AQ_INGESTDB_DB_URL_SECRET_NAME="${UK_AQ_INGESTDB_DB_URL_SECRET_NAME:-UK_AQ_INGESTDB_DB_URL}"
UK_AQ_OBS_AQIDB_DB_URL_SECRET_NAME="${UK_AQ_OBS_AQIDB_DB_URL_SECRET_NAME:-UK_AQ_OBS_AQIDB_DB_URL}"
DROPBOX_APP_KEY_SECRET_NAME="${DROPBOX_APP_KEY_SECRET_NAME:-DROPBOX_APP_KEY}"
DROPBOX_APP_SECRET_SECRET_NAME="${DROPBOX_APP_SECRET_SECRET_NAME:-DROPBOX_APP_SECRET}"
DROPBOX_REFRESH_TOKEN_SECRET_NAME="${DROPBOX_REFRESH_TOKEN_SECRET_NAME:-DROPBOX_REFRESH_TOKEN}"

RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
INVOKER_SA_EMAIL="${INVOKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${IMAGE_NAME}:${IMAGE_TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DOCKERFILE_PATH="workers/uk_aq_supabase_db_dump_backup_service/Dockerfile"

ensure_service_account() {
  local account_name="$1"
  local display_name="$2"
  if gcloud iam service-accounts describe "${account_name}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --project "${PROJECT_ID}" >/dev/null 2>&1; then
    return 0
  fi
  gcloud iam service-accounts create "${account_name}" \
    --project "${PROJECT_ID}" \
    --display-name "${display_name}"
}

ensure_artifact_repo() {
  if gcloud artifacts repositories describe "${ARTIFACT_REPO}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" >/dev/null 2>&1; then
    return 0
  fi
  gcloud artifacts repositories create "${ARTIFACT_REPO}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --repository-format docker \
    --description "UK AQ ops container images"
}

grant_secret_access() {
  local secret_name="$1"
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role "roles/secretmanager.secretAccessor" >/dev/null
}

echo "Ensuring service accounts exist..."
ensure_service_account "${RUNTIME_SA_NAME}" "UK AQ DB dump backup runtime"
ensure_service_account "${INVOKER_SA_NAME}" "UK AQ DB dump backup invoker"

echo "Ensuring Artifact Registry repository exists..."
ensure_artifact_repo

echo "Granting runtime secret access..."
grant_secret_access "${UK_AQ_INGESTDB_DB_URL_SECRET_NAME}"
grant_secret_access "${UK_AQ_OBS_AQIDB_DB_URL_SECRET_NAME}"
grant_secret_access "${DROPBOX_APP_KEY_SECRET_NAME}"
grant_secret_access "${DROPBOX_APP_SECRET_SECRET_NAME}"
grant_secret_access "${DROPBOX_REFRESH_TOKEN_SECRET_NAME}"

echo "Building container image ${IMAGE_URI}..."
gcloud builds submit "${REPO_ROOT}" \
  --project "${PROJECT_ID}" \
  --tag "${IMAGE_URI}" \
  --file "${DOCKERFILE_PATH}"

echo "Deploying Cloud Run service ${SERVICE_NAME}..."
gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE_URI}" \
  --service-account "${RUNTIME_SA_EMAIL}" \
  --ingress "${SERVICE_INGRESS}" \
  --no-allow-unauthenticated \
  --cpu "${SERVICE_CPU}" \
  --memory "${SERVICE_MEMORY}" \
  --timeout "${SERVICE_TIMEOUT_SECONDS}s" \
  --concurrency "${SERVICE_CONCURRENCY}" \
  --max-instances "${SERVICE_MAX_INSTANCES}" \
  --min-instances "${SERVICE_MIN_INSTANCES}" \
  --set-env-vars "UK_AQ_DROPBOX_ROOT=${UK_AQ_DROPBOX_ROOT},UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR=${UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR},UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS=${UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS}" \
  --set-secrets "UK_AQ_INGESTDB_DB_URL=${UK_AQ_INGESTDB_DB_URL_SECRET_NAME}:latest,UK_AQ_OBS_AQIDB_DB_URL=${UK_AQ_OBS_AQIDB_DB_URL_SECRET_NAME}:latest,DROPBOX_APP_KEY=${DROPBOX_APP_KEY_SECRET_NAME}:latest,DROPBOX_APP_SECRET=${DROPBOX_APP_SECRET_SECRET_NAME}:latest,DROPBOX_REFRESH_TOKEN=${DROPBOX_REFRESH_TOKEN_SECRET_NAME}:latest" \
  --labels "service=${SERVICE_NAME},component=supabase-db-dump-backup"

echo "Granting Cloud Run invoke permission to ${INVOKER_SA_EMAIL}..."
gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --member "serviceAccount:${INVOKER_SA_EMAIL}" \
  --role "roles/run.invoker" >/dev/null

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)')"

cat <<EOF
Deploy complete.

Service URL: ${SERVICE_URL}
Runtime service account: ${RUNTIME_SA_EMAIL}
Invoker service account: ${INVOKER_SA_EMAIL}
Image: ${IMAGE_URI}
EOF
