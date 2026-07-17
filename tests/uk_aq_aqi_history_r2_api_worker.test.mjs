import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import aqiHistoryWorker from "../workers/uk_aq_aqi_history_r2_api_worker/worker.mjs";
import {
  rowsToAqilevelDataV2ParquetBufferForTest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

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

function makeBufferR2Object(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return {
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function aqiDataRow({ timestamp, timeseriesId = 4242, connectorId = 77, stationId = 88, value = 6 }) {
  return {
    connector_id: connectorId,
    station_id: stationId,
    timeseries_id: timeseriesId,
    pollutant_code: "pm25",
    timestamp_hour_utc: timestamp,
    daqi_input_value_ugm3: value,
    daqi_input_averaging_code: "rolling_24h_mean",
    daqi_index_level: 1,
    daqi_source_observation_count: 24,
    daqi_required_observation_count: 24,
    daqi_calculation_status: "ok",
    daqi_missing_reason: null,
    eaqi_input_value_ugm3: value,
    eaqi_input_averaging_code: "hourly_mean",
    eaqi_index_level: 1,
    eaqi_source_observation_count: 1,
    eaqi_required_observation_count: 1,
    eaqi_calculation_status: "ok",
    eaqi_missing_reason: null,
    hourly_sample_count: 1,
    algorithm_version: "test-aqi-v1",
    computed_at_utc: new Date(Date.parse(timestamp) + 60_000).toISOString(),
  };
}

function hourlyObservationRows({ endHourIso, count = 24, omitTimes = new Set(), timeseriesId = 4242, connectorId = 77, stationId = 88, includeTimeseriesId = true }) {
  const endMs = Date.parse(endHourIso);
  return Array.from({ length: count }, (_, index) => {
    const observedAt = new Date(endMs - (count - 1 - index) * HOUR_MS).toISOString();
    if (omitTimes.has(observedAt)) return null;
    return {
      ...(includeTimeseriesId ? { timeseries_id: timeseriesId } : {}),
      connector_id: connectorId,
      station_id: stationId,
      pollutant_code: "pm25",
      observed_at_utc: observedAt,
      value: 6,
    };
  }).filter(Boolean);
}

function installLiveEnabledWorkerHarness({
  r2Objects,
  observationPayload,
  ingestRows = [],
  nowIso = "2026-07-14T12:30:00.000Z",
}) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalDateNow = Date.now;
  const fetchCalls = [];
  const r2GetKeys = [];
  const pendingWaits = [];
  Date.now = () => Date.parse(nowIso);
  globalThis.fetch = async (input) => {
    const requestUrl = typeof input === "string" ? input : input.url;
    const url = new URL(requestUrl);
    fetchCalls.push(url.toString());
    if (url.pathname.endsWith("/v1/observations")) {
      return new Response(JSON.stringify(observationPayload), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    const select = String(url.searchParams.get("select") || "");
    if (select === "connector_id,station_id,timeseries_id,pollutant_code,observed_at_utc,value") {
      return new Response(JSON.stringify(ingestRows), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`Unexpected live-enabled worker fetch URL: ${url.toString()}`);
  };
  globalThis.caches = {
    default: {
      async match() {
        throw new Error("internal response cache should be disabled");
      },
      async put() {
        throw new Error("internal response cache should be disabled");
      },
    },
  };
  return {
    fetchCalls,
    r2GetKeys,
    env: {
      UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret",
      UK_AQ_R2_HISTORY_VERSION: "v2",
      INGESTDB_RETENTION_DAYS: "5",
      UK_AQ_AQI_MUTABLE_HOURS: "120",
      UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED: "true",
      UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED: "false",
      UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED: "true",
      UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX: "true",
      UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://observations.example.test/root",
      OBS_AQIDB_SUPABASE_URL: "https://supabase.test",
      OBS_AQIDB_SECRET_KEY: "test-obsaqidb-secret",
      UK_AQ_PUBLIC_SCHEMA: "uk_aq_public",
      UK_AQ_HISTORY_BUCKET: {
        async get(key) {
          r2GetKeys.push(key);
          return r2Objects[key] || null;
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
      Date.now = originalDateNow;
      if (originalCaches === undefined) {
        delete globalThis.caches;
      } else {
        globalThis.caches = originalCaches;
      }
      await Promise.allSettled(pendingWaits);
    },
  };
}

function buildLiveR2Objects({ dayUtc, connectorId, pollutant = "pm25", parquetRows = [], timeseriesId = 4242 }) {
  const partKey = `history/v2/aqilevels/hourly/data/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutant}/part-00000.parquet`;
  const indexKey = `history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutant}/manifest.json`;
  const objects = {
    [indexKey]: makeJsonR2Object({
      history_version: "v2",
      domain: "aqilevels",
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutant,
      files: parquetRows.length > 0 ? [{
        key: partKey,
        pollutant_code: pollutant,
        min_timeseries_id: timeseriesId,
        max_timeseries_id: timeseriesId,
        row_count: parquetRows.length,
      }] : [],
    }),
  };
  if (parquetRows.length > 0) {
    objects[partKey] = makeBufferR2Object(rowsToAqilevelDataV2ParquetBufferForTest(parquetRows));
  }
  return { objects, indexKey, partKey };
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
  assert.match(workerSource, /AQI_V2_RESPONSE_COLUMNS/);
  assert.match(workerSource, /aqi_hour_interval_v2/);
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
    assert.equal(response.headers.get("x-uk-aq-aqi-response-contract"), "aqi_hour_interval_v2");
    const payload = await response.json();
    assert.equal(payload.response_contract, "aqi_hour_interval_v2");
    assert.equal(payload.meta.response_contract, "aqi_hour_interval_v2");
    assert.deepEqual(payload.columns.slice(-2), ["timestamp_hour_utc", "period_end_utc"]);
    assert.equal(payload.coverage.connector_id_source, "request");
    assert.equal(payload.coverage.used_supabase_connector_lookup, false);
    assert.equal(harness.fetchCalls.length, 0);
    assert.ok(harness.r2GetKeys.some((key) =>
      key.includes("history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-03-18/connector_id=6/pollutant_code=pm25/manifest.json")
    ));
  } finally {
    await harness.restore();
  }
});

test("historical-only v2 AQI resolves connector from stable R2 binding first", async () => {
  const bindingKey = "history/_index_v2/timeseries_binding/timeseries_id=3742.json";
  const harness = installHistoricalR2Harness({
    [bindingKey]: makeJsonR2Object({
      schema_version: 1,
      history_version: "v2",
      index_kind: "timeseries_binding",
      timeseries_id: 3742,
      connector_id: 6,
      pollutant_code: "pm25",
      station_id: 91,
    }),
  });
  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history?timeseries_id=3742&pollutant=pm25&from_utc=2026-03-18T00:00:00.000Z&to_utc=2026-03-19T00:00:00.000Z", {
        headers: { "x-uk-aq-upstream-auth": "test-upstream-secret" },
      }),
      harness.env,
      harness.ctx,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.coverage.connector_id_source, "r2_binding");
    assert.equal(payload.coverage.timeseries_binding_index_key, bindingKey);
    assert.equal(payload.coverage.used_r2_timeseries_binding_lookup, true);
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
      new Request("https://example.test/v1/aqi-history?timeseries_id=101&pollutant=pm25&days=1", {
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
    assert.equal(payload.row_count, 1);
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

    assert.equal(payload.coverage.row_summary.parsed_point_count, 1);
    assert.equal(payload.coverage.row_summary.null_daqi_count, 0);
    assert.equal(payload.coverage.row_summary.null_eaqi_count, 0);
    assert.equal(payload.coverage.row_summary.source_counts.obs_aqidb, 1);
    assert.equal(payload.coverage.row_summary.source_coverage_counts.retention, 1);
    assert.equal(payload.coverage.row_summary.pollutant_counts.pm25, 1);
    assert.equal(payload.coverage.row_summary.pollutant_counts.no2 || 0, 0);
    assert.equal(payload.coverage.row_summary.pollutant_counts.pm10 || 0, 0);
    assert.equal(payload.meta.row_summary.null_daqi_count, 0);
    assert.equal(payload.meta.row_summary.source_counts.obs_aqidb, 1);
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
      new Request("https://example.test/v1/aqi-history?timeseries_id=101&pollutant=pm25&days=1&format=objects", {
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
    assert.equal("period_end_utc" in payload.points[0], false);
    assert.equal("response_contract" in payload, false);
    assert.equal(payload.points[0].daqi_calculation_status, "ok");
    assert.equal(payload.points[0].eaqi_calculation_status, "ok");
  } finally {
    await harness.restore();
  }
});

test("worker rejects missing pollutant without broad all-pollutant read", async () => {
  const harness = installAqiHistoryMocks([]);
  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history?timeseries_id=101&days=1", {
        headers: { "x-uk-aq-upstream-auth": "test-upstream-secret" },
      }),
      { UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret", UK_AQ_R2_HISTORY_VERSION: "v2" },
      harness.ctx,
    );
    assert.equal(response.status, 400);
    assert.equal(harness.calls.length, 0);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "pollutant is required and must be one of pm25, pm10, or no2.");
  } finally {
    await harness.restore();
  }
});

test("worker rejects invalid pollutant", async () => {
  const harness = installAqiHistoryMocks([]);
  try {
    const response = await aqiHistoryWorker.fetch(
      new Request("https://example.test/v1/aqi-history?timeseries_id=101&pollutant=o3&days=1", {
        headers: { "x-uk-aq-upstream-auth": "test-upstream-secret" },
      }),
      { UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret", UK_AQ_R2_HISTORY_VERSION: "v2" },
      harness.ctx,
    );
    assert.equal(response.status, 400);
    assert.equal(harness.calls.length, 0);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "pollutant is required and must be one of pm25, pm10, or no2.");
  } finally {
    await harness.restore();
  }
});

test("live-enabled Worker calculates missing v2 PM2.5 AQI from R2 observations and ingest fill", async () => {
  const timeseriesId = 4242;
  const connectorId = 77;
  const stationId = 88;
  const r2Hour = "2026-07-14T10:00:00.000Z";
  const missingHour = "2026-07-14T11:00:00.000Z";
  const dayUtc = "2026-07-14";
  const missingObservation = "2026-07-14T06:00:00.000Z";
  const r2ObservationRows = hourlyObservationRows({
    endHourIso: missingHour,
    omitTimes: new Set([missingObservation]),
    timeseriesId,
    connectorId,
    stationId,
    includeTimeseriesId: false,
  });
  const ingestRows = [
    { timeseries_id: timeseriesId, connector_id: connectorId, station_id: stationId, pollutant_code: "pm25", observed_at_utc: "2026-07-14T10:00:00.000Z", value: 99 },
    { timeseries_id: timeseriesId, connector_id: connectorId, station_id: stationId, pollutant_code: "pm25", observed_at_utc: missingObservation, value: 6 },
  ];
  const { objects } = buildLiveR2Objects({
    dayUtc,
    connectorId,
    timeseriesId,
    parquetRows: [aqiDataRow({ timestamp: r2Hour, timeseriesId, connectorId, stationId, value: 4 })],
  });
  const harness = installLiveEnabledWorkerHarness({
    r2Objects: objects,
    ingestRows,
    observationPayload: {
      ok: true,
      response_complete: true,
      coverage_state: "complete",
      has_gap: false,
      partial_reasons: [],
      rows: r2ObservationRows,
    },
  });
  try {
    const response = await aqiHistoryWorker.fetch(
      new Request(`https://example.test/v1/aqi-history?format=objects&timeseries_id=${timeseriesId}&connector_id=${connectorId}&station_id=${stationId}&pollutant=pm25&from_utc=${encodeURIComponent(r2Hour)}&to_utc=${encodeURIComponent("2026-07-14T12:00:00.000Z")}`, {
        headers: { "x-uk-aq-upstream-auth": "test-upstream-secret" },
      }),
      harness.env,
      harness.ctx,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-uk-aq-internal-response-cache"), "disabled");
    assert.equal(response.headers.get("x-uk-aq-response-complete"), "true");
    const payload = await response.json();
    assert.equal(payload.response_complete, true);
    assert.equal(payload.meta.live_observation_fallback.status, "calculated");
    assert.equal(payload.meta.live_observation_fallback.materialised_aqi_fallback_queried, false);
    assert.equal(payload.meta.live_observation_fallback.r2_observation_row_count, 23);
    assert.equal(payload.meta.live_observation_fallback.ingest_observation_row_count, 2);
    assert.equal(payload.meta.live_observation_fallback.discarded_ingest_overlap_count, 1);
    assert.equal(payload.meta.live_observation_fallback.live_calculated_row_count, 1);
    assert.equal(payload.coverage.obs_aqidb_status, "not_requested");
    assert.match(payload.source, /^r2_first/);
    assert.deepEqual(payload.points.map((row) => row.period_start_utc), [r2Hour, missingHour]);
    const r2Row = payload.points.find((row) => row.period_start_utc === r2Hour);
    const liveRow = payload.points.find((row) => row.period_start_utc === missingHour);
    assert.equal(r2Row.source, "r2");
    assert.equal(r2Row.source_coverage, "r2_first_full_range");
    assert.equal(liveRow.source, "live_calculated");
    assert.equal(liveRow.timeseries_id, timeseriesId);
    assert.equal(liveRow.daqi_calculation_status, "ok");
    assert.ok(liveRow.daqi_index_level >= 1);
    const observationsCall = harness.fetchCalls.find((url) => new URL(url).pathname.endsWith("/v1/observations"));
    assert.ok(observationsCall);
    assert.equal(new URL(observationsCall).pathname, "/root/v1/observations");
    assert.equal(new URL(observationsCall).searchParams.get("timeseries_id"), String(timeseriesId));
    assert.ok(!harness.fetchCalls.some((url) => String(url).includes("daqi_input_value_ugm3")));
  } finally {
    await harness.restore();
  }
});

test("live-enabled Worker propagates partial R2 observation responses as incomplete and uncacheable", async () => {
  const timeseriesId = 4242;
  const connectorId = 77;
  const stationId = 88;
  const missingHour = "2026-07-14T11:00:00.000Z";
  const { objects } = buildLiveR2Objects({
    dayUtc: "2026-07-14",
    connectorId,
    timeseriesId,
    parquetRows: [],
  });
  const harness = installLiveEnabledWorkerHarness({
    r2Objects: objects,
    ingestRows: [],
    observationPayload: {
      ok: true,
      response_complete: false,
      coverage_state: "partial",
      has_gap: true,
      partial_reasons: ["test_r2_observation_scan_partial"],
      rows: hourlyObservationRows({ endHourIso: missingHour, timeseriesId, connectorId, stationId, includeTimeseriesId: false }),
    },
  });
  try {
    const response = await aqiHistoryWorker.fetch(
      new Request(`https://example.test/v1/aqi-history?format=objects&timeseries_id=${timeseriesId}&connector_id=${connectorId}&station_id=${stationId}&pollutant=pm25&from_utc=${encodeURIComponent(missingHour)}&to_utc=${encodeURIComponent("2026-07-14T12:00:00.000Z")}`, {
        headers: { "x-uk-aq-upstream-auth": "test-upstream-secret" },
      }),
      harness.env,
      harness.ctx,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uk-aq-response-complete"), "false");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-uk-aq-internal-response-cache"), "disabled");
    const payload = await response.json();
    assert.equal(payload.response_complete, false);
    assert.equal(payload.has_gap, true);
    assert.equal(payload.coverage.coverage_state, "partial");
    assert.ok(payload.partial_reasons.includes("r2_observations_api_partial"));
    assert.ok(payload.partial_reasons.includes("r2_observations_api:test_r2_observation_scan_partial"));
    assert.equal(payload.meta.live_observation_fallback.status, "partial_r2_observations");
    assert.equal(payload.meta.live_observation_fallback.live_calculated_row_count, 1);
    assert.equal(payload.meta.live_observation_fallback.materialised_aqi_fallback_queried, false);
    assert.ok(!harness.fetchCalls.some((url) => String(url).includes("daqi_input_value_ugm3")));
  } finally {
    await harness.restore();
  }
});

test("live-enabled PM fallback near mutable boundary requests one 23-hour R2 context window", async () => {
  const timeseriesId = 4242;
  const connectorId = 77;
  const stationId = 88;
  const outputHour = "2026-07-09T13:00:00.000Z";
  const expectedContextStart = "2026-07-08T14:00:00.000Z";
  const { objects } = buildLiveR2Objects({
    dayUtc: "2026-07-09",
    connectorId,
    timeseriesId,
    parquetRows: [],
  });
  const harness = installLiveEnabledWorkerHarness({
    r2Objects: objects,
    nowIso: "2026-07-14T12:00:00.000Z",
    ingestRows: [],
    observationPayload: {
      ok: true,
      response_complete: true,
      coverage_state: "complete",
      has_gap: false,
      partial_reasons: [],
      rows: hourlyObservationRows({ endHourIso: outputHour, timeseriesId, connectorId, stationId, includeTimeseriesId: false }),
    },
  });
  try {
    const response = await aqiHistoryWorker.fetch(
      new Request(`https://example.test/v1/aqi-history?format=objects&timeseries_id=${timeseriesId}&connector_id=${connectorId}&station_id=${stationId}&pollutant=pm25&from_utc=${encodeURIComponent(outputHour)}&to_utc=${encodeURIComponent("2026-07-09T14:00:00.000Z")}`, {
        headers: { "x-uk-aq-upstream-auth": "test-upstream-secret" },
      }),
      harness.env,
      harness.ctx,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    const diagnostics = payload.meta.live_observation_fallback;
    assert.equal(diagnostics.status, "calculated");
    assert.equal(diagnostics.eligible_output_hour_count, 1);
    assert.equal(diagnostics.skipped_outside_horizon_hour_count, 0);
    assert.equal(diagnostics.pm_context_start_utc, expectedContextStart);
    assert.deepEqual(payload.points.map((row) => row.period_start_utc), [outputHour]);
    const observationsCall = harness.fetchCalls.find((url) => new URL(url).pathname.endsWith("/v1/observations"));
    assert.ok(observationsCall);
    const observationsUrl = new URL(observationsCall);
    assert.equal(observationsUrl.searchParams.get("start_utc"), expectedContextStart);
    assert.notEqual(observationsUrl.searchParams.get("start_utc"), "2026-07-07T15:00:00.000Z");
    const ingestCall = harness.fetchCalls.find((url) => new URL(url).hostname === "supabase.test");
    assert.ok(ingestCall);
    assert.match(new URL(ingestCall).searchParams.get("observed_at_utc") || "", /^gte\.2026-07-09T13:00:00\.000Z$/);
  } finally {
    await harness.restore();
  }
});

test("live observation fallback normalizes R2 observation rows using requested timeseries context", () => {
  assert.match(workerSource, /timeseriesIdFromRequest = null/);
  assert.match(workerSource, /parseRequiredPositiveInt\(row\?\.timeseries_id\) \|\| parseRequiredPositiveInt\(timeseriesIdFromRequest\)/);
  assert.match(workerSource, /normalizeLiveObservationRow\(row, \{ connectorId, stationId, pollutantCode: pollutantKey, timeseriesIdFromRequest: timeseriesId \}\)/);
  assert.match(workerSource, /url\.pathname = "\/v1\/observations"/);
  assert.match(workerSource, /url\.pathname = `\$\{normalizedPath\}\/v1\/observations`/);
});

test("live observation fallback applies PM R2 context exactly once and bounds ingest independently", () => {
  assert.match(workerSource, /eligibleMissingHoursForLiveFallback = rawMissingHours\.filter/);
  assert.match(workerSource, /coalesceAqiMissingHourWindows\(eligibleMissingHoursForLiveFallback, \{ contextHours: 0 \}\)/);
  assert.match(workerSource, /r2ObservationStartMs = requestedPollutant === "pm25" \|\| requestedPollutant === "pm10"\s*\? outputStartMs - 23 \* HOUR_MS\s*: outputStartMs/s);
  assert.match(workerSource, /ingestObservationStartMs = Math\.max\(outputStartMs, retentionStartMs\)/);
  assert.match(workerSource, /for \(const hour of eligibleMissingHours\)/);
});
