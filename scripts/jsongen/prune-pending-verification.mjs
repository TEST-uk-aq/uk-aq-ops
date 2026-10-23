import { managedR2Environment } from './r2-config.mjs';
// Independent private source reader. Never called by Prune; byte integrity
// alone cannot qualify a source for a VERIFIED receipt.
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { BUCKET, canonicalJson, same } from './schema.mjs';
import { LIMITS, createBudget, evidence, freeze } from './limits.mjs';
import { admitDerived, readImmutable } from './inputs.mjs';
import { normalizeCanonicalObservationRow } from '../../workers/shared/uk_aq_observation_content_hash.mjs';
import { validatePrunePendingSourceRows } from './prune-pending-source.mjs';
import { describePrunePendingSource } from './prune-evidence.mjs';

const verifiedRows = new WeakMap();
export function verifiedPrunePendingRows(verification) {
  evidence(verifiedRows.has(verification), 'unverified_pending_source', 'Independent private pending readback required');
  return structuredClone(verifiedRows.get(verification));
}

// Share frozen authenticated rows within this invocation without cloning the
// unsupported observations into every planner/partition. No raw row is reported.
export function* iterateVerifiedPrunePendingRows(verification) {
  evidence(verifiedRows.has(verification), 'unverified_pending_source', 'Independent private pending readback required');
  yield* verifiedRows.get(verification);
}

export async function verifyPrunePendingSource({ r2, reference, intentId, runId, dayUtc,
  connectorId, expectedRowCount, sourceIdentity, expectedEvidenceSha256 = null,
  budget = createBudget(), environment = managedR2Environment(r2) }) {
  reference = structuredClone(reference); sourceIdentity = structuredClone(sourceIdentity);
  admitDerived(r2);
  evidence(environment === managedR2Environment(r2), 'cross_environment_evidence', 'Pending source environment differs from configured storage');
  evidence(connectorId === 1 && Number.isSafeInteger(expectedRowCount)
    && expectedRowCount > 0 && expectedRowCount <= LIMITS.rows,
  'invalid_frozen_source', 'Complete bounded AURN connector-day required');
  const prefix = `managed/jsongen/v1/pending/unverified/prune_daily_v3/connector_id=${connectorId}`
    + `/day_utc=${dayUtc}/invocation=${encodeURIComponent(runId)}`;
  evidence(reference?.bucket === BUCKET && typeof reference.key === 'string'
    && reference.key === `${prefix}/compressed_sha256=${reference.sha256}`
      + `/uncompressed_sha256=${reference.json_sha256}.ndjson.gz`
    && /^[a-f0-9]{64}$/.test(reference.sha256)
    && /^[a-f0-9]{64}$/.test(reference.json_sha256)
    && Number.isSafeInteger(reference.byte_size) && reference.byte_size > 0
    && reference.byte_size <= LIMITS.compressed_bytes
    && Number.isSafeInteger(reference.json_byte_size) && reference.json_byte_size > 0
    && reference.json_byte_size <= LIMITS.uncompressed_bytes,
  'invalid_object_identity', 'pending reference outside expected invocation and limits');
  const intentIdentity = ['uk_aq_jsongen_upload_intent_v1', BUCKET, reference.key,
    'prune_daily_v3', runId, 'v3', connectorId, dayUtc,
    'connector_day_observations_ndjson_gzip', reference.byte_size, reference.sha256,
    reference.json_byte_size, reference.json_sha256, 'connector_day', connectorId, dayUtc];
  const expectedIntentId = createHash('sha256').update(JSON.stringify(intentIdentity)).digest('hex');
  evidence(intentId === expectedIntentId, 'invalid_object_identity',
    'pending reference does not match original signer intent identity');
  const compressed = await readImmutable({ r2, reference, maxBytes: LIMITS.compressed_bytes, budget });
  evidence(reference.json_byte_size <= budget.remainingBytes(), 'resource_limit', 'Pending decompression budget exceeded');
  let source;
  try { source = gunzipSync(compressed, { maxOutputLength: reference.json_byte_size }); }
  catch { evidence(false, 'invalid_object_identity', 'pending gzip cannot be decoded within source limit'); }
  evidence(source.length === reference.json_byte_size && sha256Hex(source) === reference.json_sha256,
    'invalid_object_identity', 'pending original bytes differ');
  budget.bytes('decompressed', source.length);
  let rows;
  try {
    rows = validatePrunePendingSourceRows(source,
      { dayUtc, connectorId, expectedRowCount, sourceIdentity });
  } catch (error) {
    if (error?.name === 'JSONgenEvidenceError') throw error;
    evidence(false, 'invalid_frozen_source', 'Pending NDJSON or canonical source identity is invalid');
  }
  for (const row of rows) {
    budget.check();
    // The shared source hash accepts legacy coercions. Consumer admission must
    // additionally reject them: never round a timestamp, infer a status or
    // silently convert a string numeric value to make the source pass.
    const { observed_at: alias, ...canonical } = row;
    let normalized;
    try { normalized = normalizeCanonicalObservationRow(canonical); } catch {
      evidence(false, 'invalid_frozen_source', 'Pending row requires canonical identity, exact timestamp, numeric value and effective status');
    }
    evidence((alias === undefined || alias === row.observed_at_utc)
      && Object.hasOwn(row, 'verification_status') && same(canonical, normalized),
      'invalid_frozen_source', 'Pending row is not an exact canonical observation');
  }
  budget.rows(rows.length);
  const pendingEvidence = describePrunePendingSource({ source, compressed,
    rows, runId, dayUtc, connectorId, sourceIdentity, environment });
  const evidenceSha256 = sha256Hex(canonicalJson(pendingEvidence));
  evidence(expectedEvidenceSha256 === null || expectedEvidenceSha256 === evidenceSha256,
    'invalid_object_identity', 'pending source evidence declaration differs from stored bytes');
  const result = freeze({ state: 'source_bytes_verified', intent_id: intentId, source: reference,
    pending_evidence: pendingEvidence, evidence_sha256: evidenceSha256 });
  verifiedRows.set(result, freeze(rows));
  return result;
}
