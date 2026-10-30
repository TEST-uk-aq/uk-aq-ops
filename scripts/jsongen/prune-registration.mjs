// Manual read-only Stage 3D Phase 1. Original authentication and deterministic
// receipt construction belong to the existing consumer, not this diagnostic.
import { readManagedControl } from './control.mjs';
import { controlSnapshot } from './control-snapshot.mjs';
import { originalPruneAcceptance } from './prune-outbox-reader.mjs';
import { authenticatePruneHandover, inspectAuthenticatedPruneHandover } from './prune-consumer-authentication.mjs';
import { buildSelectedPruneEvent } from './prune-selected-event.mjs';
import { buildPruneReceiptGroup, inspectPruneReceiptGroup } from './prune-receipts.mjs';
import { readPruneEventDescriptor, readReceipt, readBundle } from './inputs.mjs';
import { authenticateFinalPublication } from './writer-authentication.mjs';
import { CONTROL_KEY, same, scopeKey } from './schema.mjs';
import { assertManagedR2CredentialMode } from './r2-config.mjs';
import { createPruneHandoverBudget, evidence, JSONgenEvidenceError, PRUNE_PENDING_SOURCE_LIMITS } from './limits.mjs';
import { classifyPruneRegistration, assertPruneRegistrationReport, assertPruneDiscoveryRequest,
  registrationArtifact } from './prune-registration-report.mjs';

// Fixed code-owned diagnostics only. Remote errors can contain URLs, SQL or
// private evidence; neither their messages nor arbitrary codes enter reports.
function failure(error) {
  if (error?.status === 404) return { state: 'missing', reason: 'exact_object_not_found' };
  if (error instanceof JSONgenEvidenceError && error.code === 'missing_original_authority')
    return { state: 'unknown', reason: 'original_authority_incomplete' };
  if (error instanceof JSONgenEvidenceError && ['reader_configuration_required', 'outbox_read_unavailable',
    'outbox_connection_unavailable'].includes(error.code)) return { state: 'unknown', reason: 'restricted_reader_unavailable' };
  if (error instanceof JSONgenEvidenceError) return error.code === 'resource_limit'
    ? { state: 'unknown', reason: 'resource_limit' }
    : { state: 'reconciliation_required', reason: 'evidence_rejected' };
  return { state: 'unknown', reason: 'read_or_validation_unavailable' };
}
const unknown = reason => ({ state: 'unknown', reason });
async function retained(operation) {
  try { await operation(); return { state: 'retained', reason: 'exact_authenticated_readback' }; }
  catch (error) { return failure(error); }
}
function registration(control, id, expected) {
  if (!control) return unknown('control_unavailable');
  const entry = control.registered_changes[id];
  if (!entry) return { state: 'missing', reason: 'absent_from_exact_control' };
  return same(entry.receipt, expected.receipt) && same(entry.receipt_object, expected.receipt_object)
    ? { state: 'registered', reason: 'exact_authenticated_group_member' }
    : { state: 'reconciliation_required', reason: 'conflicting_control_member' };
}

