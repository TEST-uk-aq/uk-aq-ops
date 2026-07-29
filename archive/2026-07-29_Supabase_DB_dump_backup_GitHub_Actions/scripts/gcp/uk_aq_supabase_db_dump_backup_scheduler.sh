#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Create or update the Cloud Scheduler job for the uk_aq Supabase DB dump backup service.

Required environment variables:
  PROJECT_ID

Optional environment variables:
  REGION                         Default: europe-west2
  SERVICE_NAME                   Default: uk-aq-supabase-db-dump-backup-service
  JOB_NAME                       Default: SERVICE_NAME with trailing -service replaced by -trigger
  INVOKER_SA_NAME                Default: uk-aq-db-dump-backup-invoker
  SCHEDULE                       Default: 55 0 * * *
  TIME_ZONE                      Default: UTC
  ATTEMPT_DEADLINE               Default: 1800s
  MAX_RETRY_ATTEMPTS             Default: 0
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PROJECT_ID="${PROJECT_ID:-}"
if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is required." >&2
  usage >&2
  exit 2
fi

REGION="${REGION:-europe-west2}"
SERVICE_NAME="${SERVICE_NAME:-uk-aq-supabase-db-dump-backup-service}"
JOB_NAME="${JOB_NAME:-}"
if [[ -z "${JOB_NAME}" ]]; then
  JOB_NAME="${SERVICE_NAME}"
  if [[ "${JOB_NAME}" == *-service ]]; then
    JOB_NAME="${JOB_NAME%-service}-trigger"
  else
    JOB_NAME="${JOB_NAME}-trigger"
  fi
fi
INVOKER_SA_NAME="${INVOKER_SA_NAME:-uk-aq-db-dump-backup-invoker}"
SCHEDULE="${SCHEDULE:-55 0 * * *}"
TIME_ZONE="${TIME_ZONE:-UTC}"
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-1800s}"
MAX_RETRY_ATTEMPTS="${MAX_RETRY_ATTEMPTS:-0}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
INVOKER_SA_EMAIL="${INVOKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"

echo "Granting Cloud Scheduler service agent token minting on ${INVOKER_SA_EMAIL}..."
gcloud iam service-accounts add-iam-policy-binding "${INVOKER_SA_EMAIL}" \
  --project "${PROJECT_ID}" \
  --member "serviceAccount:${SCHEDULER_AGENT}" \
  --role "roles/iam.serviceAccountTokenCreator" >/dev/null

if gcloud scheduler jobs describe "${JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" >/dev/null 2>&1; then
  echo "Updating Scheduler job ${JOB_NAME}..."
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --schedule "${SCHEDULE}" \
    --time-zone "${TIME_ZONE}" \
    --uri "${SERVICE_URL}/run-backup" \
    --http-method POST \
    --headers "Content-Type=application/json" \
    --message-body '{"trigger_mode":"scheduler"}' \
    --oidc-service-account-email "${INVOKER_SA_EMAIL}" \
    --oidc-token-audience "${SERVICE_URL}" \
    --attempt-deadline "${ATTEMPT_DEADLINE}" \
    --max-retry-attempts "${MAX_RETRY_ATTEMPTS}"
else
  echo "Creating Scheduler job ${JOB_NAME}..."
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --schedule "${SCHEDULE}" \
    --time-zone "${TIME_ZONE}" \
    --uri "${SERVICE_URL}/run-backup" \
    --http-method POST \
    --headers "Content-Type=application/json" \
    --message-body '{"trigger_mode":"scheduler"}' \
    --oidc-service-account-email "${INVOKER_SA_EMAIL}" \
    --oidc-token-audience "${SERVICE_URL}" \
    --attempt-deadline "${ATTEMPT_DEADLINE}" \
    --max-retry-attempts "${MAX_RETRY_ATTEMPTS}"
fi

cat <<EOF
Scheduler configured.

Service URL: ${SERVICE_URL}
Job name: ${JOB_NAME}
Schedule: ${SCHEDULE}
Time zone: ${TIME_ZONE}
Invoker service account: ${INVOKER_SA_EMAIL}
EOF
