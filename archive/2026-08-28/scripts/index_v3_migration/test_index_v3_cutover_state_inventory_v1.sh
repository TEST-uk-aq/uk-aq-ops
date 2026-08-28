#!/usr/bin/env bash
set -euo pipefail

# UK AQ Phase 6 - TEST cutover state inventory v1
#
# READ-ONLY with respect to UK AQ runtime/data systems.
#
# Purpose:
#   - prove TEST is still frozen on the pre-cutover v2 authority;
#   - prove the migration evidence remains accepted;
#   - inventory the current and v3-candidate runtime surfaces;
#   - prove the candidate deployments are successful and not stale relative
#     to the code paths they deploy;
#   - prove maintenance is still ON and the three scheduler rows are disabled;
#   - print the exact cutover surfaces for operator review.
#
# This script does NOT:
#   - change GitHub variables or secrets;
#   - deploy/redeploy a Worker;
#   - change a service binding;
#   - write D1/Supabase/R2/Dropbox;
#   - change maintenance mode;
#   - start migration/recovery/rollback;
#   - perform the cutover.

REPO="TEST-uk-aq/uk-aq-ops"
REPO_ROOT="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops"
EXPECTED_ORIGIN_HTTPS="https://github.com/TEST-uk-aq/uk-aq-ops.git"
EXPECTED_ORIGIN_SSH="git@github.com:TEST-uk-aq/uk-aq-ops.git"
EXPECTED_BRANCH="main"
REVIEWED_MIGRATION_BASELINE="95b62d374a98c16f4b48c762ce450db803534237"

VERIFY_REPORT="$REPO_ROOT/tmp/phase6_index_v3/post_migration_verify_report.json"
RECOVERY_HEAD="/Users/mikehinford/uk-aq-work/index_v3_migration/step10/migration_checkpoint.json.recovery/head.json"

OBS_CANDIDATE_WORKFLOW="uk_aq_observs_history_r2_api_v3_candidate_deploy.yml"
STATION_CANDIDATE_WORKFLOW="uk_aq_station_history_v3_candidate_deploy.yml"
CACHE_PROXY_WORKFLOW="uk_aq_cache_proxy_deploy.yml"
MAINTENANCE_WORKFLOW_NAME="UK AQ Edge Maintenance Deploy"

CURRENT_STATION_WORKER="uk-aq-station-history-test"
CANDIDATE_STATION_WORKER="uk-aq-station-history-v3-candidate"
CANDIDATE_OBS_WORKER="uk-aq-observs-history-r2-api-v3-candidate"
EXPECTED_BUCKET="uk-aq-history-cic-test"

EXPECTED_SEQUENCE="79387"
EXPECTED_LAST_ENTRY_SHA="0493c1ccdb82f1914846d142520f4369a6bc6b3a40c44a8ec37879d157d6b4fa"

SELF_REL="scripts/index_v3_migration/test_index_v3_cutover_state_inventory_v1.sh"

failures=0
warnings=0

pass_check() { printf 'PASS: %s\n' "$1"; }
fail_check() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
warn_check() { printf 'WARN: %s\n' "$1"; warnings=$((warnings + 1)); }
stop_now() { printf 'STOP: %s\n' "$1"; exit 2; }

for cmd in git gh jq pgrep curl npx awk grep sed; do
  command -v "$cmd" >/dev/null 2>&1 || stop_now "required command missing: $cmd"
done

echo
echo "============================================================"
echo "UK AQ Phase 6 - TEST CUTOVER STATE INVENTORY v1"
echo "READ-ONLY - NO CUTOVER"
echo "============================================================"
echo

[ -d "$REPO_ROOT/.git" ] || stop_now "TEST Ops repository not found: $REPO_ROOT"
[ -f "$VERIFY_REPORT" ] || stop_now "final verification report not found: $VERIFY_REPORT"
[ -f "$RECOVERY_HEAD" ] || stop_now "recovery head not found: $RECOVERY_HEAD"

cd "$REPO_ROOT"

echo "=== LOCAL REPOSITORY ==="

CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_BRANCH="$(git branch --show-current)"
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"

echo "HEAD:   $CURRENT_HEAD"
echo "Branch: $CURRENT_BRANCH"
echo "Origin: $ORIGIN_URL"

[ "$CURRENT_BRANCH" = "$EXPECTED_BRANCH" ] \
  && pass_check "repository branch is $EXPECTED_BRANCH" \
  || fail_check "repository branch is $CURRENT_BRANCH, expected $EXPECTED_BRANCH"

