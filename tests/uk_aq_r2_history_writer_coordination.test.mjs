import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  HISTORY_LOCK_NAMESPACES,
  evaluateIntegrityIngestBoundary,
  historyWriterLockIdentity,
  observationsGlobalOperationLockIdentity,
  isConfirmedR2ObjectAbsentError,
  mergeConnectorManifestReferences,
  readParentManifestForBoundedRecovery,
  withHistoryWriterLock,
  withObservationsGlobalOperationLock,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";

function identity(input) {
  return historyWriterLockIdentity(input);
}

test("history lock identity is database-local and environment labels do not affect it", () => {
  const resource = { namespace: HISTORY_LOCK_NAMESPACES.connectorDay, dayUtc: "2026-07-26", connectorId: 7 };
  assert.deepEqual(identity({ ...resource, environment: "TEST" }), identity({ ...resource, environment: "CIC-Test" }));
  assert.deepEqual(identity({ ...resource, environment: "LIVE" }), identity(resource));
  assert.notDeepEqual(identity(resource), identity({ ...resource, connectorId: 8 }));
  assert.notDeepEqual(identity(resource), identity({ ...resource, dayUtc: "2026-07-25" }));
});

test("history lock namespaces and resource components remain distinct", () => {
  const connector = identity({ namespace: HISTORY_LOCK_NAMESPACES.connectorDay, dayUtc: "2026-07-26", connectorId: 7 });
  const day = identity({ namespace: HISTORY_LOCK_NAMESPACES.dayFinalization, dayUtc: "2026-07-26" });
  const global = identity({ namespace: HISTORY_LOCK_NAMESPACES.globalIndex });
  assert.equal(connector.logical_identity, "uk_aq:r2_history:v1:connector_day:2026-07-26:7");
  assert.equal(day.logical_identity, "uk_aq:r2_history:v1:day_finalisation:2026-07-26");
  assert.equal(global.logical_identity, "uk_aq:r2_history:v1:global_index_finalisation");
  assert.equal(new Set([`${connector.class_id}:${connector.object_id}`, `${day.class_id}:${day.object_id}`, `${global.class_id}:${global.object_id}`]).size, 3);
});

test("history lock acquisition is bounded", async () => {
  let clock = 0;
  const client = { query: async () => ({ rows: [{ acquired: false }] }) };
  await assert.rejects(
    withHistoryWriterLock({
      client,
      namespace: HISTORY_LOCK_NAMESPACES.globalIndex,
      timeoutMs: 20,
      retryMs: 10,
      now: () => clock,
      sleep: async (delay) => { clock += delay; },
    }, async () => {}),
    (error) => error.code === "UK_AQ_HISTORY_LOCK_TIMEOUT",
  );
});

test("global observations lock has one environment- and owner-independent identity", () => {
  const expected = observationsGlobalOperationLockIdentity();
  assert.equal(
    expected.logical_identity,
    "uk_aq:r2_history:v2:observations_global_operation",
  );
  for (const _metadata of [
    { environment: "TEST", owner: "prune_daily" },
    { environment: "TEST-secondary-label", owner: "integrity" },
    { environment: "ignored", owner: "r2_history_dropbox_backup" },
  ]) {
    assert.deepEqual(observationsGlobalOperationLockIdentity(), expected);
  }
});

