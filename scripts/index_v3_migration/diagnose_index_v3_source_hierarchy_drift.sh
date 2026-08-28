#!/bin/bash
set -euo pipefail

# Read-only diagnostic for Phase 6 observation-history source hierarchy drift.
# Compares the pinned Dropbox copy of the v2 observation manifest hierarchy
# with the hierarchy currently stored in R2 and reports changed years, months
# and day-manifest identities.

usage() {
  cat <<'EOF'
Usage:
  diagnose_index_v3_source_hierarchy_drift.sh \
    --plan-report PATH \
    --dropbox-root PATH

Required loaded environment:
  CFLARE_R2_ENDPOINT
  CFLARE_R2_BUCKET
  CFLARE_R2_ACCESS_KEY_ID
  CFLARE_R2_SECRET_ACCESS_KEY

Optional:
  CFLARE_R2_REGION (defaults to auto)

This script is strictly read-only. It reads the pinned local Dropbox hierarchy
and performs R2 GETs only for aggregate branches whose hashes differ. It does
not modify R2, D1, GitHub, maintenance state, schedulers, Workers, Dropbox, or
migration evidence.
EOF
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

PLAN_REPORT=""
DROPBOX_ROOT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan-report) PLAN_REPORT="${2:-}"; shift 2 ;;
    --dropbox-root) DROPBOX_ROOT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[ -n "$PLAN_REPORT" ] || fail "--plan-report is required"
[ -n "$DROPBOX_ROOT" ] || fail "--dropbox-root is required"
[ -f "$PLAN_REPORT" ] || fail "plan report not found: $PLAN_REPORT"
[ -d "$DROPBOX_ROOT" ] || fail "Dropbox backup root not found: $DROPBOX_ROOT"

for command in git jq node shasum; do
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

SOURCE_KEY="$(jq -r '.result.source_root.key // empty' "$PLAN_REPORT")"
PLAN_SOURCE_SHA="$(jq -r '.result.source_root.sha256 // empty' "$PLAN_REPORT")"
PLAN_CONTENT_HASH="$(jq -r '.result.source_root.content_hash // empty' "$PLAN_REPORT")"

[ -n "$SOURCE_KEY" ] || fail "plan source-root key is missing"
for identity in "$PLAN_SOURCE_SHA" "$PLAN_CONTENT_HASH"; do
  printf '%s' "$identity" | grep -Eq '^[0-9a-f]{64}$' \
    || fail "plan source-root identity is malformed"
done

PINNED_ROOT="$DROPBOX_ROOT/${SOURCE_KEY#/}"
[ -f "$PINNED_ROOT" ] || fail "pinned Dropbox source root not found: $PINNED_ROOT"
PINNED_SHA="$(shasum -a 256 "$PINNED_ROOT" | awk '{print $1}')"
[ "$PINNED_SHA" = "$PLAN_SOURCE_SHA" ] \
  || fail "Dropbox source root SHA does not match the migration plan"
PINNED_CONTENT_HASH="$(jq -r '.content_hash // empty' "$PINNED_ROOT")"
[ "$PINNED_CONTENT_HASH" = "$PLAN_CONTENT_HASH" ] \
  || fail "Dropbox source root content_hash does not match the migration plan"

export SOURCE_KEY PLAN_SOURCE_SHA PLAN_CONTENT_HASH DROPBOX_ROOT
export CFLARE_R2_REGION="${CFLARE_R2_REGION:-auto}"

printf '%s\n' '============================================================'
printf '%s\n' 'UK AQ INDEX V3 SOURCE HIERARCHY DRIFT DIAGNOSTIC'
printf 'Repository root: %s\n' "$REPO_ROOT"
printf 'R2 bucket: %s\n' "$CFLARE_R2_BUCKET"
printf 'Pinned Dropbox root: %s\n' "$DROPBOX_ROOT"
printf 'Source root key: %s\n' "$SOURCE_KEY"
printf '%s\n\n' 'READ-ONLY: LOCAL READS + SELECTIVE R2 GETS; NO MUTATION IS PERFORMED'

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";

