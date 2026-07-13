#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  hasRequiredR2Config,
  r2GetObject,
  r2ListAllObjects,
  r2PutObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";

const SUPPORTED_DOMAINS = new Set(["observations", "aqilevels"]);

const HISTORY_OBSERVATIONS_SCHEMA_NAME = "observations";
const HISTORY_OBSERVATIONS_SCHEMA_VERSION = 2;
const HISTORY_OBSERVATIONS_WRITER_VERSION = "parquet-wasm-zstd-v2";
const HISTORY_OBSERVATIONS_COLUMNS = Object.freeze([
  "connector_id",
  "timeseries_id",
  "observed_at",
  "value",
]);

const HISTORY_AQILEVELS_SCHEMA_NAME = "aqilevels_hourly";
const HISTORY_AQILEVELS_SCHEMA_VERSION = 1;
const HISTORY_AQILEVELS_WRITER_VERSION = "parquet-wasm-zstd-v1";
const HISTORY_AQILEVELS_GRAIN = "hourly";
const HISTORY_AQILEVELS_COLUMNS = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "timestamp_hour_utc",
  "daqi_input_value_ugm3",
  "daqi_input_averaging_code",
  "daqi_index_level",
  "daqi_source_observation_count",
  "daqi_required_observation_count",
  "daqi_calculation_status",
  "daqi_missing_reason",
  "eaqi_input_value_ugm3",
  "eaqi_input_averaging_code",
  "eaqi_index_level",
  "eaqi_source_observation_count",
  "eaqi_required_observation_count",
  "eaqi_calculation_status",
  "eaqi_missing_reason",
  "hourly_sample_count",
  "algorithm_version",
  "computed_at_utc",
  "hourly_mean_ugm3",
  "rolling24h_mean_ugm3",
  "no2_hourly_mean_ugm3",
  "pm25_hourly_mean_ugm3",
  "pm10_hourly_mean_ugm3",
  "pm25_rolling24h_mean_ugm3",
  "pm10_rolling24h_mean_ugm3",
  "daqi_no2_index_level",
  "daqi_pm25_rolling24h_index_level",
  "daqi_pm10_rolling24h_index_level",
  "eaqi_no2_index_level",
  "eaqi_pm25_index_level",
  "eaqi_pm10_index_level",
  "updated_at",
]);

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_rebuild_r2_day_manifest_from_connectors.mjs --day-utc YYYY-MM-DD [options]",
    "",
    "Purpose:",
    "  Rebuild one R2 history day manifest from the connector manifests already",
    "  present under that day. This is metadata-only: it does not read source DB",
    "  rows and does not read parquet payloads.",
    "",
    "Default mode:",
    "  Dry-run report only (no R2 writes).",
    "",
    "Options:",
    "  --domain observations|aqilevels   Domain to repair (default: observations)",
    "  --day-utc <YYYY-MM-DD>            Required day to rebuild",
    "  --connector-id <n>                Optional connector filter; repeatable",
    "  --max-keys <n>                    R2 list page size (default: index config)",
    "  --dry-run                         Explicit no-write mode (default)",
    "  --write-r2                        Write rebuilt day manifest to R2",
    "  -h, --help                        Show this help",
    "",
    "Follow-up after --write-r2:",
    "  Run scripts/backup_r2/uk_aq_build_r2_history_index.mjs --domain <domain>",
    "  without --target/--targets-csv so latest/index manifests pick up the",
    "  repaired day manifest.",
    "",
    "Required env for R2 reads/writes:",
    "  CFLARE_R2_ENDPOINT / R2_ENDPOINT",
    "  CFLARE_R2_REGION / R2_REGION",
    "  CFLARE_R2_ACCESS_KEY_ID / R2_ACCESS_KEY_ID",
    "  CFLARE_R2_SECRET_ACCESS_KEY / R2_SECRET_ACCESS_KEY",
    "  R2 bucket via CFLARE_R2_BUCKET / R2_BUCKET",
    "",
    "Optional env:",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX   default: history/v1/observations",
    "  UK_AQ_R2_HISTORY_AQILEVELS_PREFIX      default: history/v1/aqilevels/hourly",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    domain: "observations",
    dayUtc: "",
    connectorIds: [],
    maxKeys: undefined,
    mode: "dry-run",
    sawDryRun: false,
    sawWriteR2: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--domain") {
      args.domain = normalizeDomain(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--day-utc") {
      args.dayUtc = parseIsoDay(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--connector-id") {
      args.connectorIds.push(parseConnectorId(argv[i + 1], "--connector-id"));
      i += 1;
      continue;
    }
    if (arg === "--max-keys") {
      args.maxKeys = parsePositiveInt(argv[i + 1], "--max-keys");
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.mode = "dry-run";
      args.sawDryRun = true;
      continue;
    }
    if (arg === "--write-r2") {
      args.mode = "write-r2";
      args.sawWriteR2 = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (args.sawDryRun && args.sawWriteR2) {
    throw new Error("Use either --dry-run or --write-r2, not both");
  }
  if (!args.dayUtc) {
    throw new Error("--day-utc is required and must be YYYY-MM-DD");
  }
  args.connectorIds = Array.from(new Set(args.connectorIds)).sort((a, b) => a - b);
  return args;
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (!SUPPORTED_DOMAINS.has(domain)) {
    throw new Error("--domain must be observations or aqilevels");
  }
  return domain;
}

function parseIsoDay(value) {
  const day = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("day must be YYYY-MM-DD");
  }
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new Error("day must be a valid YYYY-MM-DD date");
  }
  return day;
}

