import { Buffer } from "node:buffer";

import {
  normalizeR2Sha256Checksum,
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

export function verifyR2StoredSha256Head({ head, intent }) {
  if (!head || head.exists === false) {
    throw new Error(`Checksum-aware R2 object is missing: ${intent.key}`);
  }
  if (Number(head.bytes ?? head.size) !== intent.byte_size) {
    throw new Error(`Checksum-aware R2 byte-size verification failed: ${intent.key}`);
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
    stored_sha256_verified: true,
  });
}

export async function putAndVerifyR2ObjectWithSha256({
  r2,
  intent,
  putObject = r2PutObject,
  headObject = r2HeadObject,
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
  return verifyR2StoredSha256Head({ head, intent: normalizedIntent });
}
