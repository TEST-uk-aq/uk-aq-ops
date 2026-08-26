#!/bin/bash
set -euo pipefail

# TEST ONLY - RECOVERY / RESUME ONLY - EXISTING CHECKPOINT REQUIRED
#
# This wrapper never constructs a new migration plan. Its immutable authority is
# the preserved Step 10 checkpoint. Mutable recovery progress is written only to
# the checkpoint's separate hash-chained .recovery sidecar directory.

trap '' HUP

REPO="TEST-uk-aq/uk-aq-ops"
EXPECTED_REPO_ROOT="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops"
EXPECTED_ORIGIN_HTTPS="https://github.com/TEST-uk-aq/uk-aq-ops.git"
EXPECTED_ORIGIN_SSH="git@github.com:TEST-uk-aq/uk-aq-ops.git"
TEST_SITE_URL="https://test-uk-aq.ukaq.co.uk"
EXPECTED_TEST_SUPABASE_PROJECT_REF="zztjgmdiftqtdcrlfpvc"

TARGET_WRITER_GIT_SHA="b8858d95c42ff52558cb0fa59413162d6bc12afa"
EXPECTED_PLAN_SHA256="a095d4e2ce3babfacf270b6eebbfb47a9f7baaf9e9fb54034cea774c481f8486"
EXPECTED_AUTHORITY_SHA256="52ec1bb14fafcc05241b28202793f572ff0bf78d79a5c9af42de8f420bdc64eb"
EXPECTED_CHECKPOINT_SHA256="dabab5f5fb406af461dd6355780731b4c862b1fade14b362bfc93e5ef88c1c98"
EXPECTED_CHECKPOINT_BYTES="502003733"
EXPECTED_RECOVERY_CLI_SHA256="99ea4508767d71640e741b434296e3823278ac726133bb8982127ddfe2fb08c2"
EXPECTED_RECOVERY_LIBRARY_SHA256="cec8c4325c4c34c8d5015207d5e9fc49313ab7866d7544155722bcf8d095bc8d"

EXPECTED_SOURCE_ROOT_SHA256="46cc0b9722714e6bef223fa4700806a3c3870b603db0e075fd5e4e0e7c6210a1"
EXPECTED_SOURCE_ROOT_CONTENT_HASH="d0823fb50e848d0ceb923d5477b00a6aa5e16f8990b0bf544f573c0246722cd5"
INVENTORY_SHA256="4329f2966d807ada9991280ebbe460aae20a21cebcd613a3fb2b3cf01fd08b23"
STATE_SHA256="d9b2160331599a47d2f17df23c57088d421605f2fb3fbd8259528f41360d598e"
EXPECTED_V2_LATEST_SHA256="c9e25204a272867684f4bb10fd2eabe6fbab64312b011de4775be296d01a9840"
EXPECTED_LATEST_BACKUP_RUN_ID="32930800883"
MIGRATION_RUN_ID="test-observation-history-v3-20260825"

DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/TEST/R2_history_backup"
STEP9_REPORT="tmp/phase6_index_v3/migration_plan_report.json"
STEP10_DIR="/Users/mikehinford/uk-aq-work/index_v3_migration/step10"
WRITER_LIMITS="$STEP10_DIR/writer_limits.json"
CHECKPOINT="$STEP10_DIR/migration_checkpoint.json"
RECOVERY_ROOT="$CHECKPOINT.recovery"

WRAPPER_REPO_PATH="scripts/index_v3_migration/run_step10_resume.sh"
MIGRATION_CLI="scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs"
MIGRATION_LIBRARY="scripts/backup_r2/lib/observation_history_migration_v3.mjs"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