test("global observations lock contention is bounded on retained sessions", async () => {
  let heldBy = null;
  let clock = 0;
  const client = (name) => ({
    query: async (sql) => {
      if (sql.includes("try_advisory")) {
        if (heldBy === null) heldBy = name;
        return { rows: [{ acquired: heldBy === name }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        const released = heldBy === name;
        if (released) heldBy = null;
        return { rows: [{ released }] };
      }
      return { rows: [{ observations_global_operation_lock_heartbeat: 1 }] };
    },
  });
  let releaseFirst;
  const first = withObservationsGlobalOperationLock({
    client: client("first"), owner: "prune_daily", runId: "first", heartbeatMs: 60_000,
  }, async () => await new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    withObservationsGlobalOperationLock({
      client: client("second"),
      owner: "integrity",
      runId: "second",
      timeoutMs: 20,
      retryMs: 10,
      heartbeatMs: 60_000,
      now: () => clock,
      sleep: async (delay) => { clock += delay; },
    }, async () => {}),
    (error) => error.code === "UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_TIMEOUT",
  );
  releaseFirst();
  await first;
  assert.equal(heldBy, null);
});

test("global observations lock releases on callback failure and fails closed on session loss", async () => {
  const queries = [];
  const client = new EventEmitter();
  client.query = async (sql) => {
    queries.push(sql);
    if (sql.includes("try_advisory")) return { rows: [{ acquired: true }] };
    if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
    return { rows: [{ observations_global_operation_lock_heartbeat: 1 }] };
  };
  await assert.rejects(
    withObservationsGlobalOperationLock({
      client, owner: "backup", runId: "callback-error", heartbeatMs: 60_000,
    }, async () => { throw new Error("operation failed"); }),
    /operation failed/,
  );
  assert.equal(queries.filter((sql) => sql.includes("pg_advisory_unlock")).length, 1);

  queries.length = 0;
  await assert.rejects(
    withObservationsGlobalOperationLock({
      client, owner: "integrity", runId: "lost", heartbeatMs: 60_000,
    }, async (_identity, lock) => {
      client.emit("error", new Error("connection ended"));
      lock.assertHeld();
    }),
    (error) => error.code === "UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_LOST",
  );
  assert.equal(queries.filter((sql) => sql.includes("pg_advisory_unlock")).length, 0);
});

test("history lock is released after success, error, and cancellation", async () => {
  for (const outcome of ["success", "error", "cancellation"]) {
    const queries = [];
    const client = {
      query: async (sql) => {
        queries.push(sql);
        return { rows: [sql.includes("try_advisory") ? { acquired: true } : { released: true }] };
      },
    };
    const operation = withHistoryWriterLock({
      client,
      namespace: HISTORY_LOCK_NAMESPACES.globalIndex,
    }, async () => {
      if (outcome === "error") throw new Error("failed operation");
      if (outcome === "cancellation") {
        const error = new Error("cancelled operation");
        error.name = "AbortError";
        throw error;
      }
      return "ok";
    });
    if (outcome === "success") assert.equal(await operation, "ok");
    else await assert.rejects(operation);
    assert.equal(queries.filter((sql) => sql.includes("pg_advisory_unlock")).length, 1);
  }
});

test("day-manifest merge preserves existing connectors and replaces changed connectors", () => {
  assert.deepEqual(mergeConnectorManifestReferences(
    [{ connector_id: 1, manifest_key: "old-1" }, { connector_id: 2, manifest_key: "old-2" }],
    [{ connector_id: 2, manifest_key: "new-2" }, { connector_id: 3, manifest_key: "new-3" }],
  ), [
    { connector_id: 1, manifest_key: "old-1" },
    { connector_id: 2, manifest_key: "new-2" },
    { connector_id: 3, manifest_key: "new-3" },
  ]);
});

test("parent-manifest recovery is limited to confirmed absence or structural invalidity", async () => {
  const key = "history/v2/observations/day_utc=2026-07-26/manifest.json";
  const validate = (manifest) => {
    if (!Array.isArray(manifest.connector_manifests)) throw new Error("invalid parent structure");
    return manifest.connector_manifests;
  };

  const absent = await readParentManifestForBoundedRecovery({
    getObject: async () => { throw new Error(`R2 GET failed (404) key=${key}: NoSuchKey`); },
    key,
    validate,
  });
  assert.equal(absent.state, "absent");

  const malformedJson = await readParentManifestForBoundedRecovery({
    getObject: async () => ({ body: Buffer.from("{not-json", "utf8") }),
    key,
    validate,
  });
  assert.equal(malformedJson.state, "structurally_invalid");

  const invalidStructure = await readParentManifestForBoundedRecovery({
    getObject: async () => ({ body: Buffer.from(JSON.stringify({ connector_manifests: null }), "utf8") }),
    key,
    validate,
  });
  assert.equal(invalidStructure.state, "structurally_invalid");

  const valid = await readParentManifestForBoundedRecovery({
    getObject: async () => ({
      body: Buffer.from(JSON.stringify({ connector_manifests: [{ connector_id: 1 }] }), "utf8"),
    }),
    key,
    validate,
  });
  assert.equal(valid.state, "valid");
  assert.deepEqual(valid.value, [{ connector_id: 1 }]);

  for (const error of [
    Object.assign(new Error("R2 GET failed (403): AccessDenied"), { status: 403 }),
    new Error("GET request timed out after 30000ms"),
    new TypeError("fetch failed"),
    Object.assign(new Error("R2 service unavailable"), { status: 503 }),
  ]) {
    await assert.rejects(readParentManifestForBoundedRecovery({
      getObject: async () => { throw error; },
      key,
      validate,
    }), (caught) => caught === error);
  }
  assert.equal(isConfirmedR2ObjectAbsentError(Object.assign(new Error("missing"), { statusCode: 404 })), true);
  assert.equal(isConfirmedR2ObjectAbsentError(Object.assign(new Error("denied"), { statusCode: 403 })), false);
  assert.equal(isConfirmedR2ObjectAbsentError(Object.assign(new Error("contradictory"), { statusCode: 403, code: "NoSuchKey" })), false);
});

test("Integrity boundary reports every overlapping connector and permits connectors without rows", () => {
  const result = evaluateIntegrityIngestBoundary({
    requestedToDayUtc: "2026-07-20",
    boundaries: [
      { source: "openaq", connector_id: 1, earliest_ingest_day_utc: "2026-07-20" },
      { source: "sensorcommunity", connector_id: 2, earliest_ingest_day_utc: "2026-07-19" },
      { source: "sos", connector_id: 3, earliest_ingest_day_utc: null },
    ],
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers.map((entry) => entry.connector_id), [1, 2]);
  assert.equal(result.connectors[2].allowed, true);
});
