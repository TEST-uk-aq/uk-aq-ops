import assert from "node:assert/strict";
import test from "node:test";
import worker from "../workers/uk_aq_station_history/src/index.mjs";
import {
  readDirectIngestObservations,
  sanitizeIngestDiagnosticText,
  selectDirectIngestWindowLabel,
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
  nowMs: Date.parse("2026-07-14T01:00:00.000Z"),
  timeoutMs: 50,
};

function rpcPayload(data, guideline = null) {
  return [{
    timeseries_id: 7,
    window: "12h",
    start: "2026-07-13T13:00:00.000Z",
    end: "2026-07-14T01:00:00.000Z",
    count: data.length,
    guideline,
    data,
  }];
}

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
        assert.equal(error.logicalFetchCount, expected.logicalFetchCount ?? 1);
        assert.equal(error.httpAttemptCount, expected.httpAttemptCount ?? 1);
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
        && error.failureClass === "config"
        && error.logicalFetchCount === 0,
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

test("direct ingest rejects invalid JSON, RPC result shape, and data shape distinctly", async () => {
  await expectIngestError(
    async () => new Response("not-json", { status: 200 }),
    { code: "station_series_ingest_invalid_json", failureClass: "invalid_json", upstreamStatus: 200 },
  );
  await expectIngestError(
    async () => new Response(JSON.stringify({ rows: [] }), { status: 200 }),
    { code: "station_series_ingest_invalid_rpc_result_shape", failureClass: "invalid_rpc_result_shape", upstreamStatus: 200 },
  );
  await expectIngestError(
    async () => new Response(JSON.stringify(rpcPayload({ rows: [] })), { status: 200 }),
    { code: "station_series_ingest_invalid_data_shape", failureClass: "invalid_data_shape", upstreamStatus: 200 },
  );
});

test("direct ingest rejects an optional row identity that conflicts with the authoritative identity", async () => {
  await expectIngestError(
    async () => new Response(JSON.stringify(rpcPayload([{
      connector_id: 3,
      observed_at: "2026-07-14T00:00:00.000Z",
      value: 20,
    }])), { status: 200 }),
    { code: "station_series_ingest_identity_mismatch", failureClass: "identity_mismatch", upstreamStatus: 200 },
  );
});

test("valid RPC rows preserve guideline, status, and authoritative enrichment", async () => {
  await withFetch(
    async () => new Response(JSON.stringify(rpcPayload([{
      observed_at: "2026-07-14T00:00:00.000Z",
      value: 20,
      status: "verified",
    }], { source: "WHO" })), { status: 200 }),
    async () => {
      const result = await readDirectIngestObservations(bounds);
      assert.equal(result.fetch_count, 1);
      assert.equal(result.logical_fetch_count, 1);
      assert.equal(result.http_attempt_count, 1);
      assert.equal(result.rows.length, 1);
      assert.deepEqual(result.rows[0], {
        connector_id: 2,
        station_id: 9,
        timeseries_id: 7,
        pollutant_code: "no2",
        observed_at: "2026-07-14T00:00:00.000Z",
        value: 20,
        status: "verified",
        source: "ingest",
      });
      assert.deepEqual(result.guideline, { source: "WHO" });
    },
  );
});

test("direct ingest selects the smallest supported RPC window for its required source interval", () => {
  const end = Date.parse("2026-07-15T12:00:00.000Z");
  assert.equal(selectDirectIngestWindowLabel(end - 12 * 60 * 60 * 1000, end), "12h");
  assert.equal(selectDirectIngestWindowLabel(end - 24 * 60 * 60 * 1000, end), "24h");
  assert.equal(selectDirectIngestWindowLabel(end - 47 * 60 * 60 * 1000, end), "7d");
  assert.equal(selectDirectIngestWindowLabel(end - 8 * 24 * 60 * 60 * 1000, end), "30d");
});

test("a direct source interval beyond the RPC maximum is marked incomplete", async () => {
  await withFetch(
    async () => new Response(JSON.stringify(rpcPayload([])), { status: 200 }),
    async () => {
      const nowMs = Date.parse("2026-07-15T12:00:00.000Z");
      const result = await readDirectIngestObservations({
        ...bounds,
        startMs: nowMs - 31 * 24 * 60 * 60 * 1000,
        endMs: nowMs,
        nowMs,
      });
      assert.equal(result.rpc_window_label, "30d");
      assert.equal(result.rpc_window_covers_required_start, false);
      assert.equal(result.response_complete, false);
    },
  );
});

test("unexpected RPC signature mismatch is classified and is not retried", async () => {
  let attempts = 0;
  await expectIngestError(
    async () => {
      attempts += 1;
      return new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function uk_aq_timeseries_rpc" }), { status: 404 });
    },
    { code: "station_series_ingest_unsupported_rpc_signature", failureClass: "unsupported_rpc_signature", upstreamStatus: 404, postgrestCode: "PGRST202" },
  );
  assert.equal(attempts, 1);
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

test("private station-series responses expose only safe RPC diagnostics", async () => {
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
    if (url.includes("/rest/v1/rpc/uk_aq_timeseries_rpc")) {
      return new Response(JSON.stringify({
        code: "PGRST202",
        message: "function missing; apikey=obs-key",
        details: "https://obsaqi.example/rest/v1/rpc/uk_aq_timeseries_rpc?apikey=obs-key",
        hint: "check function",
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
    assert.equal(response.headers.get("X-UK-AQ-Station-History-Error-Class"), "unsupported_rpc_signature");
    assert.equal(body.error.code, "station_series_ingest_unsupported_rpc_signature");
    assert.equal(body.error.detail.path, "rpc/uk_aq_timeseries_rpc");
    assert.equal(body.error.detail.http_attempt_count, 1);
    assert.doesNotMatch(JSON.stringify(body), /obs-key|obsaqi\.example/);
  });
});
