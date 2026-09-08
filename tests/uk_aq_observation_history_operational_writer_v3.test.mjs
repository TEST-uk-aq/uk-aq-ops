import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createObservationHistoryV3CanonicalConnectorPublisher,
  createObservationHistoryV3CanonicalAggregatePublisher,
  createObservationHistoryV3CanonicalDayPublisher,
  createObservationHistoryV3LatestScopedReferenceRecovery,
  runDisconnectedPruneDailyObservationHistoryV3Writer,
  runOperationalPruneDailyObservationHistoryV3ConnectorPublication,
} from "../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest,
  buildHistoryV2DayManifestKey,
} from "../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  assertAcceptedObservationHistoryWriterLimitsV3,
} from "../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";

const TARGET_GIT_SHA = "2".repeat(40);
const DAY_UTC = "2026-08-18";
const OBSERVATIONS_PREFIX = "history/v3/observations";
const EXACT_INDEX_ROOT = "history/_index_v3/observations_timeseries";

function rows(pollutantCode, timeseriesId) {
  return [{
    connector_id: 1,
    station_id: 10,
    timeseries_id: timeseriesId,
    pollutant_code: pollutantCode,
    observed_at_utc: `${DAY_UTC}T00:00:00.000Z`,
    value: 12.5,
    verification_status: null,
  }];
}

function rowsFor(connectorId, pollutantCode, timeseriesId, value = 12.5) {
  return rows(pollutantCode, timeseriesId).map((row) => ({
    ...row,
    connector_id: connectorId,
    station_id: connectorId * 10,
    value,
  }));
}

function recoveryRows(count, valueOffset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    connector_id: 1,
    station_id: 1000 + index,
    timeseries_id: 1000 + index,
    pollutant_code: "no2",
    observed_at_utc: `${DAY_UTC}T00:00:00.000Z`,
    value: 10 + index + valueOffset,
    verification_status: null,
  }));
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function connectorFromPartition({ connectorId, partition, backedUpAtUtc }) {
  const key = buildHistoryV2ConnectorManifestKey(
    "history/v2/observations",
    DAY_UTC,
    connectorId,
  );
  return buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    connectorId,
    runId: null,
    manifestKey: key,
    pollutantManifests: [partition.canonical_pollutant_manifest.payload],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc,
  });
}

function changedConnectorEntry(payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  return {
    connector_id: payload.connector_id,
    canonical: {
      connector_manifest_payload: payload,
      connector_manifest: {
        key: payload.manifest_key,
        byte_size: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        verified: true,
        durable: true,
      },
    },
  };
}

function currentConnectorFromPartitions(partitions) {
  const connectorId = partitions[0].scope.connector_id;
  const key = buildHistoryV2ConnectorManifestKey(
    OBSERVATIONS_PREFIX,
    DAY_UTC,
    connectorId,
  );
  return buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    connectorId,
    runId: null,
    manifestKey: key,
    pollutantManifests: partitions.map(
      (partition) => partition.canonical_pollutant_manifest.payload,
    ),
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
}

function recoveryObjects(partition, connector = currentConnectorFromPartitions([partition])) {
  return new Map([
    [connector.manifest_key, Buffer.from(JSON.stringify(connector, null, 2))],
    [
      partition.canonical_pollutant_manifest.key,
      Buffer.from(partition.canonical_pollutant_manifest.body),
    ],
    ...partition.file_intents.map((intent) => [intent.key, Buffer.from(intent.body)]),
    ...partition.v3_hierarchy.publication_objects.map((artifact) => [
      artifact.key,
      Buffer.from(artifact.body),
    ]),
  ]);
}

function latestRecoveryRequest({ stale, current }) {
  return {
    source: "prune_daily",
    reference: {
      key: stale.key,
      byte_size: stale.byte_size,
      sha256: stale.sha256,
    },
    latest_scope: {
      day_utc: stale.payload.day_utc,
      connector_id: stale.payload.connector_id,
      pollutant_code: stale.payload.pollutant_code,
      key: stale.key,
      byte_size: stale.byte_size,
      sha256: stale.sha256,
    },
    live_reference: {
      key: current.key,
      byte_size: current.byte_size,
      sha256: current.sha256,
    },
    live_body: Buffer.from(current.body),
    observations_prefix: OBSERVATIONS_PREFIX,
    index_root: EXACT_INDEX_ROOT,
  };
}

