#!/bin/bash
set -euo pipefail

# Read-only Phase 6 observation-history index-v3 readiness gate.
# Expected environment identity comes from the loaded terminal profile.
# Actual repository/configuration state is read independently from GitHub,
# Cloudflare D1, R2, Dropbox evidence, and the public site.

usage() {
  cat <<'EOF'
Usage:
  index_v3_preflight.sh --stage plan
  index_v3_preflight.sh --stage migration-start \
    --authority-file PATH --plan-report PATH --dropbox-root PATH --site-url URL \
    --writer-freeze-evidence PATH
  index_v3_preflight.sh --stage cutover \
    --plan-report PATH --dropbox-root PATH --site-url URL \
    --checkpoint PATH --verify-report PATH \
    --writer-freeze-evidence PATH --v2-runtime-rollback-record PATH
  index_v3_preflight.sh --self-test

Stages:
  plan             Local/repository/environment configuration only.
  migration-start  Adds frozen writers, current backup/source, and maintenance.
  cutover          Adds final v3 verification, recovery, and candidate readiness.

This script is strictly read-only. It never changes maintenance, schedulers,
deployments, GitHub configuration, D1, R2, Dropbox, or migration state.
EOF
}

pass() { printf 'PASS: %s\n' "$1"; }
warn() { printf 'WARN: %s\n' "$1"; }
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf 'NO CUTOVER WAS PERFORMED.\n' >&2
  exit 1
}

candidate_worker_name() {
  local active_name="${1:-}" candidate_name
  case "$active_name" in
    ''|*[!a-z0-9-]*|-*|*-|*-v3-candidate) return 1 ;;
  esac
  candidate_name="${active_name}-v3-candidate"
  [ "${#candidate_name}" -le 63 ] || return 1
  printf '%s\n' "$candidate_name"
}

noncompleted_workflow_runs() {
  jq -c '[.[] | select(.status != "completed")]'
}

maintenance_status_is_on() {
  node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        process.exitCode = 1;
        return;
      }
      if (
        !payload
        || payload.schema_version !== 1
        || payload.mode !== "on"
        || typeof payload.deployment_id !== "string"
        || !payload.deployment_id.trim()
        || typeof payload.artifact_built_at_utc !== "string"
        || Number.isNaN(Date.parse(payload.artifact_built_at_utc))
      ) {
        process.exitCode = 1;
      }
    });
  '
}

recovery_manifest_implementation_is_valid() {
  jq -e '
    .schema_version == 1 and
    .kind == "uk_aq_observation_history_v3_recovery_manifest" and
    ((.payload.recovery_implementation.repository_head | type) == "string") and
    (.payload.recovery_implementation.repository_head | test("^[0-9a-f]{40}$")) and
    ((.payload.recovery_implementation.files | type) == "array") and
    (.payload.recovery_implementation.files | length > 0) and
    all(
      .payload.recovery_implementation.files[];
      ((.path | type) == "string") and
      (.path | length > 0) and
      ((.sha256 | type) == "string") and
      (.sha256 | test("^[0-9a-f]{64}$"))
    )
  ' >/dev/null
}

git_blob_sha256_at_commit() {
  local commit="$1" path="$2"
  git cat-file -e "${commit}:${path}" 2>/dev/null || return 1
  git cat-file blob "${commit}:${path}" 2>/dev/null | shasum -a 256 | awk '{print $1}'
}

self_test() {
  local output status candidate legacy_workflow legacy_status fixture recovery_fixture self_test_dir
  command -v jq >/dev/null 2>&1 || fail "self-test: jq is unavailable"
  command -v node >/dev/null 2>&1 || fail "self-test: node is unavailable"
  self_test_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
  node "$self_test_dir/recovery_post_migration_root_evidence.mjs" --self-test >/dev/null \
    || fail "self-test: post-migration recovery-root evidence reader failed"
  set +e
  output="$("$0" --_self-test-fail 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "self-test: induced prerequisite did not fail"
  printf '%s\n' "$output" | grep -Fq 'NO CUTOVER WAS PERFORMED.' \
    || fail "self-test: hard failure omitted the no-cutover statement"
  if printf '%s\n' "$output" | grep -Fq 'SELF_TEST_UNREACHABLE'; then
    fail "self-test: execution continued after a hard failure"
  fi
  output="$("$0" --_self-test-warning 2>&1)" \
    || fail "self-test: warning stopped execution"
  printf '%s\n' "$output" | grep -Fq 'SELF_TEST_AFTER_WARNING' \
    || fail "self-test: warning did not continue"

  output="$(printf '%s\n' '[{"status":"completed"}]' | noncompleted_workflow_runs)" \
    || fail "self-test: completed workflow fixture could not be evaluated"
  [ "$output" = '[]' ] || fail "self-test: completed workflow was treated as active"
  for status in in_progress queued waiting; do
    output="$(printf '[{"status":"%s"}]\n' "$status" | noncompleted_workflow_runs)" \
      || fail "self-test: $status workflow fixture could not be evaluated"
    [ "$output" != '[]' ] || fail "self-test: $status workflow was treated as idle"
  done

  fixture='{"schema_version":1,"mode":"on","deployment_id":"self-test","artifact_built_at_utc":"2026-08-28T00:00:00.000Z"}'
  printf '%s\n' "$fixture" | maintenance_status_is_on \
    || fail "self-test: valid maintenance status was rejected"
  for fixture in \
    '{"schema_version":1,"mode":"off","deployment_id":"self-test","artifact_built_at_utc":"2026-08-28T00:00:00.000Z"}' \
    '{"schema_version":1,"mode":"on","deployment_id":"","artifact_built_at_utc":"2026-08-28T00:00:00.000Z"}' \
    '{"schema_version":1,"mode":"on","deployment_id":"self-test","artifact_built_at_utc":"not-a-date"}' \
    'not-json'
  do
    if printf '%s\n' "$fixture" | maintenance_status_is_on 2>/dev/null; then
      fail "self-test: invalid maintenance status was accepted"
    fi
  done

  recovery_fixture='{"schema_version":1,"kind":"uk_aq_observation_history_v3_recovery_manifest","payload":{"recovery_implementation":{"repository_head":"0123456789abcdef0123456789abcdef01234567","files":[{"path":"scripts/example.sh","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]}}}'
  printf '%s\n' "$recovery_fixture" | recovery_manifest_implementation_is_valid \
    || fail "self-test: valid recovery_implementation manifest shape was rejected"
  recovery_fixture='{"schema_version":1,"kind":"uk_aq_observation_history_v3_recovery_manifest","payload":{"implementation":{"repository_head":"0123456789abcdef0123456789abcdef01234567","files":[{"path":"scripts/example.sh","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]}}}'
  if printf '%s\n' "$recovery_fixture" | recovery_manifest_implementation_is_valid 2>/dev/null; then
    fail "self-test: obsolete payload.implementation manifest shape was accepted"
  fi

  candidate="$(candidate_worker_name 'uk-aq-station-history-test')" \
    || fail "self-test: TEST station candidate name was rejected"
  [ "$candidate" = 'uk-aq-station-history-test-v3-candidate' ] \
    || fail "self-test: TEST station candidate name was derived incorrectly"
  candidate="$(candidate_worker_name 'uk-aq-station-history-live')" \
    || fail "self-test: LIVE station candidate name was rejected"
  [ "$candidate" = 'uk-aq-station-history-live-v3-candidate' ] \
    || fail "self-test: LIVE station candidate name was derived incorrectly"
  candidate="$(candidate_worker_name 'uk-aq-observs-history-r2-api-test')" \
    || fail "self-test: TEST observations candidate name was rejected"
  [ "$candidate" = 'uk-aq-observs-history-r2-api-test-v3-candidate' ] \
    || fail "self-test: TEST observations candidate name was derived incorrectly"
  candidate="$(candidate_worker_name 'uk-aq-observs-history-r2-api-live')" \
    || fail "self-test: LIVE observations candidate name was rejected"
  [ "$candidate" = 'uk-aq-observs-history-r2-api-live-v3-candidate' ] \
    || fail "self-test: LIVE observations candidate name was derived incorrectly"
  if candidate_worker_name 'uk-aq-station-history-test-v3-candidate' >/dev/null; then
    fail "self-test: candidate Worker identity was accepted as the stable station identity"
  fi

  legacy_workflow="$(printf '%s%s' 'UK AQ Edge Maintenance ' 'Deploy')"
  legacy_status="$(printf '%s%s' '__uk_aq_site_' 'mode.json')"
  ! grep -Fq "$legacy_workflow" "$0" \
    || fail "self-test: obsolete maintenance workflow lookup returned"
  ! grep -Fq "$legacy_status" "$0" \
    || fail "self-test: obsolete maintenance status path returned"

  pass "induced mandatory failure stopped immediately"
  pass "induced warning continued"
  pass "completed and non-completed workflow states remain distinguished"
  pass "maintenance status requires valid schema-v1 ON evidence and a deployment ID"
  pass "immutable recovery manifest requires recovery_implementation schema"
  pass "post-migration source-root evidence is anchored to the recovery journal head"
  pass "TEST and LIVE candidate Worker names derive from active Worker names"
  pass "obsolete maintenance lookup strings remain absent"
}

