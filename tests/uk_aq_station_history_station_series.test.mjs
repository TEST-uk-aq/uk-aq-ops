import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { buildStationSeries, resolveStationSeriesRequest } from "../workers/uk_aq_station_history/src/index.mjs";
import { normalizeDirectIngestRows } from "../workers/uk_aq_station_history/src/ingest_observations.mjs";

const HOUR_MS = 60 * 60 * 1000;
const identity = { timeseriesId: 7, connectorId: 2, stationId: 9, pollutant: "no2" };
const env = {
  SUPABASE_URL: "https://identity.example",
  SB_SECRET_KEY: "service-key",
  OBS_AQIDB_SUPABASE_URL: "https://obsaqi.example",
  OBS_AQIDB_SECRET_KEY: "obs-key",
  UK_AQ_PUBLIC_SCHEMA: "uk_aq_public",
  INGESTDB_RETENTION_DAYS: "31",
  UK_AQ_EDGE_UPSTREAM_SECRET: "upstream-key",
  UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi-r2.example/v1/aqi-history",
  UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observs-r2.example/v1/observations",
};

test("station-series has no dependency on the stitched public timeseries Edge Function", async () => {
  const source = await readFile("workers/uk_aq_station_history/src/index.mjs", "utf8");
  const directSource = await readFile("workers/uk_aq_station_history/src/ingest_observations.mjs", "utf8");
  assert.doesNotMatch(`${source}\n${directSource}`, /\/functions\/v1\/uk_aq_timeseries|fetchIngestOnce/);
});

function observations(startIso, hours, pollutant = "no2") {
  const startMs = Date.parse(startIso);
  return Array.from({ length: hours }, (_, index) => ({ connector_id: 2, station_id: 9, timeseries_id: 7, pollutant_code: pollutant, observed_at_utc: new Date(startMs + index * HOUR_MS).toISOString(), value: 20 }));
}

function identityPayload(pollutant = "no2") {
  return [{ id: 7, station_id: 9, connector_id: 2, phenomenon_id: 4, ended_at: null, phenomena: { connector_id: 2, observed_property_id: 5, observed_properties: { code: pollutant } } }];
}

function request({ pollutant = "no2", startIso, endIso, includeAqi = true, window = "12h" }) {
  return { ...identity, pollutant, startMs: Date.parse(startIso), endMs: Date.parse(endIso), contextHours: includeAqi && pollutant.startsWith("pm") ? 23 : 0, contextStartMs: Date.parse(startIso) - (includeAqi && pollutant.startsWith("pm") ? 23 : 0) * HOUR_MS, includeAqi, window };
}

test("direct ObsAQIDB rows retain authority and malformed neighbours survive", () => {
  const normalized = normalizeDirectIngestRows([
    ...observations("2026-07-14T00:00:00.000Z", 1),
    { ...observations("2026-07-14T01:00:00.000Z", 1)[0], value: "not-finite" },
    ...observations("2026-07-14T02:00:00.000Z", 1),
  ], identity);
  assert.equal(normalized.rows.length, 2);
  assert.equal(normalized.rejected_row_count, 1);
  assert.ok(normalized.rows.every((row) => row.source === "ingest" && row.connector_id === 2 && row.station_id === 9));
  assert.throws(() => normalizeDirectIngestRows([{ ...observations("2026-07-14T00:00:00.000Z", 1)[0], connector_id: 3 }], identity), /identity_mismatch/);
});

