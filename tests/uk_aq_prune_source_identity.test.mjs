import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computePruneConnectorSourceIdentity,
  comparePruneConnectorSourceIdentities,
} from "../workers/shared/uk_aq_prune_connector_source_identity.mjs";
import {
  deletePruneBucketsWithSourceIdentity,
  runPruneConnectorDayDeletionTransaction,
} from "../workers/uk_aq_prune_daily/source_identity_deletion.mjs";
import { buildAtomicConnectorDayDeletionPlan } from "../workers/uk_aq_prune_daily/server.mjs";

function row(overrides = {}) {
  return {
    connector_id: 7,
    station_id: 11,
    timeseries_id: 19,
    pollutant_code: "no2",
    observed_at_utc: "2026-07-21T01:00:00.000Z",
    value: 12.5,
    verification_status: "P",
    ...overrides,
  };
}

test("Prune connector source identity is value/status aware and order independent", () => {
  const rows = [row(), row({ timeseries_id: 20, value: 3, verification_status: "R" })];
  const baseline = computePruneConnectorSourceIdentity(rows);
  assert.deepEqual(computePruneConnectorSourceIdentity([...rows].reverse()), baseline);
  assert.notEqual(
    computePruneConnectorSourceIdentity([row({ value: 12.6 }), rows[1]]).source_content_hash,
    baseline.source_content_hash,
  );
  assert.notEqual(
    computePruneConnectorSourceIdentity([row({ verification_status: "R" }), rows[1]]).source_content_hash,
    baseline.source_content_hash,
  );
});

test("Prune connector source identity reuses canonical zero and status rules", () => {
  assert.equal(
    computePruneConnectorSourceIdentity([row({ value: -0 })]).source_content_hash,
    computePruneConnectorSourceIdentity([row({ value: 0 })]).source_content_hash,
  );
  assert.throws(
    () => computePruneConnectorSourceIdentity([row({ verification_status: "unverified" })]),
    /verification_status must be P, R or null/,
  );
  assert.throws(
    () => computePruneConnectorSourceIdentity([]),
    /non-empty canonical connector-day rows/,
  );
});

test("Prune connector source identity comparison distinguishes row count and content", () => {
  const baseline = computePruneConnectorSourceIdentity([row()]);
  assert.deepEqual(comparePruneConnectorSourceIdentities(baseline, baseline), {
    match: true,
    failure_reason: null,
  });
  assert.equal(comparePruneConnectorSourceIdentities(baseline, {
    ...baseline,
    source_content_hash_row_count: 2,
  }).failure_reason, "source_identity_row_count_mismatch");
  assert.equal(comparePruneConnectorSourceIdentities(baseline, {
    ...baseline,
    source_content_hash: "f".repeat(64),
  }).failure_reason, "source_identity_mismatch");
});

function transactionEvidence(sourceRows) {
  const identity = computePruneConnectorSourceIdentity(sourceRows);
  const connectorId = Number(sourceRows[0].connector_id);
  const candidate = {
    day_utc: "2026-07-21",
    connector_id: connectorId,
    status: "complete",
    ...identity,
  };
  const gate = {
    day_utc: "2026-07-21",
    connector_id: connectorId,
    history_done: true,
    history_manifest_key: `history/v2/observations/day_utc=2026-07-21/connector_id=${connectorId}/manifest.json`,
    history_manifest_hash: "a".repeat(64),
    history_row_count: sourceRows.length,
    history_file_count: 1,
    history_total_bytes: 100,
    history_completed_at: "2026-07-22T00:00:00.000Z",
    completion_source: "prune_daily_phase_b",
    ...identity,
  };
  return { candidate, gate };
}

