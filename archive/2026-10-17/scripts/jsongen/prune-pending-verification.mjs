// Inactive private reader for later reconciliation. Never called by Prune.
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { r2GetObjectBounded, sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { BUCKET } from './schema.mjs';
import { LIMITS, evidence } from './limits.mjs';
import { admitDerived } from './inputs.mjs';
import { validatePrunePendingSourceRows } from './prune-pending-source.mjs';

export async function verifyPrunePendingSource({ r2, reference, intentId, runId, dayUtc,
  connectorId, expectedRowCount, sourceIdentity }) {
  admitDerived(r2);
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
  const readback = await r2GetObjectBounded({ r2, key: reference.key,
    max_bytes: reference.byte_size, timeout_ms: 15_000 });
  evidence(readback.bytes === reference.byte_size && sha256Hex(readback.body) === reference.sha256,
    'invalid_object_identity', 'pending compressed bytes differ');
  let source;
  try { source = gunzipSync(readback.body, { maxOutputLength: reference.json_byte_size }); }
  catch { evidence(false, 'invalid_object_identity', 'pending gzip cannot be decoded within source limit'); }
  evidence(source.length === reference.json_byte_size && sha256Hex(source) === reference.json_sha256,
    'invalid_object_identity', 'pending original bytes differ');
  validatePrunePendingSourceRows(source, { dayUtc, connectorId, expectedRowCount, sourceIdentity });
  return { state: 'source_bytes_verified', intent_id: intentId, source: reference };
}
