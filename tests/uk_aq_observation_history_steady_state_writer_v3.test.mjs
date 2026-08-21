import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildObservationHistoryIndexV3Latest,
} from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  runIntegrityObservationHistoryV3Writer,
  runPruneDailyObservationHistoryV3Writer,
  runSosHistoricalReplacementObservationHistoryV3Writer,
  runSupportedBackfillObservationHistoryV3Writer,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";

const LIMITS = Object.freeze({
  target_row_group_rows: 2,
  max_row_group_rows: 2,
  target_file_rows: 4,
  max_file_rows: 4,
  target_file_bytes: 1_000_000,
  max_file_bytes: 2_000_000,
  max_row_groups_per_file: 2,
});
const TARGET_GIT_SHA = "1".repeat(40);
const BACKED_UP_AT_UTC = "2026-08-21T00:00:00.000Z";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidence(key) {
  const body = Buffer.from(key, "utf8");
  return {
    key,
    byte_size: body.byteLength,
    sha256: sha256(body),
    verified: true,
    durable: true,
  };
}

function rows({ dayUtc, connectorId, pollutantCode, timeseriesId }) {
  return [0, 1].map((hour) => ({
    connector_id: connectorId,
    station_id: timeseriesId + 10,
    timeseries_id: timeseriesId,
    pollutant_code: pollutantCode,
    observed_at_utc: `${dayUtc}T${String(hour).padStart(2, "0")}:00:00.000Z`,
    value: timeseriesId + hour / 10,
    verification_status: hour === 0 ? null : "P",
  }));
}

function partitions() {
  return [
    { rows: rows({ dayUtc: "2026-08-18", connectorId: 1, pollutantCode: "pm25", timeseriesId: 101 }) },
    { rows: rows({ dayUtc: "2026-08-18", connectorId: 1, pollutantCode: "no2", timeseriesId: 102 }) },
    { rows: rows({ dayUtc: "2026-08-18", connectorId: 2, pollutantCode: "pm25", timeseriesId: 201 }) },
    { rows: rows({ dayUtc: "2026-08-20", connectorId: 1, pollutantCode: "pm10", timeseriesId: 301 }) },
  ];
}

