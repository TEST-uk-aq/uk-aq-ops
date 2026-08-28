#!/bin/bash
set -euo pipefail

# Environment-neutral operator wrapper for the observation-history v3 migration.
# No mode is implicit. Mutation requires an explicit mode, --apply, a matching
# run-bound authorisation phrase, and the complete read-only migration-start gate.

usage() {
  cat <<'EOF'
Usage:
  index_v3_migration.sh plan \
    --work-dir PATH --migration-run-id ID --dropbox-root PATH \
    --inventory-root-sha256 HEX --state-root-sha256 HEX

  index_v3_migration.sh migrate \
    --work-dir PATH --dropbox-root PATH --site-url URL \
    --writer-freeze-evidence PATH --apply

  index_v3_migration.sh resume \
    --work-dir PATH --dropbox-root PATH --site-url URL \
    --writer-freeze-evidence PATH --apply

  index_v3_migration.sh verify \
    --work-dir PATH --dropbox-root PATH [--report-out PATH]

Common work-dir files:
  operator_authority.json
  migration_plan_report.json
  migration_checkpoint.json
  writer_limits.json

Explicit path overrides:
  --authority-file PATH --plan-report PATH --checkpoint PATH --report-out PATH

Mutation authorisation:
  migrate requires UK_AQ_INDEX_V3_MIGRATION_AUTH to equal the exact phrase printed.
  resume  requires UK_AQ_INDEX_V3_RESUME_AUTH to equal the exact phrase printed.

The wrapper never changes scheduler, maintenance, deployment, GitHub, or reader
configuration. It never performs cutover. The underlying CLI owns the global
observation lock and the checkpoint/recovery journal.
EOF
}

stop() {
  printf 'STOP: %s\n' "$1" >&2
  printf 'NO CUTOVER WAS PERFORMED.\n' >&2
  exit 1
}

require_authorization() {
  local variable_name="$1" expected="$2" actual
  actual="${!variable_name:-}"
  if [ "$actual" != "$expected" ]; then
    printf 'Required exact %s:\n%s\n' "$variable_name" "$expected" >&2
    stop "explicit run-bound authorisation is absent or incorrect"
  fi
}

# Complete local dependency closure loaded by read-only verify. The current-only
# files intentionally contain compatible post-migration verifier hardening, so
# they are authenticated against current HEAD rather than required to equal the
# historical migration implementation. The remaining dependencies must also be
# byte-compatible with the pinned target-writer commit.
VERIFY_CURRENT_ONLY_DEPENDENCIES=(
  scripts/index_v3_migration/index_v3_migration.sh
  scripts/index_v3_migration/index_v3_preflight.sh
  scripts/index_v3_migration/recovery_journal_authority.mjs
  scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs
  scripts/backup_r2/lib/observation_history_migration_v3.mjs
)
VERIFY_PINNED_COMPATIBILITY_DEPENDENCIES=(
  package.json
  package-lock.json
  scripts/backup_r2/lib/hierarchical_backup_v2.mjs
  scripts/backup_r2/lib/uk_aq_parquet_dependencies.mjs
  scripts/backup_r2/uk_aq_build_r2_history_index.mjs
  scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs
  scripts/operations/uk_aq_with_observations_global_operation_lock.mjs
  workers/shared/r2_sigv4.mjs
  workers/shared/uk_aq_connector_day_gate.mjs
  workers/shared/uk_aq_observation_content_hash.mjs
  workers/shared/uk_aq_observation_history_index_v3.mjs
  workers/shared/uk_aq_observation_history_schema.mjs
  workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs
  workers/shared/uk_aq_observation_history_target_writer.mjs
  workers/shared/uk_aq_observation_history_writer_limits_v3.mjs
  workers/shared/uk_aq_observation_property_code.mjs
  workers/shared/uk_aq_prune_connector_source_identity.mjs
  workers/shared/uk_aq_r2_checksum_publication.mjs
  workers/shared/uk_aq_r2_file_identity.mjs
  workers/shared/uk_aq_r2_history_canonical.mjs
  workers/shared/uk_aq_r2_history_index.mjs
  workers/shared/uk_aq_r2_history_manifest_validation.mjs
  workers/shared/uk_aq_r2_history_writer.mjs
  workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs
)
VERIFY_READ_ONLY_DEPENDENCIES=(
  "${VERIFY_CURRENT_ONLY_DEPENDENCIES[@]}"
  "${VERIFY_PINNED_COMPATIBILITY_DEPENDENCIES[@]}"
)
MUTATION_IMPLEMENTATION_SCOPES=(
  package.json
  package-lock.json
  scripts/backup_r2
  scripts/operations
  scripts/index_v3_migration/index_v3_migration.sh
  workers/shared
)

