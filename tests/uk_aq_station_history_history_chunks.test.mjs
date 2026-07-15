import assert from "node:assert/strict";
import test from "node:test";
import worker from "../workers/uk_aq_station_history/src/index.mjs";
import {
  aqiResponseRows,
  buildAqiHistoryChunk,
  buildObservationHistoryChunk,
  classifyChunk,
  parseHistoryChunkRequest,
} from "../workers/uk_aq_station_history/src/history_chunks.mjs";
import { resolveStationHistoryPolicy } from "../workers/uk_aq_station_history/src/policy.mjs";

function chunkUrl(path, start, end, extra = "") {
  return new URL(`https://internal${path}?timeseries_id=7&connector_id=2&pollutant=pm25&start_utc=${encodeURIComponent(start)}&end_utc=${encodeURIComponent(end)}&stable_head_start_utc=${encodeURIComponent("2026-07-08T00:00:00.000Z")}&format=objects${extra}`);
}

test("chunk boundaries progress newest first without gaps or overlap", () => {
  const newest = parseHistoryChunkRequest(chunkUrl("/v1/aqi-history", "2026-07-01T00:00:00.000Z", "2026-07-08T00:00:00.000Z"), "aqi");
  const older = parseHistoryChunkRequest(chunkUrl("/v1/aqi-history", "2026-06-24T00:00:00.000Z", newest.startUtc), "aqi");
  assert.equal(newest.ok, true);
  assert.equal(older.endUtc, newest.startUtc);
  const body = buildAqiHistoryChunk(newest, { points: [], response_complete: false }, Date.parse("2026-07-15T00:00:00.000Z"));
  assert.equal(body.chunk.direction, "newest_first");
  assert.equal(body.chunk.next_older_chunk_end_utc, newest.startUtc);
  assert.equal(body.chunk.replacement_policy, "extend_backwards_only");
});

test("identical chunk requests produce a deterministic retry key", () => {
  const url = chunkUrl("/v1/observations-history", "2026-07-01T00:00:00.000Z", "2026-07-07T00:00:00.000Z", "&limit=1000");
  const first = parseHistoryChunkRequest(url, "observations");
  const second = parseHistoryChunkRequest(new URL(url.toString()), "observations");
  assert.equal(first.retryKey, second.retryKey);
});

test("chunk immutable classification uses the existing 120 hour boundary", () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  assert.equal(classifyChunk(Date.parse("2026-07-09T00:00:00.000Z"), now), "immutable");
  assert.equal(classifyChunk(Date.parse("2026-07-14T00:00:00.000Z"), now), "mutable");
});

test("chunks overlapping the stable head are rejected", () => {
  const parsed = parseHistoryChunkRequest(chunkUrl("/v1/aqi-history", "2026-07-07T00:00:00.000Z", "2026-07-09T00:00:00.000Z"), "aqi");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "history_chunk_overlaps_stable_head");
});

test("station-history source and chunk limits are configurable with safe bounded defaults", () => {
  const defaults = resolveStationHistoryPolicy({});
  assert.deepEqual(defaults, { stableAqiHeadMaxHours: 168, aqiChunkMaxHours: 744, observationChunkMaxHours: 168, observationOverlapHours: 2, obsAqiDbTimeoutMs: 10000, ingestRetentionDays: 5 });
  const tuned = resolveStationHistoryPolicy({ UK_AQ_STATION_HISTORY_AQI_CHUNK_MAX_HOURS: "24", UK_AQ_STATION_HISTORY_OBSERVATION_OVERLAP_HOURS: "3", UK_AQ_STATION_HISTORY_OBSAQIDB_TIMEOUT_MS: "5000" });
  assert.equal(tuned.aqiChunkMaxHours, 24);
  assert.equal(tuned.observationOverlapHours, 3);
  assert.equal(tuned.obsAqiDbTimeoutMs, 5000);
  assert.equal(resolveStationHistoryPolicy({ UK_AQ_STATION_HISTORY_OBSERVATION_OVERLAP_HOURS: "9" }).observationOverlapHours, 2);
});

