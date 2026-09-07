#!/bin/bash
set -euo pipefail

# Read-only TEST side-by-side cut-over verification, before writer release.
# Requires the existing supervised migration lock for the pinned run throughout.
# Historical in-place/v3-rebuild checks are retained separately in
# index_v3_historical_post_cutover_verify.sh.

usage() {
  cat <<'EOF'
Usage:
  index_v3_post_cutover_verify.sh \
    --transition v2-to-v3 \
    --expected-repository OWNER/REPO \
    --expected-repository-git-sha SHA \
    --expected-bucket BUCKET \
    --plan-report PATH \
    --checkpoint PATH \
    --site-url URL \
    --cache-url URL

Required environment already used by the migration tooling:
  UKAQ_ENV_NAME
  UK_AQ_R2_HISTORY_VERSION
  CFLARE_R2_ENDPOINT
  CFLARE_R2_BUCKET
  CFLARE_R2_ACCESS_KEY_ID
  CFLARE_R2_SECRET_ACCESS_KEY

TEST live-probe requirement:
  UK_AQ_CACHE_BYPASS_SECRET

The deployed TEST cache Worker must also have UK_AQ_LOCAL_DEV_BYPASS_ENABLED=true/1.
The secret is used only in request headers and is never printed.
EOF
}

pass() { printf 'PASS: %s\n' "$1"; }
warn() { printf 'WARN: %s\n' "$1"; }
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf 'DEPLOYED-PATH VERIFICATION FAILED. KEEP THE MIGRATION LOCK HELD; DO NOT RELEASE WRITERS.\n' >&2
  exit 1
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "required loaded environment value is missing: $name"
}

is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

read_http_header() {
  local header_name="$1" headers_file="$2"
  awk -v wanted="$(printf '%s' "$header_name" | tr '[:upper:]' '[:lower:]')" '
    {
      line = $0
      sub(/\r$/, "", line)
      colon = index(line, ":")
      if (colon <= 0) next
      name = substr(line, 1, colon - 1)
      value = substr(line, colon + 1)
      gsub(/^[[:space:]]+/, "", value)
      if (tolower(name) == wanted) {
        print value
        exit
      }
    }
  ' "$headers_file"
}

EXPECTED_REPOSITORY=""
EXPECTED_REPOSITORY_GIT_SHA=""
EXPECTED_BUCKET=""
PLAN_REPORT=""
TRANSITION=""
CHECKPOINT=""
SITE_URL=""
CACHE_URL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-repository) EXPECTED_REPOSITORY="${2:-}"; shift 2 ;;
    --expected-repository-git-sha) EXPECTED_REPOSITORY_GIT_SHA="${2:-}"; shift 2 ;;
    --expected-bucket) EXPECTED_BUCKET="${2:-}"; shift 2 ;;
    --plan-report) PLAN_REPORT="${2:-}"; shift 2 ;;
    --transition) TRANSITION="${2:-}"; shift 2 ;;
    --checkpoint) CHECKPOINT="${2:-}"; shift 2 ;;
    --site-url) SITE_URL="${2:-}"; shift 2 ;;
    --cache-url) CACHE_URL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[ -n "$EXPECTED_REPOSITORY" ] && [ -n "$EXPECTED_BUCKET" ] || fail "explicit expected repository and bucket are required"
printf '%s' "$EXPECTED_REPOSITORY_GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "explicit expected repository Git SHA is required"
[ -n "$PLAN_REPORT" ] || fail "--plan-report is required"
[ -n "$TRANSITION" ] || fail "--transition is required"
[ "$TRANSITION" = "v2-to-v3" ] || fail "normal cut-over requires v2-to-v3; use the separately named historical tool for v3-rebuild"
[ -n "$CHECKPOINT" ] || fail "--checkpoint is required"
[ -n "$SITE_URL" ] || fail "--site-url is required"
[ -n "$CACHE_URL" ] || fail "--cache-url is required"

for command in git gh jq node curl shasum npx awk tr; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "repository root cannot be derived from Git"
cd -- "$REPO_ROOT"

