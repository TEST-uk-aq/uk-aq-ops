#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  partitionUtcDaySlices,
} from "../../workers/uk_aq_observs_history_r2_api_v3_leaf_fanout_candidate/worker.mjs";

const DIRECT_LEAF_HOST = /-v3-leaf-candidate\.[a-z0-9-]*test[a-z0-9-]*\.workers\.dev$/i;
const FANOUT_HOST = /-v3-leaf-fanout-candidate\.[a-z0-9-]*test[a-z0-9-]*\.workers\.dev$/i;
const CASES = Object.freeze({
  seven_day: Object.freeze({
    name: "sensorcommunity_normal_ts7421_7d",
    connector_id: 7,
    timeseries_id: 7421,
    pollutant: "pm25",
    start_utc: "2026-08-20T00:00:00.000Z",
    end_utc: "2026-08-27T00:00:00.000Z",
  }),
  control_24h: Object.freeze({
    name: "sensorcommunity_normal_ts7421_24h_control",
    connector_id: 7,
    timeseries_id: 7421,
    pollutant: "pm25",
    start_utc: "2026-08-20T00:00:00.000Z",
    end_utc: "2026-08-21T00:00:00.000Z",
  }),
});

function parse(argv) {
  const options = {
    directLeafEndpoint: process.env.UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL || "",
    fanoutEndpoint: process.env.UK_AQ_V3_LEAF_FANOUT_CANDIDATE_URL || "",
    outputDir: "",
    timeoutMs: 30_000,
    dryRun: false,
    include24hControl: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index] || (() => { throw new Error(`${argument} requires a value`); })();
    if (argument === "--direct-leaf-endpoint") options.directLeafEndpoint = next();
    else if (argument === "--fanout-endpoint") options.fanoutEndpoint = next();
    else if (argument === "--output-dir") options.outputDir = next();
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--include-24h-control") options.include24hControl = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("timeout-ms must be a positive integer");
  }
  return options;
}

function endpoint(raw, pattern, label) {
  const url = new URL(String(raw || ""));
  if (url.protocol !== "https:" || !pattern.test(url.hostname)) {
    throw new Error(`refusing ${label}; expected its isolated TEST workers.dev host`);
  }
  url.pathname = "/v1/observations";
  url.search = "";
  url.hash = "";
  return url;
}

function requestUrl(base, item, variant) {
  const url = new URL(base);
  for (const [key, value] of Object.entries({
    connector_id: item.connector_id,
    pollutant: item.pollutant,
    timeseries_id: item.timeseries_id,
    start_utc: item.start_utc,
    end_utc: item.end_utc,
    diagnostics: variant === "direct_leaf" ? "workload_v1" : "fanout_v1",
  })) url.searchParams.set(key, String(value));
  return url;
}

function rowsSha256(rows) {
  return Array.isArray(rows)
    ? crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex")
    : null;
}