if [ "$ORIGIN_URL" = "$EXPECTED_ORIGIN_HTTPS" ] || [ "$ORIGIN_URL" = "$EXPECTED_ORIGIN_SSH" ]; then
  pass_check "repository origin is the expected TEST Ops repository"
else
  fail_check "repository origin is not the expected TEST Ops repository"
fi

if git merge-base --is-ancestor "$REVIEWED_MIGRATION_BASELINE" "$CURRENT_HEAD" 2>/dev/null; then
  pass_check "current HEAD descends from reviewed migration baseline"
else
  fail_check "current HEAD does not descend from reviewed migration baseline"
fi

# Permit this inventory script itself to be new/modified so it can be dropped
# into the repo and run before the operator decides whether to commit it.
STATUS_OTHER="$(
  git status --porcelain=v1 --untracked-files=all |
  awk -v self="$SELF_REL" '
    {
      path=substr($0,4)
      if (path != self) print
    }
  '
)"
if [ -z "$STATUS_OTHER" ]; then
  pass_check "no working-tree changes other than this inventory script"
else
  echo
  echo "Other working-tree changes:"
  printf '%s\n' "$STATUS_OTHER"
  fail_check "working tree contains changes unrelated to this inventory script"
fi

echo
echo "=== MORNING MIGRATION EVIDENCE ==="

if jq -e '
  .result.ok == true and
  .result.cutover_ready == true and
  .result.checkpoint_summary.full_verification_complete == true and
  .result.blocker_count == 0 and
  .audit.rollback_ready == true and
  .audit.publication_verification == true
' "$VERIFY_REPORT" >/dev/null; then
  pass_check "accepted post-migration verification remains cutover-ready"
else
  fail_check "post-migration verification is not in the accepted cutover-ready state"
fi

RECOVERY_SEQUENCE="$(jq -r '.payload.last_sequence' "$RECOVERY_HEAD")"
RECOVERY_LAST_SHA="$(jq -r '.payload.last_entry_sha256' "$RECOVERY_HEAD")"

[ "$RECOVERY_SEQUENCE" = "$EXPECTED_SEQUENCE" ] \
  && pass_check "recovery journal remains at sequence $EXPECTED_SEQUENCE" \
  || fail_check "recovery journal sequence changed to $RECOVERY_SEQUENCE"

[ "$RECOVERY_LAST_SHA" = "$EXPECTED_LAST_ENTRY_SHA" ] \
  && pass_check "recovery journal head SHA remains unchanged" \
  || fail_check "recovery journal head SHA changed"

PROCESS_MATCHES="$(pgrep -af 'uk_aq_observation_history_migration_v3|run_step10' || true)"
if [ -z "$PROCESS_MATCHES" ]; then
  pass_check "no Step 10 / verification process is running"
else
  echo "$PROCESS_MATCHES"
  fail_check "Step 10 / verification process is still running"
fi

echo
echo "=== GITHUB AUTH ==="

if gh auth status -h github.com >/dev/null 2>&1; then
  pass_check "GitHub CLI is authenticated"
else
  fail_check "GitHub CLI is not authenticated"
fi

get_var() {
  gh variable get "$1" --repo "$REPO" 2>/dev/null || true
}

HISTORY_VERSION="$(get_var UK_AQ_R2_HISTORY_VERSION)"
INDEX_VERSION="$(get_var UK_AQ_R2_HISTORY_INDEX_VERSION)"
INTEGRITY_VERSION="${UK_AQ_R2_HISTORY_INTEGRITY_VERSION:-}"
STATION_TARGET="$(get_var UK_AQ_STATION_HISTORY_WORKER_NAME)"
CURRENT_OBS_URL="$(get_var UK_AQ_OBSERVS_HISTORY_R2_API_URL)"
R2_BUCKET_VAR="$(get_var CFLARE_R2_BUCKET)"

echo
echo "=== CURRENT TEST CONFIGURATION ==="
printf '%-42s %s\n' "UK_AQ_R2_HISTORY_VERSION" "${HISTORY_VERSION:-<missing>}"
printf '%-42s %s\n' "UK_AQ_R2_HISTORY_INDEX_VERSION" "${INDEX_VERSION:-<missing>}"
printf '%-42s %s\n' "UK_AQ_R2_HISTORY_INTEGRITY_VERSION (local env)" "${INTEGRITY_VERSION:-<missing>}"
printf '%-42s %s\n' "UK_AQ_STATION_HISTORY_WORKER_NAME" "${STATION_TARGET:-<missing>}"
printf '%-42s %s\n' "UK_AQ_OBSERVS_HISTORY_R2_API_URL" "${CURRENT_OBS_URL:-<missing>}"
printf '%-42s %s\n' "CFLARE_R2_BUCKET" "${R2_BUCKET_VAR:-<missing>}"

