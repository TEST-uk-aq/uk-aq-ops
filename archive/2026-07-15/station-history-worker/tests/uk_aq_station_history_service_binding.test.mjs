import assert from "node:assert/strict";
import test from "node:test";
import worker from "../workers/uk_aq_station_history/src/index.mjs";

const env = {
  SUPABASE_URL: "https://ingest.example",
  SB_PUBLISHABLE_DEFAULT_KEY: "publishable",
  UK_AQ_EDGE_UPSTREAM_SECRET: "upstream-secret",
  UK_AQ_AQI_HISTORY_R2_API_URL: "https://aqi.example/v1/aqi-history",
};

test("private Worker returns structured errors for unsupported internal routes", async () => {
  const response = await worker.fetch(new Request("https://internal/internal/station-series"), env);
  assert.equal(response.status, 501);
  assert.equal(response.headers.get("X-UK-AQ-Station-History-Contract"), "v1");
  assert.equal((await response.json()).error.code, "station_series_not_implemented");
});

test("private Worker preserves the AQI history query and adds contract diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  let target;
  let headers;
  globalThis.fetch = async (input, init) => {
    target = String(input);
    headers = new Headers(init.headers);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request("https://internal/internal/aqi-history?timeseries_id=7&format=compact"), env);
    assert.equal(response.status, 200);
    assert.equal(target, "https://aqi.example/v1/aqi-history?timeseries_id=7&format=compact");
    assert.equal(headers.get("X-UK-AQ-Upstream-Auth"), "upstream-secret");
    assert.equal(response.headers.get("X-UK-AQ-Station-History-Worker"), "uk-aq-station-history");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
