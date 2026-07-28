import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import { verifyManifestFileIdentity } from "../workers/shared/uk_aq_r2_file_identity.mjs";
import {
  validateObservationPollutantManifestForGate,
  verifyOpaqueObservationFileForGate,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

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
