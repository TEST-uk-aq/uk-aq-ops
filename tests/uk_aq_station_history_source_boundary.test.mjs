import assert from "node:assert/strict";
import test from "node:test";
import { buildStationSeries } from "../workers/uk_aq_station_history/src/index.mjs";

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-07-16T09:52:58.189Z");
const START_MS = Date.parse("2026-07-09T09:52:48.518Z");
const END_MS = Date.parse("2026-07-16T09:52:48.518Z");
const R2_END_MS = Date.parse("2026-07-12T00:00:00.000Z");

function hourlyRows(startMs, endMs, field = "observed_at") {
  const rows = [];
  for (let hour = startMs; hour < endMs; hour += HOUR_MS) rows.push({ [field]: new Date(hour).toISOString(), value: 20 });
  return rows;
}

function r2AqiRows() {
  const rows = [];
  for (let hour = Math.ceil(START_MS / HOUR_MS) * HOUR_MS; hour < R2_END_MS; hour += HOUR_MS) {
    rows.push({
      timeseries_id: 260,
      connector_id: 2,
      station_id: 9,
      pollutant_code: "pm25",
      timestamp_hour_utc: new Date(hour).toISOString(),
      daqi_index_level: 2,
      eaqi_index_level: 2,
      daqi_calculation_status: "ok",
      eaqi_calculation_status: "ok",
      source: "r2",
    });
  }
  return rows;
}