function parseConnectorId(value, flagName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return Math.trunc(parsed);
}

function parsePositiveInt(value, flagName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return Math.trunc(parsed);
}

function toSafeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.trunc(parsed));
}

function averageNumber(total, count) {
  if (!count) {
    return null;
  }
  return total / count;
}

function statsFromFileEntries(fileEntries, totalRows) {
  if (!fileEntries.length) {
    return {
      bytes_per_row_estimate: totalRows > 0 ? null : 0,
      avg_file_bytes: 0,
      min_file_bytes: 0,
      max_file_bytes: 0,
    };
  }

  const bytes = fileEntries.map((entry) => Number(entry.bytes || 0));
  const totalBytes = bytes.reduce((sum, value) => sum + value, 0);
  let minBytes = bytes[0];
  let maxBytes = bytes[0];
  for (let i = 1; i < bytes.length; i += 1) {
    const value = bytes[i];
    if (value < minBytes) minBytes = value;
    if (value > maxBytes) maxBytes = value;
  }

  return {
    bytes_per_row_estimate: totalRows > 0 ? totalBytes / totalRows : null,
    avg_file_bytes: averageNumber(totalBytes, bytes.length),
    min_file_bytes: minBytes,
    max_file_bytes: maxBytes,
  };
}

function withManifestHash(payloadWithoutHash) {
  return {
    ...payloadWithoutHash,
    manifest_hash: sha256Hex(JSON.stringify(payloadWithoutHash)),
  };
}

function pickWriterGitSha(connectorManifests, existingDayManifest) {
  if (typeof existingDayManifest?.writer_git_sha === "string") {
    return existingDayManifest.writer_git_sha;
  }
  for (const manifest of connectorManifests) {
    if (typeof manifest.writer_git_sha === "string") {
      return manifest.writer_git_sha;
    }
  }
  return null;
}

function pickRunId(connectorManifests, existingDayManifest) {
  if (typeof existingDayManifest?.run_id === "string" && existingDayManifest.run_id.trim()) {
    return existingDayManifest.run_id;
  }
  const runIds = connectorManifests
    .map((manifest) => typeof manifest.run_id === "string" ? manifest.run_id.trim() : "")
    .filter(Boolean);
  const uniqueRunIds = Array.from(new Set(runIds));
  if (uniqueRunIds.length === 1) {
    return uniqueRunIds[0];
  }
  return "repair_from_connector_manifests";
}

