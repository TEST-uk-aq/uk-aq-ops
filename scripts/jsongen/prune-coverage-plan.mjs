// In-memory Stage 1 evidence planning. This is not a durable descriptor schema,
// a VERIFIED receipt, or an authentication cache for another invocation.
import { canonicalJson, same, assertReference, assertPruneAcceptanceAuthority } from './schema.mjs';
import { LIMITS, PRUNE_PENDING_SOURCE_LIMITS, evidence, freeze } from './limits.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { computeObservationContentHash } from '../../workers/shared/uk_aq_observation_content_hash.mjs';
import { inspectAuthenticatedPruneHandover } from './prune-consumer-authentication.mjs';
import { iterateVerifiedPrunePendingRows } from './prune-pending-verification.mjs';
import { pruneOriginalPhysicalKey } from './prune-original-identity.mjs';
import { planPruneSelectedPartitions } from './prune-consumer-partitions.mjs';

export const PRUNE_COVERAGE_PLANNING_CONTRACT = 'aurn_original_selected_coverage_v1';
const POLICY = Object.freeze({ identity: 'aurn_pm25_pm10_no2_v1', pollutants: ['no2', 'pm10', 'pm25'] });
const selected = code => POLICY.pollutants.includes(code);
const check = ok => evidence(ok, 'invalid_selected_coverage', 'Original/selected scope accounting is incomplete or contradictory');
const hash = (domain, value) => sha256Hex(canonicalJson({ contract: PRUNE_COVERAGE_PLANNING_CONTRACT, domain, value }));
const sortedScopes = scopes => [...scopes].sort((a, b) => a.scope_key.localeCompare(b.scope_key));
const total = scopes => ({ pollutant_codes: [...new Set(scopes.map(s => s.identity.pollutant_code))].sort(),
  pollutant_count: new Set(scopes.map(s => s.identity.pollutant_code)).size, scope_count: scopes.length,
  observation_count: scopes.reduce((n, s) => n + s.row_count, 0) });
const previewBytes = plan => canonicalJson(plan);

function coverageDigests(plan) {
  const common = { event_id: plan.event_id, authority: plan.authority, pending_source: plan.pending_source,
    source_identity: plan.source_identity, source_status: plan.source_status, global_lock: plan.global_lock,
    evidence_bundle: plan.evidence_bundle, original_final_evidence_sha256: plan.original_final_evidence_sha256,
    post_commit_reference_sha256: plan.post_commit_reference_sha256, sources: plan.sources,
    authorities: plan.authorities };
  const original = hash('complete_original_event', { ...common,
    scopes: plan.scopes.map(({ disposition: _selection, ...scope }) => scope) });
  const subset = yes => plan.scopes.filter(s => selected(s.identity.pollutant_code) === yes);
  const eligible = hash('selected_original_scopes', { original, policy: plan.policy, scopes: subset(true) });
  const unsupported = hash('unsupported_original_scopes', { original, policy: plan.policy, scopes: subset(false) });
  return { original, selected: eligible, unsupported };
}

