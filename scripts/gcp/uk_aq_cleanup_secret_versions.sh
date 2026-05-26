#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  uk_aq_cleanup_secret_versions.sh --project <id> [options]

Destroy old Secret Manager versions so each secret keeps one active version.
Default mode is dry-run; pass --apply to make changes.

Options:
  --project <id>                GCP project id (required)
  --region <region>             Cloud Run region for pin checks (default: europe-west2)
  --secret <name>               Only process this secret (repeatable)
  --fix-cloud-run-pins <0|1>    In apply mode, update numeric Cloud Run refs to latest (default: 0)
  --dry-run                     Explicit dry-run mode (default)
  --apply                       Apply mode (destroy old versions)
  -h, --help                    Show help
USAGE
}

PROJECT_ID=""
REGION="europe-west2"
MODE="dry-run"
FIX_CLOUD_RUN_PINS="0"
declare -a ONLY_SECRETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --secret)
      ONLY_SECRETS+=("${2:-}")
      shift 2
      ;;
    --fix-cloud-run-pins)
      FIX_CLOUD_RUN_PINS="${2:-0}"
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

if [[ -z "${PROJECT_ID}" ]]; then
  echo "--project is required." >&2
  usage >&2
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
  local secret="$1"
  local refs_file="$2"

  local numeric_file
  numeric_file="$(mktemp)"
  grep -E $'\t[0-9]+$' "${refs_file}" > "${numeric_file}" || true
  local pin_count
  pin_count="$(wc -l < "${numeric_file}" | tr -d ' ')"

  if [[ "${pin_count}" == "0" ]]; then
    echo "${secret}: cloud_run_numeric_pins=0"
    rm -f "${numeric_file}"
    return 0
  fi

  echo "${secret}: cloud_run_numeric_pins=${pin_count}"

  if [[ "${FIX_CLOUD_RUN_PINS}" != "1" ]]; then
    echo "${secret}: numeric pins found; skipping (use --fix-cloud-run-pins 1 to auto-fix)."
    rm -f "${numeric_file}"
    return 2
  fi

  local grouped_file
  grouped_file="$(mktemp)"
  awk -F'\t' '{
    k=$1"\t"$2
    u=$3"='"${secret}"':latest"
    if (m[k]=="") m[k]=u; else m[k]=m[k]","u
  } END {for (k in m) print k"\t"m[k]}' "${numeric_file}" > "${grouped_file}"

  while IFS=$'\t' read -r svc region updates; do
    [[ -z "${svc}" || -z "${updates}" ]] && continue
    if [[ "${MODE}" == "dry-run" ]]; then
      echo "${secret}: dry-run would update service ${svc} (${region}) secret refs to latest."
      continue
    fi
    gcloud run services update "${svc}" \
      --platform managed \
      --project "${PROJECT_ID}" \
      --region "${region}" \
      --update-secrets "${updates}" \
      --quiet >/dev/null
    echo "${secret}: updated service ${svc} (${region}) secret refs to latest."
  done < "${grouped_file}"

  rm -f "${grouped_file}" "${numeric_file}"

  if [[ "${MODE}" == "apply" ]]; then
    local verify_file
    verify_file="$(mktemp)"
    collect_secret_refs "${PROJECT_ID}" "${REGION}" "${secret}" > "${verify_file}" || true
    if has_numeric_pin_lines "${verify_file}"; then
      rm -f "${verify_file}"
      echo "${secret}: numeric pins still present after attempted update." >&2
      return 1
    fi
    rm -f "${verify_file}"
  fi

  return 0
}

