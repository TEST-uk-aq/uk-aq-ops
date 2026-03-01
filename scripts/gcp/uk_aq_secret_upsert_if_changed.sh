#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  uk_aq_secret_upsert_if_changed.sh --project <id> --secret <name> [options]

Reads secret value from stdin and only adds a new Secret Manager version when
the content hash has changed.

Options:
  --project <id>          GCP project id (required)
  --secret <name>         Secret name (required)
  --required <0|1>        Treat empty stdin as error when 1 (default: 0)
  --hash-label <key>      Metadata label key for hash (default: ukaq_hash)
  --hash-len <n>          Hash prefix length (default: 40)
  --dry-run               Print planned action without changing GCP
  -h, --help              Show help
USAGE
}

PROJECT_ID=""
SECRET_NAME=""
REQUIRED="0"
HASH_LABEL="ukaq_hash"
HASH_LEN="40"
DRY_RUN="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --secret)
      SECRET_NAME="${2:-}"
      shift 2
      ;;
    --required)
      REQUIRED="${2:-0}"
      shift 2
      ;;
    --hash-label)
      HASH_LABEL="${2:-}"
      shift 2
      ;;
    --hash-len)
      HASH_LEN="${2:-40}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${PROJECT_ID}" || -z "${SECRET_NAME}" ]]; then
  echo "--project and --secret are required." >&2
  usage >&2
  exit 2
fi

if [[ "${REQUIRED}" != "0" && "${REQUIRED}" != "1" ]]; then
  echo "--required must be 0 or 1." >&2
  exit 2
fi

if ! [[ "${HASH_LEN}" =~ ^[0-9]+$ ]] || (( HASH_LEN < 8 || HASH_LEN > 63 )); then
  echo "--hash-len must be an integer between 8 and 63." >&2
  exit 2
fi

SECRET_VALUE="$(cat)"

if [[ -z "${SECRET_VALUE}" ]]; then
  if [[ "${REQUIRED}" == "1" ]]; then
    echo "Missing required secret value for ${SECRET_NAME}." >&2
    exit 1
  fi
  echo "skip ${SECRET_NAME}: optional value is empty"
  exit 0
fi

hash_secret_value() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "${SECRET_VALUE}" | sha256sum | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "${SECRET_VALUE}" | shasum -a 256 | awk '{print $1}'
    return 0
  fi
  echo "No SHA256 tool found (sha256sum/shasum)." >&2
  return 1
}

NEW_HASH="$(hash_secret_value)"
NEW_HASH="${NEW_HASH:0:${HASH_LEN}}"

exists="0"
if gcloud secrets describe "${SECRET_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  exists="1"
fi

if [[ "${exists}" == "0" ]]; then
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "dry-run create ${SECRET_NAME} (hash label ${HASH_LABEL}=${NEW_HASH})"
    exit 0
  fi
  printf '%s' "${SECRET_VALUE}" | gcloud secrets create "${SECRET_NAME}" \
    --project "${PROJECT_ID}" \
    --replication-policy="automatic" \
    --labels "${HASH_LABEL}=${NEW_HASH}" \
    --data-file=-
  echo "created ${SECRET_NAME}"
  exit 0
fi

CURRENT_HASH="$(gcloud secrets describe "${SECRET_NAME}" \
  --project "${PROJECT_ID}" \
  --format="value(labels.${HASH_LABEL})" 2>/dev/null || true)"

if [[ -n "${CURRENT_HASH}" && "${CURRENT_HASH}" == "${NEW_HASH}" ]]; then
  echo "skip ${SECRET_NAME}: content hash unchanged"
  exit 0
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "dry-run update ${SECRET_NAME}: add version + set ${HASH_LABEL}=${NEW_HASH}"
  exit 0
fi

printf '%s' "${SECRET_VALUE}" | gcloud secrets versions add "${SECRET_NAME}" \
  --project "${PROJECT_ID}" \
  --data-file=-
gcloud secrets update "${SECRET_NAME}" \
  --project "${PROJECT_ID}" \
  --update-labels "${HASH_LABEL}=${NEW_HASH}" >/dev/null
echo "updated ${SECRET_NAME}: new version created"
