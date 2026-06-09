import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import aqiHistoryWorker from "../workers/uk_aq_aqi_history_r2_api_worker/worker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(
  __dirname,
  "../workers/uk_aq_aqi_history_r2_api_worker/worker.mjs",
);
const workerSource = fs.readFileSync(workerPath, "utf8");
const HOUR_MS = 60 * 60 * 1000;

function buildAqiRows(baseTimeMs) {
  const row0 = {
    timeseries_id: 101,
    station_id: 202,
    connector_id: 303,
    timestamp_hour_utc: new Date(baseTimeMs).toISOString(),
    pollutant_code: "pm25",
    daqi_input_value_ugm3: 4.2,
    daqi_input_averaging_code: "rolling_24h_mean",
    daqi_index_level: 2,
    daqi_source_observation_count: 24,
    daqi_required_observation_count: 24,
    daqi_calculation_status: "ok",
    daqi_missing_reason: null,
    eaqi_input_value_ugm3: 3.8,
    eaqi_input_averaging_code: "hourly_mean",
    eaqi_index_level: 2,
    eaqi_source_observation_count: 1,
    eaqi_required_observation_count: 1,
    eaqi_calculation_status: "ok",
    eaqi_missing_reason: null,
    hourly_sample_count: 1,
    algorithm_version: "aqi-hourly-v1",
    computed_at_utc: new Date(baseTimeMs + 1000).toISOString(),
  };

  const row1 = {
    ...row0,
    timestamp_hour_utc: new Date(baseTimeMs + HOUR_MS).toISOString(),
    pollutant_code: "no2",
    daqi_input_value_ugm3: 16.2,
    daqi_input_averaging_code: "hourly_mean",
    daqi_index_level: 3,
    eaqi_input_value_ugm3: 15.4,
    eaqi_input_averaging_code: "hourly_mean",
    eaqi_index_level: 3,
    computed_at_utc: new Date(baseTimeMs + HOUR_MS + 1000).toISOString(),
  };

  const row2 = {
    ...row0,
    timestamp_hour_utc: new Date(baseTimeMs + (2 * HOUR_MS)).toISOString(),
    pollutant_code: "pm10",
    daqi_input_value_ugm3: null,
    daqi_input_averaging_code: "rolling_24h_mean",
    daqi_index_level: null,
    daqi_source_observation_count: 12,
    daqi_required_observation_count: 24,
    daqi_calculation_status: "insufficient_samples",
    daqi_missing_reason: "insufficient_samples",
    eaqi_input_value_ugm3: null,
    eaqi_input_averaging_code: "hourly_mean",
    eaqi_index_level: null,
    eaqi_source_observation_count: 0,
    eaqi_required_observation_count: 1,
    eaqi_calculation_status: "insufficient_samples",
    eaqi_missing_reason: "insufficient_samples",
    computed_at_utc: new Date(baseTimeMs + (2 * HOUR_MS) + 1000).toISOString(),
  };

  return [row0, row1, row2];
}

