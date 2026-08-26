#!/bin/bash

set -euo pipefail

REPO="TEST-uk-aq/uk-aq-ops"
EXPECTED_HEAD="b8858d95c42ff52558cb0fa59413162d6bc12afa"

INVENTORY_SHA256="4329f2966d807ada9991280ebbe460aae20a21cebcd613a3fb2b3cf01fd08b23"
STATE_SHA256="d9b2160331599a47d2f17df23c57088d421605f2fb3fbd8259528f41360d598e"

DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/TEST/R2_history_backup"

MIGRATION_RUN_ID="test-observation-history-v3-20260825"

WORK_DIR="tmp/phase6_index_v3"
WRITER_LIMITS="$WORK_DIR/writer_limits.json"
PLAN_REPORT="$WORK_DIR/migration_plan_report.json"
PLAN_STDOUT="$WORK_DIR/migration_plan_stdout.json"

echo
echo "============================================================"
echo "UK AQ Phase 6 - Step 9"
echo "NON-MUTATING observation-history v3 migration plan"
echo "============================================================"
echo

ACTUAL_HEAD="$(git rev-parse HEAD)"

echo "Expected HEAD: $EXPECTED_HEAD"
echo "Actual HEAD:   $ACTUAL_HEAD"

if [ "$ACTUAL_HEAD" != "$EXPECTED_HEAD" ]; then
  echo
  echo "STOP: TEST ops HEAD has changed."
  exit 1
fi

echo
echo "Checking that migration/writer code has no uncommitted changes..."

if ! git diff --quiet -- \
  scripts/backup_r2 \
  workers/shared \
  package.json \
  package-lock.json
then
  echo "STOP: relevant migration/writer files have uncommitted changes."
  git status --short -- \
    scripts/backup_r2 \
    workers/shared \
    package.json \
    package-lock.json
  exit 1
fi

if ! git diff --cached --quiet -- \
  scripts/backup_r2 \
  workers/shared \
  package.json \
  package-lock.json
then
  echo "STOP: relevant migration/writer files have staged changes."
  git status --short -- \
    scripts/backup_r2 \
    workers/shared \
    package.json \
    package-lock.json
  exit 1
fi

echo "Migration/writer code identity is clean."

echo
echo "Reading TEST GitHub configuration..."

HISTORY_VERSION="$(gh variable get UK_AQ_R2_HISTORY_VERSION --repo "$REPO" 2>/dev/null || true)"
INDEX_VERSION="$(gh variable get UK_AQ_R2_HISTORY_INDEX_VERSION --repo "$REPO" 2>/dev/null || true)"
R2_BUCKET="$(gh variable get CFLARE_R2_BUCKET --repo "$REPO" 2>/dev/null || true)"
R2_ENDPOINT="$(gh variable get CFLARE_R2_ENDPOINT --repo "$REPO" 2>/dev/null || true)"

echo "History version:   $HISTORY_VERSION"
echo "Index version:     $INDEX_VERSION"
echo "R2 bucket:         $R2_BUCKET"

if [ "$HISTORY_VERSION" != "v2" ]; then
  echo "STOP: expected UK_AQ_R2_HISTORY_VERSION=v2."
  exit 1
fi

if [ "$INDEX_VERSION" != "v2" ]; then
  echo "STOP: expected UK_AQ_R2_HISTORY_INDEX_VERSION=v2."
  exit 1
fi

if [ "$R2_BUCKET" != "uk-aq-history-cic-test" ]; then
  echo "STOP: unexpected TEST R2 bucket."
  exit 1
fi

if [ -z "$R2_ENDPOINT" ]; then
  echo "STOP: CFLARE_R2_ENDPOINT GitHub variable is missing."
  exit 1
fi

echo
echo "Checking local/venv migration environment..."

: "${UK_AQ_R2_HISTORY_INTEGRITY_VERSION:?STOP: UK_AQ_R2_HISTORY_INTEGRITY_VERSION is not set}"
: "${CFLARE_R2_ACCESS_KEY_ID:?STOP: CFLARE_R2_ACCESS_KEY_ID is not set}"
: "${CFLARE_R2_SECRET_ACCESS_KEY:?STOP: CFLARE_R2_SECRET_ACCESS_KEY is not set}"