stop() {
  echo "STOP: $*"
  exit 1
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

if [ "$REPO_ROOT" != "$EXPECTED_REPO_ROOT" ]; then
  stop "Step 10 recovery is not running from the expected TEST Ops checkout."
fi
cd -- "$REPO_ROOT"

if [ "$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")" != "$REPO_ROOT/$WRAPPER_REPO_PATH" ]; then
  stop "execute the recovery wrapper from its canonical TEST Ops path."
fi

echo
echo "============================================================"
echo "UK AQ Phase 6 - Step 10 RECOVERY / RESUME"
echo "TEST ONLY - EXISTING CHECKPOINT REQUIRED"
echo "============================================================"
echo

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
if [ "$ORIGIN_URL" != "$EXPECTED_ORIGIN_HTTPS" ] &&
   [ "$ORIGIN_URL" != "$EXPECTED_ORIGIN_SSH" ]; then
  stop "expected TEST Ops origin is not configured."
fi
if [ "$(git branch --show-current)" != "main" ]; then
  stop "expected TEST Ops branch main."
fi
CURRENT_REPOSITORY_HEAD="$(git rev-parse HEAD)"
if ! git cat-file -e "${TARGET_WRITER_GIT_SHA}^{commit}" 2>/dev/null ||
   ! git merge-base --is-ancestor "$TARGET_WRITER_GIT_SHA" "$CURRENT_REPOSITORY_HEAD"; then
  stop "pinned target-writer commit is unavailable or not an ancestor of current HEAD."
fi

# These files own deterministic target bytes, keys, manifests, schema, hashes,
# and v3 index semantics. They must remain exactly as they were at the pinned
# target-writer authority.
TARGET_OUTPUT_PATHS=(
  package.json
  package-lock.json
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
  workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs
  workers/shared/r2_sigv4.mjs
  scripts/backup_r2/lib/hierarchical_backup_v2.mjs
  scripts/backup_r2/lib/uk_aq_parquet_dependencies.mjs
  scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs
)
if ! git diff --quiet "$TARGET_WRITER_GIT_SHA" -- "${TARGET_OUTPUT_PATHS[@]}"; then
  stop "target-output-affecting files differ from the pinned target-writer authority."
fi

# The recovery CLI imports these operational helpers outside the pinned target
# byte set. Require their working-tree bytes to match the recorded repository
# HEAD so unreviewed local drift cannot enter the recovery process.
RECOVERY_OPERATION_PATHS=(
  workers/shared/uk_aq_r2_history_writer.mjs
  scripts/operations/uk_aq_with_observations_global_operation_lock.mjs
  scripts/backup_r2/uk_aq_build_r2_history_index.mjs
)
if ! git diff --quiet HEAD -- "${RECOVERY_OPERATION_PATHS[@]}"; then
  stop "recovery operational dependencies have unreviewed working-tree changes."
fi

# The shared migration library is intentionally changed only at checkpoint
# persistence handoffs. Reinsert the six removed structuredClone calls and
# require the complete file to become byte-identical to the pinned authority.
TARGET_WRITER_GIT_SHA="$TARGET_WRITER_GIT_SHA" \
MIGRATION_LIBRARY="$MIGRATION_LIBRARY" \
node --input-type=module <<'NODE'
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const pinned = spawnSync("git", [
  "show",
  `${process.env.TARGET_WRITER_GIT_SHA}:${process.env.MIGRATION_LIBRARY}`,
], { encoding: "utf8" });
if (pinned.status !== 0) throw new Error("Pinned migration library is unavailable");
const current = fs.readFileSync(process.env.MIGRATION_LIBRARY, "utf8");
let restored = current;
let replacements = 0;
restored = restored.replace(/writeCheckpoint\(checkpoint\)/g, (match) => {
  replacements += 1;
  return match.replace("checkpoint", "structuredClone(checkpoint)");
});
if (replacements !== 6 || restored !== pinned.stdout) {
  throw new Error("Migration library has drift beyond the six recovery persistence handoffs");
}
console.log("Target generation logic is byte-identical to the pinned authority after recovery-only normalisation.");
NODE

if [ "$(sha256_file "$MIGRATION_CLI")" != "$EXPECTED_RECOVERY_CLI_SHA256" ] ||
   [ "$(sha256_file "$MIGRATION_LIBRARY")" != "$EXPECTED_RECOVERY_LIBRARY_SHA256" ]; then
  stop "recovery implementation bytes differ from the reviewed recovery identity."
fi
if ! git diff --cached --quiet -- "$MIGRATION_CLI" "$MIGRATION_LIBRARY" "$WRAPPER_REPO_PATH"; then
  stop "recovery files must remain unstaged for operator review."
fi

if [ ! -f "$CHECKPOINT" ]; then
  stop "the preserved Step 10 checkpoint is missing."
fi
if [ "$(stat -f '%z' "$CHECKPOINT")" != "$EXPECTED_CHECKPOINT_BYTES" ] ||
   [ "$(sha256_file "$CHECKPOINT")" != "$EXPECTED_CHECKPOINT_SHA256" ]; then
  stop "the preserved Step 10 checkpoint identity changed."
fi
if [ ! -f "$WRITER_LIMITS" ]; then
  stop "the preserved writer-limits file is missing."
fi

CHECKPOINT="$CHECKPOINT" \
WRITER_LIMITS="$WRITER_LIMITS" \
EXPECTED_AUTHORITY_SHA256="$EXPECTED_AUTHORITY_SHA256" \
EXPECTED_PLAN_SHA256="$EXPECTED_PLAN_SHA256" \
MIGRATION_RUN_ID="$MIGRATION_RUN_ID" \
TARGET_WRITER_GIT_SHA="$TARGET_WRITER_GIT_SHA" \
EXPECTED_SOURCE_ROOT_SHA256="$EXPECTED_SOURCE_ROOT_SHA256" \
EXPECTED_SOURCE_ROOT_CONTENT_HASH="$EXPECTED_SOURCE_ROOT_CONTENT_HASH" \
INVENTORY_SHA256="$INVENTORY_SHA256" \
STATE_SHA256="$STATE_SHA256" \
node --max-old-space-size=4096 --input-type=module <<'NODE'
import fs from "node:fs";
import { buildObservationHistoryV3MigrationPlanFromCheckpoint } from "./scripts/backup_r2/lib/observation_history_migration_v3.mjs";
const checkpoint = JSON.parse(fs.readFileSync(process.env.CHECKPOINT, "utf8"));
const plan = buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint });
const limits = JSON.parse(fs.readFileSync(process.env.WRITER_LIMITS, "utf8"));
const expectedLimits = {
  target_row_group_rows: 8192,
  max_row_group_rows: 16384,
  target_file_rows: 65536,
  max_file_rows: 131072,
  target_file_bytes: 4194304,
  max_file_bytes: 8388608,
  max_row_groups_per_file: 8,
};
function require(value, message) { if (!value) throw new Error(message); }
require(checkpoint.authority_sha256 === process.env.EXPECTED_AUTHORITY_SHA256,
  "checkpoint authority SHA mismatch");
