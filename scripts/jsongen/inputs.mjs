// Byte/logical integrity only. No receipt-supplied field grants writer authority.
import { assertPruneEventDescriptor, assertPruneEventReference } from './prune-event-schema.mjs';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { r2GetObjectBounded, sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { computeObservationContentHash, computeObservationMeasurementContentHash, computeEmptyObservationContentHash, computeEmptyObservationMeasurementContentHash } from '../../workers/shared/uk_aq_observation_content_hash.mjs';
import { ROOT, assertReference, assertReceipt, assertBundleRecord,
  canonicalJson, same, scopeKey } from './schema.mjs';
import { createBudget, evidence, parseJson, freeze } from './limits.mjs';
import { assertManagedR2Target, managedR2Environment } from './r2-config.mjs';

export function admitDerived(r2) {
  try { assertManagedR2Target(r2); }
  catch { evidence(false, 'unapproved_storage', 'explicit private JSONgen R2 target required'); }
}
export async function readImmutable({ r2, reference, maxBytes, budget, domain = 'derived' }) {
  reference = structuredClone(reference);
  assertReference(reference, { gzip: Object.hasOwn(reference, 'json_sha256') || Object.hasOwn(reference, 'json_byte_size') });
  evidence(reference.bucket === r2.bucket && reference.byte_size <= maxBytes && reference.byte_size <= budget.remainingBytes(), 'invalid_object_identity', 'object bucket/size admission failed');
  budget.get(domain);
  const stored = await r2GetObjectBounded({ r2, key: reference.key, max_bytes: reference.byte_size, timeout_ms: budget.timeout() });
  budget.transfer?.(domain, stored.bytes);
  budget.bytes(domain, stored.bytes);
  evidence(stored.bytes === reference.byte_size && sha256Hex(stored.body) === reference.sha256,
    'invalid_object_identity', `exact byte length or SHA-256 mismatch: ${reference.key}`);
  return stored.body;
}
export async function readReceipt({ r2, reference, expected = null, budget = createBudget() }) {
  reference = structuredClone(reference); expected = expected && structuredClone(expected);
  admitDerived(r2); assertReference(reference, { managed: true });
  evidence(reference.key === `${ROOT}/receipts/${reference.sha256}.json`, 'invalid_receipt', 'immutable receipt key required');
  const bytes = await readImmutable({ r2, reference, maxBytes: budget.limits.receipt_bytes, budget });
  const receipt = parseJson(bytes);
  evidence(Array.isArray(receipt?.scopes) && receipt.scopes.length <= budget.limits.scopes, 'resource_limit', 'declared scope budget exceeded');
  assertReceipt(receipt);
  if ([2, 3].includes(receipt.schema_version)) evidence(receipt.origin.authority.key.environment === managedR2Environment(r2),
    'cross_environment_evidence', 'Retained receipt differs from configured storage environment');
  evidence(canonicalJson(receipt).equals(bytes), 'invalid_receipt', 'receipt JSON must have canonical encoding');
  if (expected) evidence(same(receipt, expected), 'stable_change_identity_mismatch', 'retained receipt differs from registered event/writer/invocation');
  evidence(receipt.bundle.row_count <= budget.limits.rows, 'resource_limit', 'declared row budget exceeded');
  return freeze(receipt);
}
async function decompress(bytes, reference, budget) {
  evidence(reference.json_byte_size <= budget.limits.uncompressed_bytes && reference.json_byte_size <= budget.remainingBytes(), 'resource_limit', 'declared decompressed byte budget exceeded');
  const unzip = createGunzip();
  const timer = setTimeout(() => unzip.destroy(new Error('bundle decompression deadline exceeded')), budget.timeout());
  const stream = Readable.from([bytes]).pipe(unzip);
  const chunks = []; let length = 0;
  try {
    for await (const chunk of stream) {
      budget.bytes('decompressed', chunk.length);
      length += chunk.length;
      evidence(length <= reference.json_byte_size && length <= budget.limits.uncompressed_bytes, 'resource_limit', 'decompressed byte budget exceeded');
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); stream.destroy(); }
  const result = Buffer.concat(chunks, length);
  evidence(length === reference.json_byte_size && sha256Hex(result) === reference.json_sha256,
    'invalid_bundle_identity', 'uncompressed byte length or SHA-256 mismatch');
  return result;
}
export async function readBundle({ r2, receipt, budget = createBudget() }) {
  receipt = freeze(structuredClone(receipt));
  admitDerived(r2); assertReceipt(receipt);
  if ([2, 3].includes(receipt.schema_version)) evidence(receipt.origin.authority.key.environment === managedR2Environment(r2),
    'cross_environment_evidence', 'Bundle receipt source differs from configured storage environment');
  evidence(receipt.scopes.length <= budget.limits.scopes && receipt.bundle.row_count <= budget.limits.rows,
    'resource_limit', 'bundle scope/row admission failed');
  const ref = receipt.bundle.object;
  const compressed = await readImmutable({ r2, reference: ref, maxBytes: budget.limits.compressed_bytes, budget });
  const body = await decompress(compressed, ref, budget);
  const expected = new Map(receipt.scopes.map(s => [scopeKey(s), s]));
  const records = []; const logical = [];
  let offset = 0; let rows = 0;
  while (offset < body.length) {
    budget.check();
    const newline = body.indexOf(10, offset);
    const end = newline < 0 ? body.length : newline;
    evidence(end > offset && end - offset <= budget.limits.record_bytes && records.length < budget.limits.scopes,
      'invalid_bundle_membership', 'blank, oversized or excessive NDJSON record');
    const record = parseJson(body.subarray(offset, end));
    const key = scopeKey(record); const scope = expected.get(key);
    evidence(scope, 'invalid_bundle_membership', 'duplicated or undeclared replacement scope');
    assertBundleRecord(record, scope);
    rows += record.rows.length; budget.rows(record.rows.length);
    evidence(rows <= budget.limits.rows, 'resource_limit', 'bundle observation row budget exceeded');
    // Shared hashes preserve canonical timestamps, float64 values and multiplicity.
    // They do NOT authenticate source_status or effective status against a writer.
    const { canonical_rows: _observations, ...observation } = record.rows.length
      ? computeObservationContentHash(record.rows) : computeEmptyObservationContentHash();
    const { canonical_rows: _measurements, ...measurement } = record.rows.length
      ? computeObservationMeasurementContentHash(record.rows) : computeEmptyObservationMeasurementContentHash();
    logical.push({ scope_key: key, observation, measurement,
      absence_authority: record.state === 'authoritative_empty' ? 'independent_proof_required' : 'not_applicable' });
    records.push(record); expected.delete(key); offset = end + 1;
  }
  evidence(expected.size === 0 && records.length === receipt.bundle.scope_count && rows === receipt.bundle.row_count,
    'invalid_bundle_membership', 'missing scope or final row-count mismatch');
  return freeze({ integrity: 'verified', writer_authenticated: false, records, logical,
    provenance: { bundle: structuredClone(ref), source: structuredClone(receipt.source),
      writer: structuredClone(receipt.writer), change_id: receipt.change_id } });
}
export async function readWriterInput({ r2, reference, expected = null, budget = createBudget() }) {
  reference = structuredClone(reference);
  const receipt = await readReceipt({ r2, reference, expected, budget });
  const bundle = await readBundle({ r2, receipt, budget });
  return freeze({ receipt_object: reference, receipt, bundle });
}

export async function readPruneEventDescriptor({ r2, reference, expected = null, budget = createBudget() }) {
  admitDerived(r2); assertPruneEventReference(reference);
  const bytes = await readImmutable({ r2, reference, maxBytes: budget.limits.metadata_bytes, budget });
  const descriptor = assertPruneEventDescriptor(parseJson(bytes));
  evidence(descriptor.coverage.authority.key.environment === managedR2Environment(r2),
    'cross_environment_evidence', 'Descriptor source differs from configured storage environment');
  evidence(canonicalJson(descriptor).equals(bytes) && (!expected || same(descriptor, expected)),
    'invalid_authenticated_event', 'Canonical descriptor readback mismatch');
  budget.check(); return freeze(descriptor);
}
