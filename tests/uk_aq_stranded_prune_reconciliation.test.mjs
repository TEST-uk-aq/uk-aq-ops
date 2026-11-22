import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computePruneConnectorSourceIdentity } from "../workers/shared/uk_aq_prune_connector_source_identity.mjs";
import { buildObservationHistoryV3SteadyStatePartition } from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import { buildObservationHistoryExactLeafIndexV3Latest } from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { buildHistoryV2ConnectorManifest, buildHistoryV2DayManifest, buildHistoryV2DayManifestKey } from "../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifest, buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifest, buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifest, buildR2HistoryV2ObservationsYearManifestKey,
  serializeR2HistoryV2ObservationsAggregateManifest,
} from "../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import { readApproval, validateBaseline } from "../scripts/operations/lib/stranded_prune_authority.mjs";
import { connectorManifestKey, readSelectedHistory } from "../scripts/operations/lib/stranded_prune_history.mjs";
import {
  CommitOutcomeUnknown, encodeMultiset, executeTransaction, IMPACT, LIMITATION, readSource, ROWS,
} from "../scripts/operations/lib/stranded_prune_source.mjs";

const dayUtc = "2026-10-22";
const cutoff = "2026-10-24T03:22:00.000Z";
const connectorId = 7;
const prefix = "history/v3/observations";
const targetWriterGitSha = "a".repeat(40);
const canonical = Array.from({ length: ROWS }, (_, index) => {
  const pollutant = index % 37;
  return {
    connector_id: connectorId, timeseries_id: pollutant + 101, station_id: 30,
    pollutant_code: `p_${String(pollutant).padStart(2, "0")}`, value: index / 10,
    verification_status: ["P", "R", null][index % 3],
    observed_at_utc: new Date(Date.parse(`${dayUtc}T00:00:00.000Z`) + Math.floor(index / 37) * 140_000),
  };
}).sort((a, b) => a.timeseries_id - b.timeseries_id || a.observed_at_utc - b.observed_at_utc)
  .map((row) => ({ ...row, instant: row.observed_at_utc.toISOString() }));
const baseline = {
  day_utc: dayUtc, connector_id: connectorId, publication_cutoff: cutoff, original_run_id: "b4c0a403-662b-4866-9392-9fdb6bdb4225",
  manifest_key: connectorManifestKey(dayUtc, connectorId), writer_git_sha: targetWriterGitSha, manifest_hash: "c".repeat(64),
  ...computePruneConnectorSourceIdentity(canonical),
};
const raw = canonical.map((row, index) => ({
  ...row, relation_oid: "11", tuple_id: `(1,${index + 1})`, row_version: "3", before_cutoff: true,
  row_data: { connector_id: row.connector_id, timeseries_id: row.timeseries_id, observed_at: row.instant },
}));
const gate = Object.fromEntries([
  "history_run_id", "history_manifest_key", "history_manifest_hash", "history_row_count", "history_file_count",
  "history_total_bytes", "history_completed_at", "completion_source", "source_content_hash",
  "source_content_hash_contract_version", "source_content_hash_row_count",
].map((key) => [key, null]));
gate.history_done = false;
const candidate = {
  status: "failed", expected_row_count: ROWS, manifest_key: null, source_content_hash: null,
  source_content_hash_contract_version: null, source_content_hash_row_count: null, history_completed_at: null,
  history_row_count: null, history_file_count: null, history_total_bytes: null,
  last_error: 'PRUNE_HISTORY_AUTHORITY_BLOCKED:' + JSON.stringify({
    day_utc: dayUtc, connector_id: connectorId, previous_authority: `${baseline.manifest_key}#${baseline.manifest_hash}`,
  }),
};
const layout = [
  { oid: "10", partition_key: "LIST (connector_id)", kind: "p", isleaf: false, persistence: "p" },
  { oid: "11", partition_key: null, kind: "r", isleaf: true, persistence: "p" },
];
const source = (await readSource({
  query: async (sql) => ({ rows: sql.includes("row_data") ? raw : canonical }),
}, baseline)).summary;

