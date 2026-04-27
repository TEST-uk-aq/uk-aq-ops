const POSTCODE_COMPACT_PATTERN = /^(GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/;

export function normalisePostcode(input) {
  if (typeof input !== "string") {
    return null;
  }
  const compact = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!compact) {
    return null;
  }
  if (!POSTCODE_COMPACT_PATTERN.test(compact)) {
    return null;
  }
  return compact;
}

export function getPostcodeShard(normalisedPostcode) {
  if (typeof normalisedPostcode !== "string") {
    return null;
  }
  if (!POSTCODE_COMPACT_PATTERN.test(normalisedPostcode)) {
    return null;
  }
  const match = normalisedPostcode.match(/^[A-Z]+/);
  return match ? match[0] : null;
}

export function formatPostcode(normalisedPostcode) {
  if (typeof normalisedPostcode !== "string" || normalisedPostcode.length < 4) {
    return String(normalisedPostcode || "").trim();
  }
  return `${normalisedPostcode.slice(0, -3)} ${normalisedPostcode.slice(-3)}`;
}

export function buildPostcodeShardObjectKey(prefix, shard) {
  const normalizedPrefix = String(prefix || "").trim().replace(/^\/+|\/+$/g, "");
  const normalizedShard = String(shard || "").trim().toUpperCase();
  if (!normalizedPrefix || !normalizedShard) {
    return null;
  }
  return `${normalizedPrefix}/${normalizedShard}.json`;
}