[ -f "$PLAN_REPORT" ] || fail "migration plan report is missing: $PLAN_REPORT"
jq empty "$PLAN_REPORT" >/dev/null 2>&1 || fail "migration plan report is invalid JSON"
[ "$(jq -r '.result.transition.kind // empty' "$PLAN_REPORT")" = "$TRANSITION" ] \
  || fail "migration plan transition does not match --transition"
[ -f "$CHECKPOINT" ] || fail "migration checkpoint is missing: $CHECKPOINT"

for name in \
  UKAQ_ENV_NAME \
  UK_AQ_R2_HISTORY_VERSION \
  CFLARE_R2_ENDPOINT \
  CFLARE_R2_BUCKET \
  CFLARE_R2_ACCESS_KEY_ID \
  CFLARE_R2_SECRET_ACCESS_KEY \
  UK_AQ_CACHE_BYPASS_SECRET
do
  require_env "$name"
done

ENVIRONMENT="$(printf '%s' "$UKAQ_ENV_NAME" | tr '[:lower:]' '[:upper:]')"
[ "$ENVIRONMENT" = "TEST" ] || fail "normal side-by-side cut-over is TEST-only"
[ "$CFLARE_R2_BUCKET" = "$EXPECTED_BUCKET" ] || fail "loaded bucket differs from explicit expected bucket"

REPO_JSON="$(gh repo view --json nameWithOwner,defaultBranchRef 2>/dev/null)" \
  || fail "GitHub repository identity could not be read"
REPO_SLUG="$(printf '%s' "$REPO_JSON" | jq -r '.nameWithOwner // empty')"
DEFAULT_BRANCH="$(printf '%s' "$REPO_JSON" | jq -r '.defaultBranchRef.name // empty')"
CURRENT_BRANCH="$(git branch --show-current)"
[ -n "$REPO_SLUG" ] || fail "GitHub repository slug is empty"
[ -n "$DEFAULT_BRANCH" ] || fail "GitHub default branch is empty"
[ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] \
  || fail "current branch $CURRENT_BRANCH is not GitHub default branch $DEFAULT_BRANCH"
[ "$REPO_SLUG" = "$EXPECTED_REPOSITORY" ] || fail "repository differs from explicit expected identity"
CURRENT_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(gh api "repos/$REPO_SLUG/commits/$DEFAULT_BRANCH" --jq .sha)" || fail "current default-branch SHA could not be read"
[ "$CURRENT_SHA" = "$EXPECTED_REPOSITORY_GIT_SHA" ] && [ "$CURRENT_SHA" = "$REMOTE_SHA" ] || fail "local HEAD differs from explicit/current default-branch identity"
if [ -n "$(git status --short)" ]; then
  git status --short >&2
  fail "working tree is not clean"
fi

printf '%s\n' '============================================================'
printf 'UK AQ INDEX V3 DEPLOYED-PATH VERIFY: %s / %s\n' "$ENVIRONMENT" "$TRANSITION"
printf 'Repository: %s / %s\n' "$REPO_SLUG" "$CURRENT_BRANCH"
printf 'Site URL: %s\n' "${SITE_URL%/}"
printf 'Cache URL: %s\n' "${CACHE_URL%/}"
printf '%s\n\n' 'READ-ONLY: NO CONFIGURATION OR DATA MUTATION IS PERFORMED'

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/uk-aq-index-v3-post-cutover.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

GH_ENV="$(gh variable get UKAQ_ENV_NAME --repo "$REPO_SLUG" 2>/dev/null | tr '[:lower:]' '[:upper:]')" \
  || fail "GitHub UKAQ_ENV_NAME could not be read"
[ "$GH_ENV" = "$ENVIRONMENT" ] || fail "GitHub environment does not match loaded $ENVIRONMENT"

HISTORY_AUTHORITY="$(gh variable get UK_AQ_R2_HISTORY_VERSION --repo "$REPO_SLUG" 2>/dev/null)" || fail "persistent history generation could not be read"
[ "$HISTORY_AUTHORITY" = "v3" ] && [ "$UK_AQ_R2_HISTORY_VERSION" = "v3" ] || fail "loaded and persistent history generation must both be v3"
pass "loaded and persistent authority select complete v3"

