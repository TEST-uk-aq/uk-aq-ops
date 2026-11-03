// Called only inside independently authenticated immutable original outbox
// processing. No exported token, new receipt version or durable confirmation.
import { same } from './schema.mjs';
import { evidence } from './limits.mjs';
import { exactIdentity as id, exactMetadataArtifact, authenticateExactOnlyMetadata } from './exact-only-metadata.mjs';
import { EXACT_ONLY_DIRECT_VERIFIER_V3 } from '../../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs';
import { OBSERVATION_HISTORY_OFFLINE_INSPECTOR_V3 } from '../../workers/shared/uk_aq_observation_history_target_writer.mjs';
import { scopedRootDescriptor, validateObservationHistoryExactLeafIndexV3LatestRegistry }
  from '../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';

const check = (ok, field) => evidence(ok, 'contradictory_original_evidence', `Original exact-only authority mismatch: ${field}`);
const refs = values => values.map(id).sort((a, b) => a.key.localeCompare(b.key));
const fields = (value, expected) => value && same(Object.keys(value).sort(), expected.sort());

export function authenticatePruneExactOnlyCompletion({ envelope: e, row, metadata, source, schema2Roots }) {
  const batch = e.original_final_batch, completion = batch.exact_only_completion;
  if (!schema2Roots.length) {
    check(!Object.hasOwn(batch, 'exact_only_completion'), 'completion_without_schema2_selection');
    return null;
  }
  // Explicit Prune checked-batch representation only. The older generic
  // schema-1/run completion is not reinterpreted as this original authority.
  check(completion?.schema_version === 2 && completion.kind === 'uk_aq_prune_exact_only_completion'
    && fields(completion, ['schema_version', 'kind', 'authority_state', 'finalisation_complete', 'invocation_id',
      'dataset_id', 'source_evidence_sha256', 'source_identity', 'scopes', 'batch_finalization', 'latest'])
    && completion.authority_state === 'prepared_before_original_gate_transaction'
    && completion.finalisation_complete === true && !Object.hasOwn(completion, 'run')
    && completion.invocation_id === row.run_id && completion.invocation_id === e.writer.invocation_id
    && completion.dataset_id === e.pending.object.key && completion.dataset_id === row.pending_object_key
    && completion.source_evidence_sha256 === e.pending.source_evidence_sha256
    && same(completion.source_identity, e.pending.source_identity), 'same_original_pending_dataset');
  check(schema2Roots.length === source.scope.pollutant_partitions.length
    && Array.isArray(completion.scopes) && completion.scopes.length === schema2Roots.length
    && same(refs(completion.scopes.map(s => s.selector)), refs(schema2Roots.map(r => r.reference))),
  'complete_original_scope_set');
  const checked = completion.batch_finalization;
  check(fields(checked, ['affected_days_utc', 'canonical_aggregate_references', 'latest_global_references',
    'exact_scope_publication_count', 'exact_scope_references', 'day_manifests'])
    && same(checked.affected_days_utc, batch.affected_days_utc)
    && same(checked.canonical_aggregate_references, batch.canonical_aggregate_references)
    && same(checked.latest_global_references, batch.latest_global_references)
    && checked.exact_scope_publication_count === batch.validation.exact_scope_publication_count
    && Array.isArray(checked.exact_scope_references) && Array.isArray(checked.day_manifests), 'checked_batch_identity');
  // The completion covers the required whole batch; this original event covers
  // just its connector/day. Other batch references must still be pinned in the
  // original snapshot, never assumed to be additional source for this event.
  for (const [field, role] of [['day_manifests', 'day_manifest'], ['exact_scope_references', 'exact_v3_index']]) {
    check(checked[field].length > 0 && new Set(checked[field].map(r => r.key)).size === checked[field].length,
      `checked_batch.${field}`);
    if (field === 'day_manifests') checked[field].forEach(r => metadata.lookup(r, role));
  }
  check(same(refs(checked.day_manifests), refs(batch.affected_days_utc.map(day => {
    const o = metadata.objects.get(`history/v3/observations/day_utc=${day}/manifest.json`);
    check(o, 'checked_day_bytes'); return o;
  }))) && checked.exact_scope_references.filter(r => batch.exact_scope_references.some(b => b.key === r.key))
    .length === batch.exact_scope_references.length
    && batch.exact_scope_references.every(r => checked.exact_scope_references.some(b => same(id(r), id(b))))
    && batch.latest_global_references.some(r => same(id(r), completion.latest)), 'checked_batch_complete_membership');
  const latestObject = metadata.objects.get(completion.latest.key);
  const registry = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: {
    ...id(latestObject), payload: latestObject.value, body: Buffer.from(latestObject.bytes_base64, 'base64').toString(),
    kind: 'observation_history_index_v3_latest_global', publication_stage: 'latest_global' } });
  check(checked.exact_scope_references.every(ref => registry.roots.some(root => same(id(root), id(ref))))
    && new Set(checked.exact_scope_references.map(ref => {
      const root = registry.roots.find(r => r.key === ref.key);
      check(batch.affected_days_utc.includes(root.day_utc), 'checked_scope_day');
      return `${root.connector_id}:${root.day_utc}`;
    })).size === checked.exact_scope_publication_count, 'whole_checked_batch_latest_membership');
  const seen = new Set();
  for (const s of completion.scopes) {
    const root = schema2Roots.find(r => same(id(r.reference), s.selector));
    check(fields(s, ['scope', 'verifier_version', 'inspector', 'physical_identity', 'row_count', 'canonical_source_manifest',
      'selector', 'leaves', 'canonical_chain', 'files'])
      && root && same(s.scope, root.scope) && !seen.has(s.selector.key), 'original_scope_identity');
    seen.add(s.selector.key);
    check(s.verifier_version === EXACT_ONLY_DIRECT_VERIFIER_V3 && same(s.inspector, OBSERVATION_HISTORY_OFFLINE_INSPECTOR_V3),
      'accepted_original_inspector');
    const child = e.original_connector_publication.pollutant_manifests.find(p => p.pollutant_code === s.scope.pollutant_code);
    const canonical = metadata.lookup(child.manifest, 'canonical_manifest');
    const selected = metadata.objects.get(s.selector.key);
    const selector = exactMetadataArtifact(selected);
    const leaves = Object.values(selected.value.leaves_by_timeseries_id).map(t => {
      const ref = { key: t[0], byte_size: t[1], sha256: t[2] };
      metadata.lookup(ref, 'exact_v3_index');
      return exactMetadataArtifact({ ...metadata.objects.get(ref.key), canonicalSource: selector.payload.canonical_source_manifest }, 'leaf');
    });
    const direct = authenticateExactOnlyMetadata({ selector, leaves, canonical, canonicalReference: child.manifest, scope: s.scope });
    check(same(s.canonical_source_manifest, direct.source) && same(s.physical_identity, direct.physical_identity)
      && s.row_count === canonical.row_count && same(refs(s.leaves), refs(leaves)), 'direct_original_selection');
    const day = row.day_utc, base = 'history/v3/observations';
    const chain = [`${base}/_manifests/manifest.json`, `${base}/_manifests/year=${day.slice(0, 4)}/manifest.json`,
      `${base}/_manifests/year=${day.slice(0, 4)}/month=${day.slice(5, 7)}/manifest.json`,
      `${base}/day_utc=${day}/manifest.json`, row.history_manifest_key, child.manifest.key];
    check(same(s.canonical_chain, chain.map(k => id(metadata.objects.get(k))))
      && same(registry.roots.find(r => r.key === selector.key), scopedRootDescriptor(selector)), 'original_hierarchy_and_latest');
    check(Array.isArray(s.files) && s.files.length === canonical.files.length
      && s.files.every((f, i) => {
        const c = canonical.files[i], claims = leaves.flatMap(l => l.payload.files).filter(file => file.key === f.key);
        return fields(f, ['key', 'byte_size', 'sha256', 'row_count', 'row_group_count', 'etag'])
          && f.key === c.key && f.byte_size === c.bytes && f.sha256 === c.etag_or_hash && f.row_count === c.row_count
          && typeof f.etag === 'string' && f.etag.length > 0 && claims.length > 0
          && claims.every(file => file.row_group_count === f.row_group_count && (!file.etag || file.etag === f.etag));
      }), 'complete_original_physical_files');
  }
  return completion.dataset_id;
}