case "${1:-}" in
  --_self-test-fail)
    fail "induced mandatory prerequisite"
    echo SELF_TEST_UNREACHABLE
    ;;
  --_self-test-warning)
    warn "induced non-blocking condition"
    echo SELF_TEST_AFTER_WARNING
    exit 0
    ;;
  --self-test)
    self_test
    exit 0
    ;;
esac

STAGE=""
AUTHORITY_FILE=""
PLAN_REPORT=""
DROPBOX_ROOT=""
SITE_URL=""
CHECKPOINT=""
VERIFY_REPORT=""
WRITER_FREEZE_EVIDENCE=""
V2_RUNTIME_ROLLBACK_RECORD=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage) STAGE="${2:-}"; shift 2 ;;
    --authority-file) AUTHORITY_FILE="${2:-}"; shift 2 ;;
    --plan-report) PLAN_REPORT="${2:-}"; shift 2 ;;
    --dropbox-root) DROPBOX_ROOT="${2:-}"; shift 2 ;;
    --site-url) SITE_URL="${2:-}"; shift 2 ;;
    --checkpoint) CHECKPOINT="${2:-}"; shift 2 ;;
    --verify-report) VERIFY_REPORT="${2:-}"; shift 2 ;;
    --writer-freeze-evidence) WRITER_FREEZE_EVIDENCE="${2:-}"; shift 2 ;;
    --v2-runtime-rollback-record) V2_RUNTIME_ROLLBACK_RECORD="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

case "$STAGE" in
  plan|migration-start|cutover) ;;
  *) usage >&2; fail "--stage must be plan, migration-start, or cutover" ;;
esac

for command in git gh jq node curl shasum; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done
if [ "$STAGE" != "plan" ]; then
  command -v npx >/dev/null 2>&1 || fail "required command is unavailable: npx"
  [ -n "$PLAN_REPORT" ] || fail "--plan-report is required for $STAGE"
  [ -n "$DROPBOX_ROOT" ] || fail "--dropbox-root is required for $STAGE"
  [ -n "$SITE_URL" ] || fail "--site-url is required for $STAGE (no established repository variable exists)"
fi
if [ "$STAGE" = "migration-start" ]; then
  [ -n "$AUTHORITY_FILE" ] || fail "--authority-file is required for migration-start"
fi
if [ "$STAGE" != "plan" ]; then
  [ -n "$WRITER_FREEZE_EVIDENCE" ] || fail "--writer-freeze-evidence is required for $STAGE"
fi
if [ "$STAGE" = "cutover" ]; then
  [ -n "$CHECKPOINT" ] || fail "--checkpoint is required for cutover"
  [ -n "$VERIFY_REPORT" ] || fail "--verify-report is required for cutover"
  [ -n "$V2_RUNTIME_ROLLBACK_RECORD" ] || fail "--v2-runtime-rollback-record is required for cutover"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "repository root cannot be derived from Git"
cd -- "$REPO_ROOT"

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "required loaded environment value is missing: $name"
}

for name in \
  UKAQ_ENV_NAME \
  UK_AQ_R2_HISTORY_VERSION \
  UK_AQ_R2_HISTORY_INDEX_VERSION \
  UK_AQ_R2_HISTORY_INTEGRITY_VERSION \
  UK_AQ_STATION_HISTORY_WORKER_NAME \
  UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME \
  UK_AQ_DROPBOX_ROOT \
  UK_AQ_R2_HISTORY_DROPBOX_DIR \
  CFLARE_R2_BUCKET \
  CFLARE_R2_ENDPOINT
do
  require_env "$name"
done

ENVIRONMENT="$(printf '%s' "$UKAQ_ENV_NAME" | tr '[:lower:]' '[:upper:]')"
case "$ENVIRONMENT" in TEST|LIVE) ;; *) fail "UKAQ_ENV_NAME must identify TEST or LIVE" ;; esac

STATION_CANDIDATE_WORKER_NAME="$(candidate_worker_name "$UK_AQ_STATION_HISTORY_WORKER_NAME")" \
  || fail "UK_AQ_STATION_HISTORY_WORKER_NAME cannot form a valid candidate Worker name"
OBSERVATIONS_CANDIDATE_WORKER_NAME="$(candidate_worker_name "$UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME")" \
  || fail "UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME cannot form a valid candidate Worker name"

printf '%s\n' '============================================================'
printf 'UK AQ INDEX V3 PREFLIGHT: %s / %s\n' "$ENVIRONMENT" "$STAGE"
printf 'Repository root: %s\n' "$REPO_ROOT"
printf '%s\n\n' 'READ-ONLY: NO CUTOVER OR MUTATION IS PERFORMED'

[ "$UK_AQ_R2_HISTORY_VERSION" = "v2" ] \
  || fail "expected loaded UK_AQ_R2_HISTORY_VERSION=v2"
[ "$UK_AQ_R2_HISTORY_INDEX_VERSION" = "v2" ] \
  || fail "pre-cutover UK_AQ_R2_HISTORY_INDEX_VERSION must be v2"
[ "$UK_AQ_R2_HISTORY_INTEGRITY_VERSION" = "v2" ] \
  || fail "expected loaded UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2"
pass "loaded environment is recognised and retains the v2 pre-cutover authority"

CURRENT_BRANCH="$(git branch --show-current)"
[ -n "$CURRENT_BRANCH" ] || fail "detached HEAD is not permitted"
CURRENT_HEAD="$(git rev-parse HEAD)"

REPO_JSON="$(gh repo view --json nameWithOwner,defaultBranchRef 2>/dev/null)" \
  || fail "GitHub repository identity could not be read"
REPO_SLUG="$(printf '%s' "$REPO_JSON" | jq -r '.nameWithOwner // empty')"
DEFAULT_BRANCH="$(printf '%s' "$REPO_JSON" | jq -r '.defaultBranchRef.name // empty')"
[ -n "$REPO_SLUG" ] || fail "GitHub repository slug is empty"
[ -n "$DEFAULT_BRANCH" ] || fail "GitHub default branch is empty"
[ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] \
  || fail "current branch $CURRENT_BRANCH is not GitHub default branch $DEFAULT_BRANCH"