function pickBackedUpAtUtc(connectorManifests, existingDayManifest) {
  const values = connectorManifests
    .map((manifest) => typeof manifest.backed_up_at_utc === "string" ? manifest.backed_up_at_utc : "")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (values.length > 0) {
    return values[values.length - 1];
  }
  if (typeof existingDayManifest?.backed_up_at_utc === "string") {
    return existingDayManifest.backed_up_at_utc;
  }
  return null;
}

function sortConnectorManifests(connectorManifests) {
  return [...connectorManifests].sort((left, right) => (
    Number(left.connector_id) - Number(right.connector_id)
  ));
}

export function buildObservationDayManifestFromConnectorManifests({
  dayUtc,
  connectorManifests,
  existingDayManifest = null,
}) {
  const sortedManifests = sortConnectorManifests(connectorManifests);
  const files = sortedManifests.flatMap((manifest) =>
    (Array.isArray(manifest.files) ? manifest.files : []).map((entry) => ({
      connector_id: manifest.connector_id,
      key: entry.key,
      bytes: entry.bytes,
      row_count: entry.row_count,
      etag_or_hash: entry.etag_or_hash,
      min_timeseries_id: entry.min_timeseries_id ?? null,
      max_timeseries_id: entry.max_timeseries_id ?? null,
      min_observed_at: entry.min_observed_at ?? null,
      max_observed_at: entry.max_observed_at ?? null,
    }))
  );
  const parquetObjectKeys = Array.from(new Set(files.map((entry) => entry.key)))
    .sort((a, b) => a.localeCompare(b));
  const totalRows = sortedManifests.reduce(
    (sum, manifest) => sum + toSafeInt(manifest.source_row_count),
    0,
  );
  const totalBytes = files.reduce((sum, file) => sum + toSafeInt(file.bytes), 0);
  const availablePollutants = Array.from(new Set(
    files.flatMap((file) => Array.isArray(file.pollutant_codes) ? file.pollutant_codes : []),
  )).sort((a, b) => a.localeCompare(b));
  const connectorIds = sortedManifests
    .map((manifest) => Number(manifest.connector_id))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);

  let minObservedAt = null;
  let maxObservedAt = null;
  for (const manifest of sortedManifests) {
    const minValue = typeof manifest.min_observed_at === "string" ? manifest.min_observed_at : null;
    const maxValue = typeof manifest.max_observed_at === "string" ? manifest.max_observed_at : null;
    if (minValue && (!minObservedAt || minValue < minObservedAt)) {
      minObservedAt = minValue;
    }
    if (maxValue && (!maxObservedAt || maxValue > maxObservedAt)) {
      maxObservedAt = maxValue;
    }
  }

  const stats = statsFromFileEntries(
    files.map((entry) => ({
      key: entry.key,
      row_count: toSafeInt(entry.row_count),
      bytes: toSafeInt(entry.bytes),
      etag_or_hash: typeof entry.etag_or_hash === "string" ? entry.etag_or_hash : null,
    })),
    totalRows,
  );

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: pickRunId(sortedManifests, existingDayManifest),
    source_row_count: totalRows,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    parquet_object_keys: parquetObjectKeys,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    connector_manifests: sortedManifests.map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      source_row_count: manifest.source_row_count,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
    })),
    history_schema_name: HISTORY_OBSERVATIONS_SCHEMA_NAME,
    history_schema_version: HISTORY_OBSERVATIONS_SCHEMA_VERSION,
    columns: HISTORY_OBSERVATIONS_COLUMNS,
    writer_version: HISTORY_OBSERVATIONS_WRITER_VERSION,
    writer_git_sha: pickWriterGitSha(sortedManifests, existingDayManifest),
    ...stats,
    backed_up_at_utc: pickBackedUpAtUtc(sortedManifests, existingDayManifest),
  });
}

