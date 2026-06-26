import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { dispatchCronJobs, dispatchWorkflow, inputsForJob, JOBS } from "../cloudflare/workflow-scheduler/worker.js";

const wranglerText = readFileSync("cloudflare/workflow-scheduler/wrangler.toml", "utf8");
const schedulerDeployWorkflowText = readFileSync(".github/workflows/uk_aq_workflow_scheduler_deploy.yml", "utf8");
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
  assert.equal(cronJobMap.size, 5);
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

test("core snapshot cron slot dispatches one active history-version job", () => {
  const cronJobMap = parseCronJobMap();
  assert.deepEqual(cronJobMap.get("15 4 * * *"), ["uk_aq_r2_core_snapshot"]);
  const job = jobByKey("uk_aq_r2_core_snapshot");
  assert.equal(job.history_version_input, true);
  assert.deepEqual(inputsForJob(job, { UK_AQ_R2_HISTORY_VERSION: "v2" }), { history_version: "v2" });
});

test("Dropbox backup cron slot dispatches one active history-version job", () => {
  const cronJobMap = parseCronJobMap();
  assert.deepEqual(cronJobMap.get("35 4 * * *"), ["uk_aq_r2_history_dropbox_backup"]);
  const job = jobByKey("uk_aq_r2_history_dropbox_backup");
  assert.equal(job.history_version_input, true);
  assert.deepEqual(inputsForJob(job, { UK_AQ_R2_HISTORY_VERSION: "v2" }), { history_version: "v2" });
});

test("weekly Dropbox force-prune cron slot dispatches one v2-only job with merged inputs", () => {
  const cronJobMap = parseCronJobMap();
  assert.deepEqual(cronJobMap.get("0 22 * * SUN"), ["uk_aq_r2_history_dropbox_backup_force_prune_recheck"]);
  const job = jobByKey("uk_aq_r2_history_dropbox_backup_force_prune_recheck");
  assert.equal(job.history_version_input, true);
  assert.equal(job.required_history_version, "v2");
  assert.deepEqual(inputsForJob(job, { UK_AQ_R2_HISTORY_VERSION: "v2" }), {
    force_prune_recheck: "true",
    history_version: "v2",
  });
});

test("wrangler cron expressions avoid Cloudflare-invalid Sunday zero", () => {
  const cronJobMap = parseCronJobMap();
  for (const cronExpression of cronJobMap.keys()) {
    const fields = cronExpression.trim().split(/\s+/);
    assert.equal(fields.length, 5, `cron must have five fields: ${cronExpression}`);
    assert.notEqual(
      fields[4],
      "0",
      `Cloudflare Workers cron does not accept weekday 0 for Sunday; use SUN or 1: ${cronExpression}`,
    );
  }
});

test("dispatchWorkflow includes active history_version in GitHub API body", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };

  try {
    await dispatchWorkflow(
      jobByKey("uk_aq_r2_history_dropbox_backup"),
      "test-token",
      { UK_AQ_R2_HISTORY_VERSION: "v2" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: "main",
    inputs: { history_version: "v2" },
  });
});

test("dispatchWorkflow includes weekly force-prune static input plus active history_version", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };

  try {
    await dispatchWorkflow(
      jobByKey("uk_aq_r2_history_dropbox_backup_force_prune_recheck"),
      "test-token",
      { UK_AQ_R2_HISTORY_VERSION: "v2" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: "main",
    inputs: { force_prune_recheck: "true", history_version: "v2" },
  });
});

test("history-version jobs reject missing active Worker config", () => {
  assert.throws(
    () => inputsForJob(jobByKey("uk_aq_r2_core_snapshot"), {}),
    /Missing required Worker var: UK_AQ_R2_HISTORY_VERSION/,
  );
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

test("v2-only force-prune job dispatches on v2 and skips cleanly on v1", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };

  try {
    const job = jobByKey("uk_aq_r2_history_dropbox_backup_force_prune_recheck");
    const v2Results = await dispatchCronJobs("0 22 * * SUN", [job], "test-token", {
      UK_AQ_R2_HISTORY_VERSION: "v2",
    });
    const v1Results = await dispatchCronJobs("0 22 * * SUN", [job], "test-token", {
      UK_AQ_R2_HISTORY_VERSION: "v1",
    });

    assert.deepEqual(v2Results, [
      {
        job_key: "uk_aq_r2_history_dropbox_backup_force_prune_recheck",
        workflow_file: "uk_aq_r2_history_dropbox_backup.yml",
        status: "ok",
      },
    ]);
    assert.deepEqual(v1Results, [
      {
        job_key: "uk_aq_r2_history_dropbox_backup_force_prune_recheck",
        workflow_file: "uk_aq_r2_history_dropbox_backup.yml",
        status: "skipped",
        reason: "requires history_version=v2; active history_version=v1",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: "main",
    inputs: { force_prune_recheck: "true", history_version: "v2" },
  });
});

test("worker source uses cron-to-array map for grouped logical jobs", () => {
  assert.match(workerText, /export const CRON_JOB_MAP/);
  assert.match(workerText, /const jobKeys = CRON_JOB_MAP\[cronExpression\] \|\| \[\]/);
  assert.doesNotMatch(workerText, /uk_aq_r2_core_snapshot_v[12]/);
  assert.doesNotMatch(workerText, /uk_aq_r2_history_dropbox_backup_v[12]/);
});

test("tracked scheduler wrangler config does not hard-code active history version", () => {
  assert.doesNotMatch(wranglerText, /UK_AQ_R2_HISTORY_VERSION\s*=/);
});

test("scheduler deploy workflow injects active history version from repo vars", () => {
  assert.doesNotMatch(schedulerDeployWorkflowText, /target_environment/);
  assert.doesNotMatch(schedulerDeployWorkflowText, /environment:\s*\$\{\{/);
  assert.match(schedulerDeployWorkflowText, /UK_AQ_R2_HISTORY_VERSION:\s*\$\{\{\s*vars\.UK_AQ_R2_HISTORY_VERSION \|\| ''\s*\}\}/);
  assert.match(schedulerDeployWorkflowText, /Missing GitHub variable UK_AQ_R2_HISTORY_VERSION/);
  assert.match(schedulerDeployWorkflowText, /UK_AQ_R2_HISTORY_VERSION = "\{history_version\}"/);
});
