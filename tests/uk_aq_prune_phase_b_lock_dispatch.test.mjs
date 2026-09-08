import assert from "node:assert/strict";
import test from "node:test";

import {
  runPhaseBCandidateObservationWriteForTest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

const CONNECTOR_DAY_OPTIONS = Object.freeze({
  client: Object.freeze({}),
  dayUtc: "2026-08-18",
  connectorId: 7,
  diagnosticEnvironment: "TEST",
  diagnostics: Object.freeze([]),
  timeoutMs: 15_000,
});

test("Phase B v2 preserves the outer connector-day writer lock", async () => {
  const events = [];
  const result = await runPhaseBCandidateObservationWriteForTest({
    historyWriteVersion: "v2",
    connectorDayWriterOptions: CONNECTOR_DAY_OPTIONS,
    connectorDayWriter: async (options) => {
      assert.equal(options.client, CONNECTOR_DAY_OPTIONS.client);
      assert.equal(options.dayUtc, CONNECTOR_DAY_OPTIONS.dayUtc);
      assert.equal(options.connectorId, CONNECTOR_DAY_OPTIONS.connectorId);
      assert.equal(options.timeoutMs, CONNECTOR_DAY_OPTIONS.timeoutMs);
      events.push("outer_lock_acquired");
      const written = await options.write();
      const verified = await options.verify(written);
      events.push("outer_lock_released");
      return { written, verified };
    },
    write: async () => {
      events.push("gate_incomplete");
      events.push("v2_publication");
      return { publication: "v2" };
    },
    verify: async (written) => {
      assert.deepEqual(written, { publication: "v2" });
      events.push("verification");
      return { durable: true };
    },
  });

  assert.deepEqual(events, [
    "outer_lock_acquired",
    "gate_incomplete",
    "v2_publication",
    "verification",
    "outer_lock_released",
  ]);
  assert.deepEqual(result, {
    written: { publication: "v2" },
    verified: { durable: true },
  });
});

test("Phase B v3 relies on the v3 writer lock and verifies after it returns", async () => {
  const events = [];
  let outerLockCalls = 0;
  const result = await runPhaseBCandidateObservationWriteForTest({
    historyWriteVersion: "v3",
    connectorDayWriterOptions: CONNECTOR_DAY_OPTIONS,
    connectorDayWriter: async () => {
      outerLockCalls += 1;
      throw new Error("v3 must not acquire the Phase B outer connector-day lock");
    },
    write: async () => {
      events.push("gate_incomplete");
      events.push("v3_writer_lock_acquired");
      events.push("v3_publication_durable");
      events.push("v3_writer_lock_released");
      return { publication: "v3", durable: true };
    },
    verify: async (written) => {
      assert.equal(events.at(-1), "v3_writer_lock_released");
      assert.deepEqual(written, { publication: "v3", durable: true });
      events.push("verification");
      return { verified: true };
    },
  });

  assert.equal(outerLockCalls, 0);
  assert.deepEqual(events, [
    "gate_incomplete",
    "v3_writer_lock_acquired",
    "v3_publication_durable",
    "v3_writer_lock_released",
    "verification",
  ]);
  assert.deepEqual(result, {
    written: { publication: "v3", durable: true },
    verified: { verified: true },
  });
});
