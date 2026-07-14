import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import aqiHistoryWorker from "../workers/uk_aq_aqi_history_r2_api_worker/worker.mjs";

const cacheProxySourcePath = new URL("../workers/uk_aq_cache_proxy/src/index.ts", import.meta.url);
const aqiWorkerSourcePath = new URL("../workers/uk_aq_aqi_history_r2_api_worker/worker.mjs", import.meta.url);

async function cacheProxySource() {
  return await readFile(cacheProxySourcePath, "utf8");
}

async function aqiWorkerSource() {
  return await readFile(aqiWorkerSourcePath, "utf8");
}

test("AQI proxy cache groundwork uses recent profile, mutable hours, and strips generation upstream", async () => {
  const source = await cacheProxySource();

  assert.match(source, /aqi_history_recent:\s*{\s*edgeTtlSeconds:\s*3900,\s*browserTtlSeconds:\s*300,\s*staleWhileRevalidateSeconds:\s*0,\s*staleIfErrorSeconds:\s*300,/s);
  assert.match(source, /aqi_history_immutable:\s*{\s*edgeTtlSeconds:\s*86400,\s*browserTtlSeconds:\s*86400,/s);
  assert.match(source, /const DEFAULT_AQI_MUTABLE_HOURS = 120/);
  assert.match(source, /const MIN_AQI_MUTABLE_HOURS = 1/);
  assert.match(source, /const MAX_AQI_MUTABLE_HOURS = 24 \* 30/);
  assert.match(source, /function getAqiProxyGenerationHour[\s\S]*Math\.floor\(nowMs \/ HOUR_MS\) \* HOUR_MS/);
  assert.match(source, /normalizedUpstreamRequestUrl = stripAqiProxyHourlyGenerationCacheComponent\(normalizedRequestUrl\)/);
  assert.match(source, /resolveCacheProfileName\([\s\S]*upstreamFunction,[\s\S]*normalizedRequestUrl,[\s\S]*aqiMutableHours,[\s\S]*aqiProxyHourlyGenerationEnabled,[\s\S]*\)/);
  assert.match(source, /aqiScope === "recent_hourly"[\s\S]*return "aqi_history_recent"/);
  assert.match(source, /aqiScope === "recent_legacy"[\s\S]*return "realtime"/);
  assert.match(source, /aqiScope === "immutable"[\s\S]*return "aqi_history_immutable"/);
  assert.doesNotMatch(source, /AQI_HISTORY_MUTABLE_WINDOW_MS/);
});

test("AQI proxy no-store cache exception requires the worker internal-cache-disabled header", async () => {
  const source = await cacheProxySource();

  assert.match(source, /X-UK-AQ-Response-Complete"\) \?\? ""\)\.toLowerCase\(\) === "false"/);
  assert.match(source, /cacheControl\.includes\("private"\)/);
  assert.match(source, /cacheControl\.includes\("no-store"\)[\s\S]*X-UK-AQ-Internal-Response-Cache"\) \?\? ""\)\.toLowerCase\(\) === "disabled"/);
  assert.match(source, /allowAqiAuthenticatedNoStore:\s*usingExternalAqiHistoryUpstream/);
});


test("AQI proxy uses one upstream cacheability result for response headers and cache storage", async () => {
  const source = await cacheProxySource();

  assert.match(source, /const upstreamResponseCacheable = isCacheableUpstreamResponse\(upstreamResponse, \{[\s\S]*allowAqiAuthenticatedNoStore:\s*usingExternalAqiHistoryUpstream,[\s\S]*\}\)/);
  assert.match(source, /if \(upstreamResponseCacheable\) \{[\s\S]*responseHeaders\.set\("Cache-Control", buildCacheControl\(profile\)\);[\s\S]*\} else \{[\s\S]*responseHeaders\.set\("Cache-Control", "no-store"\);[\s\S]*\}/);
  assert.match(source, /shouldUseCache && request\.method === "GET" && upstreamResponseCacheable/);
  assert.doesNotMatch(source, /upstreamResponse\.status === 200 && upstreamResponseComplete !== "false"\) \{[\s\S]*buildCacheControl\(profile\)/);
});

test("AQI worker mutable horizon and internal cache toggle share the cache contract", async () => {
  const source = await aqiWorkerSource();

  assert.match(source, /const DEFAULT_AQI_MUTABLE_HOURS = 120/);
  assert.match(source, /const MIN_AQI_MUTABLE_HOURS = 1/);
  assert.match(source, /const MAX_AQI_MUTABLE_HOURS = 24 \* 30/);
  assert.match(source, /env\.UK_AQ_AQI_MUTABLE_HOURS/);
  assert.match(source, /mutableHours \* HOUR_MS/);
  assert.doesNotMatch(source, /AQI_HISTORY_MUTABLE_WINDOW_MS/);
});

test("AQI worker disabled internal cache does not call caches.default match or put", async () => {
  const previousCaches = globalThis.caches;
  let matchCount = 0;
  let putCount = 0;
  globalThis.caches = {
    default: {
      async match() {
        matchCount += 1;
        throw new Error("cache match should not be called when disabled");
      },
      async put() {
        putCount += 1;
        throw new Error("cache put should not be called when disabled");
      },
    },
  };

  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history", {
        headers: { "x-uk-aq-upstream-auth": "secret" },
      }),
      {
        UK_AQ_EDGE_UPSTREAM_SECRET: "secret",
        UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED: "false",
      },
      { waitUntil() {} },
    );

    assert.equal(matchCount, 0);
    assert.equal(putCount, 0);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-UK-AQ-Internal-Response-Cache"), "disabled");
    assert.equal(response.headers.get("x-ukaq-cache"), "BYPASS");
  } finally {
    if (previousCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = previousCaches;
    }
  }
});
