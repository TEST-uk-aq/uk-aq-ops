#!/usr/bin/env node
// Manual paired publication in an isolated experimental namespace only.
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { r2GetObjectBounded, r2PutObjectConditional, isStrongR2Etag } from "../../workers/shared/r2_sigv4.mjs";
import { canonicalJson, readLocalBounded, loadPilotConfig, calculationIdentity, parsePairs } from "./configuration.mjs";
import { sha256, requireCondition as check } from "./source_reader.mjs";
import { validateTimeseriesBinding, selectContinuitySegments } from "../../workers/uk_aq_station_history/src/continuity.mjs";
import { canonicalText, canonicalUtc, pilotIdentity, sameIdentity, sampleInterval, pilotMonths,
  selectorKey, manifestKey, artifactKey, evidenceKey, validateCompressedChartPublication, validateCompressedChartSelector,
  COMPRESSED_CHART_SHA256 as DIGEST, COMPRESSED_CHART_LIMITS as LIMITS } from "../../workers/shared/uk_aq_compressed_chart_pilot.mjs";
const HOUR = 3_600_000;
function equal(value, expected, message) { check(canonicalText(value) === canonicalText(expected), message); }
async function localArtifact(root, relative, maxBytes) {
  check(typeof relative === "string" && !path.isAbsolute(relative) && relative.split("/").every(part => part && part !== "." && part !== ".."), "Invalid local artifact path");
  const target = await fs.realpath(path.resolve(root, relative));
  check(target.startsWith(`${root}${path.sep}`), "Artifact leaves selected real export directory");
  return readLocalBounded(target, maxBytes);
}
function validateCommon(payload, candidate, evidence, sample, config) {
  check(payload.publication_id === candidate.publication_id && payload.config_sha256 === candidate.config_sha256
    && payload.environment === config.environment && payload.source_mode === config.source_mode
    && payload.managed_publication_eligible === false && sameIdentity(payload.identity, pilotIdentity(sample)), "Payload publication/source identity mismatch");
  equal(payload.algorithm, candidate.algorithm, "Payload calculation identity mismatch");
  check(payload.source?.generation === config.canonical_generation && payload.source?.bucket === config.source_bucket
    && payload.source?.source_evidence?.sha256 === candidate.source_evidence.sha256, "Payload source evidence mismatch");
  equal(payload.source.verification, evidence.verification, "Payload status interpretation mismatch");
  equal(payload.source.physical_schemas, evidence.physical_schemas, "Payload physical schema identity mismatch");
  equal(payload.continuity, evidence.continuity, "Payload continuity mismatch");
}
function validateDays(coverage, evidence, month, count) {
  check(coverage?.complete === true && coverage.month_utc === month.month_utc
    && coverage.requested_start_utc === month.start_utc && coverage.requested_end_exclusive_utc === month.end_exclusive_utc
    && coverage.row_count === count && Array.isArray(coverage.days), "Monthly coverage mismatch");
  const expected = evidence.days.filter(day => day.day_utc.startsWith(month.month_utc));
  equal(coverage.days, expected, "Monthly source-day coverage mismatch");
  check(expected.length > 0 && expected.every(day => ["exported", "authoritative_absence"].includes(day.state)
    && Number.isSafeInteger(day.row_count) && day.row_count >= 0), "Unresolved day coverage");
}
function memberFor(continuity, timestamp) {
  const ms = Date.parse(timestamp), selected = selectContinuitySegments(continuity, ms, ms + 1);
  check(selected.gaps.length === 0 && selected.segments.length === 1, "Unresolved/overlapping physical identity");
  return selected.segments[0];
}
export async function preparePublication({ configPath, candidatePath, sampleId }) {
  const deadline = performance.now() + LIMITS.duration_ms;
  const selected = await loadPilotConfig(configPath, sampleId), { config, sample, configSha } = selected;
  const root = await fs.realpath(path.dirname(path.resolve(candidatePath)));
  const candidateBytes = await readLocalBounded(candidatePath, LIMITS.metadata_bytes), candidate = JSON.parse(candidateBytes);
  check(path.basename(candidatePath) === `candidate-manifest.${sha256(candidateBytes)}.json`, "Candidate filename digest mismatch");
  check(candidate.schema_version === 3 && candidate.kind === "uk_aq_chart_history_candidate_manifest" && candidate.complete === true
    && candidate.publication_state === "local_only_not_published" && candidate.managed_publication_eligible === false
    && candidate.sample_id === sampleId && candidate.environment === config.environment && candidate.config_sha256 === configSha
    && candidate.source_mode === config.source_mode && candidate.source_generation === config.canonical_generation
    && sameIdentity(candidate.identity, pilotIdentity(sample)), "Candidate is not the complete configured exploratory export");
  equal(candidate.requested_interval, sampleInterval(sample), "Candidate interval mismatch");
  equal(candidate.algorithm, await calculationIdentity(), "Candidate algorithm/parameters differ from current shared implementation");
  const evidenceBytes = await localArtifact(root, candidate.source_evidence?.path, LIMITS.evidence_bytes);
  check(evidenceBytes.length === candidate.source_evidence.byte_size && sha256(evidenceBytes) === candidate.source_evidence.sha256, "Evidence digest/length mismatch");
  const evidence = JSON.parse(evidenceBytes);
  check(evidence.schema_version === 2 && evidence.kind === "uk_aq_chart_history_source_evidence" && evidence.source_generation === config.canonical_generation
    && evidence.bucket === config.source_bucket && evidence.environment === config.environment && evidence.source_mode === config.source_mode
    && evidence.config_sha256 === configSha && evidence.sample_id === sample.id && evidence.publication_id === candidate.publication_id
    && evidence.managed_publication_eligible === false && evidence.verification?.mode === config.verification_mode
    && evidence.verification.legacy_status_mode === config.legacy_status_mode
    && evidence.verification.operator_authority_reference === config.status_authority_reference, "Source evidence admission mismatch");
  equal(evidence.algorithm, candidate.algorithm, "Evidence calculation mismatch");
  equal(evidence.requested_interval, sampleInterval(sample), "Evidence interval mismatch");
  check(Array.isArray(evidence.source_objects) && evidence.source_objects.length > 0 && evidence.source_objects.length <= 2048
    && evidence.source_objects.every(object => DIGEST.test(object.sha256 || "") && Number.isSafeInteger(object.byte_size) && object.byte_size > 0), "Missing bounded source pins");
  const { continuity, identity } = validateTimeseriesBinding(evidence.binding, { connectorId: sample.connector_id, timeseriesId: sample.timeseries_id, pollutant: sample.pollutant_code });
  check(identity.stationId === sample.station_id && Array.isArray(evidence.physical_bindings)
    && evidence.physical_bindings.length > 0 && evidence.physical_bindings.length <= LIMITS.members
    && new Set(evidence.physical_bindings.map(binding => binding.timeseries_id)).size === evidence.physical_bindings.length, "Source root binding mismatch");
  for (const binding of evidence.physical_bindings) {
    check(sample.permitted_timeseries_ids.includes(binding.timeseries_id), "Unconfigured physical evidence");
    const resolved = validateTimeseriesBinding(binding, { connectorId: sample.connector_id, timeseriesId: binding.timeseries_id, pollutant: sample.pollutant_code });
    equal(resolved.continuity, continuity, "Physical binding continuity conflict");
  }
  const interval = sampleInterval(sample), needed = selectContinuitySegments(continuity, Date.parse(evidence.required_context_start_utc), Date.parse(interval.end_exclusive_utc));
  check(canonicalUtc(evidence.required_context_start_utc) && needed.gaps.length === 0
    && needed.segments.every(member => sample.permitted_timeseries_ids.includes(member.timeseriesId)
      && evidence.physical_bindings.some(binding => binding.timeseries_id === member.timeseriesId)), "Incomplete physical/context authority");
  check(Array.isArray(evidence.days) && Array.isArray(evidence.context_days), "Missing source-day evidence");
  const resolvedDays = [...evidence.context_days, ...evidence.days];
  for (const segment of needed.segments) {
    for (let day = Math.floor(segment.startMs / 86_400_000) * 86_400_000; day < segment.endMs; day += 86_400_000) {
      check(resolvedDays.some(entry => entry.day_utc === new Date(day).toISOString().slice(0, 10)
        && entry.timeseries_id === segment.timeseriesId && ["exported", "authoritative_absence"].includes(entry.state)), "Unresolved required source day");
    }
  }
  const uploads = [], pairs = [], months = pilotMonths(sample);
  check(Array.isArray(candidate.pairs) && candidate.pairs.length === months.length, "Missing candidate monthly pairs");
  let totalReadBytes = evidenceBytes.length;
  for (let index = 0; index < months.length; index++) {
    check(performance.now() < deadline, "Local publication preflight time budget exceeded");
    const month = months[index], pair = candidate.pairs[index];
    check(pair.month_utc === month.month_utc && pair.start_utc === month.start_utc && pair.end_exclusive_utc === month.end_exclusive_utc
      && pair.publication_id === candidate.publication_id && pair.source_complete === true && pair.context_complete === true
      && pair.source_evidence_sha256 === candidate.source_evidence.sha256, "Candidate pair mismatch/incomplete");
    const preparedPair = { ...month, publication_id: candidate.publication_id, source_complete: true, context_complete: true,
      source_evidence_sha256: candidate.source_evidence.sha256 };
    for (const part of ["observations", "aqi"]) {
      const descriptor = pair[part];
      check(descriptor && DIGEST.test(descriptor.sha256 || "") && DIGEST.test(descriptor.json_sha256 || ""), "Invalid local payload descriptor");
      const gzip = await localArtifact(root, descriptor.path, LIMITS.gzip_bytes);
      const raw = await localArtifact(root, descriptor.json_path, LIMITS.json_bytes);
      totalReadBytes += gzip.length + raw.length;
      check(totalReadBytes <= 192 * 1024 ** 2 && gzip.length === descriptor.byte_size && raw.length === descriptor.json_byte_size
        && sha256(gzip) === descriptor.sha256 && sha256(raw) === descriptor.json_sha256
        && gunzipSync(gzip, { maxOutputLength: LIMITS.json_bytes }).equals(raw), "Local gzip/raw digest/size mismatch");
      const payload = JSON.parse(raw);
      check(canonicalJson(payload).equals(raw), "Noncanonical payload serialization");
      validateCommon(payload, candidate, evidence, sample, config);
      check(payload.schema_version === 2 && payload.kind === (part === "observations" ? "uk_aq_compressed_chart_history_month" : "uk_aq_compressed_chart_aqi_month"), "Payload schema/kind mismatch");
      validateDays(payload.coverage, evidence, month, descriptor.row_count);
      if (part === "observations") {
        equal(payload.row_columns, ["observed_at_utc", "value", "station_id", "source_status", "verification_status", "timeseries_id", "embedded_verification_status", "source_status_provenance"], "Observation tuple schema mismatch");
        check(Array.isArray(payload.observations) && payload.observations.length === descriptor.row_count
          && payload.coverage.days.reduce((sum, day) => sum + day.row_count, 0) === descriptor.row_count, "Observation source counts mismatch");
        let previous = "";
        for (const row of payload.observations) {
          check(Array.isArray(row) && row.length === 8 && canonicalUtc(row[0]) && row[0] >= month.start_utc && row[0] < month.end_exclusive_utc
            && row[0] >= previous && typeof row[1] === "number" && Number.isFinite(row[1])
            && (row[3] === null || typeof row[3] === "string") && [null, "P", "R"].includes(row[4])
            && [null, "P", "R"].includes(row[6]) && ["legacy_source_status_retained", "original_source_status_unavailable"].includes(row[7])
            && (row[7] !== "original_source_status_unavailable" || row[3] === null), "Observation fidelity/provenance invalid");
          const member = memberFor(continuity, row[0]);
          check(row[5] === member.timeseriesId && (row[2] === null || row[2] === member.stationId), "Observation date-valid physical identity mismatch");
          previous = row[0];
        }
      } else {
        check(payload.coverage.context_complete === true && payload.coverage.response_complete === true
          && descriptor.response_complete === true && payload.aqi?.response_complete === true
          && payload.aqi.algorithm_version === candidate.algorithm.version && payload.aqi.calculation_source === "calculated_from_observations"
          && payload.aqi.publication_source === "precomputed_compressed_json" && Array.isArray(payload.aqi.rows)
          && payload.aqi.rows.length === descriptor.row_count && Array.isArray(payload.coverage.daily_batches), "AQI source/context/shape incomplete");
        let endpoint = Math.ceil(Date.parse(month.start_utc) / HOUR) * HOUR;
        for (const row of payload.aqi.rows) {
          const member = memberFor(continuity, row.timestamp_hour_utc);
          check(row.timestamp_hour_utc === new Date(endpoint).toISOString() && endpoint < Date.parse(month.end_exclusive_utc)
            && row.period_end_utc === row.timestamp_hour_utc && Date.parse(row.period_start_utc) === endpoint - HOUR
            && row.connector_id === sample.connector_id && row.timeseries_id === member.timeseriesId && row.station_id === member.stationId
            && row.pollutant_code === sample.pollutant_code
            && ["ok", "missing_input", "insufficient_samples"].includes(row.daqi_calculation_status)
            && ["ok", "missing_input", "insufficient_samples"].includes(row.eaqi_calculation_status), "AQI endpoint/status/identity mismatch");
          endpoint += HOUR;
        }
        check(endpoint > Date.parse(month.end_exclusive_utc) - 1, "Missing terminal AQI endpoint");
        check(payload.coverage.daily_batches.every(batch => batch.context_complete === true && batch.response_complete === true)
          && payload.coverage.daily_batches.reduce((sum, batch) => sum + batch.row_count, 0) === descriptor.row_count, "AQI daily coverage mismatch");
      }
      const key = artifactKey(config, sample, month.month_utc, part, descriptor.sha256);
      preparedPair[part] = { key, byte_size: gzip.length, sha256: descriptor.sha256, json_byte_size: raw.length,
        json_sha256: descriptor.json_sha256, row_count: descriptor.row_count, ...(part === "aqi" ? { response_complete: true } : {}) };
      uploads.push({ key, body: gzip, sha256: descriptor.sha256, contentType: "application/gzip" });
    }
    pairs.push(preparedPair);
  }
  const evidenceObject = { key: evidenceKey(config, sha256(evidenceBytes)), sha256: sha256(evidenceBytes), byte_size: evidenceBytes.length };
  const publication = { schema_version: 3, kind: "uk_aq_compressed_chart_publication", publication_state: "published_complete",
    environment: config.environment, sample_id: sampleId, config_sha256: configSha, source_mode: config.source_mode,
    source_generation: config.canonical_generation, managed_publication_eligible: false, identity: pilotIdentity(sample),
    requested_interval: sampleInterval(sample), publication_id: candidate.publication_id, algorithm: candidate.algorithm,
    evidence: evidenceObject, continuity: evidence.continuity, pairs };
  check(validateCompressedChartPublication(publication, sampleId, config, configSha), "Prepared publication validation failed");
  const manifestBytes = canonicalJson(publication), publicationKey = manifestKey(config, sha256(manifestBytes));
  check(manifestBytes.length <= LIMITS.metadata_bytes, "Publication manifest size bound");
  uploads.push({ key: evidenceObject.key, body: evidenceBytes, sha256: evidenceObject.sha256, contentType: "application/json" },
    { key: publicationKey, body: manifestBytes, sha256: sha256(manifestBytes), contentType: "application/json" });
  return { ...selected, sampleId, publication, manifestBytes, manifestKey: publicationKey, upload: uploads };
}
export async function publishPrepared(prepared) {
  const { config, sampleId, configSha } = prepared;
  check(process.env.UK_AQ_ENV_NAME === config.environment, "Publication environment mismatch");
  const endpoint = new URL(process.env.UK_AQ_COMPRESSED_CHART_R2_ENDPOINT || "");
  check(endpoint.origin === config.derived_endpoint && endpoint.protocol === "https:" && /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)
    && endpoint.pathname === "/" && !endpoint.port && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password, "Explicit derived S3 HTTPS origin required");
  const r2 = { endpoint: endpoint.origin, region: "auto", bucket: config.derived_bucket,
    access_key_id: process.env.UK_AQ_COMPRESSED_CHART_R2_ACCESS_KEY_ID, secret_access_key: process.env.UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY };
  check(r2.access_key_id && r2.secret_access_key && r2.access_key_id !== process.env.CFLARE_R2_ACCESS_KEY_ID, "Separate derived-bucket credentials required");
  const deadline = performance.now() + LIMITS.duration_ms, metrics = { get_requests: 0, put_requests: 0, read_bytes: 0, write_bytes: 0 };
  const budget = () => check(performance.now() < deadline && metrics.get_requests + metrics.put_requests < 128, "Publication time/request budget exceeded");
  async function get(key, maxBytes) {
    budget(); metrics.get_requests++;
    try {
      const object = await r2GetObjectBounded({ r2, key, max_bytes: maxBytes, timeout_ms: Math.max(1, Math.min(30_000, Math.floor(deadline - performance.now()))), accept_encoding_identity: true });
      metrics.read_bytes += object.bytes;
      check(metrics.read_bytes <= 64 * 1024 ** 2, "Publication read byte budget exceeded");
      return object;
    } catch (error) { if (error?.status === 404) return null; throw error; }
  }
  async function put(key, body, digest, contentType, condition) {
    budget(); metrics.put_requests++; metrics.write_bytes += body.length;
    await r2PutObjectConditional({ r2, key, body, sha256: digest, content_type: contentType, ...condition });
  }
  const selectedKey = selectorKey(config), prior = await get(selectedKey, 16 * 1024);
  const previous = prior ? JSON.parse(prior.body) : { schema_version: 2, kind: "uk_aq_compressed_chart_selector",
    publication_state: "published_complete", environment: config.environment, config_sha256: configSha, samples: {} };
  check(validateCompressedChartSelector(previous, config, configSha), "Previous selector invalid; use a new isolated prefix for changed configuration");
  if (prior) check(isStrongR2Etag(prior.etag), "Strong stored selector ETag required");
  for (const item of prepared.upload) {
    let stored = await get(item.key, item.body.length);
    if (!stored) {
      await put(item.key, item.body, item.sha256, item.contentType, { if_none_match: "*" });
      stored = await get(item.key, item.body.length);
    }
    check(stored && stored.bytes === item.body.length && sha256(stored.body) === item.sha256, "Immutable remote readback mismatch; selection unchanged");
  }
  const next = { ...previous, samples: { ...previous.samples, [sampleId]: { manifest_key: prepared.manifestKey, manifest_sha256: sha256(prepared.manifestBytes) } } };
  check(validateCompressedChartSelector(next, config, configSha), "Invalid next selector");
  const bytes = canonicalJson(next);
  check(bytes.length <= 16 * 1024, "Selector byte bound");
  if (!prior?.body.equals(bytes)) await put(selectedKey, bytes, sha256(bytes), "application/json", prior ? { if_match: prior.etag } : { if_none_match: "*" });
  const readback = await get(selectedKey, 16 * 1024);
  check(readback?.body.equals(bytes), "Selection readback differs; inspect current state before retry");
  return { selector_sha256: sha256(bytes), metrics };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log("--config /private/experiment.json --sample-id CONFIGURED-ID --candidate /private/export/candidate-manifest.<sha256>.json [--publish]. Default: local preflight only. Explicit publish uses dedicated private derived credentials and conditional PUT/readback."); return; }
  const values = parsePairs(args, ["config", "sample-id", "candidate"], ["publish"]);
  check(values.config && values["sample-id"] && values.candidate, "Explicit config, sample-id and candidate required");
  const prepared = await preparePublication({ configPath: values.config, candidatePath: values.candidate, sampleId: values["sample-id"] });
  if (!values.publish) { console.log(`Validated ${prepared.sampleId}: ${prepared.publication.pairs.length} pairs. Local preflight only; zero remote requests.`); return; }
  console.log(JSON.stringify(await publishPrepared(prepared)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Publication stopped: ${error.message}`); process.exitCode = 1; });
}
