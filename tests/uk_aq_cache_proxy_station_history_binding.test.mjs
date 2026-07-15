import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("gateway declares the private STATION_HISTORY Service Binding and disabled route flags", async () => {
  const [source, wrangler] = await Promise.all([
    readFile("workers/uk_aq_cache_proxy/src/index.ts", "utf8"),
    readFile("workers/uk_aq_cache_proxy/wrangler.toml", "utf8"),
  ]);
  assert.match(wrangler, /binding = "STATION_HISTORY"/);
  assert.match(wrangler, /service = "uk-aq-station-history"/);
  assert.match(source, /UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED/);
  assert.match(source, /UK_AQ_STATION_HISTORY_TIMESERIES_ENABLED/);
  assert.match(source, /station_history_internal_fetch_failed/);
  assert.match(source, /X-UK-AQ-Station-History-Route/);
  assert.match(source, /usingExternalAqiHistoryUpstream[\s\S]*?"\/v1\/aqi-history"/);
  assert.match(source, /TIMESERIES_UPSTREAM_FUNCTION[\s\S]*?"\/v1\/observations-history"/);
  assert.match(source, /useTimeseriesV2Skeleton && !stationHistoryRouting\.timeseries/);
});

test("station-series cache canonicalisation separates observations-only requests", async () => {
  const source = await readFile("workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs", "utf8");
  assert.match(source, /canonicalizeStationSeriesRequestUrl/);
  assert.match(source, /include_aqi/);
});
