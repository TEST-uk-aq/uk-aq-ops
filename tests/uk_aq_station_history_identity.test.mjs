import assert from "node:assert/strict";
import test from "node:test";

import worker from "../workers/uk_aq_station_history/src/index.mjs";
import {
  resolveAuthoritativeTimeseriesIdentity,
  StationHistoryIdentityError,
} from "../workers/uk_aq_station_history/src/identity.mjs";

const env = { SUPABASE_URL: "https://ingest.example", SB_SECRET_KEY: "service-key" };

function row(overrides = {}) {
  return {
    id: 7,
    station_id: 9,
    connector_id: 2,
    phenomenon_id: 4,
    ended_at: null,
    phenomena: {
      connector_id: 2,
      observed_property_id: 5,
      observed_properties: { code: "pm25" },
    },
    ...overrides,
  };
}

async function withLookup(payload, request) {
  const originalFetch = globalThis.fetch;
  let target = "";
  let headers;
  globalThis.fetch = async (input, init) => {
    target = String(input);
    headers = new Headers(init?.headers);
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  try {
    return { identity: await resolveAuthoritativeTimeseriesIdentity(request, env), target, headers };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("authoritative lookup resolves station, connector and pollutant with the private service key", async () => {
  const result = await withLookup([row()], { timeseriesId: 7, connectorId: null, pollutant: "PM2.5" });
  assert.deepEqual(result.identity, {
    source: "authoritative_timeseries_lookup",
    timeseriesId: 7,
    stationId: 9,
    connectorId: 2,
    phenomenonId: 4,
    observedPropertyId: 5,
    pollutant: "pm25",
  });
  assert.match(result.target, /\/rest\/v1\/timeseries/);
  assert.match(result.target, /phenomena/);
  assert.equal(result.headers.get("Accept-Profile"), "uk_aq_core");
  assert.equal(result.headers.get("Authorization"), "Bearer service-key");
});

test("matching supplied connector is accepted", async () => {
  const result = await withLookup([row()], { timeseriesId: 7, connectorId: 2, pollutant: "pm25" });
  assert.equal(result.identity.connectorId, 2);
});

test("connector and pollutant mismatches fail closed", async () => {
  await assert.rejects(
    () => withLookup([row()], { timeseriesId: 7, connectorId: 3, pollutant: "pm25" }),
    (error) => error instanceof StationHistoryIdentityError && error.status === 409 && error.code === "station_history_connector_mismatch",
  );
  await assert.rejects(
    () => withLookup([row()], { timeseriesId: 7, connectorId: 2, pollutant: "no2" }),
    (error) => error instanceof StationHistoryIdentityError && error.status === 409 && error.code === "station_history_pollutant_mismatch",
  );
});

test("private route returns a clear non-cacheable connector mismatch without reading ingest", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify([row()]), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request("https://internal/v1/station-series?timeseries_id=7&connector_id=3&pollutant=pm25&start_utc=2026-07-01T00%3A00%3A00.000Z&end_utc=2026-07-01T12%3A00%3A00.000Z&window=12h&format=objects"), {
      ...env,
      SB_PUBLISHABLE_DEFAULT_KEY: "publishable",
      UK_AQ_EDGE_UPSTREAM_SECRET: "upstream-secret",
    });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-UK-AQ-Station-History-Identity-Error"), "station_history_connector_mismatch");
    assert.equal((await response.json()).error.code, "station_history_connector_mismatch");
    assert.equal(calls, 1, "identity rejection occurs before ingest or R2 reads");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing, unknown, inactive and unusable timeseries identities fail closed", async () => {
  await assert.rejects(
    () => resolveAuthoritativeTimeseriesIdentity({ timeseriesId: null, pollutant: "pm25" }, env),
    (error) => error instanceof StationHistoryIdentityError && error.code === "station_history_timeseries_id_invalid",
  );
  await assert.rejects(
    () => withLookup([], { timeseriesId: 999, pollutant: "pm25" }),
    (error) => error instanceof StationHistoryIdentityError && error.status === 404 && error.code === "station_history_timeseries_not_found",
  );
  await assert.rejects(
    () => withLookup([row({ ended_at: "2026-07-01T00:00:00.000Z" })], { timeseriesId: 7, pollutant: "pm25" }),
    (error) => error instanceof StationHistoryIdentityError && error.code === "station_history_timeseries_inactive",
  );
  await assert.rejects(
    () => withLookup([row({ station_id: null })], { timeseriesId: 7, pollutant: "pm25" }),
    (error) => error instanceof StationHistoryIdentityError && error.code === "station_history_timeseries_identity_unusable",
  );
});