function transactionClient({
  evidenceRows,
  currentRows,
  conflictOnDelete = false,
  deleteCounts = null,
  remainingCounts = null,
}) {
  const queries = [];
  const pendingDeleteCounts = deleteCounts ? [...deleteCounts] : null;
  const pendingRemainingCounts = remainingCounts ? [...remainingCounts] : null;
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (/from uk_aq_ops\.history_candidates\s+where[\s\S]*for update/i.test(sql)) {
        return { rows: [evidenceRows.candidate] };
      }
      if (/from uk_aq_ops\.prune_connector_day_gates\s+where[\s\S]*for update/i.test(sql)) {
        return { rows: [evidenceRows.gate] };
      }
      if (/select count\(\*\)::bigint as remaining_count/i.test(sql)) {
        return { rows: [{ remaining_count: pendingRemainingCounts?.shift() ?? 0 }] };
      }
      if (/uk_aq_phase_b_history_rows_v2/i.test(sql)) return { rows: currentRows };
      if (/^with target_rows as/im.test(sql)) {
        if (conflictOnDelete) {
          const error = new Error("serialization conflict");
          error.code = "40001";
          throw error;
        }
        return { rows: [{ deleted_count: pendingDeleteCounts?.shift() ?? currentRows.length }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

async function runTransaction(client) {
  return runPruneConnectorDayDeletionTransaction({
    client,
    dayUtc: "2026-07-21",
    connectorId: 7,
    buckets: [{
      connector_id: 7,
      hour_start: "2026-07-21T01:00:00.000Z",
      observation_count: 1n,
    }],
    deleteBatchSize: 50_000,
    maxDeleteBatchesPerHour: 1,
  });
}

test("source-identity deletion reads evidence/current rows and deletes in one repeatable-read session", async () => {
  const sourceRows = [row()];
  const client = transactionClient({ evidenceRows: transactionEvidence(sourceRows), currentRows: sourceRows });
  const result = await runTransaction(client);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.source_identity_match, true);
  assert.match(client.queries[0], /begin isolation level repeatable read/i);
  const deleteIndex = client.queries.findIndex((sql) => /^with target_rows as/im.test(sql));
  const sourceIndex = client.queries.findIndex((sql) => /uk_aq_phase_b_history_rows_v2/i.test(sql));
  assert.equal(sourceIndex > 0 && deleteIndex > sourceIndex, true);
  assert.match(client.queries.at(-1), /commit/i);
});

test("source-identity mismatch invalidates only the connector-day and performs no delete", async () => {
  const evidenceRows = [row()];
  const client = transactionClient({
    evidenceRows: transactionEvidence(evidenceRows),
    currentRows: [row({ value: 99 })],
  });
  const result = await runTransaction(client);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.source_identity_failure_reason, "source_identity_mismatch");
  assert.equal(result.diagnostics.source_identity_invalidated_connector_days, 1);
  assert.equal(client.queries.some((sql) => /^with target_rows as/im.test(sql)), false);
  assert.equal(client.queries.filter((sql) => /where day_utc = \$1::date/i.test(sql)).length >= 4, true);
  assert.match(client.queries.at(-1), /commit/i);
});

test("verification-status-only current-source change also blocks deletion", async () => {
  const evidenceRows = [row()];
  const client = transactionClient({
    evidenceRows: transactionEvidence(evidenceRows),
    currentRows: [row({ verification_status: "R" })],
  });
  const result = await runTransaction(client);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.source_identity_failure_reason, "source_identity_mismatch");
  assert.equal(client.queries.some((sql) => /^with target_rows as/im.test(sql)), false);
});

test("complete legacy candidate without source identity is ineligible", async () => {
  const sourceRows = [row()];
  const evidenceRows = transactionEvidence(sourceRows);
  evidenceRows.candidate.source_content_hash = null;
  evidenceRows.candidate.source_content_hash_contract_version = null;
  evidenceRows.candidate.source_content_hash_row_count = null;
  const client = transactionClient({ evidenceRows, currentRows: sourceRows });
  const result = await runTransaction(client);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.source_identity_failure_reason, "source_identity_missing");
  assert.equal(result.diagnostics.candidate_source_identity_present, false);
  assert.equal(client.queries.some((sql) => /^with target_rows as/im.test(sql)), false);
});

