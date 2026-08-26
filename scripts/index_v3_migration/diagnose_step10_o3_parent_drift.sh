#!/bin/bash
set -euo pipefail

# UK AQ Phase 6 Step 10 recovery diagnostic
# TEST ONLY
#
# Purpose:
#   Diagnose:
#     "Pinned source parent manifest identity changed: 2025-02-03|1|o3"
#
# Safety:
#   - READ-ONLY against TEST R2 (GET only)
#   - READ-ONLY against Dropbox backup
#   - DOES NOT acquire the PostgreSQL operation lock
#   - DOES NOT touch the Step 10 recovery sidecar
#   - DOES NOT modify the preserved checkpoint or staging evidence
#   - Writes local diagnostic output only

EXPECTED_REPO_ROOT="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops"
CHECKPOINT="/Users/mikehinford/uk-aq-work/index_v3_migration/step10/migration_checkpoint.json"
RECOVERY_ROOT="${CHECKPOINT}.recovery"
DIAG="/Users/mikehinford/uk-aq-work/index_v3_migration/diagnostics/o3_parent_20250203"
DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/TEST/R2_history_backup"
REPO="TEST-uk-aq/uk-aq-ops"

DAY_UTC="2025-02-03"
CONNECTOR_ID="1"
POLLUTANT_CODE="o3"

stop() {
  echo "STOP: $*" >&2
  exit 1
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

SCRIPT_DIR="$(pwd -P)"
if [ "$SCRIPT_DIR" != "$EXPECTED_REPO_ROOT" ]; then
  stop "run this script from the TEST Ops repository root:
$EXPECTED_REPO_ROOT"
fi

if [ ! -f "$CHECKPOINT" ]; then
  stop "preserved Step 10 checkpoint is missing: $CHECKPOINT"
fi

if [ ! -d "$RECOVERY_ROOT" ]; then
  stop "active recovery generation is missing: $RECOVERY_ROOT"
fi

if ps ax -o command= | grep -E '[r]un_step10_resume|[u]k_aq_observation_history_migration_v3|[u]k_aq_with_observations_global_operation_lock' >/dev/null; then
  stop "a Step 10 recovery/migration process appears to be running"
fi

: "${CFLARE_R2_ACCESS_KEY_ID:?STOP: CFLARE_R2_ACCESS_KEY_ID is not set}"
: "${CFLARE_R2_SECRET_ACCESS_KEY:?STOP: CFLARE_R2_SECRET_ACCESS_KEY is not set}"

R2_BUCKET="$(gh variable get CFLARE_R2_BUCKET --repo "$REPO")"
R2_ENDPOINT="$(gh variable get CFLARE_R2_ENDPOINT --repo "$REPO")"

[ "$R2_BUCKET" = "uk-aq-history-cic-test" ] ||
  stop "unexpected TEST R2 bucket: $R2_BUCKET"
[ -n "$R2_ENDPOINT" ] ||
  stop "TEST R2 endpoint is empty"

mkdir -p "$DIAG"

export CHECKPOINT DIAG R2_BUCKET R2_ENDPOINT DAY_UTC CONNECTOR_ID POLLUTANT_CODE

echo "============================================================"
echo "UK AQ Step 10 O3 parent-manifest diagnostic"
echo "TEST ONLY / READ-ONLY EXTERNAL ACCESS"
echo "============================================================"
echo
echo "Scope: ${DAY_UTC} | connector ${CONNECTOR_ID} | ${POLLUTANT_CODE}"
echo "Checkpoint: $CHECKPOINT"
echo "Recovery generation: $RECOVERY_ROOT"
echo "Diagnostic output: $DIAG"
echo

echo "Extracting pinned authority from immutable checkpoint..."

node --max-old-space-size=4096 --input-type=module <<'NODE'
import fs from "node:fs";
import {
  buildObservationHistoryV3MigrationPlanFromCheckpoint,
} from "./scripts/backup_r2/lib/observation_history_migration_v3.mjs";

const checkpoint = JSON.parse(fs.readFileSync(process.env.CHECKPOINT, "utf8"));
const plan = buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint });

const partition = plan.inventory.partitions.find((entry) =>
  entry.scope?.day_utc === process.env.DAY_UTC &&
  Number(entry.scope?.connector_id) === Number(process.env.CONNECTOR_ID) &&
  entry.scope?.pollutant_code === process.env.POLLUTANT_CODE
);

if (!partition) {
  throw new Error(
    `Pinned partition not found: ${process.env.DAY_UTC}|${process.env.CONNECTOR_ID}|${process.env.POLLUTANT_CODE}`
  );
}

const ref = partition.source_manifest_reference;
if (!ref) throw new Error("Pinned source_manifest_reference is missing");

const out = {
  scope: partition.scope,
  unit_id: plan.units.find((unit) =>
    unit.source_manifest_identity?.key === partition.manifest_identity?.key &&
    unit.source_manifest_identity?.sha256 === partition.manifest_identity?.sha256
  )?.unit_id ?? null,
  partition_manifest_identity: partition.manifest_identity,
  parent_identity: ref.parent_manifest_identity,
  parent_manifest_hash: ref.parent_manifest_hash,
  child_identity: ref.current_child_manifest_identity,
  child_manifest_hash: ref.current_child_manifest_hash,
  referenced_child_manifest_hash: ref.referenced_child_manifest_hash,
  provenance: ref.provenance,
  compatibility_contract_version: ref.compatibility_contract_version,
};

