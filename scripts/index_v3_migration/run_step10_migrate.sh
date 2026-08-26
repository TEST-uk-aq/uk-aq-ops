#!/bin/bash
set -euo pipefail

REPO="TEST-uk-aq/uk-aq-ops"
EXPECTED_REPO_ROOT="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops"
EXPECTED_ORIGIN_HTTPS="https://github.com/TEST-uk-aq/uk-aq-ops.git"
EXPECTED_ORIGIN_SSH="git@github.com:TEST-uk-aq/uk-aq-ops.git"
TEST_SITE_URL="https://test-uk-aq.ukaq.co.uk"
EXPECTED_TEST_SUPABASE_PROJECT_REF="zztjgmdiftqtdcrlfpvc"

EXPECTED_HEAD="b8858d95c42ff52558cb0fa59413162d6bc12afa"
EXPECTED_PLAN_SHA256="a095d4e2ce3babfacf270b6eebbfb47a9f7baaf9e9fb54034cea774c481f8486"

EXPECTED_SOURCE_ROOT_SHA256="46cc0b9722714e6bef223fa4700806a3c3870b603db0e075fd5e4e0e7c6210a1"
EXPECTED_SOURCE_ROOT_CONTENT_HASH="d0823fb50e848d0ceb923d5477b00a6aa5e16f8990b0bf544f573c0246722cd5"

INVENTORY_SHA256="4329f2966d807ada9991280ebbe460aae20a21cebcd613a3fb2b3cf01fd08b23"
STATE_SHA256="d9b2160331599a47d2f17df23c57088d421605f2fb3fbd8259528f41360d598e"

EXPECTED_V2_LATEST_SHA256="c9e25204a272867684f4bb10fd2eabe6fbab64312b011de4775be296d01a9840"
EXPECTED_LATEST_BACKUP_RUN_ID="32930800883"

DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/TEST/R2_history_backup"
MIGRATION_RUN_ID="test-observation-history-v3-20260825"

STEP9_REPORT="tmp/phase6_index_v3/migration_plan_report.json"

STEP10_DIR="/Users/mikehinford/uk-aq-work/index_v3_migration/step10"
WRITER_LIMITS="$STEP10_DIR/writer_limits.json"
CHECKPOINT="$STEP10_DIR/migration_checkpoint.json"
MIGRATION_REPORT="$STEP10_DIR/migration_report.json"
MIGRATION_STDOUT="$STEP10_DIR/migration_stdout.json"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

if [ "$REPO_ROOT" != "$EXPECTED_REPO_ROOT" ]; then
  echo "STOP: Step 10 is not running from the expected TEST Ops checkout."
  echo "Expected: $EXPECTED_REPO_ROOT"
  echo "Actual:   $REPO_ROOT"
  exit 1
fi

GIT_TOPLEVEL="$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$GIT_TOPLEVEL" ] ||
   [ "$(cd -- "$GIT_TOPLEVEL" 2>/dev/null && pwd -P)" != "$EXPECTED_REPO_ROOT" ]; then
  echo "STOP: expected TEST Ops path is not the Git worktree root."
  exit 1
fi

cd -- "$REPO_ROOT"

echo
echo "============================================================"
echo "UK AQ Phase 6 - Step 10"
echo "MUTATING observation-history v3 migration"
echo "TEST ONLY"
echo "============================================================"
echo

# ------------------------------------------------------------
# Local environment / code identity
# ------------------------------------------------------------

if [ "${UKAQ_ENV_NAME:-}" != "TEST" ]; then
  echo "STOP: expected UKAQ_ENV_NAME=TEST."
  echo "Actual: ${UKAQ_ENV_NAME:-<unset>}"
  exit 1
fi

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
if [ "$ORIGIN_URL" != "$EXPECTED_ORIGIN_HTTPS" ] &&
   [ "$ORIGIN_URL" != "$EXPECTED_ORIGIN_SSH" ]; then
  echo "STOP: expected TEST Ops origin is not configured."
  exit 1
fi

ACTUAL_HEAD="$(git rev-parse HEAD)"

echo "Expected HEAD: $EXPECTED_HEAD"
echo "Actual HEAD:   $ACTUAL_HEAD"

if [ "$ACTUAL_HEAD" != "$EXPECTED_HEAD" ]; then
  echo "STOP: TEST Ops HEAD has changed."
  exit 1
fi

BRANCH="$(git branch --show-current)"
echo "Branch:        $BRANCH"

