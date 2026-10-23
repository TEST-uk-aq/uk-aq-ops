import { isEnvironmentName } from './environment.mjs';
// Versioned deterministic transport for complete original Prune evidence.
// Hashes and bounded decoding prove byte identity, not writer or DB authority.
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalJson } from './schema.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

export const PRUNE_EVIDENCE_BUNDLE_LIMITS = Object.freeze({
  object_bytes: 8 * 1024 ** 2,
  raw_bytes: 32 * 1024 ** 2,
  object_count: 8192,
  json_bytes: 64 * 1024 ** 2,
  compressed_bytes: 32 * 1024 ** 2,
});

const SHA = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { original_authority_code: code }); };
const check = (ok, code = 'invalid_original_evidence_bundle') => { if (!ok) fail(code); };

export function pruneEvidenceBundleIntentId({ bucket, key, identity, compressed_byte_size,
  compressed_sha256, uncompressed_byte_size, uncompressed_sha256 }) {
  const scope = identity.scope;
  const values = ['uk_aq_jsongen_evidence_bundle_intent_v1', bucket, key,
    identity.writer_identity, identity.environment, identity.invocation_id, identity.attempt_id,
    identity.writer_git_sha, identity.index_generation, identity.connector_id,
    identity.day_utc, identity.object_type, compressed_byte_size, compressed_sha256,
    uncompressed_byte_size, uncompressed_sha256, identity.source_evidence_sha256,
    identity.source_identity_sha256, identity.connector_manifest_key,
    identity.connector_manifest_sha256, identity.original_final_batch_sha256,
    scope.kind, scope.connector_id, scope.day_utc];
  return sha256Hex(Buffer.from(JSON.stringify(values)));
}

function bodyBytes(object, phase) {
  check(object && typeof object.key === 'string' && object.key.endsWith('.json')
    && !object.key.split('/').some(part => !part || part === '.' || part === '..')
    && Number.isSafeInteger(object.byte_size) && object.byte_size > 0
    && object.byte_size <= PRUNE_EVIDENCE_BUNDLE_LIMITS.object_bytes
    && SHA.test(object.sha256 || '') && typeof object.bytes_base64 === 'string'
    && object.bytes_base64.length === 4 * Math.ceil(object.byte_size / 3)
    && object.bytes_base64.length <= 4 * Math.ceil(PRUNE_EVIDENCE_BUNDLE_LIMITS.object_bytes / 3),
  'original_metadata_capture_limit');
  const bytes = Buffer.from(object.bytes_base64, 'base64');
  check(bytes.length === object.byte_size && bytes.toString('base64') === object.bytes_base64
    && sha256Hex(bytes) === object.sha256, 'invalid_original_metadata_object_bytes');
  if (phase === 'final') check(Array.isArray(object.roles) && object.roles.length > 0
    && object.roles.every(role => typeof role === 'string' && role.length <= 64),
  'invalid_original_metadata_object_roles');
  else check(['before', 'binding'].includes(object.phase), 'invalid_original_metadata_object_phase');
  return bytes.length;
}

