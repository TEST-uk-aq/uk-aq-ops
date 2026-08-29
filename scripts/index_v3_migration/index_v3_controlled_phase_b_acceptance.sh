#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  index_v3_controlled_phase_b_acceptance.sh \
    --environment TEST|LIVE \
    --expected-repository OWNER/REPO \
    --expected-git-sha SHA \
    --expected-bucket BUCKET \
    --site-url URL \
    --dry-run

  index_v3_controlled_phase_b_acceptance.sh \
    --environment TEST|LIVE \
    --expected-repository OWNER/REPO \
    --expected-git-sha SHA \
    --expected-bucket BUCKET \
    --site-url URL \
    --apply \
    --writers-frozen \
    --expected-day YYYY-MM-DD \
    --expected-connector N \
    --expected-row-count N \
    --expected-source-content-hash SHA256 \
    --expected-source-contract-version N \
    --report-out PATH \
    [--run-id ID] \
    [--node-bin PATH]

Strict --dry-run guarantees:
- no runPhaseBBackup invocation;
- no database writes;
- no R2 writes;
- no Dropbox writes;
- no GitHub/Cloudflare mutation.

The wrapper performs read-only GitHub, D1 scheduler, maintenance and database checks.
The --apply path invokes only runPhaseBBackup() under the global observation-operation
lock. It never invokes the full Prune Daily job, so the IngestDB deletion path is not
part of this acceptance operation. The retained source is verified after the write.
EOF
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf 'CONTROLLED PHASE B ACCEPTANCE STOPPED. KEEP MAINTENANCE ON AND WRITERS FROZEN.\n' >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "required loaded environment value is missing: $name"
}

ENVIRONMENT=""
EXPECTED_REPOSITORY=""
EXPECTED_GIT_SHA=""
EXPECTED_BUCKET=""
SITE_URL=""
MODE=""
WRITERS_FROZEN="false"
EXPECTED_DAY=""
EXPECTED_CONNECTOR=""
EXPECTED_ROW_COUNT=""
EXPECTED_SOURCE_CONTENT_HASH=""
EXPECTED_SOURCE_CONTRACT_VERSION=""
REPORT_OUT=""
RUN_ID=""
NODE_BIN=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --environment) ENVIRONMENT="${2:-}"; shift 2 ;;
    --expected-repository) EXPECTED_REPOSITORY="${2:-}"; shift 2 ;;
    --expected-git-sha) EXPECTED_GIT_SHA="${2:-}"; shift 2 ;;
    --expected-bucket) EXPECTED_BUCKET="${2:-}"; shift 2 ;;
    --site-url) SITE_URL="${2:-}"; shift 2 ;;
    --dry-run)
      [ -z "$MODE" ] || fail "choose exactly one of --dry-run or --apply"
      MODE="dry-run"
      shift
      ;;
    --apply)
      [ -z "$MODE" ] || fail "choose exactly one of --dry-run or --apply"
      MODE="apply"
      shift
      ;;
    --writers-frozen) WRITERS_FROZEN="true"; shift ;;
    --expected-day) EXPECTED_DAY="${2:-}"; shift 2 ;;
    --expected-connector) EXPECTED_CONNECTOR="${2:-}"; shift 2 ;;
    --expected-row-count) EXPECTED_ROW_COUNT="${2:-}"; shift 2 ;;
    --expected-source-content-hash) EXPECTED_SOURCE_CONTENT_HASH="${2:-}"; shift 2 ;;
    --expected-source-contract-version) EXPECTED_SOURCE_CONTRACT_VERSION="${2:-}"; shift 2 ;;
    --report-out) REPORT_OUT="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

ENVIRONMENT="$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')"
case "$ENVIRONMENT" in TEST|LIVE) ;; *) usage >&2; fail "--environment must be TEST or LIVE" ;; esac
[ -n "$EXPECTED_REPOSITORY" ] || fail "--expected-repository is required"
printf '%s' "$EXPECTED_GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "--expected-git-sha must be a full lower-case Git SHA"
[ -n "$EXPECTED_BUCKET" ] || fail "--expected-bucket is required"
[ -n "$SITE_URL" ] || fail "--site-url is required"
[ -n "$MODE" ] || fail "choose exactly one of --dry-run or --apply"