[ "$HISTORY_VERSION" = "v2" ] \
  && pass_check "logical observation-history version remains v2" \
  || fail_check "UK_AQ_R2_HISTORY_VERSION is ${HISTORY_VERSION:-missing}, expected v2"

[ "$INDEX_VERSION" = "v2" ] \
  && pass_check "authoritative history index version remains v2 before cutover" \
  || fail_check "UK_AQ_R2_HISTORY_INDEX_VERSION is ${INDEX_VERSION:-missing}, expected v2"

[ "$INTEGRITY_VERSION" = "v2" ] \
  && pass_check "authoritative history integrity version remains v2 before cutover" \
  || fail_check "local UK_AQ_R2_HISTORY_INTEGRITY_VERSION is ${INTEGRITY_VERSION:-missing}, expected v2"

[ "$STATION_TARGET" = "$CURRENT_STATION_WORKER" ] \
  && pass_check "cache-proxy station-history target variable still names current v2 Worker" \
  || fail_check "UK_AQ_STATION_HISTORY_WORKER_NAME is ${STATION_TARGET:-missing}, expected $CURRENT_STATION_WORKER"

[ -n "$CURRENT_OBS_URL" ] \
  && pass_check "current observations-history upstream URL is configured" \
  || fail_check "UK_AQ_OBSERVS_HISTORY_R2_API_URL is missing"

if [ -n "$R2_BUCKET_VAR" ]; then
  [ "$R2_BUCKET_VAR" = "$EXPECTED_BUCKET" ] \
    && pass_check "TEST R2 bucket variable is $EXPECTED_BUCKET" \
    || fail_check "CFLARE_R2_BUCKET is $R2_BUCKET_VAR, expected $EXPECTED_BUCKET"
else
  warn_check "CFLARE_R2_BUCKET repository variable could not be read"
fi

echo
echo "=== MAINTENANCE STATE ==="

MAINT_RUN="$(
  gh run list \
    --repo "$REPO" \
    --workflow "$MAINTENANCE_WORKFLOW_NAME" \
    --limit 1 \
    --json databaseId,status,conclusion,createdAt,updatedAt,headSha 2>/dev/null |
  jq '.[0] // null'
)"

if [ "$MAINT_RUN" = "null" ] || [ -z "$MAINT_RUN" ]; then
  fail_check "no maintenance workflow run was found"
else
  echo "$MAINT_RUN" | jq .
  MAINT_RUN_ID="$(printf '%s' "$MAINT_RUN" | jq -r '.databaseId')"
  MAINT_STATUS="$(printf '%s' "$MAINT_RUN" | jq -r '.status')"
  MAINT_CONCLUSION="$(printf '%s' "$MAINT_RUN" | jq -r '.conclusion')"
  if [ "$MAINT_STATUS" = "completed" ] && [ "$MAINT_CONCLUSION" = "success" ]; then
    pass_check "latest maintenance deployment workflow completed successfully"
  else
    fail_check "latest maintenance deployment is not a completed success"
  fi

  MAINT_LOG="$(gh run view "$MAINT_RUN_ID" --repo "$REPO" --log 2>/dev/null || true)"
  if printf '%s\n' "$MAINT_LOG" | grep -Fq 'maintenance_enabled=true'; then
    pass_check "latest maintenance deployment explicitly records maintenance_enabled=true"
  else
    fail_check "latest maintenance deployment log does not prove maintenance_enabled=true"
  fi
fi

echo
echo "=== FROZEN SCHEDULER ROWS ==="

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  fail_check "CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID are required for the read-only remote D1 scheduler check"
else
  D1_JSON="$(
    npx --yes wrangler@4.61.1 d1 execute uk-aq-cic-test \
      --remote \
      --command "SELECT name, enabled FROM uk_aq_scheduler WHERE name IN ('uk_aq_prune_daily','uk_aq_r2_history_dropbox_backup','uk_aq_r2_history_dropbox_backup_force_prune_recheck') ORDER BY name;" \
      --json 2>/dev/null || true
  )"

  if [ -z "$D1_JSON" ]; then
    fail_check "remote D1 scheduler SELECT returned no JSON"
  else
    printf '%s\n' "$D1_JSON" | jq .
    if printf '%s\n' "$D1_JSON" | jq -e '
      [.. | objects | select(has("name") and has("enabled")) | {name, enabled}]
      | unique_by(.name)
      | sort_by(.name)
      == [
        {"name":"uk_aq_prune_daily","enabled":0},
        {"name":"uk_aq_r2_history_dropbox_backup","enabled":0},
        {"name":"uk_aq_r2_history_dropbox_backup_force_prune_recheck","enabled":0}
      ]
    ' >/dev/null 2>&1; then
      pass_check "all three required scheduler rows remain disabled"
    else
      fail_check "scheduler rows are not exactly the required three disabled rows"
    fi
  fi
