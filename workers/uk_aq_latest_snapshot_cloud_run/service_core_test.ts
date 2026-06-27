import assert from "node:assert/strict";
import {
  createLatestSnapshotHandler,
  JobTimeoutError,
} from "./service_core.ts";

function postRequest(triggerMode = "scheduler"): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trigger_mode: triggerMode }),
  });
}

const silentLogger = {
  log: (_message: string) => undefined,
  error: (_message: string) => undefined,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

Deno.test("overlapping request returns a successful in-flight skip with age", async () => {
  let nowMs = Date.parse("2026-06-27T08:00:00.000Z");
  const started = deferred<void>();
  const jobResult = deferred<{ success: boolean; code: number }>();
  const handler = createLatestSnapshotHandler({
    now: () => nowMs,
    logger: silentLogger,
    runJob: async () => {
      started.resolve(undefined);
      return await jobResult.promise;
    },
  });

  const firstResponsePromise = handler(postRequest());
  await started.promise;
  nowMs += 123_000;

  const overlapResponse = await handler(postRequest());
  const overlapPayload = await overlapResponse.json();

  assert.equal(overlapResponse.status, 200);
  assert.equal(overlapPayload.ok, true);
  assert.equal(overlapPayload.skipped, true);
  assert.equal(overlapPayload.reason, "run_in_flight");
  assert.equal(overlapPayload.age_seconds, 123);
  assert.equal(overlapPayload.active_trigger_mode, "scheduler");

  jobResult.resolve({ success: true, code: 0 });
  const firstResponse = await firstResponsePromise;
  assert.equal(firstResponse.status, 200);
});

Deno.test("timeout response clears in-flight state so the next run can start", async () => {
  let runCount = 0;
  const handler = createLatestSnapshotHandler({
    logger: silentLogger,
    runJob: async () => {
      runCount += 1;
      if (runCount === 1) {
        throw new JobTimeoutError(240_000);
      }
      return { success: true, code: 0 };
    },
  });

  const timedOutResponse = await handler(postRequest());
  const timedOutPayload = await timedOutResponse.json();
  assert.equal(timedOutResponse.status, 504);
  assert.equal(timedOutPayload.error, "job_timeout");

  const recoveryResponse = await handler(postRequest("manual"));
  const recoveryPayload = await recoveryResponse.json();
  assert.equal(recoveryResponse.status, 200);
  assert.equal(recoveryPayload.ok, true);
  assert.equal(recoveryPayload.trigger_mode, "manual");
  assert.equal(runCount, 2);
});