pass "repository $REPO_SLUG and branch $CURRENT_BRANCH were derived from Git/gh"

if [ -n "$(git status --short)" ]; then
  git status --short >&2
  fail "working tree is not clean"
fi
pass "working tree is clean"

get_repo_var() {
  gh variable get "$1" --repo "$REPO_SLUG" 2>/dev/null
}

ACTUAL_ENVIRONMENT="$(get_repo_var UKAQ_ENV_NAME)" \
  || fail "GitHub variable UKAQ_ENV_NAME could not be read"
ACTUAL_ENVIRONMENT="$(printf '%s' "$ACTUAL_ENVIRONMENT" | tr '[:lower:]' '[:upper:]')"
[ "$ACTUAL_ENVIRONMENT" = "$ENVIRONMENT" ] \
  || fail "GitHub UKAQ_ENV_NAME=$ACTUAL_ENVIRONMENT does not match loaded $ENVIRONMENT"

compare_repo_var() {
  local name="$1" expected="$2" actual
  actual="$(get_repo_var "$name")" || fail "GitHub variable $name could not be read"
  [ "$actual" = "$expected" ] \
    || fail "GitHub $name=$actual does not match loaded expected value $expected"
  pass "GitHub $name matches the loaded expected value"
}

compare_repo_var UK_AQ_R2_HISTORY_VERSION "$UK_AQ_R2_HISTORY_VERSION"
compare_repo_var UK_AQ_R2_HISTORY_INDEX_VERSION "$UK_AQ_R2_HISTORY_INDEX_VERSION"
compare_repo_var UK_AQ_R2_HISTORY_INTEGRITY_VERSION "$UK_AQ_R2_HISTORY_INTEGRITY_VERSION"
compare_repo_var UK_AQ_STATION_HISTORY_WORKER_NAME "$UK_AQ_STATION_HISTORY_WORKER_NAME"
compare_repo_var UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME "$UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME"
compare_repo_var UK_AQ_DROPBOX_ROOT "$UK_AQ_DROPBOX_ROOT"
compare_repo_var UK_AQ_R2_HISTORY_DROPBOX_DIR "$UK_AQ_R2_HISTORY_DROPBOX_DIR"
compare_repo_var CFLARE_R2_BUCKET "$CFLARE_R2_BUCKET"
compare_repo_var CFLARE_R2_ENDPOINT "$CFLARE_R2_ENDPOINT"
pass "expected environment identity is independent of actual GitHub configuration"

if [ "$STAGE" = "plan" ]; then
  printf '\nPREFLIGHT PASS: environment/repository configuration is structurally ready for planning.\n'
  printf 'NO CUTOVER WAS PERFORMED.\n'
  exit 0
fi

for file in "$PLAN_REPORT"; do
  [ -f "$file" ] || fail "required migration evidence is missing: $file"
  jq empty "$file" >/dev/null 2>&1 || fail "migration evidence is not valid JSON: $file"
done

RECOVERY_AUTHORITY=0
if [ -n "$AUTHORITY_FILE" ]; then
  [ -f "$AUTHORITY_FILE" ] || fail "required migration evidence is missing: $AUTHORITY_FILE"
  jq empty "$AUTHORITY_FILE" >/dev/null 2>&1 || fail "migration evidence is not valid JSON: $AUTHORITY_FILE"
  AUTH_ENV="$(jq -r '.environment // empty' "$AUTHORITY_FILE" | tr '[:lower:]' '[:upper:]')"
  AUTH_REPO="$(jq -r '.repository // empty' "$AUTHORITY_FILE")"
  AUTH_BRANCH="$(jq -r '.branch // empty' "$AUTHORITY_FILE")"
  AUTH_HEAD="$(jq -r '.target_writer_git_sha // empty' "$AUTHORITY_FILE")"
  AUTH_HEAD_LABEL="target writer"
  AUTH_PLAN_SHA="$(jq -r '.plan_sha256 // empty' "$AUTHORITY_FILE")"
  AUTH_RUN_ID="$(jq -r '.migration_run_id // empty' "$AUTHORITY_FILE")"
else
  RECOVERY_MANIFEST="$CHECKPOINT.recovery/manifest.json"
  [ -f "$RECOVERY_MANIFEST" ] || fail "recovery manifest is required when --authority-file is omitted"
  jq empty "$RECOVERY_MANIFEST" >/dev/null 2>&1 || fail "recovery manifest is not valid JSON"
  recovery_manifest_implementation_is_valid < "$RECOVERY_MANIFEST" \
    || fail "recovery manifest does not contain the required recovery_implementation identity"
  AUTH_ENV="$(jq -r '.result.environment.environment // empty' "$PLAN_REPORT" | tr '[:lower:]' '[:upper:]')"
  AUTH_REPO="$REPO_SLUG"
  AUTH_BRANCH="$CURRENT_BRANCH"
  AUTH_HEAD="$(jq -r '.payload.recovery_implementation.repository_head // empty' "$RECOVERY_MANIFEST")"
  AUTH_HEAD_LABEL="recovery implementation"
  AUTH_PLAN_SHA="$(jq -r '.payload.plan_sha256 // empty' "$RECOVERY_MANIFEST")"
  AUTH_RUN_ID="$(jq -r '.payload.migration_run_id // empty' "$RECOVERY_MANIFEST")"
  RECOVERY_AUTHORITY=1
  pass "operator authority was derived from the immutable recovery manifest"
fi

[ "$AUTH_ENV" = "$ENVIRONMENT" ] || fail "authority environment does not match $ENVIRONMENT"
[ "$AUTH_REPO" = "$REPO_SLUG" ] || fail "authority repository does not match $REPO_SLUG"
[ "$AUTH_BRANCH" = "$CURRENT_BRANCH" ] || fail "authority branch does not match $CURRENT_BRANCH"
printf '%s' "$AUTH_HEAD" | grep -Eq '^[0-9a-f]{40}$' || fail "$AUTH_HEAD_LABEL Git SHA is invalid"
git cat-file -e "${AUTH_HEAD}^{commit}" 2>/dev/null || fail "$AUTH_HEAD_LABEL commit is unavailable"
git merge-base --is-ancestor "$AUTH_HEAD" "$CURRENT_HEAD" \
  || fail "$AUTH_HEAD_LABEL commit is not an ancestor of current HEAD"

PLAN_ENV="$(jq -r '.result.environment.environment // empty' "$PLAN_REPORT" | tr '[:lower:]' '[:upper:]')"
PLAN_RUN_ID="$(jq -r '.result.migration_run_id // empty' "$PLAN_REPORT")"
PLAN_SHA="$(jq -r '.result.plan_sha256 // empty' "$PLAN_REPORT")"
[ "$PLAN_ENV" = "$ENVIRONMENT" ] || fail "plan environment does not match $ENVIRONMENT"
[ "$PLAN_RUN_ID" = "$AUTH_RUN_ID" ] || fail "plan migration run ID does not match authority"
[ "$PLAN_SHA" = "$AUTH_PLAN_SHA" ] || fail "plan SHA-256 does not match authority"
jq -e '
  .result.kind == "uk_aq_observation_history_v3_migration_plan_summary" and
  .result.environment.ok == true and
  .result.environment.history_version == "v2" and
  .result.environment.index_version == "v2" and
  .result.environment.integrity_version == "v2" and
  .result.backup_gate.verified == true and
  .result.rollback_preflight.verified == true and
  .result.mutation_allowed == true and
  (.result.blockers | type == "array" and length == 0) and
  (.audit.blockers | type == "array" and length == 0) and
  .result.target.history_version == "v2" and
  .result.target.history_schema_version == 3 and
  .result.target.index_generation == "v3" and
  .result.target.writer_version == "parquet-wasm-zstd-v3" and
  .result.target.physical_layout_version == "timeseries-bounded-v1" and
  .result.target.writer_limits == {
    "max_file_bytes":8388608,
    "max_file_rows":131072,
    "max_row_group_rows":16384,
    "max_row_groups_per_file":8,
    "target_file_bytes":4194304,
    "target_file_rows":65536,
    "target_row_group_rows":8192
  }