async function attempt({ base, item, variant, secret, timeoutMs }) {
  const url = requestUrl(base, item, variant);
  try {
    const response = await fetch(url, {
      headers: { "x-uk-aq-upstream-auth": secret },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* retain bounded platform text below */ }
    const rows = Array.isArray(payload?.rows) ? payload.rows : null;
    const calculatedHash = rowsSha256(rows);
    return {
      schema_version: 1,
      measured_at_utc: new Date().toISOString(),
      case: item.name,
      variant,
      request: {
        url: url.toString(),
        connector_id: item.connector_id,
        pollutant: item.pollutant,
        timeseries_id: item.timeseries_id,
        start_utc: item.start_utc,
        end_utc: item.end_utc,
      },
      response: {
        status: response.status,
        ok: response.ok,
        returned_rows: payload?.row_count ?? null,
        response_complete: payload?.response_complete ?? null,
        partial_reasons: payload?.partial_reasons ?? null,
        rows,
        rows_json: rows ? JSON.stringify(rows) : null,
        rows_sha256: calculatedHash,
        reported_rows_sha256: payload?.rows_sha256 ?? null,
        diagnostic_request_id:
          response.headers.get("x-ukaq-diagnostic-request-id") ||
          payload?.diagnostic_request?.request_id ||
          null,
        cf_ray: response.headers.get("cf-ray") || payload?.diagnostic_request?.cloudflare_ray_id || null,
        coordinator_diagnostics: variant === "fanout" ? payload?.diagnostic_request ?? null : null,
        error: payload?.error ?? (!payload ? text.slice(0, 500) : null),
      },
      cloudflare_cpu_time_ms: null,
      cloudflare_cpu_time_source: "correlate diagnostic_request_id or cf_ray in Cloudflare invocation telemetry",
    };
  } catch (error) {
    return {
      schema_version: 1,
      measured_at_utc: new Date().toISOString(),
      case: item.name,
      variant,
      request: { url: url.toString() },
      response: {
        status: null,
        ok: false,
        returned_rows: null,
        response_complete: null,
        partial_reasons: null,
        rows: null,
        rows_json: null,
        rows_sha256: null,
        reported_rows_sha256: null,
        diagnostic_request_id: null,
        cf_ray: null,
        coordinator_diagnostics: null,
        error: error instanceof Error ? error.message : String(error),
      },
      cloudflare_cpu_time_ms: null,
      cloudflare_cpu_time_source: null,
    };
  }
}

function comparePair(item, direct, fanout) {
  const expectedSlices = partitionUtcDaySlices(item.start_utc, item.end_utc);
  const coordinator = fanout.response.coordinator_diagnostics;
  const exactRowsEqual = Boolean(
    direct.response.rows_json &&
    fanout.response.rows_json &&
    direct.response.rows_json === fanout.response.rows_json
  );
  const hashesEqual = Boolean(
    direct.response.rows_sha256 &&
    direct.response.rows_sha256 === fanout.response.rows_sha256
  );
  const fanoutReportedHashMatches = Boolean(
    fanout.response.rows_sha256 &&
    fanout.response.rows_sha256 === fanout.response.reported_rows_sha256
  );
  const coordinatorHashMatches = Boolean(
    fanout.response.rows_sha256 &&
    fanout.response.rows_sha256 === coordinator?.final_rows_sha256
  );
  const childBoundsExact = JSON.stringify(coordinator?.child_requests?.map((child) => ({
    ordinal: child.ordinal,
    day_utc: child.day_utc,
    start_utc: child.start_utc,
    end_utc: child.end_utc,
  }))) === JSON.stringify(expectedSlices);
  const childRowsSum = Array.isArray(coordinator?.child_requests)
    ? coordinator.child_requests.reduce((sum, child) => sum + Number(child.rows_returned), 0)
    : null;
  const coordinatorDiagnosticsExact = Boolean(
    coordinator?.child_invocation_count === expectedSlices.length &&
    JSON.stringify(coordinator?.requested_utc_days) === JSON.stringify(expectedSlices.map((slice) => slice.day_utc)) &&
    childBoundsExact &&
    childRowsSum === fanout.response.returned_rows &&
    coordinator?.merged_rows === fanout.response.returned_rows &&
    coordinator?.response_complete === true
  );
  const passed = Boolean(
    direct.response.ok &&
    fanout.response.ok &&
    direct.response.response_complete === true &&
    fanout.response.response_complete === true &&
    direct.response.returned_rows > 0 &&
    direct.response.returned_rows === fanout.response.returned_rows &&
    exactRowsEqual &&
    hashesEqual &&
    fanoutReportedHashMatches &&
    coordinatorHashMatches &&
    coordinatorDiagnosticsExact
  );
  return {
    schema_version: 1,
    case: item.name,
    passed,
    exact_rows_equal: exactRowsEqual,
    rows_sha256_equal: hashesEqual,
    fanout_reported_rows_sha256_matches: fanoutReportedHashMatches,
    coordinator_final_rows_sha256_matches: coordinatorHashMatches,
    coordinator_diagnostics_exact: coordinatorDiagnosticsExact,
    child_bounds_exact: childBoundsExact,
    child_invocation_count: coordinator?.child_invocation_count ?? null,
    direct_rows: direct.response.returned_rows,
    fanout_rows: fanout.response.returned_rows,
    direct_rows_sha256: direct.response.rows_sha256,
    fanout_rows_sha256: fanout.response.rows_sha256,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const cases = options.include24hControl ? [CASES.seven_day, CASES.control_24h] : [CASES.seven_day];
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      variants: ["direct_leaf", "fanout"],
      cases: cases.map((item) => ({
        ...item,
        fanout_child_requests: partitionUtcDaySlices(item.start_utc, item.end_utc),
      })),
      cpu_time_ms: null,
      cpu_time_source: "Cloudflare invocation telemetry after TEST deployment",
    }, null, 2)}\n`);
    return;
  }

  const endpoints = {
    direct_leaf: endpoint(options.directLeafEndpoint, DIRECT_LEAF_HOST, "direct physical-leaf endpoint"),
    fanout: endpoint(options.fanoutEndpoint, FANOUT_HOST, "leaf fan-out endpoint"),
  };
  const secret = String(process.env.UK_AQ_EDGE_UPSTREAM_SECRET || "");
  if (!secret) throw new Error("UK_AQ_EDGE_UPSTREAM_SECRET is required");
  const stamp = new Date().toISOString();
  const directory = path.resolve(options.outputDir || path.join(
    "tmp",
    "index_v3_leaf_fanout_measurements",
    stamp.replaceAll(/[-:]/g, ""),
  ));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify({
    schema_version: 1,
    run_id: crypto.randomUUID(),
    started_at_utc: stamp,
    cases: cases.map((item) => item.name),
    endpoints: Object.fromEntries(Object.entries(endpoints).map(([key, value]) => [key, value.origin])),
  }, null, 2)}\n`, { flag: "wx" });

  for (const item of cases) {
    const direct = await attempt({
      base: endpoints.direct_leaf,
      item,
      variant: "direct_leaf",
      secret,
      timeoutMs: options.timeoutMs,
    });
    const fanout = await attempt({
      base: endpoints.fanout,
      item,
      variant: "fanout",
      secret,
      timeoutMs: options.timeoutMs,
    });
    const comparison = comparePair(item, direct, fanout);
    for (const result of [direct, fanout]) {
      fs.appendFileSync(path.join(directory, "results.jsonl"), `${JSON.stringify(result)}\n`);
    }
    fs.appendFileSync(path.join(directory, "comparisons.jsonl"), `${JSON.stringify(comparison)}\n`);
    process.stdout.write(`${JSON.stringify(comparison)}\n`);
    if (!comparison.passed) throw new Error(`direct/fan-out equality failed for ${item.name}`);
  }
  process.stdout.write(`results=${directory}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
