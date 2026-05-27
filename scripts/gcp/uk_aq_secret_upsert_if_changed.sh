#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  uk_aq_secret_upsert_if_changed.sh --project <id> --secret <name> [options]

Reads secret value from stdin and updates Secret Manager safely.
Default mode is dry-run; pass --apply to make changes.

Behavior:
- If secret value is unchanged vs latest enabled version: no new version is created.
- If changed: create a new version, then destroy older active versions.
- After apply, exactly one active version remains for the secret.

Options:
  --project <id>                GCP project id (required)
  --secret <name>               Secret name (required)
  --required <0|1>              Treat empty stdin as error when 1 (default: 0)
  --region <region>             Cloud Run region for numeric pin checks (default: europe-west2)
  --fix-cloud-run-pins <0|1>    In apply mode, update numeric Cloud Run secret refs to latest (default: 1)
  --dry-run                     Explicit dry-run mode
  --apply                       Apply mode (create/destroy/update)
  -h, --help                    Show help

Notes:
- Stdin is read via command substitution to match existing behavior for trailing newlines.
- Secret payload values are never printed.
USAGE
}

PROJECT_ID=""
SECRET_NAME=""
REQUIRED="0"
MODE="dry-run"
REGION="europe-west2"
FIX_CLOUD_RUN_PINS="1"

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
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --fix-cloud-run-pins)
      FIX_CLOUD_RUN_PINS="${2:-1}"
      shift 2
      ;;
    --dry-run)
      MODE="dry-run"
      shift
      ;;
    --apply)
      MODE="apply"
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
if [[ "${FIX_CLOUD_RUN_PINS}" != "0" && "${FIX_CLOUD_RUN_PINS}" != "1" ]]; then
  echo "--fix-cloud-run-pins must be 0 or 1." >&2
  exit 2
fi
if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required." >&2
  exit 1
fi

SECRET_VALUE="$(cat)"
if [[ -z "${SECRET_VALUE}" ]]; then
  if [[ "${REQUIRED}" == "1" ]]; then
    echo "${SECRET_NAME}: missing required secret value." >&2
    exit 1
  fi
  echo "${SECRET_NAME}: optional value empty; no action."
  exit 0
fi

sha256_from_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r | awk '{print $1}'
    return 0
  fi
  echo "No sha256 tool available." >&2
  return 1
}

