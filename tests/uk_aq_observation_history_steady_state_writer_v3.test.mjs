import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildObservationHistoryExactLeafIndexV3Latest as buildObservationHistoryIndexV3Latest,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  runObservationHistoryV3RunFinalization,
  runIntegrityObservationHistoryV3Writer,
  runPruneDailyObservationHistoryV3ConnectorPublication,
  runPruneDailyObservationHistoryV3RunFinalization,
  runPruneDailyObservationHistoryV3Writer,
  runSosHistoricalReplacementObservationHistoryV3Writer,
  runSupportedBackfillObservationHistoryV3Writer,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
} from "../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";

const LIMITS = ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3;
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
  currentPollutantsFor = null,
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
  const obsoletePruneScope = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows({
      dayUtc: "2026-08-18",
      connectorId: 1,
      pollutantCode: "o3",
      timeseriesId: 103,
    }),
    writerLimits: LIMITS,
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
  });
  const initialLatest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [
      unrelated.v3_hierarchy,
      obsoletePruneScope.v3_hierarchy,
    ],
  });
  objects.set(initialLatest.key, Buffer.from(initialLatest.body));
  objects.set(
    unrelated.v3_hierarchy.scoped_manifest.key,
    Buffer.from(unrelated.v3_hierarchy.scoped_manifest.body),
  );
  objects.set(
    obsoletePruneScope.v3_hierarchy.scoped_manifest.key,
    Buffer.from(obsoletePruneScope.v3_hierarchy.scoped_manifest.body),
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
      source,
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
      const changedPollutants = changedPartitions
        .map((partition) => partition.scope.pollutant_code)
        .sort();
      const currentPollutants = typeof currentPollutantsFor === "function"
        ? currentPollutantsFor({ source, dayUtc, connectorId })
        : source === "sos_historical_replacement"
          ? []
          : connectorId === 1 ? ["o3"] : [];
      const completePruneSnapshot = source === "prune_daily";
      const finalPollutants = completePruneSnapshot
        ? changedPollutants
        : [...new Set([
          ...currentPollutants,
          ...changedPollutants,
        ])].sort();
      const finalPollutantSet = new Set(finalPollutants);
      const removedPollutants = completePruneSnapshot
        ? currentPollutants.filter((pollutantCode) =>
          !finalPollutantSet.has(pollutantCode)
        )
        : [];
      return {
        connector_scope_verified: true,
        parent_state_reread_under_lock: true,
        day_utc: dayUtc,
        connector_id: connectorId,
        current_pollutant_codes: currentPollutants,
        changed_pollutant_codes: changedPollutants,
        final_pollutant_codes: finalPollutants,
        removed_pollutant_codes: removedPollutants,
        removed_scopes: removedPollutants.map((pollutantCode) => ({
          day_utc: dayUtc,
          connector_id: connectorId,
          pollutant_code: pollutantCode,
        })),
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
    removedScopedKey: obsoletePruneScope.v3_hierarchy.scoped_manifest.key,
    activeLocks,
    globalLockCount: () => globalLockCount,
  };
}