if [ "$MODE" = "dry-run" ]; then
  [ -z "$REPORT_OUT" ] || fail "--report-out is not allowed with --dry-run"
else
  [ "$WRITERS_FROZEN" = "true" ] || fail "--apply requires explicit --writers-frozen operator assertion"
  printf '%s' "$EXPECTED_DAY" | grep -Eq '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' || fail "--expected-day must be YYYY-MM-DD"
  printf '%s' "$EXPECTED_CONNECTOR" | grep -Eq '^[1-9][0-9]*$' || fail "--expected-connector must be a positive integer"
  printf '%s' "$EXPECTED_ROW_COUNT" | grep -Eq '^[1-9][0-9]*$' || fail "--expected-row-count must be a positive integer"
  printf '%s' "$EXPECTED_SOURCE_CONTENT_HASH" | grep -Eq '^[0-9a-f]{64}$' || fail "--expected-source-content-hash must be a lower-case SHA-256"
  printf '%s' "$EXPECTED_SOURCE_CONTRACT_VERSION" | grep -Eq '^[1-9][0-9]*$' || fail "--expected-source-contract-version must be a positive integer"
  [ -n "$REPORT_OUT" ] || fail "--report-out is required with --apply"
fi

for command in git gh jq curl awk tr grep npx; do
  require_command "$command"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "repository root cannot be derived from Git"
cd -- "$REPO_ROOT"

CURRENT_SHA="$(git rev-parse HEAD)"
[ "$CURRENT_SHA" = "$EXPECTED_GIT_SHA" ] \
  || fail "current Git SHA differs from --expected-git-sha: current=$CURRENT_SHA expected=$EXPECTED_GIT_SHA"
if [ -n "$(git status --short)" ]; then
  git status --short >&2
  fail "working tree is not clean"
fi

REPO_JSON="$(gh repo view --json nameWithOwner,defaultBranchRef 2>/dev/null)" \
  || fail "GitHub repository identity could not be read"
REPO_SLUG="$(printf '%s' "$REPO_JSON" | jq -r '.nameWithOwner // empty')"
DEFAULT_BRANCH="$(printf '%s' "$REPO_JSON" | jq -r '.defaultBranchRef.name // empty')"
CURRENT_BRANCH="$(git branch --show-current)"
[ "$REPO_SLUG" = "$EXPECTED_REPOSITORY" ] \
  || fail "repository differs from --expected-repository: current=$REPO_SLUG expected=$EXPECTED_REPOSITORY"
[ -n "$DEFAULT_BRANCH" ] || fail "GitHub default branch could not be resolved"
[ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] \
  || fail "current branch $CURRENT_BRANCH is not GitHub default branch $DEFAULT_BRANCH"

for name in \
  UKAQ_ENV_NAME \
  UK_AQ_R2_HISTORY_VERSION \
  UK_AQ_R2_HISTORY_INDEX_VERSION \
  UK_AQ_R2_HISTORY_INTEGRITY_VERSION \
  SUPABASE_DB_URL \
  OBS_AQIDB_SUPABASE_URL \
  OBS_AQIDB_SECRET_KEY \
  CFLARE_R2_ENDPOINT \
  CFLARE_R2_BUCKET \
  CFLARE_R2_ACCESS_KEY_ID \
  CFLARE_R2_SECRET_ACCESS_KEY
do
  require_env "$name"
done

LOADED_ENV="$(printf '%s' "$UKAQ_ENV_NAME" | tr '[:lower:]' '[:upper:]')"
[ "$LOADED_ENV" = "$ENVIRONMENT" ] \
  || fail "loaded UKAQ_ENV_NAME=$LOADED_ENV differs from requested $ENVIRONMENT"
[ "$UK_AQ_R2_HISTORY_VERSION" = "v2" ] || fail "loaded logical history authority must be v2"
[ "$UK_AQ_R2_HISTORY_INDEX_VERSION" = "v3" ] || fail "loaded observation index authority must be v3"
[ "$UK_AQ_R2_HISTORY_INTEGRITY_VERSION" = "v2" ] || fail "loaded Integrity semantic version must be v2"
[ "$CFLARE_R2_BUCKET" = "$EXPECTED_BUCKET" ] \
  || fail "loaded R2 bucket differs from --expected-bucket"

