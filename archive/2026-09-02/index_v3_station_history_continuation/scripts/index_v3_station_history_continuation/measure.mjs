#!/usr/bin/env node
import crypto from "node:crypto";

const CASES = Object.freeze({
  "normal-24h": Object.freeze({
    timeseries_id: 7421,
    connector_id: 7,
    pollutant: "pm25",
    start_utc: "2026-08-20T00:00:00.000Z",
    end_utc: "2026-08-21T00:00:00.000Z",
    include_observations: true,
    include_aqi: false,
  }),
  "dense-24h": Object.freeze({
    timeseries_id: 7421,
    connector_id: 7,
    pollutant: "pm25",
    start_utc: "2026-04-03T00:00:00.000Z",
    end_utc: "2026-04-04T00:00:00.000Z",
    include_observations: true,
    include_aqi: false,
  }),
  "dense-pm-hidden-context": Object.freeze({
    timeseries_id: 7421,
    connector_id: 7,
    pollutant: "pm25",
    start_utc: "2026-04-03T23:00:00.001Z",
    end_utc: "2026-04-03T23:59:59.999Z",
    include_observations: true,
    include_aqi: true,
  }),
});

function required(value) { return String(value ?? "").trim(); }

function parse(argv) {
  const options = {
    baseUrl: required(process.env.UK_AQ_STATION_HISTORY_V3_CANDIDATE_URL),
    secret: required(process.env.UK_AQ_EDGE_UPSTREAM_SECRET),
    caseName: "",
    dryRun: false,
    expectedObservationsSha256: "",
    expectedAqiSha256: "",
    expectedCombinedSha256: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base-url") options.baseUrl = required(argv[++index]);
    else if (argument === "--secret") options.secret = required(argv[++index]);
    else if (argument === "--case") options.caseName = required(argv[++index]);
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--expected-observations-sha256") options.expectedObservationsSha256 = required(argv[++index]);
    else if (argument === "--expected-aqi-sha256") options.expectedAqiSha256 = required(argv[++index]);
    else if (argument === "--expected-combined-sha256") options.expectedCombinedSha256 = required(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!CASES[options.caseName]) throw new Error(`--case must be one of ${Object.keys(CASES).join(", ")}`);
  if (!options.baseUrl) throw new Error("--base-url or UK_AQ_STATION_HISTORY_V3_CANDIDATE_URL is required");
  if (!options.dryRun && !options.secret) throw new Error("--secret or UK_AQ_EDGE_UPSTREAM_SECRET is required");
  return options;
}

function requestUrl(baseUrl, fixture, continuation = null) {
  const url = new URL(baseUrl);
  url.pathname = "/v1/observations-history";
  url.search = "";
  for (const [name, value] of Object.entries({
    timeseries_id: fixture.timeseries_id,
    connector_id: fixture.connector_id,
    pollutant: fixture.pollutant,
    start_utc: fixture.start_utc,
    end_utc: fixture.end_utc,
    stable_head_start_utc: fixture.end_utc,
    format: "objects",
    include_observations: fixture.include_observations,
    include_aqi: fixture.include_aqi,
    limit: 5000,
    diagnostics: "cpu_v1",
  })) url.searchParams.set(name, String(value));
  if (continuation) url.searchParams.set("station_history_continuation", continuation);
  return url;
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertIdentity(payload, fixture) {
  for (const [actual, expected] of [
    [Number(payload?.identity?.timeseries_id), fixture.timeseries_id],
    [Number(payload?.identity?.connector_id), fixture.connector_id],
    [String(payload?.identity?.pollutant || ""), fixture.pollutant],
    [String(payload?.request?.start_utc || ""), fixture.start_utc],
    [String(payload?.request?.end_utc || ""), fixture.end_utc],
  ]) if (actual !== expected) throw new Error("station-history candidate returned contradictory identity or bounds");
}

function verifyExpected(label, actual, expected) {
  if (expected && actual !== expected) throw new Error(`${label} differs: expected ${expected}, received ${actual}`);
}

async function main() {
  const options = parse(process.argv.slice(2));
  const fixture = CASES[options.caseName];
  if (options.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      case: options.caseName,
      first_request_url: requestUrl(options.baseUrl, fixture).toString(),
      continuation_parameter: "station_history_continuation",
      diagnostics: "cpu_v1",
      cpu_source: "Cloudflare invocation logs or Workers Analytics; this command does not time CPU",
    }, null, 2));
    return;
  }
  const observations = [];
  const aqi = [];
  const invocations = [];
  const seenContinuations = new Set();
  let continuation = null;
  for (let invocation = 0; invocation < 1000; invocation += 1) {
    const url = requestUrl(options.baseUrl, fixture, continuation);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-UK-AQ-Upstream-Auth": options.secret,
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) throw new Error(`station-history candidate request failed: HTTP ${response.status}`);
    assertIdentity(payload, fixture);
    const page = payload.station_history_page;
    if (!page || page.continuation_number !== invocation) throw new Error("station-history continuation number contradicted request order");
    observations.push(...(Array.isArray(payload?.observations?.rows) ? payload.observations.rows : []));
    aqi.push(...(Array.isArray(payload?.aqi?.rows) ? payload.aqi.rows : []));
    invocations.push({
      continuation_number: invocation,
      diagnostic_request_id: response.headers.get("x-ukaq-diagnostic-request-id") || payload?.diagnostic_request?.station_history_request_id || null,
      cloudflare_ray_id: payload?.diagnostic_request?.cloudflare_ray_id || response.headers.get("cf-ray") || null,
      configured_physical_page_work_cap: page.physical_page_work_cap,
      physical_pages_consumed: page.physical_pages_consumed,
      source_rows_received: page.source_rows_received,
      observation_rows_returned: payload?.observations?.rows?.length || 0,
      aqi_rows_returned: payload?.aqi?.rows?.length || 0,
      continuation_returned: page.continuation_returned === true,
      genuine_gap: payload.has_gap === true,
      cpu_time_ms: null,
    });
    continuation = required(payload.station_history_continuation);
    if (!continuation) {
      if (payload.response_complete !== true || payload.has_gap === true) {
        throw new Error("terminal station-history response was incomplete or gap-bearing");
      }
      break;
    }
    if (seenContinuations.has(continuation)) throw new Error("station-history continuation loop");
    seenContinuations.add(continuation);
  }
  if (continuation) throw new Error("station-history continuation safety limit exceeded");
  const hashes = {
    observations_sha256: sha256(observations),
    aqi_sha256: sha256(aqi),
    combined_response_rows_sha256: sha256({ observations, aqi }),
  };
  verifyExpected("observations SHA-256", hashes.observations_sha256, options.expectedObservationsSha256);
  verifyExpected("AQI SHA-256", hashes.aqi_sha256, options.expectedAqiSha256);
  verifyExpected("combined response rows SHA-256", hashes.combined_response_rows_sha256, options.expectedCombinedSha256);
  console.log(JSON.stringify({
    ok: true,
    case: options.caseName,
    fixture,
    station_history_invocation_count: invocations.length,
    physical_page_fetch_count: invocations.reduce((sum, item) => sum + item.physical_pages_consumed, 0),
    observation_row_count: observations.length,
    aqi_row_count: aqi.length,
    hashes,
    invocations,
    cpu_source: "Cloudflare invocation logs or Workers Analytics; correlate by diagnostic_request_id and CF-Ray",
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