if [ "$BRANCH" != "main" ]; then
  echo "STOP: expected TEST Ops branch main."
  exit 1
fi

CRITICAL_PATHS=(
  package.json
  package-lock.json
  scripts/backup_r2
  scripts/operations
  workers/shared
  cloudflare/scheduler/wrangler.toml
)

if ! git diff --quiet -- "${CRITICAL_PATHS[@]}" ||
   ! git diff --cached --quiet -- "${CRITICAL_PATHS[@]}"; then
  echo "STOP: migration, lock, writer, dependency, or scheduler code differs from pinned HEAD."
  git status --short -- "${CRITICAL_PATHS[@]}"
  exit 1
fi

UNTRACKED_CRITICAL="$(git ls-files --others --exclude-standard -- "${CRITICAL_PATHS[@]}")"
if [ -n "$UNTRACKED_CRITICAL" ]; then
  echo "STOP: untracked files exist in migration-critical code paths."
  echo "$UNTRACKED_CRITICAL"
  exit 1
fi

echo "Migration-critical code identity is clean and pinned."

# ------------------------------------------------------------
# GitHub configuration
# ------------------------------------------------------------

echo
echo "Reading TEST GitHub configuration..."

HISTORY_VERSION="$(gh variable get UK_AQ_R2_HISTORY_VERSION --repo "$REPO")"
INDEX_VERSION="$(gh variable get UK_AQ_R2_HISTORY_INDEX_VERSION --repo "$REPO")"
R2_BUCKET="$(gh variable get CFLARE_R2_BUCKET --repo "$REPO")"
R2_ENDPOINT="$(gh variable get CFLARE_R2_ENDPOINT --repo "$REPO")"

echo "History version: $HISTORY_VERSION"
echo "Index version:   $INDEX_VERSION"
echo "R2 bucket:       $R2_BUCKET"

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

: "${UK_AQ_R2_HISTORY_INTEGRITY_VERSION:?STOP: UK_AQ_R2_HISTORY_INTEGRITY_VERSION is not set}"
: "${CFLARE_R2_ACCESS_KEY_ID:?STOP: CFLARE_R2_ACCESS_KEY_ID is not set}"
: "${CFLARE_R2_SECRET_ACCESS_KEY:?STOP: CFLARE_R2_SECRET_ACCESS_KEY is not set}"

LOCK_DATABASE_URL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
if [ -z "$LOCK_DATABASE_URL" ]; then
  echo "STOP: the retained PostgreSQL session lock requires SUPABASE_DB_URL or DATABASE_URL."
  exit 1
fi

LOCK_DATABASE_URL="$LOCK_DATABASE_URL" \
EXPECTED_TEST_SUPABASE_PROJECT_REF="$EXPECTED_TEST_SUPABASE_PROJECT_REF" \
node --input-type=module <<'NODE'
const value = process.env.LOCK_DATABASE_URL;
const projectRef = process.env.EXPECTED_TEST_SUPABASE_PROJECT_REF;
let url;
try {
  url = new URL(value);
} catch {
  throw new Error("PostgreSQL lock URL is invalid");
}
if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
  throw new Error("PostgreSQL lock URL must use postgres:// or postgresql://");
}
const directTestHost = url.hostname === `db.${projectRef}.supabase.co`;
const sessionModeTestPooler =
  /(^|\.)pooler\.supabase\.com$/i.test(url.hostname) &&
  new Set(["", "5432"]).has(url.port) &&
  url.username === `postgres.${projectRef}`;
if (!directTestHost && !sessionModeTestPooler) {
  throw new Error("PostgreSQL lock URL is not the pinned TEST Supabase project/session route");
}
console.log("Pinned TEST PostgreSQL session-lock prerequisite is present.");
NODE

if [ "$UK_AQ_R2_HISTORY_INTEGRITY_VERSION" != "v2" ]; then
  echo "STOP: expected UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2."
  exit 1
fi

# Translate the normal TEST shell environment name into the
# variable expected by the migration CLI.
export UK_AQ_ENV_NAME="$UKAQ_ENV_NAME"
export UK_AQ_R2_HISTORY_VERSION="$HISTORY_VERSION"
export UK_AQ_R2_HISTORY_INDEX_VERSION="$INDEX_VERSION"
export CFLARE_R2_BUCKET="$R2_BUCKET"
export CFLARE_R2_ENDPOINT="$R2_ENDPOINT"
export CFLARE_R2_REGION="auto"