function mockTransaction(failure) {
  let began = false;
  let fenced = false;
  let removed = false;
  let pendingReceipt = false;
  const state = { deleted: false, receipt: false, writes: 0, rolledBack: false };
  const client = { async query(text) {
    const sql = text.trim().toLowerCase();
    if (sql === "show server_version_num") return { rows: [{ server_version_num: "170006" }] };
    if (sql.startsWith("set ")) return {};
    if (sql === "begin isolation level repeatable read") { began = true; return {}; }
    assert.ok(began);
    if (sql.startsWith("lock table ")) {
      assert.equal(sql, "lock table uk_aq_core.observations in share row exclusive mode");
      if (failure === "contention") throw new Error("contended");
      fenced = true;
      return {};
    }
    if (sql === "rollback") {
      state.rolledBack = true;
      removed = false;
      pendingReceipt = false;
      return {};
    }
    assert.ok(fenced, "snapshot-acquiring SQL must follow the recursive table lock");
    if (sql.includes("pg_partition_tree")) return { rows: layout.map((row) =>
      ({ ...row, fenced: failure !== "coverage" || !row.isleaf })) };
    if (sql.startsWith("select to_jsonb(r)")) {
      return { rows: state.receipt || failure === "replay" ? [{ receipt: {} }] : [] };
    }
    if (sql.includes("select to_jsonb(c)")) return { rows: [{ evidence: candidate }] };
    if (sql.includes("select to_jsonb(g)")) return { rows: [{ evidence: gate }] };
    if (sql.includes("row_data")) {
      return { rows: failure === "changed" ? [{ ...raw[0], row_version: "4" }, ...raw.slice(1)] : raw };
    }
    if (sql.startsWith("select h.*")) return { rows: canonical };
    if (sql.startsWith("delete from")) {
      state.writes++;
      removed = true;
      return { rowCount: ROWS, rows: failure === "wrong_key" ? [{ ...raw[0], timeseries_id: 5000 }, ...raw.slice(1)] : raw };
    }
    if (sql.startsWith("select (select count")) return { rows: [{ raw: removed ? 0 : ROWS, canonical: removed ? 0 : ROWS }] };
    if (sql.startsWith("insert into")) {
      if (failure === "audit") throw new Error("audit unavailable");
      pendingReceipt = true;
      return { rowCount: 1, rows: [{ receipt: { transaction_id: "6" } }] };
    }
    if (sql === "commit") {
      state.deleted = removed;
      state.receipt = pendingReceipt;
      if (failure === "ambiguous") throw new Error("connection vanished after commit");
      return { command: "COMMIT" };
    }
    assert.fail(`Unexpected SQL: ${sql}`);
  } };
  const plan = { baseline, evidence: { candidate, gate }, layout, source, operation_id: "31b20b8a-6972-43cb-8599-d60b12d3c673" };
  const run = () => executeTransaction({
    client, plan, planSha: "a".repeat(64), approval: { lock_ms: 5_000, reference: "review", backup: {} },
    lock: { assertHeld() {}, assertOwned() { assert.ok(fenced); } }, assertWindow: () => 120_000,
  });
  return { run, state };
}

test("recursive fence precedes the snapshot and commits exact deletion with one receipt", async () => {
  const { run, state } = mockTransaction();
  assert.deepEqual(await run(), { transaction_id: "6" });
  assert.deepEqual(state, { deleted: true, receipt: true, writes: 1, rolledBack: false });
});

for (const [failure, writes, error] of [
  ["contention", 0, /contended/], ["coverage", 0, /coverage/], ["changed", 0, /changed since planning/],
  ["replay", 0, /already recorded/], ["wrong_key", 1, /different raw key set/], ["audit", 1, /audit unavailable/],
]) {
  test(`${failure} aborts with no committed deletion or receipt`, async () => {
    const { run, state } = mockTransaction(failure);
    await assert.rejects(run, error);
    assert.deepEqual(state, { deleted: false, receipt: false, writes, rolledBack: true });
  });
}

test("lost commit response stays ambiguous and never retries or rolls back a possible commit", async () => {
  const { run, state } = mockTransaction("ambiguous");
  await assert.rejects(run, CommitOutcomeUnknown);
  assert.deepEqual(state, { deleted: true, receipt: true, writes: 1, rolledBack: false });
});