collect_secret_refs() {
  local project="$1"
  local region="$2"
  local secret="$3"

  gcloud run services list \
    --platform managed \
    --project "${project}" \
    --region "${region}" \
    --format='value(metadata.name)' 2>/dev/null | \
  while IFS= read -r svc; do
    [[ -z "${svc}" ]] && continue
    gcloud run services describe "${svc}" \
      --platform managed \
      --project "${project}" \
      --region "${region}" \
      --format=json 2>/dev/null | \
      jq -r --arg svc "${svc}" --arg region "${region}" --arg secret "${secret}" '
        .spec.template.spec.containers[]?.env[]?
        | select(.valueFrom.secretKeyRef!=null)
        | select(.valueFrom.secretKeyRef.name == $secret)
        | [$svc, $region, .name, (.valueFrom.secretKeyRef.key // "")]
        | @tsv'
  done
}

has_numeric_pin_lines() {
  local file="$1"
  grep -Eq $'\t[0-9]+$' "${file}"
}

fix_numeric_pins_if_needed() {
  local refs_file="$1"
  local numeric_file="$2"

  grep -E $'\t[0-9]+$' "${refs_file}" > "${numeric_file}" || true
  local pin_count
  pin_count="$(wc -l < "${numeric_file}" | tr -d ' ')"

  if [[ "${pin_count}" == "0" ]]; then
    echo "${SECRET_NAME}: cloud_run_numeric_pins=0"
    return 0
  fi

  echo "${SECRET_NAME}: cloud_run_numeric_pins=${pin_count}"

  if [[ "${FIX_CLOUD_RUN_PINS}" != "1" ]]; then
    echo "${SECRET_NAME}: numeric pin fix disabled; refusing to continue." >&2
    return 1
  fi

  local grouped_file
  grouped_file="$(mktemp)"
  awk -F'\t' '{
    k=$1"\t"$2
    u=$3"='"${SECRET_NAME}"':latest"
    if (m[k]=="") m[k]=u; else m[k]=m[k]","u
  } END {for (k in m) print k"\t"m[k]}' "${numeric_file}" > "${grouped_file}"

  while IFS=$'\t' read -r svc region updates; do
    [[ -z "${svc}" || -z "${updates}" ]] && continue
    if [[ "${MODE}" == "dry-run" ]]; then
      echo "${SECRET_NAME}: dry-run would update service ${svc} (${region}) secret refs to latest."
      continue
    fi
    gcloud run services update "${svc}" \
      --platform managed \
      --project "${PROJECT_ID}" \
      --region "${region}" \
      --update-secrets "${updates}" \
      --quiet >/dev/null
    echo "${SECRET_NAME}: updated service ${svc} (${region}) secret refs to latest."
  done < "${grouped_file}"

  rm -f "${grouped_file}"

  if [[ "${MODE}" == "apply" ]]; then
    local verify_file
    verify_file="$(mktemp)"
    collect_secret_refs "${PROJECT_ID}" "${REGION}" "${SECRET_NAME}" > "${verify_file}" || true
    if has_numeric_pin_lines "${verify_file}"; then
      rm -f "${verify_file}"
      echo "${SECRET_NAME}: numeric pins still present after attempted update." >&2
      return 1
    fi
    rm -f "${verify_file}"
  fi

  return 0
}

list_active_versions_desc() {
  gcloud secrets versions list "${SECRET_NAME}" \
    --project "${PROJECT_ID}" \
    --filter='state!=DESTROYED' \
    --sort-by='~createTime' \
    --format='value(name,state)'
}

NEW_HASH="$(printf '%s' "${SECRET_VALUE}" | sha256_from_stdin)"

secret_exists="0"
if gcloud secrets describe "${SECRET_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  secret_exists="1"
fi

refs_file="$(mktemp)"
numeric_file="$(mktemp)"
trap 'rm -f "${refs_file}" "${numeric_file}"' EXIT
collect_secret_refs "${PROJECT_ID}" "${REGION}" "${SECRET_NAME}" > "${refs_file}" || true

if [[ "${secret_exists}" == "0" ]]; then
  echo "${SECRET_NAME}: value_changed=yes"
  echo "${SECRET_NAME}: would_create_new_version=yes"
  echo "${SECRET_NAME}: old_versions_to_destroy=none"
  echo "${SECRET_NAME}: active_versions_after=1"
  fix_numeric_pins_if_needed "${refs_file}" "${numeric_file}"

  if [[ "${MODE}" == "dry-run" ]]; then
    exit 0
  fi

  printf '%s' "${SECRET_VALUE}" | gcloud secrets create "${SECRET_NAME}" \
    --project "${PROJECT_ID}" \
    --replication-policy='automatic' \
    --data-file=- >/dev/null

  active_after="$(gcloud secrets versions list "${SECRET_NAME}" --project "${PROJECT_ID}" --filter='state!=DESTROYED' --format='value(name)' | wc -l | tr -d ' ')"
  if [[ "${active_after}" != "1" ]]; then
    echo "${SECRET_NAME}: expected 1 active version after create, found ${active_after}." >&2
    exit 1
  fi

  echo "${SECRET_NAME}: created with one active version."
  exit 0
fi

latest_enabled_full="$(gcloud secrets versions list "${SECRET_NAME}" \
  --project "${PROJECT_ID}" \
  --filter='state=ENABLED' \
  --sort-by='~createTime' \
  --limit=1 \
  --format='value(name)' 2>/dev/null || true)"

if [[ -z "${latest_enabled_full}" ]]; then
  echo "${SECRET_NAME}: no enabled version found; cannot safely compare or continue." >&2
  exit 1
fi

latest_id="${latest_enabled_full##*/}"
current_payload_b64="$(gcloud secrets versions access "${latest_id}" \
  --secret "${SECRET_NAME}" \
  --project "${PROJECT_ID}" \
  --format='get(payload.data)' 2>/dev/null || true)"

if [[ -z "${current_payload_b64}" ]]; then
  echo "${SECRET_NAME}: unable to access latest enabled version for safe comparison." >&2
  exit 1
fi

CURRENT_HASH="$(python3 - "${current_payload_b64}" <<'PY'
import base64
import hashlib
import sys

b64 = sys.argv[1].strip()
pad = '=' * (-len(b64) % 4)
raw = base64.urlsafe_b64decode((b64 + pad).encode('ascii'))
print(hashlib.sha256(raw).hexdigest())
PY
)"