git_paths_are_unchanged() {
  local repository="$1" base="$2" current="$3"
  shift 3
  git -C "$repository" diff --quiet "$base" "$current" -- "$@"
}

current_verify_dependencies_are_trusted() {
  local repository="$1" dependency
  for dependency in "${VERIFY_READ_ONLY_DEPENDENCIES[@]}"; do
    git -C "$repository" ls-files --error-unmatch -- "$dependency" >/dev/null 2>&1 \
      || return 1
  done
  git -C "$repository" diff --quiet HEAD -- "${VERIFY_READ_ONLY_DEPENDENCIES[@]}"
}

self_test() {
  local output status drift_repo base_commit unrelated_commit critical_commit critical_path mutation_mode
  set +e
  output="$("$0" 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || stop "self-test: missing mode did not fail"
  printf '%s' "$output" | grep -Fq 'an explicit mode is required' \
    || stop "self-test: missing mode failure was unclear"
  set +e
  output="$(env -u UK_AQ_INDEX_V3_MIGRATION_AUTH "$0" --_self-test-auth 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || stop "self-test: missing mutation authorisation did not fail"
  UK_AQ_INDEX_V3_MIGRATION_AUTH='SELF_TEST_AUTH' "$0" --_self-test-auth >/dev/null \
    || stop "self-test: exact mutation authorisation was rejected"
  drift_repo="$(mktemp -d "${TMPDIR:-/tmp}/uk-aq-index-v3-verify-drift.XXXXXX")"
  critical_path="scripts/backup_r2/lib/hierarchical_backup_v2.mjs"
  git -C "$drift_repo" init -q
  git -C "$drift_repo" config user.email 'index-v3-self-test@example.invalid'
  git -C "$drift_repo" config user.name 'Index v3 self-test'
  mkdir -p -- "$drift_repo/scripts/backup_r2/lib"
  printf '%s\n' 'critical-v1' > "$drift_repo/$critical_path"
  git -C "$drift_repo" add -- "$critical_path"
  git -C "$drift_repo" commit -qm 'base'
  base_commit="$(git -C "$drift_repo" rev-parse HEAD)"
  printf '%s\n' 'unrelated-later-tool' > "$drift_repo/scripts/backup_r2/unrelated_later_tool.mjs"
  git -C "$drift_repo" add -- scripts/backup_r2/unrelated_later_tool.mjs
  git -C "$drift_repo" commit -qm 'unrelated backup tool'
  unrelated_commit="$(git -C "$drift_repo" rev-parse HEAD)"
  git_paths_are_unchanged "$drift_repo" "$base_commit" "$unrelated_commit" \
    "${VERIFY_PINNED_COMPATIBILITY_DEPENDENCIES[@]}" \
    || stop "self-test: unrelated backup file tripped read-only verify drift"
  for mutation_mode in migrate resume; do
    if git_paths_are_unchanged "$drift_repo" "$base_commit" "$unrelated_commit" \
      "${MUTATION_IMPLEMENTATION_SCOPES[@]}"; then
      stop "self-test: unrelated backup file escaped $mutation_mode drift protection"
    fi
  done
  printf '%s\n' 'critical-v2' > "$drift_repo/$critical_path"
  git -C "$drift_repo" add -- "$critical_path"
  git -C "$drift_repo" commit -qm 'critical verifier change'
  critical_commit="$(git -C "$drift_repo" rev-parse HEAD)"
  if git_paths_are_unchanged "$drift_repo" "$base_commit" "$critical_commit" \
    "${VERIFY_PINNED_COMPATIBILITY_DEPENDENCIES[@]}"; then
    stop "self-test: verification-critical drift was accepted"
  fi
  rm -rf -- "$drift_repo"
  printf 'PASS: no mode defaults to mutation\n'
  printf 'PASS: mutating modes retain exact explicit authorisation\n'
  printf 'PASS: unrelated backup evolution does not trip read-only verify drift\n'
  printf 'PASS: verification-critical drift fails while mutation drift remains broad\n'
}

