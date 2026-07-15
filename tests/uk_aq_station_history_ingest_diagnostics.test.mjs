import assert from "node:assert/strict";
import test from "node:test";
import worker from "../workers/uk_aq_station_history/src/index.mjs";
import {
  readDirectIngestObservations,
  sanitizeIngestDiagnosticText,
  StationHistoryIngestError,
} from "../workers/uk_aq_station_history/src/ingest_observations.mjs";

const identity = { timeseriesId: 7, connectorId: 2, stationId: 9, pollutant: "no2" };
const env = {
  SUPABASE_URL: "https://identity.example",
  SB_SECRET_KEY: "service-key",
  OBS_AQIDB_SUPABASE_URL: "https://obsaqi.example",
  OBS_AQIDB_SECRET_KEY: "obs-key",
  UK_AQ_PUBLIC_SCHEMA: "uk_aq_public",
  INGESTDB_RETENTION_DAYS: "31",
};
const bounds = {
  env,
  identity,
  startMs: Date.parse("2026-07-14T00:00:00.000Z"),
  endMs: Date.parse("2026-07-14T01:00:00.000Z"),
  timeoutMs: 50,
};

async function withFetch(implementation, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function expectIngestError(implementation, expected) {
  await withFetch(implementation, async () => {
    await assert.rejects(
      readDirectIngestObservations(bounds),
      (error) => {
        assert.ok(error instanceof StationHistoryIngestError);
        assert.equal(error.code, expected.code);
        assert.equal(error.failureClass, expected.failureClass);
        assert.equal(error.upstreamStatus, expected.upstreamStatus ?? null);
        if (expected.postgrestCode) assert.equal(error.postgrestCode, expected.postgrestCode);
        return true;
      },
    );
  });
}

test("direct ingest reports missing source configuration without attempting a fetch", async () => {
  let fetchCalled = false;
  await withFetch(async () => {
    fetchCalled = true;
    throw new Error("fetch should not run");
  }, async () => {
    await assert.rejects(
      readDirectIngestObservations({ ...bounds, env: { ...env, OBS_AQIDB_SECRET_KEY: "" } }),
      (error) => error instanceof StationHistoryIngestError
        && error.code === "station_series_ingest_config_missing"
        && error.failureClass === "config",
    );
  });
  assert.equal(fetchCalled, false);
});

for (const { status, code, message } of [
  { status: 400, code: "PGRST100", message: "bad request" },
  { status: 401, code: "PGRST301", message: "authentication required" },
  { status: 404, code: "42P01", message: "relation does not exist" },
  { status: 406, code: "PGRST116", message: "not acceptable" },
  { status: 500, code: "XX000", message: "internal error" },
]) {
  test(`direct ingest classifies PostgREST HTTP ${status}`, async () => {
    await expectIngestError(
      async () => new Response(JSON.stringify({ code, message, details: "safe details", hint: "safe hint" }), { status }),
      { code: "station_series_ingest_http_failed", failureClass: "http", upstreamStatus: status, postgrestCode: code },
    );
  });
}

test("direct ingest distinguishes timeout and network failures", async () => {
  await expectIngestError(
    async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; },
    { code: "station_series_ingest_timeout", failureClass: "timeout" },
  );
  await expectIngestError(
    async () => { throw new Error("socket reset"); },
    { code: "station_series_ingest_network_failed", failureClass: "network" },
  );
});

test("direct ingest rejects invalid JSON and non-array JSON distinctly", async () => {
  await expectIngestError(
    async () => new Response("not-json", { status: 200 }),
    { code: "station_series_ingest_invalid_json", failureClass: "invalid_json", upstreamStatus: 200 },
  );
  await expectIngestError(
    async () => new Response(JSON.stringify({ rows: [] }), { status: 200 }),
    { code: "station_series_ingest_invalid_shape", failureClass: "invalid_shape", upstreamStatus: 200 },
  );
});

test("direct ingest rejects an authoritative identity mismatch", async () => {
  await expectIngestError(
    async () => new Response(JSON.stringify([{
      connector_id: 3,
      station_id: 9,
      timeseries_id: 7,
      pollutant_code: "no2",
      observed_at_utc: "2026-07-14T00:00:00.000Z",
      value: 20,
    }]), { status: 200 }),
    { code: "station_series_ingest_identity_mismatch", failureClass: "identity_mismatch", upstreamStatus: 200 },
  );
});

test("valid direct ingest array preserves the existing normalized result", async () => {
  await withFetch(
    async () => new Response(JSON.stringify([{
      connector_id: 2,
      station_id: 9,
      timeseries_id: 7,
      pollutant_code: "no2",
      observed_at_utc: "2026-07-14T00:00:00.000Z",
      value: 20,
    }]), { status: 200 }),
    async () => {
      const result = await readDirectIngestObservations(bounds);
      assert.equal(result.fetch_count, 1);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].source, "ingest");
    },
  );
});

test("diagnostic sanitisation removes credentials, URLs, HTML, and long text", () => {
  const redacted = sanitizeIngestDiagnosticText(
    "Bearer top-secret eyJabcdefgh.abcdefgh.abcdefgh apikey=obs-key https://example.test/path?apikey=leak",
  );
  assert.doesNotMatch(redacted, /top-secret|obs-key|example\.test|eyJabcdefgh/);
  assert.match(redacted, /REDACTED/);
  assert.equal(sanitizeIngestDiagnosticText("<!doctype html><html><body>failure</body></html>"), "upstream returned an HTML error page");
  assert.ok(sanitizeIngestDiagnosticText("x".repeat(2_000)).length <= 512);
});

test("private station-series responses expose only safe ingest diagnostics", async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes("/rest/v1/timeseries")) {
      return new Response(JSON.stringify([{
        id: 7,
        station_id: 9,
        connector_id: 2,
        phenomenon_id: 4,
        ended_at: null,
        phenomena: { connector_id: 2, observed_property_id: 5, observed_properties: { code: "no2" } },
      }]), { status: 200 });
    }
    if (url.includes("/rest/v1/uk_aq_observations")) {
      return new Response(JSON.stringify({
        code: "42P01",
        message: "relation missing; apikey=obs-key",
        details: "https://obsaqi.example/rest/v1/uk_aq_observations?apikey=obs-key",
        hint: "check relation",
      }), { status: 404 });
    }
    throw new Error(`unexpected request ${url}`);
  }, async () => {
    const response = await worker.fetch(new Request("https://internal/v1/station-series?timeseries_id=7&pollutant=no2&start_utc=2026-07-14T00%3A00%3A00.000Z&end_utc=2026-07-14T01%3A00%3A00.000Z&window=12h&format=objects"), env);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-UK-AQ-Station-History-Upstream"), "obsaqidb");
    assert.equal(response.headers.get("X-UK-AQ-Station-History-Upstream-Status"), "404");
    assert.equal(response.headers.get("X-UK-AQ-Station-History-Error-Class"), "http");
    assert.equal(body.error.code, "station_series_ingest_http_failed");
    assert.equal(body.error.detail.postgrest_code, "42P01");
    assert.doesNotMatch(JSON.stringify(body), /obs-key|obsaqi\.example/);
  });
});