TARGET_WRITER_GIT_SHA="$ACTUAL_HEAD"

# ------------------------------------------------------------
# Confirm maintenance and no automatic/manual canonical writer is active
# ------------------------------------------------------------

final_operational_boundary_checks() {
  echo
  echo "Checking TEST Prune Daily scheduler disablement..."

PRUNE_SCHEDULER_JSON="$(
  cd -- "$REPO_ROOT/cloudflare/scheduler"
  npx --yes wrangler@4 d1 execute uk_aq_cron_scheduler_ops_db \
    --remote \
    --config wrangler.toml \
    --json \
    --command "SELECT job_key,enabled,cron_expr,github_workflow_file FROM scheduler_jobs WHERE job_key='uk_aq_prune_daily'"
)"

PRUNE_SCHEDULER_JSON="$PRUNE_SCHEDULER_JSON" node --input-type=module <<'NODE'
const payload = JSON.parse(process.env.PRUNE_SCHEDULER_JSON);
if (!Array.isArray(payload) || payload.length !== 1) {
  throw new Error("Expected exactly one D1 result envelope");
}
const result = payload[0];
if (result?.success !== true || !Array.isArray(result.results)) {
  throw new Error("TEST D1 scheduler readback did not succeed");
}
if (result.results.length !== 1) {
  throw new Error("Expected exactly one uk_aq_prune_daily scheduler row");
}
const row = result.results[0];
if (row?.job_key !== "uk_aq_prune_daily" || row?.enabled !== 0) {
  throw new Error("TEST Prune Daily scheduler row is not exactly enabled=0");
}
console.log("TEST Prune Daily scheduler row is exactly enabled=0.");
NODE

echo
echo "Positively verifying TEST full-site maintenance..."

TEST_SITE_URL="$TEST_SITE_URL" node --input-type=module <<'NODE'
const baseUrl = process.env.TEST_SITE_URL;
const marker = '<meta name="uk-aq-site-maintenance" content="on">';
const paths = [
  "/",
  "/hex_map/",
  "/about/",
  "/dev-blog/",
  "/resources/",
  "/sensor_map/",
  "/sensors/",
];

async function get(relativePath) {
  const url = new URL(relativePath, baseUrl);
  url.searchParams.set(
    "uk_aq_step10_maintenance_check",
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "cache-control": "no-cache, no-store",
      pragma: "no-cache",
    },
  });
  return { response, body: await response.text() };
}

const statusResult = await get("/uk-aq-site-mode.json");
if (!statusResult.response.ok) {
  throw new Error(`TEST site-mode status returned HTTP ${statusResult.response.status}`);
}
const status = JSON.parse(statusResult.body);
if (
  status?.schema_version !== 1 ||
  status?.mode !== "on" ||
  typeof status?.deployment_id !== "string" ||
  !status.deployment_id.trim() ||
  typeof status?.artifact_built_at_utc !== "string" ||
  Number.isNaN(Date.parse(status.artifact_built_at_utc))
) {
  throw new Error("TEST maintenance deployment identity is absent, malformed, or not ON");
}

for (const relativePath of paths) {
  const result = await get(relativePath);
  if (!result.body.includes(marker)) {
    throw new Error(
      `TEST maintenance marker is absent from ${relativePath} (HTTP ${result.response.status})`,
    );
  }
}

console.log(
  `TEST maintenance ON: deployment ${status.deployment_id}, built ${status.artifact_built_at_utc}.`,
);
NODE

echo
echo "Checking for active Prune Daily workflow..."

ACTIVE_PRUNE_JSON="$(
  gh run list \
    --repo "$REPO" \
    --workflow uk_aq_prune_daily.yml \
    --limit 50 \
    --json databaseId,status,conclusion,event,createdAt,url \
    --jq '[.[] | select(.status != "completed")]'
)"

if [ "$ACTIVE_PRUNE_JSON" != "[]" ]; then
  echo "STOP: a Prune Daily workflow is active."
  echo "$ACTIVE_PRUNE_JSON"
  exit 1
fi

  echo "No active Prune Daily workflow."
}

echo
echo "Checking latest history Dropbox backup generation..."

LATEST_BACKUP_TSV="$(
  gh run list \
    --repo "$REPO" \
    --workflow uk_aq_r2_history_dropbox_backup.yml \
    --limit 1 \
    --json databaseId,status,conclusion,event,createdAt,url \
    --jq 'if length == 1 then .[0] | [.databaseId, .status, .conclusion] | @tsv else "" end'
)"