fi

latest_run_json() {
  local workflow="$1"
  gh run list \
    --repo "$REPO" \
    --workflow "$workflow" \
    --limit 1 \
    --json databaseId,status,conclusion,createdAt,updatedAt,headSha,event 2>/dev/null |
  jq '.[0] // null'
}

check_candidate_run() {
  local label="$1"
  local workflow="$2"
  shift 2
  local paths=("$@")

  local run
  run="$(latest_run_json "$workflow")"

  echo
  echo "--- $label ---"
  if [ "$run" = "null" ] || [ -z "$run" ]; then
    fail_check "$label has no deployment workflow run"
    return
  fi

  echo "$run" | jq .
  local run_id status conclusion run_sha
  run_id="$(printf '%s' "$run" | jq -r '.databaseId')"
  status="$(printf '%s' "$run" | jq -r '.status')"
  conclusion="$(printf '%s' "$run" | jq -r '.conclusion')"
  run_sha="$(printf '%s' "$run" | jq -r '.headSha')"

  if [ "$status" = "completed" ] && [ "$conclusion" = "success" ]; then
    pass_check "$label latest deployment completed successfully"
  else
    fail_check "$label latest deployment is not a completed success"
  fi

  if ! git cat-file -e "${run_sha}^{commit}" 2>/dev/null; then
    fail_check "$label deployment commit $run_sha is unavailable locally"
    return
  fi

  local diff
  diff="$(git diff --name-only "$run_sha" "$CURRENT_HEAD" -- "${paths[@]}")"
  if [ -z "$diff" ]; then
    pass_check "$label deployed code is not stale relative to current candidate code"
  else
    echo
    echo "Candidate-relevant paths changed after deployed run $run_id:"
    printf '%s\n' "$diff"
    fail_check "$label must be redeployed before cutover because candidate-relevant code changed"
  fi
}

echo
echo "=== V3 CANDIDATE DEPLOYMENTS ==="

OBS_CANDIDATE_PATHS=(
  ".github/workflows/$OBS_CANDIDATE_WORKFLOW"
  "workers/uk_aq_observs_history_r2_api_v3_candidate"
  "workers/shared/uk_aq_observation_history_reader_v3.mjs"
  "workers/shared/uk_aq_observation_history_random_access_v3.mjs"
  "workers/shared/uk_aq_observation_history_index_v3.mjs"
  "workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs"
  "workers/shared/uk_aq_observation_history_schema.mjs"
)

STATION_CANDIDATE_PATHS=(
  ".github/workflows/$STATION_CANDIDATE_WORKFLOW"
  "workers/uk_aq_station_history_v3_candidate"
  "workers/uk_aq_station_history/src"
)

check_candidate_run \
  "observations-history v3 candidate" \
  "$OBS_CANDIDATE_WORKFLOW" \
  "${OBS_CANDIDATE_PATHS[@]}"

check_candidate_run \
  "station-history v3 candidate" \
  "$STATION_CANDIDATE_WORKFLOW" \
  "${STATION_CANDIDATE_PATHS[@]}"

echo
echo "=== STATIC CUTOVER CONTRACT ==="

OBS_CANDIDATE_WRANGLER="workers/uk_aq_observs_history_r2_api_v3_candidate/wrangler.toml"
STATION_CANDIDATE_WRANGLER="workers/uk_aq_station_history_v3_candidate/wrangler.toml"
STATION_CANDIDATE_ENTRY="workers/uk_aq_station_history_v3_candidate/entry.mjs"
CACHE_WRANGLER="workers/uk_aq_cache_proxy/wrangler.toml"
CACHE_WORKFLOW=".github/workflows/$CACHE_PROXY_WORKFLOW"

grep -Fq 'UK_AQ_R2_HISTORY_VERSION = "v2"' "$OBS_CANDIDATE_WRANGLER" \
  && pass_check "observations candidate keeps logical history version v2" \
  || fail_check "observations candidate logical history version contract changed"

grep -Fq 'UK_AQ_R2_HISTORY_INDEX_VERSION = "v3"' "$OBS_CANDIDATE_WRANGLER" \
  && pass_check "observations candidate is fixed to index v3" \
  || fail_check "observations candidate is not fixed to index v3"

