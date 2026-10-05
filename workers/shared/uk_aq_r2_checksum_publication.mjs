import { Buffer } from "node:buffer";

import {
  normalizeR2Sha256Checksum,
  r2GetObject,
  r2HeadObject,
  r2PutObject,
  sha256Hex,
} from "./r2_sigv4.mjs";

function requireSha256(value, fieldName) {
  const normalized = normalizeR2Sha256Checksum(value);
  if (!normalized) throw new TypeError(`${fieldName} must be SHA-256 hex`);
  return normalized;
}

export function buildR2ChecksumAwarePutIntent({
  key,
  body,
  contentType = "application/octet-stream",
}) {
  const normalizedKey = String(key || "").trim().replace(/^\/+/, "");
  if (!normalizedKey) throw new TypeError("Checksum-aware R2 PUT key is required");
  const bytes = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body ?? "");
  if (bytes.byteLength === 0) {
    throw new TypeError(`Checksum-aware R2 PUT body is empty: ${normalizedKey}`);
  }
  return Object.freeze({
    key: normalizedKey,
    body: bytes,
    byte_size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    content_type: String(contentType || "application/octet-stream"),
  });
}

export function verifyR2StoredSha256Head({
  head,
  intent,
  requireStoredByteSize = true,
}) {
  if (!head || head.exists === false) {
    throw new Error(`Checksum-aware R2 object is missing: ${intent.key}`);
  }
  const rawStoredByteSize = head.bytes ?? head.size;
  const storedByteSizeAvailable = (
    rawStoredByteSize !== null &&
    rawStoredByteSize !== undefined &&
    rawStoredByteSize !== ""
  );
  const storedByteSize = storedByteSizeAvailable ? Number(rawStoredByteSize) : null;
  if (storedByteSizeAvailable && storedByteSize !== intent.byte_size) {
    throw new Error(`Checksum-aware R2 byte-size verification failed: ${intent.key}`);
  }
  if (!storedByteSizeAvailable && requireStoredByteSize) {
    throw new Error(`Checksum-aware R2 byte-size verification unavailable: ${intent.key}`);
  }
  const storedSha256 = requireSha256(
    head.sha256 ?? head.checksums?.sha256,
    `stored R2 SHA-256 for ${intent.key}`,
  );
  if (storedSha256 !== intent.sha256) {
    throw new Error(`Checksum-aware R2 SHA-256 verification failed: ${intent.key}`);
  }
  return Object.freeze({
    key: intent.key,
    byte_size: intent.byte_size,
    sha256: intent.sha256,
    etag: String(head.etag || head.httpEtag || "").trim() || null,
    verified: true,
    stored_sha256_verified: true,
    stored_byte_size_verified: storedByteSizeAvailable,
  });
}

function storedBodyBytes(stored, key) {
  const body = stored?.body;
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error(`Checksum-aware R2 stored body verification unavailable: ${key}`);
}

