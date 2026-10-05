import assert from "node:assert/strict";
import test from "node:test";

import {
  buildR2ChecksumAwarePutIntent,
  putAndVerifyR2ObjectWithSha256,
  verifyR2StoredSha256Head,
} from "../workers/shared/uk_aq_r2_checksum_publication.mjs";

const intent = buildR2ChecksumAwarePutIntent({
  key: "history/_prototype/observation-history/fixture.json",
  body: "fixture body",
  contentType: "application/json; charset=utf-8",
});

function matchingStoredBody(overrides = {}) {
  return {
    key: intent.key,
    bytes: intent.byte_size,
    body: Buffer.from(intent.body),
    etag: "stored-etag",
    ...overrides,
  };
}

test("checksum-aware HEAD accepts matching stored byte size and SHA-256", () => {
  const verified = verifyR2StoredSha256Head({
    head: { exists: true, bytes: intent.byte_size, sha256: intent.sha256 },
    intent,
  });
  assert.equal(verified.byte_size, intent.byte_size);
  assert.equal(verified.stored_byte_size_verified, true);
  assert.equal(verified.stored_sha256_verified, true);
});

test("normal matching HEAD verification succeeds without GET", async () => {
  let getCount = 0;
  const verified = await putAndVerifyR2ObjectWithSha256({
    r2: {},
    intent,
    putObject: async () => {},
    headObject: async () => ({
      exists: true,
      bytes: intent.byte_size,
      sha256: intent.sha256,
    }),
    getObject: async () => {
      getCount += 1;
      return matchingStoredBody();
    },
    verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
  });
  assert.equal(getCount, 0);
  assert.equal(verified.stored_byte_size_verified, true);
  assert.equal(verified.stored_sha256_verified, true);
  assert.equal(verified.stored_body_get_verified, undefined);
});

test("missing HEAD size uses explicit stored-body GET fallback", async () => {
  let getCount = 0;
  const verified = await putAndVerifyR2ObjectWithSha256({
    r2: {},
    intent,
    putObject: async () => {},
    headObject: async () => ({
      exists: true,
      bytes: null,
      sha256: intent.sha256,
      etag: "head-etag",
    }),
    getObject: async () => {
      getCount += 1;
      return matchingStoredBody();
    },
    verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
  });
  assert.equal(getCount, 1);
  assert.equal(verified.verified, true);
  assert.equal(verified.stored_byte_size_verified, true);
  assert.equal(verified.stored_sha256_verified, true);
  assert.equal(verified.stored_body_get_verified, true);
  assert.equal(verified.head_sha256_verified, true);
});

test("missing HEAD size retains default fail-closed policy without fallback", async () => {
  let getCount = 0;
  await assert.rejects(
    putAndVerifyR2ObjectWithSha256({
      r2: {},
      intent,
      putObject: async () => {},
      headObject: async () => ({
        exists: true,
        bytes: null,
        sha256: intent.sha256,
      }),
      getObject: async () => { getCount += 1; },
    }),
    /byte-size verification unavailable/,
  );
  assert.equal(getCount, 0);
});

test("known mismatching HEAD byte size fails without GET override", async () => {
  let getCount = 0;
  await assert.rejects(
    putAndVerifyR2ObjectWithSha256({
      r2: {},
      intent,
      putObject: async () => {},
      headObject: async () => ({
        exists: true,
        bytes: intent.byte_size + 1,
        sha256: intent.sha256,
      }),
      getObject: async () => { getCount += 1; },
      verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
    }),
    /byte-size verification failed/,
  );
  assert.equal(getCount, 0);
});

test("known mismatching HEAD SHA-256 fails before GET", async () => {
  let getCount = 0;
  await assert.rejects(
    putAndVerifyR2ObjectWithSha256({
      r2: {},
      intent,
      putObject: async () => {},
      headObject: async () => ({
        exists: true,
        bytes: null,
        sha256: "0".repeat(64),
      }),
      getObject: async () => { getCount += 1; },
      verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
    }),
    /SHA-256 verification failed/,
  );
  assert.equal(getCount, 0);
});

test("fallback GET rejects wrong body byte length", async () => {
  await assert.rejects(
    putAndVerifyR2ObjectWithSha256({
      r2: {},
      intent,
      putObject: async () => {},
      headObject: async () => ({ exists: true, bytes: null, sha256: intent.sha256 }),
      getObject: async () => ({
        key: intent.key,
        body: Buffer.concat([intent.body, Buffer.from("x")]),
      }),
      verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
    }),
    /GET byte-size verification failed/,
  );
});

test("fallback GET rejects correct length with wrong locally calculated SHA-256", async () => {
  const wrongBody = Buffer.from(intent.body);
  wrongBody[0] ^= 1;
  await assert.rejects(
    putAndVerifyR2ObjectWithSha256({
      r2: {},
      intent,
      putObject: async () => {},
      headObject: async () => ({ exists: true, bytes: null, sha256: intent.sha256 }),
      getObject: async () => ({ key: intent.key, body: wrongBody }),
      verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
    }),
    /GET SHA-256 verification failed/,
  );
});

test("fallback GET failure propagates and fails closed", async () => {
  await assert.rejects(
    putAndVerifyR2ObjectWithSha256({
      r2: {},
      intent,
      putObject: async () => {},
      headObject: async () => ({ exists: true, bytes: null, sha256: intent.sha256 }),
      getObject: async () => { throw new Error("fixture GET unavailable"); },
      verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
    }),
    /fixture GET unavailable/,
  );
});

test("fallback GET requires usable returned body bytes", async () => {
  await assert.rejects(
    putAndVerifyR2ObjectWithSha256({
      r2: {},
      intent,
      putObject: async () => {},
      headObject: async () => ({ exists: true, bytes: null, sha256: intent.sha256 }),
      getObject: async () => ({ key: intent.key, bytes: intent.byte_size }),
      verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
    }),
    /stored body verification unavailable/,
  );
});

test("explicit SHA-sufficient HEAD policy remains unchanged and does not GET", async () => {
  let putCount = 0;
  let getCount = 0;
  const verified = await putAndVerifyR2ObjectWithSha256({
    r2: {},
    intent,
    putObject: async () => { putCount += 1; },
    headObject: async () => ({
      exists: true,
      bytes: null,
      sha256: intent.sha256,
    }),
    getObject: async () => { getCount += 1; },
    requireStoredByteSize: false,
  });
  assert.equal(putCount, 1);
  assert.equal(getCount, 0);
  assert.equal(verified.byte_size, intent.byte_size);
  assert.equal(verified.stored_byte_size_verified, false);
  assert.equal(verified.stored_sha256_verified, true);
  assert.equal(verified.stored_body_get_verified, undefined);
});

test("checksum-aware HEAD rejects absent size and absent stored SHA-256 under SHA-only policy", () => {
  assert.throws(
    () => verifyR2StoredSha256Head({
      head: { exists: true, bytes: null, sha256: null },
      intent,
      requireStoredByteSize: false,
    }),
    /stored R2 SHA-256.*must be SHA-256 hex/,
  );
});