STABLE_STATION_WORKER="$(gh variable get UK_AQ_STATION_HISTORY_WORKER_NAME --repo "$REPO_SLUG" 2>/dev/null)" \
  || fail "GitHub UK_AQ_STATION_HISTORY_WORKER_NAME could not be read"
case "$STABLE_STATION_WORKER" in
  ''|*[!a-z0-9-]*|-*|*-|*-v3-candidate)
    fail "stable station-history Worker identity is invalid: $STABLE_STATION_WORKER"
    ;;
esac
STATION_WORKER="$STABLE_STATION_WORKER"
OBSERVATION_WORKER="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME --repo "$REPO_SLUG" 2>/dev/null)" || fail "observation worker identity could not be read"
case "$OBSERVATION_WORKER" in ''|*[!a-z0-9-]*|-*|*-|*-v3-candidate) fail "invalid stable observation Worker name" ;; esac
RESOLVED_LOCAL="$(bash workers/uk_aq_cache_proxy/resolve_station_history_service.sh "$STATION_WORKER" v3 '')" || fail "cache binding resolver rejected v3"
[ "$RESOLVED_LOCAL" = "$STATION_WORKER" ] || fail "cache binding does not select the stable station Worker"
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

OBS_RUN_ID="$(verify_current_successful_deploy uk_aq_observs_history_r2_api_worker_deploy.yml '.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml workers/uk_aq_observs_history_r2_api_worker workers/shared' 'observation history')"
STATION_RUN_ID="$(verify_current_successful_deploy uk_aq_station_history_deploy.yml '.github/workflows/uk_aq_station_history_deploy.yml workers/uk_aq_station_history workers/shared' 'station history')"
CACHE_RUN_ID="$(verify_current_successful_deploy uk_aq_cache_proxy_deploy.yml '.github/workflows/uk_aq_cache_proxy_deploy.yml workers/uk_aq_cache_proxy workers/uk_aq_station_history workers/shared' 'cache')"
CACHE_LOG="$(gh run view "$CACHE_RUN_ID" --repo "$REPO_SLUG" --log 2>/dev/null)" || fail "cache deployment log could not be read"
printf '%s\n' "$CACHE_LOG" | grep -Fq "Resolved STATION_HISTORY Service Binding target: $STATION_WORKER" || fail "cache deployment did not bind the expected stable station Worker"
printf '%s\n' "$CACHE_LOG" | grep -Fq 'Persistent observation-history authority: v3' || fail "cache deployment did not record v3 authority"
STATION_LOG="$(gh run view "$STATION_RUN_ID" --repo "$REPO_SLUG" --log 2>/dev/null)" || fail "station deployment log could not be read"
printf '%s\n' "$STATION_LOG" | grep -Fq "Resolved observation-history Worker target: $OBSERVATION_WORKER" || fail "station deployment target differs from the expected stable observation Worker"
for deploy_id in "$STATION_RUN_ID" "$OBS_RUN_ID"; do
  DEPLOY_LOG="$(gh run view "$deploy_id" --repo "$REPO_SLUG" --log 2>/dev/null)" || fail "history deployment log could not be read"
  printf '%s\n' "$DEPLOY_LOG" | grep -Fq 'Persistent observation-history authority: v3' || fail "history deployment did not record v3 authority"
done

LOCAL_DEV_BYPASS="$(gh variable get UK_AQ_LOCAL_DEV_BYPASS_ENABLED --repo "$REPO_SLUG" 2>/dev/null || true)"
is_true "$LOCAL_DEV_BYPASS" \
  || fail "UK_AQ_LOCAL_DEV_BYPASS_ENABLED is not enabled; non-interactive TEST live probe cannot safely bypass session/origin checks"
pass "TEST local-dev bypass is enabled for the non-interactive live probe"

SITE_URL="${SITE_URL%/}"
CACHE_URL="${CACHE_URL%/}"
CACHE_BUSTER="$(date -u +%s)-$$"
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
    and all($rows[]; .job_key == "uk_aq_prune_daily"
      or .job_key == "uk_aq_r2_history_dropbox_backup"
      or .job_key == "uk_aq_r2_history_dropbox_backup_force_prune_recheck")
