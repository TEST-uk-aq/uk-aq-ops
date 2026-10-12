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
export class JSONgenEvidenceError extends Error {
  constructor(code, detail, cause) {
    super(detail, { cause }); this.name = 'JSONgenEvidenceError'; this.code = code;
  }
}
export function evidence(condition, code, detail) {
  if (!condition) throw new JSONgenEvidenceError(code, detail);
}
export function createBudget(overrides = {}) {
  requireValid(Object.keys(overrides).every(k => Object.hasOwn(LIMITS, k)), 'unknown resource limit');
  const limits = Object.freeze({ ...LIMITS, ...overrides });
  for (const [k, v] of Object.entries(limits)) requireValid(Number.isSafeInteger(v) && v > 0 && v <= LIMITS[k], `invalid ${k} limit`);
  const started = performance.now();
  const used = { derived_gets: 0, metadata_gets: 0, derived_bytes: 0, metadata_bytes: 0, decompressed_bytes: 0, rows: 0 };
  const check = () => evidence(performance.now() - started < limits.duration_ms, 'resource_limit', 'operation deadline exceeded');
  return {
    limits, check,
    timeout() { check(); return Math.max(1, Math.min(30_000, Math.floor(limits.duration_ms - (performance.now() - started)))); },
    get(domain) { check(); evidence(domain !== 'metadata' || used.metadata_gets < limits.metadata_gets, 'resource_limit', 'canonical metadata GET budget exceeded'); used[`${domain}_gets`]++; },
    bytes(domain, n) { check(); used[`${domain}_bytes`] += n; evidence(used.derived_bytes + used.metadata_bytes + used.decompressed_bytes <= limits.total_bytes, 'resource_limit', 'operation byte budget exceeded'); },
    rows(n) { check(); used.rows += n; evidence(used.rows <= limits.total_rows, 'resource_limit', 'operation row budget exceeded'); },
    remainingBytes() { check(); return limits.total_bytes - used.derived_bytes - used.metadata_bytes - used.decompressed_bytes; },
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
