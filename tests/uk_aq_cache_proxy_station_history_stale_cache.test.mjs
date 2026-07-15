import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AQI_GENERATION_PARAM,
  buildCacheMetadata,
  buildFreshAndStaleCacheKeys,
  buildFreshHitResponse,
  buildStaleFallbackResponse,
  buildStoredCacheResponse,
  inspectCompleteGapFreePayload,
  inspectStationHistoryResponse,
  isFreshCacheResponse,
  isSupportedStationHistoryStaleRequest,
  isUpstreamFailureStatus,
  isValidStaleCacheResponse,
  resolveRouteCachePolicy,
  resolveStaleCacheConfig,
  shouldAttemptStaleFallback,
} from "../workers/uk_aq_cache_proxy/src/station_history/stale_cache.mjs";

const NOW = Date.parse("2026-07-15T12:00:00.000Z");
const config = resolveStaleCacheConfig({ UK_AQ_STATION_HISTORY_STALE_FALLBACK_ENABLED: "true" });

function completeAqiPayload(overrides = {}) {
  return {
    response_complete: true,
    has_gap: false,
    points: [{ timestamp_hour_utc: "2026-07-15T11:00:00.000Z", daqi_no2_index_level: 2 }],
    chunk: { cache_class: "mutable" },
    ...overrides,
  };
}

function responseFor(payload = completeAqiPayload()) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3900",
      "ETag": '"aqi-v1"',
      "X-UK-AQ-Station-History-Contract": "v1",
    },
  });
}

test("fresh and stale keys are versioned while AQI generation remains fresh-key internal", () => {
  const url = new URL("https://cache.test/api/aq/aqi-history?timeseries_id=7");
  url.searchParams.set(AQI_GENERATION_PARAM, "1:2026-07-15T12:00:00.000Z");
  const keys = buildFreshAndStaleCacheKeys(url);
  assert.match(keys.fresh.url, /station-history-stale-v1%3Afresh/);
  assert.match(keys.fresh.url, /aqi_proxy_generation_hour/);
  assert.match(keys.stale.url, /station-history-stale-v1%3Astale/);
  assert.doesNotMatch(keys.stale.url, /aqi_proxy_generation_hour/);
});

test("fresh hit is accepted only inside explicit fresh_until", async () => {
  const policy = resolveRouteCachePolicy("/v1/aqi-history", { immutable: false }, config, 3900);
  const metadata = buildCacheMetadata(NOW, policy);
  const stored = buildStoredCacheResponse(responseFor(), metadata, "fresh", policy.freshSeconds);
  assert.equal(isFreshCacheResponse(stored, NOW + 1000), true);
  assert.equal(isFreshCacheResponse(stored, metadata.fresh_until_ms + 1), false);
  const hit = buildFreshHitResponse(stored);
  assert.equal(hit.headers.get("X-UK-AQ-Station-History-Cache-State"), "FRESH");
  assert.equal(hit.headers.get("ETag"), '"aqi-v1"');
});

test("upstream success metadata supports fresh and stale copies", () => {
  const policy = resolveRouteCachePolicy("/v1/observations-history", { immutable: false }, config, 300);
  const metadata = buildCacheMetadata(NOW, policy);
  const stale = buildStoredCacheResponse(responseFor(), metadata, "stale", policy.freshSeconds + policy.maxStaleSeconds);
  assert.equal(isValidStaleCacheResponse(stale, metadata.stale_until_ms), true);
  assert.equal(stale.headers.get("X-UK-AQ-Station-History-Cached-At"), "2026-07-15T12:00:00.000Z");
});

