import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import { verifyManifestFileIdentity } from "../workers/shared/uk_aq_r2_file_identity.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
} from "../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  validateObservationPollutantManifestForGate,
  verifyObservationConnectorHistory,
  verifyOpaqueObservationFileForGate,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

function durableEvidence(artifact) {
  return {
    key: artifact.key,
    byte_size: artifact.byte_size,
    sha256: artifact.sha256,
    verified: true,
    durable: true,
  };
}

test("Prune verifies manifest SHA-256 identity from downloaded bytes rather than R2 ETag", () => {
  const body = Buffer.from("identity-pinned parquet bytes");
  assert.equal(verifyManifestFileIdentity({
    manifestIdentity: sha256Hex(body), expectedBytes: body.byteLength,
    liveObject: { bytes: body.byteLength, body, etag: '"unrelated"' }, objectKey: "example.parquet",
  }).identity_type, "sha256");
  const replacement = Buffer.from(body);
  replacement[0] ^= 0xff;
  assert.throws(() => verifyManifestFileIdentity({
    manifestIdentity: sha256Hex(body), expectedBytes: body.byteLength,
    liveObject: { bytes: replacement.byteLength, body: replacement, etag: '"unrelated"' },
    objectKey: "example.parquet",
  }), /SHA-256 mismatch/);
});

test("Prune verifies opaque quoted ETag identity with HEAD and no body GET", async () => {
  let getCount = 0;
  const result = await verifyOpaqueObservationFileForGate({
    r2: {}, fileKey: "opaque.parquet",
    manifestIdentity: '"0123456789abcdef0123456789abcdef"', expectedBytes: 1234,
    headObject: async () => ({ exists: true, bytes: 1234, etag: '"0123456789ABCDEF0123456789ABCDEF"' }),
    getObject: async () => { getCount += 1; throw new Error("unexpected GET"); },
  });
  assert.equal(result.identity_type, "etag");
  assert.equal(getCount, 0);
});

test("Prune preserves parent-linked opaque children but keeps active hash metadata fail-closed", () => {
  const base = {
    history_version: "v2",
    manifest_schema_version: 2,
    source_row_count: 24,
    row_count: 24,
    file_count: 1,
    total_bytes: 1234,
    files: [{ bytes: 1234 }],
  };
  const opaque = { ...base, manifest_hash: sha256Hex(JSON.stringify(base)) };
  assert.equal(validateObservationPollutantManifestForGate({
    childManifest: opaque,
    childReference: { manifest_hash: opaque.manifest_hash },
    childKey: "opaque/manifest.json",
    requiresActiveValidation: false,
  }).child_hash, opaque.manifest_hash);
  const invalidActiveWithoutHash = { ...base, observation_content_hash: "invalid" };
  const invalidActive = {
    ...invalidActiveWithoutHash,
    manifest_hash: sha256Hex(JSON.stringify(invalidActiveWithoutHash)),
  };
  assert.throws(() => validateObservationPollutantManifestForGate({
    childManifest: invalidActive,
    childReference: { manifest_hash: invalidActive.manifest_hash },
    childKey: "active/manifest.json",
    requiresActiveValidation: true,
  }), /observation_content_hash must be lower-case SHA-256/);
});

test("Prune v3 connector gate verifies exact writer evidence with stored SHA HEADs only", async () => {
  const dayUtc = "2026-08-18";
  const connectorId = 7;
  const writerGitSha = "3".repeat(40);
  const partition = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: [{
      connector_id: connectorId,
      station_id: 70,
      timeseries_id: 701,
      pollutant_code: "pm25",
      observed_at_utc: `${dayUtc}T00:00:00.000Z`,
      value: 9.5,
      verification_status: null,
    }],
    targetWriterGitSha: writerGitSha,
    backedUpAtUtc: "2026-08-19T00:00:00.000Z",
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    "history/v2/observations",
    dayUtc,
    connectorId,
  );
  const connectorPayload = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc,
    connectorId,
    runId: null,
    manifestKey: connectorKey,
    pollutantManifests: [partition.canonical_pollutant_manifest.payload],
    writerGitSha,
    backedUpAtUtc: "2026-08-19T00:00:00.000Z",
  });
  const connectorBody = Buffer.from(JSON.stringify(connectorPayload, null, 2));
  const connectorArtifact = {
    key: connectorKey,
    body: connectorBody,
    byte_size: connectorBody.byteLength,
    sha256: sha256Hex(connectorBody),
  };
  const fileEvidence = partition.target_metadata.files.map((file) => ({
    key: file.key,
    byte_size: file.byte_size,
    sha256: file.sha256,
    verified: true,
    durable: true,
  }));
  const scopedArtifact = partition.v3_hierarchy.scoped_manifest;
  const writerResult = {
    ok: true,
    prune_eligibility_owner: true,
    connector_publication_complete: true,
    connector_results: [{
      day_utc: dayUtc,
      connector_id: connectorId,
      partitions: [{
        scope: partition.scope,
        target_metadata: partition.target_metadata,
        pollutant_manifest: partition.canonical_pollutant_manifest,
        file_evidence: fileEvidence,
        scoped_root: {
          artifact: scopedArtifact,
          evidence: durableEvidence(scopedArtifact),
        },
      }],
      canonical: {
        connector_scope_verified: true,
        parent_state_reread_under_lock: true,
        connector_manifest_payload: connectorPayload,
        connector_manifest: durableEvidence(connectorArtifact),
        pollutant_manifests: [durableEvidence(partition.canonical_pollutant_manifest)],
      },
      v3_exact_publication: { ok: true },
    }],
  };
  const manifestBodies = new Map([
    [connectorKey, connectorBody],
    [partition.canonical_pollutant_manifest.key, partition.canonical_pollutant_manifest.body],
  ]);
  let parquetGetCount = 0;
  let parquetHeadCount = 0;
  const result = await verifyObservationConnectorHistory({
    runtime: { committed_prefix: "history/v2/observations", r2: {} },
    dayUtc,
    connectorId,
    manifestKey: connectorKey,
    expectedRowCount: 1n,
    writerResult,
    getObject: async ({ key }) => {
      if (key.endsWith(".parquet")) parquetGetCount += 1;
      const body = manifestBodies.get(key);
      if (!body) throw new Error(`unexpected object GET: ${key}`);
      return { exists: true, body: Buffer.from(body) };
    },
    headObject: async ({ key }) => {
      parquetHeadCount += 1;
      const evidence = fileEvidence.find((entry) => entry.key === key);
      return {
        exists: true,
        bytes: evidence.byte_size,
        sha256: evidence.sha256,
      };
    },
  });

  assert.equal(result.v3_scoped_index_authority_verified, true);
  assert.equal(result.observation_index_generation, "v3");
  assert.equal(result.history_row_count, 1);
  assert.equal(parquetGetCount, 0);
  assert.equal(parquetHeadCount, fileEvidence.length);
});
