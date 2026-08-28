#!/usr/bin/env bash
set -euo pipefail

# UK AQ Phase 6 - TEST pre-cutover morning gate v2
#
# READ-ONLY with respect to UK AQ runtime/data systems.
#
# This gate deliberately does NOT require the entire repository HEAD to remain
# frozen at the reviewed migration commit. Unrelated commits may have landed
# since then. Instead it requires:
#   1. the reviewed migration baseline to be an ancestor of current HEAD;
#   2. the working tree to be clean;
#   3. migration/recovery-critical files to be unchanged from that baseline;
#   4. the accepted migration/verification evidence to remain intact.
#
# It does NOT change R2, D1, Supabase, Cloudflare, schedulers, maintenance
# state, runtime index authority, Dropbox data, or preserved migration evidence.

REPO_ROOT="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops"
EXPECTED_ORIGIN_HTTPS="https://github.com/TEST-uk-aq/uk-aq-ops.git"
EXPECTED_ORIGIN_SSH="git@github.com:TEST-uk-aq/uk-aq-ops.git"
EXPECTED_BRANCH="main"

# Reviewed commit containing the completed reporting correction.
REVIEWED_MIGRATION_BASELINE="95b62d374a98c16f4b48c762ce450db803534237"

VERIFY_REPORT="$REPO_ROOT/tmp/phase6_index_v3/post_migration_verify_report.json"
RECOVERY_HEAD="/Users/mikehinford/uk-aq-work/index_v3_migration/step10/migration_checkpoint.json.recovery/head.json"
CHECKPOINT="/Users/mikehinford/uk-aq-work/index_v3_migration/step10/migration_checkpoint.json"

EXPECTED_SEQUENCE="79387"
EXPECTED_LAST_ENTRY_SHA="0493c1ccdb82f1914846d142520f4369a6bc6b3a40c44a8ec37879d157d6b4fa"
EXPECTED_CHECKPOINT_SHA="dabab5f5fb406af461dd6355780731b4c862b1fade14b362bfc93e5ef88c1c98"
EXPECTED_AUTHORITY_SHA="52ec1bb14fafcc05241b28202793f572ff0bf78d79a5c9af42de8f420bdc64eb"
EXPECTED_CHECKPOINT_BYTES="502003733"

CRITICAL_PATHS=(
  package.json
  package-lock.json
  scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs
  scripts/backup_r2/lib/observation_history_migration_v3.mjs
  scripts/backup_r2/lib/hierarchical_backup_v2.mjs
  scripts/backup_r2/lib/uk_aq_parquet_dependencies.mjs
  scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs
  scripts/backup_r2/uk_aq_build_r2_history_index.mjs
  scripts/index_v3_migration/run_step9_plan.sh
  scripts/index_v3_migration/run_step10_migrate.sh
  scripts/index_v3_migration/run_step10_resume.sh
  scripts/operations/uk_aq_with_observations_global_operation_lock.mjs
  workers/shared/r2_sigv4.mjs
  workers/shared/uk_aq_observation_content_hash.mjs
  workers/shared/uk_aq_observation_history_index_v3.mjs
  workers/shared/uk_aq_observation_history_schema.mjs
  workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs
  workers/shared/uk_aq_observation_history_target_writer.mjs
  workers/shared/uk_aq_observation_history_writer_limits_v3.mjs
  workers/shared/uk_aq_r2_checksum_publication.mjs
  workers/shared/uk_aq_r2_file_identity.mjs
  workers/shared/uk_aq_r2_history_canonical.mjs
  workers/shared/uk_aq_r2_history_index.mjs
  workers/shared/uk_aq_r2_history_writer.mjs
  workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs
)

failures=0

pass_check() { printf 'PASS: %s\n' "$1"; }
fail_check() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
stop_now() { printf 'STOP: %s\n' "$1"; exit 2; }

for cmd in git jq pgrep shasum stat awk; do
  command -v "$cmd" >/dev/null 2>&1 || stop_now "required command missing: $cmd"
done

echo
echo "============================================================"
echo "UK AQ Phase 6 - TEST PRE-CUTOVER MORNING GATE v2"
echo "READ-ONLY"
echo "============================================================"
echo

[ -d "$REPO_ROOT/.git" ] || stop_now "TEST Ops repository not found: $REPO_ROOT"
[ -f "$VERIFY_REPORT" ] || stop_now "final verification report not found: $VERIFY_REPORT"
[ -f "$RECOVERY_HEAD" ] || stop_now "recovery head not found: $RECOVERY_HEAD"
[ -f "$CHECKPOINT" ] || stop_now "immutable checkpoint not found: $CHECKPOINT"

cd "$REPO_ROOT"