require(plan.plan_sha256 === process.env.EXPECTED_PLAN_SHA256,
  "checkpoint plan SHA mismatch");
require(plan.migration_run_id === process.env.MIGRATION_RUN_ID,
  "checkpoint migration run ID mismatch");
require(plan.target_writer_git_sha === process.env.TARGET_WRITER_GIT_SHA,
  "checkpoint target-writer SHA mismatch");
require(plan.inventory.root_manifest.sha256 === process.env.EXPECTED_SOURCE_ROOT_SHA256,
  "checkpoint pre-migration root SHA mismatch");
require(plan.inventory.root_manifest.payload.content_hash ===
  process.env.EXPECTED_SOURCE_ROOT_CONTENT_HASH,
  "checkpoint pre-migration content hash mismatch");
require(plan.backup_gate.inventory_root.sha256 === process.env.INVENTORY_SHA256 &&
  plan.backup_gate.state_root.sha256 === process.env.STATE_SHA256,
  "checkpoint rollback backup identity mismatch");
require(JSON.stringify(plan.target.writer_limits) === JSON.stringify(limits) &&
  JSON.stringify(limits) === JSON.stringify(expectedLimits),
  "writer limits differ from checkpointed authority");
require(checkpoint.full_verification_complete === false && checkpoint.cutover_ready === false,
  "checkpoint is not the expected interrupted pre-verification state");
console.log(`Checkpoint authority valid: ${plan.units.length} pinned units; no source plan rebuilt.`);
NODE

if [ ! -f "$STEP9_REPORT" ]; then
  stop "refreshed Step 9 report is missing."
fi

if [ "${UKAQ_ENV_NAME:-}" != "TEST" ]; then
  stop "expected UKAQ_ENV_NAME=TEST."
fi
if [ "${UK_AQ_R2_HISTORY_INTEGRITY_VERSION:-}" != "v2" ]; then
  stop "expected UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2."
