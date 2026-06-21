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

function makeJsonR2Object(payload) {
  const text = `${JSON.stringify(payload)}\n`;
  return {
    async text() {
      return text;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(text).buffer;
    },
  };
}

function installHistoricalR2Harness(objectsByKey = {}) {
  const fetchCalls = [];
  const r2GetKeys = [];
  const cachePutCalls = [];
  const pendingWaits = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;

  globalThis.fetch = async (input) => {
    const requestUrl = typeof input === "string" ? input : input.url;
    fetchCalls.push(requestUrl);
    throw new Error(`Unexpected fetch during historical-only AQI test: ${requestUrl}`);
  };
  globalThis.caches = {
    default: {
      async match() {
        return null;
      },
      async put(request, response) {
        cachePutCalls.push({ url: request.url, status: response.status });
      },
    },
  };

  return {
    fetchCalls,
    r2GetKeys,
    cachePutCalls,
    env: {
      UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret",
      UK_AQ_R2_HISTORY_VERSION: "v2",
      INGESTDB_RETENTION_DAYS: "5",
      UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED: "true",
      UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX: "true",
      UK_AQ_HISTORY_BUCKET: {
        async get(key) {
          r2GetKeys.push(key);
          return objectsByKey[key] || null;
        },
      },
    },
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
  assert.match(workerSource, /UK_AQ_AQI_HISTORY_R2_MAX_R2_OBJECT_READS_PER_REQUEST/);
  assert.match(workerSource, /max_parquet_chunks_budget_exceeded/);
  assert.match(workerSource, /aqi_history_request/);
  assert.match(workerSource, /const requestedConnectorId = parseRequiredPositiveInt\(url\.searchParams\.get\("connector_id"\)\)/);
  assert.match(workerSource, /targetConnectorId = requestedConnectorId \|\| null/);
  assert.doesNotMatch(
    workerSource,
    /daqi_no2_index_level|daqi_pm25_rolling24h_index_level|daqi_pm10_rolling24h_index_level|eaqi_no2_index_level|eaqi_pm25_index_level|eaqi_pm10_index_level/,
  );
});

test("historical-only v2 AQI with connector_id does not use Supabase context lookup", async () => {
  const harness = installHistoricalR2Harness({});
  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history?timeseries_id=3742&connector_id=6&pollutant=pm25&from_utc=2026-03-18T00:00:00.000Z&to_utc=2026-03-19T00:00:00.000Z", {
        headers: {
          "x-uk-aq-upstream-auth": "test-upstream-secret",
        },
      }),
      harness.env,
      harness.ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.coverage.connector_id_source, "request");
    assert.equal(payload.coverage.used_supabase_connector_lookup, false);
    assert.equal(payload.coverage.r2_timeseries_metadata_lookup_attempted, false);
    assert.equal(harness.fetchCalls.length, 0);
    assert.ok(harness.r2GetKeys.some((key) =>
      key.includes("history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-03-18/connector_id=6/pollutant_code=pm25/manifest.json")
    ));
  } finally {
    await harness.restore();
  }
});

test("historical-only v2 AQI without connector_id resolves connector from R2 metadata before Supabase", async () => {
  const metadataKey = "history/_index_v2/timeseries/timeseries_id=3742.json";
  const harness = installHistoricalR2Harness({
    [metadataKey]: makeJsonR2Object({
      schema_version: 1,
      history_version: "v2",
      index_kind: "timeseries_metadata",
      timeseries_id: 3742,
      connector_id: 6,
      connector_ids: [6],
      pollutant_codes: ["pm25"],
      aqi_coverage: {
        row_count: 24,
        connector_ids: [6],
        pollutant_codes: ["pm25"],
      },
    }),
  });
  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history?timeseries_id=3742&pollutant=pm25&from_utc=2026-03-18T00:00:00.000Z&to_utc=2026-03-19T00:00:00.000Z", {
        headers: {
          "x-uk-aq-upstream-auth": "test-upstream-secret",
        },
      }),
      harness.env,
      harness.ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.coverage.connector_id_source, "r2_metadata");
    assert.equal(payload.coverage.target_connector_id, 6);
    assert.equal(payload.coverage.timeseries_metadata_index_key, metadataKey);
    assert.equal(payload.coverage.r2_timeseries_metadata_lookup_attempted, true);
    assert.equal(payload.coverage.r2_timeseries_metadata_lookup_found, true);
    assert.equal(payload.coverage.used_supabase_connector_lookup, false);
    assert.equal(harness.fetchCalls.length, 0);
  } finally {
    await harness.restore();
  }
});

test("worker returns structured partial JSON instead of broad scanning when required index lacks connector context", async () => {
  const harness = installAqiHistoryMocks([]);

  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history?scope=timeseries&grain=hourly&timeseries_id=396&entity=396&pollutant=pm25&row_limit=20000&from_utc=2026-04-03T14:52:10.978Z&to_utc=2026-04-10T14:52:10.978Z", {
        headers: {
          "x-uk-aq-upstream-auth": "test-upstream-secret",
        },
      }),
      {
        UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret",
        UK_AQ_R2_HISTORY_VERSION: "v1",
        INGESTDB_RETENTION_DAYS: "5",
        UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED: "true",
        UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX: "true",
      },
      harness.ctx,
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-uk-aq-request-id"), /^[0-9a-f-]+$/i);
    assert.equal(response.headers.get("x-uk-aq-response-complete"), "false");
    assert.equal(response.headers.get("cache-control"), "no-store");

    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.response_complete, false);
    assert.equal(payload.has_gap, true);
    assert.equal(payload.coverage.timeseries_index.enabled, true);
    assert.equal(payload.coverage.timeseries_index.require_timeseries_index, true);
    assert.equal(
      payload.coverage.history_scan_stopped_reason,
      "missing_connector_context_for_required_timeseries_index",
    );
    assert.deepEqual(payload.coverage.scan_metrics.r2_object_reads, 0);
    assert.equal(payload.coverage.scan_metrics.stopped_early, true);
    assert.equal(payload.coverage.scanned_connector_manifests, 0);
    assert.equal(payload.coverage.scanned_parquet_files, 0);
    assert.ok(payload.partial_reasons.some((reason) => (
      reason.includes("missing_connector_context_for_required_timeseries_index")
    )));
  } finally {
    await harness.restore();
  }
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
        UK_AQ_R2_HISTORY_VERSION: "v1",
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
        UK_AQ_R2_HISTORY_VERSION: "v1",
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
