// Optional PostgreSQL gate evidence only. This never declares JSONgen VERIFIED.
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
  // The schema requires a byte-pinned connector manifest for a preparation.
  // Without one, keep the honest gate-only state.
  const bytes = manifest?.sha256 && manifest?.byte_size
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