' "$PLAN_REPORT" >/dev/null || fail "migration plan/rollback authority is not accepted"
pass "migration plan, backup gate, rollback preflight, and writer limits are accepted"

OPERATOR_EVIDENCE_HELPER="$SCRIPT_DIR/index_v3_operator_evidence.mjs"
[ -f "$OPERATOR_EVIDENCE_HELPER" ] || fail "operator evidence validator is missing"
[ -f "$WRITER_FREEZE_EVIDENCE" ] || fail "durable writer-freeze evidence is missing: $WRITER_FREEZE_EVIDENCE"
FREEZE_EVIDENCE_RESULT="$(node "$OPERATOR_EVIDENCE_HELPER" validate \
  --evidence "$WRITER_FREEZE_EVIDENCE" \
  --plan-report "$PLAN_REPORT" \
  --repository-root "$REPO_ROOT")" \
  || fail "durable writer-freeze evidence is invalid"
[ "$(printf '%s' "$FREEZE_EVIDENCE_RESULT" | jq -r '.environment // empty' | tr '[:lower:]' '[:upper:]')" = "$ENVIRONMENT" ] \
  || fail "writer-freeze evidence environment does not match $ENVIRONMENT"
[ "$(printf '%s' "$FREEZE_EVIDENCE_RESULT" | jq -r '.repository // empty')" = "$REPO_SLUG" ] \
  || fail "writer-freeze evidence repository does not match $REPO_SLUG"
[ "$(printf '%s' "$FREEZE_EVIDENCE_RESULT" | jq -r '.branch // empty')" = "$CURRENT_BRANCH" ] \
  || fail "writer-freeze evidence branch does not match $CURRENT_BRANCH"
pass "durable writer-freeze evidence covers every migration-plan mutation class"

if [ "$STAGE" = "cutover" ]; then
  [ -f "$V2_RUNTIME_ROLLBACK_RECORD" ] \
    || fail "immutable v2 runtime rollback record is missing: $V2_RUNTIME_ROLLBACK_RECORD"
  ROLLBACK_RECORD_RESULT="$(node "$OPERATOR_EVIDENCE_HELPER" validate \
    --evidence "$V2_RUNTIME_ROLLBACK_RECORD" \
    --repository-root "$REPO_ROOT")" \
    || fail "immutable v2 runtime rollback record is invalid or lacks exact historical deployment identity"
  [ "$(printf '%s' "$ROLLBACK_RECORD_RESULT" | jq -r '.environment // empty' | tr '[:lower:]' '[:upper:]')" = "$ENVIRONMENT" ] \
    || fail "v2 runtime rollback record environment does not match $ENVIRONMENT"
  [ "$(printf '%s' "$ROLLBACK_RECORD_RESULT" | jq -r '.repository // empty')" = "$REPO_SLUG" ] \
    || fail "v2 runtime rollback record repository does not match $REPO_SLUG"
  [ "$(printf '%s' "$ROLLBACK_RECORD_RESULT" | jq -r '.branch // empty')" = "$CURRENT_BRANCH" ] \
    || fail "v2 runtime rollback record branch does not match $CURRENT_BRANCH"
  pass "immutable v2 runtime rollback record has exact code, workflow, Worker, and deployment identities"
fi

CRITICAL_PATHS=(
  package.json
  package-lock.json
  scripts/backup_r2
  scripts/operations
  scripts/index_v3_migration/index_v3_migration.sh
  workers/shared
  cloudflare/scheduler/jobs.toml
  cloudflare/scheduler/wrangler.toml
  .github/workflows/uk_aq_prune_daily.yml
  workers/uk_aq_prune_daily
  scripts/uk-aq-history-integrity
  scripts/uk_aq_backfill_local.sh
  workers/uk_aq_backfill_local
)
if [ "$RECOVERY_AUTHORITY" -eq 1 ]; then
  CRITICAL_DRIFT="$(git diff --name-only "$AUTH_HEAD" "$CURRENT_HEAD" -- \
    "${CRITICAL_PATHS[@]}" \
    ':(exclude)scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs' \
    ':(exclude)scripts/backup_r2/lib/observation_history_migration_v3.mjs' \
    ':(exclude)scripts/index_v3_migration/index_v3_migration.sh')"
else
  CRITICAL_DRIFT="$(git diff --name-only "$AUTH_HEAD" "$CURRENT_HEAD" -- "${CRITICAL_PATHS[@]}")"
fi
[ -z "$CRITICAL_DRIFT" ] || {
  printf '%s\n' "$CRITICAL_DRIFT" >&2
  fail "migration-critical code changed after the pinned authority"
}
if [ "$RECOVERY_AUTHORITY" -eq 1 ]; then
  pass "runtime/writer-critical code matches the pinned recovery authority; superseded recovery operator tooling is excluded"
else
  pass "migration-critical code matches the pinned writer authority"
fi

STATE_KEY="$(jq -r '.result.backup_gate.state_root.key // empty' "$PLAN_REPORT")"
STATE_SHA="$(jq -r '.result.backup_gate.state_root.sha256 // empty' "$PLAN_REPORT")"
INVENTORY_KEY="$(jq -r '.result.backup_gate.inventory_root.key // empty' "$PLAN_REPORT")"
INVENTORY_SHA="$(jq -r '.result.backup_gate.inventory_root.sha256 // empty' "$PLAN_REPORT")"
SOURCE_KEY="$(jq -r '.result.source_root.key // empty' "$PLAN_REPORT")"
SOURCE_SHA="$(jq -r '.result.source_root.sha256 // empty' "$PLAN_REPORT")"
SOURCE_CONTENT_HASH="$(jq -r '.result.source_root.content_hash // empty' "$PLAN_REPORT")"

DROPBOX_STATE="$DROPBOX_ROOT/${STATE_KEY#/}"
[ -f "$DROPBOX_STATE" ] || fail "pinned Dropbox state root is missing: $DROPBOX_STATE"
ACTUAL_STATE_SHA="$(shasum -a 256 "$DROPBOX_STATE" | awk '{print $1}')"
[ "$ACTUAL_STATE_SHA" = "$STATE_SHA" ] || fail "Dropbox state root no longer matches the pinned plan"
pass "Dropbox state root matches the pinned rollback generation"

DROPBOX_SOURCE="$DROPBOX_ROOT/${SOURCE_KEY#/}"
[ -f "$DROPBOX_SOURCE" ] || fail "pinned Dropbox source root is missing: $DROPBOX_SOURCE"
ACTUAL_DROPBOX_SOURCE_SHA="$(shasum -a 256 "$DROPBOX_SOURCE" | awk '{print $1}')"
[ "$ACTUAL_DROPBOX_SOURCE_SHA" = "$SOURCE_SHA" ] || fail "Dropbox source root no longer matches the pinned pre-migration plan"
[ "$(jq -r '.content_hash // empty' "$DROPBOX_SOURCE")" = "$SOURCE_CONTENT_HASH" ] \
  || fail "Dropbox source-root content hash no longer matches the pinned pre-migration plan"
pass "Dropbox canonical source root retains the pinned pre-migration rollback generation"