grep -Fq 'UK_AQ_R2_HISTORY_INDEX_VERSION = "v3"' "$STATION_CANDIDATE_WRANGLER" \
  && pass_check "station-history candidate is fixed to index v3" \
  || fail_check "station-history candidate is not fixed to index v3"

grep -Fq 'workers_dev = false' "$STATION_CANDIDATE_WRANGLER" \
  && pass_check "station-history candidate remains private" \
  || fail_check "station-history candidate is no longer explicitly private"

grep -Fq 'uk-aq-observs-history-r2-api-v3-candidate' "$STATION_CANDIDATE_ENTRY" \
  && pass_check "station-history candidate enforces the fixed observations v3 candidate hostname" \
  || fail_check "station-history candidate no longer enforces the fixed observations v3 candidate hostname"

grep -Fq 'UK_AQ_STATION_HISTORY_WORKER_NAME' "$CACHE_WORKFLOW" \
  && pass_check "cache-proxy deployment is controlled by UK_AQ_STATION_HISTORY_WORKER_NAME" \
  || fail_check "cache-proxy deployment no longer consumes UK_AQ_STATION_HISTORY_WORKER_NAME"

if grep -Fq 'binding = "STATION_HISTORY"' "$CACHE_WRANGLER" && \
   grep -Fq '__UK_AQ_STATION_HISTORY_WORKER_NAME__' "$CACHE_WRANGLER"; then
  pass_check "cache proxy retains the STATION_HISTORY service-binding placeholder"
else
  fail_check "cache proxy STATION_HISTORY service-binding contract changed"
fi

echo
echo "=== REPOSITORY SURFACES USING VERSION VARIABLES ==="

echo
echo "UK_AQ_R2_HISTORY_INDEX_VERSION:"
git grep -l 'UK_AQ_R2_HISTORY_INDEX_VERSION' -- ':!scripts/index_v3_migration/test_index_v3_cutover_state_inventory_v1.sh' | sort || true

echo
echo "UK_AQ_R2_HISTORY_INTEGRITY_VERSION:"
git grep -l 'UK_AQ_R2_HISTORY_INTEGRITY_VERSION' -- ':!scripts/index_v3_migration/test_index_v3_cutover_state_inventory_v1.sh' | sort || true

echo
echo "UK_AQ_STATION_HISTORY_WORKER_NAME:"
git grep -l 'UK_AQ_STATION_HISTORY_WORKER_NAME' -- ':!scripts/index_v3_migration/test_index_v3_cutover_state_inventory_v1.sh' | sort || true

echo
echo "=== CUTOVER SURFACES DISCOVERED ==="
echo
printf '%-38s %-34s -> %s\n' \
  "History index authority variable" \
  "${INDEX_VERSION:-<missing>}" \
  "v3"
printf '%-38s %-34s -> %s\n' \
  "History integrity authority variable" \
  "${INTEGRITY_VERSION:-<missing>}" \
  "v3"
printf '%-38s %-34s -> %s\n' \
  "Cache STATION_HISTORY target" \
  "${STATION_TARGET:-<missing>}" \
  "$CANDIDATE_STATION_WORKER"
printf '%-38s %-34s -> %s\n' \
  "Station candidate observations upstream" \
  "$CURRENT_OBS_URL" \
  "$CANDIDATE_OBS_WORKER (fixed workers.dev candidate)"

echo
echo "NOTE: the station-history v3 candidate intentionally has no public route"
echo "or workers.dev URL. Its first end-to-end public runtime check must therefore"
echo "happen immediately after the cache-proxy STATION_HISTORY service binding is"
echo "retargeted during the manual cutover. That is a targeted cutover acceptance"
echo "check, not a pre-cutover probe."

echo
echo "============================================================"

if [ "$failures" -eq 0 ]; then
  echo "TEST CUTOVER STATE INVENTORY v1: PASS"
  echo
  echo "Warnings: $warnings"
  echo "NO CUTOVER WAS PERFORMED."
  echo
  echo "The system remains on v2 authority, maintenance remains ON,"
  echo "the required schedulers remain frozen, and both v3 candidates"
  echo "are structurally ready for the manual cutover sequence."
  echo "============================================================"
  exit 0
fi

echo "TEST CUTOVER STATE INVENTORY v1: STOP"
echo
echo "Failures: $failures"
echo "Warnings: $warnings"
echo "NO CUTOVER WAS PERFORMED."
echo "Do NOT retarget or switch v2 -> v3 until these failures are reviewed."
echo "============================================================"
exit 1
