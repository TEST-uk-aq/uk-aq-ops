// Validation of diagnostic evidence, never an authentication shortcut for a
// writer publication, canonical currentness, or complete receipt coverage.
import { assertPruneEventReference, assertPruneEventSummary } from './prune-event-schema.mjs';
import { validateObservationContentHashMetadata } from '../../workers/shared/uk_aq_observation_content_hash.mjs';
import { DAQI_PM_ROLLING24H_WINDOW_HOURS, DAQI_PM_ROLLING24H_REQUIRED_HOURS } from '../../lib/aqi/aqi_levels.mjs';
import { getObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { ROOT, BUCKET, ALGORITHM, assertIdentity, assertReference, assertScope,
  assertSource, assertPruneAcceptanceAuthority, affectedMonths, monthKey, same, scopeKey } from './schema.mjs';
import { LIMITS, evidence, PRUNE_PENDING_SOURCE_LIMITS, INSPECTION_MAX_METADATA_GETS, INSPECTION_CONCURRENCY } from './limits.mjs';
import { assertControlSnapshot, controlSnapshot } from './control-snapshot.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { canonicalJson } from './schema.mjs';
import { assessStage3C, currentScopeMatch } from './currentness.mjs';
import { assertPruneAcceptanceKey, pruneAcceptanceId, OUTBOX_PAGE_LIMIT } from './prune-outbox-reader.mjs';
import { decodeCompactReport } from './report-codec.mjs';
import { planInspection, planMetadataRequests } from './inspection-plan.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const changeId = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const monthId = /^[1-9]\d*:[1-9]\d*:[1-9]\d*:(?:pm25|pm10|no2):\d{4}-\d\d$/;
const scopeId = /^[1-9]\d*:[1-9]\d*:[1-9]\d*:(?:pm25|pm10|no2):\d{4}-\d\d:\d{4}-\d\d-\d\d$/;
const safe = n => Number.isSafeInteger(n) && n >= 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const diagnostic = x => object(x) && typeof x.code === 'string' && x.code.length > 0 && x.code.length <= 128
  && typeof x.detail === 'string' && x.detail.length > 0 && x.detail.length <= 4096;
const set = values => Array.isArray(values) && values.every(v => typeof v === 'string')
  && same(values, [...new Set(values)].sort());
function keys(value, required, optional = []) {
  evidence(object(value) && required.every(k => Object.hasOwn(value, k))
    && Object.keys(value).every(k => required.includes(k) || optional.includes(k)),
  'invalid_report', `unexpected or missing report fields: ${required.join(', ')}`);
}
function instant(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function receiptReference(reference) {
  assertReference(reference, { managed: true });
  evidence(reference.key === `${ROOT}/receipts/${reference.sha256}.json`, 'invalid_report', 'invalid retained receipt key');
}
function canonicalReference(reference) {
  assertReference(reference);
  evidence(reference.bucket !== BUCKET, 'invalid_report', 'canonical provenance cannot use the private derived bucket');
}
function inspectLogical(value, scopes) {
  evidence(Array.isArray(value) && value.length === scopes.size, 'invalid_report', 'incomplete logical scope evidence');
  const seen = new Set();
  for (const item of value) {
    keys(item, ['scope_key', 'observation', 'measurement', 'absence_authority']);
    const scope = scopes.get(item.scope_key);
    evidence(scope && !seen.has(item.scope_key), 'invalid_report', 'duplicate or undeclared logical scope');
    seen.add(item.scope_key);
    validateObservationContentHashMetadata(item.observation, { rowCount: scope.after.row_count });
    validateObservationContentHashMetadata(item.measurement, { rowCount: scope.after.row_count });
    evidence(item.absence_authority === (scope.after.state === 'authoritative_empty'
      ? 'independent_proof_required' : 'not_applicable'),
    'invalid_report', 'logical empty membership is unauthenticated or contradictory');
  }
}

export function assertReconciliationReport(report, { controlRead = null } = {}) {
  report = decodeCompactReport(report);
  const modern = [3, 4].includes(report.schema_version);
  const stage3c = modern || report.schema_version === 2;
  const getLimit = modern ? INSPECTION_MAX_METADATA_GETS : LIMITS.metadata_gets;
  const scopeLimit = stage3c ? PRUNE_PENDING_SOURCE_LIMITS.scopes : LIMITS.scopes;
  keys(report, ['schema_version', 'kind', 'inspected_at_utc', 'control_snapshot', 'state',
    'publication_selection', 'complete_change_coverage', 'freshness', 'changes', 'canonical',
    'uncovered_scopes', 'months', 'diagnostics', 'resources', 'actions',
    ...(report.schema_version === 4 ? ['authenticated_events'] : [])], stage3c ? ['stage3c'] : []);
  evidence([1, 2, 3, 4].includes(report.schema_version) && report.kind === 'uk_aq_jsongen_reconciliation'
    && instant(report.inspected_at_utc) && report.state === 'reconciliation_required'
    && report.publication_selection === 'disabled' && report.complete_change_coverage === false
    && report.freshness === 'unknown', 'invalid_report', 'unsupported or unsafe reconciliation state');
  assertControlSnapshot(report.control_snapshot);
  if (controlRead !== null) {
    evidence(same(report.control_snapshot, controlSnapshot(controlRead.control, controlRead)),
      'invalid_report', 'report does not describe the original inspected control bytes');
  }
  keys(report.resources, ['derived_gets', 'metadata_gets', 'derived_bytes', 'metadata_bytes', 'decompressed_bytes', 'rows']);
  evidence(Array.isArray(report.changes) && report.changes.length <= LIMITS.receipt_references
    && Array.isArray(report.uncovered_scopes) && report.uncovered_scopes.length <= scopeLimit
    && Array.isArray(report.months) && report.months.length <= 2 * LIMITS.scopes * LIMITS.receipt_references
    && Array.isArray(report.diagnostics) && report.diagnostics.length <= LIMITS.metadata_gets
    && report.diagnostics.some(d => d.code === 'unknown_receipt_coverage')
    && report.diagnostics.every(diagnostic), 'invalid_report', 'invalid change, month or coverage evidence');
  const seenRefs = new Set(); const seenIds = new Set(); const registered = new Set();
  for (const change of report.changes) {
    keys(change, ['change_id', 'receipt', 'registered', 'state', 'diagnostics', 'scopes'],
      ['affected_months', 'rolling_aqi', 'bundle_integrity', 'logical_identities', 'authentication',
        ...(stage3c ? ['original_scope_authorities', 'original_verified_at_utc'] : [])]);
    receiptReference(change.receipt);
    evidence(!seenRefs.has(change.receipt.key) && typeof change.registered === 'boolean'
      && change.state === 'reconciliation_required' && Array.isArray(change.diagnostics)
      && change.diagnostics.length <= LIMITS.metadata_gets
      && change.diagnostics.every(diagnostic) && Array.isArray(change.scopes)
      && change.scopes.length <= LIMITS.scopes, 'invalid_report', 'duplicate or invalid receipt evidence');
    seenRefs.add(change.receipt.key);
    if (change.change_id !== null) {
      evidence(changeId.test(change.change_id) && !seenIds.has(change.change_id), 'invalid_report', 'contradictory change identity');
      seenIds.add(change.change_id);
    }
    if (change.registered) {
      evidence(change.change_id !== null && report.control_snapshot.registered_change_ids.includes(change.change_id),
        'invalid_report', 'registered receipt is absent from inspected control projection');
      registered.add(change.change_id);
    } else evidence(change.change_id === null || !report.control_snapshot.registered_change_ids.includes(change.change_id),
      'invalid_report', 'retained-only receipt falsely marked unregistered');
    const seenScopes = new Map();
    for (const item of change.scopes) {
      keys(item, ['scope_key', 'declared_scope', 'declared_state', 'declared_authority', 'state'],
        ['canonical_membership', 'declared_pin_relation', 'authenticated_supersession', 'empty_replacement']);
      assertScope(item.declared_scope);
      evidence(item.scope_key === scopeKey(item.declared_scope) && !seenScopes.has(item.scope_key)
        && item.declared_state === item.declared_scope.after.state
        && same(item.declared_authority, item.declared_scope.after.authority)
        && item.state === 'reconciliation_required'
        && (item.canonical_membership === undefined || ['unknown', 'present', 'authoritative_absent'].includes(item.canonical_membership))
        && (item.declared_pin_relation === undefined || ['unknown', 'matches_current_metadata', 'differs_from_current_metadata'].includes(item.declared_pin_relation))
        && (item.authenticated_supersession === undefined || item.authenticated_supersession === 'unproven')
        && (item.empty_replacement === undefined || (item.declared_state === 'authoritative_empty'
          && ['current_absence_proven_original_writer_absence_unproven', 'absence_unproven_or_contradictory'].includes(item.empty_replacement))),
      'invalid_report', 'contradictory or positively authenticated scope evidence');
      seenScopes.set(item.scope_key, item.declared_scope);
    }
    if (change.affected_months !== undefined) {
      evidence(same(change.affected_months, affectedMonths(change.scopes.map(s => s.declared_scope))),
        'invalid_report', 'affected months dropped or invented');
      const pm = change.scopes.some(s => s.declared_scope.identity.pollutant_code !== 'no2');
      evidence(same(change.rolling_aqi, { algorithm_version: ALGORITHM,
        preceding_hours: pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0,
        following_hours: pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0,
        minimum_valid_hours: pm ? DAQI_PM_ROLLING24H_REQUIRED_HOURS : 1 }),
      'invalid_report', 'rolling PM/NO2 dependency evidence changed');
    }
    evidence((change.bundle_integrity === undefined) === (change.authentication === undefined)
      && (change.bundle_integrity === undefined) === (change.logical_identities === undefined),
    'invalid_report', 'partial or invented bundle authentication evidence');
    if (change.bundle_integrity !== undefined) {
      keys(change.authentication, ['state', 'authenticated', 'writer', 'change_id', 'receipt',
        'bundle', 'declared_final_publication', 'missing_proof', 'inspected_seam', 'action'], ['original_acceptance']);
      keys(change.authentication.writer, ['identity', 'invocation_id']);
      assertReference(change.authentication.bundle, { managed: true, gzip: true });
      canonicalReference(change.authentication.declared_final_publication);
      const originalOnly = change.authentication.authenticated === true
        && change.authentication.state === 'original_prune_event_authenticated'
        && change.authentication.writer.identity === 'prune_daily_v3';
      if (originalOnly) {
        assertPruneAcceptanceAuthority(change.authentication.original_acceptance);
        evidence(change.authentication.original_acceptance.key.run_id === change.authentication.writer.invocation_id,
          'invalid_report', 'Original receipt authentication has contradictory writer invocation');
      }
      evidence(change.bundle_integrity === 'verified' && object(change.authentication)
        && (originalOnly || (change.authentication.authenticated === false
          && change.authentication.state === 'reconciliation_required'))
        && change.authentication.change_id === change.change_id
        && same(change.authentication.receipt, change.receipt)
        && Array.isArray(change.authentication.missing_proof)
        && (originalOnly ? change.authentication.missing_proof.length === 0 : change.authentication.missing_proof.length > 0)
        && change.authentication.missing_proof.length <= 16
        && change.authentication.missing_proof.every(x => typeof x === 'string' && x.length > 0 && x.length <= 128)
        && typeof change.authentication.writer.identity === 'string'
        && typeof change.authentication.writer.invocation_id === 'string'
        && typeof change.authentication.action === 'string'
        && Array.isArray(change.logical_identities)
        && same(change.logical_identities.map(x => x.scope_key).sort(), [...seenScopes.keys()].sort()),
      'invalid_report', 'bundle integrity incorrectly promoted to writer authentication');
      inspectLogical(change.logical_identities, seenScopes);
    }
    if (change.original_scope_authorities !== undefined) {
      evidence(change.authentication?.authenticated === true && Array.isArray(change.original_scope_authorities)
        && instant(change.original_verified_at_utc)
        && same(change.original_scope_authorities.map(s => s.scope_key).sort(), [...seenScopes.keys()].sort()),
      'invalid_report', 'Original scope authority requires complete independent original authentication');
      for (const s of change.original_scope_authorities) {
        keys(s, ['scope_key', 'physical_sha256', 'leaf', 'index', 'binding', 'effective_status']);
        const declared = seenScopes.get(s.scope_key);
        const i = declared.identity, suffix = `day_utc=${declared.day_utc}/connector_id=${i.connector_id}/pollutant_code=${i.pollutant_code}`;
        evidence(sha.test(s.physical_sha256) && s.effective_status === 'original_schema3_embedded_status_bound'
          && s.index.key === `history/_index_v3/observations_timeseries/${suffix}/manifest.json`
          && s.leaf.key === `history/_index_v3/observations_timeseries/${suffix}/timeseries_id=${String(i.timeseries_id).padStart(9, '0')}.json`
          && s.binding.key === `history/_index_v3/timeseries_binding/timeseries_id=${i.timeseries_id}.json`,
        'invalid_report', 'Original exact physical/status/binding identity is contradictory');
        for (const ref of [s.index, s.leaf, s.binding]) {
          canonicalReference(ref);
          evidence(ref.bucket === declared.after.authority.bucket, 'invalid_report', 'Original scope authority bucket mismatch');
        }
      }
    }
    evidence(change.original_verified_at_utc === undefined || change.original_scope_authorities !== undefined,
      'invalid_report', 'Original gate time requires independent original writer scope authority');
  }
  evidence(same([...registered].sort(), report.control_snapshot.registered_change_ids),
    'invalid_report', 'registered change coverage contradicts control projection');
  let canonicalScopes = new Map();
  if (report.canonical !== null) {
    const c = report.canonical;
    keys(c, ['schema_version', 'kind', 'generation', 'binding_prefix', 'read_consistent',
      'authority_complete', 'freshness', 'scopes', 'provenance', 'diagnostics', 'resources'],
    stage3c ? ['source_as_of', 'page_count', 'page_scope_limit',
      ...(modern ? ['selection', 'recheck_evidence', 'closing_root', 'capacity'] : [])] : []);
    evidence(c.generation?.version === 'v3'
      && same(c.generation, getObservationHistoryGeneration('v3')),
    'invalid_report', 'canonical inspection must identify the exact selected v3 generation');
    evidence(c.schema_version === (modern ? 3 : stage3c ? 2 : 1) && c.kind === 'uk_aq_jsongen_canonical_inspection'
      && c.generation.version === 'v3' && c.authority_complete === false
      && c.freshness === 'source_as_of_only' && typeof c.read_consistent === 'boolean'
      && c.binding_prefix === c.generation.timeseries_binding_index_prefix
      && Array.isArray(c.scopes) && c.scopes.length <= scopeLimit
      && Array.isArray(c.provenance) && c.provenance.length <= getLimit
      && c.provenance.every(r => (canonicalReference(r), true))
      && Array.isArray(c.diagnostics) && c.diagnostics.length <= LIMITS.metadata_gets
      && c.diagnostics.every(diagnostic),
    'invalid_report', 'canonical metadata claimed unsupported authority');
    keys(c.resources, ['derived_gets', 'metadata_gets', 'derived_bytes', 'metadata_bytes', 'decompressed_bytes', 'rows']);
    evidence(Object.entries(c.resources).every(([key, value]) => safe(value)
      && value <= report.resources[key]), 'invalid_report', 'canonical inspection resource evidence exceeds operation');
    canonicalScopes = new Map();
    for (const item of c.scopes) {
      keys(item, ['scope_key', 'identity', 'day_utc', 'diagnostics', 'state'],
        ['observations', 'physical', 'binding', 'verification']);
      assertIdentity(item.identity);
      evidence(scopeId.test(item.scope_key) && item.scope_key === `${monthKey(item.identity, item.day_utc.slice(0, 7))}:${item.day_utc}`
        && instant(`${item.day_utc}T00:00:00.000Z`)
        && (modern ? ['metadata_only', 'not_inspected_partition', 'not_inspected_resource_limit'].includes(item.state)
          : item.state === 'metadata_only') && !canonicalScopes.has(item.scope_key)
        && Array.isArray(item.diagnostics) && item.diagnostics.length <= LIMITS.metadata_gets
        && item.diagnostics.every(diagnostic)
        && (item.physical === undefined || ['present', 'authoritative_absent'].includes(item.physical.membership))
        && (item.observations === undefined || ['partition_present', 'authoritative_absent'].includes(item.observations.membership)),
      'invalid_report', 'invalid canonical scope inspection');
      if (item.observations !== undefined) {
        keys(item.observations, ['membership', 'chain', 'absent_at']);
        evidence(Array.isArray(item.observations.chain) && item.observations.chain.length <= 6,
          'invalid_report', 'invalid root-to-scope chain');
        for (const ref of item.observations.chain) {
          keys(ref, ['bucket', 'key', 'sha256', 'byte_size', 'logical_hash']);
          canonicalReference({ bucket: ref.bucket, key: ref.key, sha256: ref.sha256, byte_size: ref.byte_size });
          evidence(sha.test(ref.logical_hash), 'invalid_report', 'invalid canonical logical hash');
        }
      }
      if (item.physical !== undefined) {
        keys(item.physical, ['membership', 'row_count'], ['index', 'leaf', 'aligned_shard', 'physical_identity',
          ...(stage3c ? ['scope_sha256'] : [])]);
        evidence(safe(item.physical.row_count)
          && (item.physical.membership === 'present') === (item.physical.row_count > 0),
        'invalid_report', 'invalid physical row count');
        if (item.physical.physical_identity !== undefined) {
          const p = item.physical.physical_identity;
          keys(p, ['history_schema_version', 'writer_version', 'physical_layout_version']);
          evidence(item.physical.membership === 'present' && [3, 4].includes(p.history_schema_version)
            && p.writer_version === `parquet-wasm-zstd-v${p.history_schema_version}`
            && p.physical_layout_version === 'timeseries-aligned-v2',
          'invalid_report', 'unsupported scoped physical identity');
        }
        for (const field of ['index', 'leaf', 'aligned_shard']) {
          if (item.physical[field] !== undefined) canonicalReference(item.physical[field]);
        }
        if (stage3c && item.physical.membership === 'present') evidence(sha.test(item.physical.scope_sha256),
          'invalid_report', 'Stage 3C present scope requires its exact physical projection');
      }
      if (item.binding !== undefined) canonicalReference(item.binding);
      if (item.verification !== undefined) {
        evidence(!modern || item.verification.state !== 'overlay_metadata_verified',
          'invalid_report', 'Stage 3C has no independently authenticated accepted-overlay transition adapter');
        keys(item.verification, ['state'], ['manifest', 'entry', 'scope_sha256']);
        evidence(['embedded_status_requires_writer_evidence', 'overlay_metadata_verified',
          'overlay_authoritative_connector_unresolved', 'unknown_verification_transition_state',
          'not_applicable_to_absent_scope'].includes(item.verification.state)
          && (item.verification.state !== 'not_applicable_to_absent_scope'
            || (item.physical?.membership === 'authoritative_absent'
              && Object.keys(item.verification).length === 1))
          && (!['embedded_status_requires_writer_evidence', 'overlay_metadata_verified'].includes(item.verification.state)
            || item.physical?.membership === 'present')
          && !(item.physical?.physical_identity?.history_schema_version === 4
            && item.verification.state === 'embedded_status_requires_writer_evidence')
          && (item.verification.state !== 'overlay_metadata_verified' ||
            (item.verification.manifest && item.verification.entry && item.verification.scope_sha256)),
          'invalid_report', 'verification metadata is not writer status authentication');
        if (item.verification.manifest !== undefined) canonicalReference(item.verification.manifest);
        if (item.verification.scope_sha256 !== undefined) evidence(sha.test(item.verification.scope_sha256),
          'invalid_report', 'invalid verification scope digest');
      }
      canonicalScopes.set(item.scope_key, item);
    }
    if (stage3c) assertSourceAsOf(c, report);
    if (modern) assertInspectionCapacity(c, report);
  }
  const hasRegisteredAuthority = s => report.changes.some(c => c.registered && c.scopes.some(x =>
    x.scope_key === s.scope_key && (!stage3c || currentScopeMatch(c, x, report.canonical) === 'matches')));
  for (const change of report.changes) for (const item of change.scopes) {
    if (item.canonical_membership !== undefined) {
      const current = report.canonical?.read_consistent ? canonicalScopes.get(item.scope_key) : null;
      evidence(item.canonical_membership === (current?.physical?.membership || 'unknown'),
        'invalid_report', 'scope membership contradicts canonical inspection');
    }
  }
  for (const uncovered of report.uncovered_scopes) {
    keys(uncovered, ['scope_key', 'code', 'detail']);
    evidence(uncovered.code === 'canonical_scope_without_registered_receipt'
      && typeof uncovered.detail === 'string' && uncovered.detail.length > 0
      && report.canonical?.read_consistent && canonicalScopes.get(uncovered.scope_key)?.physical?.membership === 'present'
      && !hasRegisteredAuthority(uncovered),
    'invalid_report', 'uncovered scope contradicts registered/current metadata');
  }
  const expectedUncovered = report.canonical?.read_consistent ? [...canonicalScopes.values()]
    .filter(s => s.physical?.membership === 'present'
      && !hasRegisteredAuthority(s))
    .map(s => s.scope_key).sort() : [];
  evidence(same(report.uncovered_scopes.map(x => x.scope_key).sort(), expectedUncovered),
    'invalid_report', 'current unregistered scope omitted from diagnostics');
  const monthKeys = new Set();
  for (const m of report.months) {
    keys(m, ['month_key', 'desired_change_ids', 'applied_change_ids', 'selected_pub_id',
      'selected_source', 'context', 'retained_change_ids', 'state', 'context_authentication']);
    evidence(typeof m.month_key === 'string' && monthId.test(m.month_key)
      && instant(`${m.month_key.slice(-7)}-01T00:00:00.000Z`)
      && !monthKeys.has(m.month_key)
      && set(m.desired_change_ids) && set(m.applied_change_ids) && set(m.retained_change_ids)
      && m.applied_change_ids.every(id => m.desired_change_ids.includes(id))
      && m.state === 'reconciliation_required' && m.context_authentication === 'not_established'
      && (m.selected_pub_id === null || uuid.test(m.selected_pub_id))
      && (m.selected_source === null || (assertSource(m.selected_source), true))
      && Array.isArray(m.context), 'invalid_report', 'invalid month dependency evidence');
    monthKeys.add(m.month_key);
  }
  for (const change of report.changes) for (const m of change.affected_months || []) {
    const match = report.months.find(x => x.month_key === monthKey(m.identity, m.month_utc));
    evidence(match && match.retained_change_ids.includes(change.change_id)
      && (!change.registered || match.desired_change_ids.includes(change.change_id)),
    'invalid_report', 'retained PM/adjacent-month dependency dropped');
  }
  for (const m of report.months) {
    const expected = report.changes.filter(c => c.affected_months?.some(a => monthKey(a.identity, a.month_utc) === m.month_key))
      .map(c => c.change_id).sort();
    evidence(same(m.retained_change_ids, expected), 'invalid_report', 'month retained-change membership is contradictory');
  }
  evidence(Object.values(report.resources).every(safe)
    && report.resources.metadata_gets <= getLimit
    && report.resources.derived_gets <= (stage3c ? 3 : 2) * LIMITS.receipt_references
    && report.resources.derived_bytes + report.resources.metadata_bytes + report.resources.decompressed_bytes <= LIMITS.total_bytes
    && report.resources.rows <= LIMITS.total_rows
    && Array.isArray(report.actions) && report.actions.length > 0 && report.actions.length <= 16
    && report.actions.every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096),
  'invalid_report', 'invalid processing resource or action evidence');
  if (controlRead !== null) {
    const control = controlRead.control;
    if (report.schema_version === 4) {
      evidence(Object.entries(control.authenticated_events || {}).every(([id, record]) =>
        report.authenticated_events.some(e => e.event_id === id && e.registered && same(e.descriptor, record.descriptor)
          && same(e.authority, record.authority) && same(e.event, record.event)
          && same(e.expected_changes, record.receipt_objects.map(r => r.change_id))))
        && report.authenticated_events.filter(e => e.registered).every(e => control.authenticated_events?.[e.event_id]),
      'invalid_report', 'Authenticated event registration differs from inspected control');
    }
    evidence(same(report.months.filter(m => Object.hasOwn(control.months, m.month_key)).map(m => m.month_key).sort(),
      Object.keys(control.months).sort()), 'invalid_report', 'inspected control month omitted');
    for (const change of report.changes.filter(c => c.registered)) {
      const entry = control.registered_changes[change.change_id];
      evidence(entry && same(entry.receipt_object, change.receipt)
        && (change.scopes.length === 0 || same(change.scopes.map(s => s.declared_scope), entry.receipt.scopes))
        && (change.affected_months === undefined || same(change.affected_months, entry.receipt.affected_months)),
      'invalid_report', 'registered receipt differs from inspected control');
    }
    for (const m of report.months) {
      const source = control.months[m.month_key];
      if (source) evidence(same(m.desired_change_ids, source.desired_change_ids)
        && same(m.applied_change_ids, source.applied_change_ids)
        && m.selected_pub_id === (source.selected?.publication.pub_id || null)
        && same(m.selected_source, source.selected?.publication.source || null)
        && same(m.context, source.selected?.publication.context || []),
      'invalid_report', 'month differs from inspected control');
    }
  }
  if (stage3c) assertStage3C(report);
  return report;
}

function assertSourceAsOf(c, report) {
  const s = c.source_as_of;
  keys(s, ['state', 'identity_sha256', 'boundary', 'observations_root', 'started_at_utc', 'finished_at_utc',
    'consistency', 'completeness_fence', 'limitations']);
  keys(s.boundary, ['generation', 'scope_keys', 'metadata', 'unavailable_metadata_keys']);
  evidence(s.state === (c.read_consistent ? 'bounded_metadata_recheck_passed' : 'fresh_inspection_required')
    && s.identity_sha256 === sha256Hex(canonicalJson(s.boundary))
    && same(s.boundary.generation, c.generation) && same(s.boundary.metadata, c.provenance)
    && same(s.boundary.scope_keys, c.schema_version === 3 ? c.selection?.selected_scope_keys : c.scopes.map(x => x.scope_key).sort())
    && set(s.boundary.unavailable_metadata_keys) && s.boundary.unavailable_metadata_keys.length <= (c.schema_version === 3 ? INSPECTION_MAX_METADATA_GETS : LIMITS.metadata_gets)
    && same(c.provenance.map(r => r.key), [...new Set(c.provenance.map(r => r.key))].sort())
    && !s.boundary.unavailable_metadata_keys.some(key => c.provenance.some(r => r.key === key))
    && instant(s.started_at_utc) && instant(s.finished_at_utc) && s.started_at_utc <= s.finished_at_utc
    && s.finished_at_utc <= report.inspected_at_utc
    && Number.isSafeInteger(c.page_scope_limit) && c.page_scope_limit > 0 && c.page_scope_limit <= LIMITS.scopes
    && c.page_count === Math.ceil(c.scopes.length / c.page_scope_limit) && c.page_count >= 1
    && s.consistency === 'shared_first_read_cache_then_all_observed_metadata_rechecked'
    && s.completeness_fence === 'unavailable' && Array.isArray(s.limitations) && s.limitations.length === 2
    && s.limitations.every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096),
  'invalid_report', 'Mixed, stale or incomplete source-as-of metadata boundary');
  const root = c.provenance.find(r => r.key === c.generation.observations_root_key) || null;
  evidence(same(s.observations_root, root) && (!c.read_consistent || root),
    'invalid_report', 'Read-consistent inspection requires its exact observed root');
  for (const item of c.scopes) {
    const refs = [...(item.observations?.chain || []).map(({ logical_hash: _h, ...r }) => r),
      ...['index', 'leaf', 'aligned_shard'].map(k => item.physical?.[k]), item.binding, item.verification?.manifest].filter(Boolean);
    evidence(refs.every(ref => c.provenance.some(p => same(p, ref))), 'invalid_report', 'Scope combines incompatible metadata snapshots');
  }
}

