#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops"
VERIFY_REPORT="$REPO_ROOT/tmp/phase6_index_v3/post_migration_verify_report.json"
RECOVERY_HEAD="/Users/mikehinford/uk-aq-work/index_v3_migration/step10/migration_checkpoint.json.recovery/head.json"
CHECKPOINT="/Users/mikehinford/uk-aq-work/index_v3_migration/step10/migration_checkpoint.json"

EXPECTED_HEAD="95b62d374a98c16f4b48c762ce450db803534237"
EXPECTED_SEQUENCE="79387"
EXPECTED_LAST_ENTRY_SHA="0493c1ccdb82f1914846d142520f4369a6bc6b3a40c44a8ec37879d157d6b4fa"
EXPECTED_CHECKPOINT_SHA="dabab5f5fb406af461dd6355780731b4c862b1fade14b362bfc93e5ef88c1c98"
EXPECTED_AUTHORITY_SHA="52ec1bb14fafcc05241b28202793f572ff0bf78d79a5c9af42de8f420bdc64eb"
EXPECTED_CHECKPOINT_BYTES="502003733"

failures=0

pass_check() { printf 'PASS: %s\n' "$1"; }
fail_check() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }

for cmd in git jq pgrep shasum stat; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "STOP: required command missing: $cmd"; exit 2; }
done

echo
echo "============================================================"
echo "UK AQ Phase 6 - TEST PRE-CUTOVER MORNING GATE"
echo "READ-ONLY"
echo "============================================================"
echo

[ -d "$REPO_ROOT/.git" ] || { echo "STOP: TEST Ops repository not found"; exit 2; }
[ -f "$VERIFY_REPORT" ] || { echo "STOP: final verification report not found: $VERIFY_REPORT"; exit 2; }
[ -f "$RECOVERY_HEAD" ] || { echo "STOP: recovery head not found: $RECOVERY_HEAD"; exit 2; }
[ -f "$CHECKPOINT" ] || { echo "STOP: immutable checkpoint not found: $CHECKPOINT"; exit 2; }

cd "$REPO_ROOT"

echo "=== REPOSITORY ==="
CURRENT_HEAD="$(git rev-parse HEAD)"
echo "HEAD: $CURRENT_HEAD"

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

if [ "$CURRENT_HEAD" = "$EXPECTED_HEAD" ]; then
  pass_check "repository HEAD matches reviewed cutover-prep commit"
else
  fail_check "repository HEAD differs from expected $EXPECTED_HEAD"
fi

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
  rollback_ready: .audit.rollback_ready
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
  .audit.rollback_ready == true
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

[ "$CHECKPOINT_BYTES" = "$EXPECTED_CHECKPOINT_BYTES" ] && pass_check "immutable checkpoint byte size matches" || fail_check "immutable checkpoint byte size differs"
[ "$CHECKPOINT_SHA" = "$EXPECTED_CHECKPOINT_SHA" ] && pass_check "immutable checkpoint SHA-256 matches" || fail_check "immutable checkpoint SHA-256 differs"

echo
echo "============================================================"
if [ "$failures" -eq 0 ]; then
  echo "TEST PRE-CUTOVER MORNING GATE: PASS"
  echo
  echo "No runtime/data changes were made."
  echo "Safe to proceed to the next read-only cutover-state checks."
  echo "============================================================"
  exit 0
else
  echo "TEST PRE-CUTOVER MORNING GATE: STOP"
  echo
  echo "$failures check(s) failed."
  echo "Do NOT perform the TEST v3 cutover until reviewed."
  echo "============================================================"
  exit 1
fi