export function planPruneSelectedCoverage({ handover, budget }) {
  const proof = inspectAuthenticatedPruneHandover(handover);
  const expected = proof.pending.pending_evidence.scope.physical_timeseries_days;
  const grouped = new Map(expected.map(scope => [pruneOriginalPhysicalKey(scope), []]));
  check(grouped.size === expected.length && expected.length <= PRUNE_PENDING_SOURCE_LIMITS.scopes);
  for (const row of iterateVerifiedPrunePendingRows(proof.pending)) {
    budget.check();
    const rows = grouped.get(pruneOriginalPhysicalKey({ ...row, day_utc: proof.result.key.day_utc }));
    check(rows); rows.push(row);
  }
  const authorities = [], referenceIds = new Map();
  const authorityId = ref => {
    assertReference(ref);
    const key = canonicalJson(ref).toString();
    if (!referenceIds.has(key)) { referenceIds.set(key, authorities.length); authorities.push(ref); }
    return referenceIds.get(key);
  };
  const scopes = [...expected].sort((a, b) => pruneOriginalPhysicalKey(a).localeCompare(pruneOriginalPhysicalKey(b))).map(s => {
    budget.check();
    const key = pruneOriginalPhysicalKey(s), scope = proof.scopes[key], authority = proof.scopeAuthorities[key];
    const observations = grouped.get(key);
    check(scope && authority && observations.length === s.row_count && observations.length > 0);
    const content = computeObservationContentHash(observations);
    budget.rows(observations.length);
    check(same(content.verification_status_counts, s.verification_status_counts));
    return { scope_key: key, identity: scope.identity, day_utc: scope.day_utc, row_count: s.row_count,
      verification_status_counts: s.verification_status_counts,
      observation_content_hash: content.observation_content_hash,
      observation_content_hash_contract_version: content.observation_content_hash_contract_version,
      physical_sha256: authority.physical_sha256, effective_status: authority.effective_status,
      before: { state: scope.before.state, row_count: scope.before.row_count, authority: authorityId(scope.before.authority) },
      after: { state: scope.after.state, row_count: scope.after.row_count, authority: authorityId(scope.after.authority) },
      binding: authorityId(authority.binding), leaf: authorityId(authority.leaf), index: authorityId(authority.index),
      disposition: selected(s.pollutant_code) ? 'selected_for_future_receipt_planning'
        : 'authenticated_not_selected_unsupported_pollutant' };
  });
  // Reference-table insertion order is also canonical: sort the input before
  // assigning IDs, rather than relying on source row or object iteration order.
  // The frozen source description already has deterministic ordering; enforce it.
  const ordered = sortedScopes(scopes);
  const plan = { contract: PRUNE_COVERAGE_PLANNING_CONTRACT, policy: POLICY,
    event_id: proof.result.event_id, authority: proof.authority,
    source_identity: proof.source_identity, source_status: proof.original_source_status,
    global_lock: proof.original_global_lock, pending_source: proof.pending.source,
    evidence_bundle: proof.original_evidence_bundle,
    original_final_evidence_sha256: proof.original_evidence_sha256,
    post_commit_reference_sha256: proof.post_commit_reference_sha256, sources: proof.sources,
    original: total(ordered), selected: total(ordered.filter(s => selected(s.identity.pollutant_code))),
    unsupported: total(ordered.filter(s => !selected(s.identity.pollutant_code))),
    authorities, scopes: ordered };
  check(plan.original.observation_count === proof.result.observation_count
    && plan.original.scope_count === proof.result.physical_scope_count);
  const digests = coverageDigests(plan);
  const partitions = planPruneSelectedPartitions({ handover, budget, coverage: {
    contract: plan.contract, policy: plan.policy, original: digests.original, selected: digests.selected } });
  const partition_group = hash('selected_partition_group', { event_id: plan.event_id,
    policy: plan.policy, original: digests.original, selected: digests.selected, partitions: partitions.partitions });
  Object.assign(plan, { state: plan.selected.scope_count ? 'selected_coverage_planned' : 'no_selected_scopes',
    partitions, coverage_sha256: { ...digests, partition_group } });
  const body = previewBytes(plan);
  evidence(body.length <= LIMITS.metadata_bytes, 'resource_limit', 'In-memory descriptor preview exceeds metadata-object cap');
  budget.bytes('decompressed', body.length); budget.check();
  const result = { ...plan, descriptor_preview: { sha256: sha256Hex(body), byte_size: body.length,
    persisted: false, durable_schema_committed: false } };
  assertPruneSelectedCoverage(result);
  return freeze(result);
}

