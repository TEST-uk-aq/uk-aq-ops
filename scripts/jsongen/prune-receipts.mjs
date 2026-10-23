// Strict original-event receipts and immutable retention. PostgreSQL remains
// original gate authority; these R2 objects are derived receipts and bundles.
import { r2PutObjectConditional, sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { ROOT, BUCKET, ALGORITHM, canonicalJson, same, assertReceipt, assertBundleRecords,
  assertPruneReceiptGroup, pruneScopeCoverage, pruneGroupDigest, affectedMonths } from './schema.mjs';
import { DAQI_PM_ROLLING24H_WINDOW_HOURS, DAQI_PM_ROLLING24H_REQUIRED_HOURS } from '../../lib/aqi/aqi_levels.mjs';
import { LIMITS, createBudget, evidence, freeze, JSONgenEvidenceError } from './limits.mjs';
import { admitDerived, readImmutable, readReceipt, readBundle } from './inputs.mjs';
import { inspectAuthenticatedPruneHandover } from './prune-consumer-authentication.mjs';
import { planPruneScopePartitions, prunePartitionArtifacts } from './prune-consumer-partitions.mjs';
import { assertManagedR2CredentialMode, managedR2Environment } from './r2-config.mjs';

const groups = new WeakMap(); const cache = new WeakMap(); const retained = new WeakMap();
export function inspectPruneReceiptGroup(token) {
  const group = groups.get(token);
  evidence(group, 'unauthenticated_receipt_group', 'Original authenticated receipt construction required');
  return group.public;
}
export function retainedPruneEvent(token) {
  evidence(retained.has(token), 'unretained_original_event', 'Complete independently readback-verified original event required');
  return retained.get(token);
}
export function buildPruneReceiptGroup({ handover, budget = createBudget() }) {
  const proof = inspectAuthenticatedPruneHandover(handover);
  if (cache.has(handover)) return cache.get(handover);
  const plan = planPruneScopePartitions({ handover, budget });
  const artifacts = prunePartitionArtifacts(plan);
  const partitions = plan.partitions.map((p, i) => ({ change_id: p.change_id, scope_count: p.scope_count,
    row_count: p.row_count, coverage_sha256: pruneScopeCoverage(artifacts[i].scopes), bundle_sha256: p.object.sha256 }));
  const common = { authority: proof.authority, pending_source: proof.pending.source,
    source_identity: proof.source_identity, source_status: proof.original_source_status, global_lock: proof.original_global_lock,
    coverage_sha256: pruneScopeCoverage(artifacts.flatMap(a => a.scopes)), partitions,
    scope_count: plan.physical_scope_count, row_count: plan.observation_count };
  const groupHash = pruneGroupDigest(common);
  const entries = plan.partitions.map((p, i) => {
    const artifact = artifacts[i], scopes = artifact.scopes, code = scopes[0].identity.pollutant_code;
    evidence(scopes.every(s => s.identity.pollutant_code === code), 'invalid_source_authority', 'Each receipt must have one genuine original scoped index authority');
    const source = proof.sources[code]; const pm = code !== 'no2';
    const receipt = assertReceipt({ schema_version: 2, kind: 'uk_aq_jsongen_verified_change', change_id: p.change_id,
      writer: proof.writer, source, scopes,
      bundle: { schema_version: 1, format: 'complete_scope_ndjson_gzip', change_id: p.change_id,
        object: p.object, scope_count: p.scope_count, row_count: p.row_count },
      verification: { state: 'canonical_final_verified', authority: source.final_publication,
        provenance_authority: proof.authority, scope_completeness_authority: proof.authority },
      durability: { state: 'verified_pending', retained_receipt_authority: proof.authority },
      origin: { ...common, partition_index: i, group_sha256: groupHash },
      // Filled from the same schema-owned dependency computation below.
      ...dependencies(scopes, pm) });
    assertBundleRecords(artifact.records, receipt);
    const bytes = canonicalJson(receipt);
    evidence(bytes.length <= LIMITS.receipt_bytes, 'resource_limit', 'Receipt exceeds existing byte cap');
    return { receipt, receipt_object: { bucket: BUCKET, key: `${ROOT}/receipts/${sha256Hex(bytes)}.json`,
      sha256: sha256Hex(bytes), byte_size: bytes.length } };
  });
  assertPruneReceiptGroup(entries.map(e => e.receipt));
  const token = Object.freeze({ event_id: proof.authority.event_id, group_sha256: groupHash });
  groups.set(token, { public: freeze({ event_id: proof.authority.event_id, group_sha256: groupHash,
    plan, entries, original_authority: proof.authority }), artifacts });
  cache.set(handover, token); return token;
}

function dependencies(scopes, pm) {
  return { affected_months: affectedMonths(scopes), rolling_aqi: { algorithm_version: ALGORITHM,
    preceding_hours: pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0,
    following_hours: pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0,
    minimum_valid_hours: pm ? DAQI_PM_ROLLING24H_REQUIRED_HOURS : 1 } };
}

export function authenticatePruneReceiptInput({ input, handover }) {
  const token = buildPruneReceiptGroup({ handover }); const group = groups.get(token);
  const i = group.public.entries.findIndex(e => e.receipt.change_id === input.receipt.change_id);
  evidence(i >= 0 && same(input.receipt, group.public.entries[i].receipt)
    && same(input.receipt_object, group.public.entries[i].receipt_object)
    && input.bundle?.integrity === 'verified' && same(input.bundle.records, group.artifacts[i].records),
  'conflicting_original_receipt', 'Receipt or complete bundle differs from the authenticated original event');
  return freeze({ state: 'original_prune_event_authenticated', authenticated: true,
    writer: { identity: input.receipt.writer.identity, invocation_id: input.receipt.writer.invocation_id },
    change_id: input.receipt.change_id, receipt: input.receipt_object, bundle: input.receipt.bundle.object,
    declared_final_publication: input.receipt.source.final_publication, missing_proof: [],
    original_acceptance: input.receipt.origin.authority,
    inspected_seam: null, action: 'Original event authenticated; current canonical dominance and monthly eligibility remain unresolved.' });
}

export async function retainImmutable({ r2, reference, body, contentType, budget }) {
  assertManagedR2CredentialMode(r2, 'write'); admitDerived(r2);
  evidence(body.length === reference.byte_size && sha256Hex(body) === reference.sha256,
    'invalid_object_identity', 'Immutable retention body differs from its declared identity');
  budget.check(); budget.put?.(body.length);
  let outcome = 'written'; let timer;
  const timeout = budget.timeout();
  try {
    await Promise.race([
      r2PutObjectConditional({ r2, key: reference.key, body, sha256: reference.sha256,
        content_type: contentType, if_none_match: '*' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('deadline'),
        { code: 'R2_WRITE_AMBIGUOUS' })), timeout); }),
    ]);
  } catch (error) {
    if (!['R2_PRECONDITION_FAILED', 'R2_WRITE_AMBIGUOUS'].includes(error.code)) throw error;
    outcome = error.code === 'R2_PRECONDITION_FAILED' ? 'already_retained' : 'confirmed_after_ambiguous_write';
  } finally { clearTimeout(timer); }
  try {
    const stored = await readImmutable({ r2, reference, maxBytes: Math.max(LIMITS.compressed_bytes, LIMITS.receipt_bytes), budget });
    evidence(stored.equals(body), 'conflicting_immutable_object', 'Immutable key contains different bytes');
  } catch (cause) {
    if (cause.code === 'conflicting_immutable_object' || cause.code === 'invalid_object_identity')
      throw new JSONgenEvidenceError('conflicting_immutable_object', 'Existing immutable object conflicts with expected exact bytes', cause);
    const error = new JSONgenEvidenceError('ambiguous_r2_write_outcome', 'Immutable retention is unconfirmed; replay exact original event and resolve by readback', cause);
    error.reference = reference; throw error;
  }
  return outcome;
}

