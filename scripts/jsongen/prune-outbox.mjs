import { isEnvironmentName } from './environment.mjs';
// Optional PostgreSQL gate evidence only. This never declares JSONgen VERIFIED.
import { BUCKET, canonicalJson } from './schema.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

export const PRUNE_GATE_ACCEPTANCE_RELATION = 'uk_aq_ops.prune_jsongen_gate_acceptance_outbox';
const STATES = new Set([
  'not_attempted', 'no_intent', 'intent_issued',
  'put_acknowledged_unverified', 'put_ambiguous', 'put_failed',
]);

export function describePruneGateOutboxEvidence({ pending, connector, finalPreparation }) {
  const disposition = pending?.state || 'not_attempted';
  if (!STATES.has(disposition)) throw new Error('Unknown Prune pending-source disposition');
  const object = pending?.source;
  const intentId = pending?.intent_id || null;
  if ((intentId === null) !== (object == null)) {
    throw new Error('Prune pending intent and object reference must be retained together');
  }
  if (disposition === 'put_acknowledged_unverified' && !intentId) {
    throw new Error('Acknowledged Prune pending source lacks its intent');
  }
  const manifest = connector?.connector_manifest;
  const snapshot = finalPreparation?.envelope?.original_metadata_snapshot;
  const pack = finalPreparation?.envelope?.original_metadata_evidence;
  const bundle = pack?.codec === 'immutable_r2_json_gzip_v1'
    ? pack.reference : null;
  const completeMetadata = snapshot?.schema_version === 1
    || (snapshot?.schema_version === 2
      && snapshot.representation === 'inline_original_metadata_gzip_v1'
      && pack?.schema_version === 1 && pack.codec === 'canonical_json_gzip_v1'
      && snapshot.evidence_sha256 === pack.json_sha256)
    || (snapshot?.schema_version === 3
      && snapshot.representation === 'immutable_r2_json_gzip_v1'
      && snapshot.completeness === 'externalized_unverified'
      && finalPreparation?.envelope?.original_authority_extension?.schema_version === 3
      && finalPreparation.envelope.original_authority_extension.completeness === 'externalized_unverified'
      && bundle?.key === finalPreparation.bundle_reference?.key
      && bundle?.sha256 === finalPreparation.bundle_reference?.sha256
      && bundle?.byte_size === finalPreparation.bundle_reference?.byte_size
      && bundle?.intent_id === finalPreparation.bundle_reference?.intent_id
      && finalPreparation.bundle?.sha256 === bundle?.sha256
      && finalPreparation.bundle?.byte_size === bundle?.byte_size);
  // Retain final bytes only when every required writer-produced metadata byte
  // was captured. The DB row can still retain gate acceptance without them.
  const evidenceComplete = completeMetadata
    && ['exact_writer_metadata_captured_unverified', 'externalized_unverified']
      .includes(snapshot?.completeness);
  const bytes = manifest?.sha256 && manifest?.byte_size && evidenceComplete
    ? finalPreparation?.bytes ?? null : null;
  return {
    connector_manifest_byte_sha256: manifest?.sha256 || null,
    connector_manifest_byte_size: manifest?.byte_size ?? null,
    pending_disposition: disposition,
    pending_intent_id: intentId,
    pending_bucket: object?.bucket || null,
    pending_object_key: object?.key || null,
    pending_compressed_sha256: object?.sha256 || null,
    pending_compressed_byte_size: object?.byte_size ?? null,
    pending_ndjson_sha256: object?.json_sha256 || null,
    pending_ndjson_byte_size: object?.json_byte_size ?? null,
    original_source_status_provenance:
      pending?.pending_evidence?.original_source_status?.classification || 'not_captured',
    final_evidence_state: bytes ? 'prepared_unverified' : 'not_captured',
  };
}

