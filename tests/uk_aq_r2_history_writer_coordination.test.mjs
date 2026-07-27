import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_LOCK_NAMESPACES,
  evaluateIntegrityIngestBoundary,
  historyWriterLockIdentity,
  mergeConnectorManifestReferences,
  withHistoryWriterLock,
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