if [ -z "$LATEST_BACKUP_TSV" ]; then
  echo "STOP: no latest Dropbox backup workflow run was returned."
  exit 1
fi

IFS=$'\t' read -r LATEST_BACKUP_ID LATEST_BACKUP_STATUS LATEST_BACKUP_CONCLUSION <<< "$LATEST_BACKUP_TSV"

echo "Latest backup run:        $LATEST_BACKUP_ID"
echo "Latest backup status:     $LATEST_BACKUP_STATUS"
echo "Latest backup conclusion: $LATEST_BACKUP_CONCLUSION"

if [ "$LATEST_BACKUP_ID" != "$EXPECTED_LATEST_BACKUP_RUN_ID" ]; then
  echo "STOP: the pinned Dropbox backup generation has advanced."
  exit 1
fi

if [ "$LATEST_BACKUP_STATUS" != "completed" ] ||
   [ "$LATEST_BACKUP_CONCLUSION" != "success" ]; then
  echo "STOP: latest Dropbox backup is not a completed success."
  exit 1
fi

echo
echo "Checking for local canonical-history writers..."

WRITER_PROCESSES="$(
  ps ax -o pid=,command= | \
    egrep 'uk-aq-history-integrity|uk_aq_integrity_backfill|uk_aq_backfill|uk_aq_apply_integrity_proposal|uk_aq_execute_v2_observations_repair|uk_aq_build_v2_observations_from_dropbox_v1|uk_aq_observation_history_migration_v3' | \
    grep -v egrep || true
)"

if [ -n "$WRITER_PROCESSES" ]; then
  echo "STOP: a canonical-history writer/migration process is already running."
  echo "$WRITER_PROCESSES"
  exit 1
fi

echo "No local canonical-history writer detected."

# ------------------------------------------------------------
# Revalidate refreshed Step 9 authority
# ------------------------------------------------------------

echo
echo "Checking refreshed Step 9 report..."

if [ ! -f "$STEP9_REPORT" ]; then
  echo "STOP: refreshed Step 9 report is missing."
  exit 1
fi

EXPECTED_PLAN_SHA256="$EXPECTED_PLAN_SHA256" \
EXPECTED_SOURCE_ROOT_SHA256="$EXPECTED_SOURCE_ROOT_SHA256" \
EXPECTED_SOURCE_ROOT_CONTENT_HASH="$EXPECTED_SOURCE_ROOT_CONTENT_HASH" \
INVENTORY_SHA256="$INVENTORY_SHA256" \
STATE_SHA256="$STATE_SHA256" \
MIGRATION_RUN_ID="$MIGRATION_RUN_ID" \
STEP9_REPORT="$STEP9_REPORT" \
node --input-type=module <<'NODE'
import fs from "node:fs";

const reportPath = process.env.STEP9_REPORT;
const x = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const r = x.result;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

require(r?.kind === "uk_aq_observation_history_v3_migration_plan_summary",
  "Step 9 report kind mismatch");

require(r?.migration_run_id === process.env.MIGRATION_RUN_ID,
  "Step 9 migration run ID mismatch");

require(r?.environment?.ok === true &&
  r.environment.environment === "TEST" &&
  r.environment.configured_environment === "TEST" &&
  r.environment.bucket === "uk-aq-history-cic-test" &&
  r.environment.history_version === "v2" &&
  r.environment.index_version === "v2" &&
  r.environment.integrity_version === "v2",
  "Step 9 TEST environment authority mismatch");

require(r?.plan_sha256 === process.env.EXPECTED_PLAN_SHA256,
  "Step 9 plan SHA-256 mismatch");

require(r?.mutation_allowed === true,
  "Step 9 mutation_allowed is not true");

require(Array.isArray(r?.blockers) && r.blockers.length === 0,
  "Step 9 result has blockers");

require(Array.isArray(x.audit?.blockers) && x.audit.blockers.length === 0,
  "Step 9 audit has blockers");

require(r?.backup_gate?.verified === true,
  "Step 9 backup gate is not verified");

require(r?.backup_gate?.inventory_root?.sha256 === process.env.INVENTORY_SHA256,
  "Step 9 inventory root SHA mismatch");

require(r?.backup_gate?.state_root?.sha256 === process.env.STATE_SHA256,
  "Step 9 Dropbox state SHA mismatch");

require(r?.source_root?.sha256 === process.env.EXPECTED_SOURCE_ROOT_SHA256,
  "Step 9 canonical source physical SHA mismatch");