function verifyR2StoredBodyGet({ head, stored, intent }) {
  if (!head || head.exists === false) {
    throw new Error(`Checksum-aware R2 object is missing: ${intent.key}`);
  }
  const rawHeadSha256 = head.sha256 ?? head.checksums?.sha256;
  let headSha256Verified = false;
  if (rawHeadSha256 !== null && rawHeadSha256 !== undefined && rawHeadSha256 !== "") {
    const headSha256 = requireSha256(
      rawHeadSha256,
      `stored R2 SHA-256 for ${intent.key}`,
    );
    if (headSha256 !== intent.sha256) {
      throw new Error(`Checksum-aware R2 SHA-256 verification failed: ${intent.key}`);
    }
    headSha256Verified = true;
  }
  if (stored?.key !== undefined && stored.key !== intent.key) {
    throw new Error(`Checksum-aware R2 GET key verification failed: ${intent.key}`);
  }
  const body = storedBodyBytes(stored, intent.key);
  const rawGetByteSize = stored?.bytes ?? stored?.size;
  if (
    rawGetByteSize !== null && rawGetByteSize !== undefined && rawGetByteSize !== "" &&
    Number(rawGetByteSize) !== body.byteLength
  ) {
    throw new Error(
      `Checksum-aware R2 GET byte-size evidence is contradictory: ${intent.key}`,
    );
  }
  if (body.byteLength !== intent.byte_size) {
    throw new Error(`Checksum-aware R2 GET byte-size verification failed: ${intent.key}`);
  }
  const calculatedSha256 = sha256Hex(body);
  const rawGetSha256 = stored?.sha256 ?? stored?.checksums?.sha256;
  if (rawGetSha256 !== null && rawGetSha256 !== undefined && rawGetSha256 !== "") {
    const getSha256 = requireSha256(
      rawGetSha256,
      `GET R2 SHA-256 for ${intent.key}`,
    );
    if (getSha256 !== calculatedSha256) {
      throw new Error(
        `Checksum-aware R2 GET SHA-256 evidence is contradictory: ${intent.key}`,
      );
    }
  }
  if (calculatedSha256 !== intent.sha256) {
    throw new Error(`Checksum-aware R2 GET SHA-256 verification failed: ${intent.key}`);
  }
  return Object.freeze({
    key: intent.key,
    byte_size: intent.byte_size,
    sha256: intent.sha256,
    etag: String(stored?.etag || head.etag || head.httpEtag || "").trim() || null,
    verified: true,
    stored_sha256_verified: true,
    stored_byte_size_verified: true,
    stored_body_get_verified: true,
    head_sha256_verified: headSha256Verified,
  });
}

export async function putAndVerifyR2ObjectWithSha256({
  r2,
  intent,
  putObject = r2PutObject,
  headObject = r2HeadObject,
  getObject = r2GetObject,
  requireStoredByteSize = true,
  verifyStoredBodyWithGetWhenHeadSizeUnavailable = false,
}) {
  const normalizedIntent = buildR2ChecksumAwarePutIntent({
    key: intent?.key,
    body: intent?.body,
    contentType: intent?.content_type,
  });
  if (
    intent?.byte_size !== undefined &&
    Number(intent.byte_size) !== normalizedIntent.byte_size
  ) {
    throw new Error(`Checksum-aware PUT intent byte size changed: ${normalizedIntent.key}`);
  }
  if (
    intent?.sha256 !== undefined &&
    requireSha256(intent.sha256, "PUT intent sha256") !== normalizedIntent.sha256
  ) {
    throw new Error(`Checksum-aware PUT intent SHA-256 changed: ${normalizedIntent.key}`);
  }
  await putObject({
    r2,
    key: normalizedIntent.key,
    body: normalizedIntent.body,
    content_type: normalizedIntent.content_type,
    sha256: normalizedIntent.sha256,
  });
  const head = await headObject({ r2, key: normalizedIntent.key });
  if (!head || head.exists === false) {
    throw new Error(`Checksum-aware R2 object is missing: ${normalizedIntent.key}`);
  }
  const rawStoredByteSize = head.bytes ?? head.size;
  const storedByteSizeAvailable = (
    rawStoredByteSize !== null &&
    rawStoredByteSize !== undefined &&
    rawStoredByteSize !== ""
  );
  if (
    !storedByteSizeAvailable &&
    verifyStoredBodyWithGetWhenHeadSizeUnavailable
  ) {
    const rawHeadSha256 = head.sha256 ?? head.checksums?.sha256;
    if (
      rawHeadSha256 !== null &&
      rawHeadSha256 !== undefined &&
      rawHeadSha256 !== ""
    ) {
      const headSha256 = requireSha256(
        rawHeadSha256,
        `stored R2 SHA-256 for ${normalizedIntent.key}`,
      );
      if (headSha256 !== normalizedIntent.sha256) {
        throw new Error(
          `Checksum-aware R2 SHA-256 verification failed: ${normalizedIntent.key}`,
        );
      }
    }
    const stored = await getObject({ r2, key: normalizedIntent.key });
    return verifyR2StoredBodyGet({
      head,
      stored,
      intent: normalizedIntent,
    });
  }
  return verifyR2StoredSha256Head({
    head,
    intent: normalizedIntent,
    requireStoredByteSize,
  });
}