declare -a secrets=()
if [[ ${#ONLY_SECRETS[@]} -gt 0 ]]; then
  secrets=("${ONLY_SECRETS[@]}")
else
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    secrets+=("${name}")
  done < <(gcloud secrets list --project "${PROJECT_ID}" --format='value(name)')
fi

if [[ ${#secrets[@]} -eq 0 ]]; then
  echo "No secrets found in project ${PROJECT_ID}."
  exit 0
fi

processed=0
skipped=0
would_destroy_total=0
destroyed_total=0

for secret in "${secrets[@]}"; do
  echo
  echo "== ${secret} =="

  lines="$(gcloud secrets versions list "${secret}" \
    --project "${PROJECT_ID}" \
    --filter='state!=DESTROYED' \
    --sort-by='~createTime' \
    --format='value(name,state)' 2>/dev/null || true)"

  if [[ -z "${lines}" ]]; then
    echo "${secret}: no active versions"
    skipped=$((skipped + 1))
    continue
  fi

  echo "${secret}: active_versions_now"
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    vid="$(printf '%s' "${line}" | awk '{print $1}' | awk -F'/' '{print $NF}')"
    state="$(printf '%s' "${line}" | awk '{print $2}')"
    echo "  version=${vid} state=${state}"
  done <<< "${lines}"

  keep_full="$(gcloud secrets versions list "${secret}" \
    --project "${PROJECT_ID}" \
    --filter='state=ENABLED' \
    --sort-by='~createTime' \
    --limit=1 \
    --format='value(name)' 2>/dev/null || true)"

  if [[ -n "${keep_full}" ]]; then
    keep_version="${keep_full##*/}"
  else
    keep_version="$(printf '%s\n' "${lines}" | head -n1 | awk '{print $1}' | awk -F'/' '{print $NF}')"
    echo "${secret}: no ENABLED version found; keeping newest active version ${keep_version}."
  fi

  refs_file="$(mktemp)"
  collect_secret_refs "${PROJECT_ID}" "${REGION}" "${secret}" > "${refs_file}" || true
  if ! fix_numeric_pins_if_needed "${secret}" "${refs_file}"; then
    rm -f "${refs_file}"
    skipped=$((skipped + 1))
    continue
  fi
  rm -f "${refs_file}"

  declare -a destroy_versions=()
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    vid="$(printf '%s' "${line}" | awk '{print $1}' | awk -F'/' '{print $NF}')"
    [[ "${vid}" == "${keep_version}" ]] && continue
    destroy_versions+=("${vid}")
  done <<< "${lines}"

  if [[ ${#destroy_versions[@]} -eq 0 ]]; then
    echo "${secret}: old_versions_to_destroy=none"
    echo "${secret}: active_versions_after=1"
    processed=$((processed + 1))
    continue
  fi

  echo "${secret}: keep_version=${keep_version}"
  echo "${secret}: old_versions_to_destroy=$(IFS=,; echo "${destroy_versions[*]}")"
  would_destroy_total=$((would_destroy_total + ${#destroy_versions[@]}))

  if [[ "${MODE}" == "dry-run" ]]; then
    echo "${secret}: dry-run active_versions_after=1"
    processed=$((processed + 1))
    continue
  fi

  for vid in "${destroy_versions[@]}"; do
    gcloud secrets versions destroy "${vid}" \
      --secret "${secret}" \
      --project "${PROJECT_ID}" \
      --quiet >/dev/null
    echo "${secret}: destroyed version ${vid}"
    destroyed_total=$((destroyed_total + 1))
  done

  remain="$(gcloud secrets versions list "${secret}" \
    --project "${PROJECT_ID}" \
    --filter='state!=DESTROYED' \
    --format='value(name)' | wc -l | tr -d ' ')"
  if [[ "${remain}" != "1" ]]; then
    echo "${secret}: expected 1 active version after cleanup, found ${remain}." >&2
    exit 1
  fi

  echo "${secret}: active_versions_after=1"
  processed=$((processed + 1))
done

echo
if [[ "${MODE}" == "dry-run" ]]; then
  echo "Dry run complete: processed=${processed} skipped=${skipped} would_destroy=${would_destroy_total}"
else
  echo "Apply complete: processed=${processed} skipped=${skipped} destroyed=${destroyed_total}"
fi
