import assert from "node:assert/strict";
import test from "node:test";
import worker, { resolveStationSeriesRequest } from "../workers/uk_aq_station_history/src/index.mjs";

const env = { SUPABASE_URL: "https://ingest.example", SB_PUBLISHABLE_DEFAULT_KEY: "key", SB_SECRET_KEY: "service-key", UK_AQ_EDGE_UPSTREAM_SECRET: "secret" };
const HOUR_MS = 60 * 60 * 1000;

function observations(startIso, hours, pollutant) {
  const startMs = Date.parse(startIso);
  return Array.from({ length: hours }, (_, index) => ({ timeseries_id: 7, connector_id: 2, station_id: 9, pollutant_code: pollutant, observed_at: new Date(startMs + index * HOUR_MS).toISOString(), value: 20 }));
}

function authoritativeIdentity(pollutant = "pm25") {
  return [{ id: 7, station_id: 9, connector_id: 2, phenomenon_id: 4, ended_at: null, phenomena: { connector_id: 2, observed_property_id: 5, observed_properties: { code: pollutant } } }];
}

async function stationSeries({ pollutant, startIso, endIso, rows, window = "24h", includeAqi = true, guideline = null, connectorId = 2 }) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let identityCalls = 0;
  let target = "";
  globalThis.fetch = async (input) => {
    const inputUrl = String(input);
    if (inputUrl.includes("/rest/v1/timeseries")) {
      identityCalls += 1;
      return new Response(JSON.stringify(authoritativeIdentity(pollutant)), { status: 200 });
    }
    calls += 1;
    target = inputUrl;
    return new Response(JSON.stringify({ data: rows, response_complete: true, guideline }), { status: 200 });
  };
  try {
    const connectorQuery = connectorId == null ? "" : `&connector_id=${connectorId}`;
    const response = await worker.fetch(new Request(`https://internal/v1/station-series?timeseries_id=7${connectorQuery}&pollutant=${pollutant}&start_utc=${encodeURIComponent(startIso)}&end_utc=${encodeURIComponent(endIso)}&window=${window}&format=objects&include_aqi=${includeAqi}`), env);
    return { response, body: await response.json(), calls, identityCalls, target };
  } finally { globalThis.fetch = originalFetch; }
}

test("NO2 12h station-series uses one ingest-only fetch", async () => {
  const start = "2026-07-01T00:00:00.000Z";
  const result = await stationSeries({ pollutant: "no2", startIso: start, endIso: "2026-07-01T12:00:00.000Z", rows: observations(start, 12, "no2") });
  assert.equal(result.calls, 1);
  assert.equal(result.identityCalls, 1);
  assert.match(result.target, /ingest\.example/);
  assert.equal(result.body.source.mode, "ingest_only");
  assert.equal(result.body.aqi.rows.length, 12);
  assert.equal(result.body.observations.rows.length, 12);
});

test("station-series accepts timeseries identity without a browser connector and returns authoritative identity", async () => {
  const start = "2026-07-01T00:00:00.000Z";
  const result = await stationSeries({ pollutant: "no2", startIso: start, endIso: "2026-07-01T12:00:00.000Z", rows: observations(start, 12, "no2"), connectorId: null });
  assert.equal(result.response.status, 200);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.body.identity, {
    source: "authoritative_timeseries_lookup",
    timeseries_id: 7,
    connector_id: 2,
    station_id: 9,
    pollutant: "no2",
  });
  assert.equal(result.body.request.connector_id, 2);
  assert.equal(result.body.request.station_id, 9);
});

test("PM 24h requests include 23 context hours but exclude them from output", async () => {
  const outputStart = "2026-07-02T00:00:00.000Z";
  const contextStart = "2026-07-01T01:00:00.000Z";
  const result = await stationSeries({ pollutant: "pm25", startIso: outputStart, endIso: "2026-07-03T00:00:00.000Z", rows: observations(contextStart, 47, "pm25") });
  assert.match(result.target, /start_utc=2026-07-01T01%3A00%3A00.000Z/);
  assert.equal(result.body.source.required_context_start_utc, contextStart);
  assert.equal(result.body.observations.rows.length, 24);
  assert.equal(result.body.aqi.rows.length, 24);
  assert.ok(result.body.observations.rows.every((row) => row.observed_at >= outputStart));
});