GH_ENV="$(gh variable get UKAQ_ENV_NAME --repo "$REPO_SLUG" 2>/dev/null | tr '[:lower:]' '[:upper:]')" \
  || fail "GitHub UKAQ_ENV_NAME could not be read"
[ "$GH_ENV" = "$ENVIRONMENT" ] || fail "GitHub environment differs from requested $ENVIRONMENT"
GH_HISTORY="$(gh variable get UK_AQ_R2_HISTORY_VERSION --repo "$REPO_SLUG" 2>/dev/null)" \
  || fail "GitHub UK_AQ_R2_HISTORY_VERSION could not be read"
GH_INDEX="$(gh variable get UK_AQ_R2_HISTORY_INDEX_VERSION --repo "$REPO_SLUG" 2>/dev/null)" \
  || fail "GitHub UK_AQ_R2_HISTORY_INDEX_VERSION could not be read"
[ "$GH_HISTORY" = "v2" ] || fail "persistent GitHub history authority is not v2"
[ "$GH_INDEX" = "v3" ] || fail "persistent GitHub observation index authority is not v3"
# Intentionally no GitHub UK_AQ_R2_HISTORY_INTEGRITY_VERSION lookup. Integrity v2 is
# a loaded/profile semantic value, not a persistent GitHub migration authority.

SITE_URL="${SITE_URL%/}"
SITE_MODE="$(curl -fsSL \
  -H 'Cache-Control: no-cache, no-store' \
  -H 'Pragma: no-cache' \
  "$SITE_URL/uk-aq-site-mode.json?controlled_phase_b_check=$(date -u +%s)-$$")" \
  || fail "public maintenance status could not be read"
printf '%s' "$SITE_MODE" | jq -e '
  .schema_version == 1 and
  .mode == "on" and
  (.deployment_id | type == "string" and length > 0)
' >/dev/null || fail "public site maintenance mode is not positively ON"

SCHEDULER_CONFIG="cloudflare/scheduler/wrangler.toml"
[ -f "$SCHEDULER_CONFIG" ] || fail "scheduler configuration is missing: $SCHEDULER_CONFIG"
D1_DATABASE="$(awk -F ' *= *' '/^database_name *=/ {gsub(/"/, "", $2); print $2; exit}' "$SCHEDULER_CONFIG")"
[ -n "$D1_DATABASE" ] || fail "scheduler D1 database name is absent from $SCHEDULER_CONFIG"
D1_JSON="$(npx --yes wrangler@4.61.1 d1 execute "$D1_DATABASE" \
  --config "$SCHEDULER_CONFIG" \
  --remote \
  --command "SELECT job_key, enabled FROM scheduler_jobs WHERE job_key IN ('uk_aq_prune_daily','uk_aq_r2_history_dropbox_backup','uk_aq_r2_history_dropbox_backup_force_prune_recheck') ORDER BY job_key;" \
  --json 2>/dev/null)" \
  || fail "read-only remote D1 scheduler SELECT failed"
printf '%s' "$D1_JSON" | jq -e '
  [.. | objects | select(has("job_key") and has("enabled")) | {job_key, enabled}] as $rows
  | ($rows | length) == 3
  and all($rows[]; (.enabled | type) == "number" and .enabled == 0)
  and (["uk_aq_prune_daily","uk_aq_r2_history_dropbox_backup","uk_aq_r2_history_dropbox_backup_force_prune_recheck"] as $expected
    | ([$rows[].job_key] | sort) == ($expected | sort))
' >/dev/null || fail "migration-sensitive scheduler jobs are not exactly the three required disabled rows"

ACTIVE_PRUNE_RUNS="$(gh run list \
  --repo "$REPO_SLUG" \
  --workflow uk_aq_prune_daily.yml \
  --limit 50 \
  --json databaseId,status,conclusion,event,createdAt,url \
  --jq '[.[] | select(.status != "completed")]' 2>/dev/null)" \
  || fail "Prune Daily workflow active-run state could not be read"
[ "$ACTIVE_PRUNE_RUNS" = "[]" ] || {
  printf '%s\n' "$ACTIVE_PRUNE_RUNS" >&2
  fail "an existing Prune Daily workflow run is still active"
}

if [ -n "$NODE_BIN" ]; then
  [ -x "$NODE_BIN" ] || fail "--node-bin is not executable: $NODE_BIN"
