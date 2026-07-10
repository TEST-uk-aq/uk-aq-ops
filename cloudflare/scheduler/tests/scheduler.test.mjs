import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cronDueTimes,
  dispatchDueJobsForWindow,
  runScheduler,
} from "../worker.mjs";

const wranglerText = readFileSync("cloudflare/scheduler/wrangler.toml", "utf8");
const workerText = readFileSync("cloudflare/scheduler/worker.mjs", "utf8");
const seedText = readFileSync("cloudflare/scheduler/seeds/0001_github_jobs.sql", "utf8");
const migrationText = readFileSync("cloudflare/scheduler/migrations/0001_scheduler_schema.sql", "utf8");

function parseWranglerCronList() {
  const match = wranglerText.match(/crons\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(match, "wrangler.toml must contain [triggers].crons");
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cronMatch = line.match(/^"([^"]+)"/);
      assert.ok(cronMatch, `invalid cron line: ${line}`);
      return cronMatch[1];
    });
}

function createMemorySchedulerStore({ jobs = [], previousRuns = [] } = {}) {
  const state = {
    jobs: jobs.map((job, index) => ({ id: index + 1, ...job })),
    previousRuns: previousRuns.map((run, index) => ({ id: index + 1, ...run })),
    runs: [],
    dispatches: [],
  };
  let nextRunId = state.previousRuns.length + 1;
  let nextDispatchId = 1;

  return {
    state,

    async getPreviousRun(schedulerName, startedAtIso) {
      const matches = state.previousRuns
        .concat(state.runs)
        .filter((run) => run.scheduler_name === schedulerName && run.started_at < startedAtIso)
        .sort((left, right) => left.started_at.localeCompare(right.started_at));
      return matches.at(-1) ?? null;
    },

    async insertRun(run) {
      const row = { id: nextRunId++, ...run };
      state.runs.push(row);
      return row.id;
    },

    async listEnabledJobs() {
      return state.jobs.filter((job) => Number(job.enabled) === 1).map((job) => ({ ...job }));
    },

    async claimDispatch(claim) {
      const duplicate = state.dispatches.find(
        (dispatch) => dispatch.job_key === claim.job_key && dispatch.due_at === claim.due_at,
      );
      if (duplicate) {
        return null;
      }

      const row = {
        id: nextDispatchId++,
        ...claim,
        dispatch_status: "claimed",
        dispatched_at: null,
        reason: null,
        response_status: null,
        response_preview: null,
      };
      state.dispatches.push(row);
      return row.id;
    },

    async updateDispatch(dispatchId, patch) {
      const row = state.dispatches.find((dispatch) => dispatch.id === dispatchId);
      assert.ok(row, `missing dispatch row ${dispatchId}`);
      Object.assign(row, patch);
    },

    async finishRun(runId, patch) {
      const row = state.runs.find((run) => run.id === runId);
      assert.ok(row, `missing run row ${runId}`);
      Object.assign(row, patch);
    },
  };
}

function getJob(template = {}) {
  return {
    job_key: "uk_aq_r2_core_snapshot",
    enabled: 1,
    target_type: "github_workflow",
    cron_expr: "15 4 * * *",
    timezone: "UTC",
    github_repo: "TEST-uk-aq/uk-aq-ops",
    github_workflow_file: "uk_aq_r2_core_snapshot.yml",
    github_ref: "main",
    github_inputs_json: "{}",
    cloud_run_url: null,
    cloud_run_method: "POST",
    cloud_run_headers_json: null,
    cloud_run_body_json: null,
    dry_run: 1,
    notes: "test",
    ...template,
  };
}

function captureLogs() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

test("wrangler config uses exactly one minute cron and the ops D1 binding", () => {
  const crons = parseWranglerCronList();
  assert.deepEqual(crons, ["* * * * *"]);
  assert.match(wranglerText, /name\s*=\s*"uk-aq-cron-scheduler-ops"/);
  assert.match(wranglerText, /binding\s*=\s*"SCHEDULER_DB"/);
  assert.match(wranglerText, /database_name\s*=\s*"uk_aq_cron_scheduler_ops_db"/);
});

