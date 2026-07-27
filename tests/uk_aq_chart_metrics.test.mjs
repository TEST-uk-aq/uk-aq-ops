import assert from "node:assert/strict";
import test from "node:test";

import {
  executeChartMetrics,
  resolveChartMetricsConfig,
  runChartMetricsMaintenance,
} from "../workers/uk_aq_chart_metrics/job.mjs";

test("standalone chart metrics keeps the existing cleanup and refresh RPC contract", async () => {
  const calls = [];
  const createClientAdapter = () => ({
    schema: (schema) => ({
      rpc: async (name, payload) => {
        calls.push({ schema, name, payload });
        return name.includes("cleanup")
          ? { data: [{ rows_deleted: 4 }], error: null }
          : { data: [{ rows_upserted: 8, days_refreshed: 7 }], error: null };
      },
    }),
  });
  const config = resolveChartMetricsConfig({
    OBS_AQIDB_SUPABASE_URL: "https://example.supabase.co",
    OBS_AQIDB_SECRET_KEY: "secret",
  });
  const summary = await runChartMetricsMaintenance(config, { createClientAdapter });
  assert.deepEqual(calls.map((entry) => entry.name), [
    "uk_aq_rpc_chart_load_metrics_cleanup",
    "uk_aq_rpc_chart_load_metrics_daily_refresh",
  ]);
  assert.equal(summary.raw_rows_deleted, 4);
  assert.equal(summary.daily_rows_upserted, 8);
});

test("standalone chart metrics uses its own task-health identity", async () => {
  let input;
  await executeChartMetrics({
    OBS_AQIDB_SUPABASE_URL: "https://example.supabase.co",
    OBS_AQIDB_SECRET_KEY: "secret",
  }, {
    withDailyTaskRun: async (value, callback) => {
      input = value;
      return await callback();
    },
    createClientAdapter: () => ({
      schema: () => ({ rpc: async () => ({ data: [{}], error: null }) }),
    }),
  });
  assert.equal(input.task_key, "ops.chart_metrics");
  assert.equal(input.source_worker, "uk_aq_chart_metrics");
});