function finalizationEvidence({
  dayUtc,
  connectorId,
  pollutantCode,
  timeseriesId,
  objects,
}) {
  const partition = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows({ dayUtc, connectorId, pollutantCode, timeseriesId }),
    writerLimits: LIMITS,
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
  });
  const artifact = partition.v3_hierarchy.scoped_manifest;
  objects.set(artifact.key, Buffer.from(artifact.body));
  return {
    ok: true,
    status: "connector_publication_complete",
    source: "prune_daily",
    connector_publication_complete: true,
    connector_results: [{
      day_utc: dayUtc,
      connector_id: connectorId,
      partitions: [{
        scope: partition.scope,
        scoped_root: {
          artifact,
          evidence: {
            key: artifact.key,
            byte_size: artifact.byte_size,
            sha256: artifact.sha256,
            verified: true,
            durable: true,
          },
        },
      }],
      canonical: {
        connector_scope_verified: true,
        parent_state_reread_under_lock: true,
        connector_manifest: evidence(
          `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
        ),
        connector_manifest_payload: {},
        removed_pollutant_codes: [],
        removed_scopes: [],
      },
      v3_exact_publication: { ok: true, status: "written" },
    }],
    complete_day_replacement_results: [],
  };
}

async function finalizeCanonicalDayV3({
  day_utc: dayUtc,
  changed_connectors: changed,
}) {
  const changedIds = changed.map((entry) => entry.connector_id)
    .sort((left, right) => left - right);
  return {
    canonical_day_authority_verified: true,
    parent_state_reread_under_lock: true,
    day_utc: dayUtc,
    current_connector_ids: [],
    changed_connector_ids: changedIds,
    final_connector_ids: changedIds,
    day_manifest: evidence(
      `history/v3/observations/day_utc=${dayUtc}/manifest.json`,
    ),
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
  assert.deepEqual(result.removed_scopes, [{
    day_utc: "2026-08-18",
    connector_id: 1,
    pollutant_code: "o3",
  }]);
  const updatedLatest = JSON.parse(fixture.objects.get(fixture.latestKey).toString("utf8"));
  const updatedScopedKeys = updatedLatest.day_summaries.flatMap((day) =>
    day.scoped_roots.map((root) => root.key)
  );
  assert.equal(updatedScopedKeys.includes(fixture.removedScopedKey), false);
  assert.equal(fixture.objects.has(fixture.removedScopedKey), true);

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

test("split Prune API publishes two same-day connectors then finalizes the run once", async () => {
  const fixture = buildFixture();
  const connectorPublications = [
    await runPruneDailyObservationHistoryV3ConnectorPublication({
      ...fixture.options,
      partitions: fixture.options.partitions.slice(0, 2),
    }),
    await runPruneDailyObservationHistoryV3ConnectorPublication({
      ...fixture.options,
      partitions: fixture.options.partitions.slice(2, 3),
    }),
  ];
  assert.equal(fixture.dayCalls.length, 0);
  assert.equal(fixture.globalLockCount(), 0);
  for (const publication of connectorPublications) {
    const evidence = publication.run_finalization_evidence;
    assert.equal(evidence.connector_results.length, 1);
    assert.equal(evidence.connector_results[0].partitions[0].target_metadata, undefined);
    assert.equal(evidence.connector_results[0].partitions[0].pollutant_manifest, undefined);
    assert.equal(evidence.connector_results[0].partitions[0].file_evidence, undefined);
    assert.equal(evidence.connector_results[0].canonical.pollutant_manifests, undefined);
    assert.equal(JSON.stringify(evidence).includes('"rows"'), false);
  }

  const result = await runPruneDailyObservationHistoryV3RunFinalization({
    ...fixture.options,
    connectorPublications: connectorPublications.map(
      (publication) => publication.run_finalization_evidence,
    ),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.connectorCalls.map((entry) => entry.connector_id), [1, 2]);
  assert.deepEqual(fixture.dayCalls.map((entry) => entry.day_utc), ["2026-08-18"]);
  assert.equal(fixture.globalLockCount(), 1);
  assert.equal(
    fixture.publicationCalls.filter((call) => call.stage === "latest_global").length,
    1,
  );
});

test("split Prune API finalizes two exact affected days and shared parents once", async () => {
  const fixture = buildFixture();
  const connectorPublications = [
    await runPruneDailyObservationHistoryV3ConnectorPublication({
      ...fixture.options,
      partitions: fixture.options.partitions.slice(0, 2),
    }),
    await runPruneDailyObservationHistoryV3ConnectorPublication({
      ...fixture.options,
      partitions: fixture.options.partitions.slice(3, 4),
    }),
  ];
  const result = await runPruneDailyObservationHistoryV3RunFinalization({
    ...fixture.options,
    connectorPublications: connectorPublications.map(
      (publication) => publication.run_finalization_evidence,
    ),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.affected_days_utc, ["2026-08-18", "2026-08-20"]);
  assert.deepEqual(
    fixture.dayCalls.map((entry) => entry.day_utc),
    ["2026-08-18", "2026-08-20"],
  );
  assert.equal(fixture.globalLockCount(), 1);
  assert.equal(
    fixture.publicationCalls.filter((call) => call.stage === "latest_global").length,
    1,
  );
});

test("run finalization admits and diagnoses day, aggregate and latest stages", async () => {
  const fixture = buildFixture();
  const admittedStages = [];
  const diagnosticEvents = [];
  const connectorPublications = [
    finalizationEvidence({
      dayUtc: "2026-08-18",
      connectorId: 1,
      pollutantCode: "pm25",
      timeseriesId: 101,
      objects: fixture.objects,
    }),
    finalizationEvidence({
      dayUtc: "2026-08-20",
      connectorId: 2,
      pollutantCode: "no2",
      timeseriesId: 202,
      objects: fixture.objects,
    }),
  ];

  const result = await runPruneDailyObservationHistoryV3RunFinalization({
    ...fixture.options,
    connectorPublications,
    finalizeCanonicalDayManifests: async ({
      day_utc: dayUtc,
      changed_connectors: changed,
    }) => {
      const changedIds = changed.map((entry) => entry.connector_id);
      return {
        canonical_day_authority_verified: true,
        parent_state_reread_under_lock: true,
        day_utc: dayUtc,
        current_connector_ids: [],
        changed_connector_ids: changedIds,
        final_connector_ids: changedIds,
        day_manifest: evidence(
          `history/v3/observations/day_utc=${dayUtc}/manifest.json`,
        ),
      };
    },
    beforePublicationStage: ({ stage, ...fields }) => {
      admittedStages.push({ stage, fields });
    },
    diagnosticLog: (event, fields) => {
      diagnosticEvents.push({ event, fields });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(admittedStages.map(({ stage }) => stage), [
    "run_finalization",
    "canonical_day_finalization",
    "canonical_day_finalization",
    "canonical_aggregate_finalization",
    "latest_global_exact_v3_finalization",
  ]);
  assert.deepEqual(diagnosticEvents.map(({ event }) => event), [
    "run_finalization_start",
    "canonical_day_finalization_start",
    "canonical_day_finalization_complete",
    "canonical_day_finalization_start",
    "canonical_day_finalization_complete",
    "canonical_aggregate_finalization_start",
    "canonical_aggregate_finalization_complete",
    "latest_global_exact_v3_finalization_start",
    "latest_global_exact_v3_finalization_complete",
    "run_finalization_complete",
  ]);
  assert.deepEqual(
    diagnosticEvents
      .filter(({ event }) => event === "canonical_day_finalization_start")
      .map(({ fields }) => fields.day_utc),
    ["2026-08-18", "2026-08-20"],
  );
});

test("run finalization preserves a budget-admission error at a safe stage boundary", async () => {
  const fixture = buildFixture();
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });
  const budgetError = Object.assign(new Error("fixture budget exhausted"), {
    name: "PhaseBHistoryBudgetExhaustedError",
    code: "PHASE_B_HISTORY_BUDGET_EXHAUSTED",
    operation: "v3_canonical_day_finalization_start",
  });
  const diagnosticEvents = [];

  await assert.rejects(
    runPruneDailyObservationHistoryV3RunFinalization({
      ...fixture.options,
      connectorPublications: [connectorPublication],
      beforePublicationStage: ({ stage }) => {
        if (stage === "canonical_day_finalization") throw budgetError;
      },
      diagnosticLog: (event) => diagnosticEvents.push(event),
    }),
    (error) => error === budgetError,
  );
  assert.deepEqual(diagnosticEvents, [
    "run_finalization_start",
    "canonical_day_finalization_failed",
    "run_finalization_failed",
  ]);
  assert.equal(fixture.dayCalls.length, 0);
  assert.equal(fixture.globalLockCount(), 0);
});

test("Prune retry removes a stale latest scope after canonical connector authority is already exact", async () => {
  const fixture = buildFixture({ currentPollutantsFor: () => [] });
  const result = await runPruneDailyObservationHistoryV3Writer({
    ...fixture.options,
    partitions: fixture.options.partitions.slice(0, 1),
  });

  assert.deepEqual(result.connector_results[0].canonical.removed_scopes, []);
  assert.deepEqual(result.removed_scopes, [{
    day_utc: "2026-08-18",
    connector_id: 1,
    pollutant_code: "o3",
  }]);
  const updatedLatest = JSON.parse(fixture.objects.get(fixture.latestKey).toString("utf8"));
  const updatedScopedKeys = updatedLatest.day_summaries.flatMap((day) =>
    day.scoped_roots.map((root) => root.key)
  );
  assert.equal(updatedScopedKeys.includes(fixture.removedScopedKey), false);
  assert.equal(fixture.objects.has(fixture.removedScopedKey), true);
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

test("Prune rebuilds latest with a canonically recovered same-key scoped identity", async () => {
  const replacement = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
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
  const diagnosticEvents = [];
  const recoveryCalls = [];
  const fixture = buildFixture();
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });
  fixture.objects.set(replacementRoot.key, Buffer.from(replacementRoot.body));

  const result = await runPruneDailyObservationHistoryV3RunFinalization({
    ...fixture.options,
    connectorPublications: [connectorPublication],
    finalizeCanonicalDayManifests: finalizeCanonicalDayV3,
    diagnosticLog: (event, fields) => diagnosticEvents.push({ event, fields }),
    recoverLatestScopedReference: async (request) => {
      recoveryCalls.push(request);
      assert.equal(request.source, "prune_daily");
      assert.equal(request.reference.key, replacementRoot.key);
      assert.equal(request.latest_scope.key, replacementRoot.key);
      assert.equal(request.latest_scope.pollutant_code, "o3");
      assert.equal(request.live_reference.sha256, replacementRoot.sha256);
      assert.deepEqual(request.live_body, Buffer.from(replacementRoot.body));
      return {
        artifact: replacementRoot,
        evidence: {
          key: replacementRoot.key,
          byte_size: replacementRoot.byte_size,
          sha256: replacementRoot.sha256,
          verified: true,
          durable: true,
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(recoveryCalls.length, 1);
  const latest = JSON.parse(fixture.objects.get(fixture.latestKey).toString("utf8"));
  const recovered = latest.day_summaries
    .flatMap((day) => day.scoped_roots)
    .find((root) => root.key === replacementRoot.key);
  assert.equal(recovered.sha256, replacementRoot.sha256);
  assert.notEqual(
    recovered.sha256,
    recoveryCalls[0].reference.sha256,
  );
  const diagnostic = diagnosticEvents.find(({ event }) =>
    event === "latest_global_exact_v3_scoped_reference_recovered"
  );
  assert.deepEqual(diagnostic.fields, {
    day_utc: "2026-08-01",
    connector_id: 99,
    pollutant_code: "o3",
    key: replacementRoot.key,
    stale_latest_global_sha256: recoveryCalls[0].reference.sha256,
    canonically_proven_current_sha256: replacementRoot.sha256,
    recovery_mode: "canonical_authority_same_key_recovery",
  });
});

test("unchanged strict latest references do not invoke Prune recovery", async () => {
  const fixture = buildFixture();
  let recoveryCalls = 0;
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });
  const result = await runPruneDailyObservationHistoryV3RunFinalization({
    ...fixture.options,
    connectorPublications: [connectorPublication],
    finalizeCanonicalDayManifests: finalizeCanonicalDayV3,
    recoverLatestScopedReference: async () => {
      recoveryCalls += 1;
      throw new Error("unexpected recovery");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(recoveryCalls, 0);
});

test("a missing Prune latest dependency is not treated as recoverable", async () => {
  const fixture = buildFixture();
  let recoveryCalls = 0;
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });
  fixture.objects.delete(fixture.unrelatedScopedKey);
  await assert.rejects(
    runPruneDailyObservationHistoryV3RunFinalization({
      ...fixture.options,
      connectorPublications: [connectorPublication],
      finalizeCanonicalDayManifests: finalizeCanonicalDayV3,
      recoverLatestScopedReference: async () => {
        recoveryCalls += 1;
      },
    }),
    /V3 external publication reference is missing/,
  );
  assert.equal(recoveryCalls, 0);
});

test("a changed current-run Prune scope retains the strict race failure", async () => {
  const fixture = buildFixture();
  let recoveryCalls = 0;
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });
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
  fixture.objects.set(
    replacement.v3_hierarchy.scoped_manifest.key,
    Buffer.from(replacement.v3_hierarchy.scoped_manifest.body),
  );
  await assert.rejects(
    runPruneDailyObservationHistoryV3RunFinalization({
      ...fixture.options,
      connectorPublications: [connectorPublication],
      finalizeCanonicalDayManifests: finalizeCanonicalDayV3,
      recoverLatestScopedReference: async () => {
        recoveryCalls += 1;
      },
    }),
    /V3 external publication reference identity changed/,
  );
  assert.equal(recoveryCalls, 0);
});

test("non-Prune latest identity mismatch remains strict even with a recovery adapter", async () => {
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
  let recoveryCalls = 0;
  const fixture = buildFixture();
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });
  connectorPublication.source = "integrity";
  fixture.objects.set(replacementRoot.key, Buffer.from(replacementRoot.body));

  await assert.rejects(
    runObservationHistoryV3RunFinalization({
      ...fixture.options,
      source: "integrity",
      connectorPublications: [connectorPublication],
      finalizeCanonicalDayManifests: finalizeCanonicalDayV3,
      recoverLatestScopedReference: async () => {
        recoveryCalls += 1;
      },
    }),
    /V3 external publication reference identity changed/,
  );
  assert.equal(recoveryCalls, 0);
});

test("non-Prune fixed-source adapters reject prune-eligibility reporting", async () => {
  for (const runWriter of [
    runIntegrityObservationHistoryV3Writer,
    runSosHistoricalReplacementObservationHistoryV3Writer,
    runSupportedBackfillObservationHistoryV3Writer,
  ]) {
    const fixture = buildFixture({ reportPruneEligibility: true });
    await assert.rejects(
      runWriter({
        ...fixture.options,
        partitions: fixture.options.partitions.slice(0, 1),
        ...(runWriter === runSosHistoricalReplacementObservationHistoryV3Writer
          ? {
            prepareCompleteDayReplacement: async ({ day_utc: dayUtc }) => ({
              day_utc: dayUtc,
              complete_day_replacement_verified: true,
              complete_partition_set: true,
            }),
          }
          : {}),
      }),
      /must not create Prune Daily eligibility/,
    );
    assert.equal(fixture.globalLockCount(), 0);
    assert.equal(fixture.activeLocks.size, 0);
  }
});

test("SOS complete-day preparation is day-locked before connector publication", async () => {
  const fixture = buildFixture();
  const result = await runSosHistoricalReplacementObservationHistoryV3Writer({
    ...fixture.options,
    partitions: fixture.options.partitions.slice(0, 2),
    prepareCompleteDayReplacement: async ({ day_utc: dayUtc }) => {
      fixture.events.push(`sos:complete-day:${dayUtc}`);
      assert.deepEqual([...fixture.activeLocks], ["day"]);
      return {
        day_utc: dayUtc,
        complete_day_replacement_verified: true,
        complete_partition_set: true,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete_day_replacement_results.length, 1);
  const dayPreparation = fixture.events.indexOf("sos:complete-day:2026-08-18");
  const connectorAcquire = fixture.events.indexOf(
    "lock:connector:acquire:2026-08-18/1",
  );
  assert.ok(dayPreparation >= 0 && dayPreparation < connectorAcquire);
  assert.deepEqual(
    fixture.events
      .filter((event) => event.includes(":acquire:"))
      .map((event) => event.split(":")[1]),
    ["day", "connector", "day", "global"],
  );
});
