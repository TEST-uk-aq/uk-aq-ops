import assert from "node:assert/strict";
import test from "node:test";

import {
  buildR2ChecksumAwarePutIntent,
  putAndVerifyR2ObjectWithSha256,
  verifyR2StoredSha256Head,
} from "../workers/shared/uk_aq_r2_checksum_publication.mjs";
import {
  classifyExistingAlignedV2PrototypeObject,
} from "../scripts/index_v3_aligned_candidate/publish.mjs";

const intent = buildR2ChecksumAwarePutIntent({
  key: "history/_prototype/observation-history/fixture.json",
  body: "fixture body",
  contentType: "application/json; charset=utf-8",
});

test("checksum-aware HEAD accepts matching stored byte size and SHA-256", () => {
  const verified = verifyR2StoredSha256Head({
    head: { exists: true, bytes: intent.byte_size, sha256: intent.sha256 },
    intent,
  });
  assert.equal(verified.byte_size, intent.byte_size);
  assert.equal(verified.stored_byte_size_verified, undefined);
  assert.equal(verified.stored_sha256_verified, true);
});

test("checksum-aware HEAD rejects a known mismatching stored byte size", () => {
  assert.throws(
    () => verifyR2StoredSha256Head({
      head: { exists: true, bytes: intent.byte_size + 1, sha256: intent.sha256 },
      intent,
      requireStoredByteSize: false,
    }),
    /byte-size verification failed/,
  );
});

test("checksum-aware PUT permits absent HEAD size only under explicit SHA-sufficient policy", async () => {
  assert.throws(
    () => verifyR2StoredSha256Head({
      head: { exists: true, bytes: null, sha256: intent.sha256 },
      intent,
    }),
    /byte-size verification unavailable/,
  );
  let putCount = 0;
  const verified = await putAndVerifyR2ObjectWithSha256({
    r2: { adapter: {} },
    intent,
    putObject: async () => { putCount += 1; },
    headObject: async () => ({
      exists: true,
      bytes: null,
      sha256: intent.sha256,
    }),
    requireStoredByteSize: false,
  });
  assert.equal(putCount, 1);
  assert.equal(verified.byte_size, intent.byte_size);
  assert.equal(verified.stored_byte_size_verified, false);
  assert.equal(verified.stored_sha256_verified, true);
});

test("checksum-aware HEAD rejects absent size with mismatching SHA-256", () => {
  assert.throws(
    () => verifyR2StoredSha256Head({
      head: { exists: true, bytes: null, sha256: "0".repeat(64) },
      intent,
      requireStoredByteSize: false,
    }),
    /SHA-256 verification failed/,
  );
});

test("checksum-aware HEAD rejects absent size and absent stored SHA-256", () => {
  assert.throws(
    () => verifyR2StoredSha256Head({
      head: { exists: true, bytes: null, sha256: null },
      intent,
      requireStoredByteSize: false,
    }),
    /stored R2 SHA-256.*must be SHA-256 hex/,
  );
});

test("aligned prototype recognises an existing SHA-matching object when HEAD size is absent", () => {
  const existing = classifyExistingAlignedV2PrototypeObject({
    head: { exists: true, bytes: null, sha256: intent.sha256 },
    intent,
  });
  assert.equal(existing.action, "unchanged");
  assert.equal(existing.byte_size, intent.byte_size);
  assert.equal(existing.stored_byte_size_verified, false);
  assert.equal(existing.stored_sha256_verified, true);
});
