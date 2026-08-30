#!/bin/bash
set -euo pipefail

# Strictly read-only verifier for an accepted post-cut-over steady-state
# observation-history v3 publication. This does not reuse the immutable-root
# assertion in index_v3_post_cutover_verify.sh.

usage() {
  cat <<'EOF'
Usage:
  index_v3_steady_state_post_write_verify.sh \
    --environment TEST|LIVE \
    --expected-repository OWNER/REPO \
    --expected-repository-git-sha SHA \
    --expected-acceptance-git-sha SHA \
    --expected-bucket BUCKET \
    --acceptance-report PATH \
    --expected-acceptance-report-sha256 SHA256 \
    --expected-run-id ID \
    --expected-day-utc YYYY-MM-DD \
    --expected-connector-id N \
    --expected-row-count N \
    --expected-source-content-hash SHA256 \
    --expected-source-hash-contract-version N \
    --expected-pollutant-count N \
    --plan-report PATH \
    --checkpoint PATH \
    --dropbox-root PATH \
    --writer-freeze-evidence PATH \
    --v2-runtime-rollback-record PATH \
    --required-unchanged-day YYYY-MM-DD \
    --site-url URL \
    --cache-url URL \
    --expected-station-history-worker NAME \
    --expected-observation-history-worker NAME \
    --report-out PATH \
    [--node-bin PATH]

Required loaded environment:
  UKAQ_ENV_NAME=v2 authority profile environment
  UK_AQ_R2_HISTORY_VERSION=v2
  UK_AQ_R2_HISTORY_INDEX_VERSION=v3
  UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2
  SUPABASE_DB_URL
  CFLARE_R2_ENDPOINT/CFLARE_R2_BUCKET/R2 credentials
  UK_AQ_CACHE_BYPASS_SECRET

The verifier performs Git/GitHub reads, PostgreSQL SELECTs, a D1 SELECT,
R2 GET/HEAD, local evidence reads, and HTTP GET probes only. It never starts
Prune or backup and never changes maintenance, schedulers, data, or config.
EOF
}

fail() {
  if [ -n "${REPORT_OUT:-}" ] && command -v jq >/dev/null 2>&1; then
    mkdir -p "$(dirname -- "$REPORT_OUT")" 2>/dev/null || true
    jq -n --arg error "$1" '{schema_version:1,kind:"index_v3_steady_state_post_write_verification",status:"FAIL",stage:"wrapper_preflight",mutation_performed:false,error:$error}' > "$REPORT_OUT" 2>/dev/null || true
  fi
  printf 'FAIL: %s\n' "$1" >&2
  printf 'STEADY-STATE POST-WRITE VERIFY FAILED. MAINTENANCE AND WRITER FREEZE REMAIN REQUIRED.\n' >&2
  exit 1
}