' >/dev/null || fail "migration-sensitive scheduler jobs are not exactly the three required disabled rows"
pass "all migration-sensitive scheduler jobs retain exactly one disabled numeric row"

export PLAN_REPORT CHECKPOINT ENVIRONMENT
node --input-type=module - <<'NODE' || fail "immutable side-by-side dependency verification failed"
import fs from "node:fs";
import { r2GetObject, r2HeadObject } from "./workers/shared/r2_sigv4.mjs";
import { createSideBySideLockAssertion } from "./scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs";
import { verifySideBySideSourceRoot, verifyObservationHistoryV3CurrentDependencies } from "./scripts/backup_r2/lib/observation_history_migration_v3.mjs";
import { readAuthenticatedCutoverBaseline, selectedCutoverGeneration, verifySelectedCutoverMetadata } from "./scripts/index_v3_migration/index_v3_cutover_generation_evidence.mjs";
const generation = selectedCutoverGeneration(process.env);
const planReport = JSON.parse(fs.readFileSync(process.env.PLAN_REPORT, "utf8"));
const assertLockHeld = createSideBySideLockAssertion({ env: process.env, migrationRunId: planReport.result.migration_run_id });
assertLockHeld();
const { plan, checkpoint } = readAuthenticatedCutoverBaseline({
  checkpointPath: process.env.CHECKPOINT, planReport,
  environment: process.env.ENVIRONMENT, bucket: process.env.CFLARE_R2_BUCKET,
});
const r2 = {
  endpoint: process.env.CFLARE_R2_ENDPOINT, bucket: process.env.CFLARE_R2_BUCKET,
  region: process.env.CFLARE_R2_REGION || "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};
const guarded = (read) => async ({ key }) => {
  assertLockHeld();
  const result = await read({ r2, key });
  assertLockHeld();
  return result;
};
const getObject = guarded(r2GetObject), headObject = guarded(r2HeadObject);
await verifySideBySideSourceRoot({ plan, getObject });
const result = await verifyObservationHistoryV3CurrentDependencies({
  plan, checkpoint, getObject, headObject,
  publicationResult: { ok: true, checkpoint_evidence: true },
});
if (!result.ok || !result.cutover_ready || result.blockers?.length ||
    result.recovery_reconciliation?.counts?.fail !== 0 ||
    result.recovery_reconciliation?.counts?.legacy_recovery_ordering !== 0) {
  throw new Error("Current v3 closure does not exactly equal completed migration evidence");
}
const metadata = await verifySelectedCutoverMetadata({ generation, getObject, headObject });
await verifySideBySideSourceRoot({ plan, getObject });
assertLockHeld();
console.log(JSON.stringify({ immutable_migration_verified: true, metadata }));
NODE
pass "current v3 dependency closure equals immutable migration evidence; locked v2 source is unchanged"

printf '%s\n' '--- A. DEPLOYMENT / ROUTING SMOKE TEST ---'

PROBE_JSON="$(node --input-type=module - <<'NODE'
import crypto from "node:crypto";
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";
import { encodeObservationHistoryIndexV3Json } from "./workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";

const r2 = {
  endpoint: process.env.CFLARE_R2_ENDPOINT,
  bucket: process.env.CFLARE_R2_BUCKET,
  region: process.env.CFLARE_R2_REGION || "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};
const latestKey = "history/_index_v3/observations_timeseries_latest.json";
const supportedPollutants = new Set(["no2", "pm25", "pm10"]);
const getBytes = async (key) => {
  const result = await r2GetObject({ r2, key });
  return Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);
};
const latestBytes = await getBytes(latestKey);
const latest = JSON.parse(latestBytes.toString("utf8"));
if (
  latest?.schema_version !== 3 ||
  latest?.kind !== "observation_timeseries_latest_global" ||
  latest?.index_generation !== "v3" ||
  latest?.history_version !== "v2" ||
  !Array.isArray(latest?.day_summaries) ||
  latest.day_summaries.length === 0
) {
  throw new Error("v3 latest-global index is invalid or empty");
}
const days = [...latest.day_summaries].sort((a, b) =>
  String(b?.day_utc || "").localeCompare(String(a?.day_utc || ""))
);
let selected = null;
for (const day of days) {
  const roots = Array.isArray(day?.scoped_roots) ? day.scoped_roots : [];
  for (const root of roots) {
    const pollutant = String(root?.pollutant_code || "").trim().toLowerCase();
    if (!supportedPollutants.has(pollutant)) continue;
    const key = String(root?.key || "");
    if (!key) continue;
    const body = await getBytes(key);
    if (Number(root.byte_size) !== body.byteLength) {
      throw new Error(`scoped-root byte-size mismatch: ${key}`);
    }
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    if (String(root.sha256 || "") !== sha) {
      throw new Error(`scoped-root SHA mismatch: ${key}`);
    }
    // The immutable dependency verifier above authenticated this entire closure.
    // Select a probe from the exact-leaf payload used by the normal v3 reader.
    const validated = JSON.parse(body.toString("utf8"));
    if (encodeObservationHistoryIndexV3Json(validated) !== body.toString("utf8") ||
        validated.kind !== "observation_timeseries_physical_leaf_scoped_manifest" ||
        validated.index_generation !== "v3" || validated.key !== key ||
        validated.day_utc !== day.day_utc || validated.connector_id !== root.connector_id ||
        validated.pollutant_code !== root.pollutant_code ||
        !supportedPollutants.has(validated.pollutant_code)) {
      throw new Error(`selected scoped root is not station-series compatible: ${key}`);
    }
    const ids = Object.keys(validated.leaves_by_timeseries_id || {}).map(Number).sort((a, b) => a - b);
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("invalid exact-leaf timeseries identity");
    if (ids.length > 0 && Number(validated.coverage?.row_count || 0) > 0) {
      const dayUtc = validated.day_utc;
      const start = new Date(`${dayUtc}T00:00:00.000Z`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      selected = {
        latest_key: latestKey,
        latest_max_day_utc: latest.max_day_utc,
        scoped_manifest_key: key,
        day_utc: dayUtc,
        timeseries_id: ids[0],
        connector_id: validated.connector_id,
        pollutant: validated.pollutant_code,
        start_utc: start.toISOString(),
        end_utc: end.toISOString(),
        scoped_row_count: validated.coverage.row_count,
      };
      break;
    }
  }
  if (selected) break;
}
if (!selected) throw new Error("no non-empty no2/pm25/pm10 v3 scoped manifest could provide a live probe identity");
process.stdout.write(JSON.stringify(selected));
NODE
)" || fail "could not select a deterministic station-series-compatible historical live-probe identity from index v3"

TIMESERIES_ID="$(printf '%s' "$PROBE_JSON" | jq -r '.timeseries_id')"
CONNECTOR_ID="$(printf '%s' "$PROBE_JSON" | jq -r '.connector_id')"
POLLUTANT="$(printf '%s' "$PROBE_JSON" | jq -r '.pollutant')"
START_UTC="$(printf '%s' "$PROBE_JSON" | jq -r '.start_utc')"
END_UTC="$(printf '%s' "$PROBE_JSON" | jq -r '.end_utc')"
PROBE_DAY="$(printf '%s' "$PROBE_JSON" | jq -r '.day_utc')"
pass "selected v3 historical probe: day=$PROBE_DAY timeseries=$TIMESERIES_ID connector=$CONNECTOR_ID pollutant=$POLLUTANT"

HEADERS_FILE="$TMP_DIR/headers.txt"
BODY_FILE="$TMP_DIR/body.json"

HTTP_STATUS="$(curl -sS \
  -D "$HEADERS_FILE" \
  -o "$BODY_FILE" \
  -w '%{http_code}' \
  -H "Origin: $SITE_URL" \
  -H "X-CIC-Local-Dev-Token: $UK_AQ_CACHE_BYPASS_SECRET" \
  -H "X-UK-AQ-Bypass-Token: $UK_AQ_CACHE_BYPASS_SECRET" \
  -H 'Cache-Control: no-cache, no-store' \
  --get "$CACHE_URL/api/aq/station-series" \
  --data-urlencode "timeseries_id=$TIMESERIES_ID" \
  --data-urlencode "connector_id=$CONNECTOR_ID" \
  --data-urlencode "pollutant=$POLLUTANT" \
  --data-urlencode "start_utc=$START_UTC" \
  --data-urlencode "end_utc=$END_UTC" \
  --data-urlencode 'format=objects' \
  --data-urlencode 'include_observations=true' \
  --data-urlencode 'include_aqi=false' \
  --data-urlencode 'cache=bypass')" \
  || fail "live cache-bypassed station-series request failed at the HTTP transport layer"

if [ "$HTTP_STATUS" != "200" ]; then
  printf '%s\n' '--- response headers ---' >&2
  sed -n '1,80p' "$HEADERS_FILE" >&2
  printf '%s\n' '--- response body ---' >&2
  head -c 4000 "$BODY_FILE" >&2 || true
  printf '\n' >&2
  fail "live station-series probe returned HTTP $HTTP_STATUS instead of 200"
fi

CACHE_STATUS="$(read_http_header 'X-UK-AQ-Cache' "$HEADERS_FILE")"
STATION_ROUTE="$(read_http_header 'X-UK-AQ-Station-History-Route' "$HEADERS_FILE")"
STATION_CONTRACT="$(read_http_header 'X-UK-AQ-Station-History-Contract' "$HEADERS_FILE")"
[ "$CACHE_STATUS" = "BYPASS" ] || fail "live station-series probe was not cache-bypassed (X-UK-AQ-Cache=$CACHE_STATUS)"
[ "$STATION_ROUTE" = "/v1/station-series" ] || fail "live request did not traverse the station-history service route"
[ "$STATION_CONTRACT" = "v2" ] || fail "station-history response contract header is not v2"

jq -e \
  --argjson timeseries "$TIMESERIES_ID" \
  --argjson connector "$CONNECTOR_ID" \
  --arg pollutant "$POLLUTANT" '
    (.request.timeseries_id == $timeseries) and
    (.request.connector_id == $connector) and
    (.request.pollutant == $pollutant) and
    (.observations.enabled == true) and
    ((.observations.rows // []) | length > 0) and
    (
      ((.observations.source_counts.r2 // 0) > 0) or
      ([.observations.rows[]? | select(.source == "r2")] | length > 0)
    )
  ' "$BODY_FILE" >/dev/null \
  || {
    printf '%s\n' '--- response summary ---' >&2
    jq '{request,source,observations:{enabled:.observations.enabled,state:.observations.state,row_count:((.observations.rows // [])|length),source_counts:.observations.source_counts,partial_reasons:.observations.partial_reasons}}' "$BODY_FILE" >&2 || true
    fail "live station-series response did not prove historical R2 observations for the selected v3 identity"
  }

R2_ROW_COUNT="$(jq '[.observations.rows[]? | select(.source == "r2")] | length' "$BODY_FILE")"
if [ "$R2_ROW_COUNT" -eq 0 ]; then
  R2_ROW_COUNT="$(jq -r '.observations.source_counts.r2 // 0' "$BODY_FILE")"
fi
pass "routing/data smoke: cache BYPASS traversed /v1/station-series and returned historical R2 rows (r2_rows=$R2_ROW_COUNT)"
warn "cache BYPASS does not prove that the inner observations Worker performed a fresh cache MISS or fresh ranged R2 read"

node --input-type=module - <<'NODE' || fail "migration lock context is no longer held"
import fs from "node:fs";
import { createSideBySideLockAssertion } from "./scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs";
const report = JSON.parse(fs.readFileSync(process.env.PLAN_REPORT, "utf8"));
createSideBySideLockAssertion({ env: process.env, migrationRunId: report.result.migration_run_id })();
NODE

printf '\nDEPLOYED-PATH VERIFY PASS: exact v3 dependency generation and deployed routing/data smoke both passed.\n'
printf 'MIGRATION LOCK REMAINS REQUIRED UNTIL THE OPERATOR ACCEPTS READ-SIDE CUT-OVER.\n'
