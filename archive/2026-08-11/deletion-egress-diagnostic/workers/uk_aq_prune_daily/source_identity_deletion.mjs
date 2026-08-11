import { Client } from "pg";
import {
  isValidConnectorHistoryGateEvidence,
  normalizeConnectorDayPair,
} from "../shared/uk_aq_connector_day_gate.mjs";
import {
  comparePruneConnectorSourceIdentities,
  computePruneConnectorSourceIdentity,
  normalizePruneConnectorSourceIdentity,
  pruneConnectorSourceIdentityFailureReason,
  PRUNE_CONNECTOR_SOURCE_CONTENT_HASH_CONTRACT_VERSION,
} from "../shared/uk_aq_prune_connector_source_identity.mjs";

const HOUR_MS = 60 * 60 * 1000;
const TRANSACTION_CONFLICT_CODES = new Set(["40001", "40P01"]);

function normalizePair(dayUtcInput, connectorIdInput) {
  const dayUtc = String(dayUtcInput || "").slice(0, 10);
  const connectorId = Number(connectorIdInput);
  const dayStart = new Date(`${dayUtc}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)
    || Number.isNaN(dayStart.getTime())
    || dayStart.toISOString().slice(0, 10) !== dayUtc
    || !Number.isSafeInteger(connectorId)
    || connectorId <= 0
  ) {
    throw new Error("Invalid connector-day deletion identity");
  }
  return {
    dayUtc,
    connectorId,
    dayStart: dayStart.toISOString(),
    dayEnd: new Date(dayStart.getTime() + 24 * HOUR_MS).toISOString(),
  };
}

function normalizeBucket(pair, bucket) {
  const connectorId = Number(bucket?.connector_id);
  const hourStart = new Date(String(bucket?.hour_start || ""));
  const observationCount = BigInt(bucket?.observation_count ?? -1);
  if (
    connectorId !== pair.connectorId
    || Number.isNaN(hourStart.getTime())
    || hourStart.toISOString() !== String(bucket?.hour_start || "")
    || hourStart.toISOString().slice(0, 10) !== pair.dayUtc
    || hourStart.getUTCMinutes() !== 0
    || hourStart.getUTCSeconds() !== 0
    || hourStart.getUTCMilliseconds() !== 0
    || observationCount < 0n
  ) {
    throw new Error("Invalid connector-day deletion bucket");
  }
  return {
    ...bucket,
    connector_id: connectorId,
    hour_start: hourStart.toISOString(),
    observation_count: observationCount,
  };
}

function groupBucketsByConnectorDay(buckets) {
  const groups = new Map();
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const pair = normalizePair(String(bucket?.hour_start || "").slice(0, 10), bucket?.connector_id);
    const normalized = normalizeBucket(pair, bucket);
    const key = `${pair.dayUtc}|${pair.connectorId}`;
    if (!groups.has(key)) groups.set(key, { ...pair, buckets: [] });
    groups.get(key).buckets.push(normalized);
  }
  return Array.from(groups.values()).sort((left, right) => (
    left.dayUtc.localeCompare(right.dayUtc) || left.connectorId - right.connectorId
  ));
}

function identityPresent(row) {
  return Boolean(
    row?.source_content_hash
    && row?.source_content_hash_contract_version !== null
    && row?.source_content_hash_contract_version !== undefined
    && row?.source_content_hash_row_count !== null
    && row?.source_content_hash_row_count !== undefined
  );
}

async function invalidateConnectorDayEvidence(client, dayUtc, connectorId, failureReason) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'pending',
  run_id = null,
  last_error = $3,
  manifest_key = null,
  history_row_count = null,
  history_file_count = null,
  history_total_bytes = null,
  history_completed_at = null,
  source_content_hash = null,
  source_content_hash_contract_version = null,
  source_content_hash_row_count = null,
  resume_last_timeseries_id = null,
  resume_last_observed_at = null,
  resume_part_index = 0,
  resume_exported_row_count = 0,
  resume_parts_json = '[]'::jsonb,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [dayUtc, connectorId, failureReason],
  );
  await client.query(
    `
update uk_aq_ops.prune_connector_day_gates
set
  history_done = false,
  history_run_id = null,
  history_manifest_key = null,
  history_manifest_hash = null,
  history_row_count = null,
  history_file_count = null,
  history_total_bytes = null,
  history_completed_at = null,
  source_content_hash = null,
  source_content_hash_contract_version = null,
  source_content_hash_row_count = null,
  completion_source = null,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [dayUtc, connectorId],
  );
}

