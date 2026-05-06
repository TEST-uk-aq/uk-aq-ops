import test from "node:test";
import assert from "node:assert/strict";

import {
  createDailyTaskHealthClient,
  formatDailyTaskError,
  summarizeForDailyTaskHealth,
} from "../workers/shared/daily_task_health.mjs";

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