require_env() { [ -n "${!1:-}" ] || fail "required loaded environment value is missing: $1"; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"; }

ENVIRONMENT=""
EXPECTED_REPOSITORY=""
EXPECTED_REPOSITORY_GIT_SHA=""
EXPECTED_ACCEPTANCE_GIT_SHA=""
EXPECTED_BUCKET=""
ACCEPTANCE_REPORT=""
EXPECTED_ACCEPTANCE_REPORT_SHA256=""
EXPECTED_RUN_ID=""
EXPECTED_DAY_UTC=""
EXPECTED_CONNECTOR_ID=""
EXPECTED_ROW_COUNT=""
EXPECTED_SOURCE_CONTENT_HASH=""
EXPECTED_SOURCE_HASH_CONTRACT_VERSION=""
EXPECTED_POLLUTANT_COUNT=""
PLAN_REPORT=""
CHECKPOINT=""
DROPBOX_ROOT=""
WRITER_FREEZE_EVIDENCE=""
V2_RUNTIME_ROLLBACK_RECORD=""
REQUIRED_UNCHANGED_DAY=""
SITE_URL=""
CACHE_URL=""
EXPECTED_STATION_HISTORY_WORKER=""
EXPECTED_OBSERVATION_HISTORY_WORKER=""
REPORT_OUT=""
NODE_BIN=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --environment) ENVIRONMENT="${2:-}"; shift 2 ;;
    --expected-repository) EXPECTED_REPOSITORY="${2:-}"; shift 2 ;;
    --expected-repository-git-sha) EXPECTED_REPOSITORY_GIT_SHA="${2:-}"; shift 2 ;;
    --expected-acceptance-git-sha) EXPECTED_ACCEPTANCE_GIT_SHA="${2:-}"; shift 2 ;;
    --expected-bucket) EXPECTED_BUCKET="${2:-}"; shift 2 ;;
    --acceptance-report) ACCEPTANCE_REPORT="${2:-}"; shift 2 ;;
    --expected-acceptance-report-sha256) EXPECTED_ACCEPTANCE_REPORT_SHA256="${2:-}"; shift 2 ;;
    --expected-run-id) EXPECTED_RUN_ID="${2:-}"; shift 2 ;;
    --expected-day-utc) EXPECTED_DAY_UTC="${2:-}"; shift 2 ;;
    --expected-connector-id) EXPECTED_CONNECTOR_ID="${2:-}"; shift 2 ;;
    --expected-row-count) EXPECTED_ROW_COUNT="${2:-}"; shift 2 ;;
    --expected-source-content-hash) EXPECTED_SOURCE_CONTENT_HASH="${2:-}"; shift 2 ;;
    --expected-source-hash-contract-version) EXPECTED_SOURCE_HASH_CONTRACT_VERSION="${2:-}"; shift 2 ;;
    --expected-pollutant-count) EXPECTED_POLLUTANT_COUNT="${2:-}"; shift 2 ;;
    --plan-report) PLAN_REPORT="${2:-}"; shift 2 ;;
    --checkpoint) CHECKPOINT="${2:-}"; shift 2 ;;
    --dropbox-root) DROPBOX_ROOT="${2:-}"; shift 2 ;;
    --writer-freeze-evidence) WRITER_FREEZE_EVIDENCE="${2:-}"; shift 2 ;;
    --v2-runtime-rollback-record) V2_RUNTIME_ROLLBACK_RECORD="${2:-}"; shift 2 ;;
    --required-unchanged-day) REQUIRED_UNCHANGED_DAY="${2:-}"; shift 2 ;;
    --site-url) SITE_URL="${2:-}"; shift 2 ;;
    --cache-url) CACHE_URL="${2:-}"; shift 2 ;;
    --expected-station-history-worker) EXPECTED_STATION_HISTORY_WORKER="${2:-}"; shift 2 ;;
    --expected-observation-history-worker) EXPECTED_OBSERVATION_HISTORY_WORKER="${2:-}"; shift 2 ;;
    --report-out) REPORT_OUT="${2:-}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

ENVIRONMENT="$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')"
case "$ENVIRONMENT" in TEST|LIVE) ;; *) fail "--environment must be TEST or LIVE" ;; esac
for value_name in EXPECTED_REPOSITORY EXPECTED_BUCKET ACCEPTANCE_REPORT EXPECTED_RUN_ID PLAN_REPORT CHECKPOINT DROPBOX_ROOT WRITER_FREEZE_EVIDENCE V2_RUNTIME_ROLLBACK_RECORD SITE_URL CACHE_URL EXPECTED_STATION_HISTORY_WORKER EXPECTED_OBSERVATION_HISTORY_WORKER REPORT_OUT; do
  [ -n "${!value_name}" ] || fail "required argument is empty: $value_name"
done
for sha_value in "$EXPECTED_REPOSITORY_GIT_SHA" "$EXPECTED_ACCEPTANCE_GIT_SHA"; do
  printf '%s' "$sha_value" | grep -Eq '^[0-9a-f]{40}$' || fail "expected Git identities must be full lower-case SHA-1"
done
for sha_value in "$EXPECTED_ACCEPTANCE_REPORT_SHA256" "$EXPECTED_SOURCE_CONTENT_HASH"; do
  printf '%s' "$sha_value" | grep -Eq '^[0-9a-f]{64}$' || fail "expected content identities must be lower-case SHA-256"
