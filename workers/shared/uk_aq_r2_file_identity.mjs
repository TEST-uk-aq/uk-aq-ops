import { sha256Hex } from "./r2_sigv4.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const QUOTED_ETAG_PATTERN = /^"[^"\r\n]+"$/;

function requireExpectedBytes(value, objectKey) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Manifest file byte count is invalid: ${objectKey}`);
  }
  return bytes;
}

function normalizeQuotedEtag(value, objectKey) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!QUOTED_ETAG_PATTERN.test(text)) {
    throw new Error(`R2 ETag is missing or not a quoted strong ETag: ${objectKey}`);
  }
  return text.slice(1, -1).toLowerCase();
}

export function classifyManifestFileIdentity(value, { objectKey = "(unknown)" } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (SHA256_PATTERN.test(text)) {
    return { type: "sha256", value: text };
  }
  if (QUOTED_ETAG_PATTERN.test(text)) {
    return {
      type: "etag",
      value: text.slice(1, -1).toLowerCase(),
    };
  }
  throw new Error(`Unsupported manifest file identity format: ${objectKey}`);
}

export function verifyManifestFileIdentity({
  manifestIdentity,
  expectedBytes,
  liveObject,
  objectKey,
}) {
  const key = String(objectKey || liveObject?.key || "(unknown)");
  const bytes = requireExpectedBytes(expectedBytes, key);
  if (Number(liveObject?.bytes) !== bytes) {
    throw new Error(`R2 object byte count mismatch: ${key}`);
  }

  const identity = classifyManifestFileIdentity(manifestIdentity, {
    objectKey: key,
  });
  if (identity.type === "sha256") {
    const body = liveObject?.body;
    if (!(body instanceof Uint8Array)) {
      throw new Error(`R2 object body is required for SHA-256 verification: ${key}`);
    }
    if (sha256Hex(body) !== identity.value) {
      throw new Error(`R2 object SHA-256 mismatch: ${key}`);
    }
  } else {
    const liveEtag = normalizeQuotedEtag(liveObject?.etag, key);
    if (liveEtag !== identity.value) {
      throw new Error(`R2 object ETag mismatch: ${key}`);
    }
  }

  return {
    identity_type: identity.type,
    bytes,
  };
}
