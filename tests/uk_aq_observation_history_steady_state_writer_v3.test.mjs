import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildObservationHistoryExactLeafIndexV3Latest as buildObservationHistoryIndexV3Latest,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  createPruneDailyObservationHistoryV3RunLocalEvidenceCache,
  runObservationHistoryV3RunFinalization,
  runIntegrityObservationHistoryV3Writer,
  runPruneDailyObservationHistoryV3ConnectorPublication,
  runPruneDailyObservationHistoryV3RunFinalization,
  runPruneDailyObservationHistoryV3Writer,
  runSelectedScopeReconciliationObservationHistoryV3Writer,
  runSosHistoricalReplacementObservationHistoryV3Writer,
  runSupportedBackfillObservationHistoryV3Writer,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  observationsGlobalOperationLockContext,
  observationsGlobalOperationLockIdentity,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
} from "../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";

const LIMITS = ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3;
const TARGET_GIT_SHA = "1".repeat(40);
const BACKED_UP_AT_UTC = "2026-08-21T00:00:00.000Z";

function selectedScopeLockEnv({ owner = "selected-scope-test", runId = "run-1" } = {}) {
  const identity = observationsGlobalOperationLockIdentity();
  return {
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: owner,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: runId,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]:
      identity.logical_identity,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: "selected-scope-test-nonce",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: "0",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
  };
}

