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
import {
  buildAtomicConnectorDayDeletionPlan,
  claimConnectorDaysForParentRun,
  executePruneDaily,
} from "../workers/uk_aq_prune_daily/server.mjs";

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
  rawCounts = null,
}) {
  const queries = [];
  const pendingDeleteCounts = deleteCounts ? [...deleteCounts] : null;
  const pendingRemainingCounts = remainingCounts ? [...remainingCounts] : null;
  const pendingRawCounts = rawCounts ? [...rawCounts] : null;
  let rawCountReads = 0;
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
      if (/select count\(\*\)::bigint as raw_snapshot_row_count/i.test(sql)) {
        const fallback = rawCountReads === 0 ? currentRows.length : 0;
        rawCountReads += 1;
        return { rows: [{ raw_snapshot_row_count: pendingRawCounts?.shift() ?? fallback }] };
      }
      if (/^with target_rows as/im.test(sql)) {
        if (conflictOnDelete) {
          const error = new Error("serialization conflict");
          error.code = "40001";
          throw error;
        }
        return { rows: [{ deleted_count: pendingDeleteCounts?.shift() ?? currentRows.length }] };
      }
      if (/uk_aq_phase_b_history_rows_v2/i.test(sql)) return { rows: currentRows };
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

test("locked candidate and gate evidence use explicit canonical date projections", () => {
  const helper = readFileSync("workers/uk_aq_prune_daily/source_identity_deletion.mjs", "utf8");
  assert.doesNotMatch(helper, /select \*\s+from uk_aq_ops\.(?:history_candidates|prune_connector_day_gates)/i);
  assert.match(
    helper,
    /select\s+day_utc::text as day_utc,[\s\S]+from uk_aq_ops\.history_candidates[\s\S]+for update/i,
  );
  assert.match(
    helper,
    /select\s+day_utc::text as day_utc,[\s\S]+from uk_aq_ops\.prune_connector_day_gates[\s\S]+for update/i,
  );
});

test("canonical text and UTC-midnight Date evidence reach current-source comparison", async () => {
  for (const dayUtc of ["2026-07-21", new Date("2026-07-21T00:00:00.000Z")]) {
    const sourceRows = [row()];
    const evidenceRows = transactionEvidence(sourceRows);
    evidenceRows.candidate.day_utc = dayUtc;
    evidenceRows.gate.day_utc = dayUtc;
    const client = transactionClient({ evidenceRows, currentRows: sourceRows });
    const result = await runTransaction(client);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.source_identity_failure_reason, null);
    assert.equal(result.diagnostics.source_identity_match, true);
    assert.equal(client.queries.some((sql) => /uk_aq_phase_b_history_rows_v2/i.test(sql)), true);
  }
});

test("evidence diagnostics distinguish absent, incomplete, invalid and unsupported cases", async () => {
  const sourceRows = [row()];
  const baseline = transactionEvidence(sourceRows);
  const variants = [
    {
      evidenceRows: { ...baseline, candidate: null },
      reason: "candidate_evidence_missing",
    },
    {
      evidenceRows: { ...baseline, gate: null },
      reason: "gate_evidence_missing",
    },
    {
      evidenceRows: { ...baseline, candidate: { ...baseline.candidate, status: "pending" } },
      reason: "candidate_not_complete",
    },
    {
      evidenceRows: {
        ...baseline,
        gate: { ...baseline.gate, history_manifest_hash: "invalid" },
      },
      reason: "gate_evidence_invalid",
    },
    {
      evidenceRows: {
        candidate: {
          ...baseline.candidate,
          source_content_hash_contract_version: 2,
        },
        gate: {
          ...baseline.gate,
          source_content_hash_contract_version: 2,
        },
      },
      reason: "source_identity_contract_unsupported",
    },
  ];
  for (const variant of variants) {
    const client = transactionClient({ evidenceRows: variant.evidenceRows, currentRows: sourceRows });
    const result = await runTransaction(client);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.source_identity_failure_reason, variant.reason);
    assert.equal(client.queries.some((sql) => /^with target_rows as/im.test(sql)), false);
  }
});