function assertStage3C(report) {
  const result = report.stage3c;
  const authenticatedEvents = report.schema_version === 4 ? report.authenticated_events : [];
  evidence(Array.isArray(authenticatedEvents) && authenticatedEvents.length <= LIMITS.receipt_references
    && new Set(authenticatedEvents.map(e => e.event_id)).size === authenticatedEvents.length,
  'invalid_report', 'Invalid authenticated event coverage');
  for (const e of authenticatedEvents) {
    keys(e, ['event_id', 'authority', 'descriptor', 'event', 'expected_changes', 'original_authenticated',
      'descriptor_retained', 'selected_receipts_retained', 'registered', 'diagnostics']);
    assertPruneAcceptanceAuthority(e.authority); assertPruneEventReference(e.descriptor); assertPruneEventSummary(e.event);
    evidence(e.event_id === e.authority.event_id && Array.isArray(e.expected_changes)
      && e.expected_changes.length <= LIMITS.receipt_references && e.expected_changes.every(id => changeId.test(id))
      && new Set(e.expected_changes).size === e.expected_changes.length
      && ['original_authenticated', 'descriptor_retained', 'selected_receipts_retained', 'registered'].every(k => typeof e[k] === 'boolean')
      && Array.isArray(e.diagnostics) && e.diagnostics.every(diagnostic)
      && (!e.original_authenticated || (e.descriptor_retained && e.expected_changes.length === e.event.partition_count)),
    'invalid_report', 'Inconsistent original/selected descriptor states');
    const authenticated = report.changes.filter(c => c.authentication?.authenticated
      && c.authentication.original_acceptance.event_id === e.event_id);
    evidence(authenticated.every(c => e.expected_changes.includes(c.change_id))
      && e.selected_receipts_retained === (e.original_authenticated && e.expected_changes.every(id =>
        report.changes.some(c => c.change_id === id && c.bundle_integrity === 'verified' && c.authentication?.authenticated))),
    'invalid_report', 'Selected receipt coverage contradicts original event');
    if (e.selected_receipts_retained) evidence(authenticated.flatMap(c => c.scopes).length === e.event.selected.scope_count,
      'invalid_report', 'Selected coverage is not full original coverage');
  }
  evidence(object(result) && Array.isArray(result.original_events) && result.original_events.length <= LIMITS.receipt_references,
    'invalid_report', 'Stage 3C event coverage required');
  const eventIds = new Set();
  const originalGroups = result.original_events.map(g => {
    assertPruneAcceptanceAuthority(g.authority);
    evidence(!eventIds.has(g.event_id) && g.event_id === g.authority.event_id
      && safe(g.scope_count) && g.scope_count > 0 && g.scope_count <= PRUNE_PENDING_SOURCE_LIMITS.scopes
      && sha.test(g.group_sha256) && Array.isArray(g.expected_changes) && g.expected_changes.length > 0
      && g.expected_changes.length <= LIMITS.receipt_references
      && new Set(g.expected_changes).size === g.expected_changes.length && g.expected_changes.every(id => changeId.test(id)),
    'invalid_report', 'Invalid complete original event coverage');
    eventIds.add(g.event_id);
    const authenticated = report.changes.filter(c => c.authentication?.authenticated
      && c.authentication.original_acceptance.event_id === g.event_id);
    evidence(authenticated.every(c => g.expected_changes.includes(c.change_id)
      && same(c.authentication.original_acceptance, g.authority)), 'invalid_report', 'Original event omits authenticated receipts');
    if (g.expected_changes.every(id => authenticated.some(c => c.change_id === id))) {
      const scopes = authenticated.flatMap(c => c.scopes.map(s => s.scope_key));
      evidence(scopes.length === g.scope_count && new Set(scopes).size === scopes.length,
        'invalid_report', 'Complete original event drops or duplicates physical scopes');
    }
    return { event_id: g.event_id, authority: g.authority, scope_count: g.scope_count,
      group_sha256: g.group_sha256, expected_changes: g.expected_changes,
      ...([3, 4].includes(report.schema_version) ? { expected_scope_keys: g.expected_scope_keys } : {}) };
  });
  const d = result.discovery;
  if (d !== null) {
    keys(d, ['mode', 'from', 'to', 'events', 'state', 'next', 'window_pass_finished', 'coverage_complete', 'replay', 'canonical_precedence']);
    evidence(['recent', 'resweep'].includes(d.mode) && Number.isFinite(Date.parse(d.from)) && Number.isFinite(Date.parse(d.to))
      && Date.parse(d.to) >= Date.parse(d.from) && Date.parse(d.to) - Date.parse(d.from) <= 7 * 86400000
      && Array.isArray(d.events) && d.events.length <= OUTBOX_PAGE_LIMIT && new Set(d.events.map(e => e.event_id)).size === d.events.length
      && d.state === 'replay_required' && d.coverage_complete === false
      && d.window_pass_finished === (d.next === null)
      && d.replay === 'restart_overlapping_windows_and_periodic_historical_resweeps'
      && d.canonical_precedence === 'not_established_by_discovery', 'invalid_report', 'Discovery is not a complete writer inventory');
    for (const e of d.events) {
      keys(e, ['key', 'event_id', 'reference_sha256']); assertPruneAcceptanceKey(e.key);
      evidence(e.event_id === pruneAcceptanceId(e.key) && sha.test(e.reference_sha256), 'invalid_report', 'Invalid discovered event identity');
    }
    if (d.next !== null) {
      keys(d.next, ['from', 'to', 'mode', 'accepted_at', 'key']); assertPruneAcceptanceKey(d.next.key);
      evidence(d.next.from === d.from && d.next.to === d.to && d.next.mode === d.mode
        && Date.parse(d.next.accepted_at) >= Date.parse(d.from) && Date.parse(d.next.accepted_at) <= Date.parse(d.to),
      'invalid_report', 'Invalid bounded discovery cursor');
    }
  }
  evidence(same(result, assessStage3C({ changes: report.changes, canonical: report.canonical, originalGroups, discovery: d, authenticatedEvents })),
    'invalid_report', 'Stage 3C currentness/coverage contradicts its independently inspectable evidence');
}

