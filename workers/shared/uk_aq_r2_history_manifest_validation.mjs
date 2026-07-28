import { sha256Hex } from "./r2_sigv4.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function nonNegativeSafeInteger(value, fieldName) {
  if (
    value === null
    || value === undefined
    || typeof value === "boolean"
    || (typeof value === "string" && value.trim() === "")
  ) {
    throw new Error(`Canonical history manifest ${fieldName} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Canonical history manifest ${fieldName} is invalid`);
  }
  return parsed;
}

export function validateCanonicalHistoryV2Manifest(manifest, expected = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Canonical history manifest must be an object");
  }
  const manifestHash = String(manifest.manifest_hash || "").trim();
  if (!SHA256_PATTERN.test(manifestHash)) {
    throw new Error("Canonical history manifest_hash must be lowercase SHA-256 hex");
  }
  const { manifest_hash: _ignored, ...payload } = manifest;
  if (sha256Hex(JSON.stringify(payload)) !== manifestHash) {
    throw new Error("Canonical history manifest hash verification failed");
  }
  if (manifest.history_version !== "v2") {
    throw new Error("Canonical history manifest must use history_version=v2");
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && expectedValue !== null && manifest[field] !== expectedValue) {
      throw new Error(`Canonical history manifest ${field} identity mismatch`);
    }
  }
  const sourceRows = nonNegativeSafeInteger(manifest.source_row_count, "source_row_count");
  const rows = nonNegativeSafeInteger(manifest.row_count, "row_count");
  const fileCount = nonNegativeSafeInteger(manifest.file_count, "file_count");
  const totalBytes = nonNegativeSafeInteger(manifest.total_bytes, "total_bytes");
  if (rows !== sourceRows) {
    throw new Error("Canonical history manifest row counts disagree");
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length !== fileCount) {
    throw new Error("Canonical history manifest file_count disagrees with files");
  }
  const fileBytes = files.reduce(
    (sum, file) => sum + nonNegativeSafeInteger(file?.bytes, "files[].bytes"),
    0,
  );
  if (fileBytes !== totalBytes) {
    throw new Error("Canonical history manifest total_bytes disagrees with files");
  }
  return Object.freeze({
    manifest_hash: manifestHash,
    source_row_count: sourceRows,
    file_count: fileCount,
    total_bytes: totalBytes,
  });
}