test("unparseable returned dates roll back without invalidating valid identity evidence", async () => {
  const sourceRows = [row()];
  for (const field of ["candidate", "gate"]) {
    const evidenceRows = transactionEvidence(sourceRows);
    evidenceRows[field].day_utc = new Date("2026-07-20T23:00:00.000Z");
    const client = transactionClient({ evidenceRows, currentRows: sourceRows });
    const result = await runTransaction(client);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.source_identity_failure_reason, `${field}_evidence_invalid`);
    assert.equal(result.diagnostics.candidate_source_identity_present, true);
    assert.equal(result.diagnostics.gate_source_identity_present, true);
    assert.equal(result.diagnostics.source_identity_invalidated_connector_days, 0);
    assert.equal(result.diagnostics.connector_day_atomic_delete_rolled_back, true);
    assert.equal(client.queries.some((sql) => /^update uk_aq_ops\./im.test(sql)), false);
    assert.equal(client.queries.some((sql) => /^with target_rows as/im.test(sql)), false);
    assert.match(client.queries.at(-1), /rollback/i);
  }
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
  assert.match(server, /claimConnectorDaysForParentRun\([\s\S]+?completeInitialState = await recheckCompleteConnectorDays/);
  const helper = readFileSync("workers/uk_aq_prune_daily/source_identity_deletion.mjs", "utf8");
  assert.match(helper, /begin isolation level repeatable read/i);
  assert.match(helper, /await readLockedEvidence\(client, pair\)/);
  assert.match(helper, /await readCurrentCanonicalRows\(client, pair\)/);
  assert.match(helper, /await deleteOneHour\([\s\S]+?client/);
  assert.match(helper, /remainingSnapshotRows !== 0n/);
  assert.match(helper, /with target_rows as \([\s\S]+from uk_aq_ops\.uk_aq_phase_b_history_rows_v2\(/);
  assert.match(helper, /o\.connector_id = t\.connector_id[\s\S]+o\.timeseries_id = t\.timeseries_id[\s\S]+o\.observed_at = t\.observed_at_utc/);
  assert.doesNotMatch(helper, /select o\.ctid|o\.ctid = t\.ctid/);
  assert.doesNotMatch(helper, /fetch\(|createClient\(|r2|dropbox|observsClient/i);
});

test("raw rows outside canonical metadata scope block before delete and preserve evidence", async () => {
  const sourceRows = [row()];
  const client = transactionClient({
    evidenceRows: transactionEvidence(sourceRows),
    currentRows: sourceRows,
    rawCounts: [2],
  });
  const result = await runTransaction(client);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.connector_day_atomic_delete_failure_reason, "connector_day_scope_mismatch");
  assert.equal(result.diagnostics.connector_day_raw_snapshot_rows, "2");
  assert.equal(result.diagnostics.connector_day_canonical_snapshot_rows, "1");
  assert.equal(result.diagnostics.connector_day_scope_match, false);
  assert.equal(client.queries.some((sql) => /^with target_rows as/im.test(sql)), false);
  assert.equal(client.queries.some((sql) => /^update uk_aq_ops\./im.test(sql)), false);
  assert.match(client.queries.at(-1), /rollback/i);
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

test("duplicate, missing, extra and count-different hour plans fail before deletion", async () => {
  const sourceRows = [
    row(),
    row({ timeseries_id: 20, observed_at_utc: "2026-07-21T02:00:00.000Z" }),
  ];
  const hourOne = { connector_id: 7, hour_start: "2026-07-21T01:00:00.000Z", observation_count: 1n };
  const hourTwo = { connector_id: 7, hour_start: "2026-07-21T02:00:00.000Z", observation_count: 1n };
  const variants = [
    [hourOne, hourOne, hourTwo],
    [hourOne],
    [hourOne, hourTwo, { connector_id: 7, hour_start: "2026-07-21T03:00:00.000Z", observation_count: 1n }],
    [hourOne, { ...hourTwo, observation_count: 2n }],
  ];
  for (const buckets of variants) {
    const client = transactionClient({
      evidenceRows: transactionEvidence(sourceRows),
      currentRows: sourceRows,
    });
    const result = await runPruneConnectorDayDeletionTransaction({
      client,
      dayUtc: "2026-07-21",
      connectorId: 7,
      buckets,
      deleteBatchSize: 50_000,
      maxDeleteBatchesPerHour: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.connector_day_atomic_delete_failure_reason, "connector_day_not_fully_eligible");
    assert.equal(client.queries.some((sql) => /^with target_rows as/im.test(sql)), false);
    assert.equal(client.queries.some((sql) => /^update uk_aq_ops\./im.test(sql)), false);
    assert.match(client.queries.at(-1), /rollback/i);
  }
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
  assert.equal(retainedClient.queries.some((sql) => /^update uk_aq_ops\./im.test(sql)), false);

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

test("actual deleted-row mismatch rolls back with zero committed rows and preserves evidence", async () => {
  const sourceRows = [row()];
  const client = transactionClient({
    evidenceRows: transactionEvidence(sourceRows),
    currentRows: sourceRows,
    deleteCounts: [0],
    remainingCounts: [0, 0],
    rawCounts: [1, 0],
  });
  const result = await runTransaction(client);
  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics.connector_day_atomic_delete_failure_reason,
    "connector_day_deleted_row_count_mismatch",
  );
  assert.equal(result.diagnostics.connector_day_committed_deleted_rows, "0");
  assert.equal(result.diagnostics.connector_day_transaction_deleted_rows, "0");
  assert.equal(result.diagnostics.connector_day_validated_plan_rows, "1");
  assert.equal(result.diagnostics.connector_day_atomic_delete_rolled_back, true);
  assert.equal(client.queries.some((sql) => /^update uk_aq_ops\./im.test(sql)), false);
  assert.match(client.queries.at(-1), /rollback/i);
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
  assert.equal(client.queries.some((sql) => /^update uk_aq_ops\./im.test(sql)), false);
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

test("non-day-aligned parent batches claim a connector-day once and retain atomic top-level health reporting", async () => {
  const config = {
    dryRun: false,
    maxHoursPerRun: 25,
    ingestDbRetentionDays: 5,
    repairOneMismatchBucket: false,
    phaseB: { enabled: true, history_write_version: "v2" },
  };
  const repeatedBucket = {
    connector_id: 7,
    hour_start: "2026-07-21T23:00:00.000Z",
    observation_count: 1n,
  };
  let batchCalls = 0;
  let normalDeletionDecisions = 0;
  let lateDuplicateConnectorDays = 0;
  let healthSummary = null;
  const summary = await executePruneDaily(config, {
    runPhaseARecent: async () => ({ enabled: false, skipped: true }),
    runPhaseBBackup: async () => ({ enabled: true, status: "completed" }),
    runPruneSingleWindow: async (_config, _batch, runContext) => {
      batchCalls += 1;
      const claimed = claimConnectorDaysForParentRun(
        [repeatedBucket],
        runContext.processed_connector_days,
      );
      if (claimed.claimedBuckets.length === 0) {
        return {
          run_id: `batch-${batchCalls}`,
          duplicate_connector_day_skipped_count: claimed.duplicateConnectorDays.length,
          duplicate_connector_day_skipped_preview: claimed.duplicateConnectorDays,
          connector_day_atomic_delete_planned_count: 0,
          connector_day_atomic_delete_committed_count: 0,
          connector_day_atomic_delete_rolled_back_count: 0,
          connector_day_atomic_delete_blocked_bucket_count: 0,
          connector_day_atomic_delete_plan_preview: [],
          connector_day_atomic_delete_result_preview: [],
        };
      }
      normalDeletionDecisions += 1;
      return {
        run_id: `batch-${batchCalls}`,
        duplicate_connector_day_skipped_count: 0,
        duplicate_connector_day_skipped_preview: [],
        connector_day_atomic_delete_planned_count: 1,
        connector_day_atomic_delete_committed_count: 1,
        connector_day_atomic_delete_rolled_back_count: 0,
        connector_day_atomic_delete_blocked_bucket_count: 0,
        connector_day_atomic_delete_plan_preview: [{
          day_utc: "2026-07-21",
          connector_id: 7,
          connector_day_atomic_delete_planned: true,
        }],
        connector_day_atomic_delete_result_preview: [{
          day_utc: "2026-07-21",
          connector_id: 7,
          connector_day_atomic_delete_committed: true,
        }],
      };
    },
    runLateArrivalCleanup: async (_config, _window, runContext) => {
      const duplicate = claimConnectorDaysForParentRun(
        [repeatedBucket],
        runContext.processed_connector_days,
      );
      lateDuplicateConnectorDays = duplicate.duplicateConnectorDays.length;
      return {
        enabled: true,
        skipped: false,
        duplicate_connector_day_skipped_count: lateDuplicateConnectorDays,
        duplicate_connector_day_skipped_preview: duplicate.duplicateConnectorDays,
        connector_day_atomic_delete_planned_count: 1,
        connector_day_atomic_delete_committed_count: 0,
        connector_day_atomic_delete_rolled_back_count: 1,
        connector_day_atomic_delete_blocked_bucket_count: 2,
        connector_day_atomic_delete_plan_preview: [{
          day_utc: "2026-07-20",
          connector_id: 8,
          connector_day_atomic_delete_planned: true,
        }],
        connector_day_atomic_delete_result_preview: [{
          day_utc: "2026-07-20",
          connector_id: 8,
          connector_day_atomic_delete_rolled_back: true,
          connector_day_atomic_delete_failure_reason: "connector_day_delete_cap_reached",
        }],
      };
    },
    withDailyTaskRun: async (input, fn) => {
      const result = await fn();
      healthSummary = input.buildFinishedSummary(result);
      return result;
    },
  });

  assert.equal(batchCalls, 2);
  assert.equal(normalDeletionDecisions, 1);
  assert.equal(lateDuplicateConnectorDays, 1);
  assert.equal(summary.duplicate_connector_day_skipped_count, 2);
  assert.equal(summary.connector_day_atomic_delete_planned_count, 2);
  assert.equal(summary.connector_day_atomic_delete_committed_count, 1);
  assert.equal(summary.connector_day_atomic_delete_rolled_back_count, 1);
  assert.equal(summary.connector_day_atomic_delete_blocked_bucket_count, 2);
  assert.equal(summary.connector_day_atomic_delete_plan_preview.length, 2);
  assert.equal(summary.connector_day_atomic_delete_result_preview.length, 2);
  assert.equal(healthSummary.connector_day_atomic_delete_planned_count, 2);
  assert.equal(healthSummary.connector_day_atomic_delete_committed_count, 1);
  assert.equal(healthSummary.connector_day_atomic_delete_rolled_back_count, 1);
  assert.equal(healthSummary.connector_day_atomic_delete_blocked_bucket_count, 2);
  assert.equal(healthSummary.connector_day_atomic_delete_result_preview.length, 2);
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
  assert.equal(client.queries.some((sql) => /^update uk_aq_ops\./im.test(sql)), false);
  assert.match(client.queries.at(-1), /rollback/i);
});