function pruneRunLockContext(runId = "prune-evidence-run") {
  return observationsGlobalOperationLockContext({
    env: selectedScopeLockEnv({ owner: "prune_daily", runId }),
    expectedOwner: "prune_daily",
    expectedRunId: runId,
  });
}

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
  currentConnectorIdsFor = null,
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
      removed_scopes: removedScopes,
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
      const selectedScopeReconciliation =
        source === "selected_scope_reconciliation";
      const requestedRemovalPollutants = removedScopes
        .map((scope) => scope.pollutant_code)
        .sort();
      const finalPollutants = completePruneSnapshot
        ? changedPollutants
        : [...new Set([...currentPollutants, ...changedPollutants])]
          .filter((pollutantCode) =>
            !selectedScopeReconciliation ||
            !requestedRemovalPollutants.includes(pollutantCode)
          )
          .sort();
      const finalPollutantSet = new Set(finalPollutants);
      const removedPollutants = completePruneSnapshot
        ? currentPollutants.filter((pollutantCode) =>
          !finalPollutantSet.has(pollutantCode)
        )
        : selectedScopeReconciliation ? requestedRemovalPollutants : [];
      const connectorAuthorityPresent = finalPollutants.length > 0;
      return {
        connector_scope_verified: true,
        parent_state_reread_under_lock: true,
        current_day_authority_checked: selectedScopeReconciliation,
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
        removal_results: selectedScopeReconciliation
          ? removedScopes.map((scope) => ({
            ...scope,
            requested_removal: true,
            previously_authoritative:
              currentPollutants.includes(scope.pollutant_code),
            final_scope_present: false,
          }))
          : [],
        pollutant_manifests: pollutantManifests,
        connector_manifest: connectorAuthorityPresent
          ? evidence(
            `history/v3/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
          )
          : null,
        connector_manifest_payload: connectorAuthorityPresent ? {} : null,
        connector_authority_present: connectorAuthorityPresent,
        prune_eligibility_created: reportPruneEligibility,
      };
    },
    finalizeCanonicalDayManifests: async ({ day_utc: dayUtc, changed_connectors: changed }) => {
      events.push(`canonical:day:${dayUtc}`);
      if (failDay) throw new Error("fixture day failure");
      const current = typeof currentConnectorIdsFor === "function"
        ? currentConnectorIdsFor({ dayUtc, changed })
        : dayUtc === "2026-08-18" ? [9] : [8];
      const changedIds = changed.map((entry) => entry.connector_id).sort((a, b) => a - b);
      const absentIds = new Set(changed
        .filter((entry) => entry.canonical.connector_authority_present === false)
        .map((entry) => entry.connector_id));
      const finalIds = [...new Set([...current, ...changedIds])]
        .filter((connectorId) => !absentIds.has(connectorId))
        .sort((a, b) => a - b);
      dayCalls.push({ day_utc: dayUtc, current, changed: changedIds, final: finalIds });
      return {
        canonical_day_authority_verified: true,
        parent_state_reread_under_lock: true,
        day_utc: dayUtc,
        current_connector_ids: current,
        changed_connector_ids: changedIds,
        final_connector_ids: finalIds,
        day_manifest: evidence(`history/v3/observations/day_utc=${dayUtc}/manifest.json`),
      };
    },
    finalizeCanonicalAggregateManifests: async ({ affected_days_utc: affectedDays }) => {
      events.push(`canonical:aggregate:${affectedDays.join(",")}`);
      return {
        canonical_aggregate_authority_verified: true,
        parent_state_reread_under_lock: true,
        affected_days_utc: affectedDays,
        aggregate_manifests: [
          evidence("history/v3/observations/_manifests/manifest.json"),
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
    initialScopedHierarchies: [
      unrelated.v3_hierarchy,
      obsoletePruneScope.v3_hierarchy,
    ],
    unrelatedScopedKey: unrelated.v3_hierarchy.scoped_manifest.key,
    removedScopedKey: obsoletePruneScope.v3_hierarchy.scoped_manifest.key,
    activeLocks,
    globalLockCount: () => globalLockCount,
  };
}

function buildMultiReferenceRecoveryFixture({ recoverableConnectorIds = [] } = {}) {
  const fixture = buildFixture();
  const recoverableIds = new Set(recoverableConnectorIds);
  const recoveryArtifactsByKey = new Map();
  const keyByConnectorId = new Map();
  const scopedHierarchies = [...fixture.initialScopedHierarchies];

  for (let connectorId = 100; connectorId < 117; connectorId += 1) {
    const timeseriesId = 20_000 + connectorId;
    const original = buildObservationHistoryV3SteadyStatePartition({
      source: "integrity",
      rows: rows({
        dayUtc: "2026-08-05",
        connectorId,
        pollutantCode: "o3",
        timeseriesId,
      }),
      writerLimits: LIMITS,
      targetWriterGitSha: TARGET_GIT_SHA,
      backedUpAtUtc: BACKED_UP_AT_UTC,
    });
    const reference = original.v3_hierarchy.scoped_manifest;
    keyByConnectorId.set(connectorId, reference.key);
    scopedHierarchies.push(original.v3_hierarchy);
    fixture.objects.set(reference.key, Buffer.from(reference.body));

    if (recoverableIds.has(connectorId)) {
      const current = buildObservationHistoryV3SteadyStatePartition({
        source: "integrity",
        rows: rows({
          dayUtc: "2026-08-05",
          connectorId,
          pollutantCode: "o3",
          timeseriesId,
        }).map((row) => ({ ...row, value: row.value + 1 })),
        writerLimits: LIMITS,
        targetWriterGitSha: TARGET_GIT_SHA,
        backedUpAtUtc: BACKED_UP_AT_UTC,
      });
      const currentArtifact = current.v3_hierarchy.scoped_manifest;
      assert.equal(currentArtifact.key, reference.key);
      fixture.objects.set(reference.key, Buffer.from(currentArtifact.body));
      recoveryArtifactsByKey.set(reference.key, currentArtifact);
    }
  }

  const initialLatest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies,
  });
  assert.equal(initialLatest.key, fixture.latestKey);
  fixture.objects.set(initialLatest.key, Buffer.from(initialLatest.body));

  return { fixture, recoveryArtifactsByKey, keyByConnectorId };
}

function createMultiReferenceRecoveryAdapter(scenario, recoveryCalls) {
  return async (request) => {
    recoveryCalls.push(request);
    const artifact = scenario.recoveryArtifactsByKey.get(request.reference.key);
    assert.ok(artifact, `missing canonical recovery artifact for ${request.reference.key}`);
    assert.equal(request.source, "prune_daily");
    assert.equal(request.latest_scope.key, request.reference.key);
    assert.equal(request.live_reference.sha256, artifact.sha256);
    assert.deepEqual(request.live_body, Buffer.from(artifact.body));
    return {
      artifact,
      evidence: {
        key: artifact.key,
        byte_size: artifact.byte_size,
        sha256: artifact.sha256,
        verified: true,
        durable: true,
      },
      verification_object_count: 3,
      verification_concurrency: 8,
      verification_duration_ms: 25,
    };
  };
}

function finalizationEvidence({
  dayUtc,
  connectorId,
  pollutantCode,
  timeseriesId,
  objects,
  valueDelta = 0,
}) {
  const partition = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows({ dayUtc, connectorId, pollutantCode, timeseriesId })
      .map((row) => ({ ...row, value: row.value + valueDelta })),
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
          `history/v3/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
        ),
        connector_manifest_payload: {},
        connector_authority_present: true,
        removed_pollutant_codes: [],
        removed_scopes: [],
        removal_results: [],
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

test("Prune latest-global dependencies verify with at most eight GETs and reuse exact same-run evidence", async () => {
  const fixture = buildFixture();
  const lockContext = pruneRunLockContext();
  const evidenceCache = createPruneDailyObservationHistoryV3RunLocalEvidenceCache({
    lockContext,
  });
  assert.ok(evidenceCache);

  const existingHierarchies = Array.from({ length: 20 }, (_, index) => {
    const partition = buildObservationHistoryV3SteadyStatePartition({
      source: "integrity",
      rows: rows({
        dayUtc: `2025-01-${String(index + 1).padStart(2, "0")}`,
        connectorId: 90,
        pollutantCode: "o3",
        timeseriesId: 9_000 + index,
      }),
      writerLimits: LIMITS,
      targetWriterGitSha: TARGET_GIT_SHA,
      backedUpAtUtc: BACKED_UP_AT_UTC,
    });
    fixture.objects.set(
      partition.v3_hierarchy.scoped_manifest.key,
      Buffer.from(partition.v3_hierarchy.scoped_manifest.body),
    );
    return partition.v3_hierarchy;
  });
  const initialLatest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: existingHierarchies,
  });
  assert.equal(initialLatest.key, fixture.latestKey);
  fixture.objects.set(initialLatest.key, Buffer.from(initialLatest.body));

  const baseGetObject = fixture.options.getObject;
  let activeRequests = 0;
  let highestActiveRequests = 0;
  const measuredGetObject = async ({ key, onR2GetAdmitted = null }) => {
    if (typeof onR2GetAdmitted !== "function") {
      return await baseGetObject({ key });
    }
    onR2GetAdmitted();
    activeRequests += 1;
    highestActiveRequests = Math.max(highestActiveRequests, activeRequests);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return await baseGetObject({ key });
    } finally {
      activeRequests -= 1;
    }
  };
  const runDiagnostics = [];
  const finalizeOneDay = async ({ dayUtc, connectorId, pollutantCode, timeseriesId, valueDelta }) => {
    const publication = finalizationEvidence({
      dayUtc,
      connectorId,
      pollutantCode,
      timeseriesId,
      objects: fixture.objects,
      valueDelta,
    });
    return await runPruneDailyObservationHistoryV3RunFinalization({
      ...fixture.options,
      connectorPublications: [publication],
      getObject: measuredGetObject,
      runLocalReferenceEvidenceCache: evidenceCache,
      globalOperationLockContext: lockContext,
      diagnosticLog: (event, fields) => runDiagnostics.push({ event, fields }),
    });
  };

  const first = await finalizeOneDay({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
  });
  assert.equal(first.ok, true);
  const firstMetrics = runDiagnostics.find(({ event }) =>
    event === "run_finalization_complete"
  ).fields;
  assert.equal(firstMetrics.latest_global_dependency_count, 21);
  assert.equal(firstMetrics.latest_global_dependency_r2_get_count, 21);
  assert.equal(firstMetrics.accepted_same_run_evidence_reuse_count, 0);
  assert.equal(firstMetrics.maximum_active_verification_requests, 8);
  assert.equal(highestActiveRequests, 8);
  assert.equal(evidenceCache.entryCount(), 21);

  highestActiveRequests = 0;
  runDiagnostics.length = 0;
  const changedSameKey = await finalizeOneDay({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    valueDelta: 10,
  });
  assert.equal(changedSameKey.ok, true);
  const changedMetrics = runDiagnostics.find(({ event }) =>
    event === "run_finalization_complete"
  ).fields;
  assert.equal(changedMetrics.latest_global_dependency_count, 21);
  assert.equal(changedMetrics.latest_global_dependency_r2_get_count, 1);
  assert.equal(changedMetrics.accepted_same_run_evidence_reuse_count, 20);
  assert.equal(changedMetrics.evidence_invalidation_count, 1);
  assert.equal(changedMetrics.maximum_active_verification_requests, 1);
  assert.equal(highestActiveRequests, 1);
  assert.equal(evidenceCache.entryCount(), 21);

  highestActiveRequests = 0;
  runDiagnostics.length = 0;
  const third = await finalizeOneDay({
    dayUtc: "2026-08-19",
    connectorId: 2,
    pollutantCode: "no2",
    timeseriesId: 202,
  });
  assert.equal(third.ok, true);
  const thirdMetrics = runDiagnostics.find(({ event }) =>
    event === "run_finalization_complete"
  ).fields;
  assert.equal(thirdMetrics.latest_global_dependency_count, 22);
  assert.equal(thirdMetrics.latest_global_dependency_r2_get_count, 1);
  assert.equal(thirdMetrics.accepted_same_run_evidence_reuse_count, 21);
  assert.equal(thirdMetrics.maximum_active_verification_requests, 1);
  assert.equal(highestActiveRequests, 1);
  assert.equal(evidenceCache.entryCount(), 22);
});