test("fully covered NO2 12h uses one direct read and no R2", async () => {
  const originalFetch = globalThis.fetch;
  const targets = [];
  globalThis.fetch = async (input) => {
    const url = String(input); targets.push(url);
    if (url.includes("/rest/v1/timeseries")) return new Response(JSON.stringify(identityPayload()), { status: 200 });
    if (url.includes("/rest/v1/uk_aq_observations")) return new Response(JSON.stringify(observations("2026-07-14T00:00:00.000Z", 12)), { status: 200 });
    throw new Error(`unexpected R2 call: ${url}`);
  };
  try {
    const response = await worker.fetch(new Request("https://internal/v1/station-series?timeseries_id=7&pollutant=no2&start_utc=2026-07-14T00%3A00%3A00.000Z&end_utc=2026-07-14T12%3A00%3A00.000Z&window=12h&format=objects"), env);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source.mode, "ingest_only");
    assert.equal(body.source.ingest_fetch_count, 1);
    assert.equal(body.aqi.rows.length, 12);
    assert.equal(body.observations.rows.length, 12);
    assert.equal(body.aqi.next_chunk_end_utc, null);
    assert.equal(body.observations.next_chunk_end_utc, null);
    assert.equal(targets.filter((url) => url.includes("uk_aq_observations")).length, 1);
    assert.ok(targets.every((url) => !url.includes("/functions/v1/uk_aq_timeseries")));
    assert.ok(targets.every((url) => !url.includes("r2.example")));
    const directUrl = new URL(targets.find((url) => url.includes("uk_aq_observations")));
    assert.equal(directUrl.searchParams.get("select"), "connector_id,station_id,timeseries_id,pollutant_code,observed_at_utc,value");
  } finally { globalThis.fetch = originalFetch; }
});

test("fully covered PM 24h reads 23 context hours once and excludes context output", async () => {
  const originalFetch = globalThis.fetch;
  let directUrl;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("uk_aq_observations")) { directUrl = new URL(url); return new Response(JSON.stringify(observations("2026-07-12T01:00:00.000Z", 47, "pm25")), { status: 200 }); }
    throw new Error(`unexpected call: ${url}`);
  };
  try {
    const body = await buildStationSeries(request({ pollutant: "pm25", startIso: "2026-07-13T00:00:00.000Z", endIso: "2026-07-14T00:00:00.000Z", window: "24h" }), env, Date.parse("2026-07-14T00:30:00.000Z"));
    assert.equal(directUrl.searchParams.getAll("observed_at_utc")[0], "gte.2026-07-12T01:00:00.000Z");
    assert.equal(body.source.ingest_fetch_count, 1);
    assert.equal(body.observations.rows.length, 24);
    assert.equal(body.aqi.rows.length, 24);
    assert.ok(body.observations.rows.every((row) => row.observed_at >= "2026-07-13T00:00:00.000Z"));
  } finally { globalThis.fetch = originalFetch; }
});

test("old 24h label follows R2 observation path and reuses its one direct result", async () => {
  const originalFetch = globalThis.fetch;
  const targets = [];
  globalThis.fetch = async (input) => {
    const url = String(input); targets.push(url);
    if (url.includes("uk_aq_observations")) return new Response("[]", { status: 200 });
    if (url.includes("observs-r2.example")) return new Response(JSON.stringify({ timeseries_id: 7, connector_id: 2, pollutant: "no2", response_complete: true, has_gap: false, coverage_state: "complete", rows: observations("2026-06-01T00:00:00.000Z", 24).map((row) => ({ observed_at: row.observed_at_utc, value: row.value })) }), { status: 200 });
    throw new Error(`unexpected call: ${url}`);
  };
  try {
    const body = await buildStationSeries(request({ startIso: "2026-06-01T00:00:00.000Z", endIso: "2026-06-02T00:00:00.000Z", includeAqi: false, window: "24h" }), env, Date.parse("2026-07-15T00:00:00.000Z"));
    assert.notEqual(body.source.mode, "ingest_observations_only");
    assert.equal(body.source.ingest_fetch_count, 1);
    assert.equal(body.source.used_r2_observations, true);
    assert.equal(targets.filter((url) => url.includes("uk_aq_observations")).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("PM observations-only requests do not request AQI context", () => {
  const parsed = resolveStationSeriesRequest(new URL("https://internal/v1/station-series?timeseries_id=7&connector_id=2&pollutant=pm25&start_utc=2026-07-13T00%3A00%3A00.000Z&end_utc=2026-07-14T00%3A00%3A00.000Z&window=24h&format=objects&include_aqi=false"));
  assert.equal(parsed.contextHours, 0);
});
