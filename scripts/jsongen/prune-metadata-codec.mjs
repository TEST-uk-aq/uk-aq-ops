// Inline transport only. Original outbox bytes remain the sole durable source.
// Decoding proves byte integrity, never writer origin or canonical verification.
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalJson } from './schema.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

export const PRUNE_METADATA_JSON_LIMIT = 16 * 1024 ** 2;
const RAW_LIMIT = 8 * 1024 ** 2;
const OBJECT_LIMIT = 4096;
const fail = code => { throw Object.assign(new Error(code), { original_authority_code: code }); };
const check = (ok, code = 'contradictory_original_metadata_encoding') => { if (!ok) fail(code); };
const markerFor = (original, digest) => {
  const { objects, before, binding, ...description } = original;
  return { ...description, schema_version: 2,
    representation: 'inline_original_metadata_gzip_v1', evidence_sha256: digest,
    ...(before ? { before: { state: before.state, reason: before.reason || null } } : {}),
    ...(binding ? { binding: { state: binding.state, reason: binding.reason || null } } : {}) };
};

function validatePayload(value) {
  check(value?.schema_version === 1 && value.kind === 'uk_aq_prune_inline_original_metadata');
  const final = value.original_metadata_snapshot;
  const original = value.original_authority_extension;
  check(final?.schema_version === 1 && original?.schema_version === 1);
  check(['not_captured', 'exact_writer_metadata_captured_unverified'].includes(final.completeness)
    && original.kind === 'uk_aq_prune_original_scope_binding_authority'
    && ['captured', 'unavailable', 'contradictory', 'oversized'].includes(original.completeness));
  const groups = [final, original];
  let totalBytes = 0; let totalObjects = 0;
  for (const group of groups) {
    const objects = group.objects || [];
    check(Array.isArray(objects));
    if (group.completeness === 'exact_writer_metadata_captured_unverified' || group.completeness === 'captured')
      check(objects.length > 0 && group.required_object_count === objects.length);
    let bytes = 0;
    const seen = new Set();
    for (const object of objects) {
      const id = `${object.phase || 'final'}:${object.key}`;
      check(!seen.has(id) && typeof object.key === 'string' && object.key.endsWith('.json')
        && Number.isSafeInteger(object.byte_size) && object.byte_size > 0 && object.byte_size <= 1024 ** 2
        && typeof object.bytes_base64 === 'string'
        && object.bytes_base64.length === 4 * Math.ceil(object.byte_size / 3)
        && /^[a-f0-9]{64}$/.test(object.sha256 || ''));
      seen.add(id);
      const body = Buffer.from(object.bytes_base64, 'base64');
      check(body.length === object.byte_size && body.toString('base64') === object.bytes_base64
        && sha256Hex(body) === object.sha256);
      bytes += body.length; totalObjects++;
      check(bytes + totalBytes <= RAW_LIMIT && totalObjects <= OBJECT_LIMIT, 'original_metadata_capture_limit');
    }
    if (group.required_raw_byte_size !== undefined && objects.length) check(bytes === group.required_raw_byte_size);
    totalBytes += bytes;
  }
  return value;
}

export function encodePruneMetadataEvidence({ original_metadata_snapshot, original_authority_extension }) {
  const value = validatePayload({ schema_version: 1, kind: 'uk_aq_prune_inline_original_metadata',
    original_metadata_snapshot, original_authority_extension });
  const bytes = canonicalJson(value);
  check(bytes.length <= PRUNE_METADATA_JSON_LIMIT, 'original_metadata_encoding_limit');
  const gzip = gzipSync(bytes, { level: 6, mtime: 0 });
  // Base64 alone must fit the UNCHANGED total SQL bytea envelope. The caller
  // subsequently checks the complete outer envelope, including source evidence.
  check(gzip.length <= 786432, 'metadata_payload_exceeds_1mib');
  return { schema_version: 1, codec: 'canonical_json_gzip_v1',
    sha256: sha256Hex(gzip), byte_size: gzip.length,
    json_sha256: sha256Hex(bytes), json_byte_size: bytes.length, bytes_base64: gzip.toString('base64') };
}

export function decodePruneMetadataEvidence(envelope) {
  const pack = envelope.original_metadata_evidence;
  if (pack === undefined) {
    check(envelope.original_metadata_snapshot?.schema_version === 1
      && (!envelope.original_authority_extension || envelope.original_authority_extension.schema_version === 1),
    'unsupported_original_metadata_encoding');
    validatePayload({ schema_version: 1, kind: 'uk_aq_prune_inline_original_metadata',
      original_metadata_snapshot: envelope.original_metadata_snapshot,
      original_authority_extension: envelope.original_authority_extension || { schema_version: 1,
        kind: 'uk_aq_prune_original_scope_binding_authority', completeness: 'unavailable' } });
    return { original_metadata_snapshot: envelope.original_metadata_snapshot,
      original_authority_extension: envelope.original_authority_extension };
  }
  check(pack?.schema_version === 1 && pack.codec === 'canonical_json_gzip_v1', 'unsupported_original_metadata_encoding');
  check(envelope.original_metadata_snapshot?.schema_version === 2 && envelope.original_authority_extension?.schema_version === 2,
    'unsupported_original_metadata_encoding');
  check(Number.isSafeInteger(pack.byte_size) && pack.byte_size > 0 && pack.byte_size <= 786432
    && Number.isSafeInteger(pack.json_byte_size) && pack.json_byte_size > 0 && pack.json_byte_size <= PRUNE_METADATA_JSON_LIMIT
    && typeof pack.bytes_base64 === 'string' && pack.bytes_base64.length === 4 * Math.ceil(pack.byte_size / 3));
  const gzip = Buffer.from(pack.bytes_base64, 'base64');
  check(gzip.length === pack.byte_size && gzip.toString('base64') === pack.bytes_base64 && sha256Hex(gzip) === pack.sha256);
  const bytes = gunzipSync(gzip, { maxOutputLength: pack.json_byte_size });
  check(bytes.length === pack.json_byte_size && sha256Hex(bytes) === pack.json_sha256);
  const value = validatePayload(JSON.parse(bytes));
  check(canonicalJson(value).equals(bytes));
  for (const field of ['original_metadata_snapshot', 'original_authority_extension']) {
    check(canonicalJson(envelope[field]).equals(canonicalJson(markerFor(value[field], pack.json_sha256))));
  }
  return value;
}

export function compactPruneMetadataEvidence(envelope) {
  const pack = encodePruneMetadataEvidence(envelope);
  for (const field of ['original_metadata_snapshot', 'original_authority_extension']) {
    envelope[field] = markerFor(envelope[field], pack.json_sha256);
  }
  envelope.original_metadata_evidence = pack;
}