fi
: "${CFLARE_R2_ACCESS_KEY_ID:?STOP: CFLARE_R2_ACCESS_KEY_ID is not set}"
: "${CFLARE_R2_SECRET_ACCESS_KEY:?STOP: CFLARE_R2_SECRET_ACCESS_KEY is not set}"
LOCK_DATABASE_URL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
if [ -z "$LOCK_DATABASE_URL" ]; then
  stop "the retained PostgreSQL session lock requires SUPABASE_DB_URL or DATABASE_URL."
fi
LOCK_DATABASE_URL="$LOCK_DATABASE_URL" \
EXPECTED_TEST_SUPABASE_PROJECT_REF="$EXPECTED_TEST_SUPABASE_PROJECT_REF" \
node --input-type=module <<'NODE'
const url = new URL(process.env.LOCK_DATABASE_URL);
const ref = process.env.EXPECTED_TEST_SUPABASE_PROJECT_REF;
const direct = url.hostname === `db.${ref}.supabase.co`;
const sessionPooler = /(^|\.)pooler\.supabase\.com$/i.test(url.hostname) &&
  new Set(["", "5432"]).has(url.port) && url.username === `postgres.${ref}`;
if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || (!direct && !sessionPooler)) {
  throw new Error("PostgreSQL lock URL is not the pinned TEST session route");
}
console.log("Pinned TEST PostgreSQL session-lock route is present.");
NODE

echo
echo "Reading TEST configuration (read-only)..."
HISTORY_VERSION="$(gh variable get UK_AQ_R2_HISTORY_VERSION --repo "$REPO")"
INDEX_VERSION="$(gh variable get UK_AQ_R2_HISTORY_INDEX_VERSION --repo "$REPO")"
R2_BUCKET="$(gh variable get CFLARE_R2_BUCKET --repo "$REPO")"
R2_ENDPOINT="$(gh variable get CFLARE_R2_ENDPOINT --repo "$REPO")"
if [ "$HISTORY_VERSION" != "v2" ] || [ "$INDEX_VERSION" != "v2" ] ||
   [ "$R2_BUCKET" != "uk-aq-history-cic-test" ] || [ -z "$R2_ENDPOINT" ]; then
  stop "TEST history/index/bucket configuration is not the pinned pre-cutover state."
fi

LATEST_BACKUP_TSV="$(
  gh run list --repo "$REPO" --workflow uk_aq_r2_history_dropbox_backup.yml \
    --limit 1 --json databaseId,status,conclusion \
    --jq 'if length == 1 then .[0] | [.databaseId,.status,.conclusion] | @tsv else "" end'
)"
IFS=$'\t' read -r LATEST_BACKUP_ID LATEST_BACKUP_STATUS LATEST_BACKUP_CONCLUSION <<< "$LATEST_BACKUP_TSV"
if [ "$LATEST_BACKUP_ID" != "$EXPECTED_LATEST_BACKUP_RUN_ID" ] ||
   [ "$LATEST_BACKUP_STATUS" != "completed" ] ||
   [ "$LATEST_BACKUP_CONCLUSION" != "success" ]; then
  stop "pinned Dropbox backup run is no longer the latest completed success."
fi
if [ "$(sha256_file "$DROPBOX_ROOT/_ops/checkpoints/r2_history_backup_state_v2/root.json")" != "$STATE_SHA256" ]; then
  stop "pinned Dropbox checkpoint root identity changed."
fi

WRITER_PROCESSES="$(
  ps ax -o pid=,command= |
    egrep 'uk-aq-history-integrity|uk_aq_integrity_backfill|uk_aq_backfill|uk_aq_apply_integrity_proposal|uk_aq_execute_v2_observations_repair|uk_aq_build_v2_observations_from_dropbox_v1|uk_aq_observation_history_migration_v3' |
    grep -v egrep || true
)"
if [ -n "$WRITER_PROCESSES" ]; then
  echo "$WRITER_PROCESSES"
  stop "a canonical-history writer or migration process is already running."
fi