test("successful GitHub run requires the original connector publication, budget-failed batch and stopped summary", () => {
  // Reconstruct the recorded incident pattern using the historical Phase B log fields.
  const incident = {
    version: 1, day_utc: "2026-11-14", connector_id: 1, row_count: 22543, pollutant_count: 37,
    publication_cutoff: "2026-11-19T03:24:31.000Z", original_run_id: "452723ab-4504-40a0-bd0d-239107d7285f",
    manifest_key: connectorManifestKey("2026-11-14", 1),
    manifest_hash: "1ca74766cb6b48f369386af2aa09f93c220bd56b2fc45e72ebeded1fcf927848",
    source_content_hash: "02193a5f12e8d3b3832401d3acc08b3814ecf0b1046438e5cbc33d168b1fbd78",
    workflow_url: "https://github.com/UK-AQ/uk-aq-ops/actions/runs/44444834653",
    writer_git_sha: targetWriterGitSha,
  };
  const workflow = Buffer.from(JSON.stringify({
    url: incident.workflow_url, databaseId: 44444834653, status: "completed", conclusion: "success",
    headSha: targetWriterGitSha, workflowName: "UK AQ Prune Daily", jobs: [{ status: "completed" }],
    startedAt: "2026-11-19T02:30:00Z", updatedAt: "2026-11-19T03:25:00Z",
  }));
  const publication = {
    event: "phase_b_history_connector_publication_complete", timestamp: "2026-11-19T03:24:31.253Z",
    day_utc: incident.day_utc, connector_id: incident.connector_id, expected_row_count: "22543", written_row_count: "22543",
    source_identity_rows: 22543, source_identity_contract_version: 1, source_identity_match: true,
    source_content_hash: incident.source_content_hash, source_owner: "phase_b_export", manifest_key: incident.manifest_key,
    connector_gate_complete: false, awaiting_run_finalization: true,
  };
  const batch = {
    event: "phase_b_history_v3_run_finalization_batch_start", timestamp: "2026-11-19T03:24:32.000Z",
    affected_days_utc: [incident.day_utc], connector_publication_count: 1,
    finalization_batch_trigger: "utc_day_boundary",
  };
  const failure = {
    event: "phase_b_history_v3_run_finalization_failed", timestamp: "2026-11-19T03:24:33.000Z",
    stopped_for_budget: true, connector_gate_completed_count: 0, connector_publication_count: 1,
    finalization_batch_trigger: batch.finalization_batch_trigger,
  };
  const summary = {
    event: "phase_b_history_run_summary", timestamp: "2026-11-19T03:24:34.000Z",
    status: "stopped_budget", stopped_for_budget: true, dry_run: false,
    blocked_preview: [{ day_utc: incident.day_utc, history_done: false, reason: "phase_b_history_budget_exhausted" }],
  };
  const validate = (...events) => {
    const log = Buffer.from(events.map((event) =>
      `Prune\tRun worker\t${event.timestamp} ${JSON.stringify({ run_id: incident.original_run_id, ...event })}`).join("\n"));
    validateBaseline({ ...incident, workflow_record_sha256: sha256Hex(workflow), workflow_log_sha256: sha256Hex(log) }, workflow, log);
  };
  assert.doesNotThrow(() => validate(publication, batch, failure, summary));
  assert.throws(() => validate(publication, batch, {
    ...failure, event: "phase_b_history_v3_run_finalization_complete", connector_gate_completed_count: 1,
  }, { ...summary, status: "completed", stopped_for_budget: false }), /finalization batch/);
  assert.throws(() => validate(publication, batch, { ...failure, run_id: baseline.original_run_id }, summary), /finalization batch/);
  assert.throws(() => validate(publication, { ...batch, affected_days_utc: [dayUtc] }, failure, summary), /finalization batch/);
  assert.throws(() => validate(publication, batch, { ...failure, connector_gate_completed_count: 1 }, summary), /finalization batch/);
  assert.throws(() => validate(publication, batch, failure), /Phase B summary/);
  assert.throws(() => validate(publication, batch, failure, { ...summary, status: "completed" }), /Phase B summary/);
  assert.throws(() => validate(publication, batch, failure, {
    event: "phase_b_history_candidate_complete", timestamp: failure.timestamp,
    day_utc: incident.day_utc, connector_id: incident.connector_id,
  }, summary), /contradictory/);
});

