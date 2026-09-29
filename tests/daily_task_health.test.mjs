import test from "node:test";
import assert from "node:assert/strict";

import {
  createDailyTaskHealthClient,
  formatDailyTaskError,
  summarizeForDailyTaskHealth,
} from "../workers/shared/daily_task_health.mjs";
import {
  buildBackupVersionDetails,
  main as reportDailyTaskHealth,
  postRpc,
} from "../scripts/report_daily_task_health.mjs";

const NO_RETRY_DELAY = [0, 0, 0];
const noSleep = async () => {};

function rpcBody(overrides = {}) {
  return {
    p: {
      task_key: "ops.r2_history_dropbox_backup",
      source_repo: "TEST-uk-aq/uk-aq-ops",
      platform_run_id: "12345",
      summary: { github_run_attempt: "1" },
      ...overrides,
    },
  };
}

function rpcResponse(status, value = null) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("backup health details use complete v2/v3 generation inventory roots and retain v1", () => {
  assert.deepEqual(buildBackupVersionDetails({ UK_AQ_R2_HISTORY_VERSION: "v1" }), {
    history_version: "v1",
    backup_version: "v1",
    inventory_rel_path: "history/_index/backup_inventory_v1.json",
  });
  assert.deepEqual(buildBackupVersionDetails({ UK_AQ_R2_HISTORY_VERSION: "v2" }), {
    history_version: "v2",
    backup_version: "v2",
    inventory_rel_path: "history/_index_v2/backup_inventory_v2/root.json",
  });
  assert.deepEqual(buildBackupVersionDetails({ UK_AQ_R2_HISTORY_VERSION: "v3" }), {
    history_version: "v3",
    backup_version: "v3",
    inventory_rel_path: "history/_index_v3/backup_inventory_v2/root.json",
  });
  assert.throws(
    () => buildBackupVersionDetails({ UK_AQ_R2_HISTORY_VERSION: "v4" }),
    /expected v1, v2, or v3/,
  );
  assert.throws(
    () => buildBackupVersionDetails({
      UK_AQ_R2_HISTORY_VERSION: "v3",
      UK_AQ_R2_HISTORY_BACKUP_VERSION: "v2",
    }),
    /no longer supports UK_AQ_R2_HISTORY_BACKUP_VERSION/,
  );
});

test("summarizeForDailyTaskHealth converts BigInt values and circular references", () => {
  const input = {
    rows: 12n,
    nested: {
      bytes: 99n,
    },
  };
  input.self = input;

  assert.deepEqual(summarizeForDailyTaskHealth(input), {
    rows: "12",
    nested: {
      bytes: "99",
    },
    self: "[Circular]",
  });
});

test("formatDailyTaskError keeps compact error metadata", () => {
  const error = new Error("x".repeat(2000), {
    cause: new Error("root cause"),
  });
  error.name = "ExampleError";
  error.stack = `ExampleError: ${"s".repeat(3000)}`;

  const formatted = formatDailyTaskError(error);

  assert.equal(formatted.name, "ExampleError");
  assert.equal(formatted.message.length, 1200);
  assert.equal(formatted.message.endsWith("..."), true);
  assert.equal(formatted.stack_preview.length, 1800);
  assert.equal(formatted.stack_preview.endsWith("..."), true);
  assert.deepEqual(formatted.cause, {
    name: "Error",
    message: "root cause",
  });
});

test("disabled client does not call fetch and returns null run ids", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected fetch");
  };

  try {
    const client = createDailyTaskHealthClient({
      env: {
        DAILY_TASK_HEALTH_DISABLED: "true",
      },
    });
    const runId = await client.dailyTaskStarted({
      task_key: "ops.prune_daily",
      source_worker: "test_worker",
    });

    assert.equal(runId, null);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing Supabase config is non-fatal unless strict mode is enabled", async () => {
  const relaxed = createDailyTaskHealthClient({ env: {} });
  assert.equal(
    await relaxed.dailyTaskStarted({
      task_key: "ops.prune_daily",
      source_worker: "test_worker",
    }),
    null,
  );

  const strict = createDailyTaskHealthClient({
    env: {
      DAILY_TASK_HEALTH_STRICT: "true",
    },
  });

  await assert.rejects(
    strict.dailyTaskStarted({
      task_key: "ops.prune_daily",
      source_worker: "test_worker",
    }),
    /missing Supabase URL or service role key/i,
  );
});