require(r?.source_root?.content_hash === process.env.EXPECTED_SOURCE_ROOT_CONTENT_HASH,
  "Step 9 canonical source content hash mismatch");

require(r?.rollback_preflight?.verified === true,
  "Step 9 rollback preflight is not verified");

require(r?.target?.history_version === "v2" &&
  r.target.history_schema_version === 3 &&
  r.target.index_generation === "v3" &&
  r.target.writer_version === "parquet-wasm-zstd-v3" &&
  r.target.physical_layout_version === "timeseries-bounded-v1",
  "Step 9 target writer authority mismatch");

const expectedWriterLimits = {
  target_row_group_rows: 8192,
  max_row_group_rows: 16384,
  target_file_rows: 65536,
  max_file_rows: 131072,
  target_file_bytes: 4194304,
  max_file_bytes: 8388608,
  max_row_groups_per_file: 8,
};
require(
  Object.keys(expectedWriterLimits).every(
    (key) => r?.target?.writer_limits?.[key] === expectedWriterLimits[key],
  ) &&
  Object.keys(r?.target?.writer_limits || {}).length ===
    Object.keys(expectedWriterLimits).length,
  "Step 9 writer limits mismatch",
);

console.log("Refreshed Step 9 authority matches all pinned values.");
NODE

# ------------------------------------------------------------
# Revalidate current R2 authority immediately before migrate
# ------------------------------------------------------------

echo
echo "Checking current R2 source identities..."

EXPECTED_SOURCE_ROOT_SHA256="$EXPECTED_SOURCE_ROOT_SHA256" \
EXPECTED_SOURCE_ROOT_CONTENT_HASH="$EXPECTED_SOURCE_ROOT_CONTENT_HASH" \
INVENTORY_SHA256="$INVENTORY_SHA256" \
EXPECTED_V2_LATEST_SHA256="$EXPECTED_V2_LATEST_SHA256" \
node --input-type=module <<'NODE'
import { Buffer } from "node:buffer";

import {
  resolveR2HistoryIndexConfig,
} from "./workers/shared/uk_aq_r2_history_index.mjs";

import {
  r2GetObject,
  sha256Hex,
} from "./workers/shared/r2_sigv4.mjs";

const config = resolveR2HistoryIndexConfig(process.env);

async function get(key) {
  const object = await r2GetObject({ r2: config.r2, key });
  const body = Buffer.from(object.body);
  return {
    body,
    sha256: sha256Hex(body),
    json: JSON.parse(body.toString("utf8")),
  };
}

const root = await get(
  "history/v2/observations/_manifests/manifest.json",
);

if (root.sha256 !== process.env.EXPECTED_SOURCE_ROOT_SHA256) {
  throw new Error("Canonical observation root physical SHA changed");
}

if (
  root.json.content_hash !==
  process.env.EXPECTED_SOURCE_ROOT_CONTENT_HASH
) {
  throw new Error("Canonical observation root content hash changed");
}

const inventory = await get(
  "history/_index_v2/backup_inventory_v2/root.json",
);

if (inventory.sha256 !== process.env.INVENTORY_SHA256) {
  throw new Error("Backup inventory root SHA changed");
}

const latest = await get(
  "history/_index_v2/observations_timeseries_latest.json",
);

if (latest.sha256 !== process.env.EXPECTED_V2_LATEST_SHA256) {
  throw new Error("Current v2 latest index SHA changed");
}

console.log("Current R2 authority matches refreshed Step 9.");
NODE

echo
echo "Checking current Dropbox state identity..."

ACTUAL_STATE_SHA256="$(
  shasum -a 256 \
    "$DROPBOX_ROOT/_ops/checkpoints/r2_history_backup_state_v2/root.json" |
    awk '{print $1}'
)"

echo "Expected: $STATE_SHA256"
echo "Actual:   $ACTUAL_STATE_SHA256"

if [ "$ACTUAL_STATE_SHA256" != "$STATE_SHA256" ]; then
  echo "STOP: Dropbox checkpoint root identity changed."
  exit 1
fi

# ------------------------------------------------------------
# Prepare NEW Step 10 local checkpoint/staging paths
# ------------------------------------------------------------

mkdir -p "$STEP10_DIR"

for path in \
  "$CHECKPOINT" \
  "$CHECKPOINT.publication.json" \
  "$CHECKPOINT.staging" \
  "$MIGRATION_REPORT" \
  "$MIGRATION_STDOUT"
