// Explicitly invoked library only: no CLI, scheduling, canonical writes or dispatch.
import { sha256Hex, r2PutObjectConditional } from '../../workers/shared/r2_sigv4.mjs';
import { assertControl, canonicalJson, same, scopeKey, monthKey, ROOT, BUCKET } from './schema.mjs';
import { MAX_CONTROL_BYTES, updateManagedControl } from './control.mjs';
import { readReceipt, readBundle, readImmutable, admitDerived } from './inputs.mjs';
import { readCanonicalScopes } from './authority.mjs';
import { authenticateFinalPublication } from './writer-authentication.mjs';
import { createBudget, evidence, freeze, JSONgenEvidenceError } from './limits.mjs';

export async function reconcileManagedInputs({ derivedR2, control, retainedReceipts = [],
  canonical, requestedScopes = [], writerKinds = {}, budget = createBudget() }) {
  control = structuredClone(control); assertControl(control);
  const controlBytes = canonicalJson(control);
  evidence(controlBytes.length <= MAX_CONTROL_BYTES, 'resource_limit', 'control admission size exceeded');
  evidence(Array.isArray(retainedReceipts) && retainedReceipts.length <= budget.limits.receipt_references,
    'resource_limit', 'retained receipt reference budget exceeded');
  const registered = Object.entries(control.registered_changes);
  evidence(registered.length <= budget.limits.receipt_references, 'resource_limit', 'registered receipt reference budget exceeded; partition operation explicitly');
  const refs = new Map();
  for (const [, entry] of registered) refs.set(entry.receipt_object.key, entry.receipt_object);
  for (const ref of retainedReceipts) {
    const old = refs.get(ref.key);
    evidence(!old || same(old, ref), 'invalid_object_identity', 'same receipt key with contradictory identity');
    refs.set(ref.key, structuredClone(ref));
  }
  evidence(refs.size <= budget.limits.receipt_references, 'resource_limit', 'combined receipt reference budget exceeded');
  const changes = []; const scopes = new Map(); const ids = new Map();
  const addScope = scope => {
    scopes.set(scopeKey(scope), scope);
    evidence(scopes.size <= budget.limits.scopes, 'resource_limit', 'combined canonical scope budget exceeded');
  };
  evidence(Array.isArray(requestedScopes) && requestedScopes.length <= budget.limits.scopes, 'resource_limit', 'requested scope budget exceeded');
  requestedScopes.forEach(addScope);
  registered.forEach(([, e]) => e.receipt.scopes.forEach(addScope));
  for (const ref of refs.values()) {
    const entry = registered.find(([, e]) => e.receipt_object.key === ref.key);
    const change = { change_id: entry?.[0] || null, receipt: ref, registered: Boolean(entry),
      state: 'reconciliation_required', diagnostics: [], scopes: [] };
    changes.push(change);
    try {
      const receipt = await readReceipt({ r2: derivedR2, reference: ref, expected: entry?.[1].receipt, budget });
      change.change_id = receipt.change_id;
      const prior = ids.get(receipt.change_id);
      evidence(!prior || same(prior, ref), 'stable_change_identity_mismatch', 'change ID reused across retained receipts');
      const registeredEntry = control.registered_changes[receipt.change_id];
      evidence(!registeredEntry || same(registeredEntry.receipt_object, ref), 'stable_change_identity_mismatch', 'retained change conflicts with registered receipt');
      ids.set(receipt.change_id, ref);
      change.scopes = receipt.scopes.map(s => ({ scope_key: scopeKey(s), declared_state: s.after.state,
        declared_authority: s.after.authority, state: 'reconciliation_required' }));
      receipt.scopes.forEach(addScope);
      change.affected_months = receipt.affected_months;
      change.rolling_aqi = receipt.rolling_aqi;
      if (!change.registered) change.diagnostics.push({ code: 'retained_receipt_missing_registration',
        detail: 'A retained receipt is absent from this control snapshot; its verified canonical origin is still unproven.' });
      let bundle;
      try { bundle = await readBundle({ r2: derivedR2, receipt, budget }); }
      catch (error) {
        change.diagnostics.push({ code: error.status === 404 ? 'missing_retained_bundle' : error.code || 'invalid_bundle', detail: error.message });
        continue;
      }
      change.bundle_integrity = 'verified';
      change.logical_identities = bundle.logical;
      change.authentication = authenticateFinalPublication({ input: { receipt, receipt_object: ref, bundle }, writerKind: writerKinds[receipt.writer.identity] });
    } catch (error) {
      change.diagnostics.push({ code: error.status === 404 ? 'missing_retained_receipt' : error.code || 'invalid_receipt', detail: error.message });
    }
  }
  let current = null;
  const diagnostics = [{ code: 'unknown_receipt_coverage',
    detail: 'No independently authenticated durable writer outbox/inventory establishes complete change coverage. An unchanged control revision proves neither coverage nor canonical freshness.' }];
  if (scopes.size) {
    try { current = await readCanonicalScopes({ ...canonical, scopes: [...scopes.values()], budget }); }
    catch (error) { diagnostics.push({ code: error.code || 'canonical_metadata_unavailable', detail: error.message }); }
  } else diagnostics.push({ code: 'unknown_scope_coverage', detail: 'No bounded canonical scope set was supplied or declared.' });
  for (const change of changes) for (const scope of change.scopes) {
    const now = current?.scopes.find(s => s.scope_key === scope.scope_key);
    scope.canonical_membership = current?.read_consistent ? now?.physical?.membership || 'unknown' : 'unknown';
    const matchingObject = now?.observations?.chain.find(r => r.key === scope.declared_authority.key && r.bucket === scope.declared_authority.bucket)
      || [now?.physical?.index, now?.physical?.leaf].find(r => r?.key === scope.declared_authority.key && r.bucket === scope.declared_authority.bucket);
    scope.declared_pin_relation = !current?.read_consistent || !matchingObject ? 'unknown'
      : matchingObject.sha256 === scope.declared_authority.sha256 && matchingObject.byte_size === scope.declared_authority.byte_size
        ? 'matches_current_metadata' : 'differs_from_current_metadata';
    // Neither a matching pin nor current absence proves the ORIGINAL final rows.
    scope.authenticated_supersession = 'unproven';
    if (scope.declared_state === 'authoritative_empty') scope.empty_replacement =
      scope.canonical_membership === 'authoritative_absent' ? 'current_absence_proven_original_writer_absence_unproven' : 'absence_unproven_or_contradictory';
  }
  const uncovered = (current?.read_consistent ? current.scopes : []).filter(s => s.physical?.membership === 'present'
    && !changes.some(c => c.registered && c.scopes.some(x => x.scope_key === s.scope_key))).map(s => ({ scope_key: s.scope_key,
      code: 'canonical_scope_without_registered_receipt',
      detail: 'Current requested scope has no registered receipt coverage. Metadata cannot identify the missing writer/event or reconstruct its rows.' }));
  const months = new Map(Object.entries(control.months).map(([key, value]) => [key, {
    month_key: key, desired_change_ids: [...value.desired_change_ids], applied_change_ids: [...value.applied_change_ids],
    selected_pub_id: value.selected?.publication.pub_id || null,
    selected_source: value.selected?.publication.source || null,
    context: value.selected?.publication.context || [], retained_change_ids: [],
    state: 'reconciliation_required', context_authentication: 'not_established',
  }]));
  for (const c of changes) for (const m of c.affected_months || []) {
    const k = monthKey(m.identity, m.month_utc);
    if (!months.has(k)) months.set(k, { month_key: k, desired_change_ids: [], applied_change_ids: [], selected_pub_id: null,
      selected_source: null, context: [], retained_change_ids: [], state: 'reconciliation_required', context_authentication: 'not_established' });
    months.get(k).retained_change_ids.push(c.change_id);
  }
  return freeze({ schema_version: 1, kind: 'uk_aq_jsongen_reconciliation', inspected_at_utc: new Date().toISOString(),
    control_snapshot: { control_id: control.control_id, revision: control.revision, operation_id: control.operation_id, sha256: sha256Hex(controlBytes) },
    state: 'reconciliation_required', publication_selection: 'disabled', complete_change_coverage: false,
    freshness: 'unknown', changes, canonical: current, uncovered_scopes: uncovered,
    months: [...months.values()].map(m => ({ ...m, retained_change_ids: [...new Set(m.retained_change_ids)].sort() })),
    diagnostics, resources: budget.snapshot(),
    actions: ['Retain unresolved receipts, bundles and this report; do not garbage-collect them on metadata drift.',
      'Obtain writer-owned final-source authentication and durable outbox coverage before classifying authenticated current/superseded scopes.',
      'Authenticate selected baseline and all adjacent-month PM context separately; never rebuild from Parquet automatically.'] });
}