// Deterministic projection of an ORIGINAL COMMITTED outbox row. The live writer
// calls this only after an explicit PostgreSQL COMMIT acknowledgement; a future
// independently authenticated reader can reconstruct the same message from that
// immutable row. This function validates shape; it does not authenticate callers,
// pending bytes, canonical metadata or a VERIFIED receipt. No delivery occurs.
export function preparePrunePostCommitHandover(acceptance) {
  const a = acceptance;
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const uuid = value => typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
  const positive = value => (typeof value === 'number'
    || (typeof value === 'string' && /^[1-9]\d*$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const reject = () => { throw new Error('Incomplete original Prune acceptance reference'); };
  if (a?.event_schema_version !== 1 || !isEnvironmentName(a.environment)
    || a.writer_identity !== 'prune_daily_v3' || !uuid(a.run_id) || a.attempt_id !== a.run_id
    || !/^[a-f0-9]{40}$/.test(a.writer_git_sha || '')
    || !Number.isSafeInteger(a.connector_id) || a.connector_id <= 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(a.day_utc || '')
    || !sha(a.source_content_hash) || Number(a.source_content_hash_contract_version) !== 1
    || !positive(a.source_content_hash_row_count)
    || !sha(a.history_manifest_hash)
    || a.history_manifest_key !== `history/v3/observations/day_utc=${a.day_utc}/connector_id=${a.connector_id}/manifest.json`
    || a.gate_completion_source !== 'prune_daily_phase_b'
    || a.candidate_ready_marker !== 'PRUNE_FIRST_DELETE_READY:v1'
    || !STATES.has(a.pending_disposition)
    || !['not_captured', 'prepared_unverified'].includes(a.final_evidence_state)) reject();
  const completedAt = new Date(a.gate_history_completed_at);
  if (!a.gate_history_completed_at || !Number.isFinite(completedAt.getTime())) reject();
  let pendingObject = null;
  if (a.pending_intent_id != null) {
    if (!sha(a.pending_intent_id) || a.pending_bucket !== BUCKET
      || !sha(a.pending_compressed_sha256) || !sha(a.pending_ndjson_sha256)
      || !positive(a.pending_compressed_byte_size) || Number(a.pending_compressed_byte_size) > 8 * 1024 ** 2
      || !positive(a.pending_ndjson_byte_size) || Number(a.pending_ndjson_byte_size) > 32 * 1024 ** 2
      || a.pending_object_key !== `managed/jsongen/v1/pending/unverified/prune_daily_v3/connector_id=${a.connector_id}`
        + `/day_utc=${a.day_utc}/invocation=${a.run_id}/compressed_sha256=${a.pending_compressed_sha256}`
        + `/uncompressed_sha256=${a.pending_ndjson_sha256}.ndjson.gz`) reject();
    pendingObject = { bucket: a.pending_bucket, key: a.pending_object_key,
      sha256: a.pending_compressed_sha256, byte_size: Number(a.pending_compressed_byte_size),
      json_sha256: a.pending_ndjson_sha256, json_byte_size: Number(a.pending_ndjson_byte_size) };
  } else if (['intent_issued', 'put_acknowledged_unverified'].includes(a.pending_disposition)) reject();
  const hasEvidence = a.final_evidence_state === 'prepared_unverified';
  if (hasEvidence && (!sha(a.final_evidence_sha256) || !positive(a.final_evidence_byte_size)
    || Number(a.final_evidence_byte_size) > 1024 ** 2
    || a.pending_disposition !== 'put_acknowledged_unverified'
    || !sha(a.connector_manifest_byte_sha256) || !positive(a.connector_manifest_byte_size))) reject();
  const readiness = a.pending_disposition !== 'put_acknowledged_unverified'
    ? 'incomplete_pending_source' : !hasEvidence ? 'incomplete_original_evidence'
      : 'ready_for_independent_authentication';
  const message = {
    schema_version: 1, kind: 'uk_aq_jsongen_prune_post_commit_handover',
    environment: a.environment, index_generation: 'v3', authority_state: 'requires_independent_authentication',
    writer: { identity: a.writer_identity, invocation_id: a.run_id,
      attempt_id: a.attempt_id, git_sha: a.writer_git_sha },
    acceptance: { relation: PRUNE_GATE_ACCEPTANCE_RELATION, event_schema_version: 1,
      key: { environment: a.environment, writer_identity: a.writer_identity,
        run_id: a.run_id, attempt_id: a.attempt_id, day_utc: a.day_utc, connector_id: a.connector_id },
      gate_history_completed_at: completedAt.toISOString(),
      candidate_ready_marker: a.candidate_ready_marker },
    source_identity: { source_content_hash: a.source_content_hash,
      source_content_hash_contract_version: Number(a.source_content_hash_contract_version),
      source_content_hash_row_count: Number(a.source_content_hash_row_count) },
    original_connector_manifest: { key: a.history_manifest_key, manifest_hash: a.history_manifest_hash,
      sha256: a.connector_manifest_byte_sha256 || null,
      byte_size: a.connector_manifest_byte_size == null ? null : Number(a.connector_manifest_byte_size) },
    pending: { disposition: a.pending_disposition, intent_id: a.pending_intent_id || null,
      object: pendingObject },
    final_evidence: { state: a.final_evidence_state,
      sha256: hasEvidence ? a.final_evidence_sha256 : null,
      byte_size: hasEvidence ? Number(a.final_evidence_byte_size) : null },
    readiness,
  };
  const bytes = canonicalJson(message);
  if (bytes.byteLength > 4096) reject();
  return { state: 'reference_prepared', delivery_state: 'not_attempted',
    ready_for_independent_authentication: readiness === 'ready_for_independent_authentication',
    message, sha256: sha256Hex(bytes), byte_size: bytes.byteLength };
}