do
  if [ -e "$path" ]; then
    echo "STOP: fresh Step 10 output already exists:"
    echo "$path"
    echo "A resume/recovery must be considered explicitly instead."
    exit 1
  fi
done

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
echo "Running final operational boundary checks immediately before authorisation..."
final_operational_boundary_checks

echo
echo "============================================================"
echo "FINAL STEP 10 PINS"
echo "============================================================"
echo "Environment:              TEST"
echo "Migration run ID:         $MIGRATION_RUN_ID"
echo "Target writer SHA:        $TARGET_WRITER_GIT_SHA"
echo "Step 9 plan SHA:          $EXPECTED_PLAN_SHA256"
echo "Canonical source SHA:     $EXPECTED_SOURCE_ROOT_SHA256"
echo "Canonical content hash:   $EXPECTED_SOURCE_ROOT_CONTENT_HASH"
echo "Inventory root SHA:       $INVENTORY_SHA256"
echo "Dropbox state SHA:        $STATE_SHA256"
echo "Current v2 latest SHA:    $EXPECTED_V2_LATEST_SHA256"
echo "Checkpoint:               $CHECKPOINT"
echo
echo "ALL WRAPPER GATES PASSED."
echo

# ------------------------------------------------------------
# Explicit operator authorisation - final pre-mutation boundary
# ------------------------------------------------------------

if [ "${UK_AQ_STEP10_APPLY_AUTH:-}" != "AUTHORISE_TEST_STEP10_APPLY" ]; then
  echo "EXTERNAL READ-ONLY PREFLIGHT PASSED: all TEST Step 10 gates succeeded; no external mutation was attempted."
  echo "APPLY AUTHORISATION ABSENT: UK_AQ_STEP10_APPLY_AUTH is missing or invalid."
  echo "TO APPLY: export UK_AQ_STEP10_APPLY_AUTH=AUTHORISE_TEST_STEP10_APPLY"
  printf 'THEN RERUN: %q\n' "$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
  exit 2
fi

echo "Explicit TEST Step 10 apply authorisation accepted."
echo "Starting TEST canonical observation-history migration."
echo

# ------------------------------------------------------------
# FIRST MUTATING COMMAND
# ------------------------------------------------------------

set +e

/usr/bin/time -p node scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs \
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
  --checkpoint-out "$CHECKPOINT" \
  --report-out "$MIGRATION_REPORT" \
  > "$MIGRATION_STDOUT"

MIGRATION_STATUS=$?

set -e

echo
echo "Migration exit status: $MIGRATION_STATUS"

if [ "$MIGRATION_STATUS" -ne 0 ]; then
  echo
  echo "STOP: Step 10 migration did not complete successfully."
  echo "Do NOT restart from scratch."
  echo "Preserve checkpoint/staging/publication evidence for review."
  echo
  echo "Checkpoint: $CHECKPOINT"
  echo "Report:     $MIGRATION_REPORT"
  echo "Stdout:     $MIGRATION_STDOUT"
  exit "$MIGRATION_STATUS"
fi

echo
echo "============================================================"
echo "STEP 10 COMMAND COMPLETED"
echo "============================================================"

if [ -f "$CHECKPOINT" ]; then
  echo
  echo "Checkpoint SHA256:"
  shasum -a 256 "$CHECKPOINT"
fi

if [ -f "$MIGRATION_REPORT" ]; then
  echo
  echo "Migration report SHA256:"
  shasum -a 256 "$MIGRATION_REPORT"

  echo
  echo "Migration result summary:"

  node --input-type=module -e '
    import fs from "node:fs";
    const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(JSON.stringify({
      result_kind: x.result?.kind ?? null,
      migration_run_id:
        x.result?.migration_run_id ?? x.audit?.migration_run_id ?? null,
      cutover_ready:
        x.result?.cutover_ready ?? x.audit?.cutover_ready ?? null,
      audit_blockers: x.audit?.blockers ?? null,
      rollback_ready: x.audit?.rollback_ready ?? null,
      publication_verification:
        x.audit?.publication_verification ?? null,
      r2_stored_sha_verification:
        x.audit?.r2_stored_sha_verification ?? null
    }, null, 2));
  ' "$MIGRATION_REPORT"
fi

echo
echo "Step 10 command has returned successfully."
echo "DO NOT unfreeze writers or change index authority yet."
echo "Review Step 10 evidence before proceeding."