test("selected aligned-v2 writer limits are exact and reject drift", () => {
  assert.equal(
    assertAcceptedObservationHistoryWriterLimitsV3({
      ...ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
    }),
    ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  );
  assert.throws(
    () => assertAcceptedObservationHistoryWriterLimitsV3({
      ...ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
      max_file_rows: 131071,
    }),
    /max_file_rows must equal the selected aligned-v2 value 131072/,
  );
  assert.throws(
    () => assertAcceptedObservationHistoryWriterLimitsV3({
      ...ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
      tunable_override: 1,
    }),
    /exactly the selected aligned-v2 fields/,
  );
});

test("Prune latest recovery independently rebuilds and verifies the current exact scope", async () => {
  const stale = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 101),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const current = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 101).map((row) => ({ ...row, value: 14.5 })),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const objects = recoveryObjects(current);
  const reads = [];
  const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
    observationsPrefix: OBSERVATIONS_PREFIX,
    indexRoot: EXACT_INDEX_ROOT,
    getObject: async ({ key }) => {
      reads.push(key);
      return objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false };
    },
  });
  const result = await recover(latestRecoveryRequest({
    stale: stale.v3_hierarchy.scoped_manifest,
    current: current.v3_hierarchy.scoped_manifest,
  }));

  assert.equal(result.artifact.sha256, current.v3_hierarchy.scoped_manifest.sha256);
  assert.equal(result.evidence.sha256, current.v3_hierarchy.scoped_manifest.sha256);
  assert.notEqual(result.artifact.sha256, stale.v3_hierarchy.scoped_manifest.sha256);
  assert.equal(
    result.verification_object_count,
    current.v3_hierarchy.publication_objects.length,
  );
  assert.equal(result.verification_concurrency, 8);
  assert.ok(Number.isSafeInteger(result.verification_duration_ms));
  assert.ok(reads.includes(current.canonical_pollutant_manifest.key));
  assert.ok(current.file_intents.every((intent) => reads.includes(intent.key)));
  assert.ok(current.v3_hierarchy.publication_objects.every((artifact) =>
    artifact.key === current.v3_hierarchy.scoped_manifest.key ||
    reads.includes(artifact.key)
  ));
});

test("Prune latest recovery verifies rebuilt exact-v3 artifacts with bounded concurrency", async () => {
  const stale = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: recoveryRows(20),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const current = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: recoveryRows(20, 1),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const objects = recoveryObjects(current);
  const verificationKeys = new Set(
    current.v3_hierarchy.publication_objects
      .filter((artifact) => artifact.key !== current.v3_hierarchy.scoped_manifest.key)
      .map((artifact) => artifact.key),
  );
  assert.ok(verificationKeys.size >= 8);
  const eightStarted = deferred();
  const releaseReads = deferred();
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
    observationsPrefix: OBSERVATIONS_PREFIX,
    indexRoot: EXACT_INDEX_ROOT,
    getObject: async ({ key }) => {
      if (verificationKeys.has(key)) {
        started += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (started === 8) eightStarted.resolve();
        await releaseReads.promise;
        active -= 1;
      }
      return objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false };
    },
  });
  const recovery = recover(latestRecoveryRequest({
    stale: stale.v3_hierarchy.scoped_manifest,
    current: current.v3_hierarchy.scoped_manifest,
  }));

  await eightStarted.promise;
  assert.equal(active, 8);
  assert.equal(maximumActive, 8);
  releaseReads.resolve();
  const result = await recovery;

  assert.equal(result.verification_concurrency, 8);
  assert.equal(
    result.verification_object_count,
    current.v3_hierarchy.publication_objects.length,
  );
  assert.equal(started, verificationKeys.size);
  assert.throws(
    () => createObservationHistoryV3LatestScopedReferenceRecovery({
      observationsPrefix: OBSERVATIONS_PREFIX,
      indexRoot: EXACT_INDEX_ROOT,
      exactV3PublicationConcurrency: 17,
      getObject: async () => ({ exists: false }),
    }),
    /verification concurrency must be an integer from 1 to 16/,
  );
});

