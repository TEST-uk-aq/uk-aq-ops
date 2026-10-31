// Shared exact-byte encoding for Node publishers and bounded Worker validation.
const utf8 = new TextEncoder();
function bytewiseCompare(left, right) {
  if (/^[\x00-\x7f]*$/.test(left + right)) return left < right ? -1 : left > right ? 1 : 0;
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(bytewiseCompare)
      .map((key) => [key, canonicalizeJsonValue(value[key])]));
  }
  return value;
}
export function encodeObservationHistoryIndexV3Json(payload) {
  return `${JSON.stringify(canonicalizeJsonValue(payload), null, 2)}\n`;
}