case "${1:-}" in
  --self-test) self_test; exit 0 ;;
  --_self-test-auth)
    require_authorization UK_AQ_INDEX_V3_MIGRATION_AUTH SELF_TEST_AUTH
    exit 0
    ;;
esac

[ "$#" -gt 0 ] || { usage >&2; stop "an explicit mode is required"; }
MODE="$1"
shift
case "$MODE" in plan|migrate|resume|verify) ;; *) usage >&2; stop "unsupported mode: $MODE" ;; esac

WORK_DIR=""
MIGRATION_RUN_ID=""
DROPBOX_ROOT=""
SITE_URL=""
INVENTORY_SHA=""
STATE_SHA=""
AUTHORITY_FILE=""
PLAN_REPORT=""
CHECKPOINT=""
REPORT_OUT=""
WRITER_FREEZE_EVIDENCE=""
APPLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --work-dir) WORK_DIR="${2:-}"; shift 2 ;;
    --migration-run-id) MIGRATION_RUN_ID="${2:-}"; shift 2 ;;
    --dropbox-root) DROPBOX_ROOT="${2:-}"; shift 2 ;;
    --site-url) SITE_URL="${2:-}"; shift 2 ;;
    --inventory-root-sha256) INVENTORY_SHA="${2:-}"; shift 2 ;;
    --state-root-sha256) STATE_SHA="${2:-}"; shift 2 ;;
    --authority-file) AUTHORITY_FILE="${2:-}"; shift 2 ;;
    --plan-report) PLAN_REPORT="${2:-}"; shift 2 ;;
    --checkpoint) CHECKPOINT="${2:-}"; shift 2 ;;
    --report-out) REPORT_OUT="${2:-}"; shift 2 ;;
    --writer-freeze-evidence) WRITER_FREEZE_EVIDENCE="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; stop "unknown argument: $1" ;;
  esac
done

[ -n "$WORK_DIR" ] || stop "--work-dir is required"
[ -n "$DROPBOX_ROOT" ] || stop "--dropbox-root is required"
mkdir -p -- "$WORK_DIR"
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"
AUTHORITY_FILE="${AUTHORITY_FILE:-$WORK_DIR/operator_authority.json}"
PLAN_REPORT="${PLAN_REPORT:-$WORK_DIR/migration_plan_report.json}"
CHECKPOINT="${CHECKPOINT:-$WORK_DIR/migration_checkpoint.json}"
WRITER_LIMITS="$WORK_DIR/writer_limits.json"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || stop "repository root cannot be derived from Git"
cd -- "$REPO_ROOT"

MIGRATION_CLI="scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs"
PREFLIGHT="scripts/index_v3_migration/index_v3_preflight.sh"

for command in git gh jq node; do
  command -v "$command" >/dev/null 2>&1 || stop "required command is unavailable: $command"
done
[ -f "$MIGRATION_CLI" ] || stop "migration CLI is missing: $MIGRATION_CLI"
[ -x "$PREFLIGHT" ] || stop "preflight is missing or not executable: $PREFLIGHT"

for name in \
  UKAQ_ENV_NAME \
  UK_AQ_R2_HISTORY_VERSION \
  UK_AQ_R2_HISTORY_INDEX_VERSION \
  UK_AQ_R2_HISTORY_INTEGRITY_VERSION \
  CFLARE_R2_BUCKET \
  CFLARE_R2_ENDPOINT \
  CFLARE_R2_ACCESS_KEY_ID \
  CFLARE_R2_SECRET_ACCESS_KEY
