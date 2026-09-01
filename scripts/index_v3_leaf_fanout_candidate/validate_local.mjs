#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import fanoutWorker, {
  partitionUtcDaySlices,
} from "../../workers/uk_aq_observs_history_r2_api_v3_leaf_fanout_candidate/worker.mjs";

const START_UTC = "2026-08-20T00:00:00.000Z";
const END_UTC = "2026-08-27T00:00:00.000Z";
const SECRET = "local-service-binding-secret";
const EXPECTED_SLICES = Object.freeze([
  ["2026-08-20", "2026-08-20T00:00:00.000Z", "2026-08-21T00:00:00.000Z"],
  ["2026-08-21", "2026-08-21T00:00:00.000Z", "2026-08-22T00:00:00.000Z"],
  ["2026-08-22", "2026-08-22T00:00:00.000Z", "2026-08-23T00:00:00.000Z"],
  ["2026-08-23", "2026-08-23T00:00:00.000Z", "2026-08-24T00:00:00.000Z"],
  ["2026-08-24", "2026-08-24T00:00:00.000Z", "2026-08-25T00:00:00.000Z"],
  ["2026-08-25", "2026-08-25T00:00:00.000Z", "2026-08-26T00:00:00.000Z"],
  ["2026-08-26", "2026-08-26T00:00:00.000Z", "2026-08-27T00:00:00.000Z"],
]);

function sha256Rows(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function directRows() {
  return EXPECTED_SLICES.flatMap(([day], index) => [
    { observed_at: `${day}T00:00:00.000Z`, value: 10 + index },
    { observed_at: `${day}T12:00:00.000Z`, value: 10.5 + index },
  ]);
}

function leafPayload(url, rows, ordinal) {
  const startUtc = url.searchParams.get("start_utc");
  const endUtc = url.searchParams.get("end_utc");
  const requestId = `mock-leaf-request-${ordinal}`;
  const ray = `mock-leaf-ray-${ordinal}`;
  return {
    requestId,
    ray,
    body: {
      ok: true,
      read_version: "v2",
      index_version: "v3-physical-leaf-candidate",
      physical_leaf_candidate_version: "physical-leaf-index-v1",
      pollutant: "pm25",
      physical_layout_version: "timeseries-aligned-v2",
      writer_version: "pyarrow-zstd-timeseries-aligned-candidate-v1",
      aligned_row_cap: 1024,
      timeseries_id: 7421,
      connector_id: 7,
      start_utc: startUtc,
      end_utc: endUtc,
      since_utc: null,
      row_count: rows.length,
      response_complete: true,
      has_gap: false,
      coverage_state: "complete",
      partial_reasons: [],
      rows,
      diagnostic_request: {
        schema_version: 1,
        mode: "workload_v1",
        request_id: requestId,
        cloudflare_ray_id: ray,
        rows_returned: rows.length,
        cpu_time_ms: null,
      },
      coverage: {
        response_complete: true,
        has_gap: false,
        coverage_state: "complete",
        partial_reasons: [],
        limited_by_limit: false,
        total_rows_before_limit: rows.length,
      },
    },
  };
}

export async function validateLocalFanout() {
  const slices = partitionUtcDaySlices(START_UTC, END_UTC);
  assert.deepEqual(
    slices.map((slice) => [slice.day_utc, slice.start_utc, slice.end_utc]),
    EXPECTED_SLICES,
  );

  const expectedRows = directRows();
  const calls = [];
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const serviceBinding = {
    async fetch(request) {
      const url = new URL(request.url);
      const ordinal = calls.length + 1;
      calls.push(url);
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await Promise.resolve();
      activeCalls -= 1;
      assert.equal(request.headers.get("x-uk-aq-upstream-auth"), SECRET);
      assert.equal(url.pathname, "/v1/observations");
      assert.equal(url.searchParams.get("connector_id"), "7");
      assert.equal(url.searchParams.get("pollutant"), "pm25");
      assert.equal(url.searchParams.get("timeseries_id"), "7421");
      assert.equal(url.searchParams.get("diagnostics"), "workload_v1");
      const startMs = Date.parse(url.searchParams.get("start_utc"));
      const endMs = Date.parse(url.searchParams.get("end_utc"));
      const rows = expectedRows.filter((row) => {
        const timestamp = Date.parse(row.observed_at);
        return timestamp >= startMs && timestamp < endMs;
      });
      const payload = leafPayload(url, rows, ordinal);
      return new Response(JSON.stringify(payload.body), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-ukaq-diagnostic-request-id": payload.requestId,
          "cf-ray": payload.ray,
        },
      });
    },
  };

  const requestUrl = new URL("https://fanout.test.workers.dev/v1/observations");
  for (const [key, value] of Object.entries({
    connector_id: 7,
    pollutant: "pm25",
    timeseries_id: 7421,
    start_utc: START_UTC,
    end_utc: END_UTC,
    diagnostics: "fanout_v1",
  })) requestUrl.searchParams.set(key, String(value));
  const response = await fanoutWorker.fetch(new Request(requestUrl, {
    headers: { "x-uk-aq-upstream-auth": SECRET, "cf-ray": "mock-coordinator-ray" },
  }), {
    UKAQ_ENV_NAME: "TEST",
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v3-physical-leaf-fanout-candidate",
    UK_AQ_EDGE_UPSTREAM_SECRET: SECRET,
    PHYSICAL_LEAF: serviceBinding,
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.response_complete, true);
  assert.equal(payload.diagnostic_request.child_invocation_count, 7);
  assert.equal(maximumActiveCalls, 7);
  assert.equal(calls.length, 7);
  assert.deepEqual(payload.rows, expectedRows);
  assert.equal(JSON.stringify(payload.rows), JSON.stringify(expectedRows));
  assert.equal(payload.rows_sha256, sha256Rows(expectedRows));
  assert.equal(payload.diagnostic_request.final_rows_sha256, payload.rows_sha256);
  assert.deepEqual(
    payload.diagnostic_request.child_requests.map((child) => [
      child.day_utc,
      child.start_utc,
      child.end_utc,
      child.rows_returned,
    ]),
    EXPECTED_SLICES.map((slice) => [...slice, 2]),
  );
  return {
    child_invocation_count: calls.length,
    maximum_concurrent_child_calls: maximumActiveCalls,
    slices: EXPECTED_SLICES,
    direct_rows: expectedRows.length,
    merged_rows: payload.rows.length,
    rows_sha256: payload.rows_sha256,
    exact_rows_equal: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateLocalFanout()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