export function buildAqilevelsDayManifestFromConnectorManifests({
  dayUtc,
  connectorManifests,
  existingDayManifest = null,
}) {
  const sortedManifests = sortConnectorManifests(connectorManifests);
  const files = sortedManifests.flatMap((manifest) =>
    (Array.isArray(manifest.files) ? manifest.files : []).map((entry) => ({
      connector_id: manifest.connector_id,
      key: entry.key,
      bytes: entry.bytes,
      row_count: entry.row_count,
      etag_or_hash: entry.etag_or_hash,
      pollutant_codes: Array.isArray(entry.pollutant_codes)
        ? entry.pollutant_codes
        : null,
      min_timeseries_id: entry.min_timeseries_id ?? null,
      max_timeseries_id: entry.max_timeseries_id ?? null,
      min_timestamp_hour_utc: entry.min_timestamp_hour_utc ?? null,
      max_timestamp_hour_utc: entry.max_timestamp_hour_utc ?? null,
    }))
  );
  const parquetObjectKeys = Array.from(new Set(files.map((entry) => entry.key)))
    .sort((a, b) => a.localeCompare(b));
  const totalRows = sortedManifests.reduce(
    (sum, manifest) => sum + toSafeInt(manifest.source_row_count),
    0,
  );
  const totalBytes = files.reduce((sum, file) => sum + toSafeInt(file.bytes), 0);
  const connectorIds = sortedManifests
    .map((manifest) => Number(manifest.connector_id))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);

  let minTimestampHourUtc = null;
  let maxTimestampHourUtc = null;
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  for (const manifest of sortedManifests) {
    const minValue = typeof manifest.min_timestamp_hour_utc === "string"
      ? manifest.min_timestamp_hour_utc
      : null;
    const maxValue = typeof manifest.max_timestamp_hour_utc === "string"
      ? manifest.max_timestamp_hour_utc
      : null;
    if (minValue && (!minTimestampHourUtc || minValue < minTimestampHourUtc)) {
      minTimestampHourUtc = minValue;
    }
    if (maxValue && (!maxTimestampHourUtc || maxValue > maxTimestampHourUtc)) {
      maxTimestampHourUtc = maxValue;
    }
    const manifestMinTimeseriesId = Number(manifest.min_timeseries_id);
    if (Number.isFinite(manifestMinTimeseriesId) && manifestMinTimeseriesId > 0) {
      const normalized = Math.trunc(manifestMinTimeseriesId);
      if (minTimeseriesId === null || normalized < minTimeseriesId) {
        minTimeseriesId = normalized;
      }
    }
    const manifestMaxTimeseriesId = Number(manifest.max_timeseries_id);
    if (Number.isFinite(manifestMaxTimeseriesId) && manifestMaxTimeseriesId > 0) {
      const normalized = Math.trunc(manifestMaxTimeseriesId);
      if (maxTimeseriesId === null || normalized > maxTimeseriesId) {
        maxTimeseriesId = normalized;
      }
    }
  }

  const stats = statsFromFileEntries(
    files.map((entry) => ({
      key: entry.key,
      row_count: toSafeInt(entry.row_count),
      bytes: toSafeInt(entry.bytes),
      etag_or_hash: typeof entry.etag_or_hash === "string" ? entry.etag_or_hash : null,
    })),
    totalRows,
  );
  const availablePollutants = Array.from(new Set(
    sortedManifests.flatMap((manifest) =>
      Array.isArray(manifest.available_pollutants)
        ? manifest.available_pollutants.map((pollutantCode) => String(pollutantCode || "").trim().toLowerCase()).filter(Boolean)
        : []
    ),
  )).sort();

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: pickRunId(sortedManifests, existingDayManifest),
    source_row_count: totalRows,
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    parquet_object_keys: parquetObjectKeys,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    connector_manifests: sortedManifests.map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      source_row_count: manifest.source_row_count,
      min_timeseries_id: manifest.min_timeseries_id ?? null,
      max_timeseries_id: manifest.max_timeseries_id ?? null,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      available_pollutants: Array.isArray(manifest.available_pollutants) ? manifest.available_pollutants : [],
    })),
    grain: HISTORY_AQILEVELS_GRAIN,
    history_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    history_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    columns: HISTORY_AQILEVELS_COLUMNS,
    writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
    writer_git_sha: pickWriterGitSha(sortedManifests, existingDayManifest),
    available_pollutants: availablePollutants,
    ...stats,
    backed_up_at_utc: pickBackedUpAtUtc(sortedManifests, existingDayManifest),
  });
}

