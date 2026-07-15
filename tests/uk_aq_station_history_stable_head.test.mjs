import assert from "node:assert/strict";
import test from "node:test";
import { buildStationSeries } from "../workers/uk_aq_station_history/src/index.mjs";
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
  return Array.from({ length: count }, (_, index) => ({ timeseries_id: 7, connector_id: 2, station_id: 9, pollutant_code: "pm25", observed_at_utc: new Date(startMs + index * HOUR_MS).toISOString(), value: 20 }));
}

function rpcPayload(rows) {
  return [{
    timeseries_id: 7,
    window: "7d",
    start: "2026-06-30T00:00:00.000Z",
    end: "2026-07-08T00:00:00.000Z",
    count: rows.length,
    guideline: { source: "WHO" },
    data: rows.map((row) => ({ observed_at: row.observed_at_utc, value: row.value })),
  }];
}

async function longRequest({ incompleteIngest = false, r2MissingIndex = 167, missingObservationIndex = incompleteIngest ? 190 : -1 } = {}) {
  const originalFetch = globalThis.fetch;
  const targets = [];
  const headStart = "2026-07-01T00:00:00.000Z";
  const end = "2026-07-08T00:00:00.000Z";
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); targets.push(url);
    if (url.includes("uk_aq_timeseries_rpc")) {
      const contextStart = "2026-06-30T01:00:00.000Z";
      const rows = observationRows(contextStart, 191).filter((_row, index) => index !== missingObservationIndex);
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify(rpcPayload(rows)), { status: 200 });
    }
    if (url.includes("aqi-r2.example")) {
      return new Response(JSON.stringify({ points: r2Rows(headStart, 168, r2MissingIndex), response_complete: true, coverage: { r2_expected_hour_coverage: { complete: r2MissingIndex < 0 } } }), { status: 200 });
    }
    if (url.includes("observs-r2.example")) {
      return new Response(JSON.stringify({ timeseries_id: 7, connector_id: 2, pollutant: "pm25", response_complete: true, has_gap: false, coverage_state: "complete", rows: observationRows("2026-06-30T01:00:00.000Z", 2).map((row) => ({ observed_at: row.observed_at_utc, value: row.value })) }), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const request = { timeseriesId: 7, connectorId: 2, stationId: 9, pollutant: "pm25", startMs: Date.parse("2026-06-24T00:00:00.000Z"), endMs: Date.parse(end), contextHours: 23, contextStartMs: Date.parse("2026-06-23T01:00:00.000Z"), includeAqi: true, window: "14d" };
    const body = await buildStationSeries(request, { OBS_AQIDB_SUPABASE_URL: "https://obsaqi.example", OBS_AQIDB_SECRET_KEY: "obs-key", INGESTDB_RETENTION_DAYS: "31", UK_AQ_EDGE_UPSTREAM_SECRET: "secret", UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi-r2.example/v1/aqi-history", UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observs-r2.example/v1/observations" }, Date.parse("2026-07-08T00:30:00.000Z"));
    return { body, targets };
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

test("one bounded PM ingest bundle supplies the stable head observations and live R2 gap", async () => {
  const result = await longRequest();
  assert.equal(result.targets.length, 3);
  assert.match(result.targets[0], /uk_aq_timeseries_rpc/);
  assert.match(result.targets[1], /aqi-r2\.example/);
  assert.match(result.targets[2], /observs-r2\.example/);
  assert.doesNotMatch(result.targets[0], /uk_aq_observations|observed_at_utc=/);
  assert.equal(result.body.aqi.source_counts.live_calculated, 1);
  assert.equal(result.body.aqi.rows.at(-1).source, "live_calculated");
  assert.equal(result.body.observations.rows.length, 168);
  assert.equal(result.body.source.discarded_ingest_observation_overlap_count, 2);
  assert.equal(result.body.source.live_calculation_observation_sources.r2, 2);
});

test("incomplete live source leaves the stable head unlocked and uncacheable", async () => {
  const result = await longRequest({ incompleteIngest: true });
  assert.equal(result.body.aqi.response_complete, false);
  assert.equal(result.body.aqi.stable_head_locked, false);
});

test("complete R2 AQI remains complete when unrelated recent observations are incomplete", async () => {
  const result = await longRequest({ r2MissingIndex: -1, incompleteIngest: true, missingObservationIndex: 80 });
  assert.equal(result.body.aqi.response_complete, true);
  assert.equal(result.body.aqi.has_gap, false);
  assert.equal(result.body.observations.response_complete, false);
  assert.equal(result.body.observations.has_gap, true);
});

test("R2 claiming complete coverage with an incomplete response fails closed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("uk_aq_timeseries_rpc")
    ? new Response(JSON.stringify(rpcPayload(observationRows("2026-06-30T01:00:00.000Z", 191))), { status: 200 })
    : new Response(JSON.stringify({ points: [], response_complete: false, coverage: { r2_expected_hour_coverage: { complete: true } } }), { status: 200 });
  try {
    const request = { timeseriesId: 7, connectorId: 2, stationId: 9, pollutant: "pm25", startMs: Date.parse("2026-06-24T00:00:00.000Z"), endMs: Date.parse("2026-07-08T00:00:00.000Z"), contextHours: 23, contextStartMs: Date.parse("2026-06-23T01:00:00.000Z"), includeAqi: true, window: "14d" };
    await assert.rejects(buildStationSeries(request, { OBS_AQIDB_SUPABASE_URL: "https://obsaqi.example", OBS_AQIDB_SECRET_KEY: "obs-key", INGESTDB_RETENTION_DAYS: "31", UK_AQ_EDGE_UPSTREAM_SECRET: "secret", UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi-r2.example/v1/aqi-history", UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observs-r2.example/v1/observations" }, Date.parse("2026-07-08T00:30:00.000Z")), /station_series_r2_claimed_complete_response_incomplete/);
  } finally { globalThis.fetch = originalFetch; }
});
