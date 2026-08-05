import assert from "node:assert/strict";
import test from "node:test";

import { runPruneDailyJob } from "../workers/uk_aq_prune_daily/job.mjs";

test("Prune Daily finalises the exact observation hierarchy branch inside task health", async () => {
  const events = [];
  let finalizerArgs = null;
  let writtenPayload = null;
  const runSummary = {
    mode: "delete",
    phase_b_history: {
      global_index_finalization: {
        affected_days_utc: ["2026-07-31", "2026-08-01"],
      },
    },
  };

  const payload = await runPruneDailyJob({
    env: {},
    buildRunConfigAdapter: () => ({ dryRun: false }),
    executePruneDailyAdapter: async (_config, adapters) => adapters.withDailyTaskRun(
      { task_key: "ops.prune_daily" },
      async () => {
        events.push("prune_complete");
        return runSummary;
      },
    ),
    withDailyTaskRunAdapter: async (_options, callback) => {
      events.push("task_started");
      const result = await callback();
      events.push("task_finished");
      return result;
    },
    resolveR2HistoryIndexConfigAdapter: () => ({
      r2: { bucket: "uk-aq-history-cic-test" },
      observations_prefix_v2: "history/v2/observations",
      max_keys: 500,
    }),
    finalizerAdapter: async (args) => {
      events.push("hierarchy_finalized");
      finalizerArgs = args;
      return { ok: true, status: "written", execution: { wrote_object_count: 4 } };
    },
    writeReportAdapter: async (value) => {
      writtenPayload = value;
    },
    reportPruneDailyErrorAdapter: async () => assert.fail("unexpected error path"),
    setExitCode: () => assert.fail("unexpected non-zero exit"),
  });

  assert.deepEqual(events, [
    "task_started",
    "prune_complete",
    "hierarchy_finalized",
    "task_finished",
  ]);
  assert.deepEqual(finalizerArgs.affectedDaysUtc, ["2026-07-31", "2026-08-01"]);
  assert.equal(finalizerArgs.observationsPrefix, "history/v2/observations");
  assert.equal(finalizerArgs.maxKeys, 500);
  assert.equal(finalizerArgs.writeR2, true);
  assert.equal(payload.summary.observations_manifest_hierarchy.status, "written");
  assert.deepEqual(writtenPayload, payload);
});

test("Prune Daily dry-run records a hierarchy skip without calling the writer", async () => {
  let finalizerCalls = 0;
  const payload = await runPruneDailyJob({
    env: { INPUT_DRY_RUN: "true" },
    buildRunConfigAdapter: () => ({ dryRun: true }),
    executePruneDailyAdapter: async (_config, adapters) => adapters.withDailyTaskRun(
      { task_key: "ops.prune_daily" },
      async () => ({
        mode: "dry-run",
        phase_b_history: {
          global_index_finalization: {
            affected_days_utc: ["2026-08-01"],
          },
        },
      }),
    ),
    withDailyTaskRunAdapter: async (_options, callback) => callback(),
    finalizerAdapter: async () => {
      finalizerCalls += 1;
      return { ok: true };
    },
    writeReportAdapter: async () => {},
    reportPruneDailyErrorAdapter: async () => assert.fail("unexpected error path"),
    setExitCode: () => assert.fail("unexpected non-zero exit"),
  });

  assert.equal(finalizerCalls, 0);
  assert.equal(payload.summary.observations_manifest_hierarchy.status, "skipped");
  assert.equal(payload.summary.observations_manifest_hierarchy.reason, "prune_daily_dry_run");
});