done
for day_value in "$EXPECTED_DAY_UTC" "$REQUIRED_UNCHANGED_DAY"; do
  printf '%s' "$day_value" | grep -Eq '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' || fail "day identities must be YYYY-MM-DD"
done
for number_value in "$EXPECTED_CONNECTOR_ID" "$EXPECTED_ROW_COUNT" "$EXPECTED_SOURCE_HASH_CONTRACT_VERSION" "$EXPECTED_POLLUTANT_COUNT"; do
  printf '%s' "$number_value" | grep -Eq '^[1-9][0-9]*$' || fail "numeric expected identities must be positive integers"
done
case "$EXPECTED_STATION_HISTORY_WORKER:$EXPECTED_OBSERVATION_HISTORY_WORKER" in
  *[!a-z0-9:-]*|*-v3-candidate:*|*:*-v3-candidate) fail "pass stable worker names, without the -v3-candidate suffix" ;;
esac

for command in git gh jq curl awk tr grep npx shasum wc; do require_command "$command"; done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || fail "repository root cannot be derived from Git"
cd -- "$REPO_ROOT"

for file in "$ACCEPTANCE_REPORT" "$PLAN_REPORT" "$CHECKPOINT" "$WRITER_FREEZE_EVIDENCE" "$V2_RUNTIME_ROLLBACK_RECORD"; do
  [ -f "$file" ] || fail "required evidence file is missing: $file"
done
[ -d "$CHECKPOINT.recovery" ] || fail "authenticated recovery journal is missing: $CHECKPOINT.recovery"
[ -d "$DROPBOX_ROOT" ] || fail "Dropbox read-only root is missing: $DROPBOX_ROOT"

CURRENT_SHA="$(git rev-parse HEAD)"
[ "$CURRENT_SHA" = "$EXPECTED_REPOSITORY_GIT_SHA" ] || fail "current repository SHA differs from explicit expected SHA"
git cat-file -e "${EXPECTED_ACCEPTANCE_GIT_SHA}^{commit}" 2>/dev/null || fail "accepted writer Git SHA is unavailable locally"
git merge-base --is-ancestor "$EXPECTED_ACCEPTANCE_GIT_SHA" HEAD || fail "accepted writer Git SHA is not an ancestor of current HEAD"
if [ -n "$(git status --short)" ]; then git status --short >&2; fail "working tree is not clean"; fi
REPO_JSON="$(gh repo view --json nameWithOwner,defaultBranchRef 2>/dev/null)" || fail "GitHub repository identity could not be read"
REPO_SLUG="$(printf '%s' "$REPO_JSON" | jq -r '.nameWithOwner // empty')"
DEFAULT_BRANCH="$(printf '%s' "$REPO_JSON" | jq -r '.defaultBranchRef.name // empty')"
CURRENT_BRANCH="$(git branch --show-current)"
[ "$REPO_SLUG" = "$EXPECTED_REPOSITORY" ] || fail "repository differs from explicit expected repository"
[ -n "$DEFAULT_BRANCH" ] && [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] || fail "current branch is not the GitHub default branch"

for name in UKAQ_ENV_NAME UK_AQ_R2_HISTORY_VERSION UK_AQ_R2_HISTORY_INDEX_VERSION UK_AQ_R2_HISTORY_INTEGRITY_VERSION SUPABASE_DB_URL CFLARE_R2_ENDPOINT CFLARE_R2_BUCKET CFLARE_R2_ACCESS_KEY_ID CFLARE_R2_SECRET_ACCESS_KEY UK_AQ_CACHE_BYPASS_SECRET; do require_env "$name"; done
[ "$(printf '%s' "$UKAQ_ENV_NAME" | tr '[:lower:]' '[:upper:]')" = "$ENVIRONMENT" ] || fail "loaded environment differs from explicit environment"
[ "$UK_AQ_R2_HISTORY_VERSION" = "v2" ] || fail "loaded logical history authority is not v2"
[ "$UK_AQ_R2_HISTORY_INDEX_VERSION" = "v3" ] || fail "loaded index authority is not v3"
[ "$UK_AQ_R2_HISTORY_INTEGRITY_VERSION" = "v2" ] || fail "loaded Integrity semantic version is not v2"
[ "$CFLARE_R2_BUCKET" = "$EXPECTED_BUCKET" ] || fail "loaded R2 bucket differs from explicit expected bucket"

