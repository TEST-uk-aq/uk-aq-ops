import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDailyTaskJob } from "../cloudflare/scheduler/shared.mjs";
import { OPS_JOBS } from "../cloudflare/scheduler/ops/worker.mjs";

test("daily job skips until scheduled time and then becomes due", () => {
  const job = OPS_JOBS.find((item) => item.job_key === "ops.prune_daily");
  assert.ok(job);

  const beforeDue = Date.parse("2026-07-10T02:30:00Z");
  const afterDue = Date.parse("2026-07-10T02:55:00Z");
  const rows = [];

  const beforeDecision = evaluateDailyTaskJob(job, rows, beforeDue);
  assert.equal(beforeDecision.due, false);
  assert.equal(beforeDecision.reason, "not_due_yet");

  const afterDecision = evaluateDailyTaskJob(job, rows, afterDue);
  assert.equal(afterDecision.due, true);
  assert.equal(afterDecision.reason, "due");
});

test("daily job skips if a run already completed today", () => {
  const job = OPS_JOBS.find((item) => item.job_key === "ops.observs_partition_maintenance");
  assert.ok(job);
  const now = Date.parse("2026-07-10T04:00:00Z");
  const rows = [
    {
      task_key: "ops.observs_partition_maintenance",
      scheduled_for_date: "2026-07-10",
      scheduled_time_utc: "03:00",
      started_at: "2026-07-10T03:05:00Z",
      finished_at: "2026-07-10T03:11:00Z",
      raw_status: "Finished",
      effective_status: "Finished",
      updated_at: "2026-07-10T03:11:00Z",
    },
  ];

  const decision = evaluateDailyTaskJob(job, rows, now);
  assert.equal(decision.due, false);
  assert.equal(decision.reason, "recent_success");
  assert.equal(decision.wouldTrigger, false);
});

test("planned phase-2 jobs exclude deferred ops targets", () => {
  assert.equal(OPS_JOBS.some((job) => job.job_key === "uk_aq_db_size_logger"), false);
  assert.equal(OPS_JOBS.some((job) => job.job_key === "uk_aq_timeseries_aqi_hourly"), false);
});
