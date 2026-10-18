// Complete-scope planning only. These bytes cannot be retained as VERIFIED
// bundles until the mandatory receipt authorities are supplied and accepted.
import { gzipSync } from 'node:zlib';
import { verifiedPrunePendingRows } from './prune-pending-verification.mjs';
import { inspectAuthenticatedPruneHandover } from './prune-consumer-authentication.mjs';
import { BUCKET, ROOT, assertIdentity, canonicalJson, same } from './schema.mjs';
import { LIMITS, createBudget, evidence, freeze } from './limits.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

const physicalKey = s => `${s.pollutant_code}:${s.timeseries_id}:${s.station_id}:${s.day_utc}`;

export function planPruneScopePartitions({ handover, budget = createBudget() }) {
  const proof = inspectAuthenticatedPruneHandover(handover);
  const { result, pending } = proof;
  const rows = verifiedPrunePendingRows(pending);
  const expected = pending.pending_evidence.scope.physical_timeseries_days;
  const grouped = new Map(expected.map(scope => [physicalKey(scope), { scope, rows: [] }]));
  evidence(grouped.size === expected.length, 'incomplete_partition_coverage', 'Duplicate declared physical scope');
  for (const row of rows) {
    budget.check();
    const group = grouped.get(physicalKey({ ...row, day_utc: result.key.day_utc }));
    evidence(group, 'incomplete_partition_coverage', 'Source row has no original declared scope');
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
    const body = canonicalJson(record);
    evidence(body.length <= LIMITS.record_bytes, 'resource_limit', 'One complete physical scope exceeds the record cap; cannot split it');
    return { scope, key: physicalKey(scope), body, row_count: observations.length };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const groups = []; let group = []; let length = 0; let count = 0;
  for (const record of records) {
    if (group.length && (group.length === LIMITS.scopes || length + record.body.length > LIMITS.uncompressed_bytes
      || count + record.row_count > LIMITS.rows)) {
      groups.push(group); group = []; length = 0; count = 0;
    }
    group.push(record); length += record.body.length; count += record.row_count;
  }
  if (group.length) groups.push(group);
  const partitions = [];
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
      pending_source: pending.source, original_scope_count: expected.length,
      original_observation_count: rows.length, scopes };
    const id = sha256Hex(canonicalJson(binding));
    partitions.push({ partition_id: id, prospective_change_id: `prune:${id}`, binding,
      scope_count: records.length, row_count: records.reduce((n, record) => n + record.row_count, 0),
      format: 'complete_scope_ndjson_gzip', object: { bucket: BUCKET,
        key: `${ROOT}/bundles/${sha256Hex(compressed)}.ndjson.gz`, sha256: sha256Hex(compressed), byte_size: compressed.length,
        json_sha256: sha256Hex(body), json_byte_size: body.length },
      retention: 'not_attempted_missing_receipt_authority' });
  };
  groups.forEach(encode);
  const actual = partitions.flatMap(p => p.binding.scopes.map(physicalKey)).sort();
  evidence(same(actual, expected.map(physicalKey).sort()) && new Set(actual).size === expected.length
    && partitions.reduce((n, p) => n + p.row_count, 0) === rows.length,
  'incomplete_partition_coverage', 'Partition plan does not cover the complete original connector-day exactly once');
  budget.rows(rows.length);
  return freeze({ state: 'incomplete', coverage: 'complete_source_partition_plan_only',
    partition_count: partitions.length, physical_scope_count: expected.length, observation_count: rows.length,
    partitions, receipt_coverage_complete: false, handover_complete: false });
}
