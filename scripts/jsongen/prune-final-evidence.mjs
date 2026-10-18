// Writer-lifetime preparation only. This is deliberately neither a retained
// attestation nor an authenticated Stage 1 verified-change receipt.
import { BUCKET, canonicalJson } from './schema.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { preparePruneOriginalAuthorityExtension } from './prune-original-metadata.mjs';
import { compactPruneMetadataEvidence } from './prune-metadata-codec.mjs';

const same = (a, b) => canonicalJson(a).equals(canonicalJson(b));
const reference = value => value && typeof value.key === 'string'
  && /^[a-f0-9]{64}$/.test(value.sha256 || '')
  && Number.isSafeInteger(value.byte_size) && value.byte_size > 0
    ? { key: value.key, sha256: value.sha256, byte_size: value.byte_size } : null;
const references = values => (Array.isArray(values) ? values : [])
  .map(reference).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key));

export function preparePruneOriginalFinalEvidence({ pending, connector, finalization,
  runId, dayUtc, connectorId, writerGitSha, sourceIdentity, originalMetadataSnapshot = null,
  originalAuthorityCapture = null }) {
  if (pending?.state !== 'put_acknowledged_unverified'
    || pending.pending_evidence?.writer?.invocation_id !== runId
    || pending.pending_evidence?.connector_id !== connectorId
    || pending.pending_evidence?.day_utc !== dayUtc
    || connector?.run_id !== runId
    || connector?.day_utc !== dayUtc
    || connector?.connector_id !== connectorId
    || connector?.connector_manifest?.key !== connector?.manifest_key
    || finalization?.ok !== true
    || finalization.canonical_aggregate_result?.canonical_aggregate_authority_verified !== true
    || finalization.canonical_aggregate_result?.parent_state_reread_under_lock !== true
    || !same(finalization.canonical_aggregate_result.affected_days_utc, finalization.affected_days_utc)
    || !Array.isArray(finalization.v3_publication?.exact_scopes)
    || !finalization.v3_publication.exact_scopes.length
    || finalization.v3_publication.exact_scopes.some(scope => scope?.ok !== true)
    || finalization.v3_publication.latest_global?.ok !== true
    || !finalization.affected_days_utc?.includes(dayUtc))
    throw new Error('JSONgen final preparation lacks the original pending, connector, or batch identity');
  const sourceEvidence = pending.pending_evidence;
  const { signed_upload: signedUpload, ...unsignedEvidence } = sourceEvidence;
  const expectedPendingKey = `managed/jsongen/v1/pending/unverified/prune_daily_v3/connector_id=${connectorId}`
    + `/day_utc=${dayUtc}/invocation=${runId}/compressed_sha256=${pending.source?.sha256}`
    + `/uncompressed_sha256=${pending.source?.json_sha256}.ndjson.gz`;
  if (sourceEvidence.writer.attempt_id !== runId
    || !same(sourceEvidence.source_identity, sourceIdentity)
    || sourceEvidence.scope?.kind !== 'complete_connector_day'
    || sourceEvidence.scope.connector_id !== connectorId || sourceEvidence.scope.day_utc !== dayUtc
    || !Array.isArray(sourceEvidence.scope.physical_timeseries_days)
    || !sourceEvidence.scope.physical_timeseries_days.length
    || sourceEvidence.original_ndjson?.row_count !== sourceIdentity.source_content_hash_row_count
    || sourceEvidence.original_ndjson.sha256 !== pending.source?.json_sha256
    || sourceEvidence.original_ndjson.byte_size !== pending.source?.json_byte_size
    || sourceEvidence.compressed_ndjson_gzip?.sha256 !== pending.source?.sha256
    || sourceEvidence.compressed_ndjson_gzip.byte_size !== pending.source?.byte_size
    || pending.source?.bucket !== BUCKET || pending.source.key !== expectedPendingKey
    || signedUpload?.intent_id !== pending.intent_id || !same(signedUpload.object, pending.source)
    || signedUpload.disposition !== 'put_acknowledged_unverified'
    || sha256Hex(canonicalJson(unsignedEvidence)) !== pending.source_evidence_sha256
    || sha256Hex(canonicalJson(sourceEvidence)) !== pending.preparation_sha256)
    throw new Error('JSONgen final preparation differs from original complete frozen source evidence');
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
  if (originalMetadataSnapshot?.completeness === 'exact_writer_metadata_captured_unverified') {
    const objects = originalMetadataSnapshot.objects;
    const contains = reference => objects.some(object =>
      object.key === reference?.key && object.sha256 === reference?.sha256
      && object.byte_size === reference?.byte_size
      && object.canonical_bucket === connector.connector_manifest.bucket);
    if (originalMetadataSnapshot.day_utc !== dayUtc
      || originalMetadataSnapshot.connector_id !== connectorId
      || originalMetadataSnapshot.invocation_id !== runId
      || originalMetadataSnapshot.writer_git_sha !== writerGitSha
      || !same(originalMetadataSnapshot.affected_days_utc, finalization.affected_days_utc)
      || !Array.isArray(objects)
      || !contains(connector.connector_manifest)
      || actual.some(child => !contains(child.manifest))
      || (connector.scoped_roots || []).some(root => !contains(root.reference))) {
      throw new Error('JSONgen original metadata snapshot is not bound to the connector publication');
    }
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
      // Retain the entire reproducible source description, including exact
      // physical membership, pollutant content/status counts and byte digests.
      // Its original hashes can be authenticated later without a Parquet read.
      source_evidence: sourceEvidence,
      original_source_status: pending.pending_evidence.original_source_status,
      effective_verification_status: pending.pending_evidence.effective_verification_status },
    original_connector_publication: connector,
    original_metadata_snapshot: originalMetadataSnapshot?.completeness ===
      'exact_writer_metadata_captured_unverified'
      ? originalMetadataSnapshot
      : { schema_version: 1, completeness: 'not_captured',
        reason: originalMetadataSnapshot?.reason || 'original_metadata_snapshot_unavailable',
        required_object_count: originalMetadataSnapshot?.required_object_count ?? null,
        required_raw_byte_size: originalMetadataSnapshot?.required_raw_byte_size ?? null },
    original_final_batch: {
      affected_days_utc: [...finalization.affected_days_utc],
      validation: { boundary: 'validatePhaseBV3RunFinalizationResult',
        canonical_aggregate_authority_verified: finalization.canonical_aggregate_result.canonical_aggregate_authority_verified,
        parent_state_reread_under_lock: finalization.canonical_aggregate_result.parent_state_reread_under_lock,
        exact_scope_publication_count: finalization.v3_publication.exact_scopes.length,
        all_exact_scope_publications_ok: true,
        latest_global_ok: finalization.v3_publication.latest_global.ok },
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
      ...(originalMetadataSnapshot?.completeness === 'exact_writer_metadata_captured_unverified'
        ? [] : ['original_canonical_metadata_bytes_not_completely_captured']),
      'current_canonical_status_and_binding_authority_not_independently_authenticated',
      'evidence_envelope_retention_depends_on_optional_outbox_commit',
    ],
  };
  // Compatible schema-1 addition: neither the legacy metadata group meanings
  // nor the immutable SQL event/version/identity changes. Absence of this
  // versioned extension remains a legacy incomplete event for the consumer.
  envelope.original_authority_extension = preparePruneOriginalAuthorityExtension({
    capture: originalAuthorityCapture, pending, connector,
    finalBatch: envelope.original_final_batch,
    runId, dayUtc, connectorId, writerGitSha, sourceIdentity,
  });
  if (envelope.original_authority_extension.completeness !== 'captured')
    envelope.unresolved.push('original_before_or_binding_authority_not_completely_captured');
  const discardMetadata = (reason, completeSize = null) => {
    const original = envelope.original_authority_extension;
    envelope.original_metadata_snapshot = { schema_version: 1, completeness: 'not_captured', reason,
      required_object_count: originalMetadataSnapshot?.required_object_count ?? null,
      required_raw_byte_size: originalMetadataSnapshot?.required_raw_byte_size ?? null,
      complete_envelope_byte_size: completeSize };
    envelope.original_authority_extension = { schema_version: 1, kind: original.kind,
      completeness: reason.includes('limit') || reason.includes('exceeds') ? 'oversized'
        : reason.includes('contradictory') ? 'contradictory' : 'unavailable', reason,
      before: { state: 'unavailable', reason }, binding: { state: 'unavailable', reason } };
    delete envelope.original_metadata_evidence;
    envelope.unresolved.push('original_canonical_metadata_bytes_not_completely_captured',
      'original_before_or_binding_authority_not_completely_captured');
  };
  // Preserve exact outer schema-1 identity fields required by SQL. Nested v2
  // markers explicitly require the versioned bounded decoder; old readers fail
  // closed. Compression includes BOTH original and final metadata together.
  try { compactPruneMetadataEvidence(envelope); }
  catch (error) { discardMetadata(error.original_authority_code || 'original_metadata_encoding_unavailable'); }
  let bytes = canonicalJson(envelope);
  if (bytes.length > 1024 * 1024) {
    discardMetadata('metadata_payload_exceeds_1mib', bytes.length);
    bytes = canonicalJson(envelope);
  }
  if (bytes.length > 1024 * 1024)
    throw new Error('JSONgen final preparation exceeds bounded metadata size');
  return { envelope, bytes, sha256: sha256Hex(bytes), byte_size: bytes.length,
    retention_state: 'transient_writer_memory_only' };
}
