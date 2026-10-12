// Validation of diagnostic evidence, never an authentication shortcut for a
// writer publication, canonical currentness, or complete receipt coverage.
import { validateObservationContentHashMetadata } from '../../workers/shared/uk_aq_observation_content_hash.mjs';
import { DAQI_PM_ROLLING24H_WINDOW_HOURS, DAQI_PM_ROLLING24H_REQUIRED_HOURS } from '../../lib/aqi/aqi_levels.mjs';
import { getObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { ROOT, BUCKET, ALGORITHM, assertIdentity, assertReference, assertScope,
  assertSource, affectedMonths, monthKey, same, scopeKey } from './schema.mjs';
import { LIMITS, evidence } from './limits.mjs';
import { assertControlSnapshot, controlSnapshot } from './control-snapshot.mjs';

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
  keys(report, ['schema_version', 'kind', 'inspected_at_utc', 'control_snapshot', 'state',
    'publication_selection', 'complete_change_coverage', 'freshness', 'changes', 'canonical',
    'uncovered_scopes', 'months', 'diagnostics', 'resources', 'actions']);
  evidence(report.schema_version === 1 && report.kind === 'uk_aq_jsongen_reconciliation'
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
    && Array.isArray(report.uncovered_scopes) && report.uncovered_scopes.length <= LIMITS.scopes
    && Array.isArray(report.months) && report.months.length <= 2 * LIMITS.scopes * LIMITS.receipt_references
    && Array.isArray(report.diagnostics) && report.diagnostics.length <= LIMITS.metadata_gets
    && report.diagnostics.some(d => d.code === 'unknown_receipt_coverage')
    && report.diagnostics.every(diagnostic), 'invalid_report', 'invalid change, month or coverage evidence');
  const seenRefs = new Set(); const seenIds = new Set(); const registered = new Set();
  for (const change of report.changes) {
    keys(change, ['change_id', 'receipt', 'registered', 'state', 'diagnostics', 'scopes'],
      ['affected_months', 'rolling_aqi', 'bundle_integrity', 'logical_identities', 'authentication']);
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
        'bundle', 'declared_final_publication', 'missing_proof', 'inspected_seam', 'action']);
      keys(change.authentication.writer, ['identity', 'invocation_id']);
      assertReference(change.authentication.bundle, { managed: true, gzip: true });
      canonicalReference(change.authentication.declared_final_publication);
      evidence(change.bundle_integrity === 'verified' && object(change.authentication)
        && change.authentication.authenticated === false
        && change.authentication.state === 'reconciliation_required'
        && change.authentication.change_id === change.change_id
        && same(change.authentication.receipt, change.receipt)
        && Array.isArray(change.authentication.missing_proof)
        && change.authentication.missing_proof.length > 0
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
  }
  evidence(same([...registered].sort(), report.control_snapshot.registered_change_ids),
    'invalid_report', 'registered change coverage contradicts control projection');
  let canonicalScopes = new Map();
  if (report.canonical !== null) {
    const c = report.canonical;
    keys(c, ['schema_version', 'kind', 'generation', 'binding_prefix', 'read_consistent',
      'authority_complete', 'freshness', 'scopes', 'provenance', 'diagnostics', 'resources']);
    evidence(c.generation?.version === 'v3'
      && same(c.generation, getObservationHistoryGeneration('v3')),
    'invalid_report', 'canonical inspection must identify the exact selected v3 generation');
    evidence(c.schema_version === 1 && c.kind === 'uk_aq_jsongen_canonical_inspection'
      && c.generation.version === 'v3' && c.authority_complete === false
      && c.freshness === 'source_as_of_only' && typeof c.read_consistent === 'boolean'
      && (c.binding_prefix === null || ['history/_index_v2/timeseries_binding',
        c.generation.timeseries_binding_index_prefix].includes(c.binding_prefix))
      && Array.isArray(c.scopes) && c.scopes.length <= LIMITS.scopes
      && Array.isArray(c.provenance) && c.provenance.length <= LIMITS.metadata_gets
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
        && item.state === 'metadata_only' && !canonicalScopes.has(item.scope_key)
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
        keys(item.physical, ['membership', 'row_count'], ['index', 'leaf', 'aligned_shard']);
        evidence(safe(item.physical.row_count)
          && (item.physical.membership === 'present') === (item.physical.row_count > 0),
        'invalid_report', 'invalid physical row count');
        for (const field of ['index', 'leaf', 'aligned_shard']) {
          if (item.physical[field] !== undefined) canonicalReference(item.physical[field]);
        }
      }
      if (item.binding !== undefined) canonicalReference(item.binding);
      if (item.verification !== undefined) {
        keys(item.verification, ['state'], ['manifest', 'entry', 'scope_sha256']);
        evidence(['embedded_status_requires_writer_evidence', 'overlay_metadata_verified'].includes(item.verification.state),
          'invalid_report', 'verification metadata is not writer status authentication');
        if (item.verification.manifest !== undefined) canonicalReference(item.verification.manifest);
        if (item.verification.scope_sha256 !== undefined) evidence(sha.test(item.verification.scope_sha256),
          'invalid_report', 'invalid verification scope digest');
      }
      canonicalScopes.set(item.scope_key, item);
    }
  }
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
      && !report.changes.some(c => c.registered && c.scopes.some(s => s.scope_key === uncovered.scope_key)),
    'invalid_report', 'uncovered scope contradicts registered/current metadata');
  }
  const expectedUncovered = report.canonical?.read_consistent ? [...canonicalScopes.values()]
    .filter(s => s.physical?.membership === 'present'
      && !report.changes.some(c => c.registered && c.scopes.some(x => x.scope_key === s.scope_key)))
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
    && report.resources.metadata_gets <= LIMITS.metadata_gets
    && report.resources.derived_gets <= 2 * LIMITS.receipt_references
    && report.resources.derived_bytes + report.resources.metadata_bytes + report.resources.decompressed_bytes <= LIMITS.total_bytes
    && report.resources.rows <= LIMITS.total_rows
    && Array.isArray(report.actions) && report.actions.length > 0 && report.actions.length <= 16
    && report.actions.every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096),
  'invalid_report', 'invalid processing resource or action evidence');
  if (controlRead !== null) {
    const control = controlRead.control;
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
  return report;
}
