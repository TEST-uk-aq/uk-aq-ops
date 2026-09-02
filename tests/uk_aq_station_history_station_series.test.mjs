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
  assert.doesNotMatch(directSource, /uk_aq_observations/);
  assert.match(directSource, /rpc\/uk_aq_timeseries_rpc/);
});

function observations(startIso, hours, pollutant = "no2") {
  const startMs = Date.parse(startIso);
  return Array.from({ length: hours }, (_, index) => ({ observed_at: new Date(startMs + index * HOUR_MS).toISOString(), value: 20, ...(pollutant === "no2" ? {} : { pollutant_code: pollutant }) }));
}

function rpcPayload(rows, guideline = null) {
  return [{
    timeseries_id: 7,
    window: "24h",
    start: "2026-07-13T00:00:00.000Z",
    end: "2026-07-14T00:00:00.000Z",
    count: rows.length,
    guideline,
    data: rows,
  }];
}

function identityPayload(pollutant = "no2") {
  return [{ id: 7, station_id: 9, connector_id: 2, phenomenon_id: 4, ended_at: null, phenomena: { connector_id: 2, observed_property_id: 5, observed_properties: { code: pollutant } } }];
}

function request({ pollutant = "no2", startIso, endIso, includeAqi = true, window = "12h" }) {
  return { ...identity, pollutant, startMs: Date.parse(startIso), endMs: Date.parse(endIso), contextHours: includeAqi && pollutant.startsWith("pm") ? 23 : 0, contextStartMs: Date.parse(startIso) - (includeAqi && pollutant.startsWith("pm") ? 23 : 0) * HOUR_MS, includeAqi, window };
}

test("direct ingest rows retain authority and malformed neighbours survive", () => {
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
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); targets.push({ url, init });
    if (url.includes("/rest/v1/timeseries")) return new Response(JSON.stringify(identityPayload()), { status: 200 });
    if (url.includes("/rest/v1/rpc/uk_aq_timeseries_rpc")) return new Response(JSON.stringify(rpcPayload(observations("2026-07-14T00:00:00.000Z", 12), { source: "WHO" })), { status: 200 });
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
    assert.equal(targets.filter(({ url }) => url.includes("uk_aq_timeseries_rpc")).length, 1);
    assert.ok(targets.every(({ url }) => !url.includes("/rest/v1/uk_aq_observations") && !url.includes("/functions/v1/uk_aq_timeseries")));
    assert.ok(targets.every(({ url }) => !url.includes("r2.example")));
    const direct = targets.find(({ url }) => url.includes("uk_aq_timeseries_rpc"));
    assert.equal(direct.init.method, "POST");
    assert.equal(direct.init.headers["Accept-Profile"], "uk_aq_public");
    assert.equal(direct.init.headers["Content-Profile"], "uk_aq_public");
    assert.equal(direct.init.headers.apikey, "service-key");
    assert.equal(direct.init.headers.Authorization, "Bearer service-key");
    const rpcBody = JSON.parse(direct.init.body);
    assert.match(rpcBody.window_label, /^(12h|24h|7d|30d)$/);
    delete rpcBody.window_label;
    assert.deepEqual(rpcBody, { timeseries_id: 7, limit_rows: null, since_ts: null, include_status: false });
    assert.deepEqual(body.observations.guideline, { source: "WHO" });
  } finally { globalThis.fetch = originalFetch; }
});

test("fully covered PM 24h reads 23 context hours once and excludes context output", async () => {
  const originalFetch = globalThis.fetch;
  let directRequest;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("uk_aq_timeseries_rpc")) { directRequest = { url, init }; return new Response(JSON.stringify(rpcPayload(observations("2026-07-12T01:00:00.000Z", 47, "pm25"))), { status: 200 }); }
    throw new Error(`unexpected call: ${url}`);
  };
  try {
    const body = await buildStationSeries(request({ pollutant: "pm25", startIso: "2026-07-13T00:00:00.000Z", endIso: "2026-07-14T00:00:00.000Z", window: "24h" }), env, Date.parse("2026-07-14T00:30:00.000Z"));
    assert.equal(JSON.parse(directRequest.init.body).window_label, "7d");
    assert.equal(body.source.ingest_fetch_count, 1);
    assert.equal(body.observations.rows.length, 24);
    assert.equal(body.aqi.rows.length, 24);
    assert.ok(body.observations.rows.every((row) => row.observed_at >= "2026-07-13T00:00:00.000Z"));
  } finally { globalThis.fetch = originalFetch; }
});

