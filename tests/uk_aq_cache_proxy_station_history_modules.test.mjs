import assert from "node:assert/strict";
import test from "node:test";

import { RequestValidationError } from "../workers/uk_aq_cache_proxy/src/station_history/contracts.mjs";
import {
  buildTimeseriesV2RequestWindow,
  canonicalizeTimeseriesV2RequestUrl,
  isProgressiveStationHistoryChunkRequest,
} from "../workers/uk_aq_cache_proxy/src/station_history/request_window.mjs";
import {
  applyAqiProxyHourlyGenerationCacheComponent,
  applyStationSeriesAqiGenerationCacheComponent,
  cachedStationSeriesIdentityMatchesRequest,
  canonicalizeAqiHistoryRequestUrl,
  canonicalizeStationSeriesRequestUrl,
} from "../workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs";

const AQI_UPSTREAM = "__uk_aq_aqi_history_r2_api__";
const STATION_SERIES_UPSTREAM = "__uk_aq_station_history_service__";

test("station-history request module preserves v2 cache-key canonicalisation", () => {
  const result = canonicalizeTimeseriesV2RequestUrl(
    new URL("https://cache.test/api/aq/timeseries?timeseries_id=7&pollutant=PM2.5&window=24h&v=2&_t=1"),
    false,
  );
  assert.equal(result.url.search, "?timeseries_id=7&pollutant=pm25&window=24h&format=json&v=2");
  assert.deepEqual(result.strippedCacheBusters, ["_t"]);
});

test("only explicit bounded progressive history requests qualify for Service Binding delegation", () => {
  assert.equal(isProgressiveStationHistoryChunkRequest(new URL("https://cache.test/api/aq/timeseries?timeseries_id=7&window=24h&v=2")), false);
  assert.equal(isProgressiveStationHistoryChunkRequest(new URL("https://cache.test/api/aq/aqi-history?timeseries_id=7&start_utc=2026-07-01T00:00:00Z&end_utc=2026-07-02T00:00:00Z&stable_head_start_utc=2026-07-02T00:00:00Z")), true);
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
  assert.equal(canonical.searchParams.get("__uk_aq_aqi_history_contract"), "aqi_hour_interval_v2");
});

test("station-series cache identity is deterministic without trusting the optional connector hint", () => {
  const withoutConnector = canonicalizeStationSeriesRequestUrl(
    new URL("https://cache.test/api/aq/station-series?end_utc=2026-07-15T12:00:00Z&timeseries_id=7&pollutant=PM2.5&start_utc=2026-07-14T12:00:00Z&window=24h&format=objects"),
    STATION_SERIES_UPSTREAM,
    STATION_SERIES_UPSTREAM,
  );
  const matchingHint = canonicalizeStationSeriesRequestUrl(
    new URL("https://cache.test/api/aq/station-series?connector_id=2&timeseries_id=07&pollutant=pm25&start_utc=2026-07-14T12:00:00.000Z&end_utc=2026-07-15T12:00:00.000Z&window=24h&include_aqi=true"),
    STATION_SERIES_UPSTREAM,
    STATION_SERIES_UPSTREAM,
  );
  assert.equal(matchingHint.toString(), withoutConnector.toString());
  assert.equal(withoutConnector.searchParams.has("connector_id"), false);
  assert.equal(withoutConnector.searchParams.get("__uk_aq_station_series_contract"), "3");

  const otherSeries = canonicalizeStationSeriesRequestUrl(
    new URL("https://cache.test/api/aq/station-series?timeseries_id=8&pollutant=pm25&start_utc=2026-07-14T12:00:00Z&end_utc=2026-07-15T12:00:00Z&window=24h"),
    STATION_SERIES_UPSTREAM,
    STATION_SERIES_UPSTREAM,
  );
  const observationsOnly = canonicalizeStationSeriesRequestUrl(
    new URL("https://cache.test/api/aq/station-series?timeseries_id=7&pollutant=pm25&start_utc=2026-07-14T12:00:00Z&end_utc=2026-07-15T12:00:00Z&window=24h&include_aqi=false"),
    STATION_SERIES_UPSTREAM,
    STATION_SERIES_UPSTREAM,
  );
  assert.notEqual(otherSeries.toString(), withoutConnector.toString());
  assert.notEqual(observationsOnly.toString(), withoutConnector.toString());
});

test("AQI-enabled station-series uses an internal hourly generation while observations-only omits it", () => {
  const enabled = applyStationSeriesAqiGenerationCacheComponent(
    new URL("https://cache.test/api/aq/station-series?timeseries_id=7&include_aqi=true"),
    STATION_SERIES_UPSTREAM,
    true,
    STATION_SERIES_UPSTREAM,
    Date.parse("2026-07-15T10:59:00Z"),
  );
  const nextHour = applyStationSeriesAqiGenerationCacheComponent(
    enabled,
    STATION_SERIES_UPSTREAM,
    true,
    STATION_SERIES_UPSTREAM,
    Date.parse("2026-07-15T11:00:00Z"),
  );
  const observationsOnly = applyStationSeriesAqiGenerationCacheComponent(
    new URL("https://cache.test/api/aq/station-series?timeseries_id=7&include_aqi=false"),
    STATION_SERIES_UPSTREAM,
    true,
    STATION_SERIES_UPSTREAM,
    Date.parse("2026-07-15T11:00:00Z"),
  );
  assert.equal(enabled.searchParams.get("__uk_aq_aqi_proxy_generation_hour"), "1:2026-07-15T10:00:00.000Z");
  assert.equal(nextHour.searchParams.get("__uk_aq_aqi_proxy_generation_hour"), "1:2026-07-15T11:00:00.000Z");
  assert.equal(observationsOnly.searchParams.has("__uk_aq_aqi_proxy_generation_hour"), false);
});

test("a cached station-series response accepts only a matching supplied connector hint", async () => {
  const response = new Response(JSON.stringify({ identity: { connector_id: 2 } }), { status: 200 });
  assert.equal(await cachedStationSeriesIdentityMatchesRequest(
    response,
    new URL("https://cache.test/api/aq/station-series?connector_id=2"),
    STATION_SERIES_UPSTREAM,
    STATION_SERIES_UPSTREAM,
  ), true);
  assert.equal(await cachedStationSeriesIdentityMatchesRequest(
    response,
    new URL("https://cache.test/api/aq/station-series?connector_id=3"),
    STATION_SERIES_UPSTREAM,
    STATION_SERIES_UPSTREAM,
  ), false);
});