function installAqiHistoryMocks(rows) {
  const calls = [];
  const cachePutCalls = [];
  const pendingWaits = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;

  const mockFetch = async (input) => {
    const requestUrl = typeof input === "string" ? input : input.url;
    const url = new URL(requestUrl);
    calls.push(url.toString());

    const select = String(url.searchParams.get("select") || "");
    if (select === "timeseries_id,station_id,connector_id,timestamp_hour_utc") {
      return new Response(JSON.stringify([
        {
          timeseries_id: rows[2].timeseries_id,
          station_id: rows[2].station_id,
          connector_id: rows[2].connector_id,
          timestamp_hour_utc: rows[2].timestamp_hour_utc,
        },
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (select.includes("daqi_input_value_ugm3") && select.includes("eaqi_input_value_ugm3")) {
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    throw new Error(`Unexpected mock fetch URL: ${url.toString()}`);
  };

  const mockCache = {
    async match() {
      return null;
    },
    async put(request, response) {
      cachePutCalls.push({
        url: request.url,
        status: response.status,
      });
    },
  };

  globalThis.fetch = mockFetch;
  globalThis.caches = { default: mockCache };

  return {
    calls,
    cachePutCalls,
    ctx: {
      waitUntil(promise) {
        pendingWaits.push(promise);
      },
    },
    async restore() {
      globalThis.fetch = originalFetch;
      if (originalCaches === undefined) {
        delete globalThis.caches;
      } else {
        globalThis.caches = originalCaches;
      }
      await Promise.allSettled(pendingWaits);
    },
  };
}

test("worker source uses the normalized hourly AQI response contract", () => {
  assert.match(workerSource, /const AQI_PARQUET_COLUMNS = \[/);
  assert.match(workerSource, /const AQI_RESPONSE_COLUMNS = \[/);
  assert.match(workerSource, /__ukaq_aqi_history_response_v/);
  assert.match(workerSource, /aqi_band_cache:\s*\{\s*enabled: false/);
  assert.doesNotMatch(
    workerSource,
    /daqi_no2_index_level|daqi_pm25_rolling24h_index_level|daqi_pm10_rolling24h_index_level|eaqi_no2_index_level|eaqi_pm25_index_level|eaqi_pm10_index_level/,
  );
});

test("worker returns normalized compact AQI rows with row-summary metadata", async () => {
  const baseTimeMs = Date.now() - (12 * HOUR_MS);
  const rows = buildAqiRows(baseTimeMs);
  const harness = installAqiHistoryMocks(rows);

  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history?timeseries_id=101&days=1", {
        headers: {
          "x-uk-aq-upstream-auth": "test-upstream-secret",
        },
      }),
      {
        UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret",
        OBS_AQIDB_SUPABASE_URL: "https://supabase.test",
        OBS_AQIDB_SECRET_KEY: "test-obsaqidb-secret",
        UK_AQ_PUBLIC_SCHEMA: "uk_aq_public",
        INGESTDB_RETENTION_DAYS: "5",
      },
      harness.ctx,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-ukaq-cache"), "MISS");

    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.data_format, "compact");
    assert.equal(payload.source, "obs_aqidb_retention_only");
    assert.equal(payload.coverage.obs_aqidb_status, "fallback_live");
    assert.equal(payload.row_count, 3);
    assert.deepEqual(payload.columns.slice(0, 7), [
      "period_start_utc",
      "connector_id",
      "station_id",
      "timeseries_id",
      "pollutant_code",
      "daqi_index_level",
      "eaqi_index_level",
    ]);

    assert.equal(Array.isArray(payload.points[0]), true);
    assert.equal(payload.points[0][0], rows[0].timestamp_hour_utc);
    assert.equal(payload.points[0][1], 303);
    assert.equal(payload.points[0][2], 202);
    assert.equal(payload.points[0][4], "pm25");
    assert.equal(payload.points[0][5], 2);
    assert.equal(payload.points[0][6], 2);
    assert.equal(payload.points[0][13], "obs_aqidb");
    assert.equal(payload.points[0][14], "retention");

    assert.equal(payload.coverage.row_summary.parsed_point_count, 3);
    assert.equal(payload.coverage.row_summary.null_daqi_count, 1);
    assert.equal(payload.coverage.row_summary.null_eaqi_count, 1);
    assert.equal(payload.coverage.row_summary.source_counts.obs_aqidb, 3);
    assert.equal(payload.coverage.row_summary.source_coverage_counts.retention, 3);
    assert.equal(payload.coverage.row_summary.pollutant_counts.pm25, 1);
    assert.equal(payload.coverage.row_summary.pollutant_counts.no2, 1);
    assert.equal(payload.coverage.row_summary.pollutant_counts.pm10, 1);
    assert.equal(payload.meta.row_summary.null_daqi_count, 1);
    assert.equal(payload.meta.row_summary.source_counts.obs_aqidb, 3);
  } finally {
    await harness.restore();
  }
});

test("worker returns row objects without legacy timestamp fields when format=objects", async () => {
  const baseTimeMs = Date.now() - (12 * HOUR_MS);
  const rows = buildAqiRows(baseTimeMs);
  const harness = installAqiHistoryMocks(rows);

  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history?timeseries_id=101&days=1&format=objects", {
        headers: {
          "x-uk-aq-upstream-auth": "test-upstream-secret",
        },
      }),
      {
        UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret",
        OBS_AQIDB_SUPABASE_URL: "https://supabase.test",
        OBS_AQIDB_SECRET_KEY: "test-obsaqidb-secret",
        UK_AQ_PUBLIC_SCHEMA: "uk_aq_public",
        INGESTDB_RETENTION_DAYS: "5",
      },
      harness.ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data_format, "objects");
    assert.equal(Array.isArray(payload.points[0]), false);
    assert.deepEqual(Object.keys(payload.points[0]), payload.columns);
    assert.equal(payload.points[0].period_start_utc, rows[0].timestamp_hour_utc);
    assert.equal(payload.points[0].source, "obs_aqidb");
    assert.equal(payload.points[0].source_coverage, "retention");
    assert.equal("timestamp_hour_utc" in payload.points[0], false);
    assert.equal(payload.points[2].daqi_calculation_status, "insufficient_samples");
    assert.equal(payload.points[2].eaqi_calculation_status, "insufficient_samples");
  } finally {
    await harness.restore();
  }
});