function buildFixture({
  failConnector = false,
  failDay = false,
  reportPruneEligibility = false,
} = {}) {
  const events = [];
  const objects = new Map();
  const activeLocks = new Set();
  const connectorCalls = [];
  const dayCalls = [];
  let globalLockCount = 0;

  const unrelated = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows({
      dayUtc: "2026-08-01",
      connectorId: 99,
      pollutantCode: "o3",
      timeseriesId: 9901,
    }),
    writerLimits: LIMITS,
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
  });
  const initialLatest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [unrelated.v3_hierarchy],
  });
  objects.set(initialLatest.key, Buffer.from(initialLatest.body));
  objects.set(
    unrelated.v3_hierarchy.scoped_manifest.key,
    Buffer.from(unrelated.v3_hierarchy.scoped_manifest.body),
  );

  async function withinLock(kind, identity, callback) {
    assert.equal(activeLocks.size, 0, `lock overlap before ${kind}:${identity}`);
    activeLocks.add(kind);
    events.push(`lock:${kind}:acquire:${identity}`);
    try {
      return await callback();
    } finally {
      activeLocks.delete(kind);
      events.push(`lock:${kind}:release:${identity}`);
    }
  }

  const options = {
    client: { query: async () => ({ rows: [] }) },
    partitions: partitions(),
    writerLimits: LIMITS,
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
    r2: {},
    withConnectorDayLock: async ({ dayUtc, connectorId }, callback) =>
      await withinLock("connector", `${dayUtc}/${connectorId}`, callback),
    runDayFinalizer: async ({ dayUtc, finalize }) =>
      await withinLock("day", dayUtc, finalize),
    runGlobalFinalizer: async ({ finalize }) => {
      globalLockCount += 1;
      return await withinLock("global", "all", finalize);
    },
    putAndVerifyParquet: async ({ intent }) => {
      events.push(`parquet:${intent.key}`);
      objects.set(intent.key, Buffer.from(intent.body));
      return {
        key: intent.key,
        byte_size: intent.byte_size,
        sha256: intent.sha256,
        stored_sha256_verified: true,
      };
    },
    publishConnectorScopedCanonicalManifests: async ({
      day_utc: dayUtc,
      connector_id: connectorId,
      partitions: changedPartitions,
    }) => {
      connectorCalls.push({
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_count: changedPartitions.length,
      });
      events.push(`canonical:connector:${dayUtc}/${connectorId}`);
      if (failConnector && connectorId === 2) {
        throw new Error("fixture connector failure");
      }
      const pollutantManifests = changedPartitions.map(({ pollutant_manifest: artifact }) => {
        objects.set(artifact.key, Buffer.from(artifact.body));
        return {
          key: artifact.key,
          byte_size: artifact.byte_size,
          sha256: artifact.sha256,
          verified: true,
          durable: true,
        };
      });
      return {
        connector_scope_verified: true,
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_manifests: pollutantManifests,
        connector_manifest: evidence(
          `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
        ),
        prune_eligibility_created: reportPruneEligibility,
      };
    },
    finalizeCanonicalDayManifests: async ({ day_utc: dayUtc, changed_connectors: changed }) => {
      events.push(`canonical:day:${dayUtc}`);
      if (failDay) throw new Error("fixture day failure");
      const current = dayUtc === "2026-08-18" ? [9] : [8];
      const changedIds = changed.map((entry) => entry.connector_id).sort((a, b) => a - b);
      const finalIds = [...new Set([...current, ...changedIds])].sort((a, b) => a - b);
      dayCalls.push({ day_utc: dayUtc, current, changed: changedIds, final: finalIds });
      return {
        canonical_day_authority_verified: true,
        parent_state_reread_under_lock: true,
        day_utc: dayUtc,
        current_connector_ids: current,
        changed_connector_ids: changedIds,
        final_connector_ids: finalIds,
        day_manifest: evidence(`history/v2/observations/day_utc=${dayUtc}/manifest.json`),
      };
    },
    finalizeCanonicalAggregateManifests: async ({ affected_days_utc: affectedDays }) => {
      events.push(`canonical:aggregate:${affectedDays.join(",")}`);
      return {
        canonical_aggregate_authority_verified: true,
        parent_state_reread_under_lock: true,
        affected_days_utc: affectedDays,
        aggregate_manifests: [
          evidence("history/v2/observations/_manifests/manifest.json"),
        ],
      };
    },
    putIfChanged: async ({ key, body, publication_stage: stage }) => {
      events.push(`v3:put:${stage}:${key}`);
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    getObject: async ({ key }) => {
      events.push(`v3:get:${key}`);
      const body = objects.get(key);
      return body ? { exists: true, body: Buffer.from(body) } : { exists: false };
    },
    recordDurableEvidence: async ({ key, publication_stage: stage }) => {
      events.push(`v3:durable:${stage}:${key}`);
      return { durable: true };
    },
  };

  return {
    events,
    options,
    connectorCalls,
    dayCalls,
    activeLocks,
    globalLockCount: () => globalLockCount,
  };
}

test("run-level v3 writer releases each lock phase, merges days, and publishes latest once", async () => {
  const fixture = buildFixture();
  const result = await runPruneDailyObservationHistoryV3Writer(fixture.options);

  assert.equal(result.ok, true);
  assert.equal(result.affected_partition_count, 4);
  assert.deepEqual(result.affected_days_utc, ["2026-08-18", "2026-08-20"]);
  assert.equal(fixture.globalLockCount(), 1);
  assert.equal(fixture.activeLocks.size, 0);
  assert.deepEqual(fixture.connectorCalls, [
    { day_utc: "2026-08-18", connector_id: 1, pollutant_count: 2 },
    { day_utc: "2026-08-18", connector_id: 2, pollutant_count: 1 },
    { day_utc: "2026-08-20", connector_id: 1, pollutant_count: 1 },
  ]);
  assert.deepEqual(fixture.dayCalls, [
    { day_utc: "2026-08-18", current: [9], changed: [1, 2], final: [1, 2, 9] },
    { day_utc: "2026-08-20", current: [8], changed: [1], final: [1, 8] },
  ]);

  const acquisitions = fixture.events.filter((event) => event.includes(":acquire:"));
  assert.deepEqual(acquisitions.map((event) => event.split(":")[1]), [
    "connector", "connector", "connector", "day", "day", "global",
  ]);
  const latestPuts = fixture.events.filter((event) =>
    event.startsWith("v3:put:latest_global:")
  );
  assert.equal(latestPuts.length, 1);

  const childDurables = fixture.events
    .map((event, index) => [event, index])
    .filter(([event]) => event.startsWith("v3:durable:child_shard:"));
  const scopedPuts = fixture.events
    .map((event, index) => [event, index])
    .filter(([event]) => event.startsWith("v3:put:scoped_manifest:"));
  const scopedDurables = fixture.events
    .map((event, index) => [event, index])
    .filter(([event]) => event.startsWith("v3:durable:scoped_manifest:"));
  const aggregateIndex = fixture.events.findIndex((event) =>
    event.startsWith("canonical:aggregate:")
  );
  const latestPutIndex = fixture.events.findIndex((event) =>
    event.startsWith("v3:put:latest_global:")
  );
  assert.ok(childDurables.length > 0);
  assert.ok(scopedPuts.length > 0);
  assert.ok(Math.max(...childDurables.map(([, index]) => index)) < Math.min(...scopedPuts.map(([, index]) => index)));
  assert.ok(Math.max(...scopedDurables.map(([, index]) => index)) < aggregateIndex);
  assert.ok(aggregateIndex < latestPutIndex);
});

test("connector or day failure prevents later authority phases", async () => {
  const connectorFailure = buildFixture({ failConnector: true });
  await assert.rejects(
    runPruneDailyObservationHistoryV3Writer(connectorFailure.options),
    /fixture connector failure/,
  );
  assert.equal(connectorFailure.globalLockCount(), 0);
  assert.equal(connectorFailure.events.some((event) => event.startsWith("lock:day:acquire:")), false);
  assert.equal(connectorFailure.activeLocks.size, 0);

  const dayFailure = buildFixture({ failDay: true });
  await assert.rejects(
    runPruneDailyObservationHistoryV3Writer(dayFailure.options),
    /fixture day failure/,
  );
  assert.equal(dayFailure.globalLockCount(), 0);
  assert.equal(dayFailure.activeLocks.size, 0);
});

test("non-Prune fixed-source adapters reject prune-eligibility reporting", async () => {
  for (const runWriter of [
    runIntegrityObservationHistoryV3Writer,
    runSosHistoricalReplacementObservationHistoryV3Writer,
    runSupportedBackfillObservationHistoryV3Writer,
  ]) {
    const fixture = buildFixture({ reportPruneEligibility: true });
    await assert.rejects(
      runWriter({ ...fixture.options, partitions: fixture.options.partitions.slice(0, 1) }),
      /must not create Prune Daily eligibility/,
    );
    assert.equal(fixture.globalLockCount(), 0);
    assert.equal(fixture.activeLocks.size, 0);
  }
});