test("Prune run-local evidence requires exact identity and invalidates on key mutation", () => {
  const lockContext = pruneRunLockContext();
  const cache = createPruneDailyObservationHistoryV3RunLocalEvidenceCache({
    lockContext,
  });
  const body = Buffer.from("scoped-root", "utf8");
  const reference = {
    key: "history/_index_v3/observations_timeseries/day_utc=2025-01-01/connector_id=1/pollutant_code=no2/manifest.json",
    byte_size: body.byteLength,
    sha256: sha256(body),
  };
  const verified = {
    ...reference,
    verified: true,
    durable: true,
  };
  assert.equal(cache.remember(reference, verified), true);
  cache.recordFinalizedDependencies([reference]);
  assert.deepEqual(cache.getVerified(reference), verified);
  assert.equal(cache.getVerified({ ...reference, byte_size: reference.byte_size + 1 }), null);
  assert.equal(cache.takeInvalidationCount(), 1);

  assert.equal(cache.remember(reference, verified), true);
  cache.recordFinalizedDependencies([reference]);
  assert.equal(cache.invalidateKey(reference.key), true);
  assert.equal(cache.getVerified(reference), null);
  assert.equal(cache.takeInvalidationCount(), 1);

  const removedReference = {
    ...reference,
    key: `${reference.key}.removed`,
  };
  const removedVerified = {
    ...verified,
    key: removedReference.key,
  };
  assert.equal(cache.remember(reference, verified), true);
  assert.equal(cache.remember(removedReference, removedVerified), true);
  cache.recordFinalizedDependencies([reference, removedReference]);
  cache.recordFinalizedDependencies([reference]);
  assert.equal(cache.entryCount(), 1);
  assert.equal(cache.getVerified(removedReference), null);
  assert.equal(cache.takeInvalidationCount(), 1);

  const otherRun = pruneRunLockContext("another-prune-run");
  assert.equal(cache.matches(otherRun), false);
  cache.clear();
  assert.equal(cache.entryCount(), 0);
  assert.equal(cache.getVerified(reference), null);
});

