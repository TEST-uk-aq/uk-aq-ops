import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { dispatchWorkflow, JOBS } from "../cloudflare/workflow-scheduler/worker.js";

const wranglerText = readFileSync("cloudflare/workflow-scheduler/wrangler.toml", "utf8");
const workerText = readFileSync("cloudflare/workflow-scheduler/worker.js", "utf8");

function parseCronJobMap() {
  const match = wranglerText.match(/crons\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(match, "wrangler.toml must contain [triggers].crons");

  const map = new Map();
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const cronMatch = line.match(/^"([^"]+)"\s*,?\s*#\s*job_keys?:\s*([^|#]+)/);
    assert.ok(cronMatch, `cron line must have job_keys comment: ${line}`);
    const [, cronExpression, rawJobKeys] = cronMatch;
    const jobKeys = rawJobKeys.split(",").map((key) => key.trim()).filter(Boolean);
    assert.ok(jobKeys.length > 0, `cron ${cronExpression} must map to at least one job key`);
    map.set(cronExpression, jobKeys);
  }
  return map;
}

function jobByKey(jobKey) {
  const job = JOBS.find((candidate) => candidate.job_key === jobKey);
  assert.ok(job, `missing worker job ${jobKey}`);
  return job;
}

test("wrangler cron count stays within Cloudflare limit and below previous expanded config", () => {
  const cronJobMap = parseCronJobMap();
  assert.equal(cronJobMap.size, 4);
  assert.ok(cronJobMap.size <= 5, "Cloudflare allows at most five cron triggers");
  assert.ok(cronJobMap.size <= 6, "grouped scheduler must not increase the previous checked-in expanded cron count");
});

test("every wrangler cron maps to existing worker jobs", () => {
  const cronJobMap = parseCronJobMap();
  const workerJobKeys = new Set(JOBS.map((job) => job.job_key));
  for (const [cronExpression, jobKeys] of cronJobMap.entries()) {
    assert.ok(jobKeys.length > 0, `${cronExpression} must map to logical jobs`);
    for (const jobKey of jobKeys) {
      assert.ok(workerJobKeys.has(jobKey), `${jobKey} must exist in worker.js`);
    }
  }
});

test("core snapshot cron slot dispatches v1 and v2 with explicit inputs", () => {
  const cronJobMap = parseCronJobMap();
  assert.deepEqual(cronJobMap.get("15 4 * * *"), [
    "uk_aq_r2_core_snapshot_v1",
    "uk_aq_r2_core_snapshot_v2",
  ]);
  assert.deepEqual(jobByKey("uk_aq_r2_core_snapshot_v1").inputs, { history_version: "v1" });
  assert.deepEqual(jobByKey("uk_aq_r2_core_snapshot_v2").inputs, { history_version: "v2" });
});

test("Dropbox backup cron slot dispatches v1 and v2 with explicit inputs", () => {
  const cronJobMap = parseCronJobMap();
  assert.deepEqual(cronJobMap.get("35 4 * * *"), [
    "uk_aq_r2_history_dropbox_backup_v1",
    "uk_aq_r2_history_dropbox_backup_v2",
  ]);
  assert.deepEqual(jobByKey("uk_aq_r2_history_dropbox_backup_v1").inputs, { backup_version: "v1" });
  assert.deepEqual(jobByKey("uk_aq_r2_history_dropbox_backup_v2").inputs, { backup_version: "v2" });
});

test("dispatchWorkflow includes inputs in GitHub API body when present", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };

  try {
    await dispatchWorkflow(jobByKey("uk_aq_r2_history_dropbox_backup_v2"), "test-token");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: "main",
    inputs: { backup_version: "v2" },
  });
});

test("dispatchWorkflow preserves single-job cron behaviour by omitting inputs when absent", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };

  try {
    await dispatchWorkflow(jobByKey("uk_aq_stations_daily"), "test-token");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "main" });
});

test("worker source uses cron-to-array map for grouped logical jobs", () => {
  assert.match(workerText, /export const CRON_JOB_MAP/);
  assert.match(workerText, /const jobKeys = CRON_JOB_MAP\[cronExpression\] \|\| \[\]/);
});