export function buildDayManifestFromConnectorManifests({
  domain,
  dayUtc,
  connectorManifests,
  existingDayManifest = null,
}) {
  const normalizedDomain = normalizeDomain(domain);
  if (!Array.isArray(connectorManifests) || connectorManifests.length === 0) {
    throw new Error("At least one connector manifest is required");
  }
  if (normalizedDomain === "observations") {
    return buildObservationDayManifestFromConnectorManifests({
      dayUtc,
      connectorManifests,
      existingDayManifest,
    });
  }
  return buildAqilevelsDayManifestFromConnectorManifests({
    dayUtc,
    connectorManifests,
    existingDayManifest,
  });
}

function encodeJsonBody(payload) {
  return JSON.stringify(payload, null, 2);
}

function dayManifestKey(domainPrefix, dayUtc) {
  return `${domainPrefix}/day_utc=${dayUtc}/manifest.json`;
}

function connectorManifestKey(domainPrefix, dayUtc, connectorId) {
  return `${domainPrefix}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
}

function connectorIdFromManifestKey(key) {
  const match = String(key || "").match(/\/connector_id=(\d+)\/manifest\.json$/);
  return match ? Number(match[1]) : null;
}

function readJsonBuffer(result, label) {
  try {
    return JSON.parse(result.body.toString("utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${label}: ${message}`);
  }
}

function isR2NotFoundError(error) {
  const message = String(error instanceof Error ? error.message : error || "");
  return message.includes("R2 GET failed (404)");
}

async function getOptionalR2Json({ r2, key }) {
  try {
    const result = await r2GetObject({ r2, key });
    return {
      found: true,
      bytes: result.bytes,
      payload: readJsonBuffer(result, key),
    };
  } catch (error) {
    if (isR2NotFoundError(error)) {
      return { found: false, bytes: 0, payload: null };
    }
    throw error;
  }
}

async function listConnectorManifestKeys({ r2, domainPrefix, dayUtc, maxKeys, connectorIds }) {
  if (connectorIds.length > 0) {
    return connectorIds.map((connectorId) => connectorManifestKey(domainPrefix, dayUtc, connectorId));
  }
  const prefix = `${domainPrefix}/day_utc=${dayUtc}/connector_id=`;
  const entries = await r2ListAllObjects({ r2, prefix, max_keys: maxKeys });
  return entries
    .map((entry) => entry.key)
    .filter((key) => connectorIdFromManifestKey(key) !== null)
    .sort((a, b) => {
      const left = connectorIdFromManifestKey(a) ?? 0;
      const right = connectorIdFromManifestKey(b) ?? 0;
      return left - right;
    });
}

function summarizeConnectorIds(manifest) {
  if (Array.isArray(manifest?.connector_ids)) {
    return manifest.connector_ids
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value))
      .sort((a, b) => a - b);
  }
  if (Array.isArray(manifest?.connector_manifests)) {
    return manifest.connector_manifests
      .map((entry) => Number(entry.connector_id))
      .filter((value) => Number.isInteger(value))
      .sort((a, b) => a - b);
  }
  return [];
}

const TEST_R2_BUCKET = "uk-aq-history-cic-test";

function assertTestR2WriteTarget(r2) {
  const bucket = String(r2?.bucket || "").trim();
  if (bucket !== TEST_R2_BUCKET) {
    throw new Error(`Refusing --write-r2 for non-TEST bucket: ${bucket || "(empty)"}`);
  }
}

