// Deterministic authenticated complete-scope bundles, before durable retention.
import { gzipSync } from 'node:zlib';
import { iterateVerifiedPrunePendingRows } from './prune-pending-verification.mjs';
import { inspectAuthenticatedPruneHandover, assertPruneReceiptScopeEligibility } from './prune-consumer-authentication.mjs';
import { BUCKET, ROOT, assertIdentity, assertBundleRecord, canonicalJson, same } from './schema.mjs';
import { prunePhysicalKey } from './prune-original-authority.mjs';
import { LIMITS, createBudget, evidence, freeze } from './limits.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

const physicalKey = s => `${s.pollutant_code}:${s.timeseries_id}:${s.station_id}:${s.day_utc}`;
const artifacts = new WeakMap();
export function prunePartitionArtifacts(plan) {
  evidence(artifacts.has(plan), 'unauthenticated_partition_plan', 'Authenticated complete partition construction required');
  return artifacts.get(plan).map(a => ({ ...a, body: Buffer.from(a.body), records: structuredClone(a.records) }));
}

export function planPruneScopePartitions({ handover, budget = createBudget() }) {
  const proof = inspectAuthenticatedPruneHandover(handover);
  // The existing schema-2 retention path still requires a whole original event.
  assertPruneReceiptScopeEligibility(proof.pending.pending_evidence);
  return planPartitions({ handover, budget });
}

// Read-only selected planning never grants access to retained bundle artifacts.
export function planPruneSelectedPartitions({ handover, budget, coverage }) {
  return planPartitions({ handover, budget, coverage });
}

