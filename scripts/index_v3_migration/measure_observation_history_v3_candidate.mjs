#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIAGNOSTIC_MODE = "workload_v1";
const DEFAULT_REPEAT = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HIGH_DENSITY_TIMESERIES_ID = 7421;
const DEFAULT_HIGH_DENSITY_DAY_UTC = "2026-04-03";
const TEST_CANDIDATE_HOST_PATTERN =
  /-v3-candidate\.[a-z0-9-]*test[a-z0-9-]*\.workers\.dev$/i;

function canonicalIso(value, label) {
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return parsed.toISOString();
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function utcEnd(dayUtc, hours) {
  const start = Date.parse(`${dayUtc}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error(`Invalid UTC day: ${dayUtc}`);
  return new Date(start + hours * 60 * 60 * 1000).toISOString();
}

function matrixCases({
  highDensityTimeseriesId = DEFAULT_HIGH_DENSITY_TIMESERIES_ID,
  highDensityDayUtc = DEFAULT_HIGH_DENSITY_DAY_UTC,
} = {}) {
  const cases = [
    ...[
      ["aurn_ts218_1d", "2026-06-04T00:00:00.000Z", "2026-06-05T00:00:00.000Z"],
      ["aurn_ts218_3d", "2026-06-04T00:00:00.000Z", "2026-06-07T00:00:00.000Z"],
      ["aurn_ts218_7d", "2026-06-04T00:00:00.000Z", "2026-06-11T00:00:00.000Z"],
      ["aurn_ts218_9_partition_failure_shape", "2026-06-14T13:58:29.148Z", "2026-06-22T12:58:29.149Z"],
    ].map(([name, startUtc, endUtc]) => ({
      name,
      source: "AURN",
      connectorId: 1,
      pollutant: "pm25",
      timeseriesId: 218,
      startUtc,
      endUtc,
      maxAttempts: name.includes("failure_shape") ? 1 : null,
    })),
    ...[1, 6, 12, 24, 72, 168].map((hours) => ({
      name: `sensor_community_ts7421_${hours}h`,
      source: "Sensor.Community-normal",
      connectorId: 7,
      pollutant: "pm25",
      timeseriesId: 7421,
      startUtc: "2026-08-20T00:00:00.000Z",
      endUtc: utcEnd("2026-08-20", hours),
      maxAttempts: null,
    })),
  ];

  if (highDensityTimeseriesId !== null || highDensityDayUtc !== null) {
    if (highDensityTimeseriesId === null || highDensityDayUtc === null) {
      throw new Error(
        "High-density measurement requires both --high-density-timeseries-id and --high-density-day-utc",
      );
    }
    for (const hours of [1, 6, 12, 24]) {
      cases.push({
        name: `sensor_community_high_density_ts${highDensityTimeseriesId}_${hours}h`,
        source: "Sensor.Community-high-density",
        connectorId: 7,
        pollutant: "pm25",
        timeseriesId: positiveInteger(
          highDensityTimeseriesId,
          "high-density timeseries ID",
        ),
        startUtc: canonicalIso(`${highDensityDayUtc}T00:00:00.000Z`, "high-density start"),
        endUtc: utcEnd(highDensityDayUtc, hours),
        maxAttempts: null,
      });
    }
  }
  return cases;
}

export function buildObservationHistoryV3MeasurementMatrix(options = {}) {
  return matrixCases(options).map((entry) => Object.freeze({ ...entry }));
}

export function assertTestCandidateEndpoint(value) {
  const endpoint = new URL(String(value || ""));
  if (endpoint.protocol !== "https:") {
    throw new Error("Candidate endpoint must use https");
  }
  if (!TEST_CANDIDATE_HOST_PATTERN.test(endpoint.hostname)) {
    throw new Error(
      "Refusing non-TEST endpoint; expected a *-v3-candidate.<TEST-account>.workers.dev host",
    );
  }
  endpoint.pathname = "/v1/observations";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function parseArgs(argv) {
  const options = {
    endpoint: process.env.UK_AQ_V3_CANDIDATE_URL || "",
    outputDir: "",
    repeat: DEFAULT_REPEAT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    highDensityTimeseriesId: DEFAULT_HIGH_DENSITY_TIMESERIES_ID,
    highDensityDayUtc: DEFAULT_HIGH_DENSITY_DAY_UTC,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    if (argument === "--endpoint") options.endpoint = next();
    else if (argument === "--output-dir") options.outputDir = next();
    else if (argument === "--repeat") options.repeat = positiveInteger(next(), "repeat");
    else if (argument === "--timeout-ms") options.timeoutMs = positiveInteger(next(), "timeout-ms");
    else if (argument === "--high-density-timeseries-id") {
      options.highDensityTimeseriesId = positiveInteger(next(), "high-density timeseries ID");
    } else if (argument === "--high-density-day-utc") {
      options.highDensityDayUtc = next();
    } else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function requestUrl(endpoint, measurementCase) {
  const url = new URL(endpoint);
  url.searchParams.set("connector_id", String(measurementCase.connectorId));
  url.searchParams.set("pollutant", measurementCase.pollutant);
  url.searchParams.set("timeseries_id", String(measurementCase.timeseriesId));
  url.searchParams.set("start_utc", measurementCase.startUtc);
  url.searchParams.set("end_utc", measurementCase.endUtc);
  url.searchParams.set("diagnostics", DIAGNOSTIC_MODE);
  return url;
}

function selectedHeaders(response) {
  return {
    cf_ray: response.headers.get("cf-ray"),
    diagnostic_request_id: response.headers.get("x-ukaq-diagnostic-request-id"),
    cache: response.headers.get("x-ukaq-cache"),
    cache_generation: response.headers.get("x-ukaq-cache-generation"),
    footer_cache_generation: response.headers.get("x-ukaq-footer-cache-generation"),
    cache_control: response.headers.get("cache-control"),
  };
}

function compactResult({ measurementCase, attempt, response, payload, bodyText, elapsedMs }) {
  const exactDiagnostics = payload?.coverage?.exact_reader_diagnostics ||
    payload?.diagnostics || null;
  return {
    schema_version: 1,
    measured_at_utc: new Date().toISOString(),
    source: measurementCase.source,
    case: measurementCase.name,
    attempt,
    request: {
      connector_id: measurementCase.connectorId,
      pollutant: measurementCase.pollutant,
      timeseries_id: measurementCase.timeseriesId,
      start_utc: measurementCase.startUtc,
      end_utc: measurementCase.endUtc,
    },
    response: {
      status: response.status,
      ok: response.ok,
      headers: selectedHeaders(response),
      client_elapsed_ms: Number(elapsedMs.toFixed(3)),
      row_count: payload?.row_count ?? null,
      response_complete: payload?.response_complete ?? null,
      has_gap: payload?.has_gap ?? null,
      partial_reasons: payload?.partial_reasons ?? null,
      error: payload?.error ?? (!payload ? bodyText.slice(0, 512) : null),
    },
    diagnostic_request: payload?.diagnostic_request ?? null,
    exact_reader_diagnostics: exactDiagnostics,
    cloudflare_cpu_time_ms: null,
    cloudflare_cpu_time_source: "correlate diagnostic request ID or cf-ray in invocation logs/analytics",
  };
}

async function measureOne({ endpoint, secret, measurementCase, attempt, timeoutMs }) {
  const url = requestUrl(endpoint, measurementCase);
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-uk-aq-upstream-auth": secret },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyText = await response.text();
  const elapsedMs = performance.now() - startedAt;
  let payload = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    // Cloudflare platform failures such as 1102 may return a plain-text body.
  }
  return compactResult({
    measurementCase,
    attempt,
    response,
    payload,
    bodyText,
    elapsedMs,
  });
}

function outputDirectory(value, runTimestamp) {
  return path.resolve(value || path.join(
    "tmp",
    "index_v3_workload_measurements",
    runTimestamp.replaceAll(":", "").replaceAll("-", ""),
  ));
}

function writeResult(directory, sequence, result) {
  const prefix = String(sequence).padStart(3, "0");
  const filename = `${prefix}_${result.case}_attempt${result.attempt}.json`;
  fs.writeFileSync(
    path.join(directory, filename),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  fs.appendFileSync(
    path.join(directory, "results.jsonl"),
    `${JSON.stringify(result)}\n`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const matrix = buildObservationHistoryV3MeasurementMatrix(options);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      diagnostic_mode: DIAGNOSTIC_MODE,
      repeat: options.repeat,
      high_density_configured: options.highDensityTimeseriesId !== null,
      cases: matrix,
    }, null, 2)}\n`);
    return;
  }

  const endpoint = assertTestCandidateEndpoint(options.endpoint);
  const secret = String(process.env.UK_AQ_EDGE_UPSTREAM_SECRET || "");
  if (!secret) throw new Error("UK_AQ_EDGE_UPSTREAM_SECRET is required in the environment");
  const runTimestamp = new Date().toISOString();
  const directory = outputDirectory(options.outputDir, runTimestamp);
  fs.mkdirSync(directory, { recursive: true });
  const run = {
    schema_version: 1,
    run_id: crypto.randomUUID(),
    started_at_utc: runTimestamp,
    endpoint_origin: endpoint.origin,
    diagnostic_mode: DIAGNOSTIC_MODE,
    repeat: options.repeat,
    timeout_ms: options.timeoutMs,
    high_density_configured: options.highDensityTimeseriesId !== null,
    note: "Consecutive attempts may use different Cloudflare isolates; infer warmth only from footer cache counters.",
  };
  fs.writeFileSync(
    path.join(directory, "run.json"),
    `${JSON.stringify(run, null, 2)}\n`,
    { flag: "wx" },
  );

  let sequence = 0;
  for (const measurementCase of matrix) {
    const attempts = measurementCase.maxAttempts || options.repeat;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      sequence += 1;
      let result;
      try {
        result = await measureOne({
          endpoint,
          secret,
          measurementCase,
          attempt,
          timeoutMs: options.timeoutMs,
        });
      } catch (error) {
        result = {
          schema_version: 1,
          measured_at_utc: new Date().toISOString(),
          source: measurementCase.source,
          case: measurementCase.name,
          attempt,
          request: {
            connector_id: measurementCase.connectorId,
            pollutant: measurementCase.pollutant,
            timeseries_id: measurementCase.timeseriesId,
            start_utc: measurementCase.startUtc,
            end_utc: measurementCase.endUtc,
          },
          response: {
            status: null,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          diagnostic_request: null,
          exact_reader_diagnostics: null,
          cloudflare_cpu_time_ms: null,
        };
      }
      writeResult(directory, sequence, result);
      process.stdout.write(`${JSON.stringify({
        sequence,
        case: result.case,
        attempt,
        status: result.response.status,
        complete: result.response.response_complete ?? null,
        rows: result.response.row_count ?? null,
        diagnostic_request_id:
          result.diagnostic_request?.request_id ||
          result.response.headers?.diagnostic_request_id || null,
        cf_ray: result.response.headers?.cf_ray || null,
        client_elapsed_ms: result.response.client_elapsed_ms ?? null,
      })}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ output_directory: directory, result_count: sequence })}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
