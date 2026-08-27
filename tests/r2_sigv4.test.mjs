import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithTimeout,
  r2PutObject,
} from "../workers/shared/r2_sigv4.mjs";

const TEST_R2_CONFIG = {
  endpoint: "https://example.invalid",
  bucket: "uk-aq-history-test",
  region: "auto",
  access_key_id: "test-access-key",
  secret_access_key: "test-secret-key",
};

function installImmediateSleep() {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) <= 5000) {
      callback(...args);
      return 0;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}

test("fetchWithTimeout aborts a hung request with an actionable error", async () => {
  let observedAbort = false;
  const hangingFetch = async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  };

  await assert.rejects(
    () => fetchWithTimeout(
      "https://example.invalid/hung",
      { method: "POST" },
      5,
      hangingFetch,
    ),
    /POST request to https:\/\/example\.invalid\/hung timed out after 5ms/,
  );
  assert.equal(observedAbort, true);
});

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

test("r2PutObject retries nested Node fetch and Undici transport failures", async (t) => {
  const cases = [
    {
      name: "fetch failed with ECONNRESET cause",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      }),
    },
    {
      name: "nested Undici connect timeout",
      error: new Error("request failed", {
        cause: Object.assign(new Error("connect timeout"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const restoreSleep = installImmediateSleep();
      const originalFetch = globalThis.fetch;
      let attempts = 0;
      let firstBody = null;
      globalThis.fetch = async (_url, init) => {
        attempts += 1;
        if (attempts === 1) {
          firstBody = init.body;
          throw testCase.error;
        }
        assert.equal(init.body, firstBody);
        return new Response("", { status: 200 });
      };

      try {
        await r2PutObject({
          r2: TEST_R2_CONFIG,
          key: `history/v2/test/${testCase.name}.json`,
          body: Buffer.from("deterministic-body"),
        });
        assert.equal(attempts, 2);
      } finally {
        globalThis.fetch = originalFetch;
        restoreSleep();
      }
    });
  }
});

test("r2PutObject stops after four retryable fetch failures", async () => {
  const restoreSleep = installImmediateSleep();
  const originalFetch = globalThis.fetch;
  const fetchFailure = new TypeError("fetch failed");
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw fetchFailure;
  };

  try {
    await assert.rejects(
      () => r2PutObject({
        r2: TEST_R2_CONFIG,
        key: "history/v2/test/max-attempts.json",
        body: "payload",
      }),
      (error) => error === fetchFailure,
    );
    assert.equal(attempts, 4);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSleep();
  }
});

test("r2PutObject does not retry an unrelated cyclic programming error", async () => {
  const restoreSleep = installImmediateSleep();
  const originalFetch = globalThis.fetch;
  const programmingError = new TypeError("invalid local request state");
  programmingError.cause = programmingError;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw programmingError;
  };

  try {
    await assert.rejects(
      () => r2PutObject({
        r2: TEST_R2_CONFIG,
        key: "history/v2/test/programming-error.json",
        body: "payload",
      }),
      (error) => error === programmingError,
    );
    assert.equal(attempts, 1);
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
      key: "history/v1/aqilevels/hourly/day_utc=2025-07-27/connector_id=3/part-00000.parquet",
      body: "payload",
    });

    assert.equal(attempts, 2);
    assert.equal(result.etag, '"status-retry-ok"');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSleep();
  }
});

test("r2PutObject does not retry ordinary non-retryable client failures", async () => {
  const restoreSleep = installImmediateSleep();
  const originalFetch = globalThis.fetch;

  try {
    for (const status of [400, 401, 403, 404]) {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts += 1;
        return new Response("client failure", { status });
      };
      await assert.rejects(
        () => r2PutObject({
          r2: TEST_R2_CONFIG,
          key: `history/v2/test/http-${status}.json`,
          body: "payload",
        }),
        new RegExp(`R2 PUT failed \\(${status}\\)`),
      );
      assert.equal(attempts, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreSleep();
  }
});
