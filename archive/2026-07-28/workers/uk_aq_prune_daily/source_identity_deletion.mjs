import { Client } from "pg";
import { isValidConnectorHistoryGateEvidence } from "../shared/uk_aq_connector_day_gate.mjs";
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
  return { dayUtc, connectorId, dayStart: dayStart.toISOString() };
}

function groupBucketsByConnectorDay(buckets) {
  const groups = new Map();
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const pair = normalizePair(String(bucket?.hour_start || "").slice(0, 10), bucket?.connector_id);
    const hourStart = new Date(String(bucket?.hour_start || ""));
    if (
      Number.isNaN(hourStart.getTime())
      || hourStart.toISOString() !== String(bucket.hour_start)
      || hourStart.toISOString().slice(0, 10) !== pair.dayUtc
    ) {
      throw new Error(`Invalid deletion hour_start: ${String(bucket?.hour_start || "")}`);
    }
    const key = `${pair.dayUtc}|${pair.connectorId}`;
    if (!groups.has(key)) groups.set(key, { ...pair, buckets: [] });
    groups.get(key).buckets.push(bucket);
  }
  return Array.from(groups.values());
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
      source_identity_match: false,
      source_identity_failure_reason: failureReason,
      source_identity_rows: currentIdentity?.source_content_hash_row_count ?? null,
      candidate_source_identity_present: identityPresent(candidate),
      gate_source_identity_present: identityPresent(gate),
      source_identity_invalidated_connector_days: invalidated ? 1 : 0,
    },
  };
}

async function readLockedEvidence(client, pair) {
  const candidateResult = await client.query(
    `
select *
from uk_aq_ops.history_candidates
where day_utc = $1::date
  and connector_id = $2::integer
for update
`,
    [pair.dayUtc, pair.connectorId],
  );
  const gateResult = await client.query(
    `
select *
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

async function readCurrentCanonicalRows(client, pair) {
  const dayEnd = new Date(Date.parse(pair.dayStart) + 24 * HOUR_MS).toISOString();
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
    [pair.connectorId, pair.dayStart, dayEnd],
  );
  return result.rows;
}

async function deleteOneHour(client, pair, bucket, deleteBatchSize, maxDeleteBatchesPerHour, pollutantCodes) {
  let totalDeleted = 0n;
  let batchesRun = 0;
  let drained = false;
  let lastDeleted = 0;
  for (let batchNumber = 1; batchNumber <= maxDeleteBatchesPerHour; batchNumber += 1) {
    batchesRun = batchNumber;
    const result = await client.query(
      `
with target_rows as (
  select o.ctid
  from uk_aq_core.observations o
  where o.connector_id = $1::integer
    and o.observed_at >= $2::timestamptz
    and o.observed_at < $2::timestamptz + interval '1 hour'
    and (
      $4::text[] is null
      or exists (
        select 1
        from uk_aq_core.timeseries ts
        join uk_aq_core.phenomena p on p.id = ts.phenomenon_id
        join uk_aq_core.observed_properties op on op.id = p.observed_property_id
        where ts.id = o.timeseries_id
          and ts.connector_id = o.connector_id
          and lower(op.code) = any($4::text[])
      )
    )
  limit $3::integer
),
deleted as (
  delete from uk_aq_core.observations o
  using target_rows t
  where o.ctid = t.ctid
  returning 1
)
select count(*)::integer as deleted_count from deleted
`,
      [pair.connectorId, bucket.hour_start, deleteBatchSize, pollutantCodes],
    );
    lastDeleted = Number(result.rows[0]?.deleted_count || 0);
    if (lastDeleted === 0) {
      drained = true;
      break;
    }
    totalDeleted += BigInt(lastDeleted);
  }
  return {
    connector_id: bucket.connector_id,
    hour_start: bucket.hour_start,
    deleted_rows: totalDeleted,
    batches_run: batchesRun,
    drained,
    max_batches_reached_with_remaining_rows: !drained && lastDeleted > 0,
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
  let transactionStarted = false;
  let transactionCandidate = null;
  let transactionGate = null;
  let transactionCurrentIdentity = null;
  try {
    await client.query("begin isolation level repeatable read");
    transactionStarted = true;
    const { candidate, gate } = await readLockedEvidence(client, pair);
    transactionCandidate = candidate;
    transactionGate = gate;
    let candidateIdentity;
    let gateIdentity;
    let failureReason = null;
    try {
      if (candidate?.status !== "complete" || !isValidConnectorHistoryGateEvidence(gate)) {
        throw new TypeError("source_identity_missing");
      }
      candidateIdentity = normalizePruneConnectorSourceIdentity(candidate);
      gateIdentity = normalizePruneConnectorSourceIdentity(gate);
      const candidateGateComparison = comparePruneConnectorSourceIdentities(candidateIdentity, gateIdentity);
      if (!candidateGateComparison.match) failureReason = candidateGateComparison.failure_reason;
    } catch (error) {
      failureReason = pruneConnectorSourceIdentityFailureReason(error);
    }

    let currentIdentity = null;
    if (!failureReason) {
      try {
        currentIdentity = computePruneConnectorSourceIdentity(
          await readCurrentCanonicalRows(client, pair),
        );
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
        buckets,
        candidate,
        gate,
        failureReason,
        invalidated: true,
        currentIdentity,
      });
    }

    const bucketResults = [];
    for (const bucket of buckets) {
      bucketResults.push(await deleteOneHour(
        client,
        pair,
        bucket,
        deleteBatchSize,
        maxDeleteBatchesPerHour,
        pollutantCodes,
      ));
    }
    await client.query("commit");
    transactionStarted = false;
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
        buckets,
        candidate: transactionCandidate,
        gate: transactionGate,
        failureReason: "source_identity_transaction_conflict",
        invalidated: false,
        currentIdentity: transactionCurrentIdentity,
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