test("Prune latest recovery stops new verification launches and preserves failures", async (t) => {
  const stale = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: recoveryRows(6),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const current = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: recoveryRows(6, 1),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const request = latestRecoveryRequest({
    stale: stale.v3_hierarchy.scoped_manifest,
    current: current.v3_hierarchy.scoped_manifest,
  });
  const verificationKeys = current.v3_hierarchy.publication_objects
    .filter((artifact) => artifact.key !== current.v3_hierarchy.scoped_manifest.key)
    .map((artifact) => artifact.key);

  await t.test("exact identity failure", async () => {
    const objects = recoveryObjects(current);
    const bothStarted = deferred();
    const releaseFailure = deferred();
    const releaseSibling = deferred();
    const started = [];
    const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
      observationsPrefix: OBSERVATIONS_PREFIX,
      indexRoot: EXACT_INDEX_ROOT,
      exactV3PublicationConcurrency: 2,
      getObject: async ({ key }) => {
        if (verificationKeys.includes(key)) {
          started.push(key);
          if (started.length === 2) bothStarted.resolve();
          if (key === verificationKeys[0]) {
            await releaseFailure.promise;
            return { exists: true, body: Buffer.from("wrong identity") };
          }
          await releaseSibling.promise;
        }
        return objects.has(key)
          ? { exists: true, body: Buffer.from(objects.get(key)) }
          : { exists: false };
      },
    });
    const recovery = recover(request);
    await bothStarted.promise;
    releaseFailure.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 2);
    releaseSibling.resolve();
    await assert.rejects(
      recovery,
      /Canonically rebuilt exact-v3 dependency identity disagrees/,
    );
    assert.equal(started.length, 2);
  });

  await t.test("Phase B budget error", async () => {
    const objects = recoveryObjects(current);
    const bothStarted = deferred();
    const releaseFailure = deferred();
    const releaseSibling = deferred();
    const started = [];
    const budgetError = Object.assign(new Error("controlled Phase B budget"), {
      name: "PhaseBHistoryBudgetExhaustedError",
      code: "PHASE_B_HISTORY_BUDGET_EXHAUSTED",
    });
    const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
      observationsPrefix: OBSERVATIONS_PREFIX,
      indexRoot: EXACT_INDEX_ROOT,
      exactV3PublicationConcurrency: 2,
      getObject: async ({ key }) => {
        if (verificationKeys.includes(key)) {
          started.push(key);
          if (started.length === 2) bothStarted.resolve();
          if (key === verificationKeys[0]) {
            await releaseFailure.promise;
            throw budgetError;
          }
          await releaseSibling.promise;
        }
        return objects.has(key)
          ? { exists: true, body: Buffer.from(objects.get(key)) }
          : { exists: false };
      },
    });
    const recovery = recover(request);
    await bothStarted.promise;
    releaseFailure.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 2);
    releaseSibling.resolve();
    await assert.rejects(recovery, (error) => error === budgetError);
    assert.equal(started.length, 2);
  });
});

test("Prune latest recovery rejects a live scoped object outside current canonical authority", async () => {
  const stale = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 101),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const canonical = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 101).map((row) => ({ ...row, value: 14.5 })),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const wrongLive = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 101).map((row) => ({ ...row, value: 99 })),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-23T00:00:00.000Z",
  });
  const objects = recoveryObjects(canonical);
  const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
    observationsPrefix: OBSERVATIONS_PREFIX,
    indexRoot: EXACT_INDEX_ROOT,
    getObject: async ({ key }) => objects.has(key)
      ? { exists: true, body: Buffer.from(objects.get(key)) }
      : { exists: false },
  });

  await assert.rejects(
    recover(latestRecoveryRequest({
      stale: stale.v3_hierarchy.scoped_manifest,
      current: wrongLive.v3_hierarchy.scoped_manifest,
    })),
    /Live exact-v3 scoped identity does not match current canonical authority/,
  );
});

