import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import candidateWorker, {
  OBSERVATION_HISTORY_V3_WORKLOAD_DIAGNOSTIC_MODE,
  parseObservationRequest,
} from "../workers/uk_aq_observs_history_r2_api_v3_candidate/worker.mjs";
import {
  assertTestCandidateEndpoint,
  buildObservationHistoryV3MeasurementMatrix,
} from "../scripts/index_v3_migration/measure_observation_history_v3_candidate.mjs";
import {
  assertAlignedTestEndpoint,
  buildAlignedV2MeasurementMatrix,
  measureAlignedV2Attempt,
} from "../scripts/index_v3_aligned_candidate/measure.mjs";
import {
  alignedV2TestR2Authority,
  assertAlignedV2TestR2Identity,
} from "../scripts/index_v3_aligned_candidate/test_r2_identity.mjs";

const candidateSource = readFileSync(
  new URL(
    "../workers/uk_aq_observs_history_r2_api_v3_candidate/worker.mjs",
    import.meta.url,
  ),
  "utf8",
);

function observationUrl(extra = "") {
  const url = new URL("https://candidate.example/v1/observations");
  url.searchParams.set("timeseries_id", "7421");
  url.searchParams.set("connector_id", "7");
  url.searchParams.set("pollutant", "pm25");
  url.searchParams.set("start_utc", "2026-08-20T00:00:00.000Z");
  url.searchParams.set("end_utc", "2026-08-21T00:00:00.000Z");
  if (extra) url.searchParams.set("diagnostics", extra);
  return url;
}

test("v3 candidate workload diagnostics require the explicit supported mode", () => {
  const normal = parseObservationRequest(observationUrl());
  assert.equal(normal.ok, true);
  assert.equal(normal.diagnosticMode, null);

  const diagnostic = parseObservationRequest(observationUrl(
    OBSERVATION_HISTORY_V3_WORKLOAD_DIAGNOSTIC_MODE,
  ));
  assert.equal(diagnostic.ok, true);
  assert.equal(
    diagnostic.diagnosticMode,
    OBSERVATION_HISTORY_V3_WORKLOAD_DIAGNOSTIC_MODE,
  );

  const unsupported = parseObservationRequest(observationUrl("verbose"));
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, 400);
});

test("v3 candidate diagnostics remain authenticated and bypass Cache API", async () => {
  const unauthorized = await candidateWorker.fetch(
    new Request(observationUrl(OBSERVATION_HISTORY_V3_WORKLOAD_DIAGNOSTIC_MODE)),
    { UK_AQ_EDGE_UPSTREAM_SECRET: "secret" },
    {},
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("x-ukaq-diagnostic-request-id"), null);

  const diagnosticBranch = candidateSource.indexOf("if (diagnosticContext)");
  const cacheKeyBranch = candidateSource.indexOf(
    "const key = cacheKey(request.url, params, INDEX_GENERATION)",
  );
  assert.ok(diagnosticBranch >= 0);
  assert.ok(cacheKeyBranch > diagnosticBranch);
  assert.match(candidateSource, /noStore: !complete \|\| Boolean\(diagnosticContext\)/);
  assert.match(candidateSource, /x-ukaq-diagnostic-request-id/);
  assert.match(candidateSource, /cpu_time_ms: null/);
  assert.match(candidateSource, /cloudflare_invocation_logs_or_analytics/);
});

test("v3 workload matrix is bounded, repeatable, and TEST-host restricted", () => {
  const baseline = buildObservationHistoryV3MeasurementMatrix();
  assert.equal(baseline.length, 14);
  assert.deepEqual(
    baseline.filter((entry) => entry.source === "AURN").map((entry) => entry.name),
    [
      "aurn_ts218_1d",
      "aurn_ts218_3d",
      "aurn_ts218_7d",
      "aurn_ts218_9_partition_failure_shape",
    ],
  );
  assert.equal(
    baseline.find((entry) => entry.name.includes("failure_shape")).maxAttempts,
    1,
  );
  assert.deepEqual(
    baseline.filter((entry) => entry.source === "Sensor.Community-normal")
      .map((entry) => (Date.parse(entry.endUtc) - Date.parse(entry.startUtc)) / 3_600_000),
    [1, 6, 12, 24, 72, 168],
  );

  const withHighDensity = buildObservationHistoryV3MeasurementMatrix();
  assert.deepEqual(
    withHighDensity.slice(-4).map((entry) =>
      (Date.parse(entry.endUtc) - Date.parse(entry.startUtc)) / 3_600_000
    ),
    [1, 6, 12, 24],
  );
  assert.ok(withHighDensity.slice(-4).every((entry) =>
    entry.timeseriesId === 7421 && entry.startUtc.startsWith("2026-04-03T")
  ));

  assert.equal(
    assertTestCandidateEndpoint(
      "https://uk-aq-observs-history-r2-api-v3-candidate.cic-test.workers.dev/ignored",
    ).pathname,
    "/v1/observations",
  );
  assert.throws(
    () => assertTestCandidateEndpoint(
      "https://uk-aq-observs-history-r2-api-live-v3-candidate.account.workers.dev",
    ),
    /Refusing non-TEST endpoint/,
  );
});

test("aligned-v2 measurement records a thrown request without inventing diagnostics", async () => {
  const item = buildAlignedV2MeasurementMatrix()[0];
  const result = await measureAlignedV2Attempt({
    endpoint: assertAlignedTestEndpoint(
      "https://uk-aq-observs-history-r2-api-v3-aligned-candidate.cic-test.workers.dev",
    ),
    secret: "secret",
    item,
    attempt: 2,
    timeoutMs: 100,
    fetchImpl: async () => {
      throw new Error("fixture connection reset");
    },
  });

  assert.equal(result.case, item.name);
  assert.equal(result.aligned_row_cap, item.aligned_row_cap);
  assert.equal(result.attempt, 2);
  assert.deepEqual(result.request, {
    connector_id: item.connector_id,
    timeseries_id: item.timeseries_id,
    pollutant: "pm25",
    start_utc: item.start_utc,
    end_utc: item.end_utc,
  });
  assert.equal(result.response.status, null);
  assert.equal(result.response.error, "fixture connection reset");
  assert.equal(result.physical, null);
  assert.equal(result.cloudflare_cpu_time_ms, null);
});

test("aligned-v2 local R2 guard uses exact repository TEST authority", () => {
  const authority = alignedV2TestR2Authority();
  assert.deepEqual(
    assertAlignedV2TestR2Identity({
      UKAQ_ENV_NAME: "TEST",
      CFLARE_R2_ENDPOINT: authority.endpoint,
      CFLARE_R2_BUCKET: authority.bucket,
    }),
    authority,
  );
  assert.throws(
    () => assertAlignedV2TestR2Identity({
      UKAQ_ENV_NAME: "TEST",
      CFLARE_R2_ENDPOINT: "https://live-account.r2.cloudflarestorage.com",
      CFLARE_R2_BUCKET: authority.bucket,
    }),
    /endpoint does not match.*TEST authority/,
  );
  assert.throws(
    () => assertAlignedV2TestR2Identity({
      UKAQ_ENV_NAME: "TEST",
      CFLARE_R2_ENDPOINT: authority.endpoint,
      CFLARE_R2_BUCKET: "different-bucket",
    }),
    /bucket does not match.*TEST authority/,
  );
});
