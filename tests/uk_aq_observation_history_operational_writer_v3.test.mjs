import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createObservationHistoryV3CanonicalConnectorPublisher,
  createObservationHistoryV3CanonicalAggregatePublisher,
  createObservationHistoryV3CanonicalDayPublisher,
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

test("steady-state preparation represents authoritative empty pollutant scope", () => {
  const prepared = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    scope: {
      day_utc: DAY_UTC,
      connector_id: 1,
      pollutant_code: "o3",
    },
    rows: [],
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  assert.deepEqual(prepared.scope, {
    day_utc: DAY_UTC,
    connector_id: 1,
    pollutant_code: "o3",
  });
  assert.equal(prepared.target_metadata.row_count, 0);
  assert.equal(prepared.file_intents.length, 0);
  assert.equal(prepared.canonical_pollutant_manifest.payload.row_count, 0);
  assert.equal(prepared.v3_hierarchy.child_shards.length, 0);
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
    "history/v2/observations",
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
    "history/v2/observations",
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
  const publisher = createObservationHistoryV3CanonicalAggregatePublisher({
    r2: { bucket: "test" },
    getObject: async ({ key: requested }) => {
      assert.equal(requested, key);
      return { body };
    },
    recordDurableEvidence: async () => ({ durable: true }),
    hierarchyFinalizer: async (options) => {
      assert.deepEqual(options.affectedDaysUtc, [DAY_UTC]);
      assert.equal(options.writeR2, true);
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