if [[ -z "${CURRENT_HASH}" ]]; then
  echo "${SECRET_NAME}: unable to compute current secret hash." >&2
  exit 1
fi

changed="yes"
if [[ "${CURRENT_HASH}" == "${NEW_HASH}" ]]; then
  changed="no"
fi

active_lines="$(list_active_versions_desc || true)"
if [[ -z "${active_lines}" ]]; then
  echo "${SECRET_NAME}: no active versions found; cannot safely continue." >&2
  exit 1
fi

keep_version="${latest_id}"

if [[ "${changed}" == "no" ]]; then
  echo "${SECRET_NAME} unchanged; no new version created."
else
  echo "${SECRET_NAME}: value_changed=yes"
fi

would_create="no"
if [[ "${changed}" == "yes" ]]; then
  would_create="yes"
fi

planned_destroy=()
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  version_path="$(printf '%s' "${line}" | awk '{print $1}')"
  version_id="${version_path##*/}"
  [[ "${version_id}" == "${keep_version}" ]] && continue
  planned_destroy+=("${version_id}")
done <<< "${active_lines}"

echo "${SECRET_NAME}: would_create_new_version=${would_create}"
if [[ ${#planned_destroy[@]} -eq 0 ]]; then
  echo "${SECRET_NAME}: old_versions_to_destroy=none"
else
  echo "${SECRET_NAME}: old_versions_to_destroy=$(IFS=,; echo "${planned_destroy[*]}")"
fi
fix_numeric_pins_if_needed "${refs_file}" "${numeric_file}"

if [[ "${MODE}" == "dry-run" ]]; then
  if [[ "${would_create}" == "yes" ]]; then
    echo "${SECRET_NAME}: active_versions_after=1 (after create + prune)"
  else
    echo "${SECRET_NAME}: active_versions_after=1 (after prune)"
  fi
  exit 0
fi

if [[ "${changed}" == "yes" ]]; then
  printf '%s' "${SECRET_VALUE}" | gcloud secrets versions add "${SECRET_NAME}" \
    --project "${PROJECT_ID}" \
    --data-file=- >/dev/null

  latest_enabled_full="$(gcloud secrets versions list "${SECRET_NAME}" \
    --project "${PROJECT_ID}" \
    --filter='state=ENABLED' \
    --sort-by='~createTime' \
    --limit=1 \
    --format='value(name)')"
  keep_version="${latest_enabled_full##*/}"
  echo "${SECRET_NAME}: created new version ${keep_version}."
fi

active_lines_after="$(list_active_versions_desc)"
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  version_path="$(printf '%s' "${line}" | awk '{print $1}')"
  version_id="${version_path##*/}"
  [[ "${version_id}" == "${keep_version}" ]] && continue
  gcloud secrets versions destroy "${version_id}" \
    --project "${PROJECT_ID}" \
    --secret "${SECRET_NAME}" \
    --quiet >/dev/null
  echo "${SECRET_NAME}: destroyed older active version ${version_id}."
done <<< "${active_lines_after}"

active_remaining="$(gcloud secrets versions list "${SECRET_NAME}" \
  --project "${PROJECT_ID}" \
  --filter='state!=DESTROYED' \
  --format='value(name)' | wc -l | tr -d ' ')"

if [[ "${active_remaining}" != "1" ]]; then
  echo "${SECRET_NAME}: expected exactly one active version remaining, found ${active_remaining}." >&2
  exit 1
fi

echo "${SECRET_NAME}: active_versions_after=1"
echo "${SECRET_NAME}: safe update complete."