test("latest-global dependency verification stops at a request budget failure and reports it", async () => {
  const fixture = buildFixture();
  const existingHierarchies = Array.from({ length: 10 }, (_, index) => {
    const partition = buildObservationHistoryV3SteadyStatePartition({
      source: "integrity",
      rows: rows({
        dayUtc: `2025-02-${String(index + 1).padStart(2, "0")}`,
        connectorId: 91,
        pollutantCode: "o3",
        timeseriesId: 9_100 + index,
      }),
      writerLimits: LIMITS,
      targetWriterGitSha: TARGET_GIT_SHA,
      backedUpAtUtc: BACKED_UP_AT_UTC,
    });
    fixture.objects.set(
      partition.v3_hierarchy.scoped_manifest.key,
      Buffer.from(partition.v3_hierarchy.scoped_manifest.body),
    );
    return partition.v3_hierarchy;
  });
  const initialLatest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: existingHierarchies,
  });
  fixture.objects.set(initialLatest.key, Buffer.from(initialLatest.body));

  const budgetError = Object.assign(new Error("dependency GET budget exhausted"), {
    name: "PhaseBHistoryBudgetExhaustedError",
    code: "PHASE_B_HISTORY_BUDGET_EXHAUSTED",
    operation: "v3_run_finalization_r2_read",
  });
  const baseGetObject = fixture.options.getObject;
  let admittedDependencies = 0;
  let actualDependencyGets = 0;
  const budgetedGetObject = async ({ key, onR2GetAdmitted = null }) => {
    if (typeof onR2GetAdmitted === "function") {
      admittedDependencies += 1;
      if (admittedDependencies === 1) throw budgetError;
      onR2GetAdmitted();
      actualDependencyGets += 1;
    }
    return await baseGetObject({ key });
  };
  const diagnostics = [];
  const publication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });

  await assert.rejects(
    runPruneDailyObservationHistoryV3RunFinalization({
      ...fixture.options,
      connectorPublications: [publication],
      getObject: budgetedGetObject,
      diagnosticLog: (event, fields) => diagnostics.push({ event, fields }),
    }),
    (error) => error === budgetError,
  );
  assert.equal(admittedDependencies, 8);
  assert.equal(actualDependencyGets, 7);
  assert.equal(
    fixture.publicationCalls.filter((call) => call.stage === "latest_global").length,
    0,
  );
  const failure = diagnostics.find(({ event }) =>
    event === "latest_global_exact_v3_finalization_failed"
  );
  assert.equal(failure.fields.failure_outcome, "budget_stop");
  assert.equal(failure.fields.latest_global_dependency_count, 11);
  assert.equal(failure.fields.latest_global_dependency_r2_get_count, 7);
  assert.equal(failure.fields.maximum_active_verification_requests, 7);
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

