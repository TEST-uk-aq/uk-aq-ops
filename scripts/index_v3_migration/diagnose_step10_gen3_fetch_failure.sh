#!/bin/bash
set -euo pipefail

# UK AQ Phase 6 Step 10 generation-3 fetch-failure diagnostic.
# TEST ONLY. Externally read-only: R2 HEAD/GET only.
#
# Replays the existing local recovery journal, identifies the first canonical
# publication object without durable checkpoint evidence, and compares the
# current TEST R2 object with the deterministic expected bytes.

EXPECTED_REPO_ROOT="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops"
CHECKPOINT="/Users/mikehinford/uk-aq-work/index_v3_migration/step10/migration_checkpoint.json"
RECOVERY_ROOT="${CHECKPOINT}.recovery"
REPO="TEST-uk-aq/uk-aq-ops"

stop() {
  echo "STOP: $*" >&2
  exit 1
}

cd "$EXPECTED_REPO_ROOT"

[ "$(pwd -P)" = "$EXPECTED_REPO_ROOT" ] ||
  stop "unexpected repository root"

[ -f "$CHECKPOINT" ] || stop "checkpoint missing"
[ -d "$RECOVERY_ROOT" ] || stop "recovery sidecar missing"

: "${CFLARE_R2_ACCESS_KEY_ID:?STOP: CFLARE_R2_ACCESS_KEY_ID is not set}"
: "${CFLARE_R2_SECRET_ACCESS_KEY:?STOP: CFLARE_R2_SECRET_ACCESS_KEY is not set}"

R2_BUCKET="$(gh variable get CFLARE_R2_BUCKET --repo "$REPO")"
R2_ENDPOINT="$(gh variable get CFLARE_R2_ENDPOINT --repo "$REPO")"

[ "$R2_BUCKET" = "uk-aq-history-cic-test" ] ||
  stop "unexpected TEST bucket: $R2_BUCKET"
[ -n "$R2_ENDPOINT" ] || stop "TEST R2 endpoint is empty"

export CHECKPOINT EXPECTED_REPO_ROOT R2_BUCKET R2_ENDPOINT

node --max-old-space-size=4096 --input-type=module <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";

import {
  buildObservationHistoryV3RecoveryProgressContext,
} from "./scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs";

import {
  buildObservationHistoryV3MigrationPlanFromCheckpoint,
} from "./scripts/backup_r2/lib/observation_history_migration_v3.mjs";

import {
  r2GetObject,
  r2HeadObject,
} from "./workers/shared/r2_sigv4.mjs";

const checkpoint = JSON.parse(
  fs.readFileSync(process.env.CHECKPOINT, "utf8"),
);

const recovery = buildObservationHistoryV3RecoveryProgressContext({
  checkpointPath: process.env.CHECKPOINT,
  checkpoint,
  repositoryRoot: process.env.EXPECTED_REPO_ROOT,
});

const recovered = recovery.checkpoint;

const plan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
  checkpoint: recovered,
  requirePrepared: true,
});

const completed = new Set(Object.keys(recovered.completed_objects || {}));
const canonical = plan.canonical_publication_objects || [];

const completedCanonical = canonical.filter((entry) => completed.has(entry.key));
const next = canonical.find((entry) => !completed.has(entry.key)) || null;
const previous = completedCanonical.at(-1) || null;

const parquetKeys = Object.keys(recovered.completed_objects || {})
  .filter((key) => key.endsWith(".parquet"));

console.log("============================================================");
console.log("STEP 10 GENERATION 3 FETCH-FAILURE DIAGNOSTIC");
console.log("TEST ONLY / R2 READ-ONLY");
console.log("============================================================");
console.log();
console.log(JSON.stringify({
  journal_sequence: recovery.sequence,
  prepared_units: Object.keys(recovered.prepared_units || {}).length,
  completed_objects: Object.keys(recovered.completed_objects || {}).length,
  completed_parquet_objects: parquetKeys.length,
  canonical_publication_objects_total: canonical.length,
  canonical_publication_objects_completed: completedCanonical.length,
  previous_completed_canonical_object: previous ? {
    key: previous.key,
    byte_size: previous.byte_size,
    sha256: previous.sha256,
  } : null,
  next_uncheckpointed_canonical_object: next ? {
    key: next.key,
    byte_size: next.byte_size,
    sha256: next.sha256,
  } : null,
}, null, 2));

if (!next) {
  console.log();
  console.log("No uncheckpointed canonical publication object remains.");
  process.exit(0);
}

const r2 = {
  endpoint: process.env.R2_ENDPOINT,
  bucket: process.env.R2_BUCKET,
  region: "auto",
  access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
};

function exactBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("R2 response body is unavailable");
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function errorSummary(error) {
  const out = {
    name: error?.name ?? typeof error,
    message: error?.message ?? String(error),
  };
  let cause = error?.cause;
  const causes = [];
  let depth = 0;
  while (cause && depth < 5) {
    causes.push({
      name: cause?.name ?? typeof cause,
      message: cause?.message ?? String(cause),
      code: cause?.code ?? null,
      errno: cause?.errno ?? null,
      syscall: cause?.syscall ?? null,
      address: cause?.address ?? null,
      port: cause?.port ?? null,
    });
    cause = cause?.cause;
    depth += 1;
  }
  if (causes.length) out.causes = causes;
  return out;
}

console.log();
console.log("=== CURRENT TEST R2 NEXT OBJECT ===");

let got = null;

for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const head = await r2HeadObject({ r2, key: next.key });
    const result = await r2GetObject({ r2, key: next.key });
    const body = exactBuffer(result.body);
    const current = {
      key: next.key,
      byte_size: body.byteLength,
      sha256: sha256(body),
    };

    let expectedJson = null;
    let currentJson = null;
    try { expectedJson = JSON.parse(exactBuffer(next.body).toString("utf8")); } catch {}
    try { currentJson = JSON.parse(body.toString("utf8")); } catch {}

    console.log(JSON.stringify({
      attempt,
      head: {
        status: head?.status ?? null,
        bytes: head?.bytes ?? head?.byte_size ?? null,
        etag: head?.etag ?? null,
        stored_sha256: head?.stored_sha256 ?? head?.sha256 ?? null,
      },
      expected: {
        key: next.key,
        byte_size: next.byte_size,
        sha256: next.sha256,
        manifest_hash: expectedJson?.manifest_hash ?? null,
        manifest_schema_version: expectedJson?.manifest_schema_version ?? null,
        writer_version: expectedJson?.writer_version ?? null,
      },
      current: {
        ...current,
        manifest_hash: currentJson?.manifest_hash ?? null,
        manifest_schema_version: currentJson?.manifest_schema_version ?? null,
        writer_version: currentJson?.writer_version ?? null,
      },
      exact_identity_matches:
        current.byte_size === next.byte_size &&
        current.sha256 === next.sha256,
    }, null, 2));
    got = true;
    break;
  } catch (error) {
    console.log(JSON.stringify({
      attempt,
      error: errorSummary(error),
    }, null, 2));
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

console.log();
if (got) {
  console.log("Diagnostic completed with a readable current TEST R2 object.");
} else {
  console.log("Diagnostic could not read the next TEST R2 object after three attempts.");
}
console.log("No R2 write operation was performed.");
NODE