do
  [ -n "${!name:-}" ] || stop "required loaded environment value is missing: $name"
done

ENVIRONMENT="$(printf '%s' "$UKAQ_ENV_NAME" | tr '[:lower:]' '[:upper:]')"
case "$ENVIRONMENT" in TEST|LIVE) ;; *) stop "UKAQ_ENV_NAME must identify TEST or LIVE" ;; esac
export UK_AQ_ENV_NAME="$ENVIRONMENT"
export CFLARE_R2_REGION="${CFLARE_R2_REGION:-auto}"

printf '%s\n' '============================================================'
printf 'UK AQ INDEX V3 MIGRATION: %s / %s\n' "$ENVIRONMENT" "$MODE"
printf 'Repository root: %s\n' "$REPO_ROOT"
printf '%s\n' '============================================================'

write_writer_limits() {
  printf '%s\n' '{' \
    '  "target_row_group_rows": 8192,' \
    '  "max_row_group_rows": 16384,' \
    '  "target_file_rows": 65536,' \
    '  "max_file_rows": 131072,' \
    '  "target_file_bytes": 4194304,' \
    '  "max_file_bytes": 8388608,' \
    '  "max_row_groups_per_file": 8' \
    '}' > "$WRITER_LIMITS"
  chmod 600 "$WRITER_LIMITS"
}

load_authority() {
  [ -f "$AUTHORITY_FILE" ] || stop "operator authority is missing: $AUTHORITY_FILE"
  [ -f "$PLAN_REPORT" ] || stop "migration plan report is missing: $PLAN_REPORT"
  jq -e '.schema_version == 1 and .kind == "uk_aq_index_v3_operator_authority"' \
    "$AUTHORITY_FILE" >/dev/null 2>&1 || stop "operator authority is malformed"
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
    (.audit.blockers | type == "array" and length == 0)
  ' "$PLAN_REPORT" >/dev/null 2>&1 || stop "migration plan authority is not accepted"
  AUTH_ENV="$(jq -r '.environment // empty' "$AUTHORITY_FILE" | tr '[:lower:]' '[:upper:]')"
  AUTH_REPO="$(jq -r '.repository // empty' "$AUTHORITY_FILE")"
  AUTH_BRANCH="$(jq -r '.branch // empty' "$AUTHORITY_FILE")"
  TARGET_WRITER_GIT_SHA="$(jq -r '.target_writer_git_sha // empty' "$AUTHORITY_FILE")"
  MIGRATION_RUN_ID="$(jq -r '.migration_run_id // empty' "$AUTHORITY_FILE")"
  PLAN_SHA="$(jq -r '.plan_sha256 // empty' "$AUTHORITY_FILE")"
  INVENTORY_SHA="$(jq -r '.inventory_root_sha256 // empty' "$AUTHORITY_FILE")"
  STATE_SHA="$(jq -r '.state_root_sha256 // empty' "$AUTHORITY_FILE")"
  [ "$AUTH_ENV" = "$ENVIRONMENT" ] || stop "authority environment does not match $ENVIRONMENT"
  [ "$(jq -r '.result.environment.environment // empty' "$PLAN_REPORT" | tr '[:lower:]' '[:upper:]')" = "$ENVIRONMENT" ] \
    || stop "plan environment does not match $ENVIRONMENT"
  [ "$(jq -r '.result.environment.bucket // empty' "$PLAN_REPORT")" = "$CFLARE_R2_BUCKET" ] \
    || stop "plan R2 bucket does not match the loaded environment"
  [ "$AUTH_REPO" = "$(gh repo view --json nameWithOwner -q .nameWithOwner)" ] \
    || stop "authority repository does not match the current GitHub repository"
  [ "$AUTH_BRANCH" = "$(git branch --show-current)" ] \
    || stop "authority branch does not match the current branch"
  [ "$(jq -r '.result.plan_sha256 // empty' "$PLAN_REPORT")" = "$PLAN_SHA" ] \
    || stop "plan report does not match operator authority"
  [ "$(jq -r '.result.migration_run_id // empty' "$PLAN_REPORT")" = "$MIGRATION_RUN_ID" ] \
    || stop "plan report migration run ID does not match operator authority"
  printf '%s' "$TARGET_WRITER_GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' \
    || stop "pinned target writer Git SHA is malformed"
  for identity in "$PLAN_SHA" "$INVENTORY_SHA" "$STATE_SHA"; do
    printf '%s' "$identity" | grep -Eq '^[0-9a-f]{64}$' \
      || stop "operator authority contains a malformed SHA-256 identity"
  done
  git cat-file -e "${TARGET_WRITER_GIT_SHA}^{commit}" 2>/dev/null \
    || stop "pinned target writer commit is unavailable"
  git merge-base --is-ancestor "$TARGET_WRITER_GIT_SHA" "$(git rev-parse HEAD)" \
    || stop "pinned target writer commit is not an ancestor of current HEAD"
  if [ "$MODE" = "verify" ]; then
    current_verify_dependencies_are_trusted "$REPO_ROOT" \
      || stop "current read-only verification dependency set is not exact, tracked current HEAD"
    LOAD_AUTHORITY_DRIFT="$(git diff --name-only "$TARGET_WRITER_GIT_SHA" HEAD -- \
      "${VERIFY_PINNED_COMPATIBILITY_DEPENDENCIES[@]}")"
  else
    LOAD_AUTHORITY_DRIFT="$(git diff --name-only "$TARGET_WRITER_GIT_SHA" HEAD -- \
      "${MUTATION_IMPLEMENTATION_SCOPES[@]}")"
  fi
  [ -z "$LOAD_AUTHORITY_DRIFT" ] \
    || stop "migration/recovery implementation differs from the pinned target writer commit"
  write_writer_limits
}