if [ "$UK_AQ_R2_HISTORY_INTEGRITY_VERSION" != "v2" ]; then
  echo "STOP: expected UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2."
  echo "Actual: $UK_AQ_R2_HISTORY_INTEGRITY_VERSION"
  exit 1
fi

echo "Integrity version: $UK_AQ_R2_HISTORY_INTEGRITY_VERSION"

export UK_AQ_ENV_NAME="TEST"
export UK_AQ_R2_HISTORY_VERSION="$HISTORY_VERSION"
export UK_AQ_R2_HISTORY_INDEX_VERSION="$INDEX_VERSION"
export CFLARE_R2_BUCKET="$R2_BUCKET"
export CFLARE_R2_ENDPOINT="$R2_ENDPOINT"
export CFLARE_R2_REGION="auto"

TARGET_WRITER_GIT_SHA="$ACTUAL_HEAD"

mkdir -p "$WORK_DIR"

cat > "$WRITER_LIMITS" <<'JSON'
{
  "target_row_group_rows": 8192,
  "max_row_group_rows": 16384,
  "target_file_rows": 65536,
  "max_file_rows": 131072,
  "target_file_bytes": 4194304,
  "max_file_bytes": 8388608,
  "max_row_groups_per_file": 8
}
JSON

echo
echo "Pinned inputs"
echo "-------------"
echo "Environment:          TEST"
echo "R2 bucket:            $R2_BUCKET"
echo "Migration run ID:     $MIGRATION_RUN_ID"
echo "Target writer SHA:    $TARGET_WRITER_GIT_SHA"
echo "Inventory root SHA:   $INVENTORY_SHA256"
echo "Dropbox state SHA:    $STATE_SHA256"
echo "Dropbox root:         $DROPBOX_ROOT"
echo
echo "This is --mode plan only."
echo "There is NO --apply and NO canonical R2 mutation."
echo

set +e

/usr/bin/time -p node scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs \
  --mode plan \
  --environment TEST \
  --expected-bucket "$R2_BUCKET" \
  --migration-run-id "$MIGRATION_RUN_ID" \
  --target-writer-git-sha "$TARGET_WRITER_GIT_SHA" \
  --writer-limits-json "$WRITER_LIMITS" \
  --dropbox-root "$DROPBOX_ROOT" \
  --expected-inventory-root-sha256 "$INVENTORY_SHA256" \
  --expected-state-root-sha256 "$STATE_SHA256" \
  --report-out "$PLAN_REPORT" \
  > "$PLAN_STDOUT"

PLAN_STATUS=$?

set -e

echo
echo "Plan exit status: $PLAN_STATUS"

if [ "$PLAN_STATUS" -ne 0 ]; then
  echo
  echo "STOP: migration plan did not pass."
  echo "Report: $PLAN_REPORT"
  echo "Stdout: $PLAN_STDOUT"
  exit "$PLAN_STATUS"
fi

echo
echo "============================================================"
echo "PINNED PLAN SUMMARY"
echo "============================================================"

node --input-type=module -e '
import fs from "node:fs";

const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

console.log(JSON.stringify({
  kind: x.result?.kind,
  migration_run_id: x.result?.migration_run_id,
  plan_sha256: x.result?.plan_sha256,
  mutation_allowed: x.result?.mutation_allowed,
  blockers: x.result?.blockers,
  source_root: x.result?.source_root,
  backup_gate: x.result?.backup_gate,
  estimated: x.result?.estimated,
  rollback_preflight: x.result?.rollback_preflight ? {
    verified: x.result.rollback_preflight.verified,
    object_count: x.result.rollback_preflight.object_count
  } : null,
  audit_blockers: x.audit?.blockers
}, null, 2));
' "$PLAN_REPORT"

echo
echo "============================================================"
echo "PLAN REPORT FILE SHA256"
echo "============================================================"

shasum -a 256 "$PLAN_REPORT"

echo
echo "Step 9 plan report:"
echo "$PLAN_REPORT"
echo
echo "Step 9 completed successfully."