test("Prune latest recovery rejects malformed or contradictory canonical authority", async (t) => {
  const stale = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 101),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const current = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 101).map((row) => ({ ...row, value: 14.5 })),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const request = latestRecoveryRequest({
    stale: stale.v3_hierarchy.scoped_manifest,
    current: current.v3_hierarchy.scoped_manifest,
  });

  await t.test("malformed connector parent", async () => {
    const objects = recoveryObjects(current);
    const connector = currentConnectorFromPartitions([current]);
    objects.set(connector.manifest_key, Buffer.from("{bad json", "utf8"));
    const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
      observationsPrefix: OBSERVATIONS_PREFIX,
      indexRoot: EXACT_INDEX_ROOT,
      getObject: async ({ key }) => objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false },
    });
    await assert.rejects(recover(request), /manifest is invalid JSON/);
  });

  await t.test("missing connector parent", async () => {
    const objects = recoveryObjects(current);
    const connector = currentConnectorFromPartitions([current]);
    objects.delete(connector.manifest_key);
    const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
      observationsPrefix: OBSERVATIONS_PREFIX,
      indexRoot: EXACT_INDEX_ROOT,
      getObject: async ({ key }) => objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false },
    });
    await assert.rejects(recover(request), /connector manifest is missing/);
  });

  await t.test("pollutant child contradicts parent descriptor", async () => {
    const objects = recoveryObjects(current);
    objects.set(
      current.canonical_pollutant_manifest.key,
      Buffer.from(stale.canonical_pollutant_manifest.body),
    );
    const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
      observationsPrefix: OBSERVATIONS_PREFIX,
      indexRoot: EXACT_INDEX_ROOT,
      getObject: async ({ key }) => objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false },
    });
    await assert.rejects(
      recover(request),
      /pollutant child contradicts its connector descriptor/,
    );
  });

  await t.test("canonical Parquet identity contradicts pollutant authority", async () => {
    const objects = recoveryObjects(current);
    const parquetKey = current.file_intents[0].key;
    const body = Buffer.from(objects.get(parquetKey));
    body[0] ^= 0xff;
    objects.set(parquetKey, body);
    const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
      observationsPrefix: OBSERVATIONS_PREFIX,
      indexRoot: EXACT_INDEX_ROOT,
      getObject: async ({ key }) => objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false },
    });
    await assert.rejects(
      recover(request),
      /canonical Parquet identity disagrees/,
    );
  });

  await t.test("pollutant absent from current connector", async () => {
    const pm25 = buildObservationHistoryV3SteadyStatePartition({
      source: "prune_daily",
      rows: rows("pm25", 102),
      targetWriterGitSha: TARGET_GIT_SHA,
      backedUpAtUtc: "2026-08-22T00:00:00.000Z",
    });
    const connector = currentConnectorFromPartitions([pm25]);
    const objects = recoveryObjects(current, connector);
    const recover = createObservationHistoryV3LatestScopedReferenceRecovery({
      observationsPrefix: OBSERVATIONS_PREFIX,
      indexRoot: EXACT_INDEX_ROOT,
      getObject: async ({ key }) => objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false },
    });
    await assert.rejects(
      recover(request),
      /does not authorise pollutant no2/,
    );
  });
});

test("steady-state preparation rejects an empty exact-v3 pollutant scope", () => {
  assert.throws(
    () => buildObservationHistoryV3SteadyStatePartition({
      source: "integrity",
      scope: {
        day_utc: DAY_UTC,
        connector_id: 1,
        pollutant_code: "o3",
      },
      rows: [],
      targetWriterGitSha: TARGET_GIT_SHA,
      backedUpAtUtc: "2026-08-22T00:00:00.000Z",
    }),
    /exact-v3 publication requires a non-empty canonical scope/,
  );
});

test("connector publisher rereads and preserves unchanged pollutant union", async () => {
  const currentO3 = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows("o3", 101),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const changedPm25 = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows("pm25", 102),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    "history/v3/observations",
    DAY_UTC,
    1,
  );
  const currentConnector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    connectorId: 1,
    runId: null,
    manifestKey: connectorKey,
    pollutantManifests: [currentO3.canonical_pollutant_manifest.payload],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const objects = new Map([
    [
      currentO3.canonical_pollutant_manifest.key,
      Buffer.from(currentO3.canonical_pollutant_manifest.body),
    ],
    [connectorKey, Buffer.from(JSON.stringify(currentConnector, null, 2), "utf8")],
  ]);
  const events = [];
  const publisher = createObservationHistoryV3CanonicalConnectorPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => {
      events.push(`get:${key}`);
      return objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false };
    },
    putIfChanged: async ({ key, body }) => {
      events.push(`put:${key}`);
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async ({ key }) => {
      events.push(`durable:${key}`);
      return { durable: true };
    },
  });
  const fileEvidence = changedPm25.file_intents.map((intent) => ({
    key: intent.key,
    byte_size: intent.byte_size,
    sha256: intent.sha256,
    verified: true,
    durable: true,
  }));
  const result = await publisher({
    source: "integrity",
    day_utc: DAY_UTC,
    connector_id: 1,
    partitions: [{
      scope: changedPm25.scope,
      target_metadata: changedPm25.target_metadata,
      pollutant_manifest: changedPm25.canonical_pollutant_manifest,
      file_evidence: fileEvidence,
      v3_hierarchy: changedPm25.v3_hierarchy,
    }],
  });

  assert.equal(result.parent_state_reread_under_lock, true);
  assert.deepEqual(result.current_pollutant_codes, ["o3"]);
  assert.deepEqual(result.changed_pollutant_codes, ["pm25"]);
  assert.deepEqual(result.final_pollutant_codes, ["o3", "pm25"]);
  assert.deepEqual(result.removed_pollutant_codes, []);
  assert.deepEqual(result.removed_scopes, []);
  assert.deepEqual(
    result.connector_manifest_payload.pollutant_codes,
    ["o3", "pm25"],
  );
  assert.ok(events.indexOf(`get:${connectorKey}`) < events.indexOf(
    `put:${changedPm25.canonical_pollutant_manifest.key}`,
  ));
  await assert.rejects(
    publisher({
      source: "sos_historical_replacement",
      day_utc: DAY_UTC,
      connector_id: 1,
      partitions: [{
        scope: changedPm25.scope,
        target_metadata: changedPm25.target_metadata,
        pollutant_manifest: changedPm25.canonical_pollutant_manifest,
        file_evidence: fileEvidence,
        v3_hierarchy: changedPm25.v3_hierarchy,
      }],
    }),
    /SOS complete-day replacement found live connector state after deletion/,
  );
});

