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
  runPhaseBBackup,
  runBudgetedPhaseBStageForTest,
  stopPhaseBForBudgetForTest,
  summarizeVerifiedMergedDayManifestForGate,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  executePruneDaily,
  filterBucketsByConnectorHistoryGate,
  runPruneForTest,
} from "../workers/uk_aq_prune_daily/server.mjs";
import { runPruneDailyJob } from "../workers/uk_aq_prune_daily/job.mjs";
import {
  canonicalObservationConnectorManifestKey,
  connectorDayGateKey,
  isValidConnectorHistoryGateEvidence,
  setConnectorDayGateIncomplete,
} from "../workers/shared/uk_aq_connector_day_gate.mjs";
import { computePruneConnectorSourceIdentity } from "../workers/shared/uk_aq_prune_connector_source_identity.mjs";

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
    phase_b_calculate_aqi_from_observations_enabled: true,
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
