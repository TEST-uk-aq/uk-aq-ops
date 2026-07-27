import assert from "node:assert/strict";
import test from "node:test";

import { completeIntegrityConnectorDayGates } from
  "../scripts/backup_r2/uk_aq_complete_integrity_connector_gates.mjs";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  verifyManifestFileIdentity,
} from "../workers/shared/uk_aq_r2_file_identity.mjs";
import {
  validateObservationPollutantManifestForGate,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

function withManifestHash(payload) {
  return {
    ...payload,
    manifest_hash: sha256Hex(JSON.stringify(payload)),
  };
}

test("manifest SHA-256 identity is verified from downloaded bytes, not R2 ETag", () => {
  const body = Buffer.from("integrity parquet bytes");
  const result = verifyManifestFileIdentity({
    manifestIdentity: sha256Hex(body),
    expectedBytes: body.byteLength,
    liveObject: {
      bytes: body.byteLength,
      body,
      etag: '"an-unrelated-r2-etag"',
    },
    objectKey: "history/v2/observations/example.parquet",
  });
  assert.equal(result.identity_type, "sha256");
  assert.throws(
    () => verifyManifestFileIdentity({
      manifestIdentity: sha256Hex(body),
      expectedBytes: body.byteLength,
      liveObject: {
        bytes: body.byteLength,
        body: Buffer.from("different parquet bytes"),
        etag: '"an-unrelated-r2-etag"',
      },
      objectKey: "history/v2/observations/example.parquet",
    }),
    /SHA-256 mismatch/,
  );
});

test("quoted legacy R2 ETag identity is compared only with the live ETag", () => {
  const body = Buffer.from("legacy parquet bytes");
  const result = verifyManifestFileIdentity({
    manifestIdentity: '"0123456789abcdef0123456789abcdef"',
    expectedBytes: body.byteLength,
    liveObject: {
      bytes: body.byteLength,
      body,
      etag: '"0123456789ABCDEF0123456789ABCDEF"',
    },
    objectKey: "history/v2/observations/legacy.parquet",
  });
  assert.equal(result.identity_type, "etag");
  assert.throws(
    () => verifyManifestFileIdentity({
      manifestIdentity: '"0123456789abcdef0123456789abcdef"',
      expectedBytes: body.byteLength,
      liveObject: {
        bytes: body.byteLength,
        body,
        etag: '"fedcba9876543210fedcba9876543210"',
      },
      objectKey: "history/v2/observations/legacy.parquet",
    }),
    /ETag mismatch/,
  );
});

test("active pollutant hash metadata remains fail-closed", () => {
  const childKey = "history/v2/observations/day_utc=2026-07-07/connector_id=1/pollutant_code=no2/manifest.json";
  const childManifest = withManifestHash({
    source_row_count: 1,
    file_count: 1,
    total_bytes: 10,
    observation_content_hash: "not-a-sha256",
  });
  assert.throws(
    () => validateObservationPollutantManifestForGate({
      childManifest,
      childReference: { manifest_hash: childManifest.manifest_hash },
      childKey,
      requiresActiveValidation: true,
    }),
    /observation_content_hash must be lower-case SHA-256/,
  );
});

test("parent-linked opaque child is preserved without the active hash contract", () => {
  const childKey = "history/v2/observations/day_utc=2026-07-07/connector_id=1/pollutant_code=123c6h3ch33/manifest.json";
  const childManifest = withManifestHash({
    manifest_schema_version: 2,
    source_row_count: 24,
    file_count: 1,
    total_bytes: 1234,
  });
  const before = structuredClone(childManifest);
  const result = validateObservationPollutantManifestForGate({
    childManifest,
    childReference: { manifest_hash: childManifest.manifest_hash },
    childKey,
    requiresActiveValidation: false,
  });
  assert.equal(result.child_hash, childManifest.manifest_hash);
  assert.deepEqual(childManifest, before);
  assert.equal(Object.hasOwn(childManifest, "observation_content_hash"), false);
});

test("missing or contradictory opaque child identity remains fail-closed", () => {
  const childKey = "history/v2/observations/day_utc=2026-07-07/connector_id=1/pollutant_code=123c6h3ch33/manifest.json";
  const childManifest = withManifestHash({
    manifest_schema_version: 2,
    source_row_count: 24,
    file_count: 1,
    total_bytes: 1234,
  });
  assert.throws(
    () => validateObservationPollutantManifestForGate({
      childManifest: undefined,
      childReference: { manifest_hash: childManifest.manifest_hash },
      childKey,
      requiresActiveValidation: false,
    }),
    /invalid manifest_hash/,
  );
  assert.throws(
    () => validateObservationPollutantManifestForGate({
      childManifest,
      childReference: { manifest_hash: "f".repeat(64) },
      childKey,
      requiresActiveValidation: false,
    }),
    /Connector child manifest hash mismatch/,
  );
});

test("bounded completion marks only the successfully verified connector-day complete", async () => {
  const gateState = new Map([
    ["2026-07-02|1", false],
    ["2026-07-03|1", false],
    ["2026-07-04|2", true],
  ]);
  const result = await completeIntegrityConnectorDayGates({
    payload: {
      history_run_id: "2026-07-27T160142Z-gate-recovery",
      connector_days: [
        { day_utc: "2026-07-02", connector_id: 1 },
        { day_utc: "2026-07-03", connector_id: 1 },
      ],
    },
    runtime: {},
    databaseUrl: "unused",
    dependencies: {
      async withConnectorDayGateClient(_databaseUrl, callback) {
        return await callback({});
      },
      async verifyObservationConnectorHistory({ dayUtc, connectorId, activePollutants }) {
        assert.deepEqual(activePollutants, ["pm25", "pm10", "no2", "o3"]);
        if (dayUtc === "2026-07-03") throw new Error("representative verification failure");
        return {
          history_manifest_key: `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
          history_manifest_hash: "a".repeat(64),
          history_row_count: 10,
          history_file_count: 1,
          history_total_bytes: 100,
        };
      },
      async setConnectorDayGateComplete(_client, evidence) {
        gateState.set(`${evidence.day_utc}|${evidence.connector_id}`, true);
      },
      async setConnectorDayGateIncomplete(_client, pair) {
        gateState.set(`${pair.day_utc}|${pair.connector_id}`, false);
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.completed_connector_day_count, 1);
  assert.equal(result.failed_connector_day_count, 1);
  assert.equal(gateState.get("2026-07-02|1"), true);
  assert.equal(gateState.get("2026-07-03|1"), false);
  assert.equal(gateState.get("2026-07-04|2"), true);
});
