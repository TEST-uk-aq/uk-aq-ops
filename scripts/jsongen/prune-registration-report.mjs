// Separate private diagnostic v1. Existing reconciliation report versions 1-4,
// compact codecs and immutable receipt schemas retain their exact meanings.
import { canonicalJson, same, scopeKey, assertReference, assertSource, assertPruneAcceptanceAuthority,
  CONTROL_KEY, ROOT } from './schema.mjs';
import { assertControlSnapshot, controlSnapshot } from './control-snapshot.mjs';
import { assertPruneEventSummary, assertPruneEventReference } from './prune-event-schema.mjs';
import { assertPruneAcceptanceKey, pruneAcceptanceId, OUTBOX_PAGE_LIMIT } from './prune-outbox-reader.mjs';
import { sha256Hex, isStrongR2Etag } from '../../workers/shared/r2_sigv4.mjs';
import { createPruneHandoverBudget, LIMITS, PRUNE_PENDING_SOURCE_LIMITS, evidence } from './limits.mjs';

const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const count = x => Number.isSafeInteger(x) && x >= 0;
const instant = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.(?:\d{3}|\d{6})Z$/.test(x)
  && Number.isFinite(Date.parse(x));
const check = ok => evidence(ok, 'invalid_prune_registration_report', 'Invalid or unsafe private registration diagnostic');
function keys(x, names) {
  check(x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === names.length
    && names.every(k => Object.hasOwn(x, k)));
}
const reasons = new Set(['exact_object_not_found', 'resource_limit', 'evidence_rejected', 'read_or_validation_unavailable',
  'exact_authenticated_readback', 'control_unavailable', 'absent_from_exact_control', 'exact_authenticated_group_member',
  'conflicting_control_member', 'complete_authenticated_group', 'not_inspected', 'original_authentication_required',
  'original_authority_incomplete', 'restricted_reader_unavailable',
  'original_authentication_unavailable', 'original_outbox_private_source_and_final_evidence',
  'discovered_original_not_visible_on_replay', 'original_evidence_incomplete', 'complete_group_not_resolved',
  'discovery_unavailable', 'bounded_page_only']);
function status(x, allowed) {
  keys(x, ['state', 'reason']); check(allowed.includes(x.state) && reasons.has(x.reason));
  check(x.state !== 'missing' || ['exact_object_not_found', 'absent_from_exact_control'].includes(x.reason));
}
function groupState(items, complete) {
  return items.some(x => x.state === 'reconciliation_required') ? 'reconciliation_required'
    : items.some(x => x.state === 'missing') ? 'missing'
      : items.some(x => x.state !== complete) ? 'unknown' : complete;
}
function cursor(x, request) {
  if (x === null) return;
  keys(x, ['from', 'to', 'mode', 'accepted_at', 'key']); assertPruneAcceptanceKey(x.key);
  check(x.from === request.from && x.to === request.to && x.mode === request.mode && instant(x.accepted_at)
    && Date.parse(x.accepted_at) >= Date.parse(x.from) && Date.parse(x.accepted_at) <= Date.parse(x.to));
}
export function assertPruneDiscoveryRequest(x) {
  keys(x, ['from', 'to', 'mode', 'limit', 'after']);
  check(['recent', 'resweep'].includes(x.mode) && instant(x.from) && instant(x.to)
    && Date.parse(x.to) >= Date.parse(x.from) && Date.parse(x.to) - Date.parse(x.from) <= 7 * 86400000
    && Number.isSafeInteger(x.limit) && x.limit > 0 && x.limit <= OUTBOX_PAGE_LIMIT);
  cursor(x.after, x); return x;
}

export function classifyPruneRegistration(e) {
  if (e.original.state === 'reconciliation_required' || e.diagnostic?.state === 'reconciliation_required') return 'reconciliation_required';
  if (e.original.state !== 'authenticated' || !e.group_complete) return 'unknown';
  if ([e.registration, e.retention].some(s => s.state === 'reconciliation_required')) return 'reconciliation_required';
  if (e.registration.state === 'missing') return e.retention.state === 'missing'
    ? 'missing_registration_and_retention' : 'missing_registration';
  if (e.retention.state === 'missing') return 'missing_retention';
  if (e.registration.state !== 'registered' || e.retention.state !== 'retained') return 'unknown';
  return e.evidence.summary.selected.scope_count === 0 ? 'registered_no_selected_scopes' : 'registered_and_retained';
}