fs.writeFileSync(
  `${process.env.DIAG}/pinned.json`,
  JSON.stringify(out, null, 2) + "\n"
);

console.log(JSON.stringify(out, null, 2));
NODE

echo
echo "Reading exact parent and O3 child objects from current TEST R2 (GET only)..."

node --input-type=module <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";
import { r2GetObject } from "./workers/shared/r2_sigv4.mjs";

const pinned = JSON.parse(fs.readFileSync(`${process.env.DIAG}/pinned.json`, "utf8"));

const r2 = {
  endpoint: process.env.R2_ENDPOINT,
  bucket: process.env.R2_BUCKET,
  region: "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};

function bufferFromResult(result, key) {
  const value = result?.body;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`R2 GET returned no readable body: ${key}`);
}

function identity(key, body) {
  return {
    key,
    byte_size: body.byteLength,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
  };
}

async function read(key) {
  const result = await r2GetObject({ r2, key });
  const body = bufferFromResult(result, key);
  return {
    body,
    identity: identity(key, body),
    json: JSON.parse(body.toString("utf8")),
  };
}

const parent = await read(pinned.parent_identity.key);
const child = await read(pinned.child_identity.key);

fs.writeFileSync(`${process.env.DIAG}/current_parent.json`, parent.body);
fs.writeFileSync(`${process.env.DIAG}/current_o3_child.json`, child.body);

const currentO3References = (parent.json.pollutant_manifests || []).filter((entry) =>
  entry?.pollutant_code === process.env.POLLUTANT_CODE
);

const report = {
  scope: pinned.scope,
  parent: {
    pinned_identity: pinned.parent_identity,
    current_identity: parent.identity,
    identity_matches:
      pinned.parent_identity.byte_size === parent.identity.byte_size &&
      pinned.parent_identity.sha256 === parent.identity.sha256,
    pinned_manifest_hash: pinned.parent_manifest_hash,
    current_manifest_hash: parent.json.manifest_hash ?? null,
    current_o3_reference_count: currentO3References.length,
    current_o3_references: currentO3References,
  },
  child: {
    pinned_identity: pinned.child_identity,
    current_identity: child.identity,
    identity_matches:
      pinned.child_identity.byte_size === child.identity.byte_size &&
      pinned.child_identity.sha256 === child.identity.sha256,
    pinned_manifest_hash: pinned.child_manifest_hash,
    current_manifest_hash: child.json.manifest_hash ?? null,
  },
};

fs.writeFileSync(
  `${process.env.DIAG}/current_identity.json`,
  JSON.stringify(report, null, 2) + "\n"
);

console.log(JSON.stringify(report, null, 2));
NODE

echo
echo "Searching locked Dropbox backup for matching parent/child paths..."

PARENT_KEY="$(jq -r '.parent_identity.key' "$DIAG/pinned.json")"
CHILD_KEY="$(jq -r '.child_identity.key' "$DIAG/pinned.json")"

: > "$DIAG/dropbox_candidates.tsv"

while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  printf '%s\t%s\t%s\n' \
    "$(stat -f '%z' "$candidate")" \
    "$(sha256_file "$candidate")" \
    "$candidate" >> "$DIAG/dropbox_candidates.tsv"
done < <(
  find "$DROPBOX_ROOT" -type f \
    \( -path "*/$PARENT_KEY" -o -path "*/$CHILD_KEY" \) \
    -print 2>/dev/null
)

echo
echo "============================================================"
echo "SUMMARY"
echo "============================================================"

jq '{
  scope,
  parent: {
    pinned_identity: .parent.pinned_identity,
    current_identity: .parent.current_identity,
    identity_matches: .parent.identity_matches,
    pinned_manifest_hash: .parent.pinned_manifest_hash,
    current_manifest_hash: .parent.current_manifest_hash,
    current_o3_reference_count: .parent.current_o3_reference_count,
    current_o3_references: .parent.current_o3_references
  },
  child: {
    pinned_identity: .child.pinned_identity,
    current_identity: .child.current_identity,
    identity_matches: .child.identity_matches,
    pinned_manifest_hash: .child.pinned_manifest_hash,
    current_manifest_hash: .child.current_manifest_hash
  }
}' "$DIAG/current_identity.json"

echo
echo "=== DROPBOX CANDIDATES: bytes  sha256  path ==="
if [ -s "$DIAG/dropbox_candidates.tsv" ]; then
  cat "$DIAG/dropbox_candidates.tsv"
else
  echo "No matching Dropbox backup files found by canonical path."
fi

echo
echo "=== LOCAL DIAGNOSTIC FILES ==="
ls -lh \
  "$DIAG/pinned.json" \
  "$DIAG/current_identity.json" \
  "$DIAG/current_parent.json" \
  "$DIAG/current_o3_child.json" \
  "$DIAG/dropbox_candidates.tsv"

echo
echo "Diagnostic complete."
echo "No R2 write, lock acquisition, checkpoint change, staging change, or recovery-sidecar change was performed."