test("fixed selected-scope adapter performs removal-only finalization without empty child output", async () => {
  const fixture = buildFixture({
    currentPollutantsFor: ({ dayUtc, connectorId }) =>
      dayUtc === "2026-08-18" && connectorId === 1 ? ["o3"] : [],
    currentConnectorIdsFor: ({ dayUtc }) =>
      dayUtc === "2026-08-18" ? [1, 9] : [],
  });
  const removedScope = {
    day_utc: "2026-08-18",
    connector_id: 1,
    pollutant_code: "o3",
  };
  const result = await runSelectedScopeReconciliationObservationHistoryV3Writer({
    ...fixture.options,
    env: selectedScopeLockEnv(),
    expectedObservationsGlobalOperationLockOwner: "selected-scope-test",
    expectedObservationsGlobalOperationLockRunId: "run-1",
    partitions: [],
    removedScopes: [removedScope],
  });

  assert.deepEqual(result.removed_scopes, [removedScope]);
  assert.equal(result.removal_results.length, 1);
  assert.deepEqual(
    {
      day_utc: result.removal_results[0].day_utc,
      connector_id: result.removal_results[0].connector_id,
      pollutant_code: result.removal_results[0].pollutant_code,
      requested_removal: result.removal_results[0].requested_removal,
      previously_authoritative:
        result.removal_results[0].previously_authoritative,
      final_scope_present: result.removal_results[0].final_scope_present,
    },
    {
      ...removedScope,
      requested_removal: true,
      previously_authoritative: true,
      final_scope_present: false,
    },
  );
  assert.equal(
    result.removal_results[0]
      .canonical_connector_result.connector_authority_present,
    false,
  );
  assert.deepEqual(
    result.removal_results[0].canonical_day_result.final_connector_ids,
    [9],
  );
  assert.equal(
    result.removal_results[0]
      .exact_v3_removal_result.removed_from_latest_global,
    true,
  );

  const latest = JSON.parse(fixture.objects.get(fixture.latestKey).toString("utf8"));
  const latestRoots = latest.day_summaries.flatMap((day) => day.scoped_roots);
  assert.equal(latestRoots.some((root) =>
    root.day_utc === removedScope.day_utc &&
    root.connector_id === removedScope.connector_id &&
    root.pollutant_code === removedScope.pollutant_code
  ), false);
  assert.equal(latestRoots.some((root) => root.connector_id === 99), true);
  assert.equal(
    fixture.events.some((event) => event.startsWith("parquet:")),
    false,
  );
  assert.deepEqual(
    fixture.publicationCalls.map((entry) => entry.stage),
    ["latest_global"],
  );
});