function assertInspectionCapacity(c, report) {
  evidence(Array.isArray(report.stage3c?.original_events), 'invalid_report', 'Original event coverage table required');
  const wanted = planInspection(c.scopes.map(s => ({ identity: s.identity, day_utc: s.day_utc })),
    c.selection?.selected_partition, c.page_scope_limit);
  evidence(same(c.selection, wanted), 'invalid_report', 'Missing, overlapping or contradictory inspection partitions');
  const selected = new Set(wanted.selected_scope_keys), all = new Set(c.scopes.map(s => s.scope_key));
  for (const change of report.changes) for (const s of change.scopes)
    evidence(all.has(s.scope_key), 'invalid_report', 'Original receipt scope omitted from full inspection accounting');
  for (const group of report.stage3c.original_events) {
    evidence(set(group.expected_scope_keys) && group.expected_scope_keys.length === group.scope_count
      && group.expected_scope_keys.every(key => scopeId.test(key) && all.has(key)),
    'invalid_report', 'Complete original event membership omitted from inspection accounting');
    const authenticated = report.changes.filter(change => change.authentication?.original_acceptance?.event_id === group.event_id
      && change.authentication.authenticated).flatMap(change => change.scopes.map(s => s.scope_key));
    evidence(authenticated.every(key => group.expected_scope_keys.includes(key)), 'invalid_report', 'Original group physical scope identity mismatch');
  }
  for (const s of c.scopes) evidence(selected.has(s.scope_key) ? s.state !== 'not_inspected_partition'
    : s.state === 'not_inspected_partition' && s.diagnostics.length === 0 && !s.physical && !s.binding && !s.verification && !s.observations,
  'invalid_report', 'Unselected scopes cannot carry current-inspection authority');
  const p = planMetadataRequests(c.scopes.filter(s => selected.has(s.scope_key)), c.generation), cap = c.capacity;
  keys(cap, ['deterministic_keys', 'status_manifest_allowance', 'initial_get_allowance', 'metadata_get_allowance',
    'metadata_get_limit', 'initial_gets', 'recheck_gets', 'closing_root_gets', 'cache_bytes', 'peak_concurrency',
    'initial_bytes', 'recheck_bytes', 'closing_root_bytes', 'previous_metadata_bytes',
    'previous_metadata_gets', 'initial_keys', 'recheck_keys', 'concurrency_limit', 'cache_byte_limit', 'elapsed_ms', 'duration_limit_ms']);
  evidence(Object.entries(p).every(([key, value]) => same(cap[key], value))
    && set(cap.initial_keys) && set(cap.recheck_keys) && cap.initial_gets === cap.initial_keys.length
    && cap.recheck_gets === cap.recheck_keys.length && cap.recheck_keys.every(key => cap.initial_keys.includes(key))
    && [0, 1].includes(cap.closing_root_gets) && safe(cap.previous_metadata_gets)
    && Number.isSafeInteger(cap.metadata_get_limit) && cap.metadata_get_limit > 0
    && cap.metadata_get_limit <= p.metadata_get_allowance && cap.metadata_get_limit <= INSPECTION_MAX_METADATA_GETS
    && c.resources.metadata_gets === cap.previous_metadata_gets + cap.initial_gets + cap.recheck_gets + cap.closing_root_gets
    && [cap.previous_metadata_bytes, cap.initial_bytes, cap.recheck_bytes, cap.closing_root_bytes].every(safe)
    && c.resources.metadata_bytes === cap.previous_metadata_bytes + cap.initial_bytes + cap.recheck_bytes + cap.closing_root_bytes
    && c.resources.metadata_gets <= cap.metadata_get_limit
    && cap.concurrency_limit === INSPECTION_CONCURRENCY && safe(cap.peak_concurrency) && cap.peak_concurrency <= cap.concurrency_limit
    && cap.cache_byte_limit === LIMITS.metadata_bytes && safe(cap.cache_bytes) && cap.cache_bytes <= cap.cache_byte_limit
    && cap.cache_bytes <= c.resources.metadata_bytes && safe(cap.elapsed_ms)
    && Number.isSafeInteger(cap.duration_limit_ms) && cap.duration_limit_ms > 0 && cap.duration_limit_ms <= LIMITS.duration_ms
    && (!c.read_consistent || cap.elapsed_ms <= cap.duration_limit_ms),
  'invalid_report', 'Metadata plan, concurrency, cache, deadline or GET accounting bypass');
  const connectorIds = new Set(c.scopes.filter(s => selected.has(s.scope_key)).map(s => s.identity.connector_id));
  const overlay = key => [...connectorIds].some(id => new RegExp(`^history/v3/verification/connector_id=${id}/manifests/[a-f0-9]{64}\\.json$`).test(key));
  evidence(cap.initial_keys.every(key => p.deterministic_keys.includes(key) || overlay(key))
    && cap.initial_keys.filter(overlay).length <= p.status_manifest_allowance
    && c.provenance.every(ref => cap.initial_keys.includes(ref.key))
    && c.source_as_of.boundary.unavailable_metadata_keys.every(key => cap.initial_keys.includes(key)),
  'invalid_report', 'Metadata read outside selected physical-scope plan');
  evidence(Array.isArray(c.recheck_evidence)
    && same(c.recheck_evidence.map(e => e.key), cap.initial_keys), 'invalid_report', 'Missing or duplicate metadata recheck evidence');
  const originals = new Map(c.provenance.map(ref => [ref.key, ref]));
  const absent = new Set(c.source_as_of.boundary.unavailable_metadata_keys);
  for (const e of c.recheck_evidence) {
    keys(e, ['key', 'state', 'current']);
    evidence(['matched', 'changed', 'unavailable', 'not_rechecked'].includes(e.state)
      && (cap.recheck_keys.includes(e.key) || e.state === 'not_rechecked'), 'invalid_report', 'Invented metadata recheck');
    if (e.current !== null) {
      canonicalReference(e.current); evidence(e.current.key === e.key, 'invalid_report', 'Recheck changed object key');
    }
    if (e.state === 'matched') evidence(originals.has(e.key) ? same(originals.get(e.key), e.current)
      : absent.has(e.key) && e.current === null, 'invalid_report', 'Recheck identity does not match initial byte authority');
    if (e.state === 'changed') evidence(originals.has(e.key) ? !same(originals.get(e.key), e.current)
      : !absent.has(e.key) || e.current !== null, 'invalid_report', 'False metadata drift');
    if (['unavailable', 'not_rechecked'].includes(e.state)) evidence(e.current === null, 'invalid_report', 'Unavailable recheck claims byte authority');
  }
  if (c.closing_root !== null) {
    canonicalReference(c.closing_root);
    evidence(cap.closing_root_gets === 1 && c.closing_root.key === c.generation.observations_root_key,
      'invalid_report', 'Missing closing root GET');
  }
  if (c.read_consistent) evidence(c.recheck_evidence.every(e => e.state === 'matched')
    && same(cap.initial_keys, cap.recheck_keys) && cap.closing_root_gets === 1
    && same(c.closing_root, c.source_as_of.observations_root)
    && cap.initial_bytes === c.provenance.reduce((n, ref) => n + ref.byte_size, 0)
    && cap.cache_bytes === cap.initial_bytes && cap.recheck_bytes === cap.initial_bytes
    && cap.closing_root_bytes === c.closing_root.byte_size,
  'invalid_report', 'Incomplete rechecks or contradictory byte accounting cannot establish source-as-of consistency');
}