export function assertPruneRegistrationReport(r, { controlRead = null } = {}) {
  keys(r, ['schema_version', 'kind', 'inspected_at_utc', 'finished_at_utc', 'state', 'publication_selection', 'publication_eligible',
    'complete_change_coverage', 'writer_coverage', 'freshness', 'current_canonical_authority', 'coherent_canonical_snapshot',
    'control', 'discovery_request', 'discovery', 'discovery_state', 'events', 'limitations', 'resources', 'admitted', 'limits']);
  check(r.schema_version === 1 && r.kind === 'uk_aq_jsongen_prune_registration_diagnostic' && instant(r.inspected_at_utc)
    && instant(r.finished_at_utc) && Date.parse(r.finished_at_utc) >= Date.parse(r.inspected_at_utc)
    && r.state === 'reconciliation_required' && r.publication_selection === 'disabled' && r.publication_eligible === false
    && r.complete_change_coverage === false && r.writer_coverage === 'unknown' && r.freshness === 'unknown'
    && r.current_canonical_authority === 'not_inspected' && r.coherent_canonical_snapshot === false);
  check(same(r.limitations, ['optional_aurn_outbox_is_not_a_complete_prune_inventory',
    'integrity_v3_sos_light_ifw_coverage_unresolved', 'discovery_absence_is_not_event_absence',
    'registration_does_not_establish_canonical_dominance_or_freshness',
    'independent_source_as_of_inspections_cannot_be_combined',
    'complete_all_writer_coverage_and_managed_publication_eligibility_not_established']));
  const ceiling = createPruneHandoverBudget().limits;
  keys(r.limits, Object.keys(ceiling));
  check(Object.entries(r.limits).every(([k, n]) => Number.isSafeInteger(n) && n > 0 && n <= ceiling[k]));
  keys(r.resources, ['derived_gets', 'metadata_gets', 'derived_bytes', 'metadata_bytes', 'decompressed_bytes', 'rows']);
  check(Object.values(r.resources).every(count) && r.resources.rows <= r.limits.total_rows
    && r.resources.metadata_gets <= r.limits.metadata_gets
    && r.resources.derived_bytes + r.resources.metadata_bytes + r.resources.decompressed_bytes <= r.limits.total_bytes);
  keys(r.admitted, ['receipt_references', 'selected_scopes']);
  check(count(r.admitted.receipt_references) && r.admitted.receipt_references <= r.limits.receipt_references
    && count(r.admitted.selected_scopes) && r.admitted.selected_scopes <= PRUNE_PENDING_SOURCE_LIMITS.scopes);
  keys(r.control, ['state', 'snapshot', 'object', 'etag']);
  check(['available', 'missing', 'unknown', 'reconciliation_required'].includes(r.control.state));
  if (r.control.state === 'available') {
    assertControlSnapshot(r.control.snapshot); assertReference(r.control.object, { managed: true });
    check(r.control.snapshot.byte_provenance === 'exact_read' && r.control.object.key === CONTROL_KEY
      && r.control.object.sha256 === r.control.snapshot.sha256 && r.control.object.byte_size <= 4 * 1024 ** 2
      && isStrongR2Etag(r.control.etag));
    if (controlRead) check(same(r.control.snapshot, controlSnapshot(controlRead.control, controlRead))
      && controlRead.body.length === r.control.object.byte_size && r.control.etag === controlRead.etag);
  } else check(!controlRead && r.control.snapshot === null && r.control.object === null && r.control.etag === null);
  assertPruneDiscoveryRequest(r.discovery_request);
  status(r.discovery_state, ['available', 'unknown', 'reconciliation_required']);
  const d = r.discovery;
  check(Array.isArray(r.events) && r.events.length <= r.discovery_request.limit);
  if (d === null) { check(r.discovery_state.state !== 'available' && r.events.length === 0); return r; }
  keys(d, ['mode', 'from', 'to', 'events', 'state', 'next', 'window_pass_finished', 'coverage_complete', 'replay', 'canonical_precedence']);
  check(d.mode === r.discovery_request.mode && d.from === r.discovery_request.from && d.to === r.discovery_request.to
    && d.state === 'replay_required' && d.coverage_complete === false && d.window_pass_finished === (d.next === null)
    && d.replay === 'restart_overlapping_windows_and_periodic_historical_resweeps'
    && d.canonical_precedence === 'not_established_by_discovery' && Array.isArray(d.events)
    && d.events.length === r.events.length && new Set(d.events.map(e => e.event_id)).size === d.events.length);
  cursor(d.next, r.discovery_request);
  const refs = new Set(), scopes = new Set();
  for (const [i, e] of r.events.entries()) {
    keys(e, ['key', 'event_id', 'reference_sha256', 'classification', 'original', 'evidence', 'family', 'group_complete', 'group_sha256',
      'diagnostic', 'failure_stage', 'descriptor', 'partitions', 'registration', 'retention']);
    const found = d.events[i]; keys(found, ['key', 'event_id', 'reference_sha256']);
    assertPruneAcceptanceKey(e.key);
    check(e.event_id === pruneAcceptanceId(e.key) && sha(e.reference_sha256) && same(found,
      { key: e.key, event_id: e.event_id, reference_sha256: e.reference_sha256 }) && typeof e.group_complete === 'boolean');
    status(e.original, ['authenticated', 'unknown', 'reconciliation_required']);
    status(e.registration, ['registered', 'missing', 'unknown', 'reconciliation_required']);
    status(e.retention, ['retained', 'missing', 'unknown', 'reconciliation_required']);
    if (e.diagnostic !== null) status(e.diagnostic, ['missing', 'unknown', 'reconciliation_required']);
    check(e.failure_stage === null || ['original_outbox_read', 'original_reference_binding', 'original_authentication',
      'selected_group_construction', 'legacy_family_probe', 'group_admission_and_comparison'].includes(e.failure_stage));
    check((e.failure_stage === null) === (e.diagnostic === null));
    check(['unknown', 'selected_receipt_v3', 'legacy_receipt_v2'].includes(e.family)
      && Array.isArray(e.partitions) && e.partitions.length <= LIMITS.receipt_references
      && (e.group_sha256 === null || sha(e.group_sha256)));
    if (e.evidence !== null) {
      keys(e.evidence, ['authority', 'summary', 'source_identity', 'pending_source', 'original_evidence_bundle', 'sources']);
      const a = e.evidence.authority, summary = e.evidence.summary;
      assertPruneAcceptanceAuthority(a); assertPruneEventSummary(summary);
      check(e.original.state === 'authenticated' && a.event_id === e.event_id && same(a.key, e.key)
        && a.post_commit_reference_sha256 === e.reference_sha256);
      assertReference(e.evidence.pending_source, { managed: true, gzip: true });
      keys(e.evidence.source_identity, ['source_content_hash', 'source_content_hash_contract_version', 'source_content_hash_row_count']);
      check(sha(e.evidence.source_identity.source_content_hash) && e.evidence.source_identity.source_content_hash_contract_version === 1
        && e.evidence.source_identity.source_content_hash_row_count === summary.original.observation_count
        && same(Object.keys(e.evidence.sources).sort(), summary.original.pollutant_codes));
      Object.values(e.evidence.sources).forEach(assertSource);
      const b = e.evidence.original_evidence_bundle;
      if (b !== null) {
        keys(b, ['bucket', 'key', 'sha256', 'byte_size', 'json_sha256', 'json_byte_size',
          'intent_id', 'object_count', 'raw_byte_size', 'conditional_create']);
        const { intent_id, object_count, raw_byte_size, conditional_create, ...reference } = b;
        assertReference(reference, { managed: true, gzip: true });
        check(sha(intent_id) && count(object_count) && object_count > 0 && object_count <= 8192
          && count(raw_byte_size) && raw_byte_size > 0 && raw_byte_size <= 32 * 1024 ** 2
          && reference.byte_size <= 32 * 1024 ** 2 && reference.json_byte_size <= 64 * 1024 ** 2
          && conditional_create === 'if_none_match_star');
      }
    }
    if (e.descriptor !== null) {
      keys(e.descriptor, ['reference', 'registration', 'retention']); assertPruneEventReference(e.descriptor.reference);
      check(e.family === 'selected_receipt_v3');
      status(e.descriptor.registration, ['registered', 'missing', 'unknown', 'reconciliation_required']);
      status(e.descriptor.retention, ['retained', 'missing', 'unknown', 'reconciliation_required']);
      if (e.descriptor.retention.state === 'missing') check(e.descriptor.retention.reason === 'exact_object_not_found');
      if (r.control.state !== 'available') check(e.descriptor.registration.state === 'unknown');
      if (controlRead) {
        const record = controlRead.control.authenticated_events?.[e.event_id];
        const match = record && same(record.descriptor, e.descriptor.reference)
          && same(record.authority, e.evidence.authority) && same(record.event, e.evidence.summary)
          && same(record.receipt_objects, e.partitions.map(p => ({ change_id: p.change_id, receipt_object: p.receipt })));
        check(e.descriptor.registration.state === (!record ? 'missing' : match ? 'registered' : 'reconciliation_required'));
      }
    }
    const eventScopes = new Set();
    for (const p of e.partitions) {
      keys(p, ['change_id', 'receipt', 'bundle', 'scope_keys', 'row_count', 'source', 'registration', 'receipt_retention', 'bundle_retention']);
      assertReference(p.receipt, { managed: true }); assertReference(p.bundle, { managed: true, gzip: true }); assertSource(p.source);
      check(/^prune:[a-f0-9]{64}$/.test(p.change_id) && p.receipt.key === `${ROOT}/receipts/${p.receipt.sha256}.json`
        && !refs.has(p.receipt.key) && Array.isArray(p.scope_keys) && p.scope_keys.length > 0 && p.scope_keys.length <= LIMITS.scopes
        && same(p.scope_keys, [...new Set(p.scope_keys)].sort()) && count(p.row_count) && p.row_count > 0 && p.row_count <= LIMITS.rows);
      refs.add(p.receipt.key);
      for (const key of p.scope_keys) {
        check(new RegExp(`^1:[1-9]\\d*:[1-9]\\d*:(?:pm25|pm10|no2):${e.key.day_utc.slice(0, 7)}:${e.key.day_utc}$`).test(key)
          && !eventScopes.has(key)); eventScopes.add(key); scopes.add(key);
      }
      const pollutant = p.scope_keys[0].split(':')[3];
      check(e.evidence !== null && p.scope_keys.every(k => k.split(':')[3] === pollutant)
        && same(p.source, e.evidence.sources[pollutant]));
      status(p.registration, ['registered', 'missing', 'unknown', 'reconciliation_required']);
      for (const x of [p.receipt_retention, p.bundle_retention]) {
        status(x, ['retained', 'missing', 'unknown', 'reconciliation_required']);
        if (x.state === 'missing') check(x.reason === 'exact_object_not_found');
      }
      if (p.registration.state === 'registered') check(r.control.snapshot?.registered_change_ids.includes(p.change_id));
      if (p.registration.state === 'missing') check(r.control.state === 'available' && !r.control.snapshot.registered_change_ids.includes(p.change_id));
      if (r.control.state !== 'available') check(p.registration.state === 'unknown');
      if (controlRead) {
        const entry = controlRead.control.registered_changes[p.change_id];
        check(p.registration.state === (!entry ? 'missing' : same(entry.receipt_object, p.receipt)
          ? 'registered' : 'reconciliation_required'));
        if (entry && same(entry.receipt_object, p.receipt)) check(same(entry.receipt.bundle.object, p.bundle)
          && same(entry.receipt.source, p.source) && same(entry.receipt.scopes.map(scopeKey).sort(), p.scope_keys)
          && entry.receipt.bundle.row_count === p.row_count
          && same(entry.receipt.origin.authority, e.evidence.authority)
          && entry.receipt.origin.authority.event_id === e.event_id);
      }
    }
    if (e.group_complete) {
      check(e.original.state === 'authenticated' && e.evidence !== null && e.family !== 'unknown'
        && sha(e.group_sha256)
        && (e.family === 'selected_receipt_v3') === (e.descriptor !== null)
        && e.partitions.length === e.evidence.summary.partition_count
        && e.partitions.reduce((n, p) => n + p.scope_keys.length, 0) === e.evidence.summary.selected.scope_count
        && e.partitions.reduce((n, p) => n + p.row_count, 0) === e.evidence.summary.selected.observation_count);
      if (e.family === 'legacy_receipt_v2') check(e.evidence.summary.unsupported.scope_count === 0 && e.partitions.length > 0);
      else check(e.group_sha256 === e.evidence.summary.coverage_sha256.partition_group);
      const registration = [...e.partitions.map(p => p.registration), ...(e.descriptor ? [e.descriptor.registration] : [])];
      const retention = [...e.partitions.flatMap(p => [p.receipt_retention, p.bundle_retention]),
        ...(e.descriptor ? [e.descriptor.retention] : [])];
      if (e.diagnostic === null) {
        check(e.retention.state === groupState(retention, 'retained'));
        const extras = controlRead && Object.values(controlRead.control.registered_changes).some(x => [2, 3].includes(x.receipt.schema_version)
          && x.receipt.origin.authority.event_id === e.event_id && !e.partitions.some(p => same(p.receipt, x.receipt_object)));
        check(e.registration.state === (extras ? 'reconciliation_required' : groupState(registration, 'registered'))
          || (!controlRead && e.registration.state === 'reconciliation_required' && e.registration.reason === 'conflicting_control_member'));
      }
      if (e.registration.state === 'registered') check(r.control.state === 'available'
        && e.partitions.every(p => p.registration.state === 'registered')
        && (!e.descriptor || e.descriptor.registration.state === 'registered'));
      if (e.retention.state === 'retained') check(e.partitions.every(p => p.receipt_retention.state === 'retained'
        && p.bundle_retention.state === 'retained') && (!e.descriptor || e.descriptor.retention.state === 'retained'));
    } else check(!['registered', 'missing'].includes(e.registration.state) && !['retained', 'missing'].includes(e.retention.state));
    check(e.classification === classifyPruneRegistration(e));
  }
  check(refs.size <= r.admitted.receipt_references && scopes.size <= r.admitted.selected_scopes);
  return r;
}

export function registrationArtifact(report) {
  assertPruneRegistrationReport(report);
  const body = canonicalJson(report), r = report.resources;
  check(body.length <= report.limits.report_bytes
    && r.derived_bytes + r.metadata_bytes + r.decompressed_bytes + 2 * body.length <= report.limits.total_bytes);
  return { body, sha256: sha256Hex(body), byte_size: body.length };
}