function blockedResult({
  pair,
  buckets,
  candidate,
  gate,
  failureReason,
  invalidated = false,
  currentIdentity = null,
  sourceIdentityMatch = false,
  rolledBack = false,
  currentBucketCount = null,
  eligibleBucketCount = null,
  remainingSnapshotRows = null,
  rawSnapshotRows = null,
  canonicalSnapshotRows = null,
  scopeMatch = null,
  validatedPlanRows = null,
  transactionDeletedRows = null,
}) {
  return {
    ok: false,
    day_utc: pair.dayUtc,
    connector_id: pair.connectorId,
    bucket_results: [],
    blocked_buckets: buckets.map((bucket) => ({
      connector_id: bucket.connector_id,
      hour_start: bucket.hour_start,
      day_utc: pair.dayUtc,
      observation_count: String(bucket.observation_count),
      reason: failureReason,
    })),
    diagnostics: {
      source_identity_contract_version: PRUNE_CONNECTOR_SOURCE_CONTENT_HASH_CONTRACT_VERSION,
      source_identity_match: sourceIdentityMatch,
      source_identity_failure_reason: failureReason,
      source_identity_rows: currentIdentity?.source_content_hash_row_count ?? null,
      candidate_source_identity_present: identityPresent(candidate),
      gate_source_identity_present: identityPresent(gate),
      source_identity_invalidated_connector_days: invalidated ? 1 : 0,
      connector_day_atomic_delete_planned: true,
      connector_day_atomic_delete_committed: false,
      connector_day_atomic_delete_rolled_back: rolledBack,
      connector_day_atomic_delete_failure_reason: failureReason,
      connector_day_current_bucket_count: currentBucketCount,
      connector_day_eligible_bucket_count: eligibleBucketCount ?? buckets.length,
      connector_day_committed_deleted_rows: "0",
      connector_day_remaining_snapshot_rows: remainingSnapshotRows === null
        ? null
        : String(remainingSnapshotRows),
      connector_day_raw_snapshot_rows: rawSnapshotRows === null ? null : String(rawSnapshotRows),
      connector_day_canonical_snapshot_rows: canonicalSnapshotRows === null
        ? null
        : String(canonicalSnapshotRows),
      connector_day_scope_match: scopeMatch,
      connector_day_validated_plan_rows: validatedPlanRows === null
        ? null
        : String(validatedPlanRows),
      connector_day_transaction_deleted_rows: transactionDeletedRows === null
        ? null
        : String(transactionDeletedRows),
    },
  };
}

async function readLockedEvidence(client, pair) {
  const candidateResult = await client.query(
    `
select
  day_utc::text as day_utc,
  connector_id,
  status,
  source_content_hash,
  source_content_hash_contract_version,
  source_content_hash_row_count
from uk_aq_ops.history_candidates
where day_utc = $1::date
  and connector_id = $2::integer
for update
`,
    [pair.dayUtc, pair.connectorId],
  );
  const gateResult = await client.query(
    `
select
  day_utc::text as day_utc,
  connector_id,
  history_done,
  history_manifest_key,
  history_manifest_hash,
  history_row_count,
  history_file_count,
  history_total_bytes,
  history_completed_at,
  completion_source,
  source_content_hash,
  source_content_hash_contract_version,
  source_content_hash_row_count
from uk_aq_ops.prune_connector_day_gates
where day_utc = $1::date
  and connector_id = $2::integer
for update
`,
    [pair.dayUtc, pair.connectorId],
  );
  return {
    candidate: candidateResult.rows[0] || null,
    gate: gateResult.rows[0] || null,
  };
}

function evidencePairMatches(row, pair) {
  const evidencePair = normalizeConnectorDayPair(row.day_utc, row.connector_id);
  return evidencePair.day_utc === pair.dayUtc && evidencePair.connector_id === pair.connectorId;
}

