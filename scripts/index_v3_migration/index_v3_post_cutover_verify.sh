#!/bin/bash
set -euo pipefail

# Read-only post-cutover verification for the observation-history index-v3 switch.
#
# This is intentionally stricter than a deployment-status check. It verifies:
# - persistent GitHub authority is v3;
# - the latest cache deployment resolved STATION_HISTORY to the derived v3 candidate;
# - maintenance remains ON and migration-sensitive scheduler jobs remain frozen;
# - the canonical R2 source root still matches immutable post-migration recovery evidence;
# - a real cache-bypassed station-series request returns historical R2 rows through
#   the deployed cache -> STATION_HISTORY service-binding path.
#
# It is read-only. It never changes GitHub variables, deployments, D1, R2,
# maintenance state, scheduler state, cache contents, or migration evidence.

usage() {
  cat <<'EOF'
Usage:
  index_v3_post_cutover_verify.sh \
    --plan-report PATH \
    --checkpoint PATH \
    --site-url URL \
    --cache-url URL

Required environment already used by the migration tooling:
  UKAQ_ENV_NAME
  CFLARE_R2_ENDPOINT
  CFLARE_R2_BUCKET
  CFLARE_R2_ACCESS_KEY_ID
  CFLARE_R2_SECRET_ACCESS_KEY
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN

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
  printf 'POST-CUTOVER VERIFICATION FAILED. KEEP MAINTENANCE ON AND WRITERS FROZEN.\n' >&2
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

PLAN_REPORT=""
CHECKPOINT=""
SITE_URL=""
CACHE_URL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan-report) PLAN_REPORT="${2:-}"; shift 2 ;;
    --checkpoint) CHECKPOINT="${2:-}"; shift 2 ;;
    --site-url) SITE_URL="${2:-}"; shift 2 ;;
    --cache-url) CACHE_URL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[ -n "$PLAN_REPORT" ] || fail "--plan-report is required"
[ -n "$CHECKPOINT" ] || fail "--checkpoint is required"
[ -n "$SITE_URL" ] || fail "--site-url is required"
[ -n "$CACHE_URL" ] || fail "--cache-url is required"

for command in git gh jq node curl shasum npx; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "repository root cannot be derived from Git"
cd -- "$REPO_ROOT"

[ -f "$PLAN_REPORT" ] || fail "migration plan report is missing: $PLAN_REPORT"
jq empty "$PLAN_REPORT" >/dev/null 2>&1 || fail "migration plan report is invalid JSON"
[ -f "$CHECKPOINT" ] || fail "migration checkpoint is missing: $CHECKPOINT"

for name in \
  UKAQ_ENV_NAME \
  CFLARE_R2_ENDPOINT \
  CFLARE_R2_BUCKET \
  CFLARE_R2_ACCESS_KEY_ID \
  CFLARE_R2_SECRET_ACCESS_KEY \
  CLOUDFLARE_ACCOUNT_ID \
  CLOUDFLARE_API_TOKEN \
  UK_AQ_CACHE_BYPASS_SECRET
do
  require_env "$name"
done

ENVIRONMENT="$(printf '%s' "$UKAQ_ENV_NAME" | tr '[:lower:]' '[:upper:]')"
case "$ENVIRONMENT" in TEST|LIVE) ;; *) fail "UKAQ_ENV_NAME must identify TEST or LIVE" ;; esac

REPO_JSON="$(gh repo view --json nameWithOwner,defaultBranchRef 2>/dev/null)" \
  || fail "GitHub repository identity could not be read"
REPO_SLUG="$(printf '%s' "$REPO_JSON" | jq -r '.nameWithOwner // empty')"
DEFAULT_BRANCH="$(printf '%s' "$REPO_JSON" | jq -r '.defaultBranchRef.name // empty')"
CURRENT_BRANCH="$(git branch --show-current)"
[ -n "$REPO_SLUG" ] || fail "GitHub repository slug is empty"
[ -n "$DEFAULT_BRANCH" ] || fail "GitHub default branch is empty"
[ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] \
  || fail "current branch $CURRENT_BRANCH is not GitHub default branch $DEFAULT_BRANCH"
if [ -n "$(git status --short)" ]; then
  git status --short >&2
  fail "working tree is not clean"
fi

printf '%s\n' '============================================================'
printf 'UK AQ INDEX V3 POST-CUTOVER VERIFY: %s\n' "$ENVIRONMENT"
printf 'Repository: %s / %s\n' "$REPO_SLUG" "$CURRENT_BRANCH"
printf 'Site URL: %s\n' "${SITE_URL%/}"
printf 'Cache URL: %s\n' "${CACHE_URL%/}"
printf '%s\n\n' 'READ-ONLY: NO CONFIGURATION OR DATA MUTATION IS PERFORMED'

GH_ENV="$(gh variable get UKAQ_ENV_NAME --repo "$REPO_SLUG" 2>/dev/null | tr '[:lower:]' '[:upper:]')" \
  || fail "GitHub UKAQ_ENV_NAME could not be read"