test("selected-scope removal rejects missing authority, malformed input, duplicates, and replace/remove overlap", async () => {
  const scope = {
    day_utc: "2026-08-18",
    connector_id: 1,
    pollutant_code: "pm25",
  };
  const fixture = buildFixture();
  assert.throws(
    () => runSelectedScopeReconciliationObservationHistoryV3Writer({
      ...fixture.options,
      env: {},
      partitions: [],
      removedScopes: [scope],
    }),
    /valid coordinator-owned observations global operation lock context/,
  );
  await assert.rejects(
    runSelectedScopeReconciliationObservationHistoryV3Writer({
      ...fixture.options,
      env: selectedScopeLockEnv(),
      partitions: [fixture.options.partitions[0]],
      removedScopes: [scope],
    }),
    /cannot be both replaced and removed/,
  );
  await assert.rejects(
    runSelectedScopeReconciliationObservationHistoryV3Writer({
      ...fixture.options,
      env: selectedScopeLockEnv(),
      partitions: [],
      removedScopes: [scope, scope],
    }),
    /duplicate removal scope/,
  );
  await assert.rejects(
    runSelectedScopeReconciliationObservationHistoryV3Writer({
      ...fixture.options,
      env: selectedScopeLockEnv(),
      partitions: [],
      removedScopes: [{ ...scope, pollutant_code: "PM2.5" }],
    }),
    /pollutant_code is invalid/,
  );
  assert.equal(fixture.connectorCalls.length, 0);
  assert.equal(
    fixture.events.some((event) => event.startsWith("parquet:")),
    false,
  );
});

test("existing fixed-source adapters cannot acquire selected-scope removal authority", async () => {
  const removedScopes = [{
    day_utc: "2026-08-18",
    connector_id: 1,
    pollutant_code: "o3",
  }];
  for (const writer of [
    runPruneDailyObservationHistoryV3Writer,
    runIntegrityObservationHistoryV3Writer,
    runSosHistoricalReplacementObservationHistoryV3Writer,
    runSupportedBackfillObservationHistoryV3Writer,
  ]) {
    const fixture = buildFixture();
    await assert.rejects(
      writer({
        ...fixture.options,
        removedScopes,
      }),
      /not authorised for selected-scope removal/,
    );
    assert.equal(fixture.connectorCalls.length, 0);
    assert.equal(
      fixture.events.some((event) => event.startsWith("parquet:")),
      false,
    );
  }
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
        verification_object_count: 3,
        verification_concurrency: 8,
        verification_duration_ms: 25,
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
    verification_object_count: 3,
    verification_concurrency: 8,
    verification_duration_ms: 25,
  });
});

test("Prune recovers stale roots across bounded batches and freshly verifies all dependencies before publication", async () => {
  const recoverableConnectorIds = [101, 115];
  const scenario = buildMultiReferenceRecoveryFixture({
    recoverableConnectorIds,
  });
  const { fixture } = scenario;
  const recoveryCalls = [];
  const diagnosticEvents = [];
  const initialGetCounts = new Map();
  const strictGetCounts = new Map();
  const baseGetObject = fixture.options.getObject;
  let activeRequests = 0;
  let highestActiveRequests = 0;
  const getObject = async ({ key, onR2GetAdmitted = null }) => {
    if (typeof onR2GetAdmitted !== "function") {
      return await baseGetObject({ key });
    }
    const phase = recoveryCalls.length === recoverableConnectorIds.length
      ? "strict"
      : "initial";
    onR2GetAdmitted();
    const counts = phase === "strict" ? strictGetCounts : initialGetCounts;
    counts.set(key, (counts.get(key) || 0) + 1);
    activeRequests += 1;
    highestActiveRequests = Math.max(highestActiveRequests, activeRequests);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const object = await baseGetObject({ key });
      if (phase === "strict") {
        fixture.events.push(`test:strict_get_complete:${key}`);
      }
      return object;
    } finally {
      activeRequests -= 1;
    }
  };
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
    getObject,
    diagnosticLog: (event, fields) => diagnosticEvents.push({ event, fields }),
    recoverLatestScopedReference: createMultiReferenceRecoveryAdapter(
      scenario,
      recoveryCalls,
    ),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    recoveryCalls.map(({ latest_scope: scope }) => scope.connector_id),
    recoverableConnectorIds,
  );
  assert.deepEqual(
    recoveryCalls.map(({ latest_scope: scope }) => scope.pollutant_code),
    ["o3", "o3"],
  );

  const publishedLatest = JSON.parse(
    fixture.objects.get(fixture.latestKey).toString("utf8"),
  );
  const publishedKeys = publishedLatest.day_summaries.flatMap((day) =>
    day.scoped_roots.map((root) => root.key)
  ).sort();
  assert.deepEqual([...initialGetCounts.keys()].sort(), publishedKeys);
  assert.deepEqual([...strictGetCounts.keys()].sort(), publishedKeys);
  assert.ok([...initialGetCounts.values()].every((count) => count === 1));
  assert.ok([...strictGetCounts.values()].every((count) => count === 1));
  assert.equal(highestActiveRequests, 8);

  const latestPublicationIndex = fixture.events.findIndex((event) =>
    event.startsWith("v3:put:latest_global:")
  );
  const strictGetCompletionIndexes = fixture.events
    .map((event, index) => [event, index])
    .filter(([event]) => event.startsWith("test:strict_get_complete:"))
    .map(([, index]) => index);
  assert.equal(strictGetCompletionIndexes.length, publishedKeys.length);
  assert.ok(strictGetCompletionIndexes.every((index) =>
    index < latestPublicationIndex
  ));

  const complete = diagnosticEvents.find(({ event }) =>
    event === "run_finalization_complete"
  ).fields;
  assert.equal(complete.latest_global_dependency_count, publishedKeys.length);
  assert.equal(
    complete.latest_global_dependency_r2_get_count,
    publishedKeys.length * 2,
  );
  assert.equal(complete.accepted_same_run_evidence_reuse_count, 0);
  assert.equal(complete.recovered_scoped_reference_count, 2);
  assert.equal(complete.maximum_active_verification_requests, 8);
});

