#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import {
  parquetMetadataAsync,
  parquetRead,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import * as parquetWasm from "parquet-wasm/esm";
import {
  AQI_ALGORITHM_VERSION,
  buildAqilevelHistoryRowsForDayFromSourceObservations,
  normalizePollutantCode,
} from "../../lib/aqi/aqi_levels.mjs";
import { sha256Hex } from "../../workers/shared/r2_sigv4.mjs";

const DEFAULT_SOURCE_ROOT =
  "/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup";
const DEFAULT_WORK_ROOT = path.join(os.homedir(), "uk-aq-work", "aqilevels-rebuild");
const DEFAULT_R2_TARGET = "uk_aq_r2_test:uk-aq-history-cic-test";
const AQI_PREFIX = "history/v1/aqilevels/hourly";
const OBS_PREFIX = "history/v1/observations";
const CORE_PREFIX = "history/v1/core";
const CONFIRMATION = "REBUILD TEST AQI LOCAL";
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

let parquetWasmReady = false;

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function normalizeAbs(inputPath) {
  return path.resolve(inputPath.replace(/^~(?=$|\/)/, os.homedir()));
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const config = {
    fromDayUtc: env.UK_AQ_LOCAL_AQI_FROM_DAY_UTC || null,
    toDayUtc: env.UK_AQ_LOCAL_AQI_TO_DAY_UTC || null,
    connectorIds: parseConnectorIds(env.UK_AQ_LOCAL_AQI_CONNECTOR_IDS || ""),
    sourceRoot: normalizeAbs(env.UK_AQ_LOCAL_AQI_SOURCE_ROOT || DEFAULT_SOURCE_ROOT),
    workRoot: normalizeAbs(env.UK_AQ_LOCAL_AQI_WORK_ROOT || DEFAULT_WORK_ROOT),
    r2Target: env.UK_AQ_LOCAL_AQI_R2_TARGET || DEFAULT_R2_TARGET,
    aqiPrefix: env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || AQI_PREFIX,
    mode: "dry-run",
    replace: false,
    keepLocalWork: parseBoolean(env.KEEP_LOCAL_AQI_WORK, true),
    confirmation: env.UK_AQ_LOCAL_AQI_CONFIRMATION || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value after ${arg}`);
      return argv[index];
    };
    if (arg === "--from-day") config.fromDayUtc = next();
    else if (arg === "--to-day") config.toDayUtc = next();
    else if (arg === "--connector-ids") config.connectorIds = parseConnectorIds(next());
    else if (arg === "--source-root") config.sourceRoot = normalizeAbs(next());
    else if (arg === "--work-root") config.workRoot = normalizeAbs(next());
    else if (arg === "--r2-target") config.r2Target = next();
    else if (arg === "--dry-run") config.mode = "dry-run";
    else if (arg === "--local-only") config.mode = "local-only";
    else if (arg === "--upload") config.mode = "upload";
    else if (arg === "--replace") config.replace = true;
    else if (arg === "--keep-local-work") config.keepLocalWork = true;
    else if (arg === "--delete-local-work-after-success") config.keepLocalWork = false;
    else if (arg === "--confirm") config.confirmation = next();
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!config.fromDayUtc) config.fromDayUtc = config.toDayUtc;
  if (!config.toDayUtc) config.toDayUtc = config.fromDayUtc;
  return config;
}

export function validateConfig(config) {
  if (!isIsoDay(config.fromDayUtc) || !isIsoDay(config.toDayUtc)) {
    throw new Error("Both --from-day and --to-day are required in YYYY-MM-DD format");
  }
  if (config.toDayUtc < config.fromDayUtc) {
    throw new Error("--to-day must be >= --from-day");
  }
  if (config.aqiPrefix !== AQI_PREFIX) {
    throw new Error(`AQI prefix must be ${AQI_PREFIX}`);
  }
  if (config.r2Target.toLowerCase().includes("live")) {
    throw new Error("Refusing to use a LIVE R2 target");
  }
  if (!fs.existsSync(path.join(config.sourceRoot, OBS_PREFIX))) {
    throw new Error(`Source observation backup directory does not exist: ${path.join(config.sourceRoot, OBS_PREFIX)}`);
  }
  if (isPathInsideDropbox(config.workRoot)) {
    throw new Error(`Refusing to use a Dropbox work directory: ${config.workRoot}`);
  }
  if (isSameOrSubpath(config.workRoot, config.sourceRoot) || isSameOrSubpath(path.join(config.workRoot, config.aqiPrefix), config.sourceRoot)) {
    throw new Error("Refusing to write generated AQI parquet inside the Dropbox source backup");
  }
}

function printUsage() {
  console.log(`Usage:
  node scripts/AQI-levels-refactor-June-2026/local_aqilevels_rebuild_from_dropbox.mjs \\
    --from-day YYYY-MM-DD --to-day YYYY-MM-DD [--connector-ids 1,3,6,7] [--dry-run|--local-only|--upload]

Defaults:
  source root: ${DEFAULT_SOURCE_ROOT}
  work root:   ${DEFAULT_WORK_ROOT}
  R2 target:   ${DEFAULT_R2_TARGET}
  AQI prefix:  ${AQI_PREFIX}
`);
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
}

function parseConnectorIds(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const ids = text.split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
    .map((value) => Math.trunc(value));
  return ids.length ? Array.from(new Set(ids)).sort((a, b) => a - b) : null;
}

function isIsoDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function isSameOrSubpath(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPathInsideDropbox(candidate) {
  return path.resolve(candidate).split(path.sep).some((part) => part.toLowerCase() === "dropbox");
}

function dayRange(fromDay, toDay) {
  const days = [];
  const cursor = new Date(`${fromDay}T00:00:00.000Z`);
  const end = new Date(`${toDay}T00:00:00.000Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function shiftDay(dayUtc, delta) {
  const date = new Date(`${dayUtc}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function readNdjsonGz(filePath) {
  const bytes = await fsp.readFile(filePath);
  const text = zlib.gunzipSync(bytes).toString("utf8");
  return text.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function findLatestCoreDay(sourceRoot) {
  const coreRoot = path.join(sourceRoot, CORE_PREFIX);
  const entries = await fsp.readdir(coreRoot, { withFileTypes: true });
  const days = entries
    .filter((entry) => entry.isDirectory() && /^day_utc=\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name.slice("day_utc=".length))
    .sort();
  if (!days.length) throw new Error(`No core snapshots found under ${coreRoot}`);
  return days.at(-1);
}

async function loadTimeseriesLookup(sourceRoot) {
  const dayUtc = await findLatestCoreDay(sourceRoot);
  const coreDayRoot = path.join(sourceRoot, CORE_PREFIX, `day_utc=${dayUtc}`);
  const [timeseriesRows, phenomenonRows, observedPropertyRows] = await Promise.all([
    readNdjsonGz(path.join(coreDayRoot, "table=timeseries", "rows.ndjson.gz")),
    readNdjsonGz(path.join(coreDayRoot, "table=phenomena", "rows.ndjson.gz")),
    readNdjsonGz(path.join(coreDayRoot, "table=observed_properties", "rows.ndjson.gz")),
  ]);
  const observedPropertyCodeById = new Map();
  for (const row of observedPropertyRows) {
    const id = Number(row.id);
    if (Number.isInteger(id) && id > 0) observedPropertyCodeById.set(id, String(row.code || ""));
  }
  const pollutantByPhenomenonId = new Map();
  for (const row of phenomenonRows) {
    const id = Number(row.id);
    const observedPropertyId = Number(row.observed_property_id);
    const candidate = normalizePollutantCode(row.pollutant_label) ||
      normalizePollutantCode(observedPropertyCodeById.get(observedPropertyId)) ||
      normalizePollutantCode(row.notation) ||
      normalizePollutantCode(row.source_label);
    if (Number.isInteger(id) && id > 0 && candidate) pollutantByPhenomenonId.set(id, candidate);
  }
  const lookup = new Map();
  for (const row of timeseriesRows) {
    const timeseriesId = Number(row.id);
    const stationId = Number(row.station_id);
    const connectorId = Number(row.connector_id);
    const phenomenonId = Number(row.phenomenon_id);
    const pollutantCode = pollutantByPhenomenonId.get(phenomenonId) || normalizePollutantCode(row.label);
    if (
      Number.isInteger(timeseriesId) && timeseriesId > 0 &&
      Number.isInteger(stationId) && stationId > 0 &&
      Number.isInteger(connectorId) && connectorId > 0 &&
      pollutantCode
    ) {
      lookup.set(timeseriesId, {
        timeseries_id: timeseriesId,
        station_id: stationId,
        connector_id: connectorId,
        pollutant_code: pollutantCode,
      });
    }
  }
  return { lookup, core_day_utc: dayUtc };
}

async function readParquetColumnValues(file, metadata, columnName, rowStart, rowEnd) {
  let rows = [];
  await parquetRead({
    file,
    metadata,
    columns: [columnName],
    rowStart,
    rowEnd,
    compressors,
    onComplete: (columnRows) => {
      if (Array.isArray(columnRows)) rows = columnRows;
    },
  });
  return rows.map((entry) => Array.isArray(entry) ? entry[0] : undefined);
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function readObservationParquet(filePath, connectorId, lookup) {
  const bytes = await fsp.readFile(filePath);
  const arrayBuffer = new Uint8Array(bytes).slice().buffer;
  const metadata = await parquetMetadataAsync(arrayBuffer);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) return [];
  const [timeseriesValues, observedValues, valueValues] = await Promise.all([
    readParquetColumnValues(arrayBuffer, metadata, "timeseries_id", 0, rowCount),
    readParquetColumnValues(arrayBuffer, metadata, "observed_at", 0, rowCount),
    readParquetColumnValues(arrayBuffer, metadata, "value", 0, rowCount),
  ]);
  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const timeseriesId = Number(timeseriesValues[index]);
    const binding = lookup.get(timeseriesId);
    const observedAt = toIso(observedValues[index]);
    const value = Number(valueValues[index]);
    if (!binding || binding.connector_id !== connectorId || !observedAt || !Number.isFinite(value)) continue;
    rows.push({
      timeseries_id: binding.timeseries_id,
      station_id: binding.station_id,
      connector_id: binding.connector_id,
      pollutant_code: binding.pollutant_code,
      observed_at: observedAt,
      value,
    });
  }
  return rows;
}

async function connectorIdsForDay(sourceRoot, dayUtc) {
  const manifestPath = path.join(sourceRoot, OBS_PREFIX, `day_utc=${dayUtc}`, "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = await readJson(manifestPath);
  return (Array.isArray(manifest.connector_ids) ? manifest.connector_ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .map((value) => Math.trunc(value))
    .sort((a, b) => a - b);
}

async function observationPartPathsForConnectorDay(sourceRoot, dayUtc, connectorId) {
  const manifestPath = path.join(sourceRoot, OBS_PREFIX, `day_utc=${dayUtc}`, `connector_id=${connectorId}`, "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = await readJson(manifestPath);
  const keys = Array.isArray(manifest.parquet_object_keys)
    ? manifest.parquet_object_keys
    : Array.isArray(manifest.files)
    ? manifest.files.map((file) => file.key)
    : [];
  return keys.filter(Boolean).map((key) => path.join(sourceRoot, key));
}

async function loadSourceObservationsForTargetDay({ sourceRoot, dayUtc, connectorId, lookup }) {
  const daysToRead = [shiftDay(dayUtc, -1), dayUtc];
  const rows = [];

  for (const sourceDay of daysToRead) {
    const partPaths = await observationPartPathsForConnectorDay(sourceRoot, sourceDay, connectorId);

    for (const partPath of partPaths) {
      if (!fs.existsSync(partPath)) {
        continue;
      }

      const partRows = await readObservationParquet(partPath, connectorId, lookup);

      for (const row of partRows) {
        rows.push(row);
      }
    }
  }

  return rows;
}

async function ensureParquetWasmInitialized() {
  if (parquetWasmReady) return;
  const wasmPath = path.resolve(repoRoot(), "node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm");
  parquetWasm.initSync({ module: await fsp.readFile(wasmPath) });
  parquetWasmReady = true;
}

function parquetWriterProperties(rowGroupSize, createdBy) {
  return new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.ZSTD)
    .setMaxRowGroupSize(rowGroupSize)
    .setCreatedBy(createdBy)
    .build();
}

async function rowsToAqiParquetBuffer(rows) {
  await ensureParquetWasmInitialized();
  const int32Vector = (values) => arrow.vectorFromArray(values, new arrow.Int32());
  const float64Vector = (values) => arrow.vectorFromArray(values, new arrow.Float64());
  const textVector = (values) => arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values) => arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = arrow.tableFromArrays({
    connector_id: int32Vector(rows.map((row) => row.connector_id)),
    station_id: int32Vector(rows.map((row) => row.station_id)),
    timeseries_id: int32Vector(rows.map((row) => row.timeseries_id)),
    pollutant_code: textVector(rows.map((row) => row.pollutant_code)),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_input_value_ugm3: float64Vector(rows.map((row) => row.daqi_input_value_ugm3)),
    daqi_input_averaging_code: textVector(rows.map((row) => row.daqi_input_averaging_code)),
    daqi_index_level: int32Vector(rows.map((row) => row.daqi_index_level)),
    daqi_source_observation_count: int32Vector(rows.map((row) => row.daqi_source_observation_count)),
    daqi_required_observation_count: int32Vector(rows.map((row) => row.daqi_required_observation_count)),
    daqi_calculation_status: textVector(rows.map((row) => row.daqi_calculation_status)),
    daqi_missing_reason: textVector(rows.map((row) => row.daqi_missing_reason)),
    eaqi_input_value_ugm3: float64Vector(rows.map((row) => row.eaqi_input_value_ugm3)),
    eaqi_input_averaging_code: textVector(rows.map((row) => row.eaqi_input_averaging_code)),
    eaqi_index_level: int32Vector(rows.map((row) => row.eaqi_index_level)),
    eaqi_source_observation_count: int32Vector(rows.map((row) => row.eaqi_source_observation_count)),
    eaqi_required_observation_count: int32Vector(rows.map((row) => row.eaqi_required_observation_count)),
    eaqi_calculation_status: textVector(rows.map((row) => row.eaqi_calculation_status)),
    eaqi_missing_reason: textVector(rows.map((row) => row.eaqi_missing_reason)),
    hourly_sample_count: int32Vector(rows.map((row) => row.hourly_sample_count)),
    algorithm_version: textVector(rows.map((row) => row.algorithm_version)),
    computed_at_utc: timestampVector(rows.map((row) => row.computed_at_utc ? new Date(row.computed_at_utc) : null)),
    hourly_mean_ugm3: float64Vector(rows.map((row) => row.hourly_mean_ugm3)),
    rolling24h_mean_ugm3: float64Vector(rows.map((row) => row.rolling24h_mean_ugm3)),
    no2_hourly_mean_ugm3: float64Vector(rows.map((row) => row.no2_hourly_mean_ugm3)),
    pm25_hourly_mean_ugm3: float64Vector(rows.map((row) => row.pm25_hourly_mean_ugm3)),
    pm10_hourly_mean_ugm3: float64Vector(rows.map((row) => row.pm10_hourly_mean_ugm3)),
    pm25_rolling24h_mean_ugm3: float64Vector(rows.map((row) => row.pm25_rolling24h_mean_ugm3)),
    pm10_rolling24h_mean_ugm3: float64Vector(rows.map((row) => row.pm10_rolling24h_mean_ugm3)),
    daqi_no2_index_level: int32Vector(rows.map((row) => row.daqi_no2_index_level)),
    daqi_pm25_rolling24h_index_level: int32Vector(rows.map((row) => row.daqi_pm25_rolling24h_index_level)),
    daqi_pm10_rolling24h_index_level: int32Vector(rows.map((row) => row.daqi_pm10_rolling24h_index_level)),
    eaqi_no2_index_level: int32Vector(rows.map((row) => row.eaqi_no2_index_level)),
    eaqi_pm25_index_level: int32Vector(rows.map((row) => row.eaqi_pm25_index_level)),
    eaqi_pm10_index_level: int32Vector(rows.map((row) => row.eaqi_pm10_index_level)),
    updated_at: timestampVector(rows.map((row) => row.updated_at ? new Date(row.updated_at) : null)),
  });
  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  return Buffer.from(parquetWasm.writeParquet(
    wasmTable,
    parquetWriterProperties(100_000, "parquet-wasm-zstd-v1"),
  ));
}

function summarizeRows(rows) {
  const pollutants = new Set();
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let minTimestampHourUtc = null;
  let maxTimestampHourUtc = null;
  for (const row of rows) {
    pollutants.add(row.pollutant_code);
    minTimeseriesId = minTimeseriesId === null ? row.timeseries_id : Math.min(minTimeseriesId, row.timeseries_id);
    maxTimeseriesId = maxTimeseriesId === null ? row.timeseries_id : Math.max(maxTimeseriesId, row.timeseries_id);
    minTimestampHourUtc = minTimestampHourUtc === null || row.timestamp_hour_utc < minTimestampHourUtc ? row.timestamp_hour_utc : minTimestampHourUtc;
    maxTimestampHourUtc = maxTimestampHourUtc === null || row.timestamp_hour_utc > maxTimestampHourUtc ? row.timestamp_hour_utc : maxTimestampHourUtc;
  }
  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    pollutant_codes: Array.from(pollutants).sort(),
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
  };
}

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function writeConnectorOutput({ workRoot, dayUtc, connectorId, runId, rows, computedAtUtc }) {
  const connectorRelPrefix = `${AQI_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}`;
  const connectorDir = path.join(workRoot, connectorRelPrefix);
  await fsp.mkdir(connectorDir, { recursive: true });
  const partRelKey = `${connectorRelPrefix}/part-00000.parquet`;
  const partPath = path.join(workRoot, partRelKey);
  const parquetBuffer = await rowsToAqiParquetBuffer(rows);
  await fsp.writeFile(partPath, parquetBuffer);
  const summary = summarizeRows(rows);
  const fileEntry = {
    key: partRelKey,
    row_count: rows.length,
    bytes: parquetBuffer.length,
    etag_or_hash: sha256Hex(parquetBuffer),
    ...summary,
  };
  const manifestRelKey = `${connectorRelPrefix}/manifest.json`;
  const manifest = {
    day_utc: dayUtc,
    connector_id: connectorId,
    run_id: runId,
    manifest_key: manifestRelKey,
    source_row_count: rows.length,
    ...summary,
    parquet_object_keys: [partRelKey],
    file_count: 1,
    total_bytes: parquetBuffer.length,
    files: [fileEntry],
    history_schema_name: "aqilevels_hourly",
    history_schema_version: 1,
    grain: "hourly",
    columns: HISTORY_AQILEVELS_COLUMNS,
    available_pollutants: summary.pollutant_codes,
    writer_version: "parquet-wasm-zstd-v1",
    writer_git_sha: null,
    algorithm_version: AQI_ALGORITHM_VERSION,
    backed_up_at_utc: computedAtUtc,
  };
  await writeJson(path.join(workRoot, manifestRelKey), manifest);
  return { manifest, files: [partRelKey, manifestRelKey] };
}

async function writeDayManifest({ workRoot, dayUtc, runId, connectorManifests, computedAtUtc }) {
  const files = connectorManifests.flatMap((manifest) => manifest.files || []);
  const connectorIds = connectorManifests.map((manifest) => Number(manifest.connector_id)).sort((a, b) => a - b);
  const pollutants = new Set();
  for (const manifest of connectorManifests) {
    for (const pollutant of manifest.available_pollutants || []) pollutants.add(pollutant);
  }
  const manifestRelKey = `${AQI_PREFIX}/day_utc=${dayUtc}/manifest.json`;
  const dayManifest = {
    day_utc: dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: runId,
    manifest_key: manifestRelKey,
    source_row_count: connectorManifests.reduce((sum, manifest) => sum + Number(manifest.source_row_count || 0), 0),
    parquet_object_keys: files.map((file) => file.key),
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + Number(file.bytes || 0), 0),
    files,
    connector_manifests: connectorManifests.map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      source_row_count: manifest.source_row_count,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      min_timestamp_hour_utc: manifest.min_timestamp_hour_utc,
      max_timestamp_hour_utc: manifest.max_timestamp_hour_utc,
      available_pollutants: manifest.available_pollutants,
    })),
    history_schema_name: "aqilevels_hourly",
    history_schema_version: 1,
    grain: "hourly",
    columns: HISTORY_AQILEVELS_COLUMNS,
    available_pollutants: Array.from(pollutants).sort(),
    writer_version: "parquet-wasm-zstd-v1",
    algorithm_version: AQI_ALGORITHM_VERSION,
    backed_up_at_utc: computedAtUtc,
  };
  await writeJson(path.join(workRoot, manifestRelKey), dayManifest);
  return dayManifest;
}

async function describeParquetSchema(filePath) {
  const bytes = await fsp.readFile(filePath);
  await ensureParquetWasmInitialized();
  const wasmTable = parquetWasm.readParquet(new Uint8Array(bytes));
  const table = arrow.tableFromIPC(wasmTable.intoIPCStream());
  return table.schema.fields.map((field) => ({ name: field.name, type: String(field.type) }));
}

function runRclone(args) {
  const result = spawnSync("rclone", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`rclone ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function uploadToTestR2(config, report) {
  const source = path.join(config.workRoot, config.aqiPrefix);
  const target = `${config.r2Target}/${config.aqiPrefix}`;
  if (config.replace) {
    for (const day of report.days_processed) {
      runRclone(["purge", `${target}/day_utc=${day}`]);
    }
  }
  runRclone(["copy", source, target]);
  report.files_uploaded = report.files_written;
}

async function verifyUploaded(config, report) {
  const sample = report.sampled_schema_verification_result?.sample_file;
  if (!sample) return;
  const remoteSample = `${config.r2Target}/${sample}`;
  const stdout = runRclone(["lsjson", remoteSample]);
  const parsed = JSON.parse(stdout || "[]");
  report.r2_sample_exists = Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
}

async function maybeConfirm(config) {
  if (config.mode !== "upload") return;
  if (config.confirmation === CONFIRMATION) return;
  if (!process.stdin.isTTY) {
    throw new Error(`Upload requires confirmation: ${CONFIRMATION}`);
  }
  process.stdout.write(`Type ${CONFIRMATION} to upload to TEST R2: `);
  const input = fs.readFileSync(0, "utf8").trim();
  if (input !== CONFIRMATION) throw new Error("Confirmation did not match; aborting upload");
}

export async function runLocalAqilevelsRebuild(config) {
  validateConfig(config);
  await maybeConfirm(config);
  const runStartedAt = new Date().toISOString();
  const stamp = runStartedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const runId = `local-aqilevels-${stamp}`;
  const report = {
    from_day: config.fromDayUtc,
    to_day: config.toDayUtc,
    source_root: config.sourceRoot,
    work_root: config.workRoot,
    r2_target: config.r2Target,
    aqi_prefix: config.aqiPrefix,
    mode: config.mode,
    replace: config.replace,
    days_processed: [],
    connector_ids_processed: [],
    files_written: [],
    files_uploaded: [],
    sampled_schema_verification_result: null,
    errors: [],
    local_work_output_deleted: false,
    index_rebuild_skipped_intentionally: true,
    inventory_rebuild_skipped_intentionally: true,
    dropbox_sync_skipped_intentionally: true,
  };
  const reportPath = path.join(config.workRoot, "reports", `local_aqilevels_rebuild_TEST_${stamp}.json`);

  try {
    const { lookup, core_day_utc: coreDayUtc } = await loadTimeseriesLookup(config.sourceRoot);
    report.core_snapshot_day_utc = coreDayUtc;
    if (config.mode === "dry-run") {
      report.message = "Dry run only; no local AQI parquet was written and no R2 upload was attempted.";
    } else {
      await fsp.mkdir(path.join(config.workRoot, config.aqiPrefix), { recursive: true });
      for (const dayUtc of dayRange(config.fromDayUtc, config.toDayUtc)) {
        const dayConnectorIds = await connectorIdsForDay(config.sourceRoot, dayUtc);
        const targetConnectorIds = (config.connectorIds || dayConnectorIds).filter((id) => dayConnectorIds.includes(id));
        const connectorManifests = [];
        for (const connectorId of targetConnectorIds) {
          const sourceRows = await loadSourceObservationsForTargetDay({
            sourceRoot: config.sourceRoot,
            dayUtc,
            connectorId,
            lookup,
          });
          const aqiRows = buildAqilevelHistoryRowsForDayFromSourceObservations(
            sourceRows,
            dayUtc,
            { computedAtUtc: runStartedAt },
          );
          if (!aqiRows.length) continue;
          const output = await writeConnectorOutput({
            workRoot: config.workRoot,
            dayUtc,
            connectorId,
            runId,
            rows: aqiRows,
            computedAtUtc: runStartedAt,
          });
          connectorManifests.push(output.manifest);
          report.files_written.push(...output.files);
          report.connector_ids_processed.push(connectorId);
        }
        if (connectorManifests.length) {
          const dayManifest = await writeDayManifest({
            workRoot: config.workRoot,
            dayUtc,
            runId,
            connectorManifests,
            computedAtUtc: runStartedAt,
          });
          report.files_written.push(dayManifest.manifest_key);
          report.days_processed.push(dayUtc);
        }
      }
      report.connector_ids_processed = Array.from(new Set(report.connector_ids_processed)).sort((a, b) => a - b);

      const sampleFile = report.files_written.find((file) => file.endsWith(".parquet"));
      if (sampleFile) {
        const schema = await describeParquetSchema(path.join(config.workRoot, sampleFile));
        const names = schema.map((field) => field.name);
        report.sampled_schema_verification_result = {
          sample_file: sampleFile,
          has_daqi_input_columns: names.includes("daqi_input_value_ugm3") && names.includes("daqi_input_averaging_code"),
          has_eaqi_input_columns: names.includes("eaqi_input_value_ugm3") && names.includes("eaqi_input_averaging_code"),
          stale_compact_schema: !names.includes("daqi_input_value_ugm3") || !names.includes("eaqi_input_value_ugm3"),
          schema,
        };
      }
      if (isSameOrSubpath(path.join(config.workRoot, config.aqiPrefix), config.sourceRoot)) {
        throw new Error("Generated AQI output was written into the Dropbox backup source directory");
      }
      if (config.mode === "upload") {
        await uploadToTestR2(config, report);
        await verifyUploaded(config, report);
      }
      if (config.mode === "upload" && config.keepLocalWork === false) {
        await fsp.rm(path.join(config.workRoot, config.aqiPrefix), { recursive: true, force: true });
        report.local_work_output_deleted = true;
      }
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await writeJson(reportPath, report);
    console.log(`Report: ${reportPath}`);
    printManualNextSteps();
  }
  return report;
}

function printManualNextSteps() {
  console.log(`
Manual next steps after R2 output is verified:

UK_AQ_R2_HISTORY_AQILEVELS_PREFIX="history/v1/aqilevels/hourly" \\
UK_AQ_R2_HISTORY_INDEX_PREFIX="history/_index" \\
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \\
  --domain aqilevels

UK_AQ_R2_HISTORY_AQILEVELS_PREFIX="history/v1/aqilevels/hourly" \\
node scripts/backup_r2/build_backup_inventory.mjs \\
  --source-root "uk_aq_r2_test:uk-aq-history-cic-test" \\
  --domain aqilevels \\
  --index-prefix "history/_index" \\
  --full-rebuild \\
  --report-out "tmp/r2_backup_inventory_aqilevels_after_rebuild_TEST.json"

Dropbox backup sync is manual. Do not run it until R2 output, indexes, and inventory have been checked.
`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  try {
    const config = parseArgs();
    await runLocalAqilevelsRebuild(config);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack || error.message) : String(error));
    process.exitCode = 1;
  }
}
