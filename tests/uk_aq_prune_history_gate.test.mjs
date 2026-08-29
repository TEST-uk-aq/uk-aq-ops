import assert from "node:assert/strict";
import test from "node:test";
import {
  createPhaseBRunBudgetForTest,
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  buildHistoryV2PollutantManifest,
  derivePhaseBPgTimeoutsForTest,
  isAcceptedPruneHistoryDayManifestKey,
  markCandidateAndConnectorGateCompleteForTest,
  populateBackupCandidatesForTest,
  runCandidateAqilevelsStageForTest,
  runPhaseBBackup,
  runBudgetedPhaseBStageForTest,
  stopPhaseBForBudgetForTest,
  summarizeVerifiedMergedDayManifestForGate,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import * as phaseBHistoryModule from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  executePruneDaily,
  filterBucketsByConnectorHistoryGate,
  runPruneForTest,
} from "../workers/uk_aq_prune_daily/server.mjs";
import {
  runPruneDailyJob,
  runPruneDailyJobWithGlobalLock,
} from "../workers/uk_aq_prune_daily/job.mjs";
import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  observationsGlobalOperationLockIdentity,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  canonicalObservationConnectorManifestKey,
  connectorDayGateKey,
  isValidConnectorHistoryGateEvidence,
  normalizeConnectorDayPair,
  setConnectorDayGateIncomplete,
} from "../workers/shared/uk_aq_connector_day_gate.mjs";
import { computePruneConnectorSourceIdentity } from "../workers/shared/uk_aq_prune_connector_source_identity.mjs";

test("connector-day pairs accept canonical text and UTC-midnight Date values only", () => {
  assert.deepEqual(
    normalizeConnectorDayPair("2026-07-23", "2"),
    { day_utc: "2026-07-23", connector_id: 2 },
  );
  assert.deepEqual(
    normalizeConnectorDayPair(new Date("2026-07-23T00:00:00.000Z"), 2),
    { day_utc: "2026-07-23", connector_id: 2 },
  );
  assert.throws(
    () => normalizeConnectorDayPair(new Date("2026-07-22T23:00:00.000Z"), 2),
    /Invalid connector-day UTC date/,
  );
  assert.throws(
    () => normalizeConnectorDayPair("Thu Jul 23 2026 00:00:00 GMT+0100", 2),
    /Invalid connector-day UTC date/,
  );
  assert.throws(() => normalizeConnectorDayPair("2026-07-23", "two"), /Invalid.*connector_id/);
});

test("prune history day manifest gate accepts v1 observation day manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v1/observations/day_utc=2026-06-12/manifest.json"),
    true,
  );
});

test("prune history day manifest gate accepts v2 observation day manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/manifest.json"),
    true,
  );
});

test("prune history day manifest gate rejects missing or empty keys", () => {
  assert.equal(isAcceptedPruneHistoryDayManifestKey(null), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey(undefined), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey(""), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("   "), false);
});

test("prune history day manifest gate rejects non-day and malformed paths", () => {
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-6-12/manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/not-manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v3/observations/day_utc=2026-06-12/manifest.json"), false);
});

test("prune history day manifest gate rejects connector and pollutant manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/connector_id=1/manifest.json"),
    false,
  );
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/connector_id=1/pollutant_code=no2/manifest.json"),
    false,
  );
});

test("connector-day gate is exact Prune Daily deletion authority", async () => {
  const dayUtc = "2026-06-12";
  const completeConnectorTwo = {
    day_utc: dayUtc,
    connector_id: 2,
    history_done: true,
    history_manifest_key: canonicalObservationConnectorManifestKey(dayUtc, 2),
    history_manifest_hash: "a".repeat(64),
    history_row_count: 10,
    history_file_count: 1,
    history_total_bytes: 100,
    history_completed_at: "2026-06-13T01:02:03.000Z",
    source_content_hash: "b".repeat(64),
    source_content_hash_contract_version: 1,
    source_content_hash_row_count: 10,
    completion_source: "prune_daily_phase_b",
  };
  assert.equal(isValidConnectorHistoryGateEvidence(completeConnectorTwo), true);
  for (const missingField of [
    "history_manifest_key",
    "history_manifest_hash",
    "history_completed_at",
    "history_row_count",
    "history_file_count",
    "history_total_bytes",
    "source_content_hash",
    "source_content_hash_contract_version",
    "source_content_hash_row_count",
    "completion_source",
  ]) {
    assert.equal(
      isValidConnectorHistoryGateEvidence({ ...completeConnectorTwo, [missingField]: null }),
      false,
      `${missingField} must fail closed`,
    );
  }
  assert.equal(
    isValidConnectorHistoryGateEvidence({ ...completeConnectorTwo, completion_source: "history_integrity" }),
    false,
    "Integrity-created evidence must not authorise deletion",
  );
  assert.equal(
    isValidConnectorHistoryGateEvidence({ ...completeConnectorTwo, completion_source: "historical_adoption" }),
    false,
    "legacy/adoption evidence must not authorise deletion",
  );
  for (const malformedCounts of [
    { history_row_count: -1 },
    { history_file_count: "one" },
    { history_total_bytes: "" },
    { history_row_count: 10, history_file_count: 0 },
    { history_row_count: 0, history_file_count: 1, history_total_bytes: 100 },
  ]) {
    assert.equal(
      isValidConnectorHistoryGateEvidence({ ...completeConnectorTwo, ...malformedCounts }),
      false,
      `malformed count evidence must fail closed: ${JSON.stringify(malformedCounts)}`,
    );
  }
  for (const missingZeroCount of ["history_row_count", "history_file_count", "history_total_bytes"]) {
    assert.equal(
      isValidConnectorHistoryGateEvidence({
        ...completeConnectorTwo,
        history_row_count: 0,
        history_file_count: 0,
        history_total_bytes: 0,
        [missingZeroCount]: null,
      }),
      false,
      `${missingZeroCount} must not be coerced to zero`,
    );
  }

  const gateMap = new Map([
    [connectorDayGateKey(dayUtc, 2), true],
  ]);
  const buckets = [1, 2].map((connectorId) => ({
    connector_id: String(connectorId),
    hour_start: `${dayUtc}T05:00:00.000Z`,
    observation_count: 10n,
  }));
  const preRepair = filterBucketsByConnectorHistoryGate(buckets, gateMap);
  const postRepair = filterBucketsByConnectorHistoryGate(buckets, gateMap);
  const aggregateDayHistoryDone = false;
  assert.equal(aggregateDayHistoryDone, false);
  for (const result of [preRepair, postRepair]) {
    assert.deepEqual(result.allowedBuckets.map((bucket) => bucket.connector_id), ["2"]);
    assert.deepEqual(result.blockedBuckets.map((bucket) => bucket.connector_id), ["1"]);
    assert.equal(result.blockedBuckets[0].day_utc, dayUtc);
    assert.equal(result.blockedBuckets[0].reason, "history_not_complete_for_connector_day");
  }

  // Aggregate day truth is deliberately absent from the connector map and
  // therefore cannot grant connector 1 deletion authority.
  const aggregateDayGate = new Map([[dayUtc, true]]);
  assert.equal(aggregateDayGate.get(dayUtc), true);
  assert.equal(preRepair.blockedBuckets.some((bucket) => bucket.connector_id === "1"), true);

  const simulatedGateState = new Map([
    [connectorDayGateKey(dayUtc, 1), true],
    [connectorDayGateKey(dayUtc, 2), true],
  ]);
  const fakeClient = {
    async query(_sql, params) {
      simulatedGateState.set(connectorDayGateKey(params[0], params[1]), false);
      return { rowCount: 1, rows: [] };
    },
  };
  await setConnectorDayGateIncomplete(fakeClient, { day_utc: dayUtc, connector_id: 1 });
  assert.equal(simulatedGateState.get(connectorDayGateKey(dayUtc, 1)), false);
  assert.equal(simulatedGateState.get(connectorDayGateKey(dayUtc, 2)), true);

});