GH_ENV="$(gh variable get UKAQ_ENV_NAME --repo "$REPO_SLUG" 2>/dev/null | tr '[:lower:]' '[:upper:]')" || fail "GitHub environment could not be read"
GH_HISTORY="$(gh variable get UK_AQ_R2_HISTORY_VERSION --repo "$REPO_SLUG" 2>/dev/null)" || fail "GitHub history authority could not be read"
GH_INDEX="$(gh variable get UK_AQ_R2_HISTORY_INDEX_VERSION --repo "$REPO_SLUG" 2>/dev/null)" || fail "GitHub index authority could not be read"
[ "$GH_ENV" = "$ENVIRONMENT" ] && [ "$GH_HISTORY" = "v2" ] && [ "$GH_INDEX" = "v3" ] || fail "persistent GitHub environment/history/index authority is contradictory"
# Deliberately do not read or create UK_AQ_R2_HISTORY_INTEGRITY_VERSION in GitHub.

GH_STATION="$(gh variable get UK_AQ_STATION_HISTORY_WORKER_NAME --repo "$REPO_SLUG" 2>/dev/null)" || fail "stable station-history worker identity could not be read"
GH_OBSERVATION="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME --repo "$REPO_SLUG" 2>/dev/null)" || fail "stable observation-history worker identity could not be read"
[ "$GH_STATION" = "$EXPECTED_STATION_HISTORY_WORKER" ] || fail "station-history worker differs from explicit expected identity"
[ "$GH_OBSERVATION" = "$EXPECTED_OBSERVATION_HISTORY_WORKER" ] || fail "observation-history worker differs from explicit expected identity"
STATION_CANDIDATE="${EXPECTED_STATION_HISTORY_WORKER}-v3-candidate"
OBSERVATION_CANDIDATE="${EXPECTED_OBSERVATION_HISTORY_WORKER}-v3-candidate"

SITE_URL="${SITE_URL%/}"
CACHE_URL="${CACHE_URL%/}"
SITE_MODE="$(curl -fsSL -H 'Cache-Control: no-cache, no-store' -H 'Pragma: no-cache' "$SITE_URL/uk-aq-site-mode.json?steady_state_verify=$(date -u +%s)-$$")" || fail "maintenance status could not be read"
printf '%s' "$SITE_MODE" | jq -e '.schema_version == 1 and .mode == "on" and (.deployment_id | type == "string" and length > 0)' >/dev/null || fail "maintenance is not positively ON"

SCHEDULER_CONFIG="cloudflare/scheduler/wrangler.toml"
D1_DATABASE="$(awk -F ' *= *' '/^database_name *=/ {gsub(/"/, "", $2); print $2; exit}' "$SCHEDULER_CONFIG")"
[ -n "$D1_DATABASE" ] || fail "scheduler D1 identity is unavailable"
D1_JSON="$(npx --yes wrangler@4.61.1 d1 execute "$D1_DATABASE" --config "$SCHEDULER_CONFIG" --remote --command "SELECT job_key, enabled FROM scheduler_jobs WHERE job_key IN ('uk_aq_prune_daily','uk_aq_r2_history_dropbox_backup','uk_aq_r2_history_dropbox_backup_force_prune_recheck') ORDER BY job_key;" --json 2>/dev/null)" || fail "read-only remote D1 scheduler SELECT failed"
printf '%s' "$D1_JSON" | jq -e '
  [.. | objects | select(has("job_key") and has("enabled")) | {job_key,enabled}] as $rows |
  ($rows|length)==3 and all($rows[]; (.enabled|type)=="number" and .enabled==0) and
  ([$rows[].job_key]|sort)==(["uk_aq_prune_daily","uk_aq_r2_history_dropbox_backup","uk_aq_r2_history_dropbox_backup_force_prune_recheck"]|sort)