run_cli() {
  node --max-old-space-size=4096 "$MIGRATION_CLI" "$@"
}

if [ "$MODE" = "plan" ]; then
  [ "$APPLY" -eq 0 ] || stop "plan mode does not accept --apply"
  [ -n "$MIGRATION_RUN_ID" ] || stop "plan requires --migration-run-id"
  printf '%s' "$INVENTORY_SHA" | grep -Eq '^[0-9a-f]{64}$' \
    || stop "plan requires a valid --inventory-root-sha256"
  printf '%s' "$STATE_SHA" | grep -Eq '^[0-9a-f]{64}$' \
    || stop "plan requires a valid --state-root-sha256"
  [ ! -e "$AUTHORITY_FILE" ] || stop "operator authority already exists: $AUTHORITY_FILE"
  [ ! -e "$PLAN_REPORT" ] || stop "plan report already exists: $PLAN_REPORT"
  [ ! -e "$CHECKPOINT" ] || stop "checkpoint already exists: $CHECKPOINT"

  "$PREFLIGHT" --stage plan
  TARGET_WRITER_GIT_SHA="$(git rev-parse HEAD)"
  REPOSITORY="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  BRANCH="$(git branch --show-current)"
  write_writer_limits

  run_cli \
    --mode plan \
    --environment "$ENVIRONMENT" \
    --expected-bucket "$CFLARE_R2_BUCKET" \
    --migration-run-id "$MIGRATION_RUN_ID" \
    --target-writer-git-sha "$TARGET_WRITER_GIT_SHA" \
    --writer-limits-json "$WRITER_LIMITS" \
    --dropbox-root "$DROPBOX_ROOT" \
    --expected-inventory-root-sha256 "$INVENTORY_SHA" \
    --expected-state-root-sha256 "$STATE_SHA" \
    --report-out "$PLAN_REPORT" > "$WORK_DIR/migration_plan_stdout.json"

  PLAN_SHA="$(jq -r '.result.plan_sha256 // empty' "$PLAN_REPORT")"
  [ -n "$PLAN_SHA" ] || stop "completed plan did not emit a plan SHA-256"
  AUTHORITY_TMP="$AUTHORITY_FILE.tmp-$$"
  export AUTHORITY_TMP ENVIRONMENT REPOSITORY BRANCH TARGET_WRITER_GIT_SHA MIGRATION_RUN_ID PLAN_SHA INVENTORY_SHA STATE_SHA
  node --input-type=module <<'NODE'