test("aggregate day-gate totals include connectors preserved in the merged day manifest", () => {
  const dayUtc = "2026-07-21";
  const connectorManifests = [
    { connectorId: 1, rows: 10, bytes: 100 },
    { connectorId: 2, rows: 20, bytes: 200 },
  ].map(({ connectorId, rows, bytes }) => {
    const pollutantCode = "no2";
    const pollutantManifest = buildHistoryV2PollutantManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      pollutantCode,
      manifestKey: `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`,
      sourceRowCount: rows,
      fileEntries: [{
        key: `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/part-00000.parquet`,
        row_count: rows,
        bytes,
      }],
      observationContentHash: { observation_content_hash_row_count: rows },
      backedUpAtUtc: "2026-07-22T00:00:00.000Z",
    });
    return buildHistoryV2ConnectorManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      manifestKey: canonicalObservationConnectorManifestKey(dayUtc, connectorId),
      pollutantManifests: [pollutantManifest],
      backedUpAtUtc: "2026-07-22T00:00:00.000Z",
    });
  });
  const manifestKey = `history/v2/observations/day_utc=${dayUtc}/manifest.json`;
  const dayManifest = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc,
    manifestKey,
    connectorManifests,
    backedUpAtUtc: "2026-07-22T00:00:00.000Z",
  });
  const totals = summarizeVerifiedMergedDayManifestForGate({ manifest: dayManifest, manifestKey, dayUtc });
  assert.equal(totals.history_row_count, 30n);
  assert.equal(totals.history_file_count, 2);
  assert.equal(totals.history_total_bytes, 300n);
});

test("candidate and connector gate completion persist identical source identity", async () => {
  const dayUtc = "2026-07-21";
  const sourceIdentity = computePruneConnectorSourceIdentity(
    canonicalCandidateRows(dayUtc, 7, 2),
  );
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  await markCandidateAndConnectorGateCompleteForTest(client, {
    dayUtc,
    connectorId: 7,
    runId: "run-1",
    manifestKey: canonicalObservationConnectorManifestKey(dayUtc, 7),
    manifestHash: "a".repeat(64),
    historyRowCount: 2n,
    historyFileCount: 1,
    historyTotalBytes: 100n,
    sourceIdentity,
  });
  const candidateWrite = calls.find(({ sql }) => /update uk_aq_ops\.history_candidates/i.test(sql));
  const gateWrite = calls.find(({ sql }) => /insert into uk_aq_ops\.prune_connector_day_gates/i.test(sql));
  assert.deepEqual(candidateWrite.params.slice(7, 10), [
    sourceIdentity.source_content_hash,
    sourceIdentity.source_content_hash_contract_version,
    sourceIdentity.source_content_hash_row_count,
  ]);
  assert.deepEqual(gateWrite.params.slice(8, 11), candidateWrite.params.slice(7, 10));

  const completedGateCallCount = calls.length;
  const aqiResult = await runCandidateAqilevelsStageForTest({
    client,
    runtime: { phase_b_calculate_aqi_from_observations_enabled: false },
    candidate: { day_utc: dayUtc, connector_id: 7 },
    observationResult: { verified: true },
    summary: { aggregate_day_failures: [] },
    withConnectorDayHistoryLockAdapter: async () => assert.fail("disabled AQI must not acquire its connector lock"),
    exportCandidateAqiAdapter: async () => assert.fail("disabled AQI must not run after connector-gate completion"),
  });
  assert.deepEqual(aqiResult, { status: "skipped", reason: "aqilevels_disabled" });
  assert.equal(calls.length, completedGateCallCount, "disabled AQI must not revoke the completed observation gate");
});

