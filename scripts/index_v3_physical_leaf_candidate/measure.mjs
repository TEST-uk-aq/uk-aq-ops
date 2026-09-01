#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PHYSICAL_1024_HOST = /-v3-physical-1024-candidate\.[a-z0-9-]*test[a-z0-9-]*\.workers\.dev$/i;
const PHYSICAL_LEAF_HOST = /-v3-leaf-candidate\.[a-z0-9-]*test[a-z0-9-]*\.workers\.dev$/i;

export function buildPhysicalLeafMeasurementMatrix() {
  return [
    {
      name: "sensorcommunity_normal_ts7421_24h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-08-20T00:00:00.000Z",
      end_utc: "2026-08-21T00:00:00.000Z",
    },
    {
      name: "sensorcommunity_dense_ts7421_1h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-04-03T00:00:00.000Z",
      end_utc: "2026-04-03T01:00:00.000Z",
    },
  ];
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

function parse(argv) {
  const options = {
    physical1024Endpoint: process.env.UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL || "",
    physicalLeafEndpoint: process.env.UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL || "",
    outputDir: "",
    repeat: 1,
    timeoutMs: 30000,
    dryRun: false,
    caseNames: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index] || (() => { throw new Error(`${argument} requires a value`); })();
    if (argument === "--physical-1024-endpoint") options.physical1024Endpoint = next();
    else if (argument === "--physical-leaf-endpoint") options.physicalLeafEndpoint = next();
    else if (argument === "--output-dir") options.outputDir = next();
    else if (argument === "--repeat") options.repeat = Number(next());
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--case") options.caseNames.push(next());
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (
    !Number.isSafeInteger(options.repeat) ||
    options.repeat < 1 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1
  ) throw new Error("repeat and timeout-ms must be positive integers");
  return options;
}

function selectCases(matrix, caseNames) {
  if (!caseNames.length) return matrix;
  const accepted = new Set(matrix.map((item) => item.name));
  const unknown = [...new Set(caseNames.filter((name) => !accepted.has(name)))];
  if (unknown.length) {
    throw new Error(`Unknown --case name(s): ${unknown.join(", ")}. Accepted: ${[...accepted].join(", ")}`);
  }
  const selected = new Set(caseNames);
  return matrix.filter((item) => selected.has(item.name));
}

function requestedUtcDays(item) {
  const dayMs = 86_400_000;
  const start = Date.parse(item.start_utc);
  const end = Date.parse(item.end_utc);
  return Math.floor((end - 1) / dayMs) - Math.floor(start / dayMs) + 1;
}

function requestUrl(base, item) {
  const url = new URL(base);
  for (const [key, value] of Object.entries({
    connector_id: item.connector_id,
    pollutant: "pm25",
    timeseries_id: item.timeseries_id,
    start_utc: item.start_utc,
    end_utc: item.end_utc,
    diagnostics: "workload_v1",
  })) url.searchParams.set(key, String(value));
  return url;
}

function physicalDiagnostics(diagnostics, variant, item) {
  if (!diagnostics) return null;
  const coarseChildShards = diagnostics.coarse_child_shards_read ??
    (variant === "physical_1024"
      ? Math.max(0, diagnostics.index_objects_read - requestedUtcDays(item))
      : null);
  return {
    aligned_row_cap: diagnostics.aligned_row_cap,
    selected_chronological_segments: diagnostics.selected_chronological_segments,
    selected_files: diagnostics.selected_files,
    physical_rows_decoded: diagnostics.physical_rows_decoded,
    index_objects_read: diagnostics.index_objects_read,
    index_bytes_read: diagnostics.index_bytes_read,
    timeseries_leaf_objects_read: diagnostics.timeseries_leaf_objects_read ?? 0,
    timeseries_leaf_bytes_read: diagnostics.timeseries_leaf_bytes_read ?? 0,
    coarse_child_shards_read: coarseChildShards,
    coarse_child_shards_source: diagnostics.coarse_child_shards_read === undefined
      ? "derived_as_index_objects_minus_requested_scope_manifests"
      : "reader_diagnostic",
    identity_head_reads: diagnostics.identity_head_reads,
    r2_range_reads: diagnostics.r2_range_reads,
    r2_bytes_requested: diagnostics.r2_bytes_requested,
    parquet_footer_fetched: diagnostics.parquet_footer_fetched,
    parquet_footer_parsed: diagnostics.parquet_footer_parsed,
    timeseries_id_decoded: diagnostics.timeseries_id_decoded,
  };
}

async function attempt({ base, item, variant, number, secret, timeoutMs }) {
  const started = performance.now();
  try {
    const response = await fetch(requestUrl(base, item), {
      headers: { "x-uk-aq-upstream-auth": secret },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* retain platform text error below */ }
    const diagnostics = payload?.coverage?.exact_reader_diagnostics || payload?.diagnostics || null;
    return {
      schema_version: 1,
      measured_at_utc: new Date().toISOString(),
      case: item.name,
      variant,
      attempt: number,
      request: {
        connector_id: item.connector_id,
        timeseries_id: item.timeseries_id,
        pollutant: "pm25",
        start_utc: item.start_utc,
        end_utc: item.end_utc,
      },
      response: {
        status: response.status,
        ok: response.ok,
        returned_rows: payload?.row_count ?? null,
        response_complete: payload?.response_complete ?? null,
        error: payload?.error ?? (!payload ? text.slice(0, 500) : null),
        rows_sha256: Array.isArray(payload?.rows)
          ? crypto.createHash("sha256").update(JSON.stringify(payload.rows)).digest("hex")
          : null,
        diagnostic_request_id:
          response.headers.get("x-ukaq-diagnostic-request-id") ||
          payload?.diagnostic_request?.request_id ||
          null,
        cf_ray: response.headers.get("cf-ray"),
        client_wall_ms: Number((performance.now() - started).toFixed(3)),
      },
      physical: physicalDiagnostics(diagnostics, variant, item),
      cloudflare_cpu_time_ms: null,
      cloudflare_cpu_time_source:
        "correlate diagnostic_request_id or cf_ray in Cloudflare invocation logs",
    };
  } catch (error) {
    return {
      schema_version: 1,
      measured_at_utc: new Date().toISOString(),
      case: item.name,
      variant,
      attempt: number,
      request: item,
      response: {
        status: null,
        ok: false,
        returned_rows: null,
        response_complete: null,
        error: error instanceof Error ? error.message : String(error),
        rows_sha256: null,
        diagnostic_request_id: null,
        cf_ray: null,
        client_wall_ms: Number((performance.now() - started).toFixed(3)),
      },
      physical: null,
      cloudflare_cpu_time_ms: null,
      cloudflare_cpu_time_source: null,
    };
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  const matrix = selectCases(buildPhysicalLeafMeasurementMatrix(), options.caseNames);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      repeat: options.repeat,
      variants: ["physical_1024", "physical_leaf_1024"],
      cases: matrix,
    }, null, 2)}\n`);
    return;
  }

  const endpoints = {
    physical_1024: endpoint(
      options.physical1024Endpoint,
      PHYSICAL_1024_HOST,
      "physical 1024 endpoint",
    ),
    physical_leaf_1024: endpoint(
      options.physicalLeafEndpoint,
      PHYSICAL_LEAF_HOST,
      "physical leaf endpoint",
    ),
  };
  const secret = String(process.env.UK_AQ_EDGE_UPSTREAM_SECRET || "");
  if (!secret) throw new Error("UK_AQ_EDGE_UPSTREAM_SECRET is required");

  const stamp = new Date().toISOString();
  const directory = path.resolve(options.outputDir || path.join(
    "tmp",
    "index_v3_physical_leaf_measurements",
    stamp.replaceAll(/[-:]/g, ""),
  ));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify({
    schema_version: 1,
    run_id: crypto.randomUUID(),
    started_at_utc: stamp,
    repeat: options.repeat,
    cases: matrix.length,
    endpoints: Object.fromEntries(
      Object.entries(endpoints).map(([key, value]) => [key, value.origin]),
    ),
  }, null, 2)}\n`, { flag: "wx" });

  let sequence = 0;
  for (const item of matrix) {
    for (let number = 1; number <= options.repeat; number += 1) {
      const pair = [];
      for (const variant of ["physical_1024", "physical_leaf_1024"]) {
        sequence += 1;
        const result = await attempt({
          base: endpoints[variant],
          item,
          variant,
          number,
          secret,
          timeoutMs: options.timeoutMs,
        });
        pair.push(result);
        const filename = `${String(sequence).padStart(3, "0")}_${item.name}_${variant}_attempt${number}.json`;
        fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
        fs.appendFileSync(path.join(directory, "results.jsonl"), `${JSON.stringify(result)}\n`);
        process.stdout.write(`${JSON.stringify({
          case: item.name,
          variant,
          attempt: number,
          status: result.response.status,
          rows: result.response.returned_rows,
          request_id: result.response.diagnostic_request_id,
          error: result.response.error,
        })}\n`);
      }
      const hashes = pair.map((result) => result.response.rows_sha256);
      const comparison = {
        schema_version: 1,
        case: item.name,
        attempt: number,
        comparable: hashes.every(Boolean),
        rows_sha256_equal: hashes.every(Boolean) ? hashes[0] === hashes[1] : null,
        physical_1024_rows_sha256: hashes[0],
        physical_leaf_1024_rows_sha256: hashes[1],
      };
      fs.appendFileSync(path.join(directory, "comparisons.jsonl"), `${JSON.stringify(comparison)}\n`);
      if (comparison.comparable && !comparison.rows_sha256_equal) {
        throw new Error(`rows SHA-256 mismatch for ${item.name} attempt ${number}`);
      }
    }
  }
  process.stdout.write(`results=${directory}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