export async function reconcilePruneRegistrations({ derivedR2, pruneReader, pruneDiscovery,
  budget = createPruneHandoverBudget() }) {
  assertManagedR2CredentialMode(derivedR2, 'read');
  assertPruneDiscoveryRequest(pruneDiscovery);
  // One shared existing 120s/192MiB original-handover budget for the entire
  // bounded page, including comparisons. Never restart it for another event.
  const report = { schema_version: 1, kind: 'uk_aq_jsongen_prune_registration_diagnostic',
    inspected_at_utc: new Date().toISOString(), finished_at_utc: null, state: 'reconciliation_required',
    publication_selection: 'disabled', publication_eligible: false,
    complete_change_coverage: false, writer_coverage: 'unknown', freshness: 'unknown',
    current_canonical_authority: 'not_inspected', coherent_canonical_snapshot: false,
    control: { state: 'unknown', snapshot: null, object: null, etag: null },
    discovery_request: structuredClone(pruneDiscovery), discovery: null,
    discovery_state: unknown('discovery_unavailable'), events: [],
    limitations: ['optional_aurn_outbox_is_not_a_complete_prune_inventory',
      'integrity_v3_sos_light_ifw_coverage_unresolved', 'discovery_absence_is_not_event_absence',
      'registration_does_not_establish_canonical_dominance_or_freshness',
      'independent_source_as_of_inspections_cannot_be_combined',
      'complete_all_writer_coverage_and_managed_publication_eligibility_not_established'],
    resources: null, admitted: null, limits: budget.limits };
  let controlRead = null;
  try {
    controlRead = await readManagedControl(derivedR2, { budget });
    report.control = controlRead ? { state: 'available', snapshot: controlSnapshot(controlRead.control, controlRead),
      object: { bucket: derivedR2.bucket, key: CONTROL_KEY, sha256: controlRead.sha256, byte_size: controlRead.body.length },
      etag: controlRead.etag } : { ...report.control, state: 'missing' };
  } catch (error) { report.control.state = failure(error).state; }
  const control = controlRead?.control || null;
  try {
    evidence(pruneReader, 'reader_configuration_required', 'Existing restricted original reader required');
    budget.check(); report.discovery = await pruneReader.discover(pruneDiscovery); budget.check();
    report.discovery_state = { state: 'available', reason: 'bounded_page_only' };
  } catch (error) { report.discovery_state = failure(error); }
  const receiptKeys = new Set(), selectedScopeKeys = new Set();
  for (const discovered of report.discovery?.events || []) {
    const item = { ...discovered, classification: 'unknown',
      original: unknown('original_authentication_unavailable'), evidence: null, family: 'unknown', group_complete: false,
      group_sha256: null,
      diagnostic: null, failure_stage: null,
      descriptor: null, partitions: [], registration: unknown('original_authentication_required'),
      retention: unknown('original_authentication_required') };
    report.events.push(item);
    let stage = 'original_outbox_read';
    try {
      budget.check();
      const acceptance = await pruneReader.read(discovered.key); budget.check();
      if (!acceptance) { item.original = unknown('discovered_original_not_visible_on_replay'); continue; }
      originalPruneAcceptance(acceptance);
      stage = 'original_reference_binding';
      evidence(acceptance.event_id === discovered.event_id && same(acceptance.key, discovered.key)
        && acceptance.post_commit_reference.sha256 === discovered.reference_sha256,
      'conflicting_original_event', 'Discovery/replay original identity mismatch');
      stage = 'original_authentication';
      const handover = await authenticatePruneHandover({ acceptance, derivedR2, budget });
      const proof = inspectAuthenticatedPruneHandover(handover);
      item.original = { state: 'authenticated', reason: 'original_outbox_private_source_and_final_evidence' };
      stage = 'selected_group_construction';
      const selected = buildSelectedPruneEvent({ handover, budget });
      item.evidence = { authority: selected.original_authority, summary: selected.event,
        source_identity: proof.source_identity, pending_source: proof.pending.source,
        original_evidence_bundle: proof.original_evidence_bundle,
        sources: selected.descriptor.coverage.sources };
      // Preserve the consumer's legacy replay identity, including retained but
      // unregistered v2 groups. Only wholly supported originals can use v2.
      let group = selected, legacy = Object.values(control?.registered_changes || {}).some(e =>
        e.receipt.schema_version === 2 && e.receipt.origin.authority.event_id === item.event_id);
      if (!legacy && !control?.authenticated_events?.[item.event_id] && selected.event.unsupported.scope_count === 0) {
        stage = 'legacy_family_probe';
        const candidate = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover, budget }));
        evidence(new Set([...receiptKeys, ...candidate.entries.map(e => e.receipt_object.key),
          ...selected.entries.map(e => e.receipt_object.key)]).size <= budget.limits.receipt_references,
        'resource_limit', 'Legacy identity probes exceed receipt-reference budget');
        for (const entry of candidate.entries) {
          receiptKeys.add(entry.receipt_object.key);
          try {
            await readReceipt({ r2: derivedR2, reference: entry.receipt_object, expected: entry.receipt, budget });
            legacy = true; group = candidate; break;
          } catch (error) { if (error.status !== 404) throw error; }
        }
      }
      if (legacy && group === selected) group = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover, budget }));
      item.family = legacy ? 'legacy_receipt_v2' : 'selected_receipt_v3';
      item.group_sha256 = group.group_sha256;
      stage = 'group_admission_and_comparison';
      const newKeys = group.entries.flatMap(e => e.receipt.scopes.map(scopeKey));
      evidence(new Set([...receiptKeys, ...group.entries.map(e => e.receipt_object.key)]).size <= budget.limits.receipt_references
        && new Set([...selectedScopeKeys, ...newKeys]).size <= PRUNE_PENDING_SOURCE_LIMITS.scopes,
      'resource_limit', 'Complete page groups exceed existing receipt or selected-scope cap');
      group.entries.forEach(e => receiptKeys.add(e.receipt_object.key));
      newKeys.forEach(k => selectedScopeKeys.add(k));
      // Record every expected member before doing readback, including members
      // left unknown if a byte/row/deadline cap interrupts inspection.
      item.partitions = group.entries.map(e => ({ change_id: e.receipt.change_id,
        receipt: e.receipt_object, bundle: e.receipt.bundle.object,
        scope_keys: e.receipt.scopes.map(scopeKey).sort(), row_count: e.receipt.bundle.row_count,
        source: e.receipt.source, registration: registration(control, e.receipt.change_id, e),
        receipt_retention: unknown('not_inspected'), bundle_retention: unknown('not_inspected') }));
      if (!legacy) {
        const expected = { descriptor: selected.descriptor_object, authority: selected.original_authority,
          event: selected.event, receipt_objects: selected.entries.map(e => ({ change_id: e.receipt.change_id, receipt_object: e.receipt_object })) };
        const record = control?.authenticated_events?.[item.event_id];
        const { registered_at_utc: _at, ...actual } = record || {};
        item.descriptor = { reference: selected.descriptor_object,
          registration: !control ? unknown('control_unavailable')
            : !record ? { state: 'missing', reason: 'absent_from_exact_control' }
              : same(actual, expected) ? { state: 'registered', reason: 'exact_authenticated_group_member' }
                : { state: 'reconciliation_required', reason: 'conflicting_control_member' },
          retention: await retained(() => readPruneEventDescriptor({ r2: derivedR2, reference: selected.descriptor_object,
            expected: selected.descriptor, budget })) };
      }
      item.group_complete = true;
      const extras = Object.values(control?.registered_changes || {}).filter(e => [2, 3].includes(e.receipt.schema_version)
        && e.receipt.origin.authority.event_id === item.event_id
        && !group.entries.some(x => same(x.receipt, e.receipt) && same(x.receipt_object, e.receipt_object)));
      for (const [i, entry] of group.entries.entries()) {
        const partition = item.partitions[i];
        partition.receipt_retention = await retained(() => readReceipt({ r2: derivedR2,
          reference: entry.receipt_object, expected: entry.receipt, budget }));
        // Even a missing stored receipt does not prevent checking the expected
        // bundle against the independently reconstructed complete source.
        partition.bundle_retention = await retained(async () => {
          const bundle = await readBundle({ r2: derivedR2, receipt: entry.receipt, budget });
          const authenticated = authenticateFinalPublication({ input: { ...entry, bundle }, pruneHandover: handover, budget });
          evidence(authenticated.authenticated, 'missing_original_authority', 'Original bundle authentication required');
        });
      }
      const registered = [...item.partitions.map(p => p.registration), ...(item.descriptor ? [item.descriptor.registration] : [])];
      item.registration = extras.length ? { state: 'reconciliation_required', reason: 'conflicting_control_member' }
        : aggregate(registered, 'registered');
      item.retention = aggregate([...item.partitions.flatMap(p => [p.receipt_retention, p.bundle_retention]),
        ...(item.descriptor ? [item.descriptor.retention] : [])], 'retained');
    } catch (error) {
      const problem = failure(error);
      item.diagnostic = problem;
      item.failure_stage = stage;
      // Missing original PENDING/evidence is incomplete original authority, not
      // proof that a JSONgen receipt or descriptor was never retained.
      if (item.original.state !== 'authenticated') item.original = problem.state === 'missing'
        ? unknown('original_evidence_incomplete') : problem;
      item.registration = unknown('complete_group_not_resolved');
      item.retention = unknown('complete_group_not_resolved');
    } finally { item.classification = classifyPruneRegistration(item); }
  }
  report.resources = budget.snapshot();
  report.admitted = { receipt_references: receiptKeys.size, selected_scopes: selectedScopeKeys.size };
  report.finished_at_utc = new Date().toISOString();
  assertPruneRegistrationReport(report, { controlRead });
  // Validate the bounded serialization while the exact read is still in hand.
  const artifact = registrationArtifact(report);
  return { report, controlBody: controlRead?.body || null, artifact };
}

function aggregate(items, complete) {
  const conflict = items.find(x => x.state === 'reconciliation_required');
  if (conflict) return conflict;
  const missing = items.find(x => x.state === 'missing');
  if (missing) return missing;
  const unresolved = items.find(x => x.state !== complete);
  return unresolved || { state: complete, reason: 'complete_authenticated_group' };
}
