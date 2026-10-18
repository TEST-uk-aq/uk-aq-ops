// Explicitly invoked library only: no CLI, scheduling, canonical writes or dispatch.
import { sha256Hex, r2PutObjectConditional } from '../../workers/shared/r2_sigv4.mjs';
import { assertControl, canonicalJson, inspectSourceGeneration, same, scopeKey, monthKey, ROOT, BUCKET } from './schema.mjs';
import { getObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { MAX_CONTROL_BYTES, updateManagedControl } from './control.mjs';
import { readReceipt, readBundle, readImmutable, admitDerived } from './inputs.mjs';
import { readCanonicalScopePages } from './authority.mjs';
import { authenticateFinalPublication } from './writer-authentication.mjs';
import { createBudget, evidence, freeze, JSONgenEvidenceError, PRUNE_PENDING_SOURCE_LIMITS } from './limits.mjs';
import { controlSnapshot } from './control-snapshot.mjs';
import { assertReconciliationReport } from './report-validation.mjs';
import { authenticatePruneHandover, inspectAuthenticatedPruneHandover } from './prune-consumer-authentication.mjs';
import { buildPruneReceiptGroup, inspectPruneReceiptGroup } from './prune-receipts.mjs';
import { assessStage3C, currentScopeMatch } from './currentness.mjs';
import { assertInspectionScope } from './scope-authority.mjs';

// Event-scoped replay is independent of the 128-scope current-metadata inspector.
// It reconstructs all partitions from the original outbox/private pending source,
// and can repair retention/registration only in explicitly requested retain mode.
export async function reconcilePruneAcceptance(options) {
  const { consumePruneAcceptance } = await import('./prune-consumer.mjs');
  return consumePruneAcceptance(options);
}

export async function reconcileManagedInputs({ derivedR2, control, controlRead = null, retainedReceipts = [],
  canonical, requestedScopes = [], writerKinds = {}, pruneReader = null, pruneDiscovery = null, budget = createBudget() }) {
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
  const changes = []; const scopes = new Map(); const ids = new Map(); const originalEvents = new Map();
  const originalGroups = new Map(), expectedReceipts = new Map();
  const addScope = scope => {
    assertInspectionScope(scope);
    scopes.set(scopeKey(scope), scope);
    evidence(scopes.size <= PRUNE_PENDING_SOURCE_LIMITS.scopes, 'resource_limit', 'combined 1,024 physical scope budget exceeded');
  };
  evidence(Array.isArray(requestedScopes) && requestedScopes.length <= PRUNE_PENDING_SOURCE_LIMITS.scopes, 'resource_limit', 'requested scope budget exceeded');
  requestedScopes.forEach(addScope);
  registered.forEach(([, e]) => e.receipt.scopes.forEach(addScope));
  for (const ref of refs.values()) {
    const entry = registered.find(([, e]) => e.receipt_object.key === ref.key);
    const change = { change_id: entry?.[0] || expectedReceipts.get(ref.key)?.change_id || null, receipt: ref, registered: Boolean(entry),
      state: 'reconciliation_required', diagnostics: [], scopes: [] };
    changes.push(change);
    try {
      const receipt = await readReceipt({ r2: derivedR2, reference: ref, expected: entry?.[1].receipt || expectedReceipts.get(ref.key), budget });
      change.change_id = receipt.change_id;
      const sourceGeneration = inspectSourceGeneration(receipt.source, getObservationHistoryGeneration('v3'));
      change.diagnostics.push({ code: sourceGeneration.state, detail: sourceGeneration.detail });
      const prior = ids.get(receipt.change_id);
      evidence(!prior || same(prior, ref), 'stable_change_identity_mismatch', 'change ID reused across retained receipts');
      const registeredEntry = control.registered_changes[receipt.change_id];
      evidence(!registeredEntry || same(registeredEntry.receipt_object, ref), 'stable_change_identity_mismatch', 'retained change conflicts with registered receipt');
      ids.set(receipt.change_id, ref);
      change.scopes = receipt.scopes.map(s => ({ scope_key: scopeKey(s), declared_scope: s, declared_state: s.after.state,
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
      let pruneHandover = null;
      try {
        if (receipt.schema_version === 2 && pruneReader) {
          const id = receipt.origin.authority.event_id;
          if (!originalEvents.has(id)) {
            originalEvents.set(id, (async () => {
              budget.check(); const acceptance = await pruneReader.read(receipt.origin.authority.key); budget.check();
              evidence(acceptance, 'missing_original_authority', 'Original PostgreSQL event is unavailable for receipt replay');
              return authenticatePruneHandover({ acceptance, derivedR2, budget });
            })());
          }
          pruneHandover = await originalEvents.get(id);
          const proof = inspectAuthenticatedPruneHandover(pruneHandover);
          const group = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover: pruneHandover, budget }));
          originalGroups.set(id, { event_id: id, authority: proof.authority,
            scope_count: group.plan.physical_scope_count, group_sha256: group.group_sha256,
            expected_changes: group.entries.map(e => e.receipt.change_id) });
          evidence(new Set([...refs.keys(), ...group.entries.map(e => e.receipt_object.key)]).size <= budget.limits.receipt_references,
            'resource_limit', 'Complete event partition reference budget exceeded');
          evidence(new Set([...scopes.keys(), ...group.entries.flatMap(e => e.receipt.scopes.map(scopeKey))]).size <= PRUNE_PENDING_SOURCE_LIMITS.scopes,
            'resource_limit', 'Complete original event exceeds combined physical scope budget');
          // Discover every deterministic partition of this authenticated event.
          // Readback remains separate; absence is missing retention, never an
          // invented receipt. Shared outbox/private-source replay happens once.
          for (const expected of group.entries) {
            const old = refs.get(expected.receipt_object.key);
            evidence(!old || same(old, expected.receipt_object), 'invalid_object_identity', 'Conflicting original partition identity');
            refs.set(expected.receipt_object.key, expected.receipt_object);
            expectedReceipts.set(expected.receipt_object.key, expected.receipt);
            expected.receipt.scopes.forEach(addScope);
          }
          evidence(refs.size <= budget.limits.receipt_references, 'resource_limit', 'Complete event partition reference budget exceeded');
        }
        change.authentication = authenticateFinalPublication({ input: { receipt, receipt_object: ref, bundle },
          writerKind: writerKinds[receipt.writer.identity], pruneHandover });
        if (change.authentication.authenticated) {
          const proof = inspectAuthenticatedPruneHandover(pruneHandover);
          change.original_scope_authorities = receipt.scopes.map(s => proof.scopeAuthorities[scopeKey(s)]);
          change.original_verified_at_utc = receipt.source.verified_at_utc;
        }
      } catch (error) {
        change.authentication = authenticateFinalPublication({ input: { receipt, receipt_object: ref, bundle },
          writerKind: writerKinds[receipt.writer.identity] });
        change.diagnostics.push({ code: error.code || 'original_event_authentication_unavailable',
          detail: 'Original event/private source authentication failed; retain reconciliation-required state without a canonical observation fallback.' });
      }
      change.diagnostics.push(change.authentication.authenticated
        ? { code: 'original_prune_event_authenticated', detail: 'Original event and complete bundle authenticated; current canonical dominance and intervening writer coverage remain unresolved.' }
        : { code: 'writer_authentication_unavailable', detail: 'Immutable bytes require independent original writer authentication.' });
    } catch (error) {
      change.diagnostics.push({ code: error.status === 404 ? 'missing_retained_receipt' : error.code || 'invalid_receipt', detail: error.message });
    }
  }
  let current = null;
  const diagnostics = [{ code: 'unknown_receipt_coverage',
    detail: 'No independently authenticated durable writer outbox/inventory establishes complete change coverage. An unchanged control revision proves neither coverage nor canonical freshness.' }];
  if (scopes.size) {
    try { current = await readCanonicalScopePages({ ...canonical, scopes: [...scopes.values()], budget }); }
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
  let discovery = null;
  if (pruneDiscovery) {
    try {
      evidence(pruneReader, 'reader_configuration_required', 'Private reader required for bounded discovery');
      budget.check(); discovery = await pruneReader.discover(pruneDiscovery); budget.check();
    } catch (error) { diagnostics.push({ code: error.code || 'outbox_discovery_unavailable',
      detail: 'Bounded original outbox discovery unavailable; repeat overlapping windows and historical resweeps.' }); }
  }
  const assessment = assessStage3C({ changes, canonical: current, originalGroups: [...originalGroups.values()], discovery });
  const uncovered = (current?.read_consistent ? current.scopes : []).filter(s => s.physical?.membership === 'present'
    && !changes.some(c => c.registered && c.scopes.some(x => x.scope_key === s.scope_key
      && currentScopeMatch(c, x, current) === 'matches'))).map(s => ({ scope_key: s.scope_key,
      code: 'canonical_scope_without_registered_receipt',
      detail: 'Current requested scope has no matching authenticated registered receipt authority. Metadata cannot identify the missing writer/event or reconstruct its rows.' }));
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
  const report = { schema_version: 2, kind: 'uk_aq_jsongen_reconciliation', inspected_at_utc: new Date().toISOString(),
    control_snapshot: controlSnapshot(control, controlRead),
    state: 'reconciliation_required', publication_selection: 'disabled', complete_change_coverage: false,
    freshness: 'unknown', changes, canonical: current, stage3c: assessment, uncovered_scopes: uncovered,
    months: [...months.values()].map(m => ({ ...m, retained_change_ids: [...new Set(m.retained_change_ids)].sort() })),
    diagnostics, resources: budget.snapshot(),
    actions: ['Retain unresolved receipts, bundles and this report; do not garbage-collect them on metadata drift.',
      'Obtain writer-owned final-source authentication and durable outbox coverage before classifying authenticated current/superseded scopes.',
      'Authenticate selected baseline and all adjacent-month PM context separately; never rebuild from Parquet automatically.'] };
  assertReconciliationReport(report, { controlRead });
  return freeze(report);
}

// Durable immutable diagnostics, with no new mutable state or Stage 1 schema.
export function reconciliationArtifact(report, budget = createBudget()) {
  assertReconciliationReport(report);
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
  assertReconciliationReport(report);
  evidence(report.control_snapshot.byte_provenance === 'exact_read', 'invalid_control_snapshot',
    'failure recording requires an original-byte control inspection');
  const retained = await retainReconciliationReport({ r2, report, budget });
  const result = await updateManagedControl({ r2, command: { type: 'record_failure', failure: {
    code: 'incomplete_source_change_registration', state: 'reconcile_required', at_utc: new Date().toISOString(),
    detail: `Stage 2 evidence ${retained.reference.key}; writer authentication/coverage unresolved; inspected control revision ${report.control_snapshot.revision}`,
  }, expected_control_snapshot: report.control_snapshot } });
  if (result.outcome === 'stale_reconciliation_inspection') return {
    outcome: 'stale_reconciliation_inspection', report_retention: retained.outcome,
    reference: retained.reference, control: result, new_inspection_required: true,
  };
  return { ...retained, control: result };
}
