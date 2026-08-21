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
  failExact = false,
  failDay = false,
  reportPruneEligibility = false,
  afterConnectorRelease = null,
} = {}) {
  const events = [];
  const objects = new Map();
  const activeLocks = new Set();
  const connectorCalls = [];
  const dayCalls = [];
  const publicationCalls = [];
  const durableCalls = [];
  const getCalls = [];
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
      if (kind === "connector" && typeof afterConnectorRelease === "function") {
        await afterConnectorRelease({ identity, events, objects });
      }
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
      publicationCalls.push({ key, stage, lock: [...activeLocks][0] || null });
      events.push(`v3:put:${stage}:${key}`);
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    getObject: async ({ key }) => {
      getCalls.push({ key, lock: [...activeLocks][0] || null });
      events.push(`v3:get:${key}`);
      const body = objects.get(key);
      return body ? { exists: true, body: Buffer.from(body) } : { exists: false };
    },
    recordDurableEvidence: async ({ key, publication_stage: stage }) => {
      durableCalls.push({ key, stage, lock: [...activeLocks][0] || null });
      events.push(`v3:durable:${stage}:${key}`);
      return { durable: !(failExact && stage === "child_shard") };
    },
  };

  return {
    events,
    options,
    connectorCalls,
    dayCalls,
    publicationCalls,
    durableCalls,
    getCalls,
    objects,
    latestKey: initialLatest.key,
    unrelatedScopedKey: unrelated.v3_hierarchy.scoped_manifest.key,
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
  const latestPuts = fixture.publicationCalls.filter((call) =>
    call.stage === "latest_global"
  );
  assert.equal(latestPuts.length, 1);
  assert.equal(latestPuts[0].lock, "global");

  const exactPuts = fixture.publicationCalls.filter((call) =>
    call.stage === "child_shard" || call.stage === "scoped_manifest"
  );
  const exactDurables = fixture.durableCalls.filter((call) =>
    call.stage === "child_shard" || call.stage === "scoped_manifest"
  );
  assert.ok(exactPuts.length > 0);
  assert.ok(exactPuts.every((call) => call.lock === "connector"));
  assert.ok(exactDurables.every((call) => call.lock === "connector"));
  assert.equal(
    fixture.publicationCalls.some((call) =>
      call.lock === "global" &&
      (call.stage === "child_shard" || call.stage === "scoped_manifest")
    ),
    false,
  );

  const changedScopedKeys = result.connector_results.flatMap((connector) =>
    connector.partitions.map((partition) => partition.scoped_root.evidence.key)
  );
  for (const connector of result.connector_results) {
    const prefix = `day_utc=${connector.day_utc}/connector_id=${connector.connector_id}/`;
    const releaseIndex = fixture.events.findIndex((event) =>
      event === `lock:connector:release:${connector.day_utc}/${connector.connector_id}`
    );
    const scopedDurableIndexes = fixture.events
      .map((event, index) => [event, index])
      .filter(([event]) =>
        event.startsWith("v3:durable:scoped_manifest:") && event.includes(prefix)
      )
      .map(([, index]) => index);
    assert.ok(scopedDurableIndexes.length > 0);
    assert.ok(Math.max(...scopedDurableIndexes) < releaseIndex);
    for (const partition of connector.partitions) {
      const scopedPutIndex = fixture.events.findIndex((event) =>
        event === `v3:put:scoped_manifest:${partition.scoped_root.artifact.key}`
      );
      const childKeys = partition.scoped_root.artifact.dependencies
        .filter((dependency) => dependency.kind === "child_shard")
        .map((dependency) => dependency.key);
      assert.ok(childKeys.length > 0);
      assert.ok(childKeys.every((key) => {
        const childDurableIndex = fixture.events.findIndex((event) =>
          event === `v3:durable:child_shard:${key}`
        );
        return childDurableIndex >= 0 && childDurableIndex < scopedPutIndex;
      }));
    }
  }

  for (const dayUtc of result.affected_days_utc) {
    const dayAcquireIndex = fixture.events.findIndex((event) =>
      event === `lock:day:acquire:${dayUtc}`
    );
    const scopedDurableIndexes = fixture.events
      .map((event, index) => [event, index])
      .filter(([event]) =>
        event.startsWith("v3:durable:scoped_manifest:") &&
        event.includes(`day_utc=${dayUtc}/`)
      )
      .map(([, index]) => index);
    assert.ok(Math.max(...scopedDurableIndexes) < dayAcquireIndex);
  }

  assert.ok(changedScopedKeys.every((key) =>
    fixture.getCalls.some((call) => call.key === key && call.lock === "connector")
  ));
  assert.ok(changedScopedKeys.every((key) =>
    fixture.getCalls.some((call) => call.key === key && call.lock === "global")
  ));
  assert.ok(fixture.getCalls.some((call) =>
    call.key === fixture.latestKey && call.lock === "global"
  ));
  assert.ok(fixture.getCalls.some((call) =>
    call.key === fixture.unrelatedScopedKey && call.lock === "global"
  ));

  const aggregateIndex = fixture.events.findIndex((event) =>
    event.startsWith("canonical:aggregate:")
  );
  const latestPutIndex = fixture.events.findIndex((event) =>
    event.startsWith("v3:put:latest_global:")
  );
  assert.ok(aggregateIndex < latestPutIndex);
  for (const key of [...changedScopedKeys, fixture.unrelatedScopedKey]) {
    const lastDependencyGetIndex = fixture.events.lastIndexOf(`v3:get:${key}`);
    assert.ok(lastDependencyGetIndex >= 0 && lastDependencyGetIndex < latestPutIndex);
  }
});