import fs from "node:fs";
const authority = {
  schema_version: 1,
  kind: "uk_aq_index_v3_operator_authority",
  environment: process.env.ENVIRONMENT,
  repository: process.env.REPOSITORY,
  branch: process.env.BRANCH,
  target_writer_git_sha: process.env.TARGET_WRITER_GIT_SHA,
  migration_run_id: process.env.MIGRATION_RUN_ID,
  plan_sha256: process.env.PLAN_SHA,
  inventory_root_sha256: process.env.INVENTORY_SHA,
  state_root_sha256: process.env.STATE_SHA,
};
fs.writeFileSync(process.env.AUTHORITY_TMP, `${JSON.stringify(authority, null, 2)}\n`, { mode: 0o600 });
NODE
  mv -- "$AUTHORITY_TMP" "$AUTHORITY_FILE"
  printf 'PLAN COMPLETE (READ-ONLY)\nAuthority: %s\nReport: %s\nNO CUTOVER WAS PERFORMED.\n' \
    "$AUTHORITY_FILE" "$PLAN_REPORT"
  exit 0
fi

load_authority

if [ "$MODE" = "migrate" ]; then
  [ "$APPLY" -eq 1 ] || stop "migrate requires the explicit --apply flag"
  [ -n "$SITE_URL" ] || stop "migrate requires --site-url for positive maintenance verification"
  [ -n "$WRITER_FREEZE_EVIDENCE" ] || stop "migrate requires --writer-freeze-evidence"
  [ ! -e "$CHECKPOINT" ] || stop "migrate checkpoint already exists; use explicit resume mode"
  REPORT_OUT="${REPORT_OUT:-$WORK_DIR/migration_report.json}"
  EXPECTED_AUTH="AUTHORISE_${ENVIRONMENT}_INDEX_V3_MIGRATE:${MIGRATION_RUN_ID}:${PLAN_SHA}"
  require_authorization UK_AQ_INDEX_V3_MIGRATION_AUTH "$EXPECTED_AUTH"
  "$PREFLIGHT" --stage migration-start \
    --authority-file "$AUTHORITY_FILE" \
    --plan-report "$PLAN_REPORT" \
    --dropbox-root "$DROPBOX_ROOT" \
    --site-url "$SITE_URL" \
    --writer-freeze-evidence "$WRITER_FREEZE_EVIDENCE"
  run_cli \
    --mode migrate --apply --writers-frozen \
    --environment "$ENVIRONMENT" \
    --expected-bucket "$CFLARE_R2_BUCKET" \
    --migration-run-id "$MIGRATION_RUN_ID" \
    --target-writer-git-sha "$TARGET_WRITER_GIT_SHA" \
    --writer-limits-json "$WRITER_LIMITS" \
    --dropbox-root "$DROPBOX_ROOT" \
    --expected-inventory-root-sha256 "$INVENTORY_SHA" \
    --expected-state-root-sha256 "$STATE_SHA" \
    --expected-plan-sha256 "$PLAN_SHA" \
    --checkpoint-out "$CHECKPOINT" \
    --report-out "$REPORT_OUT"
  printf 'MIGRATION COMMAND COMPLETE. NO CUTOVER WAS PERFORMED.\n'
  exit 0
fi