' >/dev/null || fail "scheduler jobs are not exactly the three required numeric disabled rows"
ACTIVE_PRUNE="$(gh run list --repo "$REPO_SLUG" --workflow uk_aq_prune_daily.yml --limit 50 --json status --jq '[.[]|select(.status != "completed")]' 2>/dev/null)" || fail "Prune workflow state could not be read"
[ "$ACTIVE_PRUNE" = "[]" ] || fail "a Prune workflow is active"

if [ -n "$NODE_BIN" ]; then
  [ -x "$NODE_BIN" ] || fail "--node-bin is not executable"
elif command -v node >/dev/null 2>&1 && node --version | grep -Eq '^v20\.'; then
  NODE_BIN="$(command -v node)"
else
  NODE_BIN="$(npx --yes node@20 -p 'process.execPath')" || fail "Node 20 could not be resolved"
fi
"$NODE_BIN" --version | grep -Eq '^v20\.' || fail "the verifier requires Node 20"

OPERATOR_HELPER="$SCRIPT_DIR/index_v3_operator_evidence.mjs"
FREEZE_RESULT="$("$NODE_BIN" "$OPERATOR_HELPER" validate --evidence "$WRITER_FREEZE_EVIDENCE" --plan-report "$PLAN_REPORT" --repository-root "$REPO_ROOT")" || fail "writer-freeze evidence is invalid"
ROLLBACK_RESULT="$("$NODE_BIN" "$OPERATOR_HELPER" validate --evidence "$V2_RUNTIME_ROLLBACK_RECORD" --repository-root "$REPO_ROOT")" || fail "v2 runtime rollback record is invalid"
for result in "$FREEZE_RESULT" "$ROLLBACK_RESULT"; do
  [ "$(printf '%s' "$result" | jq -r '.environment // empty' | tr '[:lower:]' '[:upper:]')" = "$ENVIRONMENT" ] || fail "operator evidence environment mismatch"
  [ "$(printf '%s' "$result" | jq -r '.repository // empty')" = "$REPO_SLUG" ] || fail "operator evidence repository mismatch"
done

verify_current_successful_deploy() {
  local workflow="$1" paths="$2" label="$3"
  local run run_sha drift
  run="$(gh run list --repo "$REPO_SLUG" --workflow "$workflow" --branch "$DEFAULT_BRANCH" --limit 1 --json databaseId,status,conclusion,headSha,headBranch 2>/dev/null | jq '.[0] // null')" || fail "$label deployment could not be read"
  [ "$run" != "null" ] || fail "$label deployment is absent"
  printf '%s' "$run" | jq -e --arg branch "$DEFAULT_BRANCH" '.status=="completed" and .conclusion=="success" and .headBranch==$branch' >/dev/null || fail "$label deployment is not a successful default-branch run"
  run_sha="$(printf '%s' "$run" | jq -r '.headSha')"
  git merge-base --is-ancestor "$run_sha" HEAD || fail "$label deployment SHA is not an ancestor of current HEAD"
  # shellcheck disable=SC2086
  drift="$(git diff --name-only "$run_sha" HEAD -- $paths)"
  [ -z "$drift" ] || fail "$label deployment is stale relative to relevant current code"
  printf '%s' "$run" | jq -r '.databaseId'
}

