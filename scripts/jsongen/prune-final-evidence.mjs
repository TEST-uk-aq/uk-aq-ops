// Writer-lifetime preparation only. This is deliberately neither a retained
// attestation nor an authenticated Stage 1 verified-change receipt.
import { canonicalJson } from './schema.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

const same = (a, b) => canonicalJson(a).equals(canonicalJson(b));
const reference = value => value && typeof value.key === 'string'
  && /^[a-f0-9]{64}$/.test(value.sha256 || '')
  && Number.isSafeInteger(value.byte_size) && value.byte_size > 0
    ? { key: value.key, sha256: value.sha256, byte_size: value.byte_size } : null;
const references = values => (Array.isArray(values) ? values : [])
  .map(reference).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key));

export function preparePruneOriginalFinalEvidence({ pending, connector, finalization,
  runId, dayUtc, connectorId, writerGitSha }) {
  if (pending?.state !== 'put_acknowledged_unverified'
    || pending.pending_evidence?.writer?.invocation_id !== runId
    || pending.pending_evidence?.connector_id !== connectorId
    || pending.pending_evidence?.day_utc !== dayUtc
    || connector?.run_id !== runId
    || connector?.day_utc !== dayUtc
    || connector?.connector_id !== connectorId
    || connector?.connector_manifest?.key !== connector?.manifest_key
    || finalization?.ok !== true
    || !finalization.affected_days_utc?.includes(dayUtc))
    throw new Error('JSONgen final preparation lacks the original pending, connector, or batch identity');
  const expected = pending.pending_evidence.scope.pollutant_partitions;
  const actual = connector.pollutant_manifests;
  if (!Array.isArray(actual) || expected.length !== actual.length)
    throw new Error('JSONgen final preparation lacks complete original pollutant scope');
  for (const partition of expected) {
    const child = actual.find(entry => entry.pollutant_code === partition.pollutant_code);
    if (!child || child.row_count !== partition.row_count
      || child.observation_content_hash !== partition.observation_content_hash
      || child.observation_content_hash_contract_version !== partition.observation_content_hash_contract_version
      || !same(child.verification_status_counts, partition.verification_status_counts))
      throw new Error('JSONgen frozen source does not match original canonical pollutant content');
  }
  const dayResult = (finalization.day_results || []).find(entry => entry.day_utc === dayUtc);
  const envelope = {
    schema_version: 1,
    kind: 'uk_aq_jsongen_prune_original_final_evidence_preparation',
    authority_state: 'precommit_prepared_unverified',
    environment: 'TEST', index_generation: 'v3',
    writer: { identity: 'prune_daily_v3', invocation_id: runId, attempt_id: runId,
      git_sha: writerGitSha || null },
    connector_id: connectorId, day_utc: dayUtc,
    pending: { intent_id: pending.intent_id, object: pending.source,
      preparation_sha256: pending.preparation_sha256,
      source_evidence_sha256: pending.source_evidence_sha256,
      source_identity: pending.pending_evidence.source_identity,
      original_source_status: pending.pending_evidence.original_source_status,
      effective_verification_status: pending.pending_evidence.effective_verification_status },
    original_connector_publication: connector,
    original_final_batch: {
      affected_days_utc: [...finalization.affected_days_utc],
      canonical_aggregate_references: references(finalization.canonical_aggregate_result?.aggregate_manifests),
      day_manifest: reference(dayResult?.day_manifest),
      exact_scope_references: references(connector.scoped_roots?.map(entry => entry.reference)),
      latest_global_references: references(finalization.v3_publication?.latest_global?.objects),
      observed_boundary: 'validated_v3_run_finalizer_returned',
    },
    original_candidate_connector_gate: {
      transaction_state: 'not_asserted_in_preparation',
      candidate_run_id: runId,
      connector_manifest_key: connector.manifest_key,
      connector_manifest_hash: connector.manifest_hash,
      source_identity: pending.pending_evidence.source_identity,
      expected_ready_marker: 'PRUNE_FIRST_DELETE_READY:v1',
      retained_transaction_proof: false,
    },
    unresolved: [
      'pending_private_readback_not_in_original_prune_path',
      'original_gate_acceptance_is_external_to_prepared_envelope',
      'mutable_canonical_parent_and_index_bytes_not_retained_as_original_snapshot',
      'current_canonical_status_and_binding_authority_not_independently_authenticated',
      'evidence_envelope_retention_depends_on_optional_outbox_commit',
    ],
  };
  const bytes = canonicalJson(envelope);
  if (bytes.length > 1024 * 1024)
    throw new Error('JSONgen final preparation exceeds bounded metadata size');
  return { envelope, bytes, sha256: sha256Hex(bytes), byte_size: bytes.length,
    retention_state: 'transient_writer_memory_only' };
}