echo
echo "Checking TEST Prune Daily scheduler disablement (read-only)..."
PRUNE_SCHEDULER_JSON="$(
  cd -- "$REPO_ROOT/cloudflare/scheduler"
  npx --yes wrangler@4 d1 execute uk_aq_cron_scheduler_ops_db \
    --remote --config wrangler.toml --json \
    --command "SELECT job_key,enabled,cron_expr,github_workflow_file FROM scheduler_jobs WHERE job_key='uk_aq_prune_daily'"
)"
PRUNE_SCHEDULER_JSON="$PRUNE_SCHEDULER_JSON" node --input-type=module <<'NODE'
const payload = JSON.parse(process.env.PRUNE_SCHEDULER_JSON);
const rows = payload?.[0]?.results;
if (payload?.length !== 1 || payload[0]?.success !== true || rows?.length !== 1 ||
  rows[0]?.job_key !== "uk_aq_prune_daily" || rows[0]?.enabled !== 0) {
  throw new Error("TEST Prune Daily scheduler row is not exactly enabled=0");
}
console.log("TEST Prune Daily scheduler row is exactly enabled=0.");
NODE

ACTIVE_PRUNE_JSON="$(
  gh run list --repo "$REPO" --workflow uk_aq_prune_daily.yml --limit 50 \
    --json databaseId,status,conclusion,event,createdAt,url \
    --jq '[.[] | select(.status != "completed")]'
)"
if [ "$ACTIVE_PRUNE_JSON" != "[]" ]; then
  echo "$ACTIVE_PRUNE_JSON"
  stop "a Prune Daily workflow is active."
fi

echo
echo "Positively verifying TEST full-site maintenance (read-only)..."
TEST_SITE_URL="$TEST_SITE_URL" node --input-type=module <<'NODE'
const marker = '<meta name="uk-aq-site-maintenance" content="on">';
async function get(relativePath) {
  const url = new URL(relativePath, process.env.TEST_SITE_URL);
  url.searchParams.set("uk_aq_step10_resume_check", `${Date.now()}-${Math.random()}`);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: { "cache-control": "no-cache, no-store", pragma: "no-cache" },
  });
  return { response, body: await response.text() };
}
const statusResult = await get("/uk-aq-site-mode.json");
const status = JSON.parse(statusResult.body);
if (!statusResult.response.ok || status?.schema_version !== 1 || status?.mode !== "on") {
  throw new Error("TEST maintenance state is not positively ON");
}
for (const route of ["/", "/hex_map/", "/sensor_map/"]) {
  const result = await get(route);
  if (!result.body.includes(marker)) throw new Error(`maintenance marker absent from ${route}`);
}
console.log(`TEST maintenance ON: deployment ${status.deployment_id}.`);
NODE

# Local-only, pre-authorisation recovery metadata initialisation. This creates
# or validates a separate manifest/head and never rewrites the original
# checkpoint or its retained staging file.
echo
echo "Initialising or validating hash-chained recovery progress..."
RECOVERY_SUMMARY="$(
  CHECKPOINT="$CHECKPOINT" REPO_ROOT="$REPO_ROOT" \
  node --max-old-space-size=4096 --input-type=module <<'NODE'
import { initializeObservationHistoryV3RecoveryProgress } from "./scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs";
const result = initializeObservationHistoryV3RecoveryProgress({
  checkpointPath: process.env.CHECKPOINT,
  repositoryRoot: process.env.REPO_ROOT,
});
process.stdout.write(JSON.stringify(result));
NODE
)"
RECOVERY_SUMMARY="$RECOVERY_SUMMARY" node --input-type=module <<'NODE'
const value = JSON.parse(process.env.RECOVERY_SUMMARY);
console.log(JSON.stringify({
  original_checkpoint: value.original_checkpoint,
  immutable_authority_sha256: value.immutable_authority_sha256,
  recovery_repository_head: value.recovery_implementation.repository_head,
  recovery_files: value.recovery_implementation.files,
  journal_entries: value.journal_entries,
  prepared_units: value.prepared_units,
  completed_objects: value.completed_objects,
  retained_staging_files: value.retained_staging_files,
}, null, 2));
NODE