function classifyLockedEvidence(candidate, gate, pair) {
  if (!candidate) {
    return { failureReason: "candidate_evidence_missing", preserveEvidence: false };
  }
  if (!gate) {
    return { failureReason: "gate_evidence_missing", preserveEvidence: false };
  }
  try {
    if (!evidencePairMatches(candidate, pair)) {
      return { failureReason: "candidate_evidence_invalid", preserveEvidence: true };
    }
  } catch (_error) {
    return { failureReason: "candidate_evidence_invalid", preserveEvidence: true };
  }
  try {
    if (!evidencePairMatches(gate, pair)) {
      return { failureReason: "gate_evidence_invalid", preserveEvidence: true };
    }
  } catch (_error) {
    return { failureReason: "gate_evidence_invalid", preserveEvidence: true };
  }
  if (candidate.status !== "complete") {
    return { failureReason: "candidate_not_complete", preserveEvidence: false };
  }

  let candidateIdentity;
  try {
    candidateIdentity = normalizePruneConnectorSourceIdentity(candidate);
  } catch (error) {
    return {
      failureReason: pruneConnectorSourceIdentityFailureReason(error),
      preserveEvidence: false,
    };
  }

  let gateIdentity;
  try {
    gateIdentity = normalizePruneConnectorSourceIdentity(gate);
  } catch (error) {
    return {
      failureReason: pruneConnectorSourceIdentityFailureReason(error),
      preserveEvidence: false,
    };
  }
  if (!isValidConnectorHistoryGateEvidence(gate)) {
    return { failureReason: "gate_evidence_invalid", preserveEvidence: false };
  }
  const comparison = comparePruneConnectorSourceIdentities(candidateIdentity, gateIdentity);
  return {
    failureReason: comparison.match ? null : comparison.failure_reason,
    preserveEvidence: false,
    candidateIdentity,
    gateIdentity,
  };
}

async function readCurrentCanonicalRows(client, pair) {
  const result = await client.query(
    `
select
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,
  observed_at_utc,
  value,
  status
from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  null::integer,
  null::timestamptz
)
`,
    [pair.connectorId, pair.dayStart, pair.dayEnd],
  );
  return result.rows;
}

async function readRemainingCanonicalRowCount(client, pair, windowStart, windowEnd) {
  const result = await client.query(
    `
select count(*)::bigint as remaining_count
from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  null::integer,
  null::timestamptz
)
`,
    [pair.connectorId, windowStart, windowEnd],
  );
  return BigInt(result.rows[0]?.remaining_count ?? 0);
}

async function readRawConnectorDayRowCount(client, pair) {
  const result = await client.query(
    `
select count(*)::bigint as raw_snapshot_row_count
from uk_aq_core.observations o
where o.connector_id = $1::integer
  and o.observed_at >= $2::timestamptz
  and o.observed_at < $3::timestamptz
`,
    [pair.connectorId, pair.dayStart, pair.dayEnd],
  );
  return BigInt(result.rows[0]?.raw_snapshot_row_count ?? 0);
}

function currentHourCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const observedAt = new Date(row?.observed_at_utc ?? row?.observed_at);
    if (Number.isNaN(observedAt.getTime())) throw new Error("Invalid current canonical timestamp");
    observedAt.setUTCMinutes(0, 0, 0);
    const hourStart = observedAt.toISOString();
    counts.set(hourStart, (counts.get(hourStart) || 0n) + 1n);
  }
  return counts;
}

function deletionPlanCoversCurrentConnectorDay(pair, buckets, currentRows) {
  const normalizedBuckets = buckets.map((bucket) => normalizeBucket(pair, bucket));
  const plannedByHour = new Map();
  let duplicateHour = false;
  for (const bucket of normalizedBuckets) {
    if (plannedByHour.has(bucket.hour_start)) duplicateHour = true;
    plannedByHour.set(bucket.hour_start, bucket);
  }
  const currentByHour = currentHourCounts(currentRows);
  const exactCoverage = !duplicateHour
    && plannedByHour.size === currentByHour.size
    && Array.from(currentByHour.entries()).every(([hourStart, count]) => (
      plannedByHour.get(hourStart)?.observation_count === count
    ));
  return {
    exactCoverage,
    currentBucketCount: currentByHour.size,
    eligibleBucketCount: plannedByHour.size,
    buckets: Array.from(plannedByHour.values()).sort((left, right) => (
      left.hour_start.localeCompare(right.hour_start)
    )),
  };
}