const r2 = {
  endpoint: process.env.CFLARE_R2_ENDPOINT,
  bucket: process.env.CFLARE_R2_BUCKET,
  region: process.env.CFLARE_R2_REGION || "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};

const dropboxRoot = path.resolve(process.env.DROPBOX_ROOT);
const sourceKey = process.env.SOURCE_KEY;

function localPathForKey(key) {
  return path.join(dropboxRoot, ...String(key).replace(/^\/+/, "").split("/"));
}

function readLocalJson(key) {
  const filePath = localPathForKey(key);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Pinned Dropbox manifest is missing: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function readR2Json(key) {
  const result = await r2GetObject({ r2, key });
  return JSON.parse(Buffer.from(result.body).toString("utf8"));
}

function by(items, keyFn) {
  const map = new Map();
  for (const item of items || []) map.set(keyFn(item), item);
  return map;
}

function unionKeys(left, right, compareFn = undefined) {
  const keys = new Set([...left.keys(), ...right.keys()]);
  return [...keys].sort(compareFn);
}

function recordDiff(scope, before, after, identityField) {
  return {
    scope,
    status: before && after ? "changed" : before ? "removed" : "added",
    pinned_identity: before?.[identityField] ?? null,
    current_identity: after?.[identityField] ?? null,
  };
}

const pinnedRoot = readLocalJson(sourceKey);
const currentRoot = await readR2Json(sourceKey);

const changedYears = [];
const changedMonths = [];
const changedDays = [];
let r2GetCount = 1;

const pinnedYears = by(pinnedRoot.children, (child) => String(child.year));
const currentYears = by(currentRoot.children, (child) => String(child.year));

for (const year of unionKeys(pinnedYears, currentYears, (a, b) => Number(a) - Number(b))) {
  const beforeYearRef = pinnedYears.get(year);
  const afterYearRef = currentYears.get(year);
  if (beforeYearRef?.content_hash === afterYearRef?.content_hash) continue;

  changedYears.push(recordDiff(year, beforeYearRef, afterYearRef, "content_hash"));

  if (!beforeYearRef || !afterYearRef) continue;

  const pinnedYear = readLocalJson(beforeYearRef.manifest_key);
  const currentYear = await readR2Json(afterYearRef.manifest_key);
  r2GetCount += 1;
  const pinnedMonths = by(pinnedYear.children, (child) => String(child.month).padStart(2, "0"));
  const currentMonths = by(currentYear.children, (child) => String(child.month).padStart(2, "0"));

  for (const month of unionKeys(pinnedMonths, currentMonths)) {
    const beforeMonthRef = pinnedMonths.get(month);
    const afterMonthRef = currentMonths.get(month);
    if (beforeMonthRef?.content_hash === afterMonthRef?.content_hash) continue;

    const monthScope = `${year}-${month}`;
    changedMonths.push(recordDiff(monthScope, beforeMonthRef, afterMonthRef, "content_hash"));

    if (!beforeMonthRef || !afterMonthRef) continue;

    const pinnedMonth = readLocalJson(beforeMonthRef.manifest_key);
    const currentMonth = await readR2Json(afterMonthRef.manifest_key);
    r2GetCount += 1;
    const pinnedDays = by(pinnedMonth.children, (child) => child.day_utc);
    const currentDays = by(currentMonth.children, (child) => child.day_utc);

    for (const day of unionKeys(pinnedDays, currentDays)) {
      const beforeDay = pinnedDays.get(day);
      const afterDay = currentDays.get(day);
      if (beforeDay?.manifest_hash === afterDay?.manifest_hash) continue;
      changedDays.push(recordDiff(day, beforeDay, afterDay, "manifest_hash"));
    }
  }
}

const summary = {
  classification: changedDays.length === 0 && changedMonths.length === 0 && changedYears.length === 0
    ? "no_hierarchy_drift"
    : "hierarchy_drift",
  pinned_root_content_hash: pinnedRoot.content_hash ?? null,
  current_root_content_hash: currentRoot.content_hash ?? null,
  r2_get_count: r2GetCount,
  changed_year_count: changedYears.length,
  changed_month_count: changedMonths.length,
  changed_day_count: changedDays.length,
  changed_years: changedYears,
  changed_months: changedMonths,
  changed_days: changedDays,
};

console.log(JSON.stringify(summary, null, 2));
console.log();
if (summary.classification === "no_hierarchy_drift") {
  console.log("DIAGNOSIS: aggregate hierarchy identities match despite root-level drift; investigate serialization only.");
} else {
  console.log(`DIAGNOSIS: ${changedDays.length} day manifest(s) changed across ${changedMonths.length} month(s) and ${changedYears.length} year(s).`);
}
NODE