OBS_RUN_ID="$(verify_current_successful_deploy uk_aq_observs_history_r2_api_v3_candidate_deploy.yml '.github/workflows/uk_aq_observs_history_r2_api_v3_candidate_deploy.yml workers/uk_aq_observs_history_r2_api_v3_candidate workers/shared/uk_aq_observation_history_reader_v3.mjs workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs' 'observation candidate')"
STATION_RUN_ID="$(verify_current_successful_deploy uk_aq_station_history_v3_candidate_deploy.yml '.github/workflows/uk_aq_station_history_v3_candidate_deploy.yml workers/uk_aq_station_history_v3_candidate workers/uk_aq_station_history/src' 'station candidate')"
CACHE_RUN_ID="$(verify_current_successful_deploy uk_aq_cache_proxy_deploy.yml '.github/workflows/uk_aq_cache_proxy_deploy.yml workers/uk_aq_cache_proxy workers/uk_aq_station_history_v3_candidate workers/uk_aq_station_history/src' 'cache')"
CACHE_LOG="$(gh run view "$CACHE_RUN_ID" --repo "$REPO_SLUG" --log 2>/dev/null)" || fail "cache deployment log could not be read"
printf '%s\n' "$CACHE_LOG" | grep -Fq "Resolved STATION_HISTORY Service Binding target: $STATION_CANDIDATE" || fail "cache deployment did not bind the explicit station v3 candidate"
printf '%s\n' "$CACHE_LOG" | grep -Fq 'Persistent observation-history authority: v3' || fail "cache deployment did not record v3 authority"
# Successful, current station-candidate deployment executes repository validation
# that its supplied URL is exactly the derived observation-candidate worker.
[ -n "$STATION_RUN_ID" ] && [ -n "$OBS_RUN_ID" ] || fail "candidate deployment identities are incomplete"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/uk-aq-index-v3-steady-state.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
CONTROL_EVIDENCE="$TMP_DIR/control.json"
jq -n \
  --arg environment "$ENVIRONMENT" --arg repository "$REPO_SLUG" \
  --arg repository_git_sha "$CURRENT_SHA" --arg bucket "$EXPECTED_BUCKET" \
  --arg branch "$CURRENT_BRANCH" --arg station_candidate "$STATION_CANDIDATE" \
  --arg observation_candidate "$OBSERVATION_CANDIDATE" \
  --argjson observation_deploy_run_id "$OBS_RUN_ID" \
  --argjson station_deploy_run_id "$STATION_RUN_ID" \
  --argjson cache_deploy_run_id "$CACHE_RUN_ID" '
  {environment:$environment,repository:$repository,repository_git_sha:$repository_git_sha,bucket:$bucket,branch:$branch,
   station_candidate:$station_candidate,observation_candidate:$observation_candidate,
   observation_deploy_run_id:$observation_deploy_run_id,station_deploy_run_id:$station_deploy_run_id,cache_deploy_run_id:$cache_deploy_run_id,
   repository_exact:true,working_tree_clean:true,default_branch_current:true,repository_git_sha_exact:true,
   loaded_history_v2:true,loaded_index_v3:true,persistent_history_v2:true,persistent_index_v3:true,loaded_integrity_v2:true,
   maintenance_on:true,three_scheduler_jobs_disabled:true,no_active_prune:true,writer_freeze_valid:true,v2_runtime_rollback_record_valid:true,
   cache_to_station_candidate_exact:true,station_to_observation_candidate_exact:true,mutation_performed:false}' > "$CONTROL_EVIDENCE"

RUNNER="$SCRIPT_DIR/index_v3_steady_state_post_write_verify.mjs"
"$NODE_BIN" "$RUNNER" \
  --environment "$ENVIRONMENT" \
  --repository "$EXPECTED_REPOSITORY" \
  --repository-git-sha "$EXPECTED_REPOSITORY_GIT_SHA" \
  --bucket "$EXPECTED_BUCKET" \
  --expected-acceptance-git-sha "$EXPECTED_ACCEPTANCE_GIT_SHA" \
  --acceptance-report "$ACCEPTANCE_REPORT" \
  --expected-acceptance-report-sha256 "$EXPECTED_ACCEPTANCE_REPORT_SHA256" \
  --expected-run-id "$EXPECTED_RUN_ID" \
  --expected-day-utc "$EXPECTED_DAY_UTC" \
  --expected-connector-id "$EXPECTED_CONNECTOR_ID" \
  --expected-row-count "$EXPECTED_ROW_COUNT" \
  --expected-source-content-hash "$EXPECTED_SOURCE_CONTENT_HASH" \
  --expected-source-hash-contract-version "$EXPECTED_SOURCE_HASH_CONTRACT_VERSION" \
  --expected-pollutant-count "$EXPECTED_POLLUTANT_COUNT" \
  --control-evidence "$CONTROL_EVIDENCE" \
  --plan-report "$PLAN_REPORT" \
  --checkpoint "$CHECKPOINT" \
  --dropbox-root "$DROPBOX_ROOT" \
  --required-unchanged-day "$REQUIRED_UNCHANGED_DAY" \
  --site-url "$SITE_URL" \
  --cache-url "$CACHE_URL" \
  --report-out "$REPORT_OUT"