require_env CFLARE_R2_ACCESS_KEY_ID
require_env CFLARE_R2_SECRET_ACCESS_KEY
export SOURCE_KEY SOURCE_SHA SOURCE_CONTENT_HASH INVENTORY_KEY INVENTORY_SHA
if [ "$STAGE" = "migration-start" ]; then
  node --input-type=module <<'NODE' || fail "current R2 source/inventory identity differs from the pinned pre-migration plan"
import crypto from "node:crypto";
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";

const r2 = {
  endpoint: process.env.CFLARE_R2_ENDPOINT,
  bucket: process.env.CFLARE_R2_BUCKET,
  region: process.env.CFLARE_R2_REGION || "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};
const body = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const source = body((await r2GetObject({ r2, key: process.env.SOURCE_KEY })).body);
const inventory = body((await r2GetObject({ r2, key: process.env.INVENTORY_KEY })).body);
if (sha(source) !== process.env.SOURCE_SHA) throw new Error("source root SHA mismatch");
if (JSON.parse(source).content_hash !== process.env.SOURCE_CONTENT_HASH) {
  throw new Error("source root content hash mismatch");
}
if (sha(inventory) !== process.env.INVENTORY_SHA) throw new Error("inventory root SHA mismatch");
NODE
  pass "current R2 canonical source and backup inventory match the pinned pre-migration plan"
else
  node --input-type=module <<'NODE' || fail "current R2 backup inventory differs from the pinned rollback plan"
import crypto from "node:crypto";
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";

const r2 = {
  endpoint: process.env.CFLARE_R2_ENDPOINT,
  bucket: process.env.CFLARE_R2_BUCKET,
  region: process.env.CFLARE_R2_REGION || "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};
const body = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const inventory = body((await r2GetObject({ r2, key: process.env.INVENTORY_KEY })).body);
if (sha(inventory) !== process.env.INVENTORY_SHA) throw new Error("inventory root SHA mismatch");
NODE
  pass "current R2 backup inventory matches the pinned rollback plan; post-migration source identity is checked from recovery evidence"
fi

LATEST_BACKUP="$(gh run list --repo "$REPO_SLUG" --workflow uk_aq_r2_history_dropbox_backup.yml --limit 1 --json status,conclusion 2>/dev/null | jq '.[0] // null')" \
  || fail "latest history Dropbox backup workflow could not be read"
[ "$LATEST_BACKUP" != "null" ] || fail "no history Dropbox backup workflow run was found"
printf '%s' "$LATEST_BACKUP" | jq -e '.status == "completed" and .conclusion == "success"' >/dev/null \
  || fail "latest history Dropbox backup workflow is not a completed success"
pass "latest history Dropbox backup workflow completed successfully"

WRITER_PROCESSES="$(pgrep -af 'uk_aq_observation_history_migration_v3|uk_aq_prune_daily|uk_aq_integrity_backfill|uk-aq-history-integrity' || true)"
[ -z "$WRITER_PROCESSES" ] || {
  printf '%s\n' "$WRITER_PROCESSES" >&2
  fail "a local canonical-history writer or migration process appears to be running"
}
pass "no local canonical-history writer or migration process is running (local corroboration only)"

PRUNE_RUNS="$(gh run list --repo "$REPO_SLUG" --workflow uk_aq_prune_daily.yml --limit 50 --json databaseId,status,conclusion,event,createdAt,url 2>/dev/null)" \
  || fail "recent Prune Daily workflow state could not be read"
ACTIVE_PRUNE="$(printf '%s' "$PRUNE_RUNS" | noncompleted_workflow_runs)" \
  || fail "recent Prune Daily workflow state is malformed"
[ "$ACTIVE_PRUNE" = "[]" ] || {
  printf '%s\n' "$ACTIVE_PRUNE" >&2
  fail "a recent Prune Daily workflow run is not completed"
}
pass "Prune Daily workflow is idle"

SCHEDULER_CONFIG="cloudflare/scheduler/wrangler.toml"
[ -f "$SCHEDULER_CONFIG" ] || fail "scheduler configuration is missing: $SCHEDULER_CONFIG"
D1_DATABASE="$(awk -F ' *= *' '/^database_name *=/ {gsub(/"/, "", $2); print $2; exit}' "$SCHEDULER_CONFIG")"
[ -n "$D1_DATABASE" ] || fail "scheduler D1 database name is absent from $SCHEDULER_CONFIG"
require_env CLOUDFLARE_ACCOUNT_ID
require_env CLOUDFLARE_API_TOKEN
D1_JSON="$(npx --yes wrangler@4.61.1 d1 execute "$D1_DATABASE" --config "$SCHEDULER_CONFIG" --remote --command "SELECT job_key, enabled FROM scheduler_jobs WHERE job_key IN ('uk_aq_prune_daily','uk_aq_r2_history_dropbox_backup','uk_aq_r2_history_dropbox_backup_force_prune_recheck') ORDER BY job_key;" --json 2>/dev/null)" \
  || fail "read-only remote D1 scheduler SELECT failed"
printf '%s' "$D1_JSON" | jq -e '
  [.. | objects | select(has("job_key") and has("enabled")) | {job_key, enabled}] as $rows
  | ($rows | length) == 3
    and all($rows[]; (.enabled | type) == "number" and .enabled == 0)
    and (["uk_aq_prune_daily","uk_aq_r2_history_dropbox_backup","uk_aq_r2_history_dropbox_backup_force_prune_recheck"] as $expected
      | all($expected[] as $key; ([$rows[] | select(.job_key == $key)] | length) == 1))
    and all($rows[]; .job_key == "uk_aq_prune_daily"
      or .job_key == "uk_aq_r2_history_dropbox_backup"
      or .job_key == "uk_aq_r2_history_dropbox_backup_force_prune_recheck")
' >/dev/null || fail "remote scheduler rows are not exactly the three required disabled jobs"
pass "all migration-sensitive scheduler jobs have exactly one disabled numeric row in $D1_DATABASE"

SITE_URL="${SITE_URL%/}"
CACHE_BUSTER="$(date -u +%s)-$$"
SITE_MODE="$(curl -fsSL \
  -H 'Cache-Control: no-cache, no-store' \
  -H 'Pragma: no-cache' \
  "$SITE_URL/uk-aq-site-mode.json?uk_aq_site_mode_check=$CACHE_BUSTER")" \
  || fail "public maintenance status could not be read"
printf '%s' "$SITE_MODE" | maintenance_status_is_on \
  || fail "public maintenance status is not positively ON"
ROUTE_NUMBER=0
for path in / /hex_map/ /about/ /dev-blog/ /resources/ /sensor_map/ /sensors/; do
  ROUTE_NUMBER=$((ROUTE_NUMBER + 1))
  PAGE="$(curl -sSL \
    -H 'Cache-Control: no-cache, no-store' \
    -H 'Pragma: no-cache' \
    "$SITE_URL$path?uk_aq_site_mode_check=$CACHE_BUSTER-$ROUTE_NUMBER")" \
    || fail "public maintenance page could not be read: $path"
  printf '%s' "$PAGE" | grep -Fq '<meta name="uk-aq-site-maintenance" content="on">' \
    || fail "maintenance marker is absent from public path $path"
done
pass "public site-mode deployment and all maintenance routes are positively ON"

if [ "$STAGE" = "migration-start" ]; then
  printf '\nPREFLIGHT PASS: migration-start prerequisites are satisfied.\n'
  printf 'NO CUTOVER WAS PERFORMED.\n'
  exit 0
fi