export async function retainPruneReceiptGroup({ handover, r2, budget = createBudget(), progress = () => {} }) {
  assertManagedR2CredentialMode(r2, 'write');
  admitDerived(r2);
  const proof = inspectAuthenticatedPruneHandover(handover);
  evidence(proof.authority.key.environment === managedR2Environment(r2),
    'cross_environment_evidence', 'Original retained event differs from configured storage environment');
  const token = buildPruneReceiptGroup({ handover, budget }), group = groups.get(token);
  const outcomes = [];
  for (let i = 0; i < group.public.entries.length; i++) {
    budget.check(); const entry = group.public.entries[i], artifact = group.artifacts[i];
    const bundleOutcome = await retainImmutable({ r2, reference: entry.receipt.bundle.object,
      body: artifact.body, contentType: 'application/gzip', budget });
    // Exact stored gzip, decompressed integrity and complete records must all
    // agree. The shared reader retains Stage 1 precision/status semantics.
    const bundle = await readBundle({ r2, receipt: entry.receipt, budget });
    authenticatePruneReceiptInput({ input: { ...entry, bundle }, handover });
    progress({ partition_index: i, bundle: 'retained', receipt: 'pending' });
    const receiptOutcome = await retainImmutable({ r2, reference: entry.receipt_object,
      body: canonicalJson(entry.receipt), contentType: 'application/json', budget });
    const receipt = await readReceipt({ r2, reference: entry.receipt_object, expected: entry.receipt, budget });
    authenticatePruneReceiptInput({ input: { ...entry, receipt, bundle }, handover });
    outcomes.push({ partition_index: i, change_id: receipt.change_id, bundle: bundleOutcome, receipt: receiptOutcome });
    progress({ partition_index: i, bundle: 'retained', receipt: 'retained' });
  }
  assertPruneReceiptGroup(group.public.entries.map(e => e.receipt));
  const retainedToken = Object.freeze({ event_id: group.public.event_id, group_sha256: group.public.group_sha256 });
  retained.set(retainedToken, freeze({ ...group.public, outcomes, state: 'retained',
    receipt_coverage_complete: true, handover_complete: false }));
  return retainedToken;
}
