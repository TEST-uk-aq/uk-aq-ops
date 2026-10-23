// Authenticate retained pre-PUT admission and Core-owned binding metadata.
// This module has no network adapter and cannot read canonical observations.
import { BUCKET, assertReference, canonicalJson, same } from './schema.mjs';
import { assertPruneOriginalIdentity, pruneOriginalPhysicalKey } from './prune-original-identity.mjs';
import { evidence, parseJson } from './limits.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { getObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { OBSERVATIONS_GLOBAL_OPERATION_LOCK_LOGICAL_IDENTITY } from '../../workers/shared/uk_aq_r2_history_writer.mjs';
import { validateR2HistoryV2ObservationsAggregateManifest, serializeR2HistoryV2ObservationsAggregateManifest }
  from '../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { validateCanonicalHistoryV2Manifest } from '../../workers/shared/uk_aq_r2_history_manifest_validation.mjs';
import { validateObservationHistoryExactLeafIndexV3LatestRegistry } from '../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';
import { encodeObservationHistoryIndexV3Json } from '../../workers/shared/uk_aq_observation_history_index_v3.mjs';
import { validateTimeseriesBindingSourceRootManifest, validateTimeseriesBindingSourceRangeManifest,
  timeseriesBindingSourceRangeManifestKey, TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND }
  from '../backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { validTimeseriesBindingSourceState } from '../backup_r2/lib/timeseries_binding_source_state_v2.mjs';
import { validContinuity } from './authority.mjs';
import { PRUNE_EVIDENCE_BUNDLE_LIMITS } from './prune-evidence-bundle.mjs';

const G = getObservationHistoryGeneration('v3');
const check = (ok, field) => evidence(ok, 'invalid_original_scope_authority', `Original scope authority mismatch: ${field}`);
const pin = object => ({ bucket: object.bucket ?? object.canonical_bucket, key: object.key,
  sha256: object.sha256, byte_size: object.byte_size });
export const prunePhysicalKey = pruneOriginalPhysicalKey;