test("operational writer accepts an R2 404 for a brand-new connector-day manifest", async () => {
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    "history/v2/observations",
    DAY_UTC,
    1,
  );
  const objects = new Map();
  const events = [];
  const result = await runOperationalPruneDailyObservationHistoryV3ConnectorPublication({
    env: { UK_AQ_R2_HISTORY_INDEX_VERSION: "v3" },
    client: { query: async () => ({ rows: [] }) },
    r2: { bucket: "test" },
    partitions: [{ rows: rows("pm25", 101) }],
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
    getObject: async ({ key }) => {
      events.push(`get:${key}`);
      if (key === connectorKey && !objects.has(key)) {
        const error = new Error(
          `R2 GET failed (404)\nkey=${key}\nCode=NoSuchKey`,
        );
        error.status = 404;
        error.code = "NoSuchKey";
        throw error;
      }
      return objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false };
    },
    putIfChanged: async ({ key, body }) => {
      events.push(`put:${key}`);
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async () => ({ durable: true }),
    putAndVerifyParquet: async ({ intent }) => ({
      key: intent.key,
      byte_size: intent.byte_size,
      sha256: intent.sha256,
    }),
    withConnectorDayLock: async (_options, callback) => await callback(),
  });

  assert.equal(result.connector_publication_complete, true);
  assert.deepEqual(
    result.connector_results[0].canonical.current_pollutant_codes,
    [],
  );
  assert.deepEqual(
    result.connector_results[0].canonical.final_pollutant_codes,
    ["pm25"],
  );
  assert.ok(objects.has(connectorKey));
  assert.ok(
    events.indexOf(`get:${connectorKey}`) < events.indexOf(`put:${connectorKey}`),
  );
});

test("Prune connector publisher replaces the complete pollutant set and reports removed scopes", async () => {
  const currentPm25 = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("pm25", 101),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const currentNo2 = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 102),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const changedPm25 = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("pm25", 101).map((row) => ({ ...row, value: row.value + 1 })),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    "history/v3/observations",
    DAY_UTC,
    1,
  );
  const currentConnector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    connectorId: 1,
    runId: null,
    manifestKey: connectorKey,
    pollutantManifests: [
      currentPm25.canonical_pollutant_manifest.payload,
      currentNo2.canonical_pollutant_manifest.payload,
    ],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const objects = new Map([
    [currentPm25.canonical_pollutant_manifest.key, Buffer.from(currentPm25.canonical_pollutant_manifest.body)],
    [currentNo2.canonical_pollutant_manifest.key, Buffer.from(currentNo2.canonical_pollutant_manifest.body)],
    [connectorKey, Buffer.from(JSON.stringify(currentConnector, null, 2), "utf8")],
  ]);
  const publisher = createObservationHistoryV3CanonicalConnectorPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => objects.has(key)
      ? { exists: true, body: Buffer.from(objects.get(key)) }
      : { exists: false },
    putIfChanged: async ({ key, body }) => {
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async () => ({ durable: true }),
  });
  const result = await publisher({
    source: "prune_daily",
    day_utc: DAY_UTC,
    connector_id: 1,
    partitions: [{
      scope: changedPm25.scope,
      target_metadata: changedPm25.target_metadata,
      pollutant_manifest: changedPm25.canonical_pollutant_manifest,
      file_evidence: changedPm25.file_intents.map((intent) => ({
        key: intent.key,
        byte_size: intent.byte_size,
        sha256: intent.sha256,
        verified: true,
        durable: true,
      })),
      v3_hierarchy: changedPm25.v3_hierarchy,
    }],
  });

  assert.deepEqual(result.current_pollutant_codes, ["no2", "pm25"]);
  assert.deepEqual(result.changed_pollutant_codes, ["pm25"]);
  assert.deepEqual(result.final_pollutant_codes, ["pm25"]);
  assert.deepEqual(result.removed_pollutant_codes, ["no2"]);
  assert.deepEqual(result.removed_scopes, [{
    day_utc: DAY_UTC,
    connector_id: 1,
    pollutant_code: "no2",
  }]);
  assert.deepEqual(result.connector_manifest_payload.pollutant_codes, ["pm25"]);
});

