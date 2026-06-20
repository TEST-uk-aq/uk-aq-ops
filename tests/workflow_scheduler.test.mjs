import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JOBS, dispatchWorkflow } from "../cloudflare/workflow-scheduler/worker.js";

function cronMapFromWrangler() {
  const text = readFileSync("cloudflare/workflow-scheduler/wrangler.toml", "utf8");
  const match = text.match(/crons\s*=\s*\[(.*?)\]/s);
  assert.ok(match, "wrangler.toml must define triggers.crons");

  const map = new Map();
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const cronMatch = line.match(/^"([^"]+)"\s*,?\s*#\s*job_key:\s*([A-Za-z0-9_-]+)\b/);
    assert.ok(cronMatch, `cron line must include job_key comment: ${line}`);
    const [, cron, jobKey] = cronMatch;
    assert.equal(map.has(jobKey), false, `duplicate wrangler job_key: ${jobKey}`);
    map.set(jobKey, cron);
  }
  return map;
}

function jobByKey(jobKey) {
  const job = JOBS.find((candidate) => candidate.job_key === jobKey);
  assert.ok(job, `missing job ${jobKey}`);
  return job;
}

test("wrangler cron job keys and worker JOBS entries stay aligned", () => {
  const cronMap = cronMapFromWrangler();
  const cronKeys = [...cronMap.keys()].sort();
  const jobKeys = JOBS.map((job) => job.job_key).sort();

  assert.deepEqual(cronKeys, jobKeys);
});

test("version-aware R2 jobs dispatch the expected workflow inputs", () => {
  assert.deepEqual(jobByKey("uk_aq_r2_core_snapshot_v1").inputs, {
    history_version: "v1",
  });
  assert.deepEqual(jobByKey("uk_aq_r2_core_snapshot_v2").inputs, {
    history_version: "v2",
  });
  assert.deepEqual(jobByKey("uk_aq_r2_history_dropbox_backup_v1").inputs, {
    backup_version: "v1",
  });
  assert.deepEqual(jobByKey("uk_aq_r2_history_dropbox_backup_v2").inputs, {
    backup_version: "v2",
  });
});

test("dispatch body includes inputs only when a job defines inputs", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 204 });
  });

  await dispatchWorkflow(jobByKey("uk_aq_r2_core_snapshot_v2"), "token");
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
    ref: "main",
    inputs: { history_version: "v2" },
  });

  await dispatchWorkflow(jobByKey("uk_aq_stations_daily"), "token");
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { ref: "main" });
});