test("connector exact-publication or day failure prevents later authority phases", async () => {
  const connectorFailure = buildFixture({ failExact: true });
  await assert.rejects(
    runPruneDailyObservationHistoryV3Writer(connectorFailure.options),
    /durable publication evidence failed/,
  );
  assert.equal(connectorFailure.globalLockCount(), 0);
  assert.equal(connectorFailure.events.some((event) => event.startsWith("lock:day:acquire:")), false);
  assert.equal(
    connectorFailure.publicationCalls.some((call) => call.stage === "child_shard"),
    true,
  );
  assert.equal(connectorFailure.activeLocks.size, 0);

  const dayFailure = buildFixture({ failDay: true });
  await assert.rejects(
    runPruneDailyObservationHistoryV3Writer(dayFailure.options),
    /fixture day failure/,
  );
  assert.equal(dayFailure.globalLockCount(), 0);
  assert.equal(dayFailure.activeLocks.size, 0);
});

test("a later connector generation blocks stale latest publication without rewriting its scoped root", async () => {
  const replacement = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows({
      dayUtc: "2026-08-18",
      connectorId: 1,
      pollutantCode: "pm25",
      timeseriesId: 101,
    }).map((row) => ({ ...row, value: row.value + 1 })),
    writerLimits: LIMITS,
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
  });
  const replacementRoot = replacement.v3_hierarchy.scoped_manifest;
  let replacementRecorded = false;
  const fixture = buildFixture({
    afterConnectorRelease: async ({ identity, events, objects }) => {
      if (identity === "2026-08-18/1" && !replacementRecorded) {
        replacementRecorded = true;
        objects.set(replacementRoot.key, Buffer.from(replacementRoot.body));
        events.push("race:generation-b:connector-replacement");
      }
    },
  });
  await assert.rejects(
    runPruneDailyObservationHistoryV3Writer({
      ...fixture.options,
      partitions: fixture.options.partitions.slice(0, 2),
    }),
    /V3 external publication reference identity changed/,
  );

  const releaseIndex = fixture.events.indexOf(
    "lock:connector:release:2026-08-18/1",
  );
  const replacementIndex = fixture.events.indexOf(
    "race:generation-b:connector-replacement",
  );
  const exactIndexes = fixture.events
    .map((event, index) => [event, index])
    .filter(([event]) =>
      event.startsWith("v3:put:child_shard:") ||
      event.startsWith("v3:put:scoped_manifest:") ||
      event.startsWith("v3:durable:child_shard:") ||
      event.startsWith("v3:durable:scoped_manifest:")
    )
    .map(([, index]) => index);

  assert.ok(exactIndexes.length > 0);
  assert.ok(Math.max(...exactIndexes) < releaseIndex);
  assert.ok(releaseIndex < replacementIndex);
  assert.ok(fixture.getCalls.some((call) =>
    call.key === replacementRoot.key && call.lock === "global"
  ));
  assert.equal(
    fixture.publicationCalls.filter((call) => call.stage === "latest_global").length,
    0,
  );
  assert.equal(
    exactIndexes.some((index) => index > replacementIndex),
    false,
  );
  assert.deepEqual(fixture.objects.get(replacementRoot.key), Buffer.from(replacementRoot.body));
  assert.equal(fixture.activeLocks.size, 0);
});

test("a stale unchanged latest dependency fails closed before latest publication", async () => {
  const replacement = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows({
      dayUtc: "2026-08-01",
      connectorId: 99,
      pollutantCode: "o3",
      timeseriesId: 9901,
    }).map((row) => ({ ...row, value: row.value + 1 })),
    writerLimits: LIMITS,
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
  });
  const replacementRoot = replacement.v3_hierarchy.scoped_manifest;
  let replacementRecorded = false;
  const fixture = buildFixture({
    afterConnectorRelease: async ({ identity, events, objects }) => {
      if (identity === "2026-08-18/1" && !replacementRecorded) {
        replacementRecorded = true;
        objects.set(replacementRoot.key, Buffer.from(replacementRoot.body));
        events.push("race:unchanged-root:connector-replacement");
      }
    },
  });

  await assert.rejects(
    runPruneDailyObservationHistoryV3Writer({
      ...fixture.options,
      partitions: fixture.options.partitions.slice(0, 1),
    }),
    /V3 external publication reference identity changed/,
  );

  assert.ok(fixture.getCalls.some((call) =>
    call.key === fixture.unrelatedScopedKey && call.lock === "global"
  ));
  assert.equal(
    fixture.publicationCalls.filter((call) => call.stage === "latest_global").length,
    0,
  );
  assert.deepEqual(
    fixture.objects.get(fixture.unrelatedScopedKey),
    Buffer.from(replacementRoot.body),
  );
  assert.equal(fixture.activeLocks.size, 0);
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