test("Prune complete snapshot recovers from a parent-pinned older child beneath a newer orphan body", async () => {
  const previousPm25 = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("pm25", 101),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const previousNo2 = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("no2", 102),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const selectedPm25 = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("pm25", 101).map((row) => ({ ...row, value: 99 })),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    "history/v3/observations",
    DAY_UTC,
    1,
  );
  const previousConnector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    connectorId: 1,
    runId: null,
    manifestKey: connectorKey,
    pollutantManifests: [
      previousPm25.canonical_pollutant_manifest.payload,
      previousNo2.canonical_pollutant_manifest.payload,
    ],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const objects = new Map([
    [connectorKey, Buffer.from(JSON.stringify(previousConnector, null, 2), "utf8")],
    // This newer body is durable but is not selected by previousConnector.
    [selectedPm25.canonical_pollutant_manifest.key, Buffer.from(selectedPm25.canonical_pollutant_manifest.body)],
  ]);
  const reads = [];
  const publisher = createObservationHistoryV3CanonicalConnectorPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => {
      reads.push(key);
      return objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false };
    },
    putIfChanged: async ({ key, body }) => {
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async () => ({ durable: true }),
  });
  const result = await publisher({
    source: "prune_daily",
    day_utc: DAY_UTC,
    connector_id: 1,
    partitions: [{
      scope: selectedPm25.scope,
      target_metadata: selectedPm25.target_metadata,
      pollutant_manifest: selectedPm25.canonical_pollutant_manifest,
      file_evidence: selectedPm25.file_intents.map((intent) => ({
        key: intent.key,
        byte_size: intent.byte_size,
        sha256: intent.sha256,
        verified: true,
        durable: true,
      })),
      v3_hierarchy: selectedPm25.v3_hierarchy,
    }],
  });

  assert.equal(
    result.current_child_validation_mode,
    "parent_descriptors_only_complete_snapshot",
  );
  assert.deepEqual(result.current_pollutant_codes, ["no2", "pm25"]);
  assert.deepEqual(result.final_pollutant_codes, ["pm25"]);
  assert.deepEqual(result.removed_pollutant_codes, ["no2"]);
  assert.deepEqual(result.connector_manifest_payload.pollutant_codes, ["pm25"]);
  assert.equal(
    result.connector_manifest_payload.pollutant_manifests[0].manifest_hash,
    selectedPm25.canonical_pollutant_manifest.payload.manifest_hash,
  );
  assert.ok(!reads.includes(previousNo2.canonical_pollutant_manifest.key));
});

test("targeted connector publication still rejects a live child that contradicts its current parent", async () => {
  const previousO3 = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows("o3", 101),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const orphanO3 = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows("o3", 101).map((row) => ({ ...row, value: 88 })),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-21T00:00:00.000Z",
  });
  const selectedPm25 = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows("pm25", 102),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    "history/v3/observations",
    DAY_UTC,
    1,
  );
  const previousConnector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    connectorId: 1,
    runId: null,
    manifestKey: connectorKey,
    pollutantManifests: [previousO3.canonical_pollutant_manifest.payload],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const objects = new Map([
    [connectorKey, Buffer.from(JSON.stringify(previousConnector, null, 2), "utf8")],
    [orphanO3.canonical_pollutant_manifest.key, Buffer.from(orphanO3.canonical_pollutant_manifest.body)],
  ]);
  let putCount = 0;
  const publisher = createObservationHistoryV3CanonicalConnectorPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => objects.has(key)
      ? { exists: true, body: Buffer.from(objects.get(key)) }
      : { exists: false },
    putIfChanged: async () => {
      putCount += 1;
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async () => ({ durable: true }),
  });

  await assert.rejects(
    publisher({
      source: "integrity",
      day_utc: DAY_UTC,
      connector_id: 1,
      partitions: [{
        scope: selectedPm25.scope,
        target_metadata: selectedPm25.target_metadata,
        pollutant_manifest: selectedPm25.canonical_pollutant_manifest,
        file_evidence: selectedPm25.file_intents.map((intent) => ({
          key: intent.key,
          byte_size: intent.byte_size,
          sha256: intent.sha256,
          verified: true,
          durable: true,
        })),
        v3_hierarchy: selectedPm25.v3_hierarchy,
      }],
    }),
    /Current pollutant child identity disagrees/,
  );
  assert.equal(putCount, 0);
});