echo "=== REPOSITORY ==="

CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_BRANCH="$(git branch --show-current)"
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"

echo "HEAD:   $CURRENT_HEAD"
echo "Branch: $CURRENT_BRANCH"
echo "Origin: $ORIGIN_URL"
echo "Reviewed migration baseline: $REVIEWED_MIGRATION_BASELINE"

STATUS="$(git status --short)"
if [ -n "$STATUS" ]; then
  echo
  echo "Working tree changes:"
  printf '%s\n' "$STATUS"
  fail_check "TEST Ops working tree is not clean"
else
  echo "Working tree: clean"
  pass_check "TEST Ops working tree is clean"
fi

if [ "$CURRENT_BRANCH" = "$EXPECTED_BRANCH" ]; then
  pass_check "repository branch is $EXPECTED_BRANCH"
else
  fail_check "repository branch is $CURRENT_BRANCH, expected $EXPECTED_BRANCH"
fi

if [ "$ORIGIN_URL" = "$EXPECTED_ORIGIN_HTTPS" ] || [ "$ORIGIN_URL" = "$EXPECTED_ORIGIN_SSH" ]; then
  pass_check "repository origin is the expected TEST Ops repository"
else
  fail_check "repository origin is not the expected TEST Ops repository"
fi

if git cat-file -e "${REVIEWED_MIGRATION_BASELINE}^{commit}" 2>/dev/null; then
  pass_check "reviewed migration baseline commit is available locally"
else
  fail_check "reviewed migration baseline commit is unavailable locally"
fi

if git merge-base --is-ancestor "$REVIEWED_MIGRATION_BASELINE" "$CURRENT_HEAD" 2>/dev/null; then
  pass_check "current HEAD descends from the reviewed migration baseline"
else
  fail_check "current HEAD does not descend from the reviewed migration baseline"
fi

echo
echo "=== MIGRATION / RECOVERY CODE DRIFT ==="

MISSING_CRITICAL=0
for path in "${CRITICAL_PATHS[@]}"; do
  if ! git cat-file -e "${REVIEWED_MIGRATION_BASELINE}:${path}" 2>/dev/null; then
    echo "Missing from reviewed baseline: $path"
    MISSING_CRITICAL=1
  elif ! git cat-file -e "HEAD:${path}" 2>/dev/null; then
    echo "Missing from current HEAD: $path"
    MISSING_CRITICAL=1
  fi
done

if [ "$MISSING_CRITICAL" -eq 0 ]; then
  pass_check "all critical paths exist in reviewed baseline and current HEAD"
else
  fail_check "one or more critical paths are missing"
fi

CRITICAL_DIFF="$(git diff --name-only "$REVIEWED_MIGRATION_BASELINE" "$CURRENT_HEAD" -- "${CRITICAL_PATHS[@]}")"
if [ -n "$CRITICAL_DIFF" ]; then
  echo
  echo "Critical paths changed since reviewed baseline:"
  printf '%s\n' "$CRITICAL_DIFF"
  fail_check "migration/recovery-critical committed code has drifted"
else
  echo "No critical-path drift detected."
  pass_check "migration/recovery-critical committed code is unchanged from reviewed baseline"
fi

echo
echo "=== COMMITS AFTER REVIEWED BASELINE ==="

POST_BASELINE_COMMITS="$(git log --oneline "${REVIEWED_MIGRATION_BASELINE}..${CURRENT_HEAD}" || true)"
if [ -n "$POST_BASELINE_COMMITS" ]; then
  printf '%s\n' "$POST_BASELINE_COMMITS"
else
  echo "none"
fi

echo
echo "These later commits are permitted only because the critical-path drift check above passed."

echo
echo "=== STEP 10 / VERIFY PROCESS CHECK ==="

PROCESS_MATCHES="$(pgrep -af 'uk_aq_observation_history_migration_v3|run_step10' || true)"
if [ -n "$PROCESS_MATCHES" ]; then
  echo "$PROCESS_MATCHES"
  fail_check "Step 10 / verification process is still running"
else
  echo "none"
  pass_check "no Step 10 / verification process is running"
fi

echo
echo "=== FINAL VERIFY RESULT ==="

jq '{
  ok: .result.ok,
  cutover_ready: .result.cutover_ready,
  full_verification_complete: .result.checkpoint_summary.full_verification_complete,
  blockers: .result.blocker_count,
  partitions: .result.partition_count,
  r2_sha: .result.r2_stored_sha_verification,
  scoped_root_child: .result.scoped_root_child_verification,
  completed_objects: .result.checkpoint_summary.completed_object_counts,
  rollback_ready: .audit.rollback_ready,
  publication_verification: .audit.publication_verification,
  verify_start_utc: .audit.start_utc,
  verify_end_utc: .audit.end_utc
}' "$VERIFY_REPORT"

