import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseIntegrityCoreSnapshotIdentity,
  validateIntegrityCoreSnapshotIdentity,
} from "../scripts/backup_r2/lib/uk_aq_integrity_core_snapshot_identity.mjs";

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function fixture(generation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-core-generation-"));
  const day = "2026-09-15";
  const manifestHash = "a".repeat(64);
  const manifestKey = `history/${generation}/core/day_utc=${day}/manifest.json`;
  const manifestBody = Buffer.from(JSON.stringify({
    day_utc: day,
    manifest_hash: manifestHash,
  }));
  const manifestPath = path.join(root, ...manifestKey.split("/"));
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, manifestBody);
  const identity = {
    core_snapshot_day_utc: day,
    core_snapshot_manifest_key: manifestKey,
    core_snapshot_manifest_hash: manifestHash,
    core_snapshot_manifest_sha256: sha256(manifestBody),
  };
  const identityFile = path.join(root, "identity.json");
  fs.writeFileSync(identityFile, JSON.stringify(identity));
  const env = {
    UK_AQ_R2_HISTORY_VERSION: generation,
    UK_AQ_INTEGRITY_CORE_SNAPSHOT_IDENTITY_JSON: JSON.stringify(identity),
    UK_AQ_INTEGRITY_CORE_SNAPSHOT_IDENTITY_FILE: identityFile,
    UK_AQ_INTEGRITY_CORE_SNAPSHOT_DROPBOX_ROOT: root,
  };
  return { root, identity, env };
}

for (const generation of ["v2", "v3"]) {
  test(`proposal identity validator accepts canonical ${generation} core`, () => {
    const { root, identity, env } = fixture(generation);
    try {
      const validated = validateIntegrityCoreSnapshotIdentity({
        env,
        runState: { core_snapshot_identity: identity },
        dropboxRoot: root,
        stage: "proposal_dependency_core_identity",
      });
      assert.equal(validated.core_snapshot_manifest_key, identity.core_snapshot_manifest_key);
      assert.equal(validated.coordinator_identity_match, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`proposal identity validator rejects cross-generation key for ${generation}`, () => {
    const { root, identity, env } = fixture(generation);
    try {
      const other = generation === "v2" ? "v3" : "v2";
      assert.throws(
        () => parseIntegrityCoreSnapshotIdentity({
          ...identity,
          core_snapshot_manifest_key:
            `history/${other}/core/day_utc=${identity.core_snapshot_day_utc}/manifest.json`,
        }, {
          stage: "proposal_cross_generation",
          label: "requested",
          env,
        }),
        /requested_manifest_key_noncanonical/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