function validateEvidenceEnvelope(envelope) {
  check(envelope?.schema_version === 1
    && envelope.kind === 'uk_aq_jsongen_prune_original_final_evidence_preparation'
    && isEnvironmentName(envelope.environment) && envelope.index_generation === 'v3'
    && envelope.writer?.identity === 'prune_daily_v3'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(envelope.writer?.invocation_id || '')
    && envelope.writer.attempt_id === envelope.writer.invocation_id
    && /^[a-f0-9]{40}$/.test(envelope.writer.git_sha || '')
    && Number.isSafeInteger(envelope.connector_id) && envelope.connector_id === 1
    && /^\d{4}-\d{2}-\d{2}$/.test(envelope.day_utc || ''), 'bundle_invocation_identity');
  check(envelope.pending?.source_evidence?.environment === envelope.environment
    && envelope.original_authority_extension?.identity?.environment === envelope.environment,
  'evidence_bundle_environment_mismatch');
  const snapshot = envelope.original_metadata_snapshot;
  const original = envelope.original_authority_extension;
  check(snapshot?.schema_version === 1
    && snapshot.completeness === 'exact_writer_metadata_captured_unverified'
    && snapshot.capture_boundary === 'original_writer_put_bytes_after_verified_finalization'
    && snapshot.writer_identity === envelope.writer.identity
    && snapshot.invocation_id === envelope.writer.invocation_id
    && snapshot.writer_git_sha === envelope.writer.git_sha
    && snapshot.connector_id === envelope.connector_id && snapshot.day_utc === envelope.day_utc
    && Array.isArray(snapshot.affected_days_utc)
    && Array.isArray(snapshot.objects) && snapshot.objects.length > 0
    && snapshot.objects.length === snapshot.required_object_count,
  'complete_original_final_metadata_required');
  check(original?.schema_version === 1
    && original.kind === 'uk_aq_prune_original_scope_binding_authority'
    && original.completeness === 'captured' && Array.isArray(original.objects)
    && original.objects.length > 0 && original.objects.length === original.required_object_count,
  'complete_original_before_and_binding_authority_required');
  let rawBytes = 0; let objectCount = 0;
  for (const object of snapshot.objects) { rawBytes += bodyBytes(object, 'final'); objectCount++; }
  for (const object of original.objects) { rawBytes += bodyBytes(object, object.phase); objectCount++; }
  check(rawBytes <= PRUNE_EVIDENCE_BUNDLE_LIMITS.raw_bytes
    && objectCount <= PRUNE_EVIDENCE_BUNDLE_LIMITS.object_count
    && snapshot.required_raw_byte_size === snapshot.objects.reduce((sum, object) => sum + object.byte_size, 0)
    && original.required_raw_byte_size === original.objects.reduce((sum, object) => sum + object.byte_size, 0),
  'original_metadata_capture_limit');
  return { rawBytes, objectCount };
}

export function encodePruneEvidenceBundle(envelope) {
  const { rawBytes, objectCount } = validateEvidenceEnvelope(envelope);
  const payload = { schema_version: 1,
    kind: 'uk_aq_jsongen_prune_original_evidence_bundle',
    format: 'canonical_json_gzip_v1', original_final_evidence: envelope };
  const json = canonicalJson(payload);
  check(json.length <= PRUNE_EVIDENCE_BUNDLE_LIMITS.json_bytes, 'original_evidence_bundle_json_limit');
  const compressed = gzipSync(json, { level: 6, mtime: 0 });
  check(compressed.length > 0 && compressed.length <= PRUNE_EVIDENCE_BUNDLE_LIMITS.compressed_bytes,
    'original_evidence_bundle_compressed_limit');
  return { body: compressed, byte_size: compressed.length, sha256: sha256Hex(compressed),
    json_byte_size: json.length, json_sha256: sha256Hex(json), object_count: objectCount,
    raw_byte_size: rawBytes };
}

export function decodePruneEvidenceBundle({ compressed, reference, expected }) {
  check(Buffer.isBuffer(compressed) && Number.isSafeInteger(reference?.byte_size)
    && reference.byte_size > 0 && reference.byte_size <= PRUNE_EVIDENCE_BUNDLE_LIMITS.compressed_bytes
    && compressed.length === reference.byte_size && SHA.test(reference.sha256 || '')
    && sha256Hex(compressed) === reference.sha256
    && Number.isSafeInteger(reference.json_byte_size) && reference.json_byte_size > 0
    && reference.json_byte_size <= PRUNE_EVIDENCE_BUNDLE_LIMITS.json_bytes
    && SHA.test(reference.json_sha256 || ''), 'evidence_bundle_reference_bytes');
  let json;
  try { json = gunzipSync(compressed, { maxOutputLength: reference.json_byte_size }); }
  catch { fail('evidence_bundle_decompression_failed'); }
  check(json.length === reference.json_byte_size && sha256Hex(json) === reference.json_sha256,
    'evidence_bundle_json_bytes');
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)); }
  catch { fail('evidence_bundle_invalid_json'); }
  check(canonicalJson(payload).equals(json) && payload?.schema_version === 1
    && payload.kind === 'uk_aq_jsongen_prune_original_evidence_bundle'
    && payload.format === 'canonical_json_gzip_v1'
    && Object.keys(payload).length === 4, 'evidence_bundle_schema');
  const envelope = payload.original_final_evidence;
  validateEvidenceEnvelope(envelope);
  check(!expected || (envelope.environment === expected.environment
    && envelope.writer.identity === expected.writer_identity
    && envelope.writer.invocation_id === expected.invocation_id
    && envelope.writer.attempt_id === expected.attempt_id
    && envelope.writer.git_sha === expected.writer_git_sha
    && envelope.connector_id === expected.connector_id && envelope.day_utc === expected.day_utc),
  'evidence_bundle_invocation_mismatch');
  return envelope;
}