test("incomplete AQI and observation R2 responses remain independently incomplete", () => {
  const aqiChunk = parseHistoryChunkRequest(chunkUrl("/v1/aqi-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z"), "aqi");
  const obsChunk = parseHistoryChunkRequest(chunkUrl("/v1/observations-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z"), "observations");
  const retainedAqiRow = { period_start_utc: "2026-07-07T01:00:00.000Z", timeseries_id: 7, connector_id: 2, pollutant_code: "pm25", daqi_index_level: 3, eaqi_index_level: 2, source: "r2" };
  const aqi = buildAqiHistoryChunk(aqiChunk, { points: [retainedAqiRow], response_complete: false, partial_reasons: ["missing_manifest"] });
  const observations = buildObservationHistoryChunk(obsChunk, { rows: [{ observed_at: "2026-07-07T01:00:00.000Z", value: 2 }, { observed_at: "2026-07-07T01:00:00Z", value: 2 }], response_complete: false, coverage: { response_complete: false } });
  assert.equal(aqi.response_complete, false);
  assert.equal(aqi.has_gap, true);
  assert.equal(aqi.points.length, 1, "valid R2 AQI rows survive a partial historical chunk");
  assert.equal(aqi.points[0].period_start_utc, retainedAqiRow.period_start_utc);
  assert.equal(observations.response_complete, false);
  assert.equal(observations.rows.length, 1);
  assert.deepEqual(observations.rows.map((row) => row.observed_at), ["2026-07-07T01:00:00.000Z"]);
});

test("AQI object and compact formats retain the existing columns", () => {
  const chunk = parseHistoryChunkRequest(chunkUrl("/v1/aqi-history", "2026-07-07T00:00:00.000Z", "2026-07-07T01:00:00.000Z"), "aqi");
  const body = buildAqiHistoryChunk(chunk, { columns: ["period_start_utc", "timeseries_id", "source"], points: [{ period_start_utc: "2026-07-07T00:00:00.000Z", timeseries_id: 7, connector_id: 2, pollutant_code: "pm25", source: "r2" }], response_complete: true });
  assert.equal(aqiResponseRows(body, "objects").points[0].source, "r2");
  assert.deepEqual(aqiResponseRows(body, "compact").points, [["2026-07-07T00:00:00.000Z", 7, "r2"]]);
});

test("AQI and observation upstream failures use independent error contracts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/rest/v1/timeseries")) {
      return new Response(JSON.stringify([{ id: 7, station_id: 9, connector_id: 2, phenomenon_id: 4, ended_at: null, phenomena: { connector_id: 2, observed_property_id: 5, observed_properties: { code: "pm25" } } }]), { status: 200 });
    }
    throw new Error(String(input).includes("aqi") ? "aqi down" : "observations down");
  };
  const env = { SUPABASE_URL: "https://ingest.example", SB_SECRET_KEY: "service-key", UK_AQ_EDGE_UPSTREAM_SECRET: "secret", UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi.example/v1/aqi-history", UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observations.example/v1/observations" };
  try {
    const aqiResponse = await worker.fetch(new Request(chunkUrl("/v1/aqi-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z")), env);
    const obsResponse = await worker.fetch(new Request(chunkUrl("/v1/observations-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z")), env);
    assert.equal((await aqiResponse.json()).error.code, "aqi_history_r2_failed");
    assert.equal((await obsResponse.json()).error.code, "observation_history_r2_failed");
  } finally { globalThis.fetch = originalFetch; }
});

test("history chunks reject a connector that differs from authoritative timeseries identity", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify([{ id: 7, station_id: 9, connector_id: 2, phenomenon_id: 4, ended_at: null, phenomena: { connector_id: 2, observed_property_id: 5, observed_properties: { code: "pm25" } } }]), { status: 200 });
  };
  const env = { SUPABASE_URL: "https://ingest.example", SB_SECRET_KEY: "service-key", UK_AQ_EDGE_UPSTREAM_SECRET: "secret", UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi.example/v1/aqi-history" };
  try {
    const url = chunkUrl("/v1/aqi-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z");
    url.searchParams.set("connector_id", "3");
    const response = await worker.fetch(new Request(url), env);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "station_history_connector_mismatch");
    assert.equal(calls, 1, "R2 is not read after authoritative chunk identity rejection");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