test("reporter retries HTTP 520 and succeeds on a later safe RPC attempt", async () => {
  let calls = 0;
  const result = await postRpc({
    supabaseUrl: "https://example.invalid",
    serviceRoleKey: "test-key",
    rpcName: "uk_aq_rpc_daily_task_finished",
    body: { p_run_id: "run-id", p: {} },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? rpcResponse(520, { message: "transient" }) : rpcResponse(200, null);
    },
    retryDelaysMs: NO_RETRY_DELAY,
    sleepImpl: noSleep,
  });

  assert.equal(result, null);
  assert.equal(calls, 2);
});

test("reporter retries a network failure for a safe RPC", async () => {
  let calls = 0;
  await postRpc({
    supabaseUrl: "https://example.invalid",
    serviceRoleKey: "test-key",
    rpcName: "uk_aq_rpc_recompute_daily_task_status",
    body: { p_date: "2026-09-29" },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("simulated connection reset");
      }
      return rpcResponse(200, null);
    },
    retryDelaysMs: NO_RETRY_DELAY,
    sleepImpl: noSleep,
  });

  assert.equal(calls, 2);
});

test("reporter aborts a timed-out safe RPC attempt and retries", async () => {
  let calls = 0;
  await postRpc({
    supabaseUrl: "https://example.invalid",
    serviceRoleKey: "test-key",
    rpcName: "uk_aq_rpc_daily_task_finished",
    body: { p_run_id: "run-id", p: {} },
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls > 1) {
        return rpcResponse(200, null);
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("simulated abort");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
    attemptTimeoutMs: 1,
    retryDelaysMs: NO_RETRY_DELAY,
    sleepImpl: noSleep,
  });

  assert.equal(calls, 2);
});

test("reporter fails an ordinary HTTP 4xx without retry", async () => {
  let calls = 0;
  await assert.rejects(
    postRpc({
      supabaseUrl: "https://example.invalid",
      serviceRoleKey: "test-key",
      rpcName: "uk_aq_rpc_daily_task_failed",
      body: { p_run_id: "run-id", p: {} },
      fetchImpl: async () => {
        calls += 1;
        return rpcResponse(400, { message: "bad request" });
      },
      retryDelaysMs: NO_RETRY_DELAY,
      sleepImpl: noSleep,
    }),
    /failed \(400\)/,
  );
  assert.equal(calls, 1);
});

test("reporter bounds transient retries at four total attempts", async () => {
  let calls = 0;
  await assert.rejects(
    postRpc({
      supabaseUrl: "https://example.invalid",
      serviceRoleKey: "test-key",
      rpcName: "uk_aq_rpc_daily_task_finished",
      body: { p_run_id: "run-id", p: {} },
      fetchImpl: async () => {
        calls += 1;
        return rpcResponse(520, { message: "still transient" });
      },
      retryDelaysMs: NO_RETRY_DELAY,
      sleepImpl: noSleep,
    }),
    /failed \(520\)/,
  );
  assert.equal(calls, 4);
});

test("Started without complete GitHub identity remains single-attempt", async () => {
  let calls = 0;
  await assert.rejects(
    postRpc({
      supabaseUrl: "https://example.invalid",
      serviceRoleKey: "test-key",
      rpcName: "uk_aq_rpc_daily_task_started",
      body: rpcBody({ platform_run_id: null }),
      fetchImpl: async () => {
        calls += 1;
        return rpcResponse(520, { message: "unknown commit state" });
      },
      retryDelaysMs: NO_RETRY_DELAY,
      sleepImpl: noSleep,
    }),
    /failed \(520\)/,
  );
  assert.equal(calls, 1);
});