async function deleteOneHour(client, pair, bucket, deleteBatchSize, maxDeleteBatchesPerHour) {
  let totalDeleted = 0n;
  let batchesRun = 0;
  for (let batchNumber = 1; batchNumber <= maxDeleteBatchesPerHour; batchNumber += 1) {
    batchesRun = batchNumber;
    const result = await client.query(
      `
with target_rows as (
  select
    canonical.connector_id,
    canonical.timeseries_id,
    canonical.observed_at_utc
  from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
    $1::integer,
    $2::timestamptz,
    $2::timestamptz + interval '1 hour',
    null::integer,
    null::timestamptz
  ) canonical
  limit $3::integer
),
deleted as (
  delete from uk_aq_core.observations o
  using target_rows t
  where o.connector_id = t.connector_id
    and o.timeseries_id = t.timeseries_id
    and o.observed_at = t.observed_at_utc
  returning 1
)
select count(*)::integer as deleted_count from deleted
`,
      [pair.connectorId, bucket.hour_start, deleteBatchSize],
    );
    const deletedCount = Number(result.rows[0]?.deleted_count || 0);
    totalDeleted += BigInt(deletedCount);
    if (deletedCount === 0) break;
  }
  const hourEnd = new Date(Date.parse(bucket.hour_start) + HOUR_MS).toISOString();
  const remainingRows = await readRemainingCanonicalRowCount(
    client,
    pair,
    bucket.hour_start,
    hourEnd,
  );
  return {
    connector_id: bucket.connector_id,
    hour_start: bucket.hour_start,
    deleted_rows: totalDeleted,
    batches_run: batchesRun,
    drained: remainingRows === 0n,
    remaining_snapshot_rows: remainingRows,
    max_batches_reached_with_remaining_rows:
      batchesRun >= maxDeleteBatchesPerHour && remainingRows > 0n,
  };
}