test("normal Prune has one final atomic deletion stage and late arrivals use the same helper", () => {
  const server = readFileSync("workers/uk_aq_prune_daily/server.mjs", "utf8");
  assert.match(server, /deleteBucketsWithConnectorSourceIdentity\([\s\S]+?"final_connector_day_atomic_delete"/);
  assert.match(server, /deleteBucketsWithConnectorSourceIdentity\([\s\S]+?"late_arrival_final_connector_day_atomic_delete"/);
  assert.doesNotMatch(server, /deleteBucketsWithConnectorSourceIdentity\([\s\S]{0,300}?"pre_repair"/);
  assert.doesNotMatch(server, /deleteBucketsWithConnectorSourceIdentity\([\s\S]{0,300}?"post_repair"/);
  assert.match(server, /const finalDeletion = !repairOnlyMode\s+\? await deleteBucketsWithConnectorSourceIdentity/);
  const helper = readFileSync("workers/uk_aq_prune_daily/source_identity_deletion.mjs", "utf8");
  assert.match(helper, /begin isolation level repeatable read/i);
  assert.match(helper, /await readLockedEvidence\(client, pair\)/);
  assert.match(helper, /await readCurrentCanonicalRows\(client, pair\)/);
  assert.match(helper, /await deleteOneHour\([\s\S]+?client/);
  assert.match(helper, /remainingSnapshotRows !== 0n/);
  assert.doesNotMatch(helper, /fetch\(|createClient\(|r2|dropbox|observsClient/i);
});

test("final plan combines initially matched and repaired buckets into one connector-day", async () => {
  const buckets = [
    {
      connector_id: 7,
      hour_start: "2026-07-21T01:00:00.000Z",
      observation_count: 1n,
    },
    {
      connector_id: 7,
      hour_start: "2026-07-21T02:00:00.000Z",
      observation_count: 1n,
    },
  ];
  const plan = buildAtomicConnectorDayDeletionPlan({
    currentBuckets: buckets,
    eligibleBuckets: buckets,
  });
  assert.equal(plan.connectorDays.length, 1);
  assert.equal(plan.plannedBuckets.length, 2);

  const sourceRows = [
    row(),
    row({ timeseries_id: 20, observed_at_utc: "2026-07-21T02:00:00.000Z" }),
  ];
  const client = transactionClient({
    evidenceRows: transactionEvidence(sourceRows),
    currentRows: sourceRows,
    deleteCounts: [1, 1],
    remainingCounts: [0, 0, 0],
  });
  const result = await runPruneConnectorDayDeletionTransaction({
    client,
    dayUtc: "2026-07-21",
    connectorId: 7,
    buckets: plan.plannedBuckets,
    deleteBatchSize: 50_000,
    maxDeleteBatchesPerHour: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.bucket_results.length, 2);
  assert.equal(result.diagnostics.connector_day_committed_deleted_rows, "2");
  assert.equal(client.queries.filter((sql) => /^begin /i.test(sql)).length, 1);
  assert.equal(client.queries.filter((sql) => /^commit$/i.test(sql)).length, 1);
});

test("one remaining mismatch blocks the whole connector-day before deletion", () => {
  const matched = {
    connector_id: 7,
    hour_start: "2026-07-21T01:00:00.000Z",
    observation_count: 1n,
  };
  const mismatched = {
    connector_id: 7,
    hour_start: "2026-07-21T02:00:00.000Z",
    observation_count: 1n,
  };
  const plan = buildAtomicConnectorDayDeletionPlan({
    currentBuckets: [matched, mismatched],
    eligibleBuckets: [matched],
    unresolvedBuckets: [{
      connector_id: 7,
      hour_start: mismatched.hour_start,
      reason: "fingerprint_mismatch",
    }],
  });
  assert.equal(plan.plannedBuckets.length, 0);
  assert.equal(plan.blockedBuckets.length, 2);
  assert.equal(
    plan.connectorDays[0].connector_day_atomic_delete_failure_reason,
    "connector_day_not_fully_eligible",
  );
});

test("batch cap with remaining rows rolls back the whole connector-day and retains evidence", async () => {
  const sourceRows = [
    row(),
    row({ timeseries_id: 20, observed_at_utc: "2026-07-21T02:00:00.000Z" }),
  ];
  const client = transactionClient({
    evidenceRows: transactionEvidence(sourceRows),
    currentRows: sourceRows,
    deleteCounts: [1, 1],
    remainingCounts: [0, 1],
  });
  const result = await runPruneConnectorDayDeletionTransaction({
    client,
    dayUtc: "2026-07-21",
    connectorId: 7,
    buckets: [
      { connector_id: 7, hour_start: "2026-07-21T01:00:00.000Z", observation_count: 1n },
      { connector_id: 7, hour_start: "2026-07-21T02:00:00.000Z", observation_count: 1n },
    ],
    deleteBatchSize: 50_000,
    maxDeleteBatchesPerHour: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.source_identity_failure_reason, "connector_day_delete_cap_reached");
  assert.equal(result.diagnostics.connector_day_committed_deleted_rows, "0");
  assert.equal(result.diagnostics.connector_day_atomic_delete_rolled_back, true);
  assert.equal(client.queries.filter((sql) => /^with target_rows as/im.test(sql)).length, 2);
  assert.match(client.queries.at(-1), /rollback/i);
  assert.equal(client.queries.some((sql) => /^update uk_aq_ops\./im.test(sql)), false);
});

test("non-empty final snapshot rolls back and an empty final snapshot commits", async () => {
  const sourceRows = [row()];
  const retainedClient = transactionClient({
    evidenceRows: transactionEvidence(sourceRows),
    currentRows: sourceRows,
    deleteCounts: [1],
    remainingCounts: [0, 1],
  });
  const retained = await runTransaction(retainedClient);
  assert.equal(retained.ok, false);
  assert.equal(retained.diagnostics.source_identity_failure_reason, "connector_day_not_fully_drained");
  assert.equal(retained.diagnostics.connector_day_remaining_snapshot_rows, "1");
  assert.match(retainedClient.queries.at(-1), /rollback/i);

  const drainedClient = transactionClient({
    evidenceRows: transactionEvidence(sourceRows),
    currentRows: sourceRows,
    deleteCounts: [1],
    remainingCounts: [0, 0],
  });
  const drained = await runTransaction(drainedClient);
  assert.equal(drained.ok, true);
  assert.equal(drained.diagnostics.connector_day_remaining_snapshot_rows, "0");
  assert.match(drainedClient.queries.at(-1), /commit/i);
});

test("pollutant-scoped plan rolls back before deleting under full connector-day identity", async () => {
  const sourceRows = [row()];
  const client = transactionClient({
    evidenceRows: transactionEvidence(sourceRows),
    currentRows: sourceRows,
  });
  const result = await runPruneConnectorDayDeletionTransaction({
    client,
    dayUtc: "2026-07-21",
    connectorId: 7,
    buckets: [{
      connector_id: 7,
      hour_start: "2026-07-21T01:00:00.000Z",
      observation_count: 1n,
    }],
    deleteBatchSize: 50_000,
    maxDeleteBatchesPerHour: 1,
    pollutantCodes: ["no2"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.source_identity_failure_reason, "connector_day_scope_mismatch");
  assert.equal(client.queries.some((sql) => /^with target_rows as/im.test(sql)), false);
  assert.match(client.queries.at(-1), /rollback/i);
});

test("source mismatch blocks only its connector-day while another connector commits", async () => {
  const connectorSevenRows = [row()];
  const connectorEightRows = [row({ connector_id: 8, timeseries_id: 21 })];
  const clients = [
    transactionClient({
      evidenceRows: transactionEvidence(connectorSevenRows),
      currentRows: [row({ value: 99 })],
    }),
    transactionClient({
      evidenceRows: transactionEvidence(connectorEightRows),
      currentRows: connectorEightRows,
      deleteCounts: [1],
      remainingCounts: [0, 0],
    }),
  ];
  let clientIndex = 0;
  const results = await deletePruneBucketsWithSourceIdentity({
    databaseUrl: "postgres://unused",
    buckets: [
      { connector_id: 7, hour_start: "2026-07-21T01:00:00.000Z", observation_count: 1n },
      { connector_id: 8, hour_start: "2026-07-21T01:00:00.000Z", observation_count: 1n },
    ],
    deleteBatchSize: 50_000,
    maxDeleteBatchesPerHour: 1,
    withClient: async (_databaseUrl, callback) => callback(clients[clientIndex++]),
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].diagnostics.source_identity_failure_reason, "source_identity_mismatch");
  assert.equal(results[1].ok, true);
  assert.match(clients[0].queries.at(-1), /commit/i);
  assert.match(clients[1].queries.at(-1), /commit/i);
});

test("source-identity transaction conflict rolls back and retains observations", async () => {
  const sourceRows = [row()];
  const client = transactionClient({
    evidenceRows: transactionEvidence(sourceRows),
    currentRows: sourceRows,
    conflictOnDelete: true,
  });
  const result = await runTransaction(client);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.source_identity_failure_reason, "source_identity_transaction_conflict");
  assert.match(client.queries.at(-1), /rollback/i);
});
