import assert from "node:assert/strict";
import test from "node:test";
import worker from "../workers/uk_aq_station_history/src/index.mjs";
import { mergeStableAqiHead, normalizeExactR2AqiRows } from "../workers/uk_aq_station_history/src/stable_head.mjs";

const HOUR_MS = 60 * 60 * 1000;
const requestIdentity = { timeseriesId: 7, connectorId: 2, pollutant: "pm25" };
const bounds = { headStartMs: Date.parse("2026-07-01T00:00:00.000Z"), headEndMs: Date.parse("2026-07-01T02:00:00.000Z") };

function aqi(hour, source, daqi = 2, eaqi = 3) {
  return { timeseries_id: 7, connector_id: 2, station_id: 9, pollutant_code: "pm25", timestamp_hour_utc: hour, daqi_index_level: daqi, eaqi_index_level: eaqi, daqi_calculation_status: "ok", eaqi_calculation_status: "ok", source };
}

test("matching R2/live overlap returns one authoritative R2 row", () => {
  const hour = "2026-07-01T00:00:00.000Z";
  const result = mergeStableAqiHead({ r2Rows: [aqi(hour, "r2")], liveRows: [aqi(hour, "live_calculated")], request: requestIdentity, bounds });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].source, "r2");
  assert.equal(result.overlap_count, 1);
  assert.equal(result.mismatch_count, 0);
});

test("differing R2/live overlap retains R2 and records mismatch diagnostics", () => {
  const hour = "2026-07-01T00:00:00.000Z";
  const result = mergeStableAqiHead({ r2Rows: [aqi(hour, "r2", 5, 4)], liveRows: [aqi(hour, "live_calculated", 2, 3)], request: requestIdentity, bounds });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].daqi_index_level, 5);
  assert.equal(result.mismatch_count, 1);
  assert.deepEqual(result.mismatch_hours, [hour]);
});

test("conflicting R2 identities and duplicate rows fail closed", () => {
  const hour = "2026-07-01T00:00:00.000Z";
  assert.throws(() => normalizeExactR2AqiRows({ points: [{ ...aqi(hour, "r2"), connector_id: 3 }] }, requestIdentity, bounds), /identity_mismatch/);
  assert.throws(() => normalizeExactR2AqiRows({ points: [aqi(hour, "r2", 2), aqi(hour, "r2", 5)] }, requestIdentity, bounds), /duplicate_conflict/);
});

function r2Rows(startIso, count, missingIndex = -1) {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => index).filter((index) => index !== missingIndex).map((index) => aqi(new Date(startMs + index * HOUR_MS).toISOString(), "r2"));
}

function observationRows(startIso, count) {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => ({ timeseries_id: 7, connector_id: 2, station_id: 9, pollutant_code: "pm25", observed_at: new Date(startMs + index * HOUR_MS).toISOString(), value: 20 }));
}

async function longRequest({ incompleteIngest = false } = {}) {
  const originalFetch = globalThis.fetch;
  const targets = [];
  const headStart = "2026-07-01T00:00:00.000Z";
  const end = "2026-07-08T00:00:00.000Z";
  globalThis.fetch = async (input) => {
    targets.push(String(input));
    if (targets.length === 1) {
      return new Response(JSON.stringify({ points: r2Rows(headStart, 168, 167), response_complete: true, coverage: { r2_expected_hour_coverage: { complete: false } } }), { status: 200 });
    }
    const contextStart = "2026-07-07T00:00:00.000Z";
    const rows = observationRows(contextStart, incompleteIngest ? 23 : 24);
    return new Response(JSON.stringify({ data: rows, response_complete: !incompleteIngest }), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request(`https://internal/v1/station-series?timeseries_id=7&connector_id=2&pollutant=pm25&start_utc=${encodeURIComponent(headStart)}&end_utc=${encodeURIComponent(end)}&window=7d&format=objects`), { SUPABASE_URL: "https://ingest.example", SB_PUBLISHABLE_DEFAULT_KEY: "key", UK_AQ_EDGE_UPSTREAM_SECRET: "secret", UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi-r2.example/v1/aqi-history" });
    return { response, body: await response.json(), targets };
  } finally { globalThis.fetch = originalFetch; }
}

test("stable head has one row per hour and later chunks can only extend backwards", async () => {
  const result = await longRequest();
  assert.equal(result.body.aqi.rows.length, 168);
  assert.equal(new Set(result.body.aqi.rows.map((row) => row.timestamp_hour_utc)).size, 168);
  assert.equal(result.body.aqi.stable_head_locked, true);
  assert.equal(result.body.aqi.replacement_policy, "extend_backwards_only");
  assert.equal(result.body.aqi.next_older_aqi_chunk_end_utc, result.body.aqi.stable_head_start_utc);
});

test("PM context crosses the R2/live boundary and only two source calls occur", async () => {
  const result = await longRequest();
  assert.equal(result.targets.length, 2);
  assert.match(result.targets[0], /aqi-r2\.example/);
  assert.match(result.targets[1], /start_utc=2026-07-07T00%3A00%3A00.000Z/);
  assert.equal(result.body.aqi.source_counts.live_calculated, 1);
  assert.equal(result.body.aqi.rows.at(-1).source, "live_calculated");
});

test("incomplete live source leaves the stable head unlocked and uncacheable", async () => {
  const result = await longRequest({ incompleteIngest: true });
  assert.equal(result.body.aqi.response_complete, false);
  assert.equal(result.body.aqi.stable_head_locked, false);
  assert.equal(result.response.headers.get("Cache-Control"), "no-store");
});

test("R2 claiming complete coverage with an incomplete response fails closed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ points: [], response_complete: false, coverage: { r2_expected_hour_coverage: { complete: true } } }), { status: 200 });
  try {
    const response = await worker.fetch(new Request("https://internal/v1/station-series?timeseries_id=7&connector_id=2&pollutant=pm25&start_utc=2026-07-01T00%3A00%3A00.000Z&end_utc=2026-07-08T00%3A00%3A00.000Z&window=7d&format=objects"), { UK_AQ_EDGE_UPSTREAM_SECRET: "secret", UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi-r2.example/v1/aqi-history" });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).error.code, "station_series_r2_claimed_complete_response_incomplete");
  } finally { globalThis.fetch = originalFetch; }
});
