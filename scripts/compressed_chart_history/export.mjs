#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { extractGeneration } from "./extract.mjs";
import { sha256, requireCondition as check } from "./source_reader.mjs";
import { buildCalculatedHistory } from "../../workers/uk_aq_station_history/src/calculated_history.mjs";
import { AQI_ALGORITHM_VERSION } from "../../lib/aqi/aqi_levels.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;

const HELP = `Bounded offline TEST AURN observation and precomputed AQI export (GET only).
Usage, from TEST ops with its existing .env:
  node --env-file=.env scripts/compressed_chart_history/export.mjs \\
    --connector-id 1 --timeseries-id 212 --pollutant pm25 \\
    --start-utc 2026-09-01T00:00:00Z --end-utc 2026-10-01T00:00:00Z \\
    --generations v3,v2 --output-dir /absolute/outside/workspace/new-directory

Required: all options above. End is exclusive; maximum 93 UTC days.
Optional: --max-source-mib 128 (default; integer 1..512 per generation).
Only AURN connector 1 is admitted; WAQN/SAQN are excluded.
Existing UK_AQ_ENV_NAME=TEST and CFLARE_R2_* credentials are used privately.
Output directory must be new and outside the multi-repository workspace.
Reads the preceding UTC day as PM context when available; unresolved context is marked incomplete.
No publication, source changes, runtime routing changes or retries.
`;
export function canonicalJson(value) {
  const canonical = (entry) => Array.isArray(entry) ? entry.map(canonical) : entry && typeof entry === "object" ? Object.fromEntries(Object.keys(entry).sort().filter((key) => entry[key] !== undefined).map((key) => [key, canonical(entry[key])])) : entry;
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`);
}
function parseOptions(args) {
  const allowed = ["connector-id", "timeseries-id", "pollutant", "start-utc", "end-utc", "generations", "output-dir", "max-source-mib"];
  const supplied = {};
  check(args.length % 2 === 0, "Every option requires a value; use --help");
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    check(args[i] === `--${key}` && allowed.includes(key) && supplied[key] === undefined, "Unknown or repeated option; use --help");
    supplied[key] = args[i + 1];
  }
  check(supplied["connector-id"] === "1", "Only explicitly selected AURN connector 1 is supported");
  const timeseriesId = Number(supplied["timeseries-id"]);
  check(/^[1-9][0-9]*$/.test(supplied["timeseries-id"] || "") && Number.isSafeInteger(timeseriesId), "Positive timeseries ID required");
  check(["pm25", "pm10", "no2"].includes(supplied.pollutant), "Select pm25, pm10 or no2");
  function utc(value) {
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value || ""), "Explicit UTC timestamp required");
    const date = new Date(value);
    check(!Number.isNaN(date.getTime()) && date.toISOString() === value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z"), "Invalid UTC timestamp");
    return date.toISOString();
  }
  const start = utc(supplied["start-utc"]), end = utc(supplied["end-utc"]);
  check(start < end && Math.ceil(Date.parse(end) / 86_400_000) - Math.floor(Date.parse(start) / 86_400_000) <= 93, "Select at most 93 UTC days, with exclusive end after start");
  const generations = (supplied.generations || "").split(",");
  check(generations.length <= 2 && new Set(generations).size === generations.length && generations.every((v) => ["v2", "v3"].includes(v)), "Select v3 and/or v2 explicitly");
  const mib = Number(supplied["max-source-mib"] || 128);
  check(Number.isSafeInteger(mib) && mib >= 1 && mib <= 512, "Source budget must be 1..512 MiB per generation");
  check(path.isAbsolute(supplied["output-dir"] || ""), "Absolute output directory required");
  return { timeseriesId, pollutant: supplied.pollutant, start, end, generations, maxBytes: mib * 1024 ** 2, output: path.resolve(supplied["output-dir"]) };
}
function aqiInputRows(result) {
  return [...result.contextRows, ...result.rows].map((row) => ({
    connector_id: 1, station_id: row[2], timeseries_id: result.binding.timeseries_id,
    pollutant_code: result.binding.pollutant_code, observed_at: row[0], value: row[1],
    source_status: row[3], verification_status: row[4], source: "json",
  }));
}
export async function calculateMonthAqi(result, month, options) {
  const allRows = aqiInputRows(result);
  const continuity = { enabled: false, continuityKey: null, siteRef: null, ukAirRef: null,
    pollutant: options.pollutant, members: [{ connectorId: 1, stationId: result.binding.station_id,
      timeseriesId: options.timeseriesId, pollutant: options.pollutant,
      validFromDayUtc: null, validToDayUtc: null }] };
  const request = { connectorId: 1, stationId: result.binding.station_id,
    timeseriesId: options.timeseriesId, pollutant: options.pollutant,
    includeObservations: false, includeAqi: true };
  const batches = [], rows = [], gapRanges = [], reasons = new Set(), seen = new Set();
  for (let dayMs = Date.parse(month.requested_start_utc); dayMs < Date.parse(month.requested_end_exclusive_utc); dayMs += DAY) {
    const endExclusive = Math.min(dayMs + DAY, Date.parse(month.requested_end_exclusive_utc));
    const outputStartMs = dayMs - HOUR, outputEndMs = endExclusive - HOUR;
    const inputStart = outputStartMs - (options.pollutant === "no2" ? 0 : 23 * HOUR);
    const inputEnd = outputEndMs + 1;
    const scoped = allRows.filter((row) => { const t = Date.parse(row.observed_at); return t >= inputStart && t < inputEnd; });
    const requiredDays = [...result.contextDays, ...result.days].filter((day) => {
      const t = Date.parse(`${day.day_utc}T00:00:00.000Z`);
      return t < inputEnd && t + DAY > inputStart;
    });
    const expectedDayCount = Math.ceil(inputEnd / DAY) - Math.floor(inputStart / DAY);
    const contextComplete = requiredDays.length === expectedDayCount
      && requiredDays.every((day) => ["exported", "authoritative_absence"].includes(day.state))
      && inputStart >= Date.parse(options.contextStart);
    const calculated = await buildCalculatedHistory({ request, continuity, outputStartMs, outputEndMs,
      observationProvider: async () => ({ rows: scoped, response_complete: result.state === "complete",
        partial_reasons: [], fetch_count: 0, context_complete: contextComplete }) });
    for (const row of calculated.aqi.rows) {
      check(!seen.has(row.timestamp_hour_utc), "Overlapping daily AQI output");
      seen.add(row.timestamp_hour_utc);
      rows.push(row);
    }
    gapRanges.push(...calculated.aqi.gap_ranges);
    calculated.aqi.partial_reasons.forEach((reason) => reasons.add(reason));
    batches.push({ day_utc: new Date(dayMs).toISOString().slice(0, 10),
      output_start_utc: new Date(dayMs).toISOString(), output_end_exclusive_utc: new Date(endExclusive).toISOString(),
      required_context_start_utc: new Date(inputStart).toISOString(), context_complete: contextComplete,
      response_complete: calculated.aqi.response_complete, has_gap: calculated.aqi.has_gap,
      partial_reasons: calculated.aqi.partial_reasons, row_count: calculated.aqi.rows.length });
  }
  rows.sort((a, b) => a.timestamp_hour_utc.localeCompare(b.timestamp_hour_utc));
  const complete = batches.every((batch) => batch.response_complete);
  return { schema_version: 2, kind: "uk_aq_compressed_chart_aqi_month",
    identity: { connector_id: 1, timeseries_id: options.timeseriesId,
      station_id: result.binding.station_id, pollutant_code: options.pollutant },
    source: { generation: result.generation, bucket: result.bucket,
      source_evidence: result.evidence, algorithm_version: AQI_ALGORITHM_VERSION },
    coverage: { ...month, response_complete: complete, daily_batches: batches,
      context_days: result.contextDays, row_count: rows.length },
    aqi: { enabled: true, calculation_source: "calculated_from_observations",
      publication_source: "precomputed_compressed_json", response_contract: "aqi_hour_interval_v2",
      algorithm_version: AQI_ALGORITHM_VERSION, rows, response_complete: complete,
      has_gap: batches.some((batch) => batch.has_gap), gap_ranges: gapRanges,
      partial_reasons: [...reasons].sort(), required_context_start_utc: batches[0]?.required_context_start_utc,
      output_start_utc: month.requested_start_utc,
      output_end_utc: new Date(Date.parse(month.requested_end_exclusive_utc) - HOUR).toISOString(),
      source_counts: { calculated_from_observations: rows.length } } };
}
function monthsBetween(start, end) {
  const months = [];
  const date = new Date(start);
  date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0);
  while (date.toISOString() < end) {
    const monthStart = date.toISOString();
    date.setUTCMonth(date.getUTCMonth() + 1);
    months.push({ month_utc: monthStart.slice(0, 7), month_start_utc: monthStart, month_end_exclusive_utc: date.toISOString(), requested_start_utc: start > monthStart ? start : monthStart, requested_end_exclusive_utc: end < date.toISOString() ? end : date.toISOString() });
  }
  return months;
}
async function writeNew(root, relative, body) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, { flag: "wx", mode: 0o600 });
  return target;
}
function compareSources(results) {
  const v2 = results.find((r) => r.generation === "v2"), v3 = results.find((r) => r.generation === "v3");
  if (!v2 || !v3 || [v2, v3].some((r) => r.state !== "complete")) return { state: "not_comparable", reason: "Two complete independently extracted source scopes required" };
  function multiset(rows, columns) {
    const map = new Map();
    for (const row of rows) {
      const key = JSON.stringify(columns.map((i) => row[i]));
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }
  function differences(columns) {
    const left = multiset(v2.rows, columns), right = multiset(v3.rows, columns);
    let onlyV2 = 0, onlyV3 = 0;
    const examples = [];
    for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const delta = (left.get(key) || 0) - (right.get(key) || 0);
      if (delta > 0) onlyV2 += delta;
      if (delta < 0) onlyV3 -= delta;
      if (delta && examples.length < 8) examples.push({ row: JSON.parse(key), v2_multiplicity: left.get(key) || 0, v3_multiplicity: right.get(key) || 0 });
    }
    return { equal: onlyV2 === 0 && onlyV3 === 0, only_v2_rows: onlyV2, only_v3_rows: onlyV3, examples };
  }
  return { state: "compared", measurements: differences([0, 1, 2]), embedded_status: differences([0, 1, 2, 3]), effective_status: differences([0, 1, 2, 4]), full_rows: differences([0, 1, 2, 3, 4]) };
}
async function prepareFiles(result, options) {
  const started = performance.now(), cpuStarted = process.cpuUsage();
  const objects = [];
  if (result.state === "failed") return objects;
  const evidence = { schema_version: 1, kind: "uk_aq_chart_history_source_evidence", source_generation: result.generation, bucket: result.bucket, binding: result.binding, verification: result.verification, source_objects: result.source_objects, context_days: result.contextDays };
  const evidenceBody = canonicalJson(evidence);
  const evidenceSha = sha256(evidenceBody);
  const evidencePath = `${result.generation}/source-evidence.${evidenceSha}.json`;
  await writeNew(options.output, evidencePath, evidenceBody);
  result.evidence = { path: evidencePath, sha256: evidenceSha, byte_size: evidenceBody.length };
  for (const month of monthsBetween(options.start, options.end)) {
    const rows = result.rows.filter(([timestamp]) => timestamp >= month.requested_start_utc && timestamp < month.requested_end_exclusive_utc);
    const days = result.days.filter((day) => day.day_utc.startsWith(month.month_utc));
    const complete = days.every((day) => ["exported", "authoritative_absence"].includes(day.state));
    const uniqueTimes = new Set(rows.map(([timestamp]) => timestamp));
    const payload = {
      schema_version: 1, kind: "uk_aq_compressed_chart_history_month",
      identity: { connector_id: 1, timeseries_id: options.timeseriesId, station_id: result.binding.station_id, pollutant_code: options.pollutant },
      source: { generation: result.generation, bucket: result.bucket, source_evidence: result.evidence, physical_schemas: result.metrics.physical_schemas, verification: result.verification },
      coverage: { ...month, state: complete ? rows.length ? "exported" : "authoritative_absence" : "incomplete", complete, row_count: rows.length, unique_timestamp_count: uniqueTimes.size, duplicate_timestamp_row_count: rows.length - uniqueTimes.size, min_observed_at_utc: rows[0]?.[0] || null, max_observed_at_utc: rows.at(-1)?.[0] || null, days },
      row_columns: ["observed_at_utc", "value", "station_id", "source_status", "verification_status"],
      observations: rows,
    };
    const json = canonicalJson(payload), compressed = gzipSync(json, { level: 9 });
    check(gunzipSync(compressed).equals(json), "Local gzip round-trip failed");
    const rawSha = sha256(json), compressedSha = sha256(compressed);
    const prefix = `${result.generation}/connector_id=1/timeseries_id=${options.timeseriesId}/month_utc=${month.month_utc}`;
    const jsonPath = `${prefix}/${rawSha}.json`, gzipPath = `${prefix}/${rawSha}.json.gz`;
    await writeNew(options.output, jsonPath, json);
    await writeNew(options.output, gzipPath, compressed);
    // Read written bytes back before proposing any manifest references.
    check(sha256(await fs.readFile(path.join(options.output, gzipPath))) === compressedSha && sha256(await fs.readFile(path.join(options.output, jsonPath))) === rawSha, "Local file verification failed");
    objects.push({ ...month, state: payload.coverage.state, row_count: rows.length, json_path: jsonPath, path: gzipPath, json_byte_size: json.length, byte_size: compressed.length, json_sha256: rawSha, sha256: compressedSha, content_type: "application/json", content_encoding: "gzip", source_evidence: result.evidence, publication_eligible: complete });
    if (complete) {
      const aqi = await calculateMonthAqi(result, month, options);
      const aqiJson = canonicalJson(aqi), aqiGzip = gzipSync(aqiJson, { level: 9 });
      check(gunzipSync(aqiGzip).equals(aqiJson), "AQI gzip round-trip failed");
      const aqiSha = sha256(aqiJson), aqiGzipSha = sha256(aqiGzip);
      const aqiJsonPath = `${prefix}/aqi.${aqiSha}.json`, aqiGzipPath = `${prefix}/aqi.${aqiSha}.json.gz`;
      await writeNew(options.output, aqiJsonPath, aqiJson);
      await writeNew(options.output, aqiGzipPath, aqiGzip);
      check(sha256(await fs.readFile(path.join(options.output, aqiGzipPath))) === aqiGzipSha,
        "Local AQI file verification failed");
      objects.at(-1).aqi = { path: aqiGzipPath, json_path: aqiJsonPath,
        byte_size: aqiGzip.length, json_byte_size: aqiJson.length,
        sha256: aqiGzipSha, json_sha256: aqiSha, row_count: aqi.aqi.rows.length,
        response_complete: aqi.aqi.response_complete, algorithm_version: AQI_ALGORITHM_VERSION,
        source_evidence: result.evidence };
    }
  }
  const cpu = process.cpuUsage(cpuStarted);
  Object.assign(result.metrics, { output_object_count: objects.length, json_bytes: objects.reduce((sum, o) => sum + o.json_byte_size, 0), gzip_bytes: objects.reduce((sum, o) => sum + o.byte_size, 0), source_evidence_bytes: evidenceBody.length, encoding_and_local_write_wall_ms: performance.now() - started, encoding_and_local_write_cpu_ms: (cpu.user + cpu.system) / 1000 });
  return objects;
}
function markdownReport(report) {
  const lines = ["# Stage 2A local TEST comparison", "", `Captured: ${report.captured_at_utc}. Physical AURN connector 1, timeseries ${report.selection.timeseriesId}, pollutant ${report.selection.pollutant}.`, `UTC interval: [${report.selection.start}, ${report.selection.end}).`, "", "| Generation | State | Rows | Source objects / Parquet | GETs | Source body bytes | Parquet bytes | JSON bytes | gzip bytes | Extract wall ms | Extract CPU ms | Encode/write ms |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|", ...report.sources.map((r) => { const m = r.metrics; return `| ${r.generation} | ${r.state} | ${m.row_count} | ${m.source_object_count} / ${m.source_parquet_object_count} | ${m.get_requests} | ${m.source_bytes_read} | ${m.parquet_bytes_read} | ${m.json_bytes ?? 0} | ${m.gzip_bytes ?? 0} | ${m.extraction_wall_ms.toFixed(1)} | ${m.extraction_cpu_ms.toFixed(1)} | ${(m.encoding_and_local_write_wall_ms ?? 0).toFixed(1)} |`; }), "", `Comparison: ${JSON.stringify(report.comparison)}.`, "", "Downloaded Parquet files include other AURN timeseries. Their full size is read volume, not the storage attributable to this one series. V3 additionally reports the indexed timestamp/value chunk bytes; these exclude identity/status columns, footer and shared metadata. V2 has no exact chunk attribution here. No proportional storage estimate is made.", "", "Source metadata was re-read and unchanged at the end of each successful extraction. This detects changes; it does not establish a writer freeze or a simultaneous v2/v3 snapshot. Comparisons concern these pinned scopes only. Missing authority is unknown/unexported, not canonical absence. Row multiplicity and status differences are retained.", "", "Sizes exclude source-evidence and manifest overhead; those sizes are separately recorded. Only gzip objects are proposed for later delivery; local raw JSON is diagnostic output. R2 writes: 0. GET counts include metadata revalidation and 404s; source bytes count consumed success body bytes, excluding HTTP/TLS overhead. No retries, LIST or HEAD calls. Network wall time is local R2 export time, not HTTP chart delivery speed or Worker CPU.", "", "Stage 2B: use only a complete approved sample; privately publish digest-named gzip objects and evidence after verification, then select them with a publish-last manifest. Keep the normal chart route unchanged and inject history through the existing controller/renderer/AQI boundary. Measure real TEST cold/warm delivery and chart milestones plus Cloudflare CPU/outcomes after explicit deployment approval. This offline run supplies no browser/Worker performance result.", ""];
  for (const source of report.sources) if (source.error) lines.push(`${source.generation} failure: ${source.error}`, "");
  return lines.join("\n");
}
async function main() {
  if (process.argv.slice(2).includes("--help")) { console.log(HELP); return; }
  const started = performance.now(), cpuStarted = process.cpuUsage();
  const options = parseOptions(process.argv.slice(2));
  options.contextStart = new Date(Date.parse(options.start) - 24 * HOUR).toISOString();
  const workspace = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
  let existingParent = path.dirname(options.output);
  const missingParts = [];
  for (;;) {
    try {
      const resolved = await fs.realpath(existingParent);
      existingParent = path.join(resolved, ...missingParts.reverse());
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existingParent);
      if (parent === existingParent) throw error;
      missingParts.push(path.basename(existingParent));
      existingParent = parent;
    }
  }
  const outputParent = existingParent;
  check(outputParent !== workspace && !outputParent.startsWith(`${workspace}${path.sep}`), "Output must be outside repository workspace");
  await fs.mkdir(outputParent, { recursive: true });
  options.output = path.join(outputParent, path.basename(options.output));
  await fs.mkdir(options.output, { mode: 0o700 }); // refuses reuse/overwrite
  const results = [], objects = [];
  for (const version of options.generations) {
    console.log(`Reading bounded TEST ${version}: physical timeseries ${options.timeseriesId}`);
    const result = await extractGeneration(version, options);
    objects.push(...await prepareFiles(result, options));
    results.push(result);
    console.log(`${version}: ${result.state}, ${result.metrics.row_count} rows, ${result.metrics.source_bytes_read} source bytes`);
  }
  const comparison = compareSources(results);
  const manifest = { schema_version: 2, kind: "uk_aq_chart_history_candidate_manifest", publication_state: "local_only_not_published", export_schema_version: 2, environment: "TEST", requested_interval: { start_utc: options.start, end_exclusive_utc: options.end }, identity: { connector_id: 1, timeseries_id: options.timeseriesId, pollutant_code: options.pollutant }, complete: results.every((r) => r.state === "complete"), sources: results.map((r) => ({ generation: r.generation, state: r.state, binding: r.binding || null, source_evidence: r.evidence || null, days: r.days, context_days: r.contextDays, error: r.error || null })), objects, publication_rule: "Verify paired observation/AQI gzip and evidence objects before publishing a new complete manifest; retain prior complete selection on failure." };
  const manifestBody = canonicalJson(manifest);
  const manifestPath = `candidate-manifest.${sha256(manifestBody)}.json`;
  // Manifest last, only after referenced local outputs pass checks. State never
  // claims remote publication or completeness for a failed/unexported period.
  await writeNew(options.output, manifestPath, manifestBody);
  const cpu = process.cpuUsage(cpuStarted);
  const report = { schema_version: 2, captured_at_utc: new Date().toISOString(), selection: { timeseriesId: options.timeseriesId, pollutant: options.pollutant, start: options.start, end: options.end }, runtime: { node: process.version, zlib: process.versions.zlib, gzip_level: 9 }, r2_write_operations: 0, manifest: { path: manifestPath, sha256: sha256(manifestBody), byte_size: manifestBody.length }, export_wall_ms: performance.now() - started, export_cpu_ms: (cpu.user + cpu.system) / 1000, sources: results.map(({ rows: _rows, contextRows: _contextRows, ...r }) => r), comparison };
  await writeNew(options.output, "comparison.json", canonicalJson(report));
  await writeNew(options.output, "comparison.md", markdownReport(report));
  console.log(`Local comparison: ${path.join(options.output, "comparison.md")}`);
  if (results.some((r) => r.state !== "complete")) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Export stopped: ${error.message}`); process.exitCode = 1; });
}
