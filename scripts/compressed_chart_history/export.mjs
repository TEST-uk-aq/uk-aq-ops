#!/usr/bin/env node
// Manual read-only exploratory export. Never called by managed JSONgen.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { extractGeneration, daysBetween } from "./extract.mjs";
import { sha256, requireCondition as check } from "./source_reader.mjs";
import { canonicalJson, loadPilotConfig, calculationIdentity, parsePairs } from "./configuration.mjs";
import { buildCalculatedHistory } from "../../workers/uk_aq_station_history/src/calculated_history.mjs";
import { publicContinuity } from "../../workers/uk_aq_station_history/src/continuity.mjs";
import { pilotIdentity, sampleInterval, pilotMonths, COMPRESSED_CHART_LIMITS } from "../../workers/shared/uk_aq_compressed_chart_pilot.mjs";
export { canonicalJson } from "./configuration.mjs";
const HOUR = 3_600_000, DAY = 86_400_000;
const HELP = "Manual exploratory v3 export (GET only): --config /private/experiment.json --sample-id CONFIGURED-ID --output-dir /private/new-directory. Source/status/resources are explicit configuration; no verified authority, upload, fallback or scheduling.";
const resolvedDay = day => ["exported", "authoritative_absence"].includes(day.state);
function physicalRows(result) {
  return [...result.contextRows, ...result.rows].map(row => ({ connector_id: result.binding.connector_id,
    station_id: row[2], timeseries_id: row[5], pollutant_code: result.binding.pollutant_code,
    observed_at: row[0], value: row[1], source_status: row[3], verification_status: row[4], source: "json" }));
}
export async function calculateMonthAqi(result, month, options) {
  const allRows = physicalRows(result), rows = [], batches = [], gaps = [], reasons = new Set();
  const request = { connectorId: options.connectorId, stationId: options.sample.station_id, timeseriesId: options.timeseriesId,
    pollutant: options.pollutant, includeObservations: false, includeAqi: true };
  const coverage = [...result.contextDays, ...result.days];
  for (const day of daysBetween(month.start_utc, month.end_exclusive_utc)) {
    check(performance.now() < options.deadline, "Offline processing time budget exceeded");
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const first = Math.ceil(Math.max(dayStart, Date.parse(month.start_utc)) / HOUR) * HOUR;
    const last = Math.floor((Math.min(dayStart + DAY, Date.parse(month.end_exclusive_utc)) - 1) / HOUR) * HOUR;
    check(first <= last, "Empty/unrepresentable hour-ending batch");
    const calculated = await buildCalculatedHistory({ request, continuity: result.continuity,
      outputStartMs: first - HOUR, outputEndMs: last,
      observationProvider: async ({ identity, startMs, endMs }) => {
        const neededDays = daysBetween(new Date(startMs).toISOString(), new Date(endMs).toISOString());
        const complete = startMs >= Date.parse(options.contextStart) && endMs <= Date.parse(options.end)
          && neededDays.every(required => coverage.some(entry => entry.day_utc === required
            && entry.timeseries_id === identity.timeseriesId && resolvedDay(entry)));
        return { rows: allRows.filter(row => row.timeseries_id === identity.timeseriesId
          && Date.parse(row.observed_at) >= startMs && Date.parse(row.observed_at) < endMs),
        response_complete: complete, partial_reasons: complete ? [] : ["required_canonical_context_unresolved"],
        context_complete: complete, fetch_count: 0 };
      } });
    rows.push(...calculated.aqi.rows);
    gaps.push(...calculated.aqi.gap_ranges);
    calculated.aqi.partial_reasons.forEach(reason => reasons.add(reason));
    batches.push({ day_utc: day, endpoint_start_utc: new Date(first).toISOString(), endpoint_end_utc: new Date(last).toISOString(),
      context_complete: !calculated.aqi.partial_reasons.includes("required_aqi_context_incomplete")
        && !calculated.aqi.partial_reasons.includes("required_canonical_context_unresolved"),
      response_complete: calculated.aqi.response_complete, has_gap: calculated.aqi.has_gap,
      gap_ranges: calculated.aqi.gap_ranges, partial_reasons: calculated.aqi.partial_reasons, row_count: calculated.aqi.rows.length,
      required_context_start_utc: calculated.aqi.required_context_start_utc });
  }
  check(new Set(rows.map(row => row.timestamp_hour_utc)).size === rows.length, "Overlapping daily AQI endpoints");
  return { rows, batches, context_complete: batches.every(batch => batch.context_complete),
    response_complete: batches.every(batch => batch.response_complete), has_gap: batches.some(batch => batch.has_gap),
    gap_ranges: gaps, partial_reasons: [...reasons].sort() };
}
async function prepareFiles(result, options) {
  const objects = [], started = performance.now(), cpuStarted = process.cpuUsage();
  if (result.state === "failed") return objects;
  const common = { publication_id: options.publicationId, config_sha256: options.configSha,
    source_mode: options.config.source_mode, environment: options.config.environment, managed_publication_eligible: false,
    algorithm: options.algorithm };
  const evidence = { schema_version: 2, kind: "uk_aq_chart_history_source_evidence", ...common,
    source_generation: result.generation, bucket: result.bucket, sample_id: options.sample.id,
    requested_interval: sampleInterval(options.sample), binding: result.binding, physical_bindings: result.physical_bindings,
    continuity: publicContinuity(result.continuity), verification: result.verification,
    physical_schemas: result.metrics.physical_schemas, source_objects: result.source_objects,
    days: result.days, context_days: result.contextDays, required_context_start_utc: options.contextStart,
    snapshot_claim: "source_as_read_with_metadata_rechecks_not_coherent_writer_checkpoint" };
  const evidenceBytes = canonicalJson(evidence), evidencePath = `source-evidence.${sha256(evidenceBytes)}.json`;
  check(evidenceBytes.length <= COMPRESSED_CHART_LIMITS.evidence_bytes, "Evidence size bound");
  await options.write(evidencePath, evidenceBytes);
  result.evidence = { path: evidencePath, sha256: sha256(evidenceBytes), byte_size: evidenceBytes.length };
  const source = { generation: result.generation, bucket: result.bucket, source_evidence: result.evidence,
    physical_schemas: result.metrics.physical_schemas, verification: result.verification };
  for (const month of pilotMonths(options.sample)) {
    check(performance.now() < options.deadline, "Offline processing time budget exceeded");
    const rows = result.rows.filter(row => row[0] >= month.start_utc && row[0] < month.end_exclusive_utc);
    const days = result.days.filter(day => day.day_utc.startsWith(month.month_utc));
    const complete = days.length > 0 && days.every(resolvedDay);
    const calculationStarted = performance.now();
    const calculated = await calculateMonthAqi(result, month, options);
    options.aqiWallMs += performance.now() - calculationStarted;
    const coverage = { month_utc: month.month_utc, requested_start_utc: month.start_utc,
      requested_end_exclusive_utc: month.end_exclusive_utc, complete, days, row_count: rows.length,
      unique_timestamp_count: new Set(rows.map(row => row[0])).size,
      min_observed_at_utc: rows[0]?.[0] || null, max_observed_at_utc: rows.at(-1)?.[0] || null };
    const observations = { schema_version: 2, kind: "uk_aq_compressed_chart_history_month", ...common,
      identity: pilotIdentity(options.sample), source, continuity: publicContinuity(result.continuity), coverage,
      row_columns: ["observed_at_utc", "value", "station_id", "source_status", "verification_status", "timeseries_id", "embedded_verification_status", "source_status_provenance"], observations: rows };
    const aqi = { schema_version: 2, kind: "uk_aq_compressed_chart_aqi_month", ...common,
      identity: pilotIdentity(options.sample), source, continuity: publicContinuity(result.continuity),
      coverage: { ...coverage, row_count: calculated.rows.length, daily_batches: calculated.batches,
        context_complete: calculated.context_complete, response_complete: calculated.response_complete },
      aqi: { enabled: true, calculation_source: "calculated_from_observations", publication_source: "precomputed_compressed_json",
        response_contract: "aqi_hour_interval_v2", algorithm_version: options.algorithm.version,
        rows: calculated.rows, response_complete: calculated.response_complete, has_gap: calculated.has_gap,
        gap_ranges: calculated.gap_ranges, partial_reasons: calculated.partial_reasons,
        required_context_start_utc: calculated.batches[0]?.required_context_start_utc,
        output_start_utc: new Date(Date.parse(calculated.rows[0].timestamp_hour_utc) - HOUR).toISOString(),
        output_end_utc: calculated.rows.at(-1).timestamp_hour_utc,
        source_counts: { calculated_from_observations: calculated.rows.length } } };
    const pair = { ...month, source_complete: complete, context_complete: calculated.context_complete,
      publication_id: options.publicationId, source_evidence_sha256: result.evidence.sha256 };
    for (const [part, payload] of Object.entries({ observations, aqi })) {
      const raw = canonicalJson(payload), gzip = gzipSync(raw, { level: 9 });
      check(raw.length <= COMPRESSED_CHART_LIMITS.json_bytes && gzip.length <= COMPRESSED_CHART_LIMITS.gzip_bytes
        && gunzipSync(gzip, { maxOutputLength: COMPRESSED_CHART_LIMITS.json_bytes }).equals(raw), "Payload size/gzip integrity bound");
      const prefix = `month_utc=${month.month_utc}/${part}.${sha256(gzip)}`;
      await options.write(`${prefix}.json`, raw);
      await options.write(`${prefix}.json.gz`, gzip);
      check(sha256(await fs.readFile(path.join(options.output, `${prefix}.json.gz`))) === sha256(gzip), "Local gzip readback mismatch");
      pair[part] = { path: `${prefix}.json.gz`, json_path: `${prefix}.json`, sha256: sha256(gzip), json_sha256: sha256(raw),
        byte_size: gzip.length, json_byte_size: raw.length, row_count: part === "observations" ? rows.length : calculated.rows.length,
        ...(part === "aqi" ? { response_complete: calculated.response_complete } : {}) };
    }
    objects.push(pair);
  }
  const cpu = process.cpuUsage(cpuStarted);
  Object.assign(result.metrics, { prepare_wall_ms: performance.now() - started, prepare_cpu_ms: (cpu.user + cpu.system) / 1000,
    aqi_wall_ms: options.aqiWallMs, output_pairs: objects.length, output_bytes: options.outputBytes });
  return objects;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(HELP); return; }
  const values = parsePairs(args, ["config", "sample-id", "output-dir"]);
  check(values.config && values["sample-id"] && path.isAbsolute(values["output-dir"] || ""), HELP);
  const selected = await loadPilotConfig(values.config, values["sample-id"]);
  const { config, sample } = selected;
  const interval = sampleInterval(sample), started = performance.now(), cpuStarted = process.cpuUsage();
  const output = path.resolve(values["output-dir"]), parent = await fs.realpath(path.dirname(output));
  const workspace = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
  check(parent !== workspace && !parent.startsWith(`${workspace}${path.sep}`), "Private output must be outside repository workspace");
  check(path.join(parent, path.basename(output)) === output, "Output path must have a real parent");
  const options = { ...selected, connectorId: sample.connector_id, timeseriesId: sample.timeseries_id, pollutant: sample.pollutant_code,
    start: interval.start_utc, end: interval.end_exclusive_utc,
    contextStart: new Date(Date.parse(interval.start_utc) - (sample.pollutant_code === "no2" ? HOUR : 24 * HOUR)).toISOString(),
    maxBytes: COMPRESSED_CHART_LIMITS.source_bytes, output, outputBytes: 0, aqiWallMs: 0,
    publicationId: randomUUID(), algorithm: await calculationIdentity(), deadline: started + COMPRESSED_CHART_LIMITS.duration_ms };
  await fs.mkdir(output, { mode: 0o700 });
  options.write = async (relative, bytes) => {
    options.outputBytes += bytes.length;
    check(options.outputBytes <= 192 * 1024 ** 2, "Private output byte budget exceeded");
    const target = path.join(output, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  };
  const result = await extractGeneration(config.canonical_generation, options);
  const objects = await prepareFiles(result, options);
  const complete = result.state === "complete" && objects.length === pilotMonths(sample).length
    && objects.every(pair => pair.source_complete && pair.context_complete && pair.aqi.response_complete);
  const candidate = { schema_version: 3, kind: "uk_aq_chart_history_candidate_manifest", publication_state: "local_only_not_published",
    environment: config.environment, config_sha256: selected.configSha, sample_id: sample.id, source_mode: config.source_mode,
    source_generation: config.canonical_generation, managed_publication_eligible: false, publication_id: options.publicationId,
    identity: pilotIdentity(sample), requested_interval: interval, algorithm: options.algorithm, complete,
    source_evidence: result.evidence || null, pairs: objects };
  const bytes = canonicalJson(candidate), candidatePath = `candidate-manifest.${sha256(bytes)}.json`;
  await options.write(candidatePath, bytes); // local manifest last; incomplete output never claims eligibility
  const cpu = process.cpuUsage(cpuStarted);
  const report = { schema_version: 3, state: complete ? "local_candidates_complete" : "incomplete", source_mode: config.source_mode,
    managed_publication_eligible: false, sample_id: sample.id, config_sha256: selected.configSha, publication_id: options.publicationId,
    algorithm: options.algorithm, requested_interval: interval, context_start_utc: options.contextStart,
    runtime: { node: process.version, zlib: process.versions.zlib, gzip_level: 9 }, r2_write_operations: 0,
    wall_ms: performance.now() - started, process_cpu_ms: (cpu.user + cpu.system) / 1000, max_rss_kib: process.resourceUsage().maxRSS,
    output_bytes_before_report: options.outputBytes, metrics: result.metrics, error: result.error || null,
    candidate: { path: candidatePath, byte_size: bytes.length, sha256: sha256(bytes) },
    payloads: objects.map(pair => ({ month_utc: pair.month_utc, observations: pair.observations, aqi: pair.aqi })) };
  await options.write("comparison.json", canonicalJson(report));
  console.log(`Exploratory ${sample.id}: ${report.state}; candidate ${candidatePath}; private comparison.json; no remote writes`);
  if (!complete) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Export stopped: ${error.message}`); process.exitCode = 1; });
}