else
  if command -v node >/dev/null 2>&1 && node --version 2>/dev/null | grep -Eq '^v20\.'; then
    NODE_BIN="$(command -v node)"
  else
    NODE_BIN="$(npx --yes node@20 -p 'process.execPath')" \
      || fail "Node 20 could not be resolved"
  fi
fi
NODE_VERSION="$($NODE_BIN --version 2>/dev/null)" || fail "selected Node binary could not be executed"
printf '%s' "$NODE_VERSION" | grep -Eq '^v20\.' \
  || fail "controlled acceptance requires Node 20; selected $NODE_VERSION"

export GITHUB_SHA="$EXPECTED_GIT_SHA"

NODE_ARGS=(
  --environment "$ENVIRONMENT"
  --expected-bucket "$EXPECTED_BUCKET"
  --expected-git-sha "$EXPECTED_GIT_SHA"
)

if [ -n "$EXPECTED_DAY" ]; then NODE_ARGS+=(--expected-day "$EXPECTED_DAY"); fi
if [ -n "$EXPECTED_CONNECTOR" ]; then NODE_ARGS+=(--expected-connector "$EXPECTED_CONNECTOR"); fi
if [ -n "$EXPECTED_ROW_COUNT" ]; then NODE_ARGS+=(--expected-row-count "$EXPECTED_ROW_COUNT"); fi
if [ -n "$EXPECTED_SOURCE_CONTENT_HASH" ]; then NODE_ARGS+=(--expected-source-content-hash "$EXPECTED_SOURCE_CONTENT_HASH"); fi
if [ -n "$EXPECTED_SOURCE_CONTRACT_VERSION" ]; then NODE_ARGS+=(--expected-source-contract-version "$EXPECTED_SOURCE_CONTRACT_VERSION"); fi

printf '%s\n' '============================================================'
printf 'UK AQ INDEX V3 CONTROLLED PHASE B ACCEPTANCE: %s\n' "$ENVIRONMENT"
printf 'Repository: %s / %s\n' "$REPO_SLUG" "$CURRENT_BRANCH"
printf 'Git SHA: %s\n' "$EXPECTED_GIT_SHA"
printf 'Node: %s\n' "$NODE_VERSION"
printf 'R2 bucket: %s\n' "$EXPECTED_BUCKET"
printf 'Maintenance: ON\n'
printf 'Migration-sensitive schedulers: DISABLED\n'
printf 'Active Prune workflows: NONE\n'
printf 'Logical history/index: v2/v3\n'
printf 'Loaded Integrity semantic version: v2\n\n'

NODE_RUNNER="$SCRIPT_DIR/index_v3_controlled_phase_b_acceptance.mjs"
[ -f "$NODE_RUNNER" ] || fail "Node acceptance runner is missing: $NODE_RUNNER"
LOCK_RUNNER="scripts/operations/uk_aq_with_observations_global_operation_lock.mjs"
[ -f "$LOCK_RUNNER" ] || fail "global observation-operation lock runner is missing: $LOCK_RUNNER"

if [ "$MODE" = "dry-run" ]; then
  "$NODE_BIN" "$NODE_RUNNER" --dry-run "${NODE_ARGS[@]}"
  exit $?
fi

if [ -z "$RUN_ID" ]; then
  RUN_ID="${ENVIRONMENT,,}-index-v3-controlled-phaseb-$(date -u +%Y%m%dT%H%M%SZ)"
fi

printf 'Run ID: %s\n' "$RUN_ID"
printf 'Evidence report: %s\n' "$REPORT_OUT"
printf '%s\n' 'APPLY SCOPE: runPhaseBBackup() ONLY; FULL PRUNE/INGESTDB DELETION PATH IS NOT INVOKED'
printf '%s\n\n' 'ROLLBACK DATA PRESERVATION: RETAIN UPSTREAM SOURCE'

"$NODE_BIN" "$LOCK_RUNNER" \
  --owner prune_daily \
  --run-id "$RUN_ID" \
  --timeout-ms 60000 \
  --heartbeat-ms 5000 \
  -- \
  "$NODE_BIN" "$NODE_RUNNER" \
    --apply \
    "${NODE_ARGS[@]}" \
    --run-id "$RUN_ID" \
    --report-out "$REPORT_OUT"