export async function runDayManifestRebuild({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  const config = resolveR2HistoryIndexConfig(env);
  if (!hasRequiredR2Config(config.r2)) {
    throw new Error("Missing required R2 configuration");
  }
  const writeR2 = args.mode === "write-r2";
  if (writeR2) {
    assertTestR2WriteTarget(config.r2);
  }

  const domainPrefix = args.domain === "observations"
    ? config.observations_prefix
    : config.aqilevels_prefix;
  const manifestKey = dayManifestKey(domainPrefix, args.dayUtc);
  const existingRead = await getOptionalR2Json({ r2: config.r2, key: manifestKey });
  const connectorManifestKeys = await listConnectorManifestKeys({
    r2: config.r2,
    domainPrefix,
    dayUtc: args.dayUtc,
    maxKeys: args.maxKeys || config.max_keys,
    connectorIds: args.connectorIds,
  });

  const connectorManifests = [];
  const missingRequestedConnectorIds = [];
  for (const key of connectorManifestKeys) {
    try {
      const result = await r2GetObject({ r2: config.r2, key });
      connectorManifests.push(readJsonBuffer(result, key));
    } catch (error) {
      if (args.connectorIds.length > 0 && isR2NotFoundError(error)) {
        const connectorId = connectorIdFromManifestKey(key);
        if (connectorId !== null) {
          missingRequestedConnectorIds.push(connectorId);
          continue;
        }
      }
      throw error;
    }
  }

  if (connectorManifests.length === 0) {
    throw new Error(`No connector manifests found for ${args.domain} day_utc=${args.dayUtc}`);
  }

  const rebuilt = buildDayManifestFromConnectorManifests({
    domain: args.domain,
    dayUtc: args.dayUtc,
    connectorManifests,
    existingDayManifest: existingRead.payload,
  });
  const body = encodeJsonBody(rebuilt);
  const existingBody = existingRead.found
    ? encodeJsonBody(existingRead.payload)
    : "";
  const changed = !existingRead.found || body !== existingBody;
  let putResult = null;
  let verification = {
    status: writeR2 ? (changed ? "pending" : "skipped_unchanged") : "not_run",
    fresh_remote_reads: false,
    verified_bytes: null,
  };
  if (writeR2 && changed) {
    putResult = await r2PutObject({
      r2: config.r2,
      key: manifestKey,
      body,
      content_type: "application/json",
    });
    const liveObject = await r2GetObject({ r2: config.r2, key: manifestKey });
    const liveBody = liveObject.body.toString("utf8");
    if (liveBody !== body || liveObject.bytes !== Buffer.byteLength(body, "utf8")) {
      throw new Error(
        `R2 verification failed for ${manifestKey}: live bytes=${liveObject.bytes} differ from rebuilt bytes=${Buffer.byteLength(body, "utf8")}`,
      );
    }
    verification = {
      status: "succeeded",
      fresh_remote_reads: true,
      verified_bytes: liveObject.bytes,
    };
  }

  const output = {
    ok: true,
    mode: args.mode,
    dry_run: !writeR2,
    write_r2: writeR2,
    status: writeR2 ? (changed ? "succeeded" : "skipped_unchanged") : "planned",
    planning: {
      status: "planned",
      changed,
      blocked_dependency_count: missingRequestedConnectorIds.length,
      connector_manifest_count: connectorManifests.length,
    },
    execution: {
      status: writeR2 ? (changed ? "succeeded" : "skipped_unchanged") : "planned",
      wrote_r2: Boolean(putResult),
    },
    verification,
    wrote_r2: Boolean(putResult),
    domain: args.domain,
    bucket: config.r2.bucket,
    day_utc: args.dayUtc,
    day_manifest_key: manifestKey,
    existing_day_manifest_found: existingRead.found,
    existing_day_manifest_bytes: existingRead.bytes,
    existing_connector_ids: summarizeConnectorIds(existingRead.payload),
    rebuilt_connector_ids: rebuilt.connector_ids,
    connector_manifest_count: connectorManifests.length,
    requested_connector_ids: args.connectorIds,
    missing_requested_connector_ids: missingRequestedConnectorIds.sort((a, b) => a - b),
    changed,
    existing_manifest_hash: existingRead.payload?.manifest_hash ?? null,
    rebuilt_manifest_hash: rebuilt.manifest_hash,
    source_row_count: rebuilt.source_row_count,
    file_count: rebuilt.file_count,
    total_bytes: rebuilt.total_bytes,
    index_rebuild_required_after_write: Boolean(putResult),
    put_result: putResult,
  };

  return output;
}

async function run() {
  const output = await runDayManifestRebuild({ argv: process.argv.slice(2), env: process.env });
  console.log(JSON.stringify(output, null, 2));
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
