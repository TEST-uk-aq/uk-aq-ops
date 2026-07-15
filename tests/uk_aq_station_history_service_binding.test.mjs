import assert from "node:assert/strict";
import test from "node:test";
import worker from "../workers/uk_aq_station_history/src/index.mjs";

const env = {
  SUPABASE_URL: "https://ingest.example",
  SB_PUBLISHABLE_DEFAULT_KEY: "publishable",
  SB_SECRET_KEY: "service-key",
  UK_AQ_EDGE_UPSTREAM_SECRET: "upstream-secret",
  UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi.example/v1/aqi-history",
};

test("private Worker returns structured errors for invalid station-series contracts", async () => {
  const response = await worker.fetch(new Request("https://internal/v1/station-series"), env);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("X-UK-AQ-Station-History-Contract"), "v1");
  assert.equal((await response.json()).error.code, "station_series_format_objects_required");
});

test("private Worker preserves the AQI history query and adds contract diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  let target;
  let headers;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/rest/v1/timeseries")) {
      return new Response(JSON.stringify([{ id: 7, station_id: 9, connector_id: 2, phenomenon_id: 4, ended_at: null, phenomena: { connector_id: 2, observed_property_id: 5, observed_properties: { code: "pm25" } } }]), { status: 200 });
    }
    target = String(input);
    headers = new Headers(init.headers);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request("https://internal/v1/aqi-history?timeseries_id=7&connector_id=2&pollutant=pm25&start_utc=2026-01-01T00%3A00%3A00.000Z&end_utc=2026-01-02T00%3A00%3A00.000Z&stable_head_start_utc=2026-01-02T00%3A00%3A00.000Z&format=compact"), env);
    assert.equal(response.status, 200);
    assert.match(target, /^https:\/\/aqi\.example\/v1\/aqi-history\?/);
    assert.match(target, /format=objects/);
    assert.equal(headers.get("X-UK-AQ-Upstream-Auth"), "upstream-secret");
    assert.equal(response.headers.get("X-UK-AQ-Station-History-Worker"), "uk-aq-station-history");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