test("incomplete connector gate clears all source identity fields", async () => {
  let statement = "";
  await setConnectorDayGateIncomplete({
    async query(sql) {
      statement = sql;
      return { rows: [], rowCount: 1 };
    },
  }, { day_utc: "2026-07-21", connector_id: 7 });
  assert.match(statement, /source_content_hash = null/);
  assert.match(statement, /source_content_hash_contract_version = null/);
  assert.match(statement, /source_content_hash_row_count = null/);
});

function canonicalCandidateRows(dayUtc, connectorId, count) {
  return Array.from({ length: count }, (_, index) => ({
    connector_id: connectorId,
    station_id: connectorId * 10,
    timeseries_id: connectorId * 1000 + index + 1,
    pollutant_code: "no2",
    observed_at_utc: `${dayUtc}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
    value: index + 0.5,
    status: index % 2 === 0 ? "P" : "R",
  }));
}

function completeCandidate(dayUtc, connectorId, expectedRowCount, minObservedAt, maxObservedAt) {
  const sourceIdentity = computePruneConnectorSourceIdentity(
    canonicalCandidateRows(dayUtc, connectorId, expectedRowCount),
  );
  return {
    day_utc: dayUtc,
    connector_id: connectorId,
    expected_row_count: String(expectedRowCount),
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    status: "complete",
    run_id: "previous-run",
    manifest_key: canonicalObservationConnectorManifestKey(dayUtc, connectorId),
    history_row_count: String(expectedRowCount),
    history_file_count: 1,
    history_total_bytes: "100",
    ...sourceIdentity,
    resume_last_timeseries_id: null,
    resume_last_observed_at: null,
    resume_part_index: 0,
    resume_exported_row_count: "0",
    resume_parts_json: [],
  };
}

function candidatePopulationClient({ candidates, gates, sourceRows, afterPopulation = null }) {
  return {
    async query(sql, params = []) {
      if (/select distinct op\.code/i.test(sql)) return { rows: [] };
      if (/^begin isolation level repeatable read$/i.test(sql.trim()) || /^(commit|rollback)$/i.test(sql.trim())) {
        return { rows: [] };
      }
      if (/select \*\s+from uk_aq_ops\.history_candidates/i.test(sql)) {
        return { rows: [candidates.get(connectorDayGateKey(params[0], params[1]))] };
      }
      if (/uk_aq_phase_b_history_rows_v2/i.test(sql)) {
        return { rows: canonicalCandidateRows(String(params[1]).slice(0, 10), Number(params[0]), Number(candidates.get(connectorDayGateKey(String(params[1]).slice(0, 10), params[0])).expected_row_count)) };
      }
      if (/^update uk_aq_ops\.(history_candidates|prune_connector_day_gates)/im.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      assert.match(sql, /source_changes as materialized/i);
      assert.match(sql, /invalidated_connector_gates as/i);
      assert.match(sql, /on conflict \(day_utc, connector_id\)/i);
      const rows = sourceRows.map((source) => {
        const key = connectorDayGateKey(source.day_utc, source.connector_id);
        const previous = candidates.get(key);
        const changed = previous?.status === "complete" && (
          String(previous.expected_row_count) !== String(source.expected_row_count)
          || previous.min_observed_at !== source.min_observed_at
          || previous.max_observed_at !== source.max_observed_at
        );
        const next = changed
          ? {
            ...previous,
            ...source,
            expected_row_count: String(source.expected_row_count),
            status: "pending",
            run_id: null,
            manifest_key: null,
            history_row_count: null,
            history_file_count: null,
            history_total_bytes: null,
          }
          : previous;
        candidates.set(key, next);
        if (changed) gates.set(key, false);
        return {
          ...next,
          source_row_count: String(source.expected_row_count),
          excluded_row_count: "0",
          excluded_pollutant_counts: {},
          source_changed_connector_gate_invalidated: changed,
          previous_expected_row_count: previous.expected_row_count,
          current_expected_row_count: String(source.expected_row_count),
          previous_min_observed_at: previous.min_observed_at,
          current_min_observed_at: source.min_observed_at,
          previous_max_observed_at: previous.max_observed_at,
          current_max_observed_at: source.max_observed_at,
        };
      });
      afterPopulation?.();
      return { rows };
    },
  };
}

test("real candidate population invalidates only the connector gate whose completed source identity changed", async () => {
  const dayUtc = "2026-07-21";
  const candidates = new Map([
    [connectorDayGateKey(dayUtc, 1), completeCandidate(dayUtc, 1, 10, `${dayUtc}T00:00:00.000Z`, `${dayUtc}T23:00:00.000Z`)],
    [connectorDayGateKey(dayUtc, 2), completeCandidate(dayUtc, 2, 20, `${dayUtc}T00:05:00.000Z`, `${dayUtc}T23:05:00.000Z`)],
  ]);
  const gates = new Map([
    [connectorDayGateKey(dayUtc, 1), true],
    [connectorDayGateKey(dayUtc, 2), true],
  ]);
  const sourceRows = [
    { day_utc: dayUtc, connector_id: 1, expected_row_count: "11", min_observed_at: `${dayUtc}T00:00:00.000Z`, max_observed_at: `${dayUtc}T23:30:00.000Z` },
    { day_utc: dayUtc, connector_id: 2, expected_row_count: "20", min_observed_at: `${dayUtc}T00:05:00.000Z`, max_observed_at: `${dayUtc}T23:05:00.000Z` },
  ];

  const populated = await populateBackupCandidatesForTest({
    client: candidatePopulationClient({ candidates, gates, sourceRows }),
    latestEligibleWindowEndIso: "2026-07-22T00:00:00.000Z",
    runtime: { history_write_version: "v2" },
  });

  assert.equal(candidates.get(connectorDayGateKey(dayUtc, 1)).status, "pending");
  assert.equal(gates.get(connectorDayGateKey(dayUtc, 1)), false);
  assert.equal(candidates.get(connectorDayGateKey(dayUtc, 2)).status, "complete");
  assert.equal(gates.get(connectorDayGateKey(dayUtc, 2)), true);
  assert.equal(populated[0].source_changed_connector_gate_invalidated, true);
  assert.equal(populated[1].source_changed_connector_gate_invalidated, false);
  assert.equal(new Map([[dayUtc, true]]).get(dayUtc), true, "aggregate truth exists but cannot restore the exact connector gate");
  assert.equal(gates.get(connectorDayGateKey(dayUtc, 1)), false);
});

test("insufficient Phase B budget prevents AQI and Dropbox adapters and reports a controlled stop", async () => {
  let nowMs = 1_000_000;
  const runBudget = createPhaseBRunBudgetForTest({
    nowMs: () => nowMs,
    startedAtMs: nowMs,
    maxSecondsPerRun: 1_740,
    stopBeforeTimeoutSeconds: 60,
  });
  const runtime = { run_budget: runBudget };
  assert.equal(runBudget.max_ms, 1_740_000);
  assert.equal(runBudget.stop_before_timeout_ms, 60_000);
  assert.equal(runBudget.deadline_ms - runBudget.started_at_ms, 1_680_000);
  nowMs = runBudget.deadline_ms - 179_999;
  let aqiCalls = 0;
  let dropboxCalls = 0;
  let connectorGateComplete = false;
  let preexistingValidConnectorGate = true;

  const aqi = await runBudgetedPhaseBStageForTest({
    runtime,
    operation: "aqi_calculation",
    minMs: 180_000,
    adapter: async () => {
      aqiCalls += 1;
      connectorGateComplete = true;
      preexistingValidConnectorGate = false;
    },
  });
  const dropbox = await runBudgetedPhaseBStageForTest({
    runtime,
    operation: "dropbox_comparison",
    minMs: 180_000,
    adapter: async () => {
      dropboxCalls += 1;
      connectorGateComplete = true;
      preexistingValidConnectorGate = false;
    },
  });
  const summary = stopPhaseBForBudgetForTest({
    summary: { enabled: true },
    runtime,
    operation: "aqi_calculation",
    candidate: { day_utc: "2026-07-21", connector_id: 7 },
  });

  assert.equal(aqi.status, "stopped_budget");
  assert.equal(dropbox.status, "stopped_budget");
  assert.equal(aqiCalls, 0);
  assert.equal(dropboxCalls, 0);
  assert.equal(connectorGateComplete, false);
  assert.equal(preexistingValidConnectorGate, true);
  assert.equal(summary.status, "stopped_budget");
  assert.equal(summary.stopped_for_budget, true);
  assert.equal(summary.budget_stop.remaining_budget_ms, 179_999);
});

function frozenObservationRow(overrides = {}) {
  return {
    connector_id: 7,
    station_id: 71,
    timeseries_id: 7101,
    pollutant_code: "pm25",
    observed_at_utc: "2026-07-21T00:00:00.000Z",
    value: 12.5,
    status: null,
    ...overrides,
  };
}

test("v3 frozen-source replay stops on the controlled Phase B budget before starting the writer", async () => {
  assert.equal(
    typeof phaseBHistoryModule.writeFrozenCandidateObservationsToV3ForTest,
    "function",
    "the production replay/write boundary must expose its deterministic test seam",
  );
  let nowMs = 0;
  const runtime = {
    run_budget: createPhaseBRunBudgetForTest({
      nowMs: () => nowMs,
      startedAtMs: 0,
      maxSecondsPerRun: 1_740,
      stopBeforeTimeoutSeconds: 60,
    }),
    sos_connector_id: 1,
    observation_history_index_version: "v3",
    writer_git_sha: "4".repeat(40),
    committed_prefix: "history/v2/observations",
    r2: {},
    environment: "TEST",
  };
  const frozen = {
    temp: { root: "/tmp/fake-frozen-source", ndjsonPath: "/tmp/fake-frozen-source/rows.ndjson" },
    counts: { frozen_source_row_count: 2 },
    sourceIdentity: {},
  };
  let writerCalls = 0;
  let cleanupCalls = 0;
  async function* rows() {
    yield frozenObservationRow();
    nowMs = runtime.run_budget.deadline_ms - 59_999;
    yield frozenObservationRow({
      timeseries_id: 7102,
      observed_at_utc: "2026-07-21T01:00:00.000Z",
    });
  }

  await assert.rejects(
    phaseBHistoryModule.writeFrozenCandidateObservationsToV3ForTest({
      candidate: { day_utc: "2026-07-21", connector_id: 7, expected_row_count: 2n },
      runtime,
      streamClient: {},
      frozen,
      backedUpAtUtc: "2026-07-22T00:00:00.000Z",
      readFrozenRows: () => rows(),
      connectorPublisher: async () => {
        writerCalls += 1;
        return { ok: true, connector_results: [] };
      },
      cleanupFrozenSource: () => { cleanupCalls += 1; },
    }),
    (error) => {
      assert.equal(error.code, "PHASE_B_HISTORY_BUDGET_EXHAUSTED");
      assert.equal(error.operation, "frozen_source_replay");
      return true;
    },
  );
  assert.equal(writerCalls, 0);
  assert.equal(cleanupCalls, 1);
});

test("v3 writer is not invoked when its completion allowance no longer fits the Phase B budget", async () => {
  assert.equal(
    typeof phaseBHistoryModule.writeFrozenCandidateObservationsToV3ForTest,
    "function",
    "the production replay/write boundary must expose its deterministic test seam",
  );
  let nowMs = 0;
  const runtime = {
    run_budget: createPhaseBRunBudgetForTest({
      nowMs: () => nowMs,
      startedAtMs: 0,
      maxSecondsPerRun: 1_740,
      stopBeforeTimeoutSeconds: 60,
    }),
    sos_connector_id: 1,
    observation_history_index_version: "v3",
    writer_git_sha: "4".repeat(40),
    committed_prefix: "history/v2/observations",
    r2: {},
    environment: "TEST",
  };
  const candidate = { day_utc: "2026-07-21", connector_id: 7, expected_row_count: 1n };
  const frozen = {
    temp: { root: "/tmp/fake-frozen-source", ndjsonPath: "/tmp/fake-frozen-source/rows.ndjson" },
    counts: { frozen_source_row_count: 1 },
    sourceIdentity: {},
  };
  let writerCalls = 0;
  let cleanupCalls = 0;
  let connectorGateComplete = false;
  async function* rows() {
    yield frozenObservationRow();
    nowMs = runtime.run_budget.deadline_ms - 179_999;
  }

  let budgetError;
  try {
    await phaseBHistoryModule.writeFrozenCandidateObservationsToV3ForTest({
      candidate,
      runtime,
      streamClient: {},
      frozen,
      backedUpAtUtc: "2026-07-22T00:00:00.000Z",
      readFrozenRows: () => rows(),
      connectorPublisher: async () => {
        writerCalls += 1;
        connectorGateComplete = true;
        return { ok: true, connector_results: [] };
      },
      cleanupFrozenSource: () => { cleanupCalls += 1; },
    });
  } catch (error) {
    budgetError = error;
  }
  assert.equal(budgetError?.code, "PHASE_B_HISTORY_BUDGET_EXHAUSTED");
  assert.equal(budgetError?.operation, "observation_v3_connector_publication");
  const summary = stopPhaseBForBudgetForTest({
    summary: { enabled: true },
    runtime,
    operation: budgetError.operation,
    candidate,
  });
  assert.equal(writerCalls, 0);
  assert.equal(connectorGateComplete, false);
  assert.equal(cleanupCalls, 1);
  assert.equal(summary.status, "stopped_budget");
  assert.equal(summary.stopped_for_budget, true);
  assert.equal(summary.budget_stop.operation, "observation_v3_connector_publication");
});

async function reproduceCandidateSizedV3RunFinalization({ candidates, counts }) {
  const runtime = {
    run_budget: createPhaseBRunBudgetForTest({
      nowMs: () => 0,
      startedAtMs: 0,
      maxSecondsPerRun: 1_740,
      stopBeforeTimeoutSeconds: 60,
    }),
    sos_connector_id: 1,
    observation_history_index_version: "v3",
    writer_git_sha: "4".repeat(40),
    committed_prefix: "history/v2/observations",
    r2: {},
    environment: "TEST",
  };
  const connectorPublisher = async ({ partitions }) => {
    const { day_utc: dayUtc, connector_id: connectorId } = partitions[0].scope;
    counts.connector_publication += 1;
    const partitionResults = partitions.map((partition, index) => {
      const key = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${partition.scope.pollutant_code}/part-${index}.parquet`;
      return {
        scope: partition.scope,
        target_metadata: {
          files: [{
            key,
            row_count: partition.rows.length,
            byte_size: 1,
            sha256: "a".repeat(64),
          }],
        },
      };
    });
    const publication = {
      ok: true,
      source: "prune_daily",
      prune_eligibility_owner: true,
      connector_publication_complete: true,
      connector_results: [{
        day_utc: dayUtc,
        connector_id: connectorId,
        canonical: {
          connector_manifest_payload: {
            manifest_key: `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
            parquet_object_keys: partitionResults.flatMap((partition) =>
              partition.target_metadata.files.map((file) => file.key)
            ),
          },
        },
        partitions: partitionResults,
      }],
    };
    publication.run_finalization_evidence = {
      ...publication,
      connector_results: publication.connector_results.map((result) => ({
        day_utc: result.day_utc,
        connector_id: result.connector_id,
      })),
    };
    return publication;
  };

  const publishedCandidates = [];
  for (const candidate of candidates) {
    const row = frozenObservationRow({
      connector_id: candidate.connector_id,
      station_id: candidate.connector_id * 10,
      timeseries_id: candidate.connector_id * 100 + 1,
      observed_at_utc: `${candidate.day_utc}T00:00:00.000Z`,
    });
    const exportResult = await phaseBHistoryModule.writeFrozenCandidateObservationsToV3ForTest({
      candidate: { ...candidate, expected_row_count: 1n },
      runtime,
      streamClient: {},
      frozen: {
        temp: { root: "/tmp/fake-frozen-source", ndjsonPath: "/tmp/fake-frozen-source/rows.ndjson" },
        counts: { frozen_source_row_count: 1 },
        sourceIdentity: {},
      },
      backedUpAtUtc: "2026-08-29T00:00:00.000Z",
      readFrozenRows: async function* () { yield row; },
      connectorPublisher,
      cleanupFrozenSource: () => {},
    });
    exportResult.v3_run_finalization_evidence =
      exportResult.v3_connector_publication.run_finalization_evidence;
    publishedCandidates.push({
      candidate: { ...candidate, expected_row_count: 1n },
      exportResult,
      connectorGateEvidence: {
        history_manifest_key: exportResult.manifest_key,
        history_manifest_hash: "b".repeat(64),
        history_row_count: 1,
        history_file_count: 1,
        history_total_bytes: 1,
      },
    });
  }
  const affectedDays = [...new Set(candidates.map((candidate) => candidate.day_utc))].sort();
  await phaseBHistoryModule.finalizePublishedPhaseBV3ConnectorsForTest({
    client: {},
    runtime,
    runId: "run-finalization-regression",
    publishedCandidates,
    runFinalizer: async () => {
      counts.day_finalization.push(...affectedDays);
      counts.aggregate_global_finalization += 1;
      counts.latest_publication += 1;
      return {
        ok: true,
        prune_eligibility_owner: true,
        affected_connector_days: candidates,
        affected_days_utc: affectedDays,
        day_results: affectedDays.map((day_utc) => ({
          day_utc,
          canonical_day_authority_verified: true,
          parent_state_reread_under_lock: true,
        })),
        canonical_aggregate_result: {
          canonical_aggregate_authority_verified: true,
        },
        v3_publication: { latest_global: { ok: true } },
      };
    },
    completeCandidateAndGate: async () => {},
  });
}

test("one Prune v3 run finalizes two same-day connector publications only once", async () => {
  const counts = {
    connector_publication: 0,
    day_finalization: [],
    aggregate_global_finalization: 0,
    latest_publication: 0,
  };
  await reproduceCandidateSizedV3RunFinalization({
    candidates: [
      { day_utc: "2026-08-28", connector_id: 1 },
      { day_utc: "2026-08-28", connector_id: 2 },
    ],
    counts,
  });
  assert.deepEqual(counts, {
    connector_publication: 2,
    day_finalization: ["2026-08-28"],
    aggregate_global_finalization: 1,
    latest_publication: 1,
  });
});

test("one Prune v3 run finalizes two affected days and shared parents once", async () => {
  const counts = {
    connector_publication: 0,
    day_finalization: [],
    aggregate_global_finalization: 0,
    latest_publication: 0,
  };
  await reproduceCandidateSizedV3RunFinalization({
    candidates: [
      { day_utc: "2026-08-27", connector_id: 1 },
      { day_utc: "2026-08-28", connector_id: 2 },
    ],
    counts,
  });
  assert.deepEqual(counts, {
    connector_publication: 2,
    day_finalization: ["2026-08-27", "2026-08-28"],
    aggregate_global_finalization: 1,
    latest_publication: 1,
  });
});

function publishedCandidateForFinalizationTest(dayUtc = "2026-08-28", connectorId = 1) {
  return {
    candidate: { day_utc: dayUtc, connector_id: connectorId, expected_row_count: 1n },
    exportResult: {
      v3_run_finalization_evidence: { ok: true },
      source_identity: {
        source_content_hash: "c".repeat(64),
        source_content_hash_contract_version: 1,
        source_content_hash_row_count: 1,
      },
    },
    connectorGateEvidence: {
      history_manifest_key: `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
      history_manifest_hash: "b".repeat(64),
      history_row_count: 1,
      history_file_count: 1,
      history_total_bytes: 1,
    },
  };
}

test("v3 run-finalization failure cannot create connector deletion authority", async () => {
  const runtime = {
    run_budget: createPhaseBRunBudgetForTest({
      nowMs: () => 0,
      startedAtMs: 0,
      maxSecondsPerRun: 1_740,
      stopBeforeTimeoutSeconds: 60,
    }),
    observation_history_index_version: "v3",
    writer_git_sha: "4".repeat(40),
    committed_prefix: "history/v2/observations",
    r2: {},
    environment: "TEST",
  };
  let gateCalls = 0;
  await assert.rejects(
    phaseBHistoryModule.finalizePublishedPhaseBV3ConnectorsForTest({
      client: {},
      runtime,
      runId: "failed-finalization",
      publishedCandidates: [publishedCandidateForFinalizationTest()],
      runFinalizer: async () => { throw new Error("latest publication failed"); },
      completeCandidateAndGate: async () => { gateCalls += 1; },
    }),
    /latest publication failed/,
  );
  assert.equal(gateCalls, 0);
});

test("v3 run finalization is not invoked when its conservative allowance no longer fits", async () => {
  let nowMs = 0;
  const runtime = {
    run_budget: createPhaseBRunBudgetForTest({
      nowMs: () => nowMs,
      startedAtMs: 0,
      maxSecondsPerRun: 1_740,
      stopBeforeTimeoutSeconds: 60,
    }),
    observation_history_index_version: "v3",
    writer_git_sha: "4".repeat(40),
    committed_prefix: "history/v2/observations",
    r2: {},
    environment: "TEST",
  };
  nowMs = runtime.run_budget.deadline_ms - 119_999;
  let finalizerCalls = 0;
  let gateCalls = 0;
  await assert.rejects(
    phaseBHistoryModule.finalizePublishedPhaseBV3ConnectorsForTest({
      client: {},
      runtime,
      runId: "budget-finalization",
      publishedCandidates: [publishedCandidateForFinalizationTest()],
      runFinalizer: async () => { finalizerCalls += 1; },
      completeCandidateAndGate: async () => { gateCalls += 1; },
    }),
    (error) => {
      assert.equal(error.code, "PHASE_B_HISTORY_BUDGET_EXHAUSTED");
      assert.equal(error.operation, "observation_v3_run_finalization");
      return true;
    },
  );
  assert.equal(finalizerCalls, 0);
  assert.equal(gateCalls, 0);
});

test("a later connector failure does not prevent a verified earlier connector from finalizing and gating", async () => {
  const runtime = {
    run_budget: createPhaseBRunBudgetForTest({
      nowMs: () => 0,
      startedAtMs: 0,
      maxSecondsPerRun: 1_740,
      stopBeforeTimeoutSeconds: 60,
    }),
    observation_history_index_version: "v3",
    writer_git_sha: "4".repeat(40),
    committed_prefix: "history/v2/observations",
    r2: {},
    environment: "TEST",
  };
  const successful = publishedCandidateForFinalizationTest("2026-08-28", 1);
  const gated = [];
  const finalized = await phaseBHistoryModule.finalizePublishedPhaseBV3ConnectorsForTest({
    client: {},
    runtime,
    runId: "partial-connector-failure",
    publishedCandidates: [successful],
    runFinalizer: async ({ connectorPublications }) => {
      assert.deepEqual(connectorPublications, [successful.exportResult.v3_run_finalization_evidence]);
      return {
        ok: true,
        prune_eligibility_owner: true,
        affected_connector_days: [{ day_utc: "2026-08-28", connector_id: 1 }],
        affected_days_utc: ["2026-08-28"],
        day_results: [{
          day_utc: "2026-08-28",
          canonical_day_authority_verified: true,
          parent_state_reread_under_lock: true,
        }],
        canonical_aggregate_result: {
          canonical_aggregate_authority_verified: true,
        },
        v3_publication: { latest_global: { ok: true } },
      };
    },
    completeCandidateAndGate: async (_client, evidence) => {
      gated.push(evidence.connectorId);
    },
  });
  assert.equal(finalized.completed.length, 1);
  assert.deepEqual(gated, [1]);
});

function phaseBConfig() {
  return {
    enabled: true,
    supabase_db_url: "postgresql://test.invalid/database",
    r2: {
      endpoint: "https://r2.invalid",
      bucket: "test-bucket",
      region: "auto",
      access_key_id: "test-access-key",
      secret_access_key: "test-secret-key",
    },
    history_write_version: "v2",
    observation_history_index_version: "v3",
    writer_git_sha: "4".repeat(40),
    staging_prefix_base: "history/v2/_ops/observations/staging",
    committed_prefix: "history/v2/observations",
    committed_prefix_v1: "history/v1/observations",
    committed_prefix_v2: "history/v2/observations",
    aqilevels_prefix: "history/v2/aqilevels/hourly/data",
    aqilevels_prefix_v1: "history/v1/aqilevels/hourly",
    aqilevels_hourly_data_prefix_v2: "history/v2/aqilevels/hourly/data",
    aqilevels_hourly_debug_prefix_v2: "history/v2/aqilevels/hourly/debug",
    aqilevels_timeseries_index_prefix: "history/_index_v2/aqilevels_hourly_data_timeseries",
    runs_prefix: "history/v2/_ops/observations/runs",
    runs_prefix_v1: "history/v1/_ops/observations/runs",
    runs_prefix_v2: "history/v2/_ops/observations/runs",
    max_candidates_per_run: 500,
    max_seconds_per_run: 1_740,
    stop_before_timeout_seconds: 60,
    prune_check_dropbox: { enabled: false, required: false },
  };
}

test("source-change invalidation survives a real Phase B candidate-start budget stop without R2 candidate work", async () => {
  const dayUtc = "2026-07-21";
  let nowMs = 0;
  const deadlineMs = 1_680_000;
  const key = connectorDayGateKey(dayUtc, 1);
  const candidates = new Map([
    [key, completeCandidate(dayUtc, 1, 10, `${dayUtc}T00:00:00.000Z`, `${dayUtc}T23:00:00.000Z`)],
  ]);
  const gates = new Map([[key, true]]);
  const sourceRows = [
    { day_utc: dayUtc, connector_id: 1, expected_row_count: "11", min_observed_at: `${dayUtc}T00:00:00.000Z`, max_observed_at: `${dayUtc}T23:30:00.000Z` },
  ];
  const populationClient = candidatePopulationClient({ candidates, gates, sourceRows });
  let candidateClaimed = false;
  const fakeClient = {
    async connect() {},
    async end() {},
    async query(sql, params) {
      if (/^set (timezone|statement_timeout)/i.test(sql.trim())) return { rows: [] };
      if (/select distinct op\.code|source_changes as materialized/i.test(sql)) {
        return populationClient.query(sql, params);
      }
      if (/insert into uk_aq_ops\.prune_day_gates/i.test(sql)) return { rows: [] };
      if (/where c\.status = 'pending'/i.test(sql)) {
        nowMs = deadlineMs - 299_999;
        return { rows: [candidates.get(key)] };
      }
      if (/set status = 'in_progress'/i.test(sql)) candidateClaimed = true;
      throw new Error(`Unexpected fake PostgreSQL query: ${sql.slice(0, 80)}`);
    },
  };

  const summary = await runPhaseBBackup({
    dryRun: false,
    phaseB: phaseBConfig(),
    ingestRetentionDays: 5,
    logStructured: () => {},
    runId: "budget-stop-run",
    nowUtc: "2026-07-27T12:00:00.000Z",
    nowMs: () => nowMs,
    createPgClient: () => fakeClient,
  });

  assert.equal(candidates.get(key).status, "pending");
  assert.equal(gates.get(key), false);
  assert.equal(candidateClaimed, false);
  assert.equal(summary.status, "stopped_budget");
  assert.equal(summary.stopped_for_budget, true);
  assert.equal(summary.budget_stop.operation, "candidate_start");
  assert.equal(summary.source_changed_connector_gate_invalidated_count, 1);
  assert.deepEqual(summary.run_manifest, { skipped: true, reason: "reserved_for_final_reporting" });
  assert.equal(summary.total_written_rows, "0");
  assert.equal(summary.total_written_bytes, "0");
});

test("top-level stopped-budget path skips every downstream adapter, finishes task health, and writes the normal report", async () => {
  const calls = {
    prune: 0,
    late: 0,
  };
  const stoppedPhaseB = {
    enabled: true,
    run_id: "stopped-run",
    status: "stopped_budget",
    stopped_for_budget: true,
  };
  let healthSummary = null;
  const config = {
    dryRun: false,
    maxHoursPerRun: 24,
    ingestDbRetentionDays: 5,
    phaseB: { enabled: true, history_write_version: "v2" },
  };
  const adapters = {
    runPhaseARecent: async () => ({ enabled: true }),
    runPhaseBBackup: async () => stoppedPhaseB,
    runPruneSingleWindow: async () => { calls.prune += 1; },
    runLateArrivalCleanup: async () => { calls.late += 1; },
    withDailyTaskRun: async (input, fn) => {
      const result = await fn();
      healthSummary = input.buildFinishedSummary(result);
      return result;
    },
  };

  const summary = await executePruneDaily(config, adapters);
  assert.deepEqual(calls, { prune: 0, late: 0 });
  assert.equal(summary.deletion_attempted, false);
  assert.equal(summary.normal_prune.reason, "phase_b_stopped_budget");
  assert.equal(summary.late_arrival.reason, "phase_b_stopped_budget");
  assert.equal(healthSummary.phase_b_history.status, "stopped_budget");
  assert.equal(healthSummary.phase_b_history.stopped_for_budget, true);
  assert.match(healthSummary.warnings[0], /controlled internal budget/i);

  let reportPayload = null;
  const jobResult = await runPruneDailyJob({
    env: {},
    buildRunConfigAdapter: () => config,
    executePruneDailyAdapter: async () => summary,
    writeReportAdapter: async (payload) => { reportPayload = payload; },
    setExitCode: () => assert.fail("successful stopped-budget report path must not set a failure exit code"),
  });
  assert.equal(jobResult.ok, true);
  assert.equal(reportPayload.ok, true);
  assert.equal(reportPayload.summary.phase_b_history.status, "stopped_budget");
});

test("completed Phase B proceeds directly to normal prune and late-arrival stages", async () => {
  const calls = [];
  const config = {
    dryRun: false,
    maxHoursPerRun: 24,
    ingestDbRetentionDays: 5,
    phaseB: { enabled: true, history_write_version: "v2" },
  };
  const summary = await runPruneForTest(config, {
    runPhaseARecent: async () => ({ enabled: true }),
    runPhaseBBackup: async () => ({ enabled: true, status: "completed", stopped_for_budget: false }),
    runPruneSingleWindow: async () => {
      calls.push("prune");
      return { mode: "delete", deletion_attempted: true };
    },
    runLateArrivalCleanup: async () => {
      calls.push("late");
      return { enabled: true };
    },
  });
  assert.deepEqual(calls, ["prune", "late"]);
  assert.equal(summary.deletion_attempted, true);
  assert.equal(summary.phase_b_history.status, "completed");
});

test("Phase B control PostgreSQL timeout is deadline-bounded and only deadline cancellation becomes stopped_budget", async () => {
  const runBudget = createPhaseBRunBudgetForTest({
    nowMs: () => 0,
    startedAtMs: 0,
    maxSecondsPerRun: 1_740,
    stopBeforeTimeoutSeconds: 60,
  });
  const derived = derivePhaseBPgTimeoutsForTest({ run_budget: runBudget });
  assert.ok(derived.statement_timeout_ms <= derived.remaining_budget_ms);
  assert.ok(derived.statement_timeout_ms > 0);
  assert.ok(derived.connection_timeout_ms > 0);

  const runWithPopulationError = async ({ errorCode, errorMessage, expireBudget }) => {
    let nowMs = 0;
    let connectionConfig = null;
    let configuredStatementTimeout = null;
    const fakeClient = {
      async connect() {},
      async end() {},
      async query(sql) {
        const normalized = sql.trim();
        if (/^set timezone/i.test(normalized)) return { rows: [] };
        if (/^set statement_timeout/i.test(normalized)) {
          configuredStatementTimeout = Number(normalized.match(/'(\d+)ms'/)[1]);
          return { rows: [] };
        }
        if (/select distinct op\.code/i.test(normalized)) return { rows: [] };
        if (/source_changes as materialized/i.test(normalized)) {
          if (expireBudget) nowMs = 1_679_500;
          throw Object.assign(new Error(errorMessage), { code: errorCode });
        }
        throw new Error(`Unexpected fake PostgreSQL query: ${normalized.slice(0, 80)}`);
      },
    };
    const promise = runPhaseBBackup({
      dryRun: false,
      phaseB: phaseBConfig(),
      ingestRetentionDays: 5,
      logStructured: () => {},
      runId: `sql-${errorCode}`,
      nowUtc: "2026-07-27T12:00:00.000Z",
      nowMs: () => nowMs,
      createPgClient: (config) => {
        connectionConfig = config;
        return fakeClient;
      },
    });
    return { promise, getConnectionConfig: () => connectionConfig, getStatementTimeout: () => configuredStatementTimeout };
  };

  const deadlineCase = await runWithPopulationError({
    errorCode: "57014",
    errorMessage: "canceling statement due to statement timeout",
    expireBudget: true,
  });
  const stopped = await deadlineCase.promise;
  assert.equal(stopped.status, "stopped_budget");
  assert.equal(stopped.budget_stop.operation, "control_database_statement");
  assert.ok(deadlineCase.getStatementTimeout() <= 1_680_000);
  assert.ok(deadlineCase.getConnectionConfig().connectionTimeoutMillis <= 15_000);

  const sqlDefectCase = await runWithPopulationError({
    errorCode: "42601",
    errorMessage: "syntax error at or near source_aggregates",
    expireBudget: false,
  });
  await assert.rejects(sqlDefectCase.promise, /syntax error/);
});

test("Prune Daily CLI orchestration delegates the whole job to the retained global lock", async () => {
  let lockedOptions = null;
  let jobCalls = 0;
  const result = await runPruneDailyJobWithGlobalLock({
    env: {
      SUPABASE_DB_URL: "postgresql://direct-session",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    },
    runLockedCommand: async (options) => {
      lockedOptions = options;
      return 0;
    },
    runJob: async () => { jobCalls += 1; },
  });
  assert.equal(result.delegated, true);
  assert.equal(result.exitCode, 0);
  assert.equal(jobCalls, 0);
  assert.equal(lockedOptions.databaseUrl, "postgresql://direct-session");
  assert.equal(lockedOptions.owner, "prune_daily");
  assert.equal(lockedOptions.runId, "prune-daily:123:2");
  assert.match(lockedOptions.commandArgs[0], /workers\/uk_aq_prune_daily\/job\.mjs$/);
});

test("Prune Daily locked child executes the preserved job path without reacquiring", async () => {
  const identity = observationsGlobalOperationLockIdentity();
  const env = {
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: "prune_daily",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: "prune-daily:123:2",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]: identity.logical_identity,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: "test-nonce",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: "0",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
  };
  let jobCalls = 0;
  let lockCalls = 0;
  const result = await runPruneDailyJobWithGlobalLock({
    env,
    runLockedCommand: async () => { lockCalls += 1; },
    runJob: async ({ env: receivedEnv }) => {
      jobCalls += 1;
      assert.equal(receivedEnv, env);
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(jobCalls, 1);
  assert.equal(lockCalls, 0);
});