// Structural validation for the local planning report only. It does not grant
// original authentication: that still comes exclusively from the private reader.
export function assertPruneSelectedCoverage(plan) {
  check(plan?.contract === PRUNE_COVERAGE_PLANNING_CONTRACT && same(plan.policy, POLICY)
    && plan.event_id === plan.authority?.event_id && Array.isArray(plan.scopes)
    && plan.scopes.length > 0 && plan.scopes.length <= PRUNE_PENDING_SOURCE_LIMITS.scopes
    && Array.isArray(plan.authorities) && plan.authorities.length <= 6 * PRUNE_PENDING_SOURCE_LIMITS.scopes);
  assertPruneAcceptanceAuthority(plan.authority);
  assertReference(plan.pending_source, { managed: true, gzip: true });
  plan.authorities.forEach(ref => assertReference(ref));
  const keys = new Set();
  for (const s of plan.scopes) {
    check(s.scope_key === pruneOriginalPhysicalKey(s) && !keys.has(s.scope_key)
      && Number.isSafeInteger(s.row_count) && s.row_count > 0 && s.before.state === 'authoritative_empty'
      && s.before.row_count === 0 && s.after.state === 'present' && s.after.row_count === s.row_count
      && s.effective_status === 'original_schema3_embedded_status_bound'
      && /^[a-f0-9]{64}$/.test(s.physical_sha256) && /^[a-f0-9]{64}$/.test(s.observation_content_hash)
      && s.observation_content_hash_contract_version === 1
      && ['P', 'R', 'null'].every(k => Number.isSafeInteger(s.verification_status_counts[k]) && s.verification_status_counts[k] >= 0)
      && Object.values(s.verification_status_counts).reduce((n, v) => n + v, 0) === s.row_count
      && [s.before.authority, s.after.authority, s.binding, s.leaf, s.index].every(id =>
        Number.isSafeInteger(id) && id >= 0 && id < plan.authorities.length)
      && s.disposition === (selected(s.identity.pollutant_code) ? 'selected_for_future_receipt_planning'
        : 'authenticated_not_selected_unsupported_pollutant'));
    keys.add(s.scope_key);
  }
  check(same(plan.scopes, sortedScopes(plan.scopes)));
  const eligible = plan.scopes.filter(s => selected(s.identity.pollutant_code));
  check(same(plan.original, total(plan.scopes)) && same(plan.selected, total(eligible))
    && same(plan.unsupported, total(plan.scopes.filter(s => !selected(s.identity.pollutant_code))))
    && plan.original.observation_count <= PRUNE_PENDING_SOURCE_LIMITS.rows
    && plan.source_identity.source_content_hash_row_count === plan.original.observation_count
    && plan.state === (eligible.length ? 'selected_coverage_planned' : 'no_selected_scopes'));
  const digests = coverageDigests(plan);
  check(Object.entries(digests).every(([k, v]) => v === plan.coverage_sha256[k]));
  const p = plan.partitions;
  check(p?.coverage === 'selected_original_event_scope_set' && p.state === 'authenticated'
    && p.physical_scope_count === eligible.length && p.observation_count === plan.selected.observation_count
    && p.partition_count === p.partitions.length && p.partition_count <= LIMITS.receipt_references
    && p.receipt_coverage_complete === false && p.handover_complete === false);
  const partitionScopes = [];
  for (const partition of p.partitions) {
    const scopes = partition.binding.scopes;
    check(scopes.length > 0 && scopes.length <= LIMITS.scopes && scopes.length === partition.scope_count
      && scopes.every(s => selected(s.pollutant_code) && s.pollutant_code === scopes[0].pollutant_code)
      && scopes.reduce((n, s) => n + s.row_count, 0) === partition.row_count
      && partition.row_count <= LIMITS.rows && partition.retention === 'pending'
      && partition.object.byte_size <= LIMITS.compressed_bytes && partition.object.json_byte_size <= LIMITS.uncompressed_bytes
      && partition.binding.original_scope_count === plan.original.scope_count
      && partition.binding.original_observation_count === plan.original.observation_count
      && partition.binding.event_id === plan.event_id && same(partition.binding.pending_source, plan.pending_source)
      && same(partition.binding.policy, plan.policy) && partition.binding.original_coverage_sha256 === digests.original
      && partition.binding.selected_coverage_sha256 === digests.selected
      && partition.partition_id === sha256Hex(canonicalJson(partition.binding))
      && partition.change_id === `prune:${partition.partition_id}`);
    for (const scope of scopes) {
      const key = pruneOriginalPhysicalKey(scope), original = plan.scopes.find(s => s.scope_key === key);
      check(original && original.row_count === scope.row_count
        && same(original.verification_status_counts, scope.verification_status_counts));
      partitionScopes.push(key);
    }
  }
  check(same(partitionScopes.sort(), eligible.map(s => s.scope_key).sort())
    && new Set(partitionScopes).size === eligible.length
    && p.partitions.reduce((n, s) => n + s.row_count, 0) === plan.selected.observation_count
    && plan.coverage_sha256.partition_group === hash('selected_partition_group', { event_id: plan.event_id,
      policy: plan.policy, original: digests.original, selected: digests.selected, partitions: p.partitions }));
  const { descriptor_preview: preview, ...body } = plan;
  const encoded = previewBytes(body);
  check(preview?.persisted === false && preview.durable_schema_committed === false
    && preview.byte_size === encoded.length && preview.byte_size <= LIMITS.metadata_bytes
    && preview.sha256 === sha256Hex(encoded));
  return plan;
}