[ "$GH_ENV" = "$ENVIRONMENT" ] || fail "GitHub environment does not match loaded $ENVIRONMENT"

INDEX_AUTHORITY="$(gh variable get UK_AQ_R2_HISTORY_INDEX_VERSION --repo "$REPO_SLUG" 2>/dev/null)" \
  || fail "GitHub UK_AQ_R2_HISTORY_INDEX_VERSION could not be read"
[ "$INDEX_AUTHORITY" = "v3" ] || fail "persistent index authority is not v3: $INDEX_AUTHORITY"
pass "persistent GitHub observation-history index authority is v3"

STABLE_STATION_WORKER="$(gh variable get UK_AQ_STATION_HISTORY_WORKER_NAME --repo "$REPO_SLUG" 2>/dev/null)" \
  || fail "GitHub UK_AQ_STATION_HISTORY_WORKER_NAME could not be read"
case "$STABLE_STATION_WORKER" in
  ''|*[!a-z0-9-]*|-*|*-|*-v3-candidate)
    fail "stable station-history Worker identity is invalid: $STABLE_STATION_WORKER"
    ;;
esac
STATION_CANDIDATE="${STABLE_STATION_WORKER}-v3-candidate"
[ "${#STATION_CANDIDATE}" -le 63 ] || fail "derived v3 station-history candidate name is too long"
RESOLVED_LOCAL="$(bash workers/uk_aq_cache_proxy/resolve_station_history_service.sh \
  "$STABLE_STATION_WORKER" v3 '')" \
  || fail "local cache binding resolver rejected v3 authority"
[ "$RESOLVED_LOCAL" = "$STATION_CANDIDATE" ] \
  || fail "local resolver did not derive the expected v3 station-history candidate"
pass "v3 authority deterministically resolves STATION_HISTORY to $STATION_CANDIDATE"

LATEST_CACHE_RUN="$(gh run list \
  --repo "$REPO_SLUG" \
  --workflow uk_aq_cache_proxy_deploy.yml \
  --limit 1 \
  --json databaseId,status,conclusion,headSha,url 2>/dev/null | jq '.[0] // null')" \
  || fail "latest cache deployment workflow could not be read"
[ "$LATEST_CACHE_RUN" != "null" ] || fail "no cache deployment workflow run was found"
printf '%s' "$LATEST_CACHE_RUN" | jq -e '.status == "completed" and .conclusion == "success"' >/dev/null \
  || fail "latest cache deployment is not a completed success"
CACHE_RUN_ID="$(printf '%s' "$LATEST_CACHE_RUN" | jq -r '.databaseId')"
CACHE_RUN_LOG="$(gh run view "$CACHE_RUN_ID" --repo "$REPO_SLUG" --log 2>/dev/null)" \
  || fail "latest cache deployment log could not be read"
printf '%s\n' "$CACHE_RUN_LOG" | grep -Fq \
  "Resolved STATION_HISTORY Service Binding target: $STATION_CANDIDATE" \
  || fail "latest cache deployment did not resolve STATION_HISTORY to $STATION_CANDIDATE"
printf '%s\n' "$CACHE_RUN_LOG" | grep -Fq 'Persistent observation-history authority: v3' \
  || fail "latest cache deployment log does not report persistent v3 authority"
pass "latest successful cache deployment explicitly bound STATION_HISTORY to the v3 candidate"

LOCAL_DEV_BYPASS="$(gh variable get UK_AQ_LOCAL_DEV_BYPASS_ENABLED --repo "$REPO_SLUG" 2>/dev/null || true)"
is_true "$LOCAL_DEV_BYPASS" \
  || fail "UK_AQ_LOCAL_DEV_BYPASS_ENABLED is not enabled; non-interactive TEST live probe cannot safely bypass session/origin checks"
pass "TEST local-dev bypass is enabled for the non-interactive live probe"

SITE_URL="${SITE_URL%/}"
CACHE_URL="${CACHE_URL%/}"
CACHE_BUSTER="$(date -u +%s)-$$"
SITE_MODE="$(curl -fsSL \
  -H 'Cache-Control: no-cache, no-store' \
  -H 'Pragma: no-cache' \
  "$SITE_URL/uk-aq-site-mode.json?post_cutover_check=$CACHE_BUSTER")" \
  || fail "public maintenance status could not be read"
printf '%s' "$SITE_MODE" | jq -e '
  .schema_version == 1 and
  .mode == "on" and
  (.deployment_id | type == "string" and length > 0)
' >/dev/null || fail "public site maintenance mode is not positively ON"
pass "public TEST site remains in maintenance mode"

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
  [.. | objects | select(has("job_key") and has("enabled")) | {job_key, enabled}]
  | unique_by(.job_key) | sort_by(.job_key)
  == [
    {"job_key":"uk_aq_prune_daily","enabled":0},
    {"job_key":"uk_aq_r2_history_dropbox_backup","enabled":0},
    {"job_key":"uk_aq_r2_history_dropbox_backup_force_prune_recheck","enabled":0}
  ]