test("day publisher creates verified canonical parent from changed connector authority", async () => {
  const partition = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("pm25", 102),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    "history/v2/observations",
    DAY_UTC,
    1,
  );
  const connectorPayload = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    connectorId: 1,
    runId: null,
    manifestKey: connectorKey,
    pollutantManifests: [partition.canonical_pollutant_manifest.payload],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const objects = new Map([[connectorKey, Buffer.from(JSON.stringify(connectorPayload, null, 2))]]);
  const events = [];
  const publisher = createObservationHistoryV3CanonicalDayPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => {
      events.push(`get:${key}`);
      return objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false };
    },
    putIfChanged: async ({ key, body }) => {
      events.push(`put:${key}`);
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async ({ key }) => {
      events.push(`durable:${key}`);
      return { durable: true };
    },
  });
  const result = await publisher({
    day_utc: DAY_UTC,
    changed_connectors: [changedConnectorEntry(connectorPayload)],
  });
  assert.equal(result.canonical_day_authority_verified, true);
  assert.deepEqual(result.current_connector_ids, []);
  assert.deepEqual(result.changed_connector_ids, [1]);
  assert.deepEqual(result.final_connector_ids, [1]);
  assert.equal(
    result.day_manifest.key,
    buildHistoryV2DayManifestKey("history/v2/observations", DAY_UTC),
  );
  const dayKey = result.day_manifest.key;
  const putIndex = events.indexOf(`put:${dayKey}`);
  const readbackIndex = events.lastIndexOf(`get:${dayKey}`);
  const durableIndex = events.indexOf(`durable:${dayKey}`);
  assert.ok(putIndex >= 0 && putIndex < readbackIndex);
  assert.ok(readbackIndex < durableIndex);
});

test("day publisher fails closed when canonical day authority is missing after publication", async () => {
  const partition = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rows("pm25", 102),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const connectorPayload = connectorFromPartition({
    connectorId: 1,
    partition,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const connectorBody = Buffer.from(JSON.stringify(connectorPayload, null, 2));
  const publisher = createObservationHistoryV3CanonicalDayPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => key === connectorPayload.manifest_key
      ? { exists: true, body: connectorBody }
      : { exists: false },
    putIfChanged: async () => ({ ok: true, status: "written" }),
    recordDurableEvidence: async () => ({ durable: true }),
  });

  await assert.rejects(
    publisher({
      day_utc: DAY_UTC,
      changed_connectors: [changedConnectorEntry(connectorPayload)],
    }),
    /Published canonical manifest is missing/,
  );
});

test("day publisher replaces one stale parent child with exact changed evidence and retains unrelated connectors", async () => {
  const oldOnePartition = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rowsFor(1, "pm25", 101, 10),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const newOnePartition = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rowsFor(1, "pm25", 101, 11),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const twoPartition = buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rowsFor(2, "no2", 201, 20),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-21T00:00:00.000Z",
  });
  const oldOne = connectorFromPartition({
    connectorId: 1,
    partition: oldOnePartition,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const newOne = connectorFromPartition({
    connectorId: 1,
    partition: newOnePartition,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const unchangedTwo = connectorFromPartition({
    connectorId: 2,
    partition: twoPartition,
    backedUpAtUtc: "2026-08-21T00:00:00.000Z",
  });
  const dayKey = buildHistoryV2DayManifestKey(
    "history/v2/observations",
    DAY_UTC,
  );
  const oldDay = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    runId: null,
    manifestKey: dayKey,
    connectorManifests: [oldOne, unchangedTwo],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-21T00:00:00.000Z",
  });
  const objects = new Map([
    [dayKey, Buffer.from(JSON.stringify(oldDay, null, 2))],
    [newOne.manifest_key, Buffer.from(JSON.stringify(newOne, null, 2))],
    [unchangedTwo.manifest_key, Buffer.from(JSON.stringify(unchangedTwo, null, 2))],
  ]);
  const publisher = createObservationHistoryV3CanonicalDayPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => objects.has(key)
      ? { exists: true, body: Buffer.from(objects.get(key)) }
      : { exists: false },
    putIfChanged: async ({ key, body }) => {
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async () => ({ durable: true }),
  });

  const result = await publisher({
    day_utc: DAY_UTC,
    changed_connectors: [changedConnectorEntry(newOne)],
  });
  const nextByConnector = new Map(
    result.day_manifest_payload.connector_manifests.map((entry) => [
      Number(entry.connector_id),
      entry,
    ]),
  );
  assert.equal(nextByConnector.get(1).manifest_hash, newOne.manifest_hash);
  assert.equal(nextByConnector.get(2).manifest_hash, unchangedTwo.manifest_hash);
  assert.deepEqual(result.final_connector_ids, [1, 2]);
});

