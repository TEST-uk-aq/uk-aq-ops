import test from "node:test";
import assert from "node:assert/strict";
import { r2PutObject } from "../workers/shared/r2_sigv4.mjs";

const TEST_R2_CONFIG = {
  endpoint: "https://example.invalid",
  bucket: "uk-aq-history-test",
  region: "auto",
  access_key_id: "test-access-key",
  secret_access_key: "test-secret-key",
};

function installImmediateSleep() {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => {
    callback(...args);
    return 0;
  };
  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}

test("r2PutObject retries a transient connection reset and succeeds", async () => {
  const restoreSleep = installImmediateSleep();
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error(
        "client error (SendRequest): connection error: Connection reset by peer (os error 54)",
      );
    }
    return new Response("", {
      status: 200,
      headers: { etag: '"retry-ok"' },
    });
  };

  try {
    const result = await r2PutObject({
      r2: TEST_R2_CONFIG,
      key: "history/v1/observations/day_utc=2025-07-27/connector_id=3/part-00000.parquet",
      body: "payload",
    });

    assert.equal(attempts, 2);
    assert.equal(result.key.includes("part-00000.parquet"), true);
    assert.equal(result.bytes, 7);
    assert.equal(result.etag, '"retry-ok"');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSleep();
  }
});

test("r2PutObject retries retryable HTTP failures and then succeeds", async () => {
  const restoreSleep = installImmediateSleep();
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("temporary upstream issue", { status: 503 });
    }
    return new Response("", {
      status: 200,
      headers: { etag: '"status-retry-ok"' },
    });
  };

  try {
    const result = await r2PutObject({
      r2: TEST_R2_CONFIG,
      key: "history/v1/aqilevels/day_utc=2025-07-27/connector_id=3/part-00000.parquet",
      body: "payload",
    });

    assert.equal(attempts, 2);
    assert.equal(result.etag, '"status-retry-ok"');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSleep();
  }
});

test("r2PutObject does not retry non-retryable client failures", async () => {
  const restoreSleep = installImmediateSleep();
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("bad request", { status: 400 });
  };

  try {
    await assert.rejects(
      () =>
        r2PutObject({
          r2: TEST_R2_CONFIG,
          key: "history/v1/aqilevels/day_utc=2025-07-27/connector_id=3/part-00000.parquet",
          body: "payload",
        }),
      /R2 PUT failed \(400\)/,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSleep();
  }
});
