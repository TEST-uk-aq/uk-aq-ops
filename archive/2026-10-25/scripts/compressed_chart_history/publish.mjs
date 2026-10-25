#!/usr/bin/env node
// Manual TEST-only derived publication. No canonical-history key is ever written.
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { r2GetObject, r2PutObject } from "../../workers/shared/r2_sigv4.mjs";
import { canonicalJson } from "./export.mjs";
import { sha256, requireCondition as check } from "./source_reader.mjs";
import {
  COMPRESSED_CHART_ROOT as ROOT,
  COMPRESSED_CHART_SELECTOR_KEY as SELECTOR_KEY,
  COMPRESSED_CHART_SAMPLES as SAMPLES,
  COMPRESSED_CHART_SHA256 as DIGEST,
  COMPRESSED_CHART_AQI_ALGORITHM as AQI_ALGORITHM,
  validateCompressedChartSelector,
  validateCompressedChartPublication,
} from "../../workers/shared/uk_aq_compressed_chart_pilot.mjs";

function localPath(root, relative) {
  check(typeof relative === "string" && !path.isAbsolute(relative)
    && relative.split("/").every((part) => part && part !== "." && part !== ".."), "Invalid local artifact path");
  const candidate = path.resolve(root, relative);
  check(candidate.startsWith(`${root}${path.sep}`), "Artifact leaves selected export directory");
  return candidate;
}
function same(value, expected, label) { check(value === expected, `${label} mismatch`); }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value); }
function validateDays(days, interval, count) {
  check(Array.isArray(days) && days.length >= 1 && days.length <= 31, "Unexpected exported day count");
  const startDay = interval.start.slice(0, 10), endMs = Date.parse(interval.end);
  let cursor = Date.parse(`${startDay}T00:00:00.000Z`), total = 0;
  for (const day of days) {
    same(day.day_utc, new Date(cursor).toISOString().slice(0, 10), "UTC day spine");
    check(["exported", "authoritative_absence"].includes(day.state)
      && Number.isSafeInteger(day.row_count) && day.row_count >= 0, "Unresolved or invalid day");
    total += day.row_count;
    cursor += 86_400_000;
  }
  check(cursor >= endMs && cursor - 86_400_000 < endMs && total === count, "Day coverage/count mismatch");
}
function validateMonthlyJson(payload, selected, object, sample) {
  same(payload.schema_version, 1, "JSON schema");
  same(payload.kind, "uk_aq_compressed_chart_history_month", "JSON kind");
  const identity = payload.identity;
  check(safeObject(identity), "Missing physical identity");
  same(identity.connector_id, 1, "JSON connector");
  same(identity.timeseries_id, 212, "JSON timeseries");
  same(identity.station_id, 248, "JSON station");
  same(identity.pollutant_code, "pm25", "JSON pollutant");
  same(payload.source?.generation, sample.generation, "JSON generation");
  same(payload.source?.bucket, "uk-aq-history-cic-test", "Canonical TEST source bucket");
  same(payload.source?.source_evidence?.sha256, selected.source_evidence.sha256, "JSON source evidence");
  const coverage = payload.coverage;
  check(safeObject(coverage) && coverage.complete === true, "Incomplete JSON coverage");
  same(coverage.state, "exported", "JSON coverage state");
  same(coverage.requested_start_utc, sample.start, "JSON start");
  same(coverage.requested_end_exclusive_utc, sample.end, "JSON end");
  same(coverage.month_utc, "2026-09", "JSON month");
  same(coverage.row_count, object.row_count, "JSON row count");
  check(Array.isArray(payload.observations) && payload.observations.length === object.row_count
    && JSON.stringify(payload.row_columns) === JSON.stringify(["observed_at_utc", "value", "station_id", "source_status", "verification_status"]), "JSON observation shape invalid");
  validateDays(coverage.days, sample, object.row_count);
  let previous = "";
  for (const row of payload.observations) {
    check(Array.isArray(row) && row.length === 5 && typeof row[0] === "string"
      && new Date(row[0]).toISOString() === row[0] && row[0] >= sample.start && row[0] < sample.end
      && row[0] >= previous && typeof row[1] === "number" && Number.isFinite(row[1])
      && (row[2] === null || row[2] === 248) && (row[3] === null || typeof row[3] === "string")
      && [null, "P", "R"].includes(row[4]), "JSON observation identity/value invalid");
    previous = row[0];
  }
}
export async function preparePublication({ candidatePath, sampleId }) {
  const sample = Object.hasOwn(SAMPLES, sampleId) ? SAMPLES[sampleId] : null;
  check(sample, "Sample is not in the approved AURN pilot allowlist");
  const root = path.dirname(path.resolve(candidatePath));
  check((await fs.realpath(root)) === root, "Export root must be a real directory");
  const candidateBytes = await fs.readFile(candidatePath);
  check(candidateBytes.length <= 64 * 1024 && new RegExp(`^candidate-manifest\\.${sha256(candidateBytes)}\\.json$`).test(path.basename(candidatePath)), "Candidate digest/path invalid");
  const candidate = JSON.parse(candidateBytes);
  check([1, 2].includes(candidate.schema_version) && candidate.kind === "uk_aq_chart_history_candidate_manifest"
    && candidate.publication_state === "local_only_not_published" && candidate.complete === true
    && candidate.environment === "TEST" && candidate.export_schema_version === candidate.schema_version, "Candidate is not complete local TEST export");
  same(candidate.identity?.connector_id, 1, "Candidate connector");
  same(candidate.identity?.timeseries_id, 212, "Candidate timeseries");
  same(candidate.identity?.pollutant_code, "pm25", "Candidate pollutant");
  same(candidate.requested_interval?.start_utc, sample.start, "Candidate start");
  same(candidate.requested_interval?.end_exclusive_utc, sample.end, "Candidate end");
  const sources = candidate.sources.filter((source) => source.generation === sample.generation);
  check(sources.length === 1 && sources[0].state === "complete" && sources[0].binding?.station_id === 248
    && sources[0].binding?.connector_id === 1 && sources[0].binding?.timeseries_id === 212
    && sources[0].binding?.pollutant_code === "pm25", "Selected source identity/completeness invalid");
  const source = sources[0];
  const objects = candidate.objects.filter((object) => object.path?.startsWith(`${sample.generation}/`));
  check(objects.length === 1 && objects[0].publication_eligible === true && objects[0].state === "exported", "One eligible monthly gzip object required");
  const object = objects[0];
  check(DIGEST.test(object.sha256) && DIGEST.test(object.json_sha256)
    && object.content_type === "application/json" && object.content_encoding === "gzip"
    && object.month_utc === "2026-09" && object.row_count > 0, "Gzip descriptor invalid");
  same(object.requested_start_utc, sample.start, "Object start");
  same(object.requested_end_exclusive_utc, sample.end, "Object end");
  same(object.source_evidence?.sha256, source.source_evidence?.sha256, "Source evidence descriptor");
  const gzip = await fs.readFile(localPath(root, object.path));
  const raw = await fs.readFile(localPath(root, object.json_path));
  const evidence = await fs.readFile(localPath(root, source.source_evidence.path));
  check(gzip.length === object.byte_size && gzip.length <= 2 * 1024 * 1024 && sha256(gzip) === object.sha256
    && raw.length === object.json_byte_size && sha256(raw) === object.json_sha256
    && evidence.length === source.source_evidence.byte_size && sha256(evidence) === source.source_evidence.sha256
    && gunzipSync(gzip).equals(raw), "Local artifact bytes/digests invalid");
  const evidenceJson = JSON.parse(evidence);
  same(evidenceJson.kind, "uk_aq_chart_history_source_evidence", "Evidence kind");
  same(evidenceJson.source_generation, sample.generation, "Evidence generation");
  same(evidenceJson.binding?.timeseries_id, 212, "Evidence timeseries");
  same(evidenceJson.bucket, "uk-aq-history-cic-test", "Evidence source bucket");
  check(Array.isArray(evidenceJson.source_objects), "Source object pins missing");
  const month = JSON.parse(raw);
  validateMonthlyJson(month, source, object, sample);
  check(canonicalJson(month).equals(raw), "Monthly JSON is not canonical UTF-8 encoding");
  validateDays(source.days, sample, object.row_count);
  const gzipKey = `${ROOT}/objects/connector_id=1/timeseries_id=212/generation=${sample.generation}/month_utc=2026-09/${object.sha256}.json.gz`;
  const evidenceKey = `${ROOT}/evidence/${source.source_evidence.sha256}.json`;
  let aqiObject = null, aqiUpload = null;
  if (candidate.schema_version === 2) {
    const descriptor = object.aqi;
    check(safeObject(descriptor) && DIGEST.test(descriptor.sha256) && DIGEST.test(descriptor.json_sha256)
      && descriptor.algorithm_version === AQI_ALGORITHM
      && descriptor.source_evidence?.sha256 === source.source_evidence.sha256
      && typeof descriptor.response_complete === "boolean", "Paired AQI descriptor invalid");
    const aqiGzip = await fs.readFile(localPath(root, descriptor.path));
    const aqiRaw = await fs.readFile(localPath(root, descriptor.json_path));
    check(aqiGzip.length === descriptor.byte_size && aqiGzip.length <= 2 * 1024 * 1024
      && sha256(aqiGzip) === descriptor.sha256 && aqiRaw.length === descriptor.json_byte_size
      && sha256(aqiRaw) === descriptor.json_sha256 && gunzipSync(aqiGzip).equals(aqiRaw),
    "Paired AQI bytes/digests invalid");
    const aqi = JSON.parse(aqiRaw);
    check(canonicalJson(aqi).equals(aqiRaw) && aqi.schema_version === 2
      && aqi.kind === "uk_aq_compressed_chart_aqi_month"
      && JSON.stringify(aqi.identity) === JSON.stringify(month.identity)
      && aqi.source?.generation === sample.generation
      && aqi.source?.bucket === month.source.bucket
      && aqi.source?.source_evidence?.sha256 === source.source_evidence.sha256
      && aqi.source?.algorithm_version === AQI_ALGORITHM
      && aqi.coverage?.requested_start_utc === sample.start
      && aqi.coverage?.requested_end_exclusive_utc === sample.end
      && aqi.coverage?.response_complete === descriptor.response_complete
      && JSON.stringify(aqi.coverage?.context_days) === JSON.stringify(evidenceJson.context_days || [])
      && JSON.stringify(source.context_days || []) === JSON.stringify(evidenceJson.context_days || [])
      && aqi.aqi?.algorithm_version === AQI_ALGORITHM
      && aqi.aqi?.calculation_source === "calculated_from_observations"
      && aqi.aqi?.publication_source === "precomputed_compressed_json"
      && aqi.aqi?.response_complete === descriptor.response_complete
      && Array.isArray(aqi.aqi?.rows) && aqi.aqi.rows.length === descriptor.row_count
      && Array.isArray(aqi.coverage?.daily_batches)
      && aqi.coverage.daily_batches.length === month.coverage.days.length
      && aqi.coverage.daily_batches.every((batch, index) => batch.day_utc === month.coverage.days[index].day_utc
        && batch.output_start_utc === new Date(Date.parse(sample.start) + index * 86_400_000).toISOString()
        && batch.output_end_exclusive_utc === new Date(Math.min(Date.parse(sample.start) + (index + 1) * 86_400_000, Date.parse(sample.end))).toISOString()
        && typeof batch.context_complete === "boolean" && typeof batch.response_complete === "boolean"
        && (!batch.response_complete || (batch.context_complete && batch.has_gap === false
          && Array.isArray(batch.partial_reasons) && batch.partial_reasons.length === 0))
        && Number.isSafeInteger(batch.row_count) && batch.row_count >= 0)
      && aqi.coverage.daily_batches.reduce((sum, batch) => sum + batch.row_count, 0) === descriptor.row_count
      && aqi.coverage.daily_batches.every((batch) => batch.response_complete) === descriptor.response_complete
      && (!descriptor.response_complete || (aqi.aqi.has_gap === false
        && Array.isArray(aqi.aqi.partial_reasons) && aqi.aqi.partial_reasons.length === 0)),
    "Paired AQI source, identity or completeness invalid");
    let previousHour = "";
    for (const row of aqi.aqi.rows) {
      check(row && row.connector_id === 1 && row.station_id === 248 && row.timeseries_id === 212
        && row.pollutant_code === "pm25" && row.timestamp_hour_utc > previousHour
        && row.timestamp_hour_utc >= sample.start && row.timestamp_hour_utc < sample.end
        && row.period_end_utc === row.timestamp_hour_utc
        && Date.parse(row.period_start_utc) === Date.parse(row.timestamp_hour_utc) - 3_600_000
        && typeof row.daqi_calculation_status === "string"
        && typeof row.eaqi_calculation_status === "string", "Paired AQI row invalid");
      previousHour = row.timestamp_hour_utc;
    }
    for (const batch of aqi.coverage.daily_batches) {
      const batchRows = aqi.aqi.rows.filter((row) => row.timestamp_hour_utc >= batch.output_start_utc
        && row.timestamp_hour_utc < batch.output_end_exclusive_utc);
      check(batchRows.length === batch.row_count && (!batch.response_complete ||
        (batchRows.length === (Date.parse(batch.output_end_exclusive_utc) - Date.parse(batch.output_start_utc)) / 3_600_000
          && batchRows.every((row) => row.daqi_calculation_status === "ok"
            && row.eaqi_calculation_status === "ok"))), "Paired AQI daily completeness contradiction");
    }
    const aqiKey = `${ROOT}/objects/connector_id=1/timeseries_id=212/generation=${sample.generation}/month_utc=2026-09/aqi.${descriptor.sha256}.json.gz`;
    aqiObject = { key: aqiKey, byte_size: aqiGzip.length, sha256: descriptor.sha256,
      json_sha256: descriptor.json_sha256, row_count: descriptor.row_count,
      algorithm_version: AQI_ALGORITHM, source_evidence_sha256: source.source_evidence.sha256,
      month_utc: "2026-09", requested_start_utc: sample.start,
      requested_end_exclusive_utc: sample.end, response_complete: descriptor.response_complete };
    aqiUpload = { key: aqiKey, body: aqiGzip, sha256: descriptor.sha256, contentType: "application/gzip" };
  }
  const publication = {
    schema_version: candidate.schema_version, kind: "uk_aq_compressed_chart_publication",
    publication_state: "published_complete", sample_id: sampleId,
    identity: { connector_id: 1, timeseries_id: 212, station_id: 248, pollutant_code: "pm25" },
    source_generation: sample.generation,
    requested_interval: { start_utc: sample.start, end_exclusive_utc: sample.end },
    candidate_sha256: sha256(candidateBytes),
    evidence: { key: evidenceKey, byte_size: evidence.length, sha256: sha256(evidence) },
    objects: [{ key: gzipKey, byte_size: gzip.length, sha256: sha256(gzip),
      json_sha256: sha256(raw), row_count: object.row_count,
      month_utc: "2026-09", requested_start_utc: sample.start,
      requested_end_exclusive_utc: sample.end, coverage_days: month.coverage.days }],
    ...(aqiObject ? { algorithm_version: AQI_ALGORITHM, aqi_object: aqiObject } : {}),
  };
  check(validateCompressedChartPublication(publication, sampleId), "Prepared publication shape invalid");
  const manifestBytes = canonicalJson(publication);
  const manifestKey = `${ROOT}/manifests/${sha256(manifestBytes)}.json`;
  return { sampleId, sample, publication, manifestBytes, manifestKey,
    upload: [{ key: gzipKey, body: gzip, sha256: sha256(gzip), contentType: "application/gzip" },
      ...(aqiUpload ? [aqiUpload] : []),
      { key: evidenceKey, body: evidence, sha256: sha256(evidence), contentType: "application/json" },
      { key: manifestKey, body: manifestBytes, sha256: sha256(manifestBytes), contentType: "application/json" }] };
}
function parseArgs(argv) {
  if (argv.includes("--help")) return { help: true };
  const publish = argv.includes("--publish");
  const args = argv.filter((value) => value !== "--publish");
  check(args.length % 2 === 0, "Options require values");
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    check(args[i] === `--${key}` && ["candidate", "sample-id", "derived-bucket"].includes(key)
      && values[key] === undefined, "Unknown or repeated option");
    values[key] = args[i + 1];
  }
  check(values.candidate && Object.hasOwn(SAMPLES, values["sample-id"]), "Explicit candidate and approved sample ID required");
  if (publish) check(values["derived-bucket"], "Explicit derived bucket required for publication");
  return { publish, candidatePath: values.candidate, sampleId: values["sample-id"], bucket: values["derived-bucket"] || null };
}
async function getOptional(r2, key) {
  try { return await r2GetObject({ r2, key, max_attempts: 1 }); }
  catch (error) {
    if (error?.status === 404) return null;
    throw new Error(`Derived bucket read failed: ${key}`);
  }
}
async function verifiedObject(r2, key, expectedSha256, expectedSize) {
  const existing = await getOptional(r2, key);
  if (!existing) return false;
  check(existing.bytes === expectedSize && sha256(existing.body) === expectedSha256, `Published object identity conflict: ${key}`);
  return true;
}
async function publishPrepared(prepared, bucket) {
  check(process.env.UK_AQ_ENV_NAME === "TEST", "TEST environment required");
  check(bucket === "uk-aq-chart-history-json-test", "Only the approved Sleepercar TEST derived bucket is permitted");
  const endpoint = process.env.UK_AQ_COMPRESSED_CHART_R2_ENDPOINT;
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { throw new Error("Dedicated derived R2 endpoint required"); }
  check(endpointUrl.protocol === "https:" && /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(endpointUrl.hostname)
    && endpointUrl.pathname === "/" && !endpointUrl.search && !endpointUrl.hash
    && !endpointUrl.username && !endpointUrl.password, "Dedicated derived R2 endpoint must be an account S3 HTTPS origin");
  // TEST-only: the derived bucket is in Sleepercar, not the ukaq.co.uk proxy account.
  const sleepercarTestAccountId = "41a81f781d3bd7234fde0b25df51e879";
  check(endpointUrl.hostname === `${sleepercarTestAccountId}.r2.cloudflarestorage.com`,
    "Derived R2 endpoint must belong to the Sleepercar TEST Cloudflare account");
  const r2 = { endpoint: endpointUrl.origin, region: "auto", bucket,
    access_key_id: process.env.UK_AQ_COMPRESSED_CHART_R2_ACCESS_KEY_ID,
    secret_access_key: process.env.UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY };
  check(r2.access_key_id && r2.secret_access_key, "Dedicated derived-bucket R2 credentials required");
  // Canonical and derived buckets may share the Sleepercar account endpoint.
  // Require separate credentials; the account and derived bucket are pinned above.
  const canonicalAccessKeyId = process.env.CFLARE_R2_ACCESS_KEY_ID;
  check(!canonicalAccessKeyId || r2.access_key_id !== canonicalAccessKeyId,
    "Derived publication must not reuse canonical history access key");
  const prior = await getOptional(r2, SELECTOR_KEY);
  let previous = { schema_version: 1, kind: "uk_aq_compressed_chart_selector", publication_state: "published_complete", samples: {} };
  if (prior) {
    check(prior.bytes <= 16 * 1024, "Selector exceeds bounded size");
    previous = JSON.parse(prior.body);
    check(validateCompressedChartSelector(previous), "Previous selector invalid; left unchanged");
  }
  for (const item of prepared.upload) {
    if (await verifiedObject(r2, item.key, item.sha256, item.body.length)) continue;
    try {
      await r2PutObject({ r2, key: item.key, body: item.body,
        content_type: item.contentType, sha256: item.sha256 });
    } catch { throw new Error(`Derived object upload failed: ${item.key}`); }
    check(await verifiedObject(r2, item.key, item.sha256, item.body.length), `Derived object verification failed: ${item.key}`);
  }
  // A manual single-operator publication is required. Detect a changed selector
  // before replacing it; there is no automated source-writer or history lock.
  const current = await getOptional(r2, SELECTOR_KEY);
  check((current?.body && prior?.body ? sha256(current.body) === sha256(prior.body) : !current && !prior),
    "Selector changed during upload; prior publication preserved");
  const next = { ...previous, samples: { ...previous.samples, [prepared.sampleId]: {
    manifest_key: prepared.manifestKey,
    manifest_sha256: sha256(prepared.manifestBytes),
    source_generation: prepared.sample.generation,
    start_utc: prepared.sample.start,
    end_exclusive_utc: prepared.sample.end,
    connector_id: 1, timeseries_id: 212, station_id: 248, pollutant_code: "pm25",
  } } };
  const nextBytes = canonicalJson(next);
  if (prior?.body.equals(nextBytes)) return { changed: false, selector_sha256: sha256(nextBytes) };
  try { await r2PutObject({ r2, key: SELECTOR_KEY, body: nextBytes,
    content_type: "application/json", sha256: sha256(nextBytes) }); }
  catch { throw new Error("Selector write failed; inspect remote selector before retry"); }
  check(await verifiedObject(r2, SELECTOR_KEY, sha256(nextBytes), nextBytes.length),
    "Selector post-write verification failed; inspect current remote state");
  return { changed: true, selector_sha256: sha256(nextBytes) };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node --env-file=.env.compressed-chart-test scripts/compressed_chart_history/publish.mjs --candidate /absolute/candidate-manifest.<sha>.json --sample-id v3-september-2026|v3-2026-09-01|v2-2026-09-01 [--derived-bucket PRIVATE-TEST-BUCKET --publish]; publishing requires Sleepercar TEST R2 endpoint (account 41a81f781d3bd7234fde0b25df51e879) and dedicated UK_AQ_COMPRESSED_CHART_R2_ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY");
    return;
  }
  const prepared = await preparePublication(options);
  console.log(`Validated complete ${prepared.sampleId}: ${prepared.publication.objects[0].row_count} rows; gzip ${prepared.upload[0].body.length} bytes; publication manifest ${prepared.manifestKey}`);
  if (!options.publish) { console.log("Local preflight only; zero remote requests or writes."); return; }
  const outcome = await publishPrepared(prepared, options.bucket);
  console.log(`TEST derived selector ${outcome.changed ? "advanced" : "already current"}; SHA-256 ${outcome.selector_sha256}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Publication stopped: ${error.message}`); process.exitCode = 1; });
}