test("day publisher fails closed on changed and unchanged connector drift", async () => {
  const partition = (connectorId, value) => buildObservationHistoryV3SteadyStatePartition({
    source: "prune_daily",
    rows: rowsFor(connectorId, connectorId === 1 ? "pm25" : "no2", connectorId * 100 + 1, value),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const oldOne = connectorFromPartition({ connectorId: 1, partition: partition(1, 10), backedUpAtUtc: "2026-08-20T00:00:00.000Z" });
  const newOneA = connectorFromPartition({ connectorId: 1, partition: partition(1, 11), backedUpAtUtc: "2026-08-22T00:00:00.000Z" });
  const newOneB = connectorFromPartition({ connectorId: 1, partition: partition(1, 12), backedUpAtUtc: "2026-08-22T00:00:00.000Z" });
  const twoA = connectorFromPartition({ connectorId: 2, partition: partition(2, 20), backedUpAtUtc: "2026-08-21T00:00:00.000Z" });
  const twoB = connectorFromPartition({ connectorId: 2, partition: partition(2, 21), backedUpAtUtc: "2026-08-22T00:00:00.000Z" });
  const dayKey = buildHistoryV2DayManifestKey("history/v2/observations", DAY_UTC);
  const oldDay = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    runId: null,
    manifestKey: dayKey,
    connectorManifests: [oldOne, twoA],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-21T00:00:00.000Z",
  });
  const makePublisher = (liveOne, liveTwo) => createObservationHistoryV3CanonicalDayPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => ({
      exists: true,
      body: Buffer.from(JSON.stringify(
        key === dayKey ? oldDay : key === liveOne.manifest_key ? liveOne : liveTwo,
        null,
        2,
      )),
    }),
    putIfChanged: async () => ({ ok: true, status: "written" }),
    recordDurableEvidence: async () => ({ durable: true }),
  });

  await assert.rejects(
    makePublisher(newOneB, twoA)({
      day_utc: DAY_UTC,
      changed_connectors: [changedConnectorEntry(newOneA)],
    }),
    /identity.*disagrees|connector.*drift/i,
  );
  await assert.rejects(
    makePublisher(newOneA, twoB)({
      day_utc: DAY_UTC,
      changed_connectors: [changedConnectorEntry(newOneA)],
    }),
    /identity.*disagrees|connector.*drift/i,
  );
});

test("aggregate publisher returns durable identities for hierarchy objects", async () => {
  const key = "history/v2/observations/_manifests/manifest.json";
  const body = Buffer.from('{"kind":"test"}', "utf8");
  const getObject = async ({ key: requested }) => {
    assert.equal(requested, key);
    return { body };
  };
  const putObject = async () => ({ ok: true });
  const listAllCommonPrefixes = async () => [];
  const publisher = createObservationHistoryV3CanonicalAggregatePublisher({
    r2: { bucket: "test" },
    getObject,
    putObject,
    listAllCommonPrefixes,
    recordDurableEvidence: async () => ({ durable: true }),
    hierarchyFinalizer: async (options) => {
      assert.deepEqual(options.affectedDaysUtc, [DAY_UTC]);
      assert.equal(options.writeR2, true);
      assert.equal(options.adapters.getObject, getObject);
      assert.equal(options.adapters.putObject, putObject);
      assert.equal(
        options.adapters.listAllCommonPrefixes,
        listAllCommonPrefixes,
      );
      return { ok: true, objects: [{ key }] };
    },
  });
  const result = await publisher({ affected_days_utc: [DAY_UTC] });
  assert.equal(result.canonical_aggregate_authority_verified, true);
  assert.equal(result.aggregate_manifests[0].key, key);
  assert.equal(result.aggregate_manifests[0].byte_size, body.byteLength);
  assert.match(result.aggregate_manifests[0].sha256, /^[0-9a-f]{64}$/);
});

test("disconnected operational entry point is v3-only", () => {
  assert.throws(
    () => runDisconnectedPruneDailyObservationHistoryV3Writer({
      env: { UK_AQ_R2_HISTORY_INDEX_VERSION: "v2" },
    }),
    /Unsupported observation-history index generation for v3 builder: v2/,
  );
});