test("insert-style final fallback remains single-attempt", async () => {
  let calls = 0;
  await assert.rejects(
    postRpc({
      supabaseUrl: "https://example.invalid",
      serviceRoleKey: "test-key",
      rpcName: "uk_aq_rpc_daily_task_report_final",
      body: { p: { task_key: "ops.some_other_task", status: "Finished" } },
      fetchImpl: async () => {
        calls += 1;
        return rpcResponse(520, { message: "unknown commit state" });
      },
      retryDelaysMs: NO_RETRY_DELAY,
      sleepImpl: noSleep,
    }),
    /failed \(520\)/,
  );
  assert.equal(calls, 1);
});

test("Started with complete GitHub identity uses the safe retry path", async () => {
  let calls = 0;
  const runId = await postRpc({
    supabaseUrl: "https://example.invalid",
    serviceRoleKey: "test-key",
    rpcName: "uk_aq_rpc_daily_task_started",
    body: rpcBody(),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? rpcResponse(520, { message: "response lost" })
        : rpcResponse(200, "same-run-uuid");
    },
    retryDelaysMs: NO_RETRY_DELAY,
    sleepImpl: noSleep,
  });

  assert.equal(runId, "same-run-uuid");
  assert.equal(calls, 2);
});

test("strict mode propagates exhausted terminal RPC failure", async () => {
  let calls = 0;
  await assert.rejects(
    reportDailyTaskHealth({
      env: {
        SUPABASE_URL: "https://example.invalid",
        SUPABASE_SERVICE_ROLE_KEY: "test-key",
        DAILY_TASK_KEY: "ops.r2_history_dropbox_backup",
        DAILY_TASK_HEALTH_REPORT_STAGE: "final",
        DAILY_TASK_HEALTH_RUN_ID: "run-id",
        DAILY_TASK_HEALTH_STRICT: "true",
        JOB_STATUS: "success",
        GITHUB_REPOSITORY: "TEST-uk-aq/uk-aq-ops",
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
      },
      rpcOptions: {
        fetchImpl: async () => {
          calls += 1;
          return rpcResponse(520, { message: "transient" });
        },
        retryDelaysMs: NO_RETRY_DELAY,
        sleepImpl: noSleep,
      },
    }),
    /failed \(520\)/,
  );
  assert.equal(calls, 4);
});

test("R2 final stage recovers the exact Started UUID instead of inserting a fallback run", async () => {
  const rpcNames = [];
  await reportDailyTaskHealth({
    env: {
      SUPABASE_URL: "https://example.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
      DAILY_TASK_KEY: "ops.r2_history_dropbox_backup",
      DAILY_TASK_HEALTH_REPORT_STAGE: "final",
      DAILY_TASK_HEALTH_STRICT: "true",
      JOB_STATUS: "success",
      GITHUB_REPOSITORY: "TEST-uk-aq/uk-aq-ops",
      GITHUB_WORKFLOW: "UK AQ R2 History Dropbox Backup",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    },
    rpcOptions: {
      fetchImpl: async (url, options) => {
        const rpcName = new URL(url).pathname.split("/").at(-1);
        rpcNames.push(rpcName);
        const requestBody = JSON.parse(options.body);
        if (rpcName === "uk_aq_rpc_daily_task_started") {
          assert.equal(requestBody.p.platform_run_id, "12345");
          assert.equal(requestBody.p.summary.github_run_attempt, "1");
          return rpcResponse(200, "same-run-uuid");
        }
        if (rpcName === "uk_aq_rpc_daily_task_finished") {
          assert.equal(requestBody.p_run_id, "same-run-uuid");
        }
        return rpcResponse(200, null);
      },
      retryDelaysMs: NO_RETRY_DELAY,
      sleepImpl: noSleep,
    },
  });

  assert.deepEqual(rpcNames, [
    "uk_aq_rpc_daily_task_started",
    "uk_aq_rpc_daily_task_finished",
    "uk_aq_rpc_recompute_daily_task_status",
  ]);
  assert.equal(rpcNames.includes("uk_aq_rpc_daily_task_report_final"), false);
});
