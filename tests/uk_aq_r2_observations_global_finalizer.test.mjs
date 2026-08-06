import assert from "node:assert/strict";
import test from "node:test";

import {
  runCanonicalObservationsGlobalFinalizer,
} from "../workers/shared/uk_aq_r2_observations_global_finalizer.mjs";

test("shared observations finaliser locks once and runs indexes before hierarchy", async () => {
  const events = [];
  let lockArgs = null;
  let hierarchyArgs = null;

  const result = await runCanonicalObservationsGlobalFinalizer({
    client: { query: async () => ({ rows: [] }) },
    diagnosticEnvironment: "CIC-Test",
    diagnostics: [],
    timeoutMs: 12_345,
    r2: { bucket: "uk-aq-history-cic-test" },
    observationsPrefix: "history/v2/observations",
    affectedDaysUtc: ["2026-08-02", "2026-08-01", "2026-08-02"],
    maxKeys: 500,
    finalizeExistingIndexes: async () => {
      events.push("indexes");
      return {
        status: "indexes_written",
        planned_index_object_count: 4,
      };
    },
    runCanonicalGlobalIndexFinalizerAdapter: async (args) => {
      lockArgs = args;
      events.push("lock_entered");
      const value = await args.finalize();
      events.push("lock_exited");
      return value;
    },
    hierarchyFinalizerAdapter: async (args) => {
      hierarchyArgs = args;
      events.push("hierarchy");
      return {
        ok: true,
        status: "written",
        execution: { wrote_object_count: 4 },
      };
    },
  });

  assert.deepEqual(events, ["lock_entered", "indexes", "hierarchy", "lock_exited"]);
  assert.equal(lockArgs.diagnosticEnvironment, "CIC-Test");
  assert.equal(lockArgs.timeoutMs, 12_345);
  assert.deepEqual(hierarchyArgs.affectedDaysUtc, ["2026-08-01", "2026-08-02"]);
  assert.equal(hierarchyArgs.observationsPrefix, "history/v2/observations");
  assert.equal(hierarchyArgs.maxKeys, 500);
  assert.equal(hierarchyArgs.writeR2, true);
  assert.equal(result.status, "indexes_written");
  assert.equal(result.planned_index_object_count, 4);
  assert.deepEqual(result.affected_days_utc, ["2026-08-01", "2026-08-02"]);
  assert.equal(result.index_finalization.planned_index_object_count, 4);
  assert.equal(result.observations_manifest_hierarchy.status, "written");
});

test("shared observations finaliser propagates hierarchy failure inside the lock", async () => {
  const events = [];

  await assert.rejects(
    runCanonicalObservationsGlobalFinalizer({
      client: { query: async () => ({ rows: [] }) },
      r2: { bucket: "uk-aq-history-cic-test" },
      observationsPrefix: "history/v2/observations",
      affectedDaysUtc: ["2026-08-01"],
      finalizeExistingIndexes: async () => {
        events.push("indexes");
        return { ok: true };
      },
      runCanonicalGlobalIndexFinalizerAdapter: async (args) => {
        events.push("lock_entered");
        return await args.finalize();
      },
      hierarchyFinalizerAdapter: async () => {
        events.push("hierarchy");
        throw new Error("hierarchy verification failed");
      },
    }),
    /hierarchy verification failed/,
  );

  assert.deepEqual(events, ["lock_entered", "indexes", "hierarchy"]);
});

test("shared observations finaliser skips without taking the lock when no days changed", async () => {
  let lockCalls = 0;
  let indexCalls = 0;
  let hierarchyCalls = 0;

  const result = await runCanonicalObservationsGlobalFinalizer({
    client: { query: async () => ({ rows: [] }) },
    r2: { bucket: "uk-aq-history-cic-test" },
    observationsPrefix: "history/v2/observations",
    affectedDaysUtc: [],
    finalizeExistingIndexes: async () => {
      indexCalls += 1;
    },
    runCanonicalGlobalIndexFinalizerAdapter: async () => {
      lockCalls += 1;
    },
    hierarchyFinalizerAdapter: async () => {
      hierarchyCalls += 1;
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no_affected_days");
  assert.equal(lockCalls, 0);
  assert.equal(indexCalls, 0);
  assert.equal(hierarchyCalls, 0);
});
