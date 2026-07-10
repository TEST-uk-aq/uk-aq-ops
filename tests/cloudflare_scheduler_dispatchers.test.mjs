import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDailyTaskJob, evaluateIngestJob } from "../cloudflare/scheduler-dispatchers/shared.mjs";
import { INGEST_JOBS } from "../cloudflare/scheduler-dispatchers/ingest/worker.mjs";
import { OPS_JOBS } from "../cloudflare/scheduler-dispatchers/ops/worker.mjs";

test("ingest job is due when last success is stale and no run is in progress", () => {
  const job = INGEST_JOBS.find((item) => item.job_key === "uk_aq_sos");
  assert.ok(job);
  const now = Date.parse("2026-07-10T12:15:00Z");
  const rows = [
    {
      connector_code: "sos",
      run_started_at: "2026-07-10T11:40:00Z",
      run_ended_at: "2026-07-10T11:41:00Z",
      run_status: "succeeded",
      created_at: "2026-07-10T11:41:00Z",
    },
  ];

  const decision = evaluateIngestJob(job, rows, now);
  assert.equal(decision.due, true);
  assert.equal(decision.reason, "due");
  assert.equal(decision.wouldTrigger, true);
});

test("ingest job skips recent run and in-flight run", () => {
  const job = INGEST_JOBS.find((item) => item.job_key === "uk_aq_blondon_nodes");
  assert.ok(job);
  const now = Date.parse("2026-07-10T12:15:00Z");
  const rows = [
    {
      connector_code: "blondon_nodes",
      run_started_at: "2026-07-10T12:10:00Z",
      run_ended_at: null,
      run_status: "running",
      created_at: "2026-07-10T12:10:00Z",
    },
  ];

  const decision = evaluateIngestJob(job, rows, now);
  assert.equal(decision.due, false);
  assert.equal(decision.reason, "run_in_progress");
  assert.equal(decision.wouldTrigger, false);
});

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
  assert.equal(INGEST_JOBS.some((job) => job.job_key === "uk_aq_db_size_logger"), false);
  assert.equal(OPS_JOBS.some((job) => job.job_key === "uk_aq_timeseries_aqi_hourly"), false);
});