export function authenticatePruneOriginalAuthority({ envelope: e, row, source, budget, bundleMode = false }) {
  const x = e.original_authority_extension;
  check(x?.schema_version === 1 && x.kind === 'uk_aq_prune_original_scope_binding_authority'
    && x.completeness === 'captured' && x.before?.state === 'captured' && x.binding?.state === 'captured', 'complete_extension');
  const bucket = e.original_connector_publication.connector_manifest.bucket;
  check(bucket !== BUCKET && x.capture_boundary === 'original_global_lock_before_canonical_replacement'
    && e.environment === row.environment && source.environment === row.environment
    && same(x.identity, { environment: row.environment, index_generation: 'v3', canonical_bucket: bucket,
      writer: e.writer, connector_id: 1, day_utc: row.day_utc, source_identity: source.source_identity })
    && same(x.lock, { logical_identity: OBSERVATIONS_GLOBAL_OPERATION_LOCK_LOGICAL_IDENTITY,
      owner: 'prune_daily', run_id: row.run_id }), 'writer_source_and_original_global_lock');
  check(same(x.publication, { pending_preparation_sha256: e.pending.preparation_sha256,
    source_evidence_sha256: e.pending.source_evidence_sha256,
    connector_manifest: e.original_connector_publication.connector_manifest,
    original_final_batch_sha256: sha256Hex(canonicalJson(e.original_final_batch)),
    transaction_state: 'prepared_before_original_gate_transaction' }), 'original_publication_relationship');
  const objectLimit = bundleMode ? PRUNE_EVIDENCE_BUNDLE_LIMITS.object_count : 4096;
  const objectByteLimit = bundleMode ? PRUNE_EVIDENCE_BUNDLE_LIMITS.object_bytes : 1024 ** 2;
  const rawByteLimit = bundleMode ? PRUNE_EVIDENCE_BUNDLE_LIMITS.raw_bytes : 8 * 1024 ** 2;
  check(Array.isArray(x.objects) && x.objects.length === x.required_object_count
    && x.objects.length > 0 && x.objects.length <= objectLimit, 'object_membership');
  const objects = new Map(); let bytes = 0;
  for (const object of x.objects) {
    budget.check();
    assertReference(pin(object));
    check(object.bucket === bucket && ['before', 'binding'].includes(object.phase)
      && object.key.startsWith(object.phase === 'before' ? 'history/' : `${G.timeseries_binding_index_prefix}/`)
      && object.key.endsWith('.json') && object.byte_size <= objectByteLimit, 'object_namespace');
    const id = `${object.phase}:${object.key}`;
    check(!objects.has(id), 'duplicate_original_object');
    const body = Buffer.from(object.bytes_base64, 'base64');
    check(body.length === object.byte_size && sha256Hex(body) === object.sha256, 'object_bytes');
    bytes += body.length; budget.bytes('metadata', body.length);
    objects.set(id, { reference: pin(object), value: parseJson(body), body });
  }
  check(bytes === x.required_raw_byte_size && bytes <= rawByteLimit, 'raw_byte_coverage');
  const used = new Set();
  const get = (phase, reference, expectedKey = reference?.key) => {
    assertReference(reference);
    const id = `${phase}:${expectedKey}`, object = objects.get(id);
    check(reference.key === expectedKey && object && same(reference, object.reference), `pinned_${phase}_object`);
    used.add(id); return object;
  };
  const before = x.before;
  check(before.admission === 'first_publication' && before.previous_authority === null
    && Array.isArray(before.hierarchy) && before.hierarchy.length > 0 && before.hierarchy.length <= 4
    && same(before.original_observations_root, before.hierarchy[0]), 'first_publication');
  const year = Number(row.day_utc.slice(0, 4)), month = row.day_utc.slice(5, 7);
  const keys = [G.observations_root_key, `${G.observations_prefix}/_manifests/year=${year}/manifest.json`,
    `${G.observations_prefix}/_manifests/year=${year}/month=${month}/manifest.json`,
    `${G.observations_prefix}/day_utc=${row.day_utc}/manifest.json`];
  const fields = ['year', 'month', 'day_utc', 'connector_id'], identities = [year, month, row.day_utc, 1];
  let previous = null; let parent = null;
  for (let i = 0; i < before.hierarchy.length; i++) {
    const object = get('before', before.hierarchy[i], keys[i]); const value = object.value;
    if (i < 3) {
      const validated = validateR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: G.observations_prefix });
      check(object.body.equals(serializeR2HistoryV2ObservationsAggregateManifest(validated, { basePrefix: G.observations_prefix }))
        && value.kind === `uk_aq_observations_${['root', 'year', 'month'][i]}_manifest`
        && (i === 0 || value.year === year) && (i !== 2 || value.month === month), 'before_hierarchy_kind');
    } else {
      validateCanonicalHistoryV2Manifest(value, { manifest_key: keys[i], manifest_kind: 'day', day_utc: row.day_utc, domain: 'observations' });
      check(same(value.connector_manifests, value.child_manifests), 'before_day_complete_children');
    }
    if (previous) {
      const link = previous.children.filter(child => child[fields[i - 1]] === identities[i - 1]);
      check(link.length === 1 && link[0].manifest_key === keys[i]
        && link[0][i === 3 ? 'manifest_hash' : 'content_hash'] === value[i === 3 ? 'manifest_hash' : 'content_hash'],
      'before_root_to_child_relationship');
    }
    previous = value; parent = object;
  }
  const level = before.hierarchy.length - 1;
  check(same(before.absence, { parent_key: keys[level], child_field: fields[level], child_identity: identities[level] }), 'absence_cut');
  const children = level === 3 ? parent.value.connector_manifests : parent.value.children;
  check(Array.isArray(children) && !children.some(c => c[fields[level]] === identities[level]), 'genuine_original_absence');
  const discovery = get('before', before.index_discovery, G.observations_latest_key ?? 'history/_index_v3/observations_timeseries_latest.json');
  check(discovery.body.toString() === encodeObservationHistoryIndexV3Json(discovery.value), 'original_latest_encoding');
  const { roots } = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: {
    kind: 'observation_history_index_v3_latest_global', publication_stage: 'latest_global', key: discovery.reference.key,
    payload: discovery.value, body: discovery.body.toString(), byte_size: discovery.body.length, sha256: discovery.reference.sha256 } });
  check(!roots.some(root => root.day_utc === row.day_utc && root.connector_id === 1), 'original_latest_absence_corroboration');
  const expected = source.scope.physical_timeseries_days;
  const expectedByKey = new Map(expected.map(scope => [prunePhysicalKey(scope), scope]));
  check(Array.isArray(before.scopes) && before.scopes.length === expected.length
    && new Set(before.scopes.map(prunePhysicalKey)).size === expected.length
    && same(before.scopes.map(prunePhysicalKey).sort(), expected.map(prunePhysicalKey).sort()), 'complete_before_membership');
  const beforeScopes = {};
  for (const scope of before.scopes) {
    assertPruneOriginalIdentity(scope.identity);
    check(scope.transition === 'first_publication_no_committed_observations'
      && same(scope.before, { state: 'authoritative_empty', row_count: 0, authority: parent.reference }), 'original_empty_scope_authority');
    beforeScopes[prunePhysicalKey(scope)] = scope.before;
  }
  const b = x.binding, prefix = G.timeseries_binding_index_prefix;
  check(b.publisher === 'core_snapshot_binding_publication'
    && b.relationship === 'completed_core_binding_metadata_snapshot_not_prune_reconciliation', 'core_publication_ownership');
  const root = get('binding', b.root, `${prefix}/_manifests/root.json`);
  const r = validateTimeseriesBindingSourceRootManifest(root.value);
  const sourceState = get('binding', b.source_state, `${prefix}/_source_state.json`).value;
  const refresh = get('binding', b.refresh_state, `${prefix}/_manifests/_refresh_state.json`).value;
  check(r.source_prefix === prefix && b.source_root_hash === r.source_root_hash
    && validTimeseriesBindingSourceState(sourceState, { bindingPrefix: prefix, sourceSchema: sourceState.source_schema })
    && typeof sourceState.source_schema === 'string' && sourceState.source_schema.length > 0
    && Number.isSafeInteger(sourceState.authoritative_timeseries_count) && sourceState.authoritative_timeseries_count >= 0
    && sourceState.source_tables.length === 3
    && ['timeseries', 'phenomena', 'observed_properties'].every(table => sourceState.source_tables.filter(t => t.table === table
      && Number.isSafeInteger(t.row_count) && t.row_count >= 0 && /^[a-f0-9]{64}$/.test(t.sha256_uncompressed || '')).length === 1)
    && b.source_fingerprint === sourceState.source_fingerprint && refresh.schema_version === 1 && refresh.history_version === 'v2'
    && refresh.kind === TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND && refresh.source_prefix === prefix
    && refresh.source_fingerprint === sourceState.source_fingerprint && refresh.source_root_hash === r.source_root_hash,
  'original_core_source_refresh_completion');
  check(Array.isArray(b.bindings) && b.bindings.length === expected.length
    && new Set(b.bindings.map(binding => canonicalJson(binding.identity).toString())).size === expected.length,
  'complete_original_bindings');
  const ranges = new Map(); const bindingScopes = new Set();
  for (const binding of b.bindings) {
    budget.check(); assertPruneOriginalIdentity(binding.identity);
    const id = binding.identity.timeseries_id, start = Math.floor(id / 1000) * 1000;
    const target = expectedByKey.get(prunePhysicalKey({ identity: binding.identity, day_utc: row.day_utc }));
    check(target, 'declared_binding_physical_scope'); bindingScopes.add(prunePhysicalKey(target));
    const rangeKey = timeseriesBindingSourceRangeManifestKey(prefix, start);
    let range = ranges.get(start);
    if (!range) {
      const rootRef = r.ranges.filter(range => range.range_start === start);
      check(rootRef.length === 1 && rootRef[0].manifest_key === rangeKey, 'root_to_range_membership');
      const raw = get('binding', binding.range, rangeKey); range = validateTimeseriesBindingSourceRangeManifest(raw.value);
      check(range.source_prefix === prefix && range.range_start === start && range.range_end === start + 999
        && range.source_range_hash === rootRef[0].source_range_hash && range.units.length === rootRef[0].unit_count,
      'original_binding_range_hash'); ranges.set(start, range);
    } else get('binding', binding.range, rangeKey);
    const units = range.units.filter(unit => unit.timeseries_id === id);
    const object = get('binding', binding.authority, `${prefix}/timeseries_id=${id}.json`), value = object.value;
    check(units.length === 1 && units[0].relative_path === object.reference.key
      && units[0].size === object.reference.byte_size && units[0].sha256 === object.reference.sha256
      && [1, 2].includes(value.schema_version) && value.history_version === 'v2' && value.index_kind === 'timeseries_binding'
      && Object.entries(binding.identity).every(([k, v]) => value[k] === v)
      && (value.schema_version === 1 ? !Object.hasOwn(value, 'continuity') : validContinuity(value.continuity, binding.identity)),
    'original_physical_binding_and_continuity');
  }
  check(bindingScopes.size === expected.length && used.size === objects.size, 'complete_original_authority_object_coverage');
  return { beforeScopes, bindingRoot: b.root, originalRoot: before.original_observations_root, lock: x.lock };
}
