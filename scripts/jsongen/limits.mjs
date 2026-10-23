// Provisional protective caps, not production retention or throughput policy.
import { performance } from 'node:perf_hooks';
import { requireValid } from './schema.mjs';
export const LIMITS = Object.freeze({
  receipt_bytes: 1024 ** 2, compressed_bytes: 8 * 1024 ** 2,
  uncompressed_bytes: 32 * 1024 ** 2, record_bytes: 8 * 1024 ** 2,
  scopes: 128, rows: 100_000, receipt_references: 32,
  metadata_bytes: 8 * 1024 ** 2, metadata_gets: 256,
  total_bytes: 64 * 1024 ** 2, total_rows: 200_000,
  report_bytes: 4 * 1024 ** 2, duration_ms: 60_000,
});
// Only original Prune handover decoding gets this larger still-bounded profile:
// 32 MiB compressed bundle + 64 MiB JSON + 32 MiB pinned metadata bodies +
// 8 MiB pending gzip + 32 MiB pending NDJSON fit under the 192 MiB total.
// Ordinary receipts, currentness inspection and legacy inline decoding keep
// their existing ceilings.
const PRUNE_HANDOVER_LIMITS = Object.freeze({ ...LIMITS,
  metadata_bytes: 128 * 1024 ** 2,
  total_bytes: 192 * 1024 ** 2,
  duration_ms: 120_000,
});
// Only the manual currentness inspector gets this profile. For <=128 scopes,
// at most 13 keys/scope + four shared keys, initial read + recheck + closing
// root. The actual operation is lowered to its exact deterministic key plan.
// Receipt scopes, bytes, rows, deadline and report caps are NOT raised.
export const INSPECTION_CONCURRENCY = 4;
export const INSPECTION_MAX_METADATA_GETS = 2 * (13 * LIMITS.scopes + 4) + 1;
export function createInspectionBudget(overrides = {}) {
  return makeBudget(overrides, { ...LIMITS, metadata_gets: INSPECTION_MAX_METADATA_GETS });
}
// A pending source is one complete connector-day, not a Stage 1 receipt.
// Keep receipt/consumer fan-out at 128; larger sources must later be partitioned
// into complete physical scopes by the independently authenticated consumer.
// Row, compressed/uncompressed byte and evidence caps remain coupled bounds.
export const PRUNE_PENDING_SOURCE_LIMITS = Object.freeze({
  scopes: 1024, rows: LIMITS.rows,
  compressed_bytes: LIMITS.compressed_bytes,
  uncompressed_bytes: LIMITS.uncompressed_bytes,
  evidence_bytes: LIMITS.receipt_bytes,
});
export class JSONgenEvidenceError extends Error {
  constructor(code, detail, cause) {
    super(detail, { cause }); this.name = 'JSONgenEvidenceError'; this.code = code;
  }
}
export function evidence(condition, code, detail) {
  if (!condition) throw new JSONgenEvidenceError(code, detail);
}
export function createBudget(overrides = {}) {
  return makeBudget(overrides, LIMITS);
}
export function createPruneHandoverBudget(overrides = {}) {
  return makeBudget(overrides, PRUNE_HANDOVER_LIMITS);
}
function makeBudget(overrides, ceiling) {
  requireValid(Object.keys(overrides).every(k => Object.hasOwn(LIMITS, k)), 'unknown resource limit');
  const limits = Object.freeze({ ...ceiling, ...overrides });
  for (const [k, v] of Object.entries(limits)) requireValid(Number.isSafeInteger(v) && v > 0 && v <= ceiling[k], `invalid ${k} limit`);
  const started = performance.now();
  let reserved = 0, metadataLimit = limits.metadata_gets;
  const used = { derived_gets: 0, metadata_gets: 0, derived_bytes: 0, metadata_bytes: 0, decompressed_bytes: 0, rows: 0 };
  const check = () => evidence(performance.now() - started < limits.duration_ms, 'resource_limit', 'operation deadline exceeded');
  return {
    limits, check,
    put(n) { check(); this.bytes('derived', n); used.derived_puts = (used.derived_puts || 0) + 1;
      used.upload_bytes = (used.upload_bytes || 0) + n; },
    remainingMs() { check(); return Math.max(1, Math.floor(limits.duration_ms - (performance.now() - started))); },
    elapsedMs() { return Math.ceil(performance.now() - started); },
    metadataLimit: () => metadataLimit,
    configureMetadataLimit(n) { requireValid(Number.isSafeInteger(n) && n > 0, 'invalid metadata plan'); metadataLimit = Math.min(metadataLimit, n); },
    reserveBytes(n) {
      check(); evidence(Number.isSafeInteger(n) && n > 0 && n <= limits.total_bytes - used.derived_bytes - used.metadata_bytes - used.decompressed_bytes - reserved,
        'resource_limit', 'concurrent metadata byte reservation exceeded');
      reserved += n; let released = false;
      return () => { if (!released) { reserved -= n; released = true; } };
    },
    timeout() { check(); return Math.max(1, Math.min(30_000, Math.floor(limits.duration_ms - (performance.now() - started)))); },
    get(domain) { check(); evidence(domain !== 'metadata' || used.metadata_gets < metadataLimit, 'resource_limit', 'canonical metadata GET budget exceeded'); used[`${domain}_gets`]++; },
    bytes(domain, n) { check(); used[`${domain}_bytes`] += n; evidence(used.derived_bytes + used.metadata_bytes + used.decompressed_bytes <= limits.total_bytes, 'resource_limit', 'operation byte budget exceeded'); },
    rows(n) { check(); used.rows += n; evidence(used.rows <= limits.total_rows, 'resource_limit', 'operation row budget exceeded'); },
    remainingBytes() { check(); return limits.total_bytes - used.derived_bytes - used.metadata_bytes - used.decompressed_bytes - reserved; },
    snapshot: () => ({ ...used }),
  };
}
export function parseJson(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function freeze(value) {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
