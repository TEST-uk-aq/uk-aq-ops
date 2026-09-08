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
const workerHttpMigrationText = readFileSync(
  "cloudflare/scheduler/migrations/0003_worker_http_target.sql",
  "utf8",
);

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

    async claimMinute(run) {
      const existing = state.previousRuns
        .concat(state.runs)
        .find(
          (candidate) => candidate.scheduler_name === run.scheduler_name
            && candidate.minute_slot === run.minute_slot,
        );
      if (existing) {
        return {
          claimed: false,
          scheduler_run_id: existing.id,
          run_status: existing.status,
          trigger_source: existing.trigger_source,
        };
      }
      const row = { id: nextRunId++, ...run };
      state.runs.push(row);
      return {
        claimed: true,
        scheduler_run_id: row.id,
        run_status: row.status,
        trigger_source: row.trigger_source,
      };
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
    worker_http_url: null,
    worker_http_secret_binding: null,
    worker_http_body_json: null,
    dry_run: 1,
    notes: "test",
    ...template,
  };
}

function getWorkerHttpJob(template = {}) {
  return getJob({
    job_key: "uk_aq_example_worker_http",
    target_type: "worker_http",
    github_repo: null,
    github_workflow_file: null,
    github_ref: null,
    github_inputs_json: null,
    worker_http_url: "https://worker.example.test/run",
    worker_http_secret_binding: "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET",
    worker_http_body_json: null,
    ...template,
  });
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

test("a first scheduler run evaluates the preceding one-minute window", async () => {
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

test("Worker HTTP dispatch uses the fixed authenticated POST contract and accepts any 2xx", async () => {
  const store = createMemorySchedulerStore({
    jobs: [getWorkerHttpJob({ worker_http_body_json: '{"source":"scheduler"}', dry_run: 0 })],
  });
  const calls = [];
  const logs = captureLogs();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body,
    });
    return new Response(`dedicated-secret:${"x".repeat(1_100)}`, { status: 202 });
  };

  try {
    const result = await runScheduler(
      store,
      { UK_AQ_EXAMPLE_WORKER_HTTP_SECRET: "dedicated-secret" },
      Date.parse("2026-07-10T04:15:30Z"),
    );

    assert.equal(result.jobs_dispatched, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://worker.example.test/run");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.accept, "application/json");
    assert.equal(calls[0].headers["content-type"], "application/json; charset=utf-8");
    assert.equal(calls[0].headers["x-uk-aq-worker-http-secret"], "dedicated-secret");
    assert.deepEqual(JSON.parse(calls[0].body), { source: "scheduler" });
    assert.equal(store.state.dispatches[0].dispatch_status, "dispatched");
    assert.equal(store.state.dispatches[0].response_status, 202);
    assert.equal(store.state.dispatches[0].response_preview.length, 1_000);
    assert.match(store.state.dispatches[0].response_preview, /^\[REDACTED\]:/);
    assert.doesNotMatch(store.state.dispatches[0].response_preview, /dedicated-secret/);
    assert.equal(logs.lines.some((line) => line.includes("dedicated-secret")), false);
  } finally {
    logs.restore();
    globalThis.fetch = originalFetch;
  }
});

test("Worker HTTP defaults an absent body to an empty JSON object", async () => {
  const store = createMemorySchedulerStore({ jobs: [getWorkerHttpJob({ dry_run: 0 })] });
  let requestBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requestBody = init.body;
    return new Response(null, { status: 204 });
  };

  try {
    await runScheduler(
      store,
      { UK_AQ_EXAMPLE_WORKER_HTTP_SECRET: "dedicated-secret" },
      Date.parse("2026-07-10T04:15:30Z"),
    );
    assert.equal(requestBody, "{}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker HTTP records a clear failure for non-2xx responses", async () => {
  const store = createMemorySchedulerStore({ jobs: [getWorkerHttpJob({ dry_run: 0 })] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("denied", { status: 403 });

  try {
    const result = await runScheduler(
      store,
      { UK_AQ_EXAMPLE_WORKER_HTTP_SECRET: "dedicated-secret" },
      Date.parse("2026-07-10T04:15:30Z"),
    );
    assert.equal(result.jobs_failed, 1);
    assert.equal(store.state.dispatches[0].dispatch_status, "failed");
    assert.equal(store.state.dispatches[0].response_status, 403);
    assert.equal(store.state.dispatches[0].reason, "Worker HTTP dispatch failed with HTTP 403");
    assert.equal(store.state.dispatches[0].response_preview, "denied");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker HTTP rejects missing secrets before making a request", async () => {
  const store = createMemorySchedulerStore({ jobs: [getWorkerHttpJob({ dry_run: 0 })] });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  };

  try {
    const result = await runScheduler(
      store,
      { UK_AQ_EXAMPLE_WORKER_HTTP_SECRET: "  " },
      Date.parse("2026-07-10T04:15:30Z"),
    );
    assert.equal(result.jobs_failed, 1);
    assert.equal(fetchCalls, 0);
    assert.equal(store.state.dispatches[0].reason, "Missing required Worker secret: UK_AQ_EXAMPLE_WORKER_HTTP_SECRET");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker HTTP rejects insecure URLs, non-object bodies, and unrelated secret bindings", async () => {
  const invalidOverrides = [
    { worker_http_url: "http://worker.example.test/run" },
    { worker_http_body_json: "[]" },
    { worker_http_secret_binding: "UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT" },
    { worker_http_secret_binding: "UK_AQ_EDGE_UPSTREAM_SECRET" },
    { worker_http_secret_binding: "UK_AQ_SCHEDULER_TRIGGER_SECRET" },
  ];
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  };

  try {
    for (const [index, override] of invalidOverrides.entries()) {
      const store = createMemorySchedulerStore({
        jobs: [getWorkerHttpJob({ job_key: `invalid_worker_http_${index}`, ...override, dry_run: 0 })],
      });
      const result = await runScheduler(
        store,
        { UK_AQ_EXAMPLE_WORKER_HTTP_SECRET: "dedicated-secret" },
        Date.parse(`2026-07-10T04:${String(15 + index).padStart(2, "0")}:30Z`),
      );
      assert.equal(result.jobs_failed, 1);
      assert.equal(store.state.dispatches.length, 0);
    }
    assert.equal(fetchCalls, 0);
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
  assert.match(workerHttpMigrationText, /target_type in \('github_workflow', 'cloud_run', 'worker_http'\)/);
  assert.match(workerHttpMigrationText, /worker_http_url text/);
  assert.match(workerHttpMigrationText, /worker_http_secret_binding text/);
  assert.match(workerHttpMigrationText, /worker_http_body_json is null or json_valid\(worker_http_body_json\)/);
  assert.match(workerHttpMigrationText, /references scheduler_jobs_worker_http\(job_key\)/);
  assert.match(workerHttpMigrationText, /alter table scheduler_dispatches_worker_http rename to scheduler_dispatches/);
  assert.match(workerHttpMigrationText, /pragma foreign_key_check/);
});