test("Prune recovers multiple stale roots from one completed dependency batch in order", async () => {
  const recoverableConnectorIds = [101, 103];
  const scenario = buildMultiReferenceRecoveryFixture({
    recoverableConnectorIds,
  });
  const { fixture } = scenario;
  const recoveryCalls = [];
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
    recoverLatestScopedReference: createMultiReferenceRecoveryAdapter(
      scenario,
      recoveryCalls,
    ),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    recoveryCalls.map(({ latest_scope: scope }) => scope.connector_id),
    recoverableConnectorIds,
  );
  const publishedLatest = JSON.parse(
    fixture.objects.get(fixture.latestKey).toString("utf8"),
  );
  const firstBatchKeys = publishedLatest.day_summaries.flatMap((day) =>
    day.scoped_roots.map((root) => root.key)
  ).slice(0, 8);
  assert.ok(firstBatchKeys.includes(scenario.keyByConnectorId.get(101)));
  assert.ok(firstBatchKeys.includes(scenario.keyByConnectorId.get(103)));
});

test("a later missing dependency stops batch admission after earlier Prune recovery", async () => {
  const scenario = buildMultiReferenceRecoveryFixture({
    recoverableConnectorIds: [101],
  });
  const { fixture } = scenario;
  const missingKey = scenario.keyByConnectorId.get(110);
  fixture.objects.delete(missingKey);
  const recoveryCalls = [];
  const admittedKeys = [];
  const diagnostics = [];
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });

  await assert.rejects(
    runPruneDailyObservationHistoryV3RunFinalization({
      ...fixture.options,
      connectorPublications: [connectorPublication],
      finalizeCanonicalDayManifests: finalizeCanonicalDayV3,
      getObject: async ({ key, onR2GetAdmitted = null }) => {
        onR2GetAdmitted?.();
        if (typeof onR2GetAdmitted === "function") admittedKeys.push(key);
        return await fixture.options.getObject({ key });
      },
      diagnosticLog: (event, fields) => diagnostics.push({ event, fields }),
      recoverLatestScopedReference: createMultiReferenceRecoveryAdapter(
        scenario,
        recoveryCalls,
      ),
    }),
    /V3 external publication reference is missing/,
  );

  assert.deepEqual(
    recoveryCalls.map(({ latest_scope: scope }) => scope.connector_id),
    [101],
  );
  assert.ok(admittedKeys.includes(missingKey));
  assert.equal(admittedKeys.includes(scenario.keyByConnectorId.get(115)), false);
  assert.equal(
    fixture.publicationCalls.filter((call) => call.stage === "latest_global").length,
    0,
  );
  const failure = diagnostics.find(({ event }) =>
    event === "run_finalization_failed"
  ).fields;
  assert.equal(failure.failure_outcome, "failed_closed");
  assert.equal(failure.recovered_scoped_reference_count, 1);
  assert.equal(failure.latest_global_dependency_r2_get_count, 16);
});