[ -f "$CHECKPOINT" ] || fail "immutable checkpoint is missing: $CHECKPOINT"
[ -f "$VERIFY_REPORT" ] || fail "final verification report is missing: $VERIFY_REPORT"
jq empty "$VERIFY_REPORT" >/dev/null 2>&1 || fail "final verification report is not valid JSON"
RECOVERY_ROOT="$CHECKPOINT.recovery"
RECOVERY_HEAD="$RECOVERY_ROOT/head.json"
RECOVERY_MANIFEST="$RECOVERY_ROOT/manifest.json"
RECOVERY_POST_ROOT_HELPER="$SCRIPT_DIR/recovery_post_migration_root_evidence.mjs"
[ -f "$RECOVERY_HEAD" ] || fail "recovery journal head is missing"
[ -f "$RECOVERY_MANIFEST" ] || fail "recovery manifest is missing"
[ -f "$RECOVERY_POST_ROOT_HELPER" ] || fail "post-migration recovery-root evidence helper is missing"
jq empty "$RECOVERY_HEAD" >/dev/null 2>&1 || fail "recovery journal head is not valid JSON"
jq empty "$RECOVERY_MANIFEST" >/dev/null 2>&1 || fail "recovery manifest is not valid JSON"
recovery_manifest_implementation_is_valid < "$RECOVERY_MANIFEST" \
  || fail "recovery manifest does not contain a valid recovery_implementation identity"

CHECKPOINT_SHA="$(shasum -a 256 "$CHECKPOINT" | awk '{print $1}')"
CHECKPOINT_BYTES="$(wc -c < "$CHECKPOINT" | tr -d ' ')"
CHECKPOINT_AUTHORITY_SHA="$(jq -r '.authority_sha256 // empty' "$CHECKPOINT")"
HEAD_CHECKPOINT_SHA="$(jq -r '.payload.original_checkpoint_sha256 // empty' "$RECOVERY_HEAD")"
MANIFEST_CHECKPOINT_SHA="$(jq -r '.payload.original_checkpoint.sha256 // empty' "$RECOVERY_MANIFEST")"
MANIFEST_CHECKPOINT_BYTES="$(jq -r '.payload.original_checkpoint.byte_size // empty' "$RECOVERY_MANIFEST")"
HEAD_AUTHORITY_SHA="$(jq -r '.payload.immutable_authority_sha256 // empty' "$RECOVERY_HEAD")"
MANIFEST_AUTHORITY_SHA="$(jq -r '.payload.immutable_authority_sha256 // empty' "$RECOVERY_MANIFEST")"
TARGET_WRITER_GIT_SHA="$(jq -r '.payload.target_writer_git_sha // empty' "$RECOVERY_MANIFEST")"
printf '%s' "$CHECKPOINT_AUTHORITY_SHA" | grep -Eq '^[0-9a-f]{64}$' \
  || fail "checkpoint immutable authority SHA is malformed"
[ "$CHECKPOINT_SHA" = "$HEAD_CHECKPOINT_SHA" ] || fail "recovery head references a different checkpoint"
[ "$CHECKPOINT_SHA" = "$MANIFEST_CHECKPOINT_SHA" ] || fail "recovery manifest references a different checkpoint"
[ "$CHECKPOINT_BYTES" = "$MANIFEST_CHECKPOINT_BYTES" ] || fail "checkpoint byte size differs from recovery manifest"
[ "$CHECKPOINT_AUTHORITY_SHA" = "$HEAD_AUTHORITY_SHA" ] || fail "recovery head authority differs from the independently validated checkpoint"
[ "$CHECKPOINT_AUTHORITY_SHA" = "$MANIFEST_AUTHORITY_SHA" ] || fail "recovery manifest authority differs from the independently validated checkpoint"
jq -e '.payload.last_sequence > 0 and (.payload.last_entry_sha256 | test("^[0-9a-f]{64}$"))' "$RECOVERY_HEAD" >/dev/null \
  || fail "recovery journal head is malformed"
pass "immutable checkpoint independently authenticates the recovery manifest and head identities"

VERIFY_ENV="$(jq -r '.audit.environment // empty' "$VERIFY_REPORT" | tr '[:lower:]' '[:upper:]')"
[ "$VERIFY_ENV" = "$ENVIRONMENT" ] || fail "verification report environment does not match $ENVIRONMENT"
jq -e '
  .result.ok == true and
  .result.cutover_ready == true and
  .result.checkpoint_summary.full_verification_complete == true and
  .result.checkpoint_summary.cutover_ready == true and
  (.result.blockers | type == "array" and length == 0) and
  (.audit.blockers | type == "array" and length == 0)
' "$VERIFY_REPORT" >/dev/null || fail "final v3 verification is not cutover-ready"
[ "$(jq -r '.result.checkpoint_summary.plan_sha256' "$VERIFY_REPORT")" = "$AUTH_PLAN_SHA" ] \
  || fail "verification report plan SHA does not match authority"
[ "$(jq -r '.result.checkpoint_summary.authority_sha256' "$VERIFY_REPORT")" = "$CHECKPOINT_AUTHORITY_SHA" ] \
  || fail "verification report authority SHA does not match the independently validated checkpoint"
pass "final v3 verification is complete, blocker-free, and cutover-ready"

POST_ROOT_EVIDENCE="$(node "$RECOVERY_POST_ROOT_HELPER" \
  --recovery-root "$RECOVERY_ROOT" \
  --source-key "$SOURCE_KEY" \
  --expected-checkpoint-sha256 "$CHECKPOINT_SHA" \
  --expected-checkpoint-byte-size "$CHECKPOINT_BYTES" \
  --expected-authority-sha256 "$CHECKPOINT_AUTHORITY_SHA" \
  --expected-migration-run-id "$AUTH_RUN_ID" \
  --expected-plan-sha256 "$AUTH_PLAN_SHA" \
  --expected-target-writer-git-sha "$TARGET_WRITER_GIT_SHA")" \
  || fail "post-migration canonical source-root evidence could not be derived from the immutable recovery journal"
POST_SOURCE_SHA="$(printf '%s' "$POST_ROOT_EVIDENCE" | jq -r '.sha256 // empty')"
POST_SOURCE_BYTES="$(printf '%s' "$POST_ROOT_EVIDENCE" | jq -r '.byte_size // empty')"
printf '%s' "$POST_SOURCE_SHA" | grep -Eq '^[0-9a-f]{64}$' \
  || fail "post-migration source-root recovery SHA is invalid"
printf '%s' "$POST_SOURCE_BYTES" | grep -Eq '^[1-9][0-9]*$' \
  || fail "post-migration source-root recovery byte size is invalid"
export POST_SOURCE_SHA POST_SOURCE_BYTES
node --input-type=module <<'NODE' || fail "current R2 canonical source root differs from the post-migration recovery evidence"
import crypto from "node:crypto";
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";