if [ "$MODE" = "resume" ]; then
  trap '' HUP
  [ "$APPLY" -eq 1 ] || stop "resume requires the explicit --apply flag"
  [ -n "$SITE_URL" ] || stop "resume requires --site-url for positive maintenance verification"
  [ -n "$WRITER_FREEZE_EVIDENCE" ] || stop "resume requires --writer-freeze-evidence"
  [ -f "$CHECKPOINT" ] || stop "resume requires an existing checkpoint: $CHECKPOINT"
  REPORT_OUT="${REPORT_OUT:-$WORK_DIR/migration_resume_report.json}"
  EXPECTED_AUTH="AUTHORISE_${ENVIRONMENT}_INDEX_V3_RESUME:${MIGRATION_RUN_ID}:${PLAN_SHA}"
  require_authorization UK_AQ_INDEX_V3_RESUME_AUTH "$EXPECTED_AUTH"
  "$PREFLIGHT" --stage migration-start \
    --authority-file "$AUTHORITY_FILE" \
    --plan-report "$PLAN_REPORT" \
    --dropbox-root "$DROPBOX_ROOT" \
    --site-url "$SITE_URL" \
    --writer-freeze-evidence "$WRITER_FREEZE_EVIDENCE"
  run_cli \
    --mode migrate --apply --writers-frozen \
    --environment "$ENVIRONMENT" \
    --expected-bucket "$CFLARE_R2_BUCKET" \
    --migration-run-id "$MIGRATION_RUN_ID" \
    --target-writer-git-sha "$TARGET_WRITER_GIT_SHA" \
    --writer-limits-json "$WRITER_LIMITS" \
    --dropbox-root "$DROPBOX_ROOT" \
    --expected-inventory-root-sha256 "$INVENTORY_SHA" \
    --expected-state-root-sha256 "$STATE_SHA" \
    --expected-plan-sha256 "$PLAN_SHA" \
    --checkpoint-in "$CHECKPOINT" \
    --checkpoint-out "$CHECKPOINT" \
    --report-out "$REPORT_OUT"
  printf 'RESUME COMMAND COMPLETE. NO CUTOVER WAS PERFORMED.\n'
  exit 0
fi

[ "$APPLY" -eq 0 ] || stop "verify mode does not accept --apply"
[ -f "$CHECKPOINT" ] || stop "verify requires an existing checkpoint: $CHECKPOINT"
REPORT_OUT="${REPORT_OUT:-$WORK_DIR/migration_verify_report.json}"
case "$UK_AQ_R2_HISTORY_INDEX_VERSION" in
  v2)
    "$PREFLIGHT" --stage plan
    ;;
  v3)
    REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
      || stop "GitHub repository identity could not be read for post-cutover verification"
    for variable_name in UK_AQ_R2_HISTORY_VERSION UK_AQ_R2_HISTORY_INDEX_VERSION UK_AQ_R2_HISTORY_INTEGRITY_VERSION; do
      actual_value="$(gh variable get "$variable_name" --repo "$REPO_SLUG" 2>/dev/null)" \
        || stop "GitHub variable $variable_name could not be read"
      [ "$actual_value" = "${!variable_name}" ] \
        || stop "GitHub $variable_name differs from the independently loaded verification value"
    done
    printf 'POST-CUTOVER VERIFY: GitHub history/index/integrity authorities match the loaded read-only verifier.\n'
    ;;
  *)
    stop "verify requires loaded UK_AQ_R2_HISTORY_INDEX_VERSION=v2 or v3"
    ;;
esac
run_cli \
  --mode verify \
  --environment "$ENVIRONMENT" \
  --expected-bucket "$CFLARE_R2_BUCKET" \
  --migration-run-id "$MIGRATION_RUN_ID" \
  --target-writer-git-sha "$TARGET_WRITER_GIT_SHA" \
  --writer-limits-json "$WRITER_LIMITS" \
  --dropbox-root "$DROPBOX_ROOT" \
  --expected-inventory-root-sha256 "$INVENTORY_SHA" \
  --expected-state-root-sha256 "$STATE_SHA" \
  --expected-plan-sha256 "$PLAN_SHA" \
  --checkpoint-in "$CHECKPOINT" \
  --report-out "$REPORT_OUT"
printf 'VERIFY COMPLETE (READ-ONLY). NO CUTOVER WAS PERFORMED.\n'