// Durable immutable diagnostics, with no new mutable state or Stage 1 schema.
export function reconciliationArtifact(report, budget = createBudget()) {
  evidence(report?.schema_version === 1 && report.kind === 'uk_aq_jsongen_reconciliation'
    && report.state === 'reconciliation_required' && report.publication_selection === 'disabled'
    && report.complete_change_coverage === false && report.freshness === 'unknown', 'invalid_report', 'expected fail-closed Stage 2 report');
  const body = canonicalJson(report);
  evidence(body.length <= budget.limits.report_bytes, 'resource_limit', 'reconciliation report admission exceeded');
  const hash = sha256Hex(body);
  return { body, reference: { bucket: BUCKET, key: `${ROOT}/evidence/${hash}.json`, sha256: hash, byte_size: body.length } };
}
export async function retainReconciliationReport({ r2, report, budget = createBudget() }) {
  admitDerived(r2);
  const { body, reference } = reconciliationArtifact(report, budget);
  let outcome = 'written';
  try {
    await r2PutObjectConditional({ r2, key: reference.key, body, content_type: 'application/json', sha256: reference.sha256, if_none_match: '*' });
  } catch (error) {
    if (!['R2_PRECONDITION_FAILED', 'R2_WRITE_AMBIGUOUS'].includes(error.code)) throw error;
    outcome = error.code === 'R2_PRECONDITION_FAILED' ? 'already_retained' : 'confirmed_after_ambiguous_write';
  }
  try {
    const readback = await readImmutable({ r2, reference, maxBytes: budget.limits.report_bytes, budget });
    evidence(readback.equals(body), 'ambiguous_report_retention', 'reconciliation report readback mismatch');
  } catch (cause) {
    const error = new JSONgenEvidenceError('ambiguous_report_retention', 'Report retention unconfirmed; preserve this reference and retry readback before deciding', cause);
    error.reference = reference;
    throw error;
  }
  return { outcome, reference };
}
export async function recordReconciliationRequired({ r2, report, budget = createBudget() }) {
  // If retention fails or is ambiguous, there is no control update. If control
  // CAS fails, the immutable report survives. Neither outcome marks work complete.
  const retained = await retainReconciliationReport({ r2, report, budget });
  const result = await updateManagedControl({ r2, command: { type: 'record_failure', failure: {
    code: 'incomplete_source_change_registration', state: 'reconcile_required', at_utc: new Date().toISOString(),
    detail: `Stage 2 evidence ${retained.reference.key}; writer authentication/coverage unresolved; inspected control revision ${report.control_snapshot.revision}`,
  } } });
  return { ...retained, control: result };
}
