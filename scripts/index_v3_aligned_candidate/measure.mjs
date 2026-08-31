#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CAPS = [1024, 2048, 4096];
const HOST = /-v3-aligned-candidate\.[a-z0-9-]*test[a-z0-9-]*\.workers\.dev$/i;

function dayEnd(day, hours) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + hours * 3600000).toISOString();
}

export function buildAlignedV2MeasurementMatrix() {
  const base = [
    { name: "aurn_ts218_24h", connector_id: 1, timeseries_id: 218, day: "2026-08-20", hours: 24 },
    ...[1, 6, 12, 24].map((hours) => ({
      name: `sensorcommunity_normal_ts7421_${hours}h`, connector_id: 7,
      timeseries_id: 7421, day: "2026-08-20", hours,
    })),
    ...[1, 6, 12, 24].map((hours) => ({
      name: `sensorcommunity_dense_ts7421_${hours}h`, connector_id: 7,
      timeseries_id: 7421, day: "2026-04-03", hours,
    })),
  ];
  return CAPS.flatMap((cap) => base.map((entry) => ({
    ...entry, aligned_row_cap: cap,
    start_utc: `${entry.day}T00:00:00.000Z`, end_utc: dayEnd(entry.day, entry.hours),
  })));
}

export function assertAlignedTestEndpoint(raw) {
  const url = new URL(String(raw || ""));
  if (url.protocol !== "https:" || !HOST.test(url.hostname)) {
    throw new Error("refusing endpoint; expected a *-v3-aligned-candidate.<TEST-account>.workers.dev host");
  }
  url.pathname = "/v1/observations"; url.search = ""; url.hash = "";
  return url;
}

function parse(argv) {
  const options = {
    endpoint: process.env.UK_AQ_V3_ALIGNED_CANDIDATE_URL || "", outputDir: "",
    repeat: 2, timeoutMs: 30000, dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index] || (() => { throw new Error(`${argument} requires a value`); })();
    if (argument === "--endpoint") options.endpoint = next();
    else if (argument === "--output-dir") options.outputDir = next();
    else if (argument === "--repeat") options.repeat = Number(next());
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("repeat and timeout-ms must be positive integers");
  }
  return options;
}

function requestUrl(endpoint, item) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries({
    connector_id: item.connector_id, pollutant: "pm25", timeseries_id: item.timeseries_id,
    start_utc: item.start_utc, end_utc: item.end_utc,
    aligned_row_cap: item.aligned_row_cap, diagnostics: "workload_v1",
  })) url.searchParams.set(key, String(value));
  return url;
}

function compact(item, attempt, response, payload, elapsedMs) {
  const diag = payload?.coverage?.exact_reader_diagnostics || payload?.diagnostics || null;
  return {
    schema_version: 1, measured_at_utc: new Date().toISOString(), case: item.name,
    aligned_row_cap: item.aligned_row_cap, attempt,
    request: { connector_id: item.connector_id, timeseries_id: item.timeseries_id, pollutant: "pm25", start_utc: item.start_utc, end_utc: item.end_utc },
    response: {
      status: response.status, ok: response.ok, returned_rows: payload?.row_count ?? null,
      response_complete: payload?.response_complete ?? null, error: payload?.error ?? null,
      diagnostic_request_id: response.headers.get("x-ukaq-diagnostic-request-id") || payload?.diagnostic_request?.request_id || null,
      cf_ray: response.headers.get("cf-ray"), client_wall_ms: Number(elapsedMs.toFixed(3)),
    },
    physical: diag ? {
      physical_layout_version: diag.physical_layout_version,
      physical_rows_decoded: diag.physical_rows_decoded,
      selected_aligned_segments: diag.selected_aligned_segments,
      selected_aligned_row_groups: diag.selected_aligned_row_groups,
      selected_aligned_files: diag.selected_aligned_files,
      projected_compressed_bytes: diag.workload?.projected_compressed_bytes_total ?? null,
      r2_requested_bytes: diag.r2_bytes_requested,
      footer_reads: diag.footer_reads,
      footer_cache_hits: diag.footer_cache_hits,
    } : null,
    cloudflare_cpu_time_ms: null,
    cloudflare_cpu_time_source: "correlate diagnostic_request_id or cf_ray in Cloudflare invocation logs",
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const matrix = buildAlignedV2MeasurementMatrix();
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ cases: matrix, repeat: options.repeat }, null, 2)}\n`);
    return;
  }
  const endpoint = assertAlignedTestEndpoint(options.endpoint);
  const secret = String(process.env.UK_AQ_EDGE_UPSTREAM_SECRET || "");
  if (!secret) throw new Error("UK_AQ_EDGE_UPSTREAM_SECRET is required");
  const stamp = new Date().toISOString();
  const directory = path.resolve(options.outputDir || path.join("tmp", "index_v3_aligned_measurements", stamp.replaceAll(/[-:]/g, "")));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify({ schema_version: 1, run_id: crypto.randomUUID(), started_at_utc: stamp, endpoint: endpoint.origin, repeat: options.repeat, cases: matrix.length }, null, 2)}\n`, { flag: "wx" });
  let sequence = 0;
  for (const item of matrix) {
    for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
      sequence += 1;
      const started = performance.now();
      const response = await fetch(requestUrl(endpoint, item), {
        headers: { "x-uk-aq-upstream-auth": secret }, signal: AbortSignal.timeout(options.timeoutMs),
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* platform errors may be text */ }
      const result = compact(item, attempt, response, payload, performance.now() - started);
      const name = `${String(sequence).padStart(3, "0")}_${item.name}_cap${item.aligned_row_cap}_attempt${attempt}.json`;
      fs.writeFileSync(path.join(directory, name), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
      fs.appendFileSync(path.join(directory, "results.jsonl"), `${JSON.stringify(result)}\n`);
      process.stdout.write(`${JSON.stringify({ case: item.name, cap: item.aligned_row_cap, attempt, status: response.status, rows: result.response.returned_rows, request_id: result.response.diagnostic_request_id })}\n`);
    }
  }
  process.stdout.write(`results=${directory}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