const r2 = {
  endpoint: process.env.CFLARE_R2_ENDPOINT,
  bucket: process.env.CFLARE_R2_BUCKET,
  region: process.env.CFLARE_R2_REGION || "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};
const source = Buffer.from((await r2GetObject({ r2, key: process.env.SOURCE_KEY })).body);
const sourceSha = crypto.createHash("sha256").update(source).digest("hex");
if (sourceSha !== process.env.POST_SOURCE_SHA) throw new Error("post-migration source root SHA mismatch");
if (source.byteLength !== Number(process.env.POST_SOURCE_BYTES)) throw new Error("post-migration source root byte-size mismatch");
const payload = JSON.parse(source.toString("utf8"));
if (
  payload?.kind !== "uk_aq_observations_root_manifest" ||
  payload?.schema_version !== 1 ||
  payload?.domain !== "observations" ||
  typeof payload?.content_hash !== "string" ||
  !/^[0-9a-f]{64}$/.test(payload.content_hash)
) {
  throw new Error("post-migration source root payload is not a valid canonical observations root manifest");
}
NODE
pass "current R2 canonical source root matches the verified post-migration recovery-journal identity"

RECOVERY_IMPLEMENTATION_HEAD="$(jq -r '.payload.recovery_implementation.repository_head // empty' "$RECOVERY_MANIFEST")"
IMPLEMENTATION_OK=1
while IFS=$'\t' read -r path expected_sha; do
  actual_sha="$(git_blob_sha256_at_commit "$RECOVERY_IMPLEMENTATION_HEAD" "$path" || true)"
  if [ -z "$actual_sha" ] || [ "$actual_sha" != "$expected_sha" ]; then
    printf 'Historical recovery implementation mismatch: %s at %s\n' \
      "$path" "$RECOVERY_IMPLEMENTATION_HEAD" >&2
    IMPLEMENTATION_OK=0
    break
  fi
done < <(jq -r '.payload.recovery_implementation.files[] | [.path,.sha256] | @tsv' "$RECOVERY_MANIFEST")
[ "$IMPLEMENTATION_OK" -eq 1 ] \
  || fail "Git history does not match the immutable recovery implementation manifest"
pass "historical recovery implementation in Git matches the immutable recovery manifest"

DEPENDENCY_VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/uk-aq-index-v3-current-verify.XXXXXX")"
trap 'rm -rf "$DEPENDENCY_VERIFY_DIR"' EXIT
DEPENDENCY_WRITER_LIMITS="$DEPENDENCY_VERIFY_DIR/writer_limits.json"
DEPENDENCY_VERIFY_REPORT="$DEPENDENCY_VERIFY_DIR/current_dependency_verify.json"
jq '.result.target.writer_limits' "$PLAN_REPORT" > "$DEPENDENCY_WRITER_LIMITS"
UK_AQ_ENV_NAME="$ENVIRONMENT" node --max-old-space-size=4096 \
  scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs \
  --mode verify \
  --environment "$ENVIRONMENT" \
  --expected-bucket "$CFLARE_R2_BUCKET" \
  --migration-run-id "$AUTH_RUN_ID" \
  --target-writer-git-sha "$TARGET_WRITER_GIT_SHA" \
  --writer-limits-json "$DEPENDENCY_WRITER_LIMITS" \
  --dropbox-root "$DROPBOX_ROOT" \
  --expected-inventory-root-sha256 "$INVENTORY_SHA" \
  --expected-state-root-sha256 "$STATE_SHA" \
  --expected-plan-sha256 "$AUTH_PLAN_SHA" \
  --checkpoint-in "$CHECKPOINT" \
  --report-out "$DEPENDENCY_VERIFY_REPORT" >/dev/null \
  || fail "current authoritative canonical/v3 dependency closure does not match completed migration evidence"
jq -e '
  .result.ok == true and
  .result.cutover_ready == true and
  .result.checkpoint_summary.full_verification_complete == true and
  .result.checkpoint_summary.cutover_ready == true and
  (.result.blockers | type == "array" and length == 0) and
  (.audit.blockers | type == "array" and length == 0)
' "$DEPENDENCY_VERIFY_REPORT" >/dev/null \
  || fail "current dependency verifier did not produce blocker-free exact verification"
pass "current canonical Parquet, manifest hierarchy, v3 child/scoped/latest closure exactly matches pinned completed migration authority"

check_candidate() {
  local label="$1" workflow="$2"
  shift 2
  local run run_sha drift
  run="$(gh run list --repo "$REPO_SLUG" --workflow "$workflow" --branch "$DEFAULT_BRANCH" --limit 1 --json status,conclusion,headSha,headBranch,event,createdAt,url 2>/dev/null | jq '.[0] // null')" \
    || fail "$label deployment workflow could not be read"
  [ "$run" != "null" ] || fail "$label has no deployment workflow run"
  printf '%s' "$run" | jq -e --arg branch "$DEFAULT_BRANCH" '
    .status == "completed" and .conclusion == "success" and .headBranch == $branch
  ' >/dev/null \
    || fail "$label latest deployment is not a completed success"
  run_sha="$(printf '%s' "$run" | jq -r '.headSha')"
  git cat-file -e "${run_sha}^{commit}" 2>/dev/null || fail "$label deployment commit is unavailable locally"
  git merge-base --is-ancestor "$run_sha" "$CURRENT_HEAD" \
    || fail "$label deployment commit is not an ancestor of current default-branch HEAD"
  drift="$(git diff --name-only "$run_sha" "$CURRENT_HEAD" -- "$@")"
  [ -z "$drift" ] || {
    printf '%s\n' "$drift" >&2
    fail "$label is stale relative to current candidate code"
  }
  pass "$label accepted deployment is a successful default-branch run with current relevant code identity"
}

check_candidate "observations-history v3 candidate ($OBSERVATIONS_CANDIDATE_WORKER_NAME)" \
  uk_aq_observs_history_r2_api_v3_candidate_deploy.yml \
  .github/workflows/uk_aq_observs_history_r2_api_v3_candidate_deploy.yml \
  workers/uk_aq_observs_history_r2_api_v3_candidate \
  workers/shared/uk_aq_observation_history_reader_v3.mjs \
  workers/shared/uk_aq_observation_history_random_access_v3.mjs \
  workers/shared/uk_aq_observation_history_index_v3.mjs \
  workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs

check_candidate "station-history v3 candidate ($STATION_CANDIDATE_WORKER_NAME)" \
  uk_aq_station_history_v3_candidate_deploy.yml \
  .github/workflows/uk_aq_station_history_v3_candidate_deploy.yml \
  workers/uk_aq_station_history_v3_candidate \
  workers/uk_aq_station_history/src

grep -Fq 'UK_AQ_R2_HISTORY_VERSION = "v2"' workers/uk_aq_observs_history_r2_api_v3_candidate/wrangler.toml \
  || fail "observations candidate no longer keeps logical history v2"
grep -Fq 'UK_AQ_R2_HISTORY_INDEX_VERSION = "v3"' workers/uk_aq_observs_history_r2_api_v3_candidate/wrangler.toml \
  || fail "observations candidate is not fixed to index v3"
grep -Fq 'UK_AQ_R2_HISTORY_INDEX_VERSION = "v3"' workers/uk_aq_station_history_v3_candidate/wrangler.toml \
  || fail "station-history candidate is not fixed to index v3"
grep -Fq 'workers_dev = false' workers/uk_aq_station_history_v3_candidate/wrangler.toml \
  || fail "station-history candidate is not private"
grep -Fq 'UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME' .github/workflows/uk_aq_station_history_v3_candidate_deploy.yml \
  || fail "station-history candidate deployment does not derive the observations candidate identity"
grep -Fq 'UK_AQ_STATION_HISTORY_WORKER_NAME' .github/workflows/uk_aq_station_history_v3_candidate_deploy.yml \
  || fail "station-history candidate deployment does not derive its Worker identity"
grep -Fq 'UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME' .github/workflows/uk_aq_observs_history_r2_api_v3_candidate_deploy.yml \
  || fail "observations candidate deployment does not derive its Worker identity"
CACHE_WORKFLOW='.github/workflows/uk_aq_cache_proxy_deploy.yml'
STATION_WORKFLOW='.github/workflows/uk_aq_station_history_deploy.yml'
BINDING_RESOLVER='workers/uk_aq_cache_proxy/resolve_station_history_service.sh'
[ -f "$BINDING_RESOLVER" ] || fail "cache-proxy binding resolver is missing"
grep -Fq 'station_history_service_override:' "$CACHE_WORKFLOW" \
  || fail "cache-proxy workflow lacks the explicit station binding override"
grep -Fq 'bash ./resolve_station_history_service.sh' "$CACHE_WORKFLOW" \
  || fail "cache-proxy workflow does not use the constrained station binding resolver"
grep -Fq "UK_AQ_STATION_HISTORY_WORKER_NAME: \${{ vars.UK_AQ_STATION_HISTORY_WORKER_NAME || '' }}" "$CACHE_WORKFLOW" \
  || fail "cache-proxy normal station identity is not the stable repository variable"
grep -Fq "UK_AQ_R2_HISTORY_INDEX_VERSION: \${{ vars.UK_AQ_R2_HISTORY_INDEX_VERSION || '' }}" "$CACHE_WORKFLOW" \
  || fail "cache-proxy workflow does not load the persistent observation-index authority"
grep -Fq 'command: deploy --name ${{ env.UK_AQ_STATION_HISTORY_WORKER_NAME }}' "$STATION_WORKFLOW" \
  || fail "normal station deployment no longer uses the stable Worker identity"
if grep -Fq 'Deploy Worker (base)' "$CACHE_WORKFLOW"; then
  fail "cache-proxy operational workflow still performs an unsafe bootstrap deployment"
fi
CACHE_DEPLOY_COMMAND='command: deploy --config wrangler.deploy.toml --name ${{ env.UK_AQ_CACHE_WORKER_NAME }}'
[ "$(grep -Fc "$CACHE_DEPLOY_COMMAND" "$CACHE_WORKFLOW")" -eq 1 ] \
  || fail "cache-proxy workflow must contain exactly one authority-changing deployment"
workflow_step_line() {
  grep -nF -- "- name: $1" "$CACHE_WORKFLOW" | head -n 1 | cut -d: -f1
}
CACHE_IDENTITY_VALIDATE_LINE="$(workflow_step_line 'Validate cache deployment identity and Cloudflare credentials')"
CACHE_BINDING_RESOLVE_LINE="$(workflow_step_line 'Resolve STATION_HISTORY Service Binding target')"
CACHE_REQUIRED_VALIDATE_LINE="$(workflow_step_line 'Validate required Worker secrets and vars')"
CACHE_SECRET_PREPARE_LINE="$(workflow_step_line 'Prepare and validate Worker secrets payload')"
CACHE_PACKAGE_VALIDATE_LINE="$(workflow_step_line 'Validate Worker deployment package')"
CACHE_EXISTING_WORKER_LINE="$(workflow_step_line 'Verify existing operational Workers')"
CACHE_SECRET_APPLY_LINE="$(workflow_step_line 'Apply Worker secrets to existing cache Worker')"
CACHE_DEPLOY_LINE="$(workflow_step_line 'Deploy Worker')"
for line in \
  "$CACHE_IDENTITY_VALIDATE_LINE" \
  "$CACHE_BINDING_RESOLVE_LINE" \
  "$CACHE_REQUIRED_VALIDATE_LINE" \
  "$CACHE_SECRET_PREPARE_LINE" \
  "$CACHE_PACKAGE_VALIDATE_LINE" \
  "$CACHE_EXISTING_WORKER_LINE" \
  "$CACHE_SECRET_APPLY_LINE" \
  "$CACHE_DEPLOY_LINE"
do
  [ -n "$line" ] || fail "cache-proxy operational workflow ordering step is missing"
done
[ "$CACHE_IDENTITY_VALIDATE_LINE" -lt "$CACHE_BINDING_RESOLVE_LINE" ] \
  || fail "cache-proxy binding resolves before deployment identity validation"
[ "$CACHE_BINDING_RESOLVE_LINE" -lt "$CACHE_REQUIRED_VALIDATE_LINE" ] \
  || fail "cache-proxy required secret/variable validation does not follow binding resolution"
[ "$CACHE_REQUIRED_VALIDATE_LINE" -lt "$CACHE_SECRET_PREPARE_LINE" ] \
  || fail "cache-proxy secret payload is prepared before required inputs are validated"
[ "$CACHE_SECRET_PREPARE_LINE" -lt "$CACHE_PACKAGE_VALIDATE_LINE" ] \
  || fail "cache-proxy deployment package is validated before secret payload validation"
[ "$CACHE_PACKAGE_VALIDATE_LINE" -lt "$CACHE_EXISTING_WORKER_LINE" ] \
  || fail "cache-proxy existing-Worker gate does not follow deployment-package validation"
[ "$CACHE_EXISTING_WORKER_LINE" -lt "$CACHE_SECRET_APPLY_LINE" ] \
  || fail "cache-proxy secrets can be applied before the existing-Worker gate"
[ "$CACHE_SECRET_APPLY_LINE" -lt "$CACHE_DEPLOY_LINE" ] \
  || fail "cache-proxy authority-changing deploy can occur before secret application succeeds"
grep -Fq -- '--dry-run' "$CACHE_WORKFLOW" \
  || fail "cache-proxy workflow lacks a non-mutating deployment-package validation"
grep -Fq 'verify_existing_worker' "$CACHE_WORKFLOW" \
  || fail "cache-proxy workflow does not fail closed for missing operational Workers"
[ "$(bash "$BINDING_RESOLVER" "$UK_AQ_STATION_HISTORY_WORKER_NAME" v2 '')" = "$UK_AQ_STATION_HISTORY_WORKER_NAME" ] \
  || fail "persistent v2 authority does not select the normal station Worker"
[ "$(bash "$BINDING_RESOLVER" "$UK_AQ_STATION_HISTORY_WORKER_NAME" v3 '')" = "$STATION_CANDIDATE_WORKER_NAME" ] \
  || fail "persistent v3 authority does not select the derived station candidate Worker"
[ "$(bash "$BINDING_RESOLVER" "$UK_AQ_STATION_HISTORY_WORKER_NAME" v2 "$UK_AQ_STATION_HISTORY_WORKER_NAME")" = "$UK_AQ_STATION_HISTORY_WORKER_NAME" ] \
  || fail "explicit normal cache binding override is not accepted"
[ "$(bash "$BINDING_RESOLVER" "$UK_AQ_STATION_HISTORY_WORKER_NAME" v3 "$STATION_CANDIDATE_WORKER_NAME")" = "$STATION_CANDIDATE_WORKER_NAME" ] \
  || fail "cache binding resolver does not accept the exactly derived v3 candidate"
if bash "$BINDING_RESOLVER" "$UK_AQ_STATION_HISTORY_WORKER_NAME" v2 "$STATION_CANDIDATE_WORKER_NAME" >/dev/null 2>&1; then
  fail "cache binding resolver permits the v3 candidate while v2 is authoritative"
fi
if bash "$BINDING_RESOLVER" "$UK_AQ_STATION_HISTORY_WORKER_NAME" v3 "$UK_AQ_STATION_HISTORY_WORKER_NAME" >/dev/null 2>&1; then
  fail "cache binding resolver permits the normal Worker while v3 is authoritative"
fi
if bash "$BINDING_RESOLVER" "$UK_AQ_STATION_HISTORY_WORKER_NAME" v2 'uk-aq-arbitrary-third-worker' >/dev/null 2>&1; then
  fail "cache binding resolver accepts an arbitrary third Worker"
fi
if bash "$BINDING_RESOLVER" "$UK_AQ_STATION_HISTORY_WORKER_NAME" v3 "${STATION_CANDIDATE_WORKER_NAME}-v3-candidate" >/dev/null 2>&1; then
  fail "cache binding resolver accepts a double-suffixed candidate"
fi
grep -Fq '__UK_AQ_STATION_HISTORY_WORKER_NAME__' workers/uk_aq_cache_proxy/wrangler.toml \
  || fail "cache-proxy station service-binding placeholder is missing"
pass "persistent generation authority and fail-closed single cache deployment remain intact"

warn "cutover remains an explicit operator action outside this read-only script"
printf '\nPREFLIGHT PASS: all cutover-readiness prerequisites are satisfied.\n'
printf 'NO CUTOVER WAS PERFORMED.\n'