test("old 24h label follows R2 observation path and reuses its one direct result", async () => {
  const originalFetch = globalThis.fetch;
  const targets = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); targets.push({ url, init });
    if (url.includes("uk_aq_timeseries_rpc")) return new Response(JSON.stringify(rpcPayload([])), { status: 200 });
    if (url.includes("observs-r2.example")) return new Response(JSON.stringify({ timeseries_id: 7, connector_id: 2, pollutant: "no2", response_complete: true, has_gap: false, coverage_state: "complete", rows: observations("2026-06-01T00:00:00.000Z", 24) }), { status: 200 });
    throw new Error(`unexpected call: ${url}`);
  };
  try {
    const body = await buildStationSeries(request({ startIso: "2026-06-01T00:00:00.000Z", endIso: "2026-06-02T00:00:00.000Z", includeAqi: false, window: "24h" }), env, Date.parse("2026-07-15T00:00:00.000Z"));
    assert.notEqual(body.source.mode, "ingest_observations_only");
    assert.equal(body.source.ingest_fetch_count, 1);
    assert.equal(body.source.used_r2_observations, true);
    assert.equal(targets.filter(({ url }) => url.includes("uk_aq_timeseries_rpc")).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("PM observations-only requests do not request AQI context", () => {
  const parsed = resolveStationSeriesRequest(new URL("https://internal/v1/station-series?timeseries_id=7&connector_id=2&pollutant=pm25&start_utc=2026-07-13T00%3A00%3A00.000Z&end_utc=2026-07-14T00%3A00%3A00.000Z&window=24h&format=objects&include_aqi=false"));
  assert.equal(parsed.contextHours, 0);
});

test("continuity with calculated-history AQI disabled shares one v3 physical-page budget", async () => {
  const originalFetch = globalThis.fetch;
  let leafCalls = 0;
  let directCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/timeseries-binding") {
      return new Response(JSON.stringify({
        binding: {
          schema_version: 2,
          history_version: "v2",
          index_kind: "timeseries_binding",
          timeseries_id: 7,
          station_id: 9,
          connector_id: 2,
          pollutant_code: "no2",
          continuity: {
            schema_version: 1,
            source: "sos_station_timeseries_site_refs",
            continuity_key: "2:UKA00001:no2",
            site_ref: "TEST",
            uk_air_ref: "UKA00001",
            pollutant_code: "no2",
            members: [
              { station_id: 8, timeseries_id: 6, valid_from_day_utc: "2026-01-01", valid_to_day_utc: "2026-05-31" },
              { station_id: 9, timeseries_id: 7, valid_from_day_utc: "2026-06-01", valid_to_day_utc: null },
            ],
          },
        },
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/rpc/uk_aq_timeseries_rpc")) {
      directCalls += 1;
      return new Response(JSON.stringify(rpcPayload([])), { status: 200 });
    }
    if (url.pathname === "/v1/observations") {
      const cursor = url.searchParams.get("physical_cursor");
      const pageNumber = cursor ? Number(cursor) : 1;
      const startMs = Date.parse(url.searchParams.get("start_utc"));
      const endMs = Date.parse(url.searchParams.get("end_utc"));
      leafCalls += 1;
      return new Response(JSON.stringify({
        ok: true,
        timeseries_id: 7,
        connector_id: 2,
        pollutant: "no2",
        start_utc: new Date(startMs).toISOString(),
        end_utc: new Date(endMs).toISOString(),
        response_complete: false,
        has_gap: false,
        coverage_partial_reasons: [],
        physical_page: {
          schema_version: 2,
          page_number: pageNumber,
          continuation_cursor_supplied: Boolean(cursor),
          segments_decoded: 1,
          physical_rows_decoded: 1,
          pagination_complete: false,
          next_cursor: String(pageNumber + 1),
        },
        rows: [{ observed_at: new Date(startMs + pageNumber * 60_000).toISOString(), value: 20 }],
      }), { status: 200 });
    }
    throw new Error(`unexpected call: ${url}`);
  };
  const featureEnv = {
    ...env,
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v3",
    UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED: "true",
    UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED: "false",
  };
  try {
    const response = await worker.fetch(new Request("https://internal/v1/station-series?timeseries_id=7&connector_id=2&pollutant=no2&start_utc=2026-07-01T00%3A00%3A00.000Z&end_utc=2026-07-02T00%3A00%3A00.000Z&window=24h&format=objects&include_aqi=false"), featureEnv);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(directCalls, 2, "the existing calculated and legacy phases both execute");
    assert.equal(leafCalls, 16, "both phases share one hard physical-page budget for the request");
    assert.equal(body.observations.response_complete, false);
    assert.equal(body.observations.partial_reasons.includes("observation_history_physical_page_budget_exceeded"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