test("approval binds the plan digest, execution ID, window and all-connector impact", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reconciliation-approval-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = join(directory, "operator.pem");
  const file = join(directory, "approval.json");
  const signature = join(directory, "approval.sig");
  writeFileSync(key, publicKey.export({ type: "spki", format: "pem" }));
  const plan = { operation_id: "31b20b8a-6972-43cb-8599-d60b12d3c673",
    operator_key_sha256: sha256Hex(publicKey.export({ type: "spki", format: "der" })),
    created_at: cutoff, expires_at: "2026-10-24T04:22:00.000Z" };
  const planSha = "a".repeat(64);
  const approval = { version: 1, plan_sha256: planSha, operation_id: plan.operation_id, reference: "Operator approval",
    window_start: cutoff, window_end: plan.expires_at, transaction_ms: 120000, lock_ms: 5000,
    accepted_row_incarnation_limitation: LIMITATION, accepted_cross_connector_impact: IMPACT };
  const signApproval = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(file, bytes);
    writeFileSync(signature, sign(null, bytes, privateKey));
  };
  signApproval(approval);
  assert.deepEqual(readApproval(file, signature, key, plan, planSha), approval);
  assert.throws(() => readApproval(file, signature, key, plan, "b".repeat(64)), /exact plan/);
  signApproval({ ...approval, accepted_cross_connector_impact: "connector only" });
  assert.throws(() => readApproval(file, signature, key, plan, planSha), /risk and window/);
  signApproval({ ...approval, transaction_ms: 120001 });
  assert.throws(() => readApproval(file, signature, key, plan, planSha), /risk and window/);
});

test("selected v3 read checks all actual Parquet, status and index dependencies", async () => {
  const objects = new Map();
  const put = (artifact) => objects.set(artifact.key, Buffer.from(artifact.body));
  const partitions = [...Map.groupBy(canonical, (row) => row.pollutant_code).values()].map((rows) =>
    buildObservationHistoryV3SteadyStatePartition({
      source: "prune_daily", targetWriterGitSha, backedUpAtUtc: cutoff,
      rows: rows.map((row) => ({ ...row, observed_at_utc: row.observed_at_utc.toISOString() })),
    }));
  for (const partition of partitions) {
    for (const artifact of [...partition.file_intents, ...partition.v3_hierarchy.publication_objects,
      partition.canonical_pollutant_manifest]) put(artifact);
  }
  put(buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: partitions.map((p) => p.v3_hierarchy) }));
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc, connectorId, manifestKey: baseline.manifest_key,
    pollutantManifests: partitions.map((p) => p.canonical_pollutant_manifest.payload),
    writerGitSha: targetWriterGitSha, backedUpAtUtc: cutoff,
  });
  const day = buildHistoryV2DayManifest({
    domain: "observations", dayUtc, manifestKey: buildHistoryV2DayManifestKey(prefix, dayUtc),
    connectorManifests: [connector], writerGitSha: targetWriterGitSha, backedUpAtUtc: cutoff,
  });
  for (const value of [connector, day]) objects.set(value.manifest_key, Buffer.from(JSON.stringify(value)));
  const month = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: prefix, year: 2026, month: "10", dayManifests: [day] });
  const year = buildR2HistoryV2ObservationsYearManifest({ basePrefix: prefix, year: 2026, monthManifests: [month] });
  const root = buildR2HistoryV2ObservationsRootManifest({ basePrefix: prefix, yearManifests: [year] });
  for (const [key, manifest] of [
    [buildR2HistoryV2ObservationsMonthManifestKey(prefix, 2026, "10"), month],
    [buildR2HistoryV2ObservationsYearManifestKey(prefix, 2026), year],
    [buildR2HistoryV2ObservationsRootManifestKey(prefix), root],
  ]) objects.set(key, serializeR2HistoryV2ObservationsAggregateManifest(manifest, { basePrefix: prefix }));
  const options = {
    r2: {}, baseline: { ...baseline, manifest_hash: connector.manifest_hash },
    lock: { assertHeld() {}, assertOwned() {} },
    getObject: async ({ key }) => {
      if (!objects.has(key)) throw new Error(`Object missing: ${key}`);
      return { body: objects.get(key) };
    },
  };
  const result = await readSelectedHistory(options);
  assert.deepEqual(result.encoded, encodeMultiset(canonical));
  const key = partitions[0].file_intents[0].key;
  const damaged = Buffer.from(objects.get(key));
  damaged[31] ^= 0xff;
  objects.set(key, damaged);
  await assert.rejects(readSelectedHistory(options), /Parquet identity disagrees/);
});