test("Phase B budget exhaustion after a recoverable batch prevents later dependency batches", async () => {
  const scenario = buildMultiReferenceRecoveryFixture({
    recoverableConnectorIds: [101],
  });
  const { fixture } = scenario;
  const budgetKey = scenario.keyByConnectorId.get(110);
  const budgetError = Object.assign(new Error("dependency GET budget exhausted"), {
    name: "PhaseBHistoryBudgetExhaustedError",
    code: "PHASE_B_HISTORY_BUDGET_EXHAUSTED",
    operation: "v3_run_finalization_r2_read",
  });
  const recoveryCalls = [];
  const admittedKeys = [];
  const diagnostics = [];
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });

  await assert.rejects(
    runPruneDailyObservationHistoryV3RunFinalization({
      ...fixture.options,
      connectorPublications: [connectorPublication],
      finalizeCanonicalDayManifests: finalizeCanonicalDayV3,
      getObject: async ({ key, onR2GetAdmitted = null }) => {
        if (key === budgetKey) throw budgetError;
        onR2GetAdmitted?.();
        if (typeof onR2GetAdmitted === "function") admittedKeys.push(key);
        return await fixture.options.getObject({ key });
      },
      diagnosticLog: (event, fields) => diagnostics.push({ event, fields }),
      recoverLatestScopedReference: createMultiReferenceRecoveryAdapter(
        scenario,
        recoveryCalls,
      ),
    }),
    (error) => error === budgetError,
  );

  assert.deepEqual(
    recoveryCalls.map(({ latest_scope: scope }) => scope.connector_id),
    [101],
  );
  assert.equal(admittedKeys.includes(budgetKey), false);
  assert.equal(admittedKeys.includes(scenario.keyByConnectorId.get(115)), false);
  const failure = diagnostics.find(({ event }) =>
    event === "run_finalization_failed"
  ).fields;
  assert.equal(failure.failure_outcome, "budget_stop");
  assert.equal(failure.recovered_scoped_reference_count, 1);
  assert.equal(failure.latest_global_dependency_r2_get_count, 15);
  assert.equal(
    fixture.publicationCalls.filter((call) => call.stage === "latest_global").length,
    0,
  );
});

test("Prune emits recovered-scope evidence before the strict final dependency reread", async () => {
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
  const fixture = buildFixture();
  const connectorPublication = finalizationEvidence({
    dayUtc: "2026-08-18",
    connectorId: 1,
    pollutantCode: "pm25",
    timeseriesId: 101,
    objects: fixture.objects,
  });
  fixture.objects.set(replacementRoot.key, Buffer.from(replacementRoot.body));
  const baseGetObject = fixture.options.getObject;
  let recoveryCompleted = false;
  const finalRereadError = new Error("controlled strict final dependency reread failure");

  await assert.rejects(
    runPruneDailyObservationHistoryV3RunFinalization({
      ...fixture.options,
      connectorPublications: [connectorPublication],
      finalizeCanonicalDayManifests: finalizeCanonicalDayV3,
      diagnosticLog: (event, fields) => diagnosticEvents.push({ event, fields }),
      getObject: async ({ key }) => {
        if (recoveryCompleted && key === replacementRoot.key) {
          throw finalRereadError;
        }
        return await baseGetObject({ key });
      },
      recoverLatestScopedReference: async () => {
        recoveryCompleted = true;
        return {
          artifact: replacementRoot,
          evidence: {
            key: replacementRoot.key,
            byte_size: replacementRoot.byte_size,
            sha256: replacementRoot.sha256,
            verified: true,
            durable: true,
          },
          verification_object_count: 3,
          verification_concurrency: 8,
          verification_duration_ms: 25,
        };
      },
    }),
    (error) => error === finalRereadError,
  );

  assert.ok(diagnosticEvents.some(({ event }) =>
    event === "latest_global_exact_v3_scoped_reference_recovered"
  ));
  assert.equal(
    fixture.publicationCalls.filter((call) => call.stage === "latest_global").length,
    0,
  );
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
