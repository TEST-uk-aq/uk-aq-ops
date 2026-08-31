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