test("actual ingest coverage crosses the HAR seam without treating retention as a source boundary", async () => {
  const originalFetch = globalThis.fetch;
  const targets = [];
  let ingestRows = hourlyRows(R2_END_MS, Date.parse("2026-07-16T08:00:00.000Z"));
  const r2Observations = hourlyRows(Math.ceil(START_MS / HOUR_MS) * HOUR_MS, R2_END_MS);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    targets.push(url);
    if (url.includes("uk_aq_timeseries_rpc")) {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), {
        timeseries_id: 260,
        window_label: "7d",
        limit_rows: null,
        since_ts: null,
        include_status: false,
      });
      return new Response(JSON.stringify([{
        timeseries_id: 260,
        window: "7d",
        start: "2026-07-09T09:52:58.189Z",
        end: "2026-07-16T09:52:58.189Z",
        count: ingestRows.length,
        guideline: { source: "WHO" },
        data: ingestRows,
      }]), { status: 200 });
    }
    if (url.includes("aqi-r2.example")) {
      return new Response(JSON.stringify({
        points: r2AqiRows(),
        response_complete: false,
        coverage: { r2_expected_hour_coverage: { complete: false } },
      }), { status: 200 });
    }
    if (url.includes("observs-r2.example")) {
      return new Response(JSON.stringify({
        timeseries_id: 260,
        connector_id: 2,
        pollutant: "pm25",
        response_complete: false,
        has_gap: false,
        coverage_state: "partial",
        rows: r2Observations,
      }), { status: 200 });
    }
    throw new Error(`unexpected upstream ${url}`);
  };

  try {
    const body = await buildStationSeries({
      timeseriesId: 260,
      connectorId: 2,
      stationId: 9,
      pollutant: "pm25",
      startMs: START_MS,
      endMs: END_MS,
      contextHours: 23,
      contextStartMs: START_MS - 23 * HOUR_MS,
      includeAqi: true,
      window: "7d",
    }, {
      SUPABASE_URL: "https://ingest.example",
      SB_SECRET_KEY: "ingest-key",
      INGESTDB_RETENTION_DAYS: "4",
      UK_AQ_EDGE_UPSTREAM_SECRET: "secret",
      UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi-r2.example/v1/aqi-history",
      UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observs-r2.example/v1/observations",
    }, NOW_MS);

    const seamHours = hourlyRows(R2_END_MS, Date.parse("2026-07-12T10:00:00.000Z"))
      .map((row) => row.observed_at);
    const outputObservationHours = new Set(body.observations.rows.map((row) => row.observed_at));
    const outputAqiHours = new Set(body.aqi.rows.map((row) => row.timestamp_hour_utc));
    for (const hour of seamHours) {
      assert.ok(outputObservationHours.has(hour), `observation seam hour retained: ${hour}`);
      assert.ok(outputAqiHours.has(hour), `AQI seam hour retained: ${hour}`);
    }
    assert.notEqual(body.aqi.rows.find((row) => row.timestamp_hour_utc === "2026-07-12T00:00:00.000Z")?.daqi_index_level, null,
      "PM rolling AQI uses R2 context before the seam and ingest observations after it");

    assert.equal(body.source.direct_ingest_requested_start_utc, "2026-07-08T10:52:48.518Z");
    assert.equal(body.source.direct_ingest_actual_start_utc, "2026-07-12T00:00:00.000Z");
    assert.equal(body.source.direct_ingest_actual_end_utc, "2026-07-16T07:00:00.000Z");
    assert.equal(body.source.r2_aqi_actual_end_utc, "2026-07-11T23:00:00.000Z");
    assert.equal(body.source.r2_observations_actual_end_utc, "2026-07-11T23:00:00.000Z");
    assert.equal(body.source.r2_aqi_assigned_complete, true);
    assert.equal(body.source.r2_observations_assigned_complete, true);
    assert.equal(body.source.raw_ingest_row_count, 104);
    assert.equal(body.source.valid_normalized_ingest_row_count, 104);
    assert.equal(body.source.retained_calculation_ingest_row_count, 104);
    assert.equal(body.source.malformed_or_invalid_ingest_row_count, 0);
    assert.equal(body.source.outside_required_ingest_source_interval_row_count, 0);
    assert.equal(body.source.output_ingest_row_count, 104);
    assert.equal(body.source.logical_ingest_fetch_count, 1);
    assert.equal(body.source.ingest_fetch_count, 1);
    assert.equal(body.source.seam_gap_hour_count, 2, "only the genuine current-data lag remains");
    assert.equal(body.source.aqi_seam_gap_hour_count, 2);
    assert.equal(body.source.observation_seam_gap_hour_count, 2);
    assert.equal(body.observations.rows.some((row) => Date.parse(row.observed_at) < START_MS), false);
    assert.equal(body.aqi.rows.some((row) => Date.parse(row.timestamp_hour_utc) < START_MS), false);
    assert.equal(targets.filter((url) => url.includes("uk_aq_timeseries_rpc")).length, 1);
    assert.equal(targets.some((url) => url.includes("/functions/v1/uk_aq_timeseries")), false);
    assert.equal(body.observations.rows.find((row) => row.observed_at === "2026-07-11T23:00:00.000Z")?.source, "r2");
    assert.equal(body.observations.rows.find((row) => row.observed_at === "2026-07-12T00:00:00.000Z")?.source, "ingest");

    // The upstream R2 response remains partial because it does not own the
    // deliberately live tail. Once that tail is present, the merged head is
    // complete rather than being rejected by the broad R2 status alone.
    ingestRows = hourlyRows(R2_END_MS, Math.ceil(END_MS / HOUR_MS) * HOUR_MS);
    const mergedComplete = await buildStationSeries({
      timeseriesId: 260,
      connectorId: 2,
      stationId: 9,
      pollutant: "pm25",
      startMs: START_MS,
      endMs: END_MS,
      contextHours: 23,
      contextStartMs: START_MS - 23 * HOUR_MS,
      includeAqi: true,
      window: "7d",
    }, {
      SUPABASE_URL: "https://ingest.example",
      SB_SECRET_KEY: "ingest-key",
      INGESTDB_RETENTION_DAYS: "4",
      UK_AQ_EDGE_UPSTREAM_SECRET: "secret",
      UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi-r2.example/v1/aqi-history",
      UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observs-r2.example/v1/observations",
    }, NOW_MS);
    assert.equal(mergedComplete.source.r2_aqi_response_complete, false);
    assert.equal(mergedComplete.source.r2_observations_response_complete, false);
    assert.equal(mergedComplete.aqi.response_complete, true);
    assert.equal(mergedComplete.observations.response_complete, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("R2 observations retain authority for an intentional direct-ingest overlap", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("uk_aq_timeseries_rpc")) {
      return new Response(JSON.stringify([{
        timeseries_id: 260,
        window: "7d",
        start: "2026-07-09T09:52:58.189Z",
        end: "2026-07-16T09:52:58.189Z",
        count: 2,
        data: [
          { observed_at: "2026-07-12T00:00:00.000Z", value: 20 },
          { observed_at: "2026-07-12T01:00:00.000Z", value: 20 },
        ],
      }]), { status: 200 });
    }
    if (url.includes("aqi-r2.example")) return new Response(JSON.stringify({ points: [], response_complete: false }), { status: 200 });
    if (url.includes("observs-r2.example")) return new Response(JSON.stringify({
      timeseries_id: 260,
      connector_id: 2,
      pollutant: "pm25",
      response_complete: false,
      coverage_state: "partial",
      rows: [{ observed_at: "2026-07-12T00:00:00.000Z", value: 21 }],
    }), { status: 200 });
    throw new Error(`unexpected upstream ${url}`);
  };
  try {
    const body = await buildStationSeries({
      timeseriesId: 260, connectorId: 2, stationId: 9, pollutant: "pm25",
      startMs: START_MS, endMs: END_MS,
      contextHours: 0, contextStartMs: START_MS, includeAqi: false, window: "7d",
    }, {
      SUPABASE_URL: "https://ingest.example", SB_SECRET_KEY: "ingest-key", INGESTDB_RETENTION_DAYS: "4",
      UK_AQ_EDGE_UPSTREAM_SECRET: "secret", UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi-r2.example/v1/aqi-history",
      UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observs-r2.example/v1/observations",
    }, NOW_MS);
    assert.equal(body.observations.rows.find((row) => row.observed_at === "2026-07-12T00:00:00.000Z")?.source, "r2");
    assert.equal(body.source.verified_observation_overlap_row_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