test("PM context gap leaves complete output observations usable while AQI is incomplete", async () => {
  const outputStart = "2026-07-02T00:00:00.000Z";
  const contextStart = "2026-07-01T01:00:00.000Z";
  const rows = observations(contextStart, 47, "pm25").filter((_, index) => index !== 0);
  const result = await stationSeries({ pollutant: "pm25", startIso: outputStart, endIso: "2026-07-03T00:00:00.000Z", rows });
  assert.equal(result.body.observations.response_complete, true);
  assert.equal(result.body.observations.has_gap, false);
  assert.equal(result.body.observations.next_chunk_end_utc, null);
  assert.equal(result.body.aqi.response_complete, false);
  assert.equal(result.body.aqi.has_gap, true);
  assert.equal(result.body.source.observation_output_complete, true);
  assert.equal(result.body.source.aqi_context_complete, false);
  assert.equal(result.body.source.aqi_output_complete, true);
  assert.equal(result.response.headers.get("Cache-Control"), "no-store");
});

test("incomplete ingest makes both sections incomplete and uncacheable", async () => {
  const start = "2026-07-04T00:00:00.000Z";
  const rows = observations(start, 12, "no2").filter((_, index) => index !== 5);
  const result = await stationSeries({ pollutant: "no2", startIso: start, endIso: "2026-07-04T12:00:00.000Z", rows });
  assert.equal(result.body.observations.response_complete, false);
  assert.equal(result.body.aqi.response_complete, false);
  assert.equal(result.response.headers.get("Cache-Control"), "no-store");
});

test("qualified ingest fast path does not call an R2 upstream", async () => {
  const start = "2026-07-05T00:00:00.000Z";
  const result = await stationSeries({ pollutant: "no2", startIso: start, endIso: "2026-07-05T12:00:00.000Z", rows: observations(start, 12, "no2") });
  assert.equal(result.calls, 1);
  assert.doesNotMatch(result.target, /r2|workers\.dev/i);
});

test("observations-only station-series skips AQI calculation and has an explicit disabled AQI section", async () => {
  const start = "2026-07-06T00:00:00.000Z";
  const result = await stationSeries({ pollutant: "no2", startIso: start, endIso: "2026-07-06T12:00:00.000Z", rows: observations(start, 12, "no2"), window: "12h", includeAqi: false });
  assert.equal(result.calls, 1);
  assert.equal(result.body.source.mode, "ingest_observations_only");
  assert.equal(result.body.aqi.enabled, false);
  assert.equal(result.body.aqi.state, "disabled");
  assert.deepEqual(result.body.aqi.rows, []);
  assert.equal(result.body.aqi.next_chunk_end_utc, null);
  assert.equal(result.body.observations.next_chunk_end_utc, null);
  assert.equal(result.response.headers.get("Cache-Control"), "public, max-age=60, s-maxage=60");
});

test("long observations-only station-series stays bounded and never requests the R2 AQI head", async () => {
  const end = "2026-07-20T00:00:00.000Z";
  const headStart = "2026-07-13T00:00:00.000Z";
  const result = await stationSeries({ pollutant: "pm25", startIso: "2026-07-01T00:00:00.000Z", endIso: end, rows: observations(headStart, 168, "pm25"), window: "31d", includeAqi: false });
  assert.equal(result.calls, 1);
  assert.match(result.target, /start_utc=2026-07-13T00%3A00%3A00.000Z/);
  assert.equal(result.body.aqi.enabled, false);
  assert.equal(result.body.observations.rows.length, 168);
  assert.equal(result.body.observations.next_chunk_end_utc, headStart);
});

test("PM observations-only requests do not fetch AQI context", () => {
  const request = resolveStationSeriesRequest(new URL("https://internal/v1/station-series?timeseries_id=7&connector_id=2&pollutant=pm25&start_utc=2026-07-06T00%3A00%3A00.000Z&end_utc=2026-07-07T00%3A00%3A00.000Z&window=24h&format=objects&include_aqi=false"));
  assert.equal(request?.includeAqi, false);
  assert.equal(request?.contextHours, 0);
});

test("station-series retains the observation guideline for the chart renderer", async () => {
  const start = "2026-07-07T00:00:00.000Z";
  const guideline = { limit_value: 25, uom: "µg/m³" };
  const result = await stationSeries({ pollutant: "no2", startIso: start, endIso: "2026-07-07T12:00:00.000Z", rows: observations(start, 12, "no2"), window: "12h", guideline });
  assert.deepEqual(result.body.observations.guideline, guideline);
});