export async function runPruneConnectorDayDeletionTransaction({
  client,
  dayUtc,
  connectorId,
  buckets,
  deleteBatchSize,
  maxDeleteBatchesPerHour,
  pollutantCodes = null,
}) {
  const pair = normalizePair(dayUtc, connectorId);
  const requestedBuckets = (Array.isArray(buckets) ? buckets : [])
    .map((bucket) => normalizeBucket(pair, bucket));
  let transactionStarted = false;
  let transactionCandidate = null;
  let transactionGate = null;
  let transactionCurrentIdentity = null;
  let currentBucketCount = null;
  let rawSnapshotRows = null;
  let canonicalSnapshotRows = null;
  try {
    await client.query("begin isolation level repeatable read");
    transactionStarted = true;
    const { candidate, gate } = await readLockedEvidence(client, pair);
    transactionCandidate = candidate;
    transactionGate = gate;
    const evidenceValidation = classifyLockedEvidence(candidate, gate, pair);
    const { candidateIdentity, gateIdentity } = evidenceValidation;
    let { failureReason } = evidenceValidation;

    if (failureReason && evidenceValidation.preserveEvidence) {
      await client.query("rollback");
      transactionStarted = false;
      return blockedResult({
        pair,
        buckets: requestedBuckets,
        candidate,
        gate,
        failureReason,
        invalidated: false,
        sourceIdentityMatch: false,
        rolledBack: true,
      });
    }

    let currentRows = [];
    let currentIdentity = null;
    if (!failureReason) {
      currentRows = await readCurrentCanonicalRows(client, pair);
      canonicalSnapshotRows = BigInt(currentRows.length);
      rawSnapshotRows = await readRawConnectorDayRowCount(client, pair);
      if (currentRows.length === 0 && rawSnapshotRows > 0n) {
        await client.query("rollback");
        transactionStarted = false;
        return blockedResult({
          pair,
          buckets: requestedBuckets,
          candidate,
          gate,
          failureReason: "connector_day_scope_mismatch",
          sourceIdentityMatch: false,
          rolledBack: true,
          currentIdentity,
          currentBucketCount: 0,
          eligibleBucketCount: requestedBuckets.length,
          remainingSnapshotRows: 0,
          rawSnapshotRows,
          canonicalSnapshotRows,
          scopeMatch: false,
        });
      }
      try {
        currentIdentity = computePruneConnectorSourceIdentity(currentRows);
        transactionCurrentIdentity = currentIdentity;
        const currentComparison = comparePruneConnectorSourceIdentities(currentIdentity, candidateIdentity);
        if (!currentComparison.match) failureReason = currentComparison.failure_reason;
      } catch (error) {
        failureReason = pruneConnectorSourceIdentityFailureReason(error);
      }
    }

    if (failureReason) {
      await invalidateConnectorDayEvidence(client, pair.dayUtc, pair.connectorId, failureReason);
      await client.query("commit");
      transactionStarted = false;
      return blockedResult({
        pair,
        buckets: requestedBuckets,
        candidate,
        gate,
        failureReason,
        invalidated: true,
        currentIdentity,
        rawSnapshotRows,
        canonicalSnapshotRows,
        scopeMatch: rawSnapshotRows === null || canonicalSnapshotRows === null
          ? null
          : rawSnapshotRows === canonicalSnapshotRows,
      });
    }

    if (rawSnapshotRows !== canonicalSnapshotRows) {
      await client.query("rollback");
      transactionStarted = false;
      return blockedResult({
        pair,
        buckets: requestedBuckets,
        candidate,
        gate,
        failureReason: "connector_day_scope_mismatch",
        sourceIdentityMatch: true,
        rolledBack: true,
        currentIdentity,
        currentBucketCount: currentHourCounts(currentRows).size,
        eligibleBucketCount: requestedBuckets.length,
        remainingSnapshotRows: canonicalSnapshotRows,
        rawSnapshotRows,
        canonicalSnapshotRows,
        scopeMatch: false,
      });
    }

    const coverage = deletionPlanCoversCurrentConnectorDay(pair, requestedBuckets, currentRows);
    currentBucketCount = coverage.currentBucketCount;
    const hasPollutantSubset = Array.isArray(pollutantCodes) && pollutantCodes.length > 0;
    if (hasPollutantSubset || !coverage.exactCoverage) {
      const scopeFailure = hasPollutantSubset
        ? "connector_day_scope_mismatch"
        : "connector_day_not_fully_eligible";
      await client.query("rollback");
      transactionStarted = false;
      return blockedResult({
        pair,
        buckets: requestedBuckets,
        candidate,
        gate,
        failureReason: scopeFailure,
        sourceIdentityMatch: true,
        rolledBack: true,
        currentIdentity,
        currentBucketCount: coverage.currentBucketCount,
        eligibleBucketCount: coverage.eligibleBucketCount,
        remainingSnapshotRows: currentRows.length,
        rawSnapshotRows,
        canonicalSnapshotRows,
        scopeMatch: true,
      });
    }

    const bucketResults = [];
    for (const bucket of coverage.buckets) {
      const bucketResult = await deleteOneHour(
        client,
        pair,
        bucket,
        deleteBatchSize,
        maxDeleteBatchesPerHour,
      );
      bucketResults.push(bucketResult);
      if (bucketResult.max_batches_reached_with_remaining_rows) {
        await client.query("rollback");
        transactionStarted = false;
        return blockedResult({
          pair,
          buckets: requestedBuckets,
          candidate,
          gate,
          failureReason: "connector_day_delete_cap_reached",
          sourceIdentityMatch: true,
          rolledBack: true,
          currentIdentity,
          currentBucketCount: coverage.currentBucketCount,
          eligibleBucketCount: coverage.eligibleBucketCount,
          remainingSnapshotRows: bucketResult.remaining_snapshot_rows,
          rawSnapshotRows,
          canonicalSnapshotRows,
          scopeMatch: true,
        });
      }
    }

    const remainingSnapshotRows = await readRemainingCanonicalRowCount(
      client,
      pair,
      pair.dayStart,
      pair.dayEnd,
    );
    if (remainingSnapshotRows !== 0n) {
      await client.query("rollback");
      transactionStarted = false;
      return blockedResult({
        pair,
        buckets: requestedBuckets,
        candidate,
        gate,
        failureReason: "connector_day_not_fully_drained",
        sourceIdentityMatch: true,
        rolledBack: true,
        currentIdentity,
        currentBucketCount: coverage.currentBucketCount,
        eligibleBucketCount: coverage.eligibleBucketCount,
        remainingSnapshotRows,
        rawSnapshotRows,
        canonicalSnapshotRows,
        scopeMatch: true,
      });
    }

    const remainingRawSnapshotRows = await readRawConnectorDayRowCount(client, pair);
    if (remainingRawSnapshotRows !== 0n) {
      await client.query("rollback");
      transactionStarted = false;
      return blockedResult({
        pair,
        buckets: requestedBuckets,
        candidate,
        gate,
        failureReason: "connector_day_scope_mismatch",
        sourceIdentityMatch: true,
        rolledBack: true,
        currentIdentity,
        currentBucketCount: coverage.currentBucketCount,
        eligibleBucketCount: coverage.eligibleBucketCount,
        remainingSnapshotRows,
        rawSnapshotRows,
        canonicalSnapshotRows,
        scopeMatch: false,
      });
    }

    const transactionDeletedRows = bucketResults.reduce(
      (total, result) => total + result.deleted_rows,
      0n,
    );
    const validatedPlanRows = coverage.buckets.reduce(
      (total, bucket) => total + bucket.observation_count,
      0n,
    );
    const currentIdentityRows = BigInt(currentIdentity.source_content_hash_row_count);
    const candidateIdentityRows = BigInt(candidateIdentity.source_content_hash_row_count);
    const gateIdentityRows = BigInt(gateIdentity.source_content_hash_row_count);
    if (![
      currentIdentityRows,
      candidateIdentityRows,
      gateIdentityRows,
      validatedPlanRows,
    ].every((count) => count === transactionDeletedRows)) {
      await client.query("rollback");
      transactionStarted = false;
      return blockedResult({
        pair,
        buckets: requestedBuckets,
        candidate,
        gate,
        failureReason: "connector_day_deleted_row_count_mismatch",
        sourceIdentityMatch: true,
        rolledBack: true,
        currentIdentity,
        currentBucketCount: coverage.currentBucketCount,
        eligibleBucketCount: coverage.eligibleBucketCount,
        remainingSnapshotRows,
        rawSnapshotRows,
        canonicalSnapshotRows,
        scopeMatch: true,
        validatedPlanRows,
        transactionDeletedRows,
      });
    }

    await client.query("commit");
    transactionStarted = false;
    const committedDeletedRows = transactionDeletedRows;
    return {
      ok: true,
      day_utc: pair.dayUtc,
      connector_id: pair.connectorId,
      bucket_results: bucketResults,
      blocked_buckets: [],
      diagnostics: {
        source_identity_contract_version: currentIdentity.source_content_hash_contract_version,
        source_identity_match: true,
        source_identity_failure_reason: null,
        source_identity_rows: currentIdentity.source_content_hash_row_count,
        candidate_source_identity_present: true,
        gate_source_identity_present: true,
        source_identity_invalidated_connector_days: 0,
        source_content_hash: currentIdentity.source_content_hash,
        connector_day_atomic_delete_planned: true,
        connector_day_atomic_delete_committed: true,
        connector_day_atomic_delete_rolled_back: false,
        connector_day_atomic_delete_failure_reason: null,
        connector_day_current_bucket_count: coverage.currentBucketCount,
        connector_day_eligible_bucket_count: coverage.eligibleBucketCount,
        connector_day_committed_deleted_rows: committedDeletedRows.toString(),
        connector_day_remaining_snapshot_rows: "0",
        connector_day_raw_snapshot_rows: rawSnapshotRows.toString(),
        connector_day_canonical_snapshot_rows: canonicalSnapshotRows.toString(),
        connector_day_scope_match: true,
        connector_day_validated_plan_rows: validatedPlanRows.toString(),
        connector_day_transaction_deleted_rows: transactionDeletedRows.toString(),
      },
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("rollback");
      } catch (_rollbackError) {
        // The original controlled conflict/error remains authoritative.
      }
    }
    if (TRANSACTION_CONFLICT_CODES.has(String(error?.code || ""))) {
      return blockedResult({
        pair,
        buckets: requestedBuckets,
        candidate: transactionCandidate,
        gate: transactionGate,
        failureReason: "source_identity_transaction_conflict",
        invalidated: false,
        currentIdentity: transactionCurrentIdentity,
        sourceIdentityMatch: Boolean(transactionCurrentIdentity),
        rolledBack: true,
        currentBucketCount,
        rawSnapshotRows,
        canonicalSnapshotRows,
        scopeMatch: rawSnapshotRows === null || canonicalSnapshotRows === null
          ? null
          : rawSnapshotRows === canonicalSnapshotRows,
      });
    }
    throw error;
  }
}

async function withDeletionClient(databaseUrl, callback) {
  const connectionString = String(databaseUrl || "").trim();
  if (!connectionString) throw new Error("Source-identity deletion requires SUPABASE_DB_URL");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 15_000,
    application_name: "uk-aq-prune-source-identity-delete",
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

export async function deletePruneBucketsWithSourceIdentity({
  databaseUrl,
  buckets,
  deleteBatchSize,
  maxDeleteBatchesPerHour,
  pollutantCodes = null,
  withClient = withDeletionClient,
}) {
  const results = [];
  for (const group of groupBucketsByConnectorDay(buckets)) {
    results.push(await withClient(databaseUrl, async (client) => (
      await runPruneConnectorDayDeletionTransaction({
        client,
        dayUtc: group.dayUtc,
        connectorId: group.connectorId,
        buckets: group.buckets,
        deleteBatchSize,
        maxDeleteBatchesPerHour,
        pollutantCodes,
      })
    )));
  }
  return results;
}