echo
echo "No current canonical-tree equality gate was used."
echo "Resume authority comes from the immutable checkpoint and recovery journal."
echo "Completed Parquet will be HEAD-verified against stored SHA-256 and byte size before reuse."
echo "Manual canonical-history writer exclusion remains an operator requirement."
echo
echo "============================================================"
echo "RECOVERY PINS"
echo "============================================================"
echo "Environment:              TEST"
echo "Current repository HEAD:  $CURRENT_REPOSITORY_HEAD"
echo "Recovery CLI SHA256:       $EXPECTED_RECOVERY_CLI_SHA256"
echo "Recovery library SHA256:   $EXPECTED_RECOVERY_LIBRARY_SHA256"
echo "Migration run ID:          $MIGRATION_RUN_ID"
echo "Target writer SHA:         $TARGET_WRITER_GIT_SHA"
echo "Step 9 plan SHA:           $EXPECTED_PLAN_SHA256"
echo "Original checkpoint SHA:   $EXPECTED_CHECKPOINT_SHA256"
echo "Recovery progress root:    $RECOVERY_ROOT"
echo

# Explicit authorisation is immediately before the first apply-capable command.
if [ "${UK_AQ_STEP10_RESUME_AUTH:-}" != "AUTHORISE_TEST_STEP10_RESUME" ]; then
  echo "EXTERNAL READ-ONLY RECOVERY PREFLIGHT PASSED; no external mutation was attempted."
  echo "RESUME AUTHORISATION ABSENT: UK_AQ_STEP10_RESUME_AUTH is missing or invalid."
  echo "Review the recovery manifest and repository diff before authorising."
  exit 2
fi

echo "Explicit TEST Step 10 recovery authorisation accepted."
echo "Starting SIGHUP-resistant checkpoint resume."

# FIRST APPLY-CAPABLE / EXTERNALLY MUTATING COMMAND
ATTEMPT_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ATTEMPT_DIR="$RECOVERY_ROOT/attempts/$ATTEMPT_ID"
mkdir -p "$ATTEMPT_DIR"
MIGRATION_REPORT="$ATTEMPT_DIR/migration_report.json"
MIGRATION_STDOUT="$ATTEMPT_DIR/migration_stdout.json"

export UK_AQ_ENV_NAME="$UKAQ_ENV_NAME"
export UK_AQ_R2_HISTORY_VERSION="$HISTORY_VERSION"
export UK_AQ_R2_HISTORY_INDEX_VERSION="$INDEX_VERSION"
export CFLARE_R2_BUCKET="$R2_BUCKET"
export CFLARE_R2_ENDPOINT="$R2_ENDPOINT"
export CFLARE_R2_REGION="auto"

START_EPOCH="$(date +%s)"
set +e
node --max-old-space-size=4096 \
  --import 'data:text/javascript,process.on%28%22SIGHUP%22%2C%28%29%3D%3E%7B%7D%29' \
  scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs \
  --mode migrate \
  --apply \
  --writers-frozen \
  --environment TEST \
  --expected-bucket "$R2_BUCKET" \
  --migration-run-id "$MIGRATION_RUN_ID" \
  --target-writer-git-sha "$TARGET_WRITER_GIT_SHA" \
  --writer-limits-json "$WRITER_LIMITS" \
  --dropbox-root "$DROPBOX_ROOT" \
  --expected-inventory-root-sha256 "$INVENTORY_SHA256" \
  --expected-state-root-sha256 "$STATE_SHA256" \
  --checkpoint-in "$CHECKPOINT" \
  --checkpoint-out "$CHECKPOINT" \
  --report-out "$MIGRATION_REPORT" \
  > "$MIGRATION_STDOUT"
MIGRATION_STATUS=$?
set -e
END_EPOCH="$(date +%s)"

echo
echo "Recovery migration exit status: $MIGRATION_STATUS"
echo "Recovery migration elapsed seconds: $((END_EPOCH - START_EPOCH))"
echo "Attempt evidence: $ATTEMPT_DIR"
echo "Original checkpoint remains: $CHECKPOINT"
echo "Recovery progress remains: $RECOVERY_ROOT"

if [ "$MIGRATION_STATUS" -ne 0 ]; then
  echo "STOP: recovery did not complete. Preserve all original and sidecar evidence."
  exit "$MIGRATION_STATUS"
fi

echo "Step 10 recovery command completed."
echo "DO NOT unfreeze writers, change index authority, or end maintenance yet."
