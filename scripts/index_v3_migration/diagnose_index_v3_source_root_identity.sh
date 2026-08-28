#!/bin/bash
set -euo pipefail

# Read-only diagnostic for Phase 6 observation-history source-root identity drift.
# Compares the source-root identity pinned by the migration plan and final
# verification report with the source-root object currently stored in R2.
#
# Exit status:
#   0 = exact identity match OR semantic content_hash match with byte-level drift
#   2 = canonical content_hash drift
#   1 = diagnostic/configuration failure

usage() {
  cat <<'EOF'
Usage:
  diagnose_index_v3_source_root_identity.sh \
    --plan-report PATH \
    --verify-report PATH

Required loaded environment:
  CFLARE_R2_ENDPOINT
  CFLARE_R2_BUCKET
  CFLARE_R2_ACCESS_KEY_ID
  CFLARE_R2_SECRET_ACCESS_KEY

Optional:
  CFLARE_R2_REGION (defaults to auto)

This script is strictly read-only. It performs one R2 GET and does not modify
R2, D1, GitHub, maintenance state, schedulers, Workers, or migration evidence.
EOF
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

PLAN_REPORT=""
VERIFY_REPORT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan-report) PLAN_REPORT="${2:-}"; shift 2 ;;
    --verify-report) VERIFY_REPORT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[ -n "$PLAN_REPORT" ] || fail "--plan-report is required"
[ -n "$VERIFY_REPORT" ] || fail "--verify-report is required"
[ -f "$PLAN_REPORT" ] || fail "plan report not found: $PLAN_REPORT"
[ -f "$VERIFY_REPORT" ] || fail "verify report not found: $VERIFY_REPORT"

for command in git jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

for name in \
  CFLARE_R2_ENDPOINT \
  CFLARE_R2_BUCKET \
  CFLARE_R2_ACCESS_KEY_ID \
  CFLARE_R2_SECRET_ACCESS_KEY
do
  [ -n "${!name:-}" ] || fail "required loaded environment value is missing: $name"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "repository root cannot be derived from Git"
cd -- "$REPO_ROOT"

jq empty "$PLAN_REPORT" >/dev/null 2>&1 || fail "plan report is not valid JSON"
jq empty "$VERIFY_REPORT" >/dev/null 2>&1 || fail "verify report is not valid JSON"

SOURCE_KEY="$(jq -r '.result.source_root.key // empty' "$PLAN_REPORT")"
PLAN_SOURCE_SHA="$(jq -r '.result.source_root.sha256 // empty' "$PLAN_REPORT")"
PLAN_CONTENT_HASH="$(jq -r '.result.source_root.content_hash // empty' "$PLAN_REPORT")"
VERIFY_SOURCE_SHA="$(jq -r '.audit.pre_state_identities.observation_root.sha256 // empty' "$VERIFY_REPORT")"
VERIFY_CONTENT_HASH="$(jq -r '.audit.pre_state_identities.observation_root.content_hash // empty' "$VERIFY_REPORT")"

[ -n "$SOURCE_KEY" ] || fail "plan source-root key is missing"
for identity in "$PLAN_SOURCE_SHA" "$PLAN_CONTENT_HASH" "$VERIFY_SOURCE_SHA" "$VERIFY_CONTENT_HASH"; do
  printf '%s' "$identity" | grep -Eq '^[0-9a-f]{64}$' \
    || fail "plan/verify source-root identity is malformed"
done

export SOURCE_KEY PLAN_SOURCE_SHA PLAN_CONTENT_HASH VERIFY_SOURCE_SHA VERIFY_CONTENT_HASH
export CFLARE_R2_REGION="${CFLARE_R2_REGION:-auto}"

printf '%s\n' '============================================================'
printf '%s\n' 'UK AQ INDEX V3 SOURCE-ROOT IDENTITY DIAGNOSTIC'
printf 'Repository root: %s\n' "$REPO_ROOT"
printf 'R2 bucket: %s\n' "$CFLARE_R2_BUCKET"
printf 'Source key: %s\n' "$SOURCE_KEY"
printf '%s\n\n' 'READ-ONLY: ONE R2 GET; NO MUTATION IS PERFORMED'

node --input-type=module <<'NODE'
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
const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);
const currentSha = crypto.createHash("sha256").update(body).digest("hex");

let current;
try {
  current = JSON.parse(body.toString("utf8"));
} catch (error) {
  throw new Error("Current R2 source root is not valid JSON", { cause: error });
}

const currentContentHash = typeof current?.content_hash === "string"
  ? current.content_hash
  : null;

const matches = {
  plan_sha: currentSha === process.env.PLAN_SOURCE_SHA,
  plan_content_hash: currentContentHash === process.env.PLAN_CONTENT_HASH,
  verify_sha: currentSha === process.env.VERIFY_SOURCE_SHA,
  verify_content_hash: currentContentHash === process.env.VERIFY_CONTENT_HASH,
  plan_verify_sha: process.env.PLAN_SOURCE_SHA === process.env.VERIFY_SOURCE_SHA,
  plan_verify_content_hash: process.env.PLAN_CONTENT_HASH === process.env.VERIFY_CONTENT_HASH,
};

let classification;
if (
  matches.plan_sha &&
  matches.plan_content_hash &&
  matches.verify_sha &&
  matches.verify_content_hash
) {
  classification = "exact_identity_match";
} else if (matches.plan_content_hash && matches.verify_content_hash) {
  classification = "semantic_content_match_root_bytes_changed";
} else {
  classification = "canonical_content_drift";
}

const output = {
  classification,
  key: process.env.SOURCE_KEY,
  plan: {
    sha256: process.env.PLAN_SOURCE_SHA,
    content_hash: process.env.PLAN_CONTENT_HASH,
  },
  final_verify: {
    sha256: process.env.VERIFY_SOURCE_SHA,
    content_hash: process.env.VERIFY_CONTENT_HASH,
  },
  current: {
    sha256: currentSha,
    content_hash: currentContentHash,
    byte_size: body.length,
  },
  matches,
  current_root: current,
};

console.log(JSON.stringify(output, null, 2));
console.log();
if (classification === "exact_identity_match") {
  console.log("DIAGNOSIS: current R2 source root exactly matches the pinned plan and final verification.");
} else if (classification === "semantic_content_match_root_bytes_changed") {
  console.log("DIAGNOSIS: canonical content_hash is unchanged; only source-root bytes/metadata changed.");
} else {
  console.log("DIAGNOSIS: canonical content_hash changed; the migrated v3 snapshot is not current with the pinned source root.");
  process.exitCode = 2;
}
NODE