if jq -e '
  .result.ok == true and
  .result.cutover_ready == true and
  .result.checkpoint_summary.full_verification_complete == true and
  .result.blocker_count == 0 and
  .result.partition_count == 4701 and
  .result.r2_stored_sha_verification == "verified" and
  .result.scoped_root_child_verification == "verified" and
  .result.checkpoint_summary.completed_object_counts.total == 39389 and
  .result.checkpoint_summary.completed_object_counts.parquet == 6599 and
  .result.checkpoint_summary.completed_object_counts.canonical_manifest == 6366 and
  .result.checkpoint_summary.completed_object_counts.v3_child_shard == 21722 and
  .result.checkpoint_summary.completed_object_counts.v3_scoped_manifest == 4701 and
  .result.checkpoint_summary.completed_object_counts.v3_latest_global == 1 and
  .result.checkpoint_summary.completed_object_counts.other == 0 and
  .audit.rollback_ready == true and
  .audit.publication_verification == true
' "$VERIFY_REPORT" >/dev/null; then
  pass_check "final post-migration verification is cutover-ready with zero blockers"
else
  fail_check "final post-migration verification does not match the accepted TEST result"
fi

echo
echo "=== RECOVERY HEAD ==="

jq '.payload | {
  last_sequence,
  last_entry_sha256,
  original_checkpoint_sha256,
  immutable_authority_sha256
}' "$RECOVERY_HEAD"

RECOVERY_SEQUENCE="$(jq -r '.payload.last_sequence' "$RECOVERY_HEAD")"
RECOVERY_LAST_SHA="$(jq -r '.payload.last_entry_sha256' "$RECOVERY_HEAD")"
RECOVERY_CHECKPOINT_SHA="$(jq -r '.payload.original_checkpoint_sha256' "$RECOVERY_HEAD")"
RECOVERY_AUTHORITY_SHA="$(jq -r '.payload.immutable_authority_sha256' "$RECOVERY_HEAD")"

[ "$RECOVERY_SEQUENCE" = "$EXPECTED_SEQUENCE" ] && pass_check "recovery journal sequence is $EXPECTED_SEQUENCE" || fail_check "recovery journal sequence is $RECOVERY_SEQUENCE, expected $EXPECTED_SEQUENCE"
[ "$RECOVERY_LAST_SHA" = "$EXPECTED_LAST_ENTRY_SHA" ] && pass_check "recovery journal head SHA matches" || fail_check "recovery journal head SHA differs from expected"
[ "$RECOVERY_CHECKPOINT_SHA" = "$EXPECTED_CHECKPOINT_SHA" ] && pass_check "recovery head references expected immutable checkpoint" || fail_check "recovery head references a different immutable checkpoint"
[ "$RECOVERY_AUTHORITY_SHA" = "$EXPECTED_AUTHORITY_SHA" ] && pass_check "immutable authority SHA matches" || fail_check "immutable authority SHA differs from expected"

echo
echo "=== IMMUTABLE CHECKPOINT ==="

CHECKPOINT_BYTES="$(stat -f '%z' "$CHECKPOINT")"
CHECKPOINT_SHA="$(shasum -a 256 "$CHECKPOINT" | awk '{print $1}')"

echo "bytes=$CHECKPOINT_BYTES"
echo "sha256=$CHECKPOINT_SHA"

[ "$CHECKPOINT_BYTES" = "$EXPECTED_CHECKPOINT_BYTES" ] && pass_check "immutable checkpoint byte size matches" || fail_check "immutable checkpoint byte size is $CHECKPOINT_BYTES, expected $EXPECTED_CHECKPOINT_BYTES"
[ "$CHECKPOINT_SHA" = "$EXPECTED_CHECKPOINT_SHA" ] && pass_check "immutable checkpoint SHA-256 matches" || fail_check "immutable checkpoint SHA-256 differs"

echo
echo "============================================================"

if [ "$failures" -eq 0 ]; then
  echo "TEST PRE-CUTOVER MORNING GATE v2: PASS"
  echo
  echo "No runtime/data changes were made."
  echo "Current repository HEAD may be newer than the reviewed baseline,"
  echo "but migration/recovery-critical committed code is unchanged."
  echo
  echo "Safe to proceed to the next read-only cutover-state checks."
  echo "============================================================"
  exit 0
fi

echo "TEST PRE-CUTOVER MORNING GATE v2: STOP"
echo
echo "$failures check(s) failed."
echo "Do NOT perform the TEST v3 cutover until reviewed."
echo "============================================================"
exit 1
