// Inert Stage 2 entry points. Capabilities are invocation-local WeakMap keys,
// issued only after independent original authentication and exact stored reads.
import { ROOT, BUCKET, ALGORITHM, canonicalJson, same, assertReceipt, assertBundleRecords, affectedMonths } from './schema.mjs';
import { assertPruneEventDescriptor, assertDescriptorReceipts, pruneEventSummary } from './prune-event-schema.mjs';
import { planPruneSelectedCoverage } from './prune-coverage-plan.mjs';
import { inspectAuthenticatedPruneHandover } from './prune-consumer-authentication.mjs';
import { reconstructPruneSelectedPartitions, prunePartitionArtifacts } from './prune-consumer-partitions.mjs';
import { retainImmutable } from './prune-receipts.mjs';
import { readPruneEventDescriptor, readReceipt, readBundle, admitDerived } from './inputs.mjs';
import { assertManagedR2CredentialMode, managedR2Environment } from './r2-config.mjs';
import { DAQI_PM_ROLLING24H_WINDOW_HOURS, DAQI_PM_ROLLING24H_REQUIRED_HOURS } from '../../lib/aqi/aqi_levels.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { evidence, freeze, LIMITS } from './limits.mjs';

const constructed = new WeakMap(), retained = new WeakMap();
export function buildSelectedPruneEvent({ handover, budget = null }) {
  const proof = inspectAuthenticatedPruneHandover(handover);
  budget ||= proof.operationBudget;
  evidence(budget === proof.operationBudget, 'operation_budget_mismatch', 'Selected event must share its original authentication budget');
  if (constructed.has(handover)) { budget.check(); return constructed.get(handover).public; }
  const { descriptor_preview: _preview, ...coverage } = planPruneSelectedCoverage({ handover, budget });
  const descriptor = assertPruneEventDescriptor({ schema_version: 1, kind: 'uk_aq_jsongen_authenticated_prune_event',
    writer: proof.writer, coverage });
  const bytes = canonicalJson(descriptor);
  budget.bytes('decompressed', bytes.length);
  const reference = { bucket: BUCKET, key: `${ROOT}/authenticated-events/${sha256Hex(bytes)}.json`,
    sha256: sha256Hex(bytes), byte_size: bytes.length };
  const plan = reconstructPruneSelectedPartitions({ handover, budget, coverage: { contract: coverage.contract,
    policy: coverage.policy, original: coverage.coverage_sha256.original, selected: coverage.coverage_sha256.selected } });
  evidence(same(plan, coverage.partitions), 'conflicting_selected_plan', 'Selected reconstruction changed the authenticated partition plan');
  const artifacts = prunePartitionArtifacts(plan), event = pruneEventSummary(coverage);
  const entries = plan.partitions.map((p, i) => {
    const scopes = artifacts[i].scopes, source = proof.sources[scopes[0].identity.pollutant_code];
    const pm = scopes[0].identity.pollutant_code !== 'no2';
    const receipt = assertReceipt({ schema_version: 3, kind: 'uk_aq_jsongen_verified_change', change_id: p.change_id,
      writer: proof.writer, source, scopes, affected_months: affectedMonths(scopes),
      rolling_aqi: { algorithm_version: ALGORITHM, preceding_hours: pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0,
        following_hours: pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0, minimum_valid_hours: pm ? DAQI_PM_ROLLING24H_REQUIRED_HOURS : 1 },
      bundle: { schema_version: 1, format: p.format, change_id: p.change_id, object: p.object,
        scope_count: p.scope_count, row_count: p.row_count },
      verification: { state: 'canonical_final_verified', authority: source.final_publication,
        provenance_authority: proof.authority, scope_completeness_authority: proof.authority },
      durability: { state: 'verified_pending', retained_receipt_authority: proof.authority },
      origin: { authority: proof.authority, pending_source: proof.pending.source, source_identity: proof.source_identity,
        source_status: proof.original_source_status, global_lock: proof.original_global_lock, descriptor: reference,
        event, partition_index: i, partition: p } });
    assertBundleRecords(artifacts[i].records, receipt);
    const body = canonicalJson(receipt);
    evidence(body.length <= LIMITS.receipt_bytes, 'resource_limit', 'Selected receipt exceeds byte limit');
    budget.bytes('decompressed', body.length);
    return { receipt, receipt_object: { bucket: BUCKET, key: `${ROOT}/receipts/${sha256Hex(body)}.json`,
      sha256: sha256Hex(body), byte_size: body.length } };
  });
  assertDescriptorReceipts(descriptor, reference, entries.map(e => e.receipt));
  const publicEvent = freeze({ descriptor, descriptor_object: reference, event, event_id: proof.authority.event_id,
    original_authority: proof.authority, group_sha256: event.coverage_sha256.partition_group, plan, entries });
  constructed.set(handover, { public: publicEvent, artifacts });
  budget.check(); return publicEvent;
}
export function authenticateSelectedPruneInput({ input, handover, budget }) {
  const event = buildSelectedPruneEvent({ handover, budget });
  const i = event.entries.findIndex(e => e.receipt.change_id === input?.receipt?.change_id);
  evidence(i >= 0, 'conflicting_selected_receipt', 'Selected receipt change ID is not in the authenticated descriptor');
  const artifact = constructed.get(handover).artifacts[i];
  evidence(same(input.receipt, event.entries[i].receipt)
    && same(input.receipt_object, event.entries[i].receipt_object)
    && input.bundle?.integrity === 'verified' && same(input.bundle.records, artifact.records),
  'conflicting_selected_receipt', 'Selected receipt/bundle differs from authenticated descriptor');
  return freeze({ state: 'original_prune_event_authenticated', authenticated: true,
    writer: { identity: input.receipt.writer.identity, invocation_id: input.receipt.writer.invocation_id },
    change_id: input.receipt.change_id, receipt: input.receipt_object, bundle: input.receipt.bundle.object,
    declared_final_publication: input.receipt.source.final_publication, missing_proof: [],
    original_acceptance: event.original_authority, inspected_seam: null,
    action: 'Original event and selected scope authenticated; current canonical dominance and monthly eligibility remain unresolved.' });
}
export async function retainSelectedPruneEvent({ handover, r2, budget = null, progress = () => {} }) {
  assertManagedR2CredentialMode(r2, 'write'); admitDerived(r2);
  const proof = inspectAuthenticatedPruneHandover(handover);
  evidence(proof.authority.key.environment === managedR2Environment(r2), 'cross_environment_evidence', 'Retained event differs from configured storage environment');
  budget ||= proof.operationBudget;
  evidence(budget === proof.operationBudget, 'operation_budget_mismatch', 'Retention cannot restart the original authentication budget');
  const event = buildSelectedPruneEvent({ handover, budget });
  const descriptorOutcome = await retainImmutable({ r2, reference: event.descriptor_object,
    body: canonicalJson(event.descriptor), contentType: 'application/json', budget });
  await readPruneEventDescriptor({ r2, reference: event.descriptor_object, expected: event.descriptor, budget });
  progress({ descriptor: 'retained', descriptor_outcome: descriptorOutcome });
  const outcomes = [];
  for (const [i, entry] of event.entries.entries()) {
    // Every partition still requires this invocation's private original token;
    // never authenticate a source independently for each partition/reset budget.
    inspectAuthenticatedPruneHandover(handover); budget.check();
    const artifact = constructed.get(handover).artifacts[i];
    const bundleOutcome = await retainImmutable({ r2, reference: entry.receipt.bundle.object, body: artifact.body,
      contentType: 'application/gzip', budget });
    const bundle = await readBundle({ r2, receipt: entry.receipt, budget });
    authenticateSelectedPruneInput({ input: { ...entry, bundle }, handover, budget });
    progress({ partition_index: i, bundle: 'retained', receipt: 'pending' });
    const receiptOutcome = await retainImmutable({ r2, reference: entry.receipt_object, body: canonicalJson(entry.receipt),
      contentType: 'application/json', budget });
    const receipt = await readReceipt({ r2, reference: entry.receipt_object, expected: entry.receipt, budget });
    authenticateSelectedPruneInput({ input: { ...entry, receipt, bundle }, handover, budget });
    outcomes.push({ partition_index: i, change_id: receipt.change_id, bundle: bundleOutcome, receipt: receiptOutcome });
    progress({ partition_index: i, bundle: 'retained', receipt: 'retained' });
  }
  assertDescriptorReceipts(event.descriptor, event.descriptor_object, event.entries.map(e => e.receipt));
  const token = Object.freeze({ event_id: event.event_id, descriptor_sha256: event.descriptor_object.sha256,
    group_sha256: event.group_sha256 });
  retained.set(token, { budget, public: freeze({ ...event, outcomes, descriptor_outcome: descriptorOutcome,
    state: 'retained', receipt_coverage_complete: true, handover_complete: false }) });
  budget.check(); return token;
}
export function retainedSelectedPruneEvent(token) {
  evidence(retained.has(token), 'unretained_selected_event', 'Exact descriptor and complete readback-verified selected event capability required');
  return retained.get(token).public;
}

export function retainedSelectedPruneBudget(token) {
  retainedSelectedPruneEvent(token); return retained.get(token).budget;
}