' >/dev/null || fail "migration-sensitive scheduler jobs are not exactly the three required disabled rows"
pass "all migration-sensitive scheduler jobs remain frozen"

SOURCE_KEY="$(jq -r '.result.source_root.key // empty' "$PLAN_REPORT")"
[ -n "$SOURCE_KEY" ] || fail "migration plan source-root key is missing"
RECOVERY_ROOT="$CHECKPOINT.recovery"
RECOVERY_HEAD="$RECOVERY_ROOT/head.json"
RECOVERY_HELPER="$SCRIPT_DIR/recovery_post_migration_root_evidence.mjs"
[ -f "$RECOVERY_HEAD" ] || fail "recovery journal head is missing: $RECOVERY_HEAD"
[ -f "$RECOVERY_HELPER" ] || fail "post-migration recovery-root helper is missing"
CHECKPOINT_SHA="$(shasum -a 256 "$CHECKPOINT" | awk '{print $1}')"
IMMUTABLE_AUTHORITY_SHA="$(jq -r '.payload.immutable_authority_sha256 // empty' "$RECOVERY_HEAD")"
printf '%s' "$IMMUTABLE_AUTHORITY_SHA" | grep -Eq '^[0-9a-f]{64}$' \
  || fail "immutable recovery authority SHA is invalid"
POST_ROOT_EVIDENCE="$(node "$RECOVERY_HELPER" \
  --recovery-root "$RECOVERY_ROOT" \
  --source-key "$SOURCE_KEY" \
  --expected-checkpoint-sha256 "$CHECKPOINT_SHA" \
  --expected-authority-sha256 "$IMMUTABLE_AUTHORITY_SHA")" \
  || fail "post-migration canonical source-root evidence could not be derived"
POST_SOURCE_SHA="$(printf '%s' "$POST_ROOT_EVIDENCE" | jq -r '.sha256 // empty')"
POST_SOURCE_BYTES="$(printf '%s' "$POST_ROOT_EVIDENCE" | jq -r '.byte_size // empty')"
export SOURCE_KEY POST_SOURCE_SHA POST_SOURCE_BYTES
node --input-type=module <<'NODE' \
  || fail "current R2 canonical source root differs from the immutable post-migration identity"
import crypto from "node:crypto";
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";

const r2 = {
  endpoint: process.env.CFLARE_R2_ENDPOINT,
  bucket: process.env.CFLARE_R2_BUCKET,
  region: process.env.CFLARE_R2_REGION || "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};
const result = await r2GetObject({ r2, key: process.env.SOURCE_KEY });
const bytes = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);
const sha = crypto.createHash("sha256").update(bytes).digest("hex");
if (sha !== process.env.POST_SOURCE_SHA) throw new Error("post-migration root SHA mismatch");
if (bytes.byteLength !== Number(process.env.POST_SOURCE_BYTES)) throw new Error("post-migration root byte-size mismatch");
NODE
pass "current canonical R2 source root still matches immutable post-migration recovery evidence"

PROBE_JSON="$(node --input-type=module <<'NODE'
import crypto from "node:crypto";
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";
import { validateObservationHistoryIndexV3ScopedManifestBody } from "./workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs";

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
    const validated = validateObservationHistoryIndexV3ScopedManifestBody({ key, body });
    if (!supportedPollutants.has(validated.scope.pollutant_code)) {
      throw new Error(`selected scoped root is not station-series compatible: ${key}`);
    }
    const ids = validated.coverage?.timeseries_ids || [];
    if (ids.length > 0 && Number(validated.coverage?.row_count || 0) > 0) {
      const dayUtc = validated.scope.day_utc;
      const start = new Date(`${dayUtc}T00:00:00.000Z`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      selected = {
        latest_key: latestKey,
        latest_max_day_utc: latest.max_day_utc,
        scoped_manifest_key: key,
        day_utc: dayUtc,
        timeseries_id: ids[0],
        connector_id: validated.scope.connector_id,
        pollutant: validated.scope.pollutant_code,
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

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/uk-aq-index-v3-post-cutover.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
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

CACHE_STATUS="$(awk 'BEGIN{IGNORECASE=1} /^X-UK-AQ-Cache:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$HEADERS_FILE")"
STATION_ROUTE="$(awk 'BEGIN{IGNORECASE=1} /^X-UK-AQ-Station-History-Route:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$HEADERS_FILE")"
STATION_CONTRACT="$(awk 'BEGIN{IGNORECASE=1} /^X-UK-AQ-Station-History-Contract:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$HEADERS_FILE")"
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
pass "live cache BYPASS traversed /v1/station-series and returned historical R2 rows (r2_rows=$R2_ROW_COUNT)"

printf '\nPOST-CUTOVER VERIFY PASS: deployed cache -> v3 station-history path is healthy.\n'
printf 'KEEP MAINTENANCE ON AND WRITERS FROZEN UNTIL THE OPERATOR EXPLICITLY RESUMES THEM.\n'
