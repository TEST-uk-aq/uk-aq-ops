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

test("incomplete AQI and observation R2 responses remain independently incomplete", () => {
  const aqiChunk = parseHistoryChunkRequest(chunkUrl("/v1/aqi-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z"), "aqi");
  const obsChunk = parseHistoryChunkRequest(chunkUrl("/v1/observations-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z"), "observations");
  const aqi = buildAqiHistoryChunk(aqiChunk, { points: [], response_complete: false, partial_reasons: ["missing_manifest"] });
  const observations = buildObservationHistoryChunk(obsChunk, { rows: [{ observed_at: "2026-07-07T01:00:00.000Z", value: 2 }, { observed_at: "2026-07-07T01:00:00Z", value: 2 }], response_complete: false, coverage: { response_complete: false } });
  assert.equal(aqi.response_complete, false);
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
  globalThis.fetch = async (input) => { throw new Error(String(input).includes("aqi") ? "aqi down" : "observations down"); };
  const env = { UK_AQ_EDGE_UPSTREAM_SECRET: "secret", UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi.example/v1/aqi-history", UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observations.example/v1/observations" };
  try {
    const aqiResponse = await worker.fetch(new Request(chunkUrl("/v1/aqi-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z")), env);
    const obsResponse = await worker.fetch(new Request(chunkUrl("/v1/observations-history", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z")), env);
    assert.equal((await aqiResponse.json()).error.code, "aqi_history_r2_failed");
    assert.equal((await obsResponse.json()).error.code, "observation_history_r2_failed");
  } finally { globalThis.fetch = originalFetch; }
});