test("valid stale fallback adds headers and JSON diagnostics and drops ETag", async () => {
  const policy = resolveRouteCachePolicy("/v1/aqi-history", { immutable: false }, config, 3900);
  const metadata = buildCacheMetadata(NOW, policy);
  const stored = buildStoredCacheResponse(responseFor(), metadata, "stale", policy.freshSeconds + policy.maxStaleSeconds);
  const stale = await buildStaleFallbackResponse(stored);
  assert.equal(stale.headers.get("X-UK-AQ-Cache"), "STALE");
  assert.equal(stale.headers.get("X-UK-AQ-Station-History-Stale-Reason"), "upstream_failure");
  assert.equal(stale.headers.get("Cache-Control"), "no-store");
  assert.equal(stale.headers.get("ETag"), null);
  const payload = await stale.json();
  assert.deepEqual(payload.station_history_cache, {
    state: "stale",
    reason: "upstream_failure",
    cached_at: metadata.cached_at,
    fresh_until: metadata.fresh_until,
    stale_until: metadata.stale_until,
  });
});

test("expired stale entries are rejected", () => {
  const policy = resolveRouteCachePolicy("/v1/aqi-history", { immutable: false }, config, 3900);
  const metadata = buildCacheMetadata(NOW, policy);
  const stored = buildStoredCacheResponse(responseFor(), metadata, "stale", policy.freshSeconds + policy.maxStaleSeconds);
  assert.equal(isValidStaleCacheResponse(stored, metadata.stale_until_ms + 1), false);
});

test("incomplete and known-gap responses never qualify to seed stale", () => {
  assert.equal(inspectCompleteGapFreePayload(completeAqiPayload({ response_complete: false }), "/v1/aqi-history").cacheable, false);
  assert.equal(inspectCompleteGapFreePayload(completeAqiPayload({ has_gap: true }), "/v1/aqi-history").cacheable, false);
  assert.equal(inspectCompleteGapFreePayload({
    aqi: { response_complete: true, has_gap: false },
    observations: { response_complete: false, has_gap: true },
  }, "/v1/station-series").cacheable, false);
});

test("validation errors and unsupported contracts do not qualify for stale", async () => {
  assert.equal(isUpstreamFailureStatus(400), false);
  assert.equal(isUpstreamFailureStatus(401), false);
  assert.equal(isUpstreamFailureStatus(503), true);
  assert.equal(isSupportedStationHistoryStaleRequest(
    new URL("https://cache.test/api/aq/aqi-history?format=tsv"),
    "/v1/aqi-history",
  ), false);
  const unsupported = responseFor();
  unsupported.headers.set("X-UK-AQ-Station-History-Contract", "v2");
  assert.equal((await inspectStationHistoryResponse(unsupported, "/v1/aqi-history")).cacheable, false);
});

test("station-series policy stays short and is not given the AQI hourly fresh TTL", () => {
  const policy = resolveRouteCachePolicy("/v1/station-series", { immutable: false }, config, 3900);
  assert.equal(policy.freshSeconds, 60);
  assert.equal(policy.maxStaleSeconds, 300);
});

test("stale fallback remains disabled by default", () => {
  assert.equal(resolveStaleCacheConfig({}).enabled, false);
});

test("bypass requests never attempt stale fallback", () => {
  assert.equal(shouldAttemptStaleFallback({
    enabled: true,
    shouldUseCache: false,
    requestSupported: true,
    upstreamFailure: true,
  }), false);
});

test("gateway refresh writes both versioned entries only after complete inspection", async () => {
  const source = await readFile("workers/uk_aq_cache_proxy/src/index.ts", "utf8");
  assert.match(source, /stationHistoryInspection\?\.cacheable[\s\S]*?buildStoredCacheResponse[\s\S]*?cache\.put\(stationHistoryVersionedKeys\.fresh[\s\S]*?cache\.put\(stationHistoryVersionedKeys\.stale/);
  assert.match(source, /tryStaleFallback[\s\S]*?shouldUseCache/);
  assert.match(source, /internalUrl\.search = stationHistoryCacheKeys[\s\S]*?stripAqiProxyHourlyGenerationCacheComponent/);
});