// Stage 2 reconstruction still requires a private authenticated handover. The
// Stage 1 preview itself never grants artifact access.
export function reconstructPruneSelectedPartitions({ handover, budget, coverage }) {
  return planPartitions({ handover, budget, coverage, retainArtifacts: true });
}
function planPartitions({ handover, budget, coverage = null, retainArtifacts = false }) {
  const proof = inspectAuthenticatedPruneHandover(handover);
  const { result, pending } = proof;
  const original = pending.pending_evidence.scope.physical_timeseries_days;
  const expected = coverage ? original.filter(s => ['pm25', 'pm10', 'no2'].includes(s.pollutant_code)) : original;
  const known = new Set(original.map(physicalKey));
  const rowCount = expected.reduce((n, s) => n + s.row_count, 0);
  const grouped = new Map(expected.map(scope => [physicalKey(scope), { scope, rows: [] }]));
  evidence(grouped.size === expected.length, 'incomplete_partition_coverage', 'Duplicate declared physical scope');
  for (const row of iterateVerifiedPrunePendingRows(pending)) {
    budget.check();
    const key = physicalKey({ ...row, day_utc: result.key.day_utc });
    evidence(known.has(key), 'incomplete_partition_coverage', 'Source row has no original declared scope');
    const group = grouped.get(key);
    if (!group && coverage) continue;
    // Same original timestamps, IEEE-754 values, multiplicity and P/R/null.
    // Provider source status is explicitly unavailable in the authenticated
    // source evidence; null makes no original-provider status assertion.
    const { observed_at: _alias, ...observation } = row;
    group.rows.push({ ...observation, source_status: null });
  }
  const records = [...grouped.values()].map(({ scope, rows: observations }) => {
    const identity = { connector_id: 1, timeseries_id: scope.timeseries_id,
      station_id: scope.station_id, pollutant_code: scope.pollutant_code };
    // Unsupported identity/pollutant or absent station binding fails the entire
    // plan. No filtering to fit the Stage 1 allowlist and no inferred station.
    evidence(Number.isSafeInteger(identity.station_id) && identity.station_id > 0
      && ['pm25', 'pm10', 'no2'].includes(identity.pollutant_code), 'unsupported_receipt_scope',
    'Complete source contains an identity unsupported by Stage 1; no scope may be omitted or assigned an inferred station');
    assertIdentity(identity);
    evidence(observations.length === scope.row_count && observations.length > 0,
      'incomplete_partition_coverage', 'Physical scope is incomplete; absence is not an empty replacement');
    const record = { identity, day_utc: scope.day_utc, state: 'present', rows: observations };
    assertBundleRecord(record, proof.scopes[prunePhysicalKey(scope)]);
    const body = canonicalJson(record);
    evidence(body.length <= LIMITS.record_bytes, 'resource_limit', 'One complete physical scope exceeds the record cap; cannot split it');
    return { scope, record, key: physicalKey(scope), body, row_count: observations.length };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const groups = []; let group = []; let length = 0; let count = 0;
  for (const record of records) {
    if (group.length && (group[0].scope.pollutant_code !== record.scope.pollutant_code
      || group.length === LIMITS.scopes || length + record.body.length > LIMITS.uncompressed_bytes
      || count + record.row_count > LIMITS.rows)) {
      groups.push(group); group = []; length = 0; count = 0;
    }
    group.push(record); length += record.body.length; count += record.row_count;
  }
  if (group.length) groups.push(group);
  const partitions = []; const bodies = [];
  const encode = records => {
    budget.check();
    const body = Buffer.concat(records.map(record => record.body));
    const compressed = gzipSync(body, { mtime: 0 });
    if (compressed.length > LIMITS.compressed_bytes) {
      evidence(records.length > 1, 'resource_limit', 'One complete physical scope exceeds gzip cap; cannot split it');
      const mid = Math.floor(records.length / 2);
      encode(records.slice(0, mid)); encode(records.slice(mid)); return;
    }
    budget.bytes('decompressed', body.length); budget.bytes('derived', compressed.length);
    const scopes = records.map(record => ({ ...record.scope, record_sha256: sha256Hex(record.body) }));
    const binding = { event_id: result.event_id, original_final_evidence_sha256: proof.original_evidence_sha256,
      original_post_commit_reference_sha256: proof.post_commit_reference_sha256,
      pending_source: pending.source, original_scope_count: original.length,
      original_observation_count: pending.pending_evidence.original_ndjson.row_count, scopes,
      ...(coverage ? { planning_contract: coverage.contract, policy: coverage.policy,
        original_coverage_sha256: coverage.original, selected_coverage_sha256: coverage.selected } : {}) };
    const id = sha256Hex(canonicalJson(binding));
    partitions.push({ partition_id: id, change_id: `prune:${id}`, binding,
      scope_count: records.length, row_count: records.reduce((n, record) => n + record.row_count, 0),
      format: 'complete_scope_ndjson_gzip', object: { bucket: BUCKET,
        key: `${ROOT}/bundles/${sha256Hex(compressed)}.ndjson.gz`, sha256: sha256Hex(compressed), byte_size: compressed.length,
        json_sha256: sha256Hex(body), json_byte_size: body.length },
      retention: 'pending' });
    if (!coverage || retainArtifacts) bodies.push({ partition_id: id, body: compressed, records: records.map(r => r.record),
      scopes: records.map(r => proof.scopes[prunePhysicalKey(r.scope)]) });
  };
  groups.forEach(encode);
  const actual = partitions.flatMap(p => p.binding.scopes.map(physicalKey)).sort();
  evidence(same(actual, expected.map(physicalKey).sort()) && new Set(actual).size === expected.length
    && partitions.reduce((n, p) => n + p.row_count, 0) === rowCount,
  'incomplete_partition_coverage', 'Partition plan does not cover the complete original connector-day exactly once');
  evidence(partitions.length <= LIMITS.receipt_references, 'resource_limit', 'Complete event exceeds receipt reference limit');
  const plan = freeze({ state: 'authenticated', coverage: coverage ? 'selected_original_event_scope_set' : 'complete_original_event_partition_set',
    partition_count: partitions.length, physical_scope_count: expected.length, observation_count: rowCount,
    partitions, receipt_coverage_complete: false, handover_complete: false });
  if (!coverage || retainArtifacts) artifacts.set(plan, bodies);
  return plan;
}
