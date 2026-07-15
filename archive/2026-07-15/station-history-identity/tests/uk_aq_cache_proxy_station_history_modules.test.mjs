import assert from "node:assert/strict";
import test from "node:test";

import { RequestValidationError } from "../workers/uk_aq_cache_proxy/src/station_history/contracts.mjs";
import {
  buildTimeseriesV2RequestWindow,
  canonicalizeTimeseriesV2RequestUrl,
} from "../workers/uk_aq_cache_proxy/src/station_history/request_window.mjs";
import {
  applyAqiProxyHourlyGenerationCacheComponent,
  canonicalizeAqiHistoryRequestUrl,
} from "../workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs";

const AQI_UPSTREAM = "__uk_aq_aqi_history_r2_api__";

test("station-history request module preserves v2 cache-key canonicalisation", () => {
  const result = canonicalizeTimeseriesV2RequestUrl(
    new URL("https://cache.test/api/aq/timeseries?timeseries_id=7&pollutant=PM2.5&window=24h&v=2&_t=1"),
    false,
  );
  assert.equal(result.url.search, "?timeseries_id=7&pollutant=pm25&window=24h&format=json&v=2");
  assert.deepEqual(result.strippedCacheBusters, ["_t"]);
});

test("station-history request module retains the v2 validation contract", () => {
  assert.throws(
    () => buildTimeseriesV2RequestWindow(new URL("https://cache.test/api/aq/timeseries?v=2"), { maxWindowDays: 90 }),
    (error) => error instanceof RequestValidationError && error.status === 400 && error.code === "timeseries_id_required",
  );
});

test("station-history AQI cache module retains hourly and immutable cache keys", () => {
  const recent = applyAqiProxyHourlyGenerationCacheComponent(
    new URL("https://cache.test/api/aq/aqi-history?from_utc=2026-01-01T00:14:00Z&to_utc=2026-01-05T02:14:00Z"),
    AQI_UPSTREAM,
    true,
    120,
    AQI_UPSTREAM,
    Date.parse("2026-01-05T03:20:00Z"),
  );
  assert.equal(recent.searchParams.get("__uk_aq_aqi_proxy_generation_hour"), "1:2026-01-05T03:00:00.000Z");
  const canonical = canonicalizeAqiHistoryRequestUrl(recent, AQI_UPSTREAM, AQI_UPSTREAM);
  assert.equal(canonical.searchParams.get("from_utc"), "2026-01-01T00:00:00.000Z");
  assert.equal(canonical.searchParams.get("to_utc"), "2026-01-05T02:00:00.000Z");
});