test("worker loads jobs from D1 instead of a hard-coded production job array", () => {
  assert.match(workerText, /createSchedulerStore/);
  assert.match(workerText, /listEnabledJobs/);
  assert.doesNotMatch(workerText, /const\s+JOBS\s*=/);
  assert.doesNotMatch(workerText, /job_key:\s*"uk_aq_/);
});

test("cron parser handles the supported due windows", () => {
  assert.deepEqual(
    cronDueTimes(
      "15 4 * * *",
      Date.parse("2026-07-10T04:14:30Z"),
      Date.parse("2026-07-10T04:15:30Z"),
    ),
    ["2026-07-10T04:15:00.000Z"],
  );

  assert.deepEqual(
    cronDueTimes(
      "15 4 * * *",
      Date.parse("2026-07-10T04:15:00Z"),
      Date.parse("2026-07-10T04:16:00Z"),
    ),
    [],
  );

  assert.deepEqual(
    cronDueTimes(
      "0 22 * * SUN",
      Date.parse("2026-07-11T21:59:30Z"),
      Date.parse("2026-07-12T22:00:30Z"),
    ),
    ["2026-07-12T22:00:00.000Z"],
  );

  assert.deepEqual(
    cronDueTimes(
      "15 4 * * *",
      Date.parse("2026-07-10T04:14:00Z"),
      Date.parse("2026-07-10T04:16:00Z"),
    ),
    ["2026-07-10T04:15:00.000Z"],
  );
});

test("startup lookback uses two minutes when there is no previous scheduler run", async () => {
  const store = createMemorySchedulerStore({
    jobs: [getJob()],
  });
  const logs = captureLogs();

  try {
    const result = await runScheduler(
      store,
      { UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT: "pat" },
      Date.parse("2026-07-10T04:15:30Z"),
    );

    assert.equal(result.previous_run_started_at, null);
    assert.equal(result.jobs_due, 1);
    assert.equal(store.state.dispatches.length, 1);
  } finally {
    logs.restore();
  }
});

test("first claim succeeds and an identical due slot is not dispatched twice", async () => {
  const store = createMemorySchedulerStore({
    jobs: [getJob({ dry_run: 0 })],
  });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  };

  try {
    const windowStart = Date.parse("2026-07-10T04:13:30Z");
    const windowEnd = Date.parse("2026-07-10T04:14:30Z");

    const first = await dispatchDueJobsForWindow(
      store,
      await store.listEnabledJobs(),
      { UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT: "pat" },
      windowStart,
      windowEnd,
      { scheduler_run_id: 1 },
    );
    const second = await dispatchDueJobsForWindow(
      store,
      await store.listEnabledJobs(),
      { UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT: "pat" },
      windowStart,
      windowEnd,
      { scheduler_run_id: 2 },
    );

    assert.equal(first.jobs_claimed, 1);
    assert.equal(second.jobs_claimed, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(store.state.dispatches.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dry-run jobs do not make network requests", async () => {
  const store = createMemorySchedulerStore({
    jobs: [getJob({ dry_run: 1 })],
  });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  };

  try {
    await runScheduler(store, { UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT: "pat" }, Date.parse("2026-07-10T04:15:30Z"));
    assert.equal(fetchCalls, 0);
    assert.equal(store.state.dispatches[0].dispatch_status, "dry_run");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub dispatch records success and sends workflow inputs", async () => {
  const store = createMemorySchedulerStore({
    jobs: [
      getJob({
        dry_run: 0,
        github_inputs_json: '{"force_prune_recheck":"true"}',
        cron_expr: "15 4 * * *",
      }),
    ],
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };

  try {
    const result = await runScheduler(store, { UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT: "pat" }, Date.parse("2026-07-10T04:15:30Z"));
    assert.equal(result.jobs_dispatched, 1);
    assert.equal(calls.length, 1);

	assert.equal(
	  calls[0].url,
	  "https://api.github.com/repos/TEST-uk-aq/uk-aq-ops/actions/workflows/uk_aq_r2_core_snapshot.yml/dispatches",
	);

    assert.deepEqual(JSON.parse(calls[0].init.body), {
      ref: "main",
      inputs: { force_prune_recheck: "true" },
    });
    assert.equal(store.state.dispatches[0].dispatch_status, "dispatched");
    assert.equal(store.state.dispatches[0].response_status, 204);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub dispatch records failure on non-204 responses", async () => {
  const store = createMemorySchedulerStore({
    jobs: [getJob({ dry_run: 0 })],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });

  try {
    const result = await runScheduler(store, { UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT: "pat" }, Date.parse("2026-07-10T04:15:30Z"));
    assert.equal(result.jobs_failed, 1);
    assert.equal(store.state.dispatches[0].dispatch_status, "failed");
    assert.equal(store.state.dispatches[0].response_status, 500);
    assert.match(store.state.dispatches[0].response_preview, /nope/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed GitHub inputs fail safely without dispatching the target", async () => {
  const store = createMemorySchedulerStore({
    jobs: [
      getJob({
        dry_run: 0,
        github_inputs_json: "{oops",
      }),
    ],
  });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  };

  try {
    const result = await runScheduler(store, { UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT: "pat" }, Date.parse("2026-07-10T04:15:30Z"));
    assert.equal(result.jobs_failed, 1);
    assert.equal(fetchCalls, 0);
    assert.equal(store.state.dispatches.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub PAT and Cloud Run secrets do not appear in logs", async () => {
  const store = createMemorySchedulerStore({
    jobs: [getJob({ dry_run: 0, cron_expr: "15 4 * * *" })],
  });
  const logs = captureLogs();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });

  try {
    await runScheduler(
      store,
      {
        UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT: "super-secret-pat",
        UK_AQ_EDGE_UPSTREAM_SECRET: "super-secret-cloud-run",
      },
      Date.parse("2026-07-10T04:15:30Z"),
    );

    assert.equal(
      logs.lines.some((line) => line.includes("super-secret-pat") || line.includes("super-secret-cloud-run")),
      false,
    );
  } finally {
    logs.restore();
    globalThis.fetch = originalFetch;
  }
});

test("Cloud Run dispatch adds the shared dispatch secret and records success", async () => {
  const store = createMemorySchedulerStore({
    jobs: [
      getJob({
        job_key: "uk_aq_db_size_logger",
        target_type: "cloud_run",
        cron_expr: "15 4 * * *",
        github_repo: null,
        github_workflow_file: null,
        github_ref: null,
        github_inputs_json: null,
        cloud_run_url: "https://example.invalid/run",
        cloud_run_method: "POST",
        cloud_run_headers_json: '{"x-custom-header":"value"}',
        cloud_run_body_json: '{"trigger_mode":"scheduler"}',
        dry_run: 0,
      }),
    ],
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body,
    });
    return new Response("ok", { status: 200 });
  };

  try {
    const result = await runScheduler(
      store,
      { UK_AQ_EDGE_UPSTREAM_SECRET: "cloud-secret" },
      Date.parse("2026-07-10T04:15:30Z"),
    );

    assert.equal(result.jobs_dispatched, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["x-uk-aq-dispatch-secret"], "cloud-secret");
    assert.equal(calls[0].headers["x-custom-header"], "value");
    assert.match(calls[0].body, /trigger_mode/);
    assert.equal(store.state.dispatches[0].dispatch_status, "dispatched");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloud Run dispatch records failure for non-2xx responses", async () => {
  const store = createMemorySchedulerStore({
    jobs: [
      getJob({
        job_key: "uk_aq_db_size_logger",
        target_type: "cloud_run",
        cron_expr: "15 4 * * *",
        github_repo: null,
        github_workflow_file: null,
        github_ref: null,
        github_inputs_json: null,
        cloud_run_url: "https://example.invalid/run",
        cloud_run_method: "POST",
        cloud_run_headers_json: "{}",
        cloud_run_body_json: "{}",
        dry_run: 0,
      }),
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });

  try {
    const result = await runScheduler(
      store,
      { UK_AQ_EDGE_UPSTREAM_SECRET: "cloud-secret" },
      Date.parse("2026-07-10T04:15:30Z"),
    );

    assert.equal(result.jobs_failed, 1);
    assert.equal(store.state.dispatches[0].dispatch_status, "failed");
    assert.equal(store.state.dispatches[0].response_status, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("seed data includes the four GitHub jobs and stays dry-run by default", () => {
  assert.match(seedText, /uk_aq_r2_core_snapshot/);
  assert.match(seedText, /uk_aq_r2_history_dropbox_backup/);
  assert.match(seedText, /uk_aq_r2_history_dropbox_backup_force_prune_recheck/);
  assert.match(seedText, /uk_aq_dropbox_prune_raw/);
  assert.match(seedText, /github_inputs_json[\s\S]*\{\}',\n\s+1,\n\s+'Migrated from uk-aq-workflow-scheduler'/);
});

test("migration defines the three scheduler tables and duplicate-prevention index", () => {
  assert.match(migrationText, /create table if not exists scheduler_jobs/);
  assert.match(migrationText, /create table if not exists scheduler_dispatches/);
  assert.match(migrationText, /create table if not exists scheduler_runs/);
  assert.match(migrationText, /unique \(job_key, due_at\)/);
  assert.match(migrationText, /create index if not exists scheduler_dispatches_job_time_idx/);
  assert.match(migrationText, /create index if not exists scheduler_runs_name_started_idx/);
});
