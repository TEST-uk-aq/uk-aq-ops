// Independent durable family: descriptor v1 and selected receipt v3. Shape and
// digest validation never grant original authentication or a retained capability.
import { ROOT, canonicalJson, same, requireValid, assertReference, assertSource,
  assertPruneAcceptanceAuthority, assertReceipt, scopeKey, assertScope } from './schema.mjs';
import { assertPruneSelectedCoverage, PRUNE_COVERAGE_PLANNING_CONTRACT } from './prune-coverage-plan.mjs';
import { LIMITS, PRUNE_PENDING_SOURCE_LIMITS } from './limits.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const count = x => Number.isSafeInteger(x) && x >= 0;
const hash = (domain, value) => sha256Hex(canonicalJson({ contract: PRUNE_COVERAGE_PLANNING_CONTRACT, domain, value }));
function fields(x, names) {
  requireValid(x && typeof x === 'object' && !Array.isArray(x)
    && Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x, k)), 'invalid authenticated-event fields');
}
const POLICY = { identity: 'aurn_pm25_pm10_no2_v1', pollutants: ['no2', 'pm10', 'pm25'] };
export function assertPruneEventSummary(e) {
  fields(e, ['state', 'policy', 'original', 'selected', 'unsupported', 'coverage_sha256', 'partition_count']);
  requireValid(same(e.policy, POLICY), 'selected policy mismatch');
  for (const t of [e.original, e.selected, e.unsupported]) {
    fields(t, ['pollutant_codes', 'pollutant_count', 'scope_count', 'observation_count']);
    requireValid(Array.isArray(t.pollutant_codes) && t.pollutant_codes.every(c => /^[a-z0-9][a-z0-9_]{0,63}$/.test(c))
      && same(t.pollutant_codes, [...new Set(t.pollutant_codes)].sort()) && t.pollutant_count === t.pollutant_codes.length
      && count(t.scope_count) && t.scope_count <= PRUNE_PENDING_SOURCE_LIMITS.scopes
      && count(t.observation_count) && t.observation_count <= LIMITS.rows
      && (t.scope_count === 0) === (t.observation_count === 0)
      && (t.scope_count === 0) === (t.pollutant_count === 0), 'invalid event totals');
  }
  fields(e.coverage_sha256, ['original', 'selected', 'unsupported', 'partition_group']);
  requireValid(Object.values(e.coverage_sha256).every(sha) && new Set(Object.values(e.coverage_sha256)).size === 4
    && e.original.scope_count > 0 && e.original.scope_count === e.selected.scope_count + e.unsupported.scope_count
    && e.original.observation_count === e.selected.observation_count + e.unsupported.observation_count
    && same(e.original.pollutant_codes, [...e.selected.pollutant_codes, ...e.unsupported.pollutant_codes].sort())
    && e.selected.pollutant_codes.every(c => POLICY.pollutants.includes(c))
    && e.unsupported.pollutant_codes.every(c => !POLICY.pollutants.includes(c))
    && count(e.partition_count) && e.partition_count <= LIMITS.receipt_references
    && (e.partition_count === 0) === (e.selected.scope_count === 0)
    && e.state === (e.selected.scope_count ? 'selected_coverage_planned' : 'no_selected_scopes'), 'inconsistent selected event summary');
  return e;
}
export function pruneEventSummary(coverage) {
  return assertPruneEventSummary(Object.fromEntries(['state', 'policy', 'original', 'selected', 'unsupported',
    'coverage_sha256'].map(k => [k, coverage[k]]).concat([['partition_count', coverage.partitions.partition_count]])));
}
export function assertPruneEventReference(ref) {
  assertReference(ref, { managed: true });
  requireValid(ref.key === `${ROOT}/authenticated-events/${ref.sha256}.json`
    && ref.byte_size <= LIMITS.metadata_bytes, 'invalid immutable authenticated-event reference');
  return ref;
}
export function assertPruneEventDescriptor(d) {
  fields(d, ['schema_version', 'kind', 'writer', 'coverage']);
  requireValid(d.schema_version === 1 && d.kind === 'uk_aq_jsongen_authenticated_prune_event', 'descriptor schema/kind mismatch');
  const c = d.coverage;
  fields(c, ['contract', 'policy', 'event_id', 'authority', 'source_identity', 'source_status', 'global_lock',
    'pending_source', 'evidence_bundle', 'original_final_evidence_sha256', 'post_commit_reference_sha256',
    'sources', 'original', 'selected', 'unsupported', 'authorities', 'scopes', 'state', 'partitions', 'coverage_sha256']);
  const body = canonicalJson(c);
  assertPruneSelectedCoverage({ ...c, descriptor_preview: { sha256: sha256Hex(body), byte_size: body.length,
    persisted: false, durable_schema_committed: false } });
  assertPruneEventSummary(pruneEventSummary(c));
  fields(d.writer, ['identity', 'invocation_id', 'attempt_id', 'git_sha']);
  requireValid(same(d.writer, { identity: c.authority.key.writer_identity, invocation_id: c.authority.key.run_id,
    attempt_id: c.authority.key.attempt_id, git_sha: c.authority.writer_git_sha }), 'descriptor writer mismatch');
  assertOriginalBinding(c, c.authority);
  if (c.evidence_bundle !== null) {
    const { intent_id, object_count, raw_byte_size, conditional_create, ...reference } = c.evidence_bundle;
    fields(c.evidence_bundle, ['bucket', 'key', 'sha256', 'byte_size', 'json_sha256', 'json_byte_size',
      'intent_id', 'object_count', 'raw_byte_size', 'conditional_create']);
    assertReference(reference, { managed: true, gzip: true });
    requireValid(sha(intent_id) && count(object_count) && object_count > 0 && object_count <= 8192
      && count(raw_byte_size) && raw_byte_size > 0 && raw_byte_size <= 32 * 1024 ** 2
      && reference.byte_size <= 32 * 1024 ** 2 && reference.json_byte_size <= 64 * 1024 ** 2
      && conditional_create === 'if_none_match_star', 'invalid original evidence bundle');
  }
  requireValid(c.original_final_evidence_sha256 === c.authority.final_evidence_sha256
    && c.post_commit_reference_sha256 === c.authority.post_commit_reference_sha256
    && same(Object.keys(c.sources).sort(), c.original.pollutant_codes), 'descriptor original source authority mismatch');
  Object.values(c.sources).forEach(assertSource);
  requireValid(new Set(c.authorities.map(r => canonicalJson(r).toString())).size === c.authorities.length,
    'duplicate reusable authority reference');
  const used = new Set();
  for (const s of c.scopes) {
    fields(s, ['scope_key', 'identity', 'day_utc', 'row_count', 'verification_status_counts',
      'observation_content_hash', 'observation_content_hash_contract_version', 'physical_sha256', 'effective_status',
      'before', 'after', 'binding', 'leaf', 'index', 'disposition']);
    fields(s.verification_status_counts, ['P', 'R', 'null']);
    for (const m of [s.before, s.after]) fields(m, ['state', 'row_count', 'authority']);
    requireValid(s.identity.connector_id === 1 && s.day_utc === c.authority.key.day_utc, 'original scope acceptance mismatch');
    for (const i of [s.before.authority, s.after.authority, s.binding, s.leaf, s.index]) used.add(i);
  }
  requireValid(used.size === c.authorities.length, 'unused descriptor authority');
  fields(c.partitions, ['state', 'coverage', 'partition_count', 'physical_scope_count', 'observation_count',
    'partitions', 'receipt_coverage_complete', 'handover_complete']);
  c.partitions.partitions.forEach(p => assertPartition(p, c.authority, pruneEventSummary(c)));
  requireValid(canonicalJson(d).length <= LIMITS.metadata_bytes, 'descriptor size limit');
  return d;
}
function assertOriginalBinding(o, authority) {
  assertPruneAcceptanceAuthority(authority);
  assertReference(o.pending_source, { managed: true, gzip: true });
  fields(o.source_identity, ['source_content_hash', 'source_content_hash_contract_version', 'source_content_hash_row_count']);
  requireValid(sha(o.source_identity.source_content_hash) && o.source_identity.source_content_hash_contract_version === 1
    && o.source_identity.source_content_hash_row_count > 0, 'invalid original full-source identity');
  requireValid(same(o.source_status, { schema_version: 1, classification: 'original_source_status_unavailable',
    source_boundary: 'uk_aq_phase_b_history_compact_rows_v1.status', source_status: null,
    null_meaning: 'no_original_provider_status_asserted' }), 'original provider status unavailable');
  requireValid(same(o.global_lock, { logical_identity: 'uk_aq:r2_history:v2:observations_global_operation',
    owner: 'prune_daily', run_id: authority.key.run_id }), 'original lock mismatch');
}
function assertPartition(p, authority, e) {
  fields(p, ['partition_id', 'change_id', 'binding', 'scope_count', 'row_count', 'format', 'object', 'retention']);
  fields(p.binding, ['event_id', 'original_final_evidence_sha256', 'original_post_commit_reference_sha256',
    'pending_source', 'original_scope_count', 'original_observation_count', 'scopes', 'planning_contract', 'policy',
    'original_coverage_sha256', 'selected_coverage_sha256']);
  const b = p.binding;
  requireValid(b.event_id === authority.event_id && b.original_final_evidence_sha256 === authority.final_evidence_sha256
    && b.original_post_commit_reference_sha256 === authority.post_commit_reference_sha256
    && b.original_scope_count === e.original.scope_count && b.original_observation_count === e.original.observation_count
    && b.planning_contract === PRUNE_COVERAGE_PLANNING_CONTRACT && same(b.policy, e.policy)
    && b.original_coverage_sha256 === e.coverage_sha256.original && b.selected_coverage_sha256 === e.coverage_sha256.selected
    && p.partition_id === sha256Hex(canonicalJson(b)) && p.change_id === `prune:${p.partition_id}`
    && p.format === 'complete_scope_ndjson_gzip' && p.retention === 'pending'
    && Array.isArray(b.scopes) && b.scopes.length > 0 && b.scopes.length <= LIMITS.scopes
    && p.scope_count === b.scopes.length && p.row_count === b.scopes.reduce((n, s) => n + s.row_count, 0)
    && p.row_count > 0 && p.row_count <= LIMITS.rows, 'invalid deterministic selected partition');
  assertReference(b.pending_source, { managed: true, gzip: true });
  assertReference(p.object, { managed: true, gzip: true });
  requireValid(p.object.key === `${ROOT}/bundles/${p.object.sha256}.ndjson.gz`
    && p.object.byte_size <= LIMITS.compressed_bytes && p.object.json_byte_size <= LIMITS.uncompressed_bytes,
  'invalid selected bundle reference');
  for (const s of b.scopes) {
    fields(s, ['timeseries_id', 'station_id', 'pollutant_code', 'day_utc', 'row_count',
      'verification_status_counts', 'record_sha256']);
    requireValid(s.day_utc === authority.key.day_utc && POLICY.pollutants.includes(s.pollutant_code)
      && sha(s.record_sha256), 'invalid selected scope record identity');
    fields(s.verification_status_counts, ['P', 'R', 'null']);
    requireValid(Object.values(s.verification_status_counts).every(count)
      && Object.values(s.verification_status_counts).reduce((n, v) => n + v, 0) === s.row_count,
    'invalid selected status inventory');
  }
}
export function assertSelectedReceiptOrigin(r) {
  const o = r.origin;
  fields(o, ['authority', 'pending_source', 'source_identity', 'source_status', 'global_lock', 'descriptor',
    'event', 'partition_index', 'partition']);
  assertOriginalBinding(o, o.authority); assertPruneEventReference(o.descriptor); assertPruneEventSummary(o.event);
  const e = o.event, p = o.partition;
  assertPartition(p, o.authority, e);
  requireValid(o.source_identity.source_content_hash_row_count === e.original.observation_count
    && count(o.partition_index) && o.partition_index < e.partition_count
    && r.writer.identity === 'prune_daily_v3' && r.writer.invocation_id === o.authority.key.run_id
    && r.writer.attempt_id === o.authority.key.attempt_id && r.writer.git_sha === o.authority.writer_git_sha
    && r.change_id === p.change_id && same(r.bundle.object, p.object)
    && r.bundle.row_count === p.row_count && r.scopes.length === p.scope_count
    && same(p.binding.pending_source, o.pending_source), 'selected receipt original/partition binding mismatch');
  r.scopes.forEach(assertScope);
  requireValid(r.scopes.every((s, i) => {
    const b = p.binding.scopes[i];
    return s.identity.connector_id === 1 && s.day_utc === o.authority.key.day_utc
      && s.before.state === 'authoritative_empty' && s.after.state === 'present'
      && same(s.identity, { connector_id: 1, timeseries_id: b.timeseries_id,
        station_id: b.station_id, pollutant_code: b.pollutant_code }) && s.day_utc === b.day_utc
      && s.after.row_count === b.row_count && s.identity.pollutant_code === r.scopes[0].identity.pollutant_code;
  }), 'selected complete-scope membership mismatch');
  return r;
}
export function assertSelectedReceiptGroup(receipts, descriptor, summary, authority) {
  assertPruneEventReference(descriptor); assertPruneEventSummary(summary); assertPruneAcceptanceAuthority(authority);
  requireValid(Array.isArray(receipts) && receipts.length === summary.partition_count, 'complete selected receipt group required');
  const ordered = [...receipts].sort((a, b) => a.origin.partition_index - b.origin.partition_index);
  for (const [i, r] of ordered.entries()) {
    assertReceipt(r);
    requireValid(r.schema_version === 3 && r.origin.partition_index === i && same(r.origin.descriptor, descriptor)
      && same(r.origin.event, summary) && same(r.origin.authority, authority)
      && same(r.origin.source_identity, ordered[0].origin.source_identity)
      && same(r.origin.pending_source, ordered[0].origin.pending_source), 'missing, duplicated or conflicting selected partition');
  }
  const scopes = ordered.flatMap(r => r.scopes);
  requireValid(scopes.length === summary.selected.scope_count && new Set(scopes.map(scopeKey)).size === scopes.length
    && scopes.reduce((n, s) => n + s.after.row_count, 0) === summary.selected.observation_count
    && summary.coverage_sha256.partition_group === hash('selected_partition_group', { event_id: authority.event_id,
      policy: summary.policy, original: summary.coverage_sha256.original, selected: summary.coverage_sha256.selected,
      partitions: ordered.map(r => r.origin.partition) }), 'selected group coverage mismatch');
  return receipts;
}
export function assertDescriptorReceipts(d, descriptor, receipts) {
  assertPruneEventDescriptor(d);
  const bytes = canonicalJson(d);
  requireValid(descriptor.sha256 === sha256Hex(bytes) && descriptor.byte_size === bytes.length, 'descriptor reference mismatch');
  const c = d.coverage;
  assertSelectedReceiptGroup(receipts, descriptor, pruneEventSummary(c), c.authority);
  for (const r of receipts) {
    const o = r.origin;
    requireValid(same(o.partition, c.partitions.partitions[o.partition_index]) && same(r.writer, d.writer)
      && same(o.source_identity, c.source_identity) && same(o.pending_source, c.pending_source)
      && same(r.source, c.sources[r.scopes[0].identity.pollutant_code]), 'descriptor selected receipt mismatch');
    for (const s of r.scopes) {
      const original = c.scopes.find(x => x.scope_key === scopeKey(s));
      requireValid(original && same(s, { identity: original.identity, day_utc: original.day_utc,
        before: { ...original.before, authority: c.authorities[original.before.authority] },
        after: { ...original.after, authority: c.authorities[original.after.authority] } }), 'descriptor scope authority mismatch');
    }
  }
  return receipts;
}
// Control v2 holds only descriptor/receipt references and a bounded summary;
// existing registered_changes continue to own dependency and lifecycle semantics.
export function assertSelectedControlEvents(control) {
  requireValid(control.authenticated_events && typeof control.authenticated_events === 'object'
    && !Array.isArray(control.authenticated_events), 'authenticated event map required');
  const selected = Object.values(control.registered_changes).filter(e => e.receipt.schema_version === 3);
  for (const [id, event] of Object.entries(control.authenticated_events)) {
    fields(event, ['descriptor', 'authority', 'event', 'receipt_objects', 'registered_at_utc']);
    requireValid(id === event.authority.event_id && typeof event.registered_at_utc === 'string'
      && new Date(event.registered_at_utc).toISOString() === event.registered_at_utc,
    'invalid registered authenticated event');
    const entries = selected.filter(e => e.receipt.origin.authority.event_id === id);
    assertSelectedReceiptGroup(entries.map(e => e.receipt), event.descriptor, event.event, event.authority);
    requireValid(same(event.receipt_objects, entries.sort((a, b) => a.receipt.origin.partition_index - b.receipt.origin.partition_index)
      .map(e => ({ change_id: e.receipt.change_id, receipt_object: e.receipt_object }))), 'partial registered selected event references');
    requireValid(!Object.values(control.registered_changes).some(e => e.receipt.schema_version === 2
      && e.receipt.origin.authority.event_id === id), 'legacy event cannot be registered again as selected');
  }
  requireValid(selected.every(e => Object.hasOwn(control.authenticated_events, e.receipt.origin.authority.event_id)),
    'selected receipt has no complete authenticated event');
}
