import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computePruneConnectorSourceIdentity,
  comparePruneConnectorSourceIdentities,
} from "../workers/shared/uk_aq_prune_connector_source_identity.mjs";
import { runPruneConnectorDayDeletionTransaction } from "../workers/uk_aq_prune_daily/source_identity_deletion.mjs";

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
  const candidate = {
    day_utc: "2026-07-21",
    connector_id: 7,
    status: "complete",
    ...identity,
  };
  const gate = {
    day_utc: "2026-07-21",
    connector_id: 7,
    history_done: true,
    history_manifest_key: "history/v2/observations/day_utc=2026-07-21/connector_id=7/manifest.json",
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

function transactionClient({ evidenceRows, currentRows, conflictOnDelete = false }) {
  const queries = [];
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
      if (/uk_aq_phase_b_history_rows_v2/i.test(sql)) return { rows: currentRows };
      if (/^with target_rows as/im.test(sql)) {
        if (conflictOnDelete) {
          const error = new Error("serialization conflict");
          error.code = "40001";
          throw error;
        }
        return { rows: [{ deleted_count: currentRows.length }] };
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

test("pre-repair, post-repair and late-arrival deletion share the source-identity helper", () => {
  const server = readFileSync("workers/uk_aq_prune_daily/server.mjs", "utf8");
  assert.match(server, /deleteBucketsWithConnectorSourceIdentity\([\s\S]+?"pre_repair"/);
  assert.match(server, /deleteBucketsWithConnectorSourceIdentity\([\s\S]+?"post_repair"/);
  assert.match(server, /deleteBucketsWithConnectorSourceIdentity\([\s\S]+?"late_arrival_direct_delete"/);
  const helper = readFileSync("workers/uk_aq_prune_daily/source_identity_deletion.mjs", "utf8");
  assert.match(helper, /begin isolation level repeatable read/i);
  assert.match(helper, /await readLockedEvidence\(client, pair\)/);
  assert.match(helper, /await readCurrentCanonicalRows\(client, pair\)/);
  assert.match(helper, /await deleteOneHour\([\s\S]+?client/);
  assert.doesNotMatch(helper, /fetch\(|createClient\(|r2|dropbox|observsClient/i);
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
