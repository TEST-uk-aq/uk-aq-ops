#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parquetMetadataAsync, parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  addUtcHours,
  buildAqilevelHistoryRowsForDayFromSourceObservations,
  mapR2ObservationRowsToSourceObservations,
  parseIsoDayUtc,
  shiftIsoDay,
  utcDayEndIso,
  utcDayStartIso,
} from "../../workers/uk_aq_backfill_local/backfill_core.mjs";
import { resolveR2HistoryVersion } from "../../workers/shared/uk_aq_r2_history_version.mjs";

const DEFAULT_OBSERVATIONS_PREFIX_V1 = "history/v1/observations";
const DEFAULT_AQILEVELS_PREFIX_V1 = "history/v1/aqilevels/hourly";
const DEFAULT_CORE_PREFIX_V1 = "history/v1/core";
const DEFAULT_OBSERVATIONS_PREFIX_V2 = "history/v2/observations";
const DEFAULT_AQILEVELS_DATA_PREFIX_V2 = "history/v2/aqilevels/hourly/data";
const DEFAULT_CORE_PREFIX_V2 = "history/v2/core";
const DEFAULT_MAX_SAMPLES = 50;
const DEFAULT_FLOAT_TOLERANCE = 1e-9;
const DEFAULT_BACKFILL_SCRIPT_REL = "scripts/uk_aq_backfill_local.sh";

function buildDefaultDropboxLocalBackupRoot() {
  const dropboxRoot = String(process.env.UK_AQ_DROPBOX_ROOT || "").trim() || "CIC-Test";
  return `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/${dropboxRoot}/R2_history_backup`;
}

const DEFAULT_DROPBOX_LOCAL_BACKUP_ROOT = buildDefaultDropboxLocalBackupRoot();

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_validate_aqi_from_dropbox_observs.mjs [options]",
    "",
    "Purpose:",
    "  Recompute AQI rows from local Dropbox observations history and compare",
    "  against local Dropbox aqilevels history for each day+connector.",
    "",
    "Default mode:",
    "  Dry-run report only (no writes).",
    "",
    "Options:",
    "  --root <path>                 Local R2 Dropbox backup root (default: auto detect)",
    "  --history-version v1|v2       History layout/version to read and rebuild (default from env or v1)",
    "  --from-day <YYYY-MM-DD>       Optional inclusive day lower bound",
    "  --to-day <YYYY-MM-DD>         Optional inclusive day upper bound",
    "  --connector-id <id>           Optional connector filter (repeatable)",
    "  --max-connector-days <n>      Cap connector-day checks (0=all, default 0)",
    "  --include-ok                  Include matching connector-day rows in output",
    "  --max-samples <n>             Max mismatch samples per connector-day (default 50)",
    "  --float-tolerance <n>         Float compare tolerance (default 1e-9)",
    "  --format csv|json             Output format (default: csv)",
    "  --out <path>                  Write output file as well as stdout",
    "  --dry-run                     Explicit no-write mode (default)",
    "  --write-r2                    Execute targeted AQI rebuild writes to R2 for mismatches",
    "  --backfill-script <path>      Backfill launcher path (default scripts/uk_aq_backfill_local.sh)",
    "  --print-write-commands        Include planned write commands in output",
    "  -h, --help                    Show this help",
    "",
    "Write mode details:",
    "  --write-r2 runs one backfill call per day using:",
    "    UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels",
    "    UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only",
    "    UK_AQ_BACKFILL_FORCE_REPLACE=true",
    "    UK_AQ_BACKFILL_DRY_RUN=false",
    "",
    "Optional env:",
    "  UK_AQ_DROPBOX_ROOT",
    "  UK_AQ_R2_HISTORY_DROPBOX_ROOT",
    "  UK_AQ_R2_HISTORY_DROPBOX_LOCAL_ROOT",
    "  UK_AQ_R2_HISTORY_VERSION (v1|v2)",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX (v1 default history/v1/observations)",
    "  UK_AQ_R2_HISTORY_AQILEVELS_PREFIX (v1 default history/v1/aqilevels/hourly)",
    "  UK_AQ_R2_HISTORY_CORE_PREFIX (v1 default history/v1/core)",
    "  UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX (v2 default history/v2/observations)",
    "  UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX (v2 default history/v2/aqilevels/hourly/data)",
    "  UK_AQ_R2_HISTORY_V2_CORE_PREFIX (v2 default history/v2/core)",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    root: "",
    historyVersion: "",
    fromDay: "",
    toDay: "",
    connectorIds: new Set(),
    maxConnectorDays: 0,
    includeOk: false,
    maxSamples: DEFAULT_MAX_SAMPLES,
    floatTolerance: DEFAULT_FLOAT_TOLERANCE,
    format: "csv",
    outPath: "",
    mode: "dry-run",
    sawDryRun: false,
    sawWriteR2: false,
    backfillScript: DEFAULT_BACKFILL_SCRIPT_REL,
    printWriteCommands: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--history-version") {
      args.historyVersion = parseHistoryVersion(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--from-day") {
      args.fromDay = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--to-day") {
      args.toDay = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--connector-id") {
      args.connectorIds.add(parsePositiveInt(argv[i + 1], "--connector-id"));
      i += 1;
      continue;
    }
    if (arg === "--max-connector-days") {
      args.maxConnectorDays = parseNonNegativeInt(argv[i + 1], "--max-connector-days");
      i += 1;
      continue;
    }
    if (arg === "--include-ok") {
      args.includeOk = true;
      continue;
    }
    if (arg === "--max-samples") {
      args.maxSamples = parsePositiveInt(argv[i + 1], "--max-samples");
      i += 1;
      continue;
    }
    if (arg === "--float-tolerance") {
      args.floatTolerance = parseNonNegativeNumber(argv[i + 1], "--float-tolerance");
      i += 1;
      continue;
    }
    if (arg === "--format") {
      args.format = String(argv[i + 1] || "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--out") {
      args.outPath = String(argv[i + 1] || "").trim();
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
    if (arg === "--backfill-script") {
      args.backfillScript = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--print-write-commands") {
      args.printWriteCommands = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (args.fromDay && !parseIsoDayUtc(args.fromDay)) {
    throw new Error("--from-day must be YYYY-MM-DD");
  }
  if (args.toDay && !parseIsoDayUtc(args.toDay)) {
    throw new Error("--to-day must be YYYY-MM-DD");
  }
  if (args.fromDay && args.toDay && args.fromDay > args.toDay) {
    throw new Error("--from-day must be <= --to-day");
  }
  if (!new Set(["csv", "json"]).has(args.format)) {
    throw new Error("--format must be csv or json");
  }
  if (args.sawDryRun && args.sawWriteR2) {
    throw new Error("Use either --dry-run or --write-r2, not both");
  }
  if (!args.historyVersion) {
    args.historyVersion = resolveR2HistoryVersion(process.env, { context: "R2 AQI Dropbox validation writes" });
  }
  return args;
}

function parseHistoryVersion(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (value === "v1" || value === "v2") return value;
  throw new Error("history version must be v1 or v2");
}

function parsePositiveInt(rawValue, flagName) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return Math.trunc(value);
}

function parseNonNegativeInt(rawValue, flagName) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flagName} must be >= 0`);
  }
  return Math.trunc(value);
}

function parseNonNegativeNumber(rawValue, flagName) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flagName} must be >= 0`);
  }
  return value;
}

function normalizePrefix(rawValue, fallbackValue) {
  const prefix = String(rawValue || fallbackValue || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    throw new Error("Invalid empty prefix");
  }
  return prefix;
}

function findDropboxRoot(cliValue) {
  const candidates = [
    String(cliValue || "").trim(),
    String(process.env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || "").trim(),
    String(process.env.UK_AQ_R2_HISTORY_DROPBOX_LOCAL_ROOT || "").trim(),
    DEFAULT_DROPBOX_LOCAL_BACKUP_ROOT,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return "";
}

function parsePollutantCode(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "no2" || value.includes("nitrogen")) return "no2";
  if (
    value === "pm25" || value === "pm2.5" || value === "pm_25" ||
    value === "particulate_matter_2.5um" || value === "particulate_matter_2_5um"
  ) {
    return "pm25";
  }
  if (
    value === "pm10" || value === "pm_10" ||
    value === "particulate_matter_10um"
  ) {
    return "pm10";
  }
  if (value.includes("pm2.5") || value.includes("pm25")) return "pm25";
  if (value.includes("pm10")) return "pm10";
  if (value.includes("no2")) return "no2";
  return null;
}

function parseIsoTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function toSafeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  if (fs.statSync(filePath).size <= 0) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readNdjsonGz(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) {
    return [];
  }
  const raw = fs.readFileSync(filePath);
  const text = zlib.gunzipSync(raw).toString("utf8");
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

function resolvePollutantFromTimeseriesRow(row, phenomenaById) {
  const direct = [
    row?.pollutant_code,
    row?.phenomenon_code,
    row?.observed_property_code,
    row?.pollutant,
  ];
  for (const candidate of direct) {
    const parsed = parsePollutantCode(candidate);
    if (parsed) return parsed;
  }

  const phenomenonId = Number(row?.phenomenon_id || row?.observed_property_id);
  if (Number.isInteger(phenomenonId) && phenomenaById.has(phenomenonId)) {
    const parsed = parsePollutantCode(phenomenaById.get(phenomenonId));
    if (parsed) return parsed;
  }

  const textFields = [
    row?.phenomenon_label,
    row?.observed_property_label,
    row?.timeseries_ref,
    row?.label,
    row?.display_name,
  ];
  for (const candidate of textFields) {
    const parsed = parsePollutantCode(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function loadCoreTimeseriesBindings({ dropboxRoot, corePrefix }) {
  const coreRoot = path.join(dropboxRoot, corePrefix);
  if (!fs.existsSync(coreRoot)) {
    throw new Error(`Core prefix not found in Dropbox root: ${coreRoot}`);
  }

  const dayEntries = fs.readdirSync(coreRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^day_utc=\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name.slice("day_utc=".length))
    .sort((left, right) => right.localeCompare(left));

  for (const dayUtc of dayEntries) {
    try {
      const phenomenaPath = path.join(
        coreRoot,
        `day_utc=${dayUtc}`,
        "table=phenomena",
        "rows.ndjson.gz",
      );
      const timeseriesPath = path.join(
        coreRoot,
        `day_utc=${dayUtc}`,
        "table=timeseries",
        "rows.ndjson.gz",
      );
      if (!fs.existsSync(timeseriesPath) || fs.statSync(timeseriesPath).size <= 0) {
        continue;
      }

      const phenomenaRows = readNdjsonGz(phenomenaPath);
      const phenomenaById = new Map();
      for (const row of phenomenaRows) {
        const id = Number(row?.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        const code = row?.code || row?.pollutant_code || row?.label || row?.display_name;
        if (!code) continue;
        phenomenaById.set(Math.trunc(id), String(code));
      }

      const timeseriesRows = readNdjsonGz(timeseriesPath);
      const bindingByTimeseriesId = new Map();
      for (const row of timeseriesRows) {
        const timeseriesId = Number(row?.id ?? row?.timeseries_id);
        const stationId = Number(row?.station_id);
        if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) continue;
        if (!Number.isInteger(stationId) || stationId <= 0) continue;

        const pollutantCode = resolvePollutantFromTimeseriesRow(row, phenomenaById);
        if (!pollutantCode) continue;

        const connectorIdRaw = Number(row?.connector_id);
        const connectorId = Number.isInteger(connectorIdRaw) && connectorIdRaw > 0
          ? Math.trunc(connectorIdRaw)
          : null;

        bindingByTimeseriesId.set(Math.trunc(timeseriesId), {
          timeseries_id: Math.trunc(timeseriesId),
          station_id: Math.trunc(stationId),
          connector_id: connectorId,
          pollutant_code: pollutantCode,
        });
      }

      if (bindingByTimeseriesId.size > 0) {
        return { snapshot_day_utc: dayUtc, binding_by_timeseries_id: bindingByTimeseriesId };
      }
    } catch (_error) {
      continue;
    }
  }

  throw new Error(
    "No usable core timeseries snapshot found in Dropbox backup (timeseries rows missing/empty).",
  );
}

function parseManifestParquetKeys(manifest) {
  const keys = new Set();
  const parquetObjectKeys = Array.isArray(manifest?.parquet_object_keys) ? manifest.parquet_object_keys : [];
  for (const keyRaw of parquetObjectKeys) {
    const key = String(keyRaw || "").trim();
    if (key) keys.add(key);
  }
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  for (const fileEntry of files) {
    const key = String(fileEntry?.key || "").trim();
    if (key) keys.add(key);
  }
  return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

function toArrayBufferView(bytes) {
  return new Uint8Array(bytes).slice().buffer;
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

async function readObsHistoryRowsFromParquetBytes(bytes) {
  const file = toArrayBufferView(bytes);
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) return [];
  const [timeseriesValues, observedAtValues, valueValues] = await Promise.all([
    readParquetColumnValues(file, metadata, "timeseries_id", 0, rowCount),
    readParquetColumnValues(file, metadata, "observed_at_utc", 0, rowCount)
      .catch(() => readParquetColumnValues(file, metadata, "observed_at", 0, rowCount)),
    readParquetColumnValues(file, metadata, "value", 0, rowCount),
  ]);
  const rows = [];
  const length = Math.min(timeseriesValues.length, observedAtValues.length, valueValues.length);
  for (let i = 0; i < length; i += 1) {
    const timeseriesId = Number(timeseriesValues[i]);
    const observedAt = parseIsoTimestamp(observedAtValues[i]);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0 || !observedAt) continue;
    rows.push({
      connector_id: 0,
      timeseries_id: Math.trunc(timeseriesId),
      observed_at: observedAt,
      value: toSafeNumber(valueValues[i]),
    });
  }
  return rows;
}

async function readAqiHistoryRowsFromParquetBytes(bytes) {
  const file = toArrayBufferView(bytes);
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) return [];
  const [
    timeseriesValues,
    stationValues,
    pollutantValues,
    timestampValues,
    hourlyValues,
    rollingValues,
    sampleValues,
    daqiValues,
    eaqiValues,
  ] = await Promise.all([
    readParquetColumnValues(file, metadata, "timeseries_id", 0, rowCount),
    readParquetColumnValues(file, metadata, "station_id", 0, rowCount),
    readParquetColumnValues(file, metadata, "pollutant_code", 0, rowCount),
    readParquetColumnValues(file, metadata, "timestamp_hour_utc", 0, rowCount),
    readParquetColumnValues(file, metadata, "hourly_mean_ugm3", 0, rowCount),
    readParquetColumnValues(file, metadata, "rolling24h_mean_ugm3", 0, rowCount),
    readParquetColumnValues(file, metadata, "hourly_sample_count", 0, rowCount),
    readParquetColumnValues(file, metadata, "daqi_index_level", 0, rowCount),
    readParquetColumnValues(file, metadata, "eaqi_index_level", 0, rowCount),
  ]);

  const rows = [];
  const length = Math.min(
    timeseriesValues.length,
    stationValues.length,
    pollutantValues.length,
    timestampValues.length,
    hourlyValues.length,
    rollingValues.length,
    sampleValues.length,
    daqiValues.length,
    eaqiValues.length,
  );
  for (let i = 0; i < length; i += 1) {
    const timeseriesId = Number(timeseriesValues[i]);
    const timestamp = parseIsoTimestamp(timestampValues[i]);
    const pollutant = parsePollutantCode(pollutantValues[i]);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0 || !timestamp || !pollutant) continue;
    const stationIdRaw = Number(stationValues[i]);
    rows.push({
      connector_id: 0,
      timeseries_id: Math.trunc(timeseriesId),
      station_id: Number.isInteger(stationIdRaw) && stationIdRaw > 0 ? Math.trunc(stationIdRaw) : null,
      pollutant_code: pollutant,
      timestamp_hour_utc: timestamp,
      hourly_mean_ugm3: toSafeNumber(hourlyValues[i]),
      rolling24h_mean_ugm3: toSafeNumber(rollingValues[i]),
      hourly_sample_count: toSafeNumber(sampleValues[i]),
      daqi_index_level: toSafeNumber(daqiValues[i]),
      eaqi_index_level: toSafeNumber(eaqiValues[i]),
    });
  }
  return rows;
}

function readConnectorManifest({ dropboxRoot, domainPrefix, dayUtc, connectorId }) {
  const manifestPath = path.join(
    dropboxRoot,
    domainPrefix,
    `day_utc=${dayUtc}`,
    `connector_id=${connectorId}`,
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return { manifest: null, path: manifestPath, issue: "missing_manifest" };
  if (fs.statSync(manifestPath).size <= 0) return { manifest: null, path: manifestPath, issue: "zero_bytes_manifest" };
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return { manifest, path: manifestPath, issue: null };
  } catch (error) {
    return { manifest: null, path: manifestPath, issue: `invalid_manifest_json:${String(error)}` };
  }
}

async function loadObsRowsForDayConnector({ dropboxRoot, observationsPrefix, dayUtc, connectorId }) {
  const { manifest, issue, path: manifestPath } = readConnectorManifest({
    dropboxRoot,
    domainPrefix: observationsPrefix,
    dayUtc,
    connectorId,
  });
  if (!manifest) return { rows: null, issue, manifest_path: manifestPath };
  const keys = parseManifestParquetKeys(manifest);
  const rows = [];
  for (const key of keys) {
    const filePath = path.join(dropboxRoot, key);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) continue;
    const parsed = await readObsHistoryRowsFromParquetBytes(fs.readFileSync(filePath));
    for (const row of parsed) rows.push({ ...row, connector_id: connectorId });
  }
  return { rows, issue: null, manifest_path: manifestPath };
}

async function loadAqiRowsForDayConnector({ dropboxRoot, aqilevelsPrefix, dayUtc, connectorId }) {
  const { manifest, issue, path: manifestPath } = readConnectorManifest({
    dropboxRoot,
    domainPrefix: aqilevelsPrefix,
    dayUtc,
    connectorId,
  });
  if (!manifest) return { rows: null, issue, manifest_path: manifestPath };
  const keys = parseManifestParquetKeys(manifest);
  const rows = [];
  for (const key of keys) {
    const filePath = path.join(dropboxRoot, key);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) continue;
    const parsed = await readAqiHistoryRowsFromParquetBytes(fs.readFileSync(filePath));
    for (const row of parsed) rows.push({ ...row, connector_id: connectorId });
  }
  return { rows, issue: null, manifest_path: manifestPath };
}

function findObservationTargets({ dropboxRoot, observationsPrefix, fromDay, toDay, connectorIds, maxConnectorDays }) {
  const observationsRoot = path.join(dropboxRoot, observationsPrefix);
  if (!fs.existsSync(observationsRoot)) return [];

  const out = [];
  const dayDirs = fs.readdirSync(observationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^day_utc=\d{4}-\d{2}-\d{2}$/.test(entry.name));

  for (const dayDir of dayDirs) {
    const dayUtc = dayDir.name.slice("day_utc=".length);
    if (fromDay && dayUtc < fromDay) continue;
    if (toDay && dayUtc > toDay) continue;
    const dayPath = path.join(observationsRoot, dayDir.name);
    const connectorDirs = fs.readdirSync(dayPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^connector_id=\d+$/.test(entry.name));
    for (const connectorDir of connectorDirs) {
      const connectorId = Number(connectorDir.name.slice("connector_id=".length));
      if (!Number.isInteger(connectorId) || connectorId <= 0) continue;
      if (connectorIds.size > 0 && !connectorIds.has(connectorId)) continue;
      out.push({ day_utc: dayUtc, connector_id: Math.trunc(connectorId) });
    }
  }

  out.sort((left, right) => {
    if (left.day_utc !== right.day_utc) return left.day_utc.localeCompare(right.day_utc);
    return left.connector_id - right.connector_id;
  });
  if (maxConnectorDays > 0) {
    return out.slice(0, maxConnectorDays);
  }
  return out;
}

function buildAqiRowKey(row) {
  return `${row.timeseries_id}|${row.timestamp_hour_utc}|${row.pollutant_code}`;
}

function normalizeAqiRow(row) {
  return {
    timeseries_id: Number(row.timeseries_id),
    station_id: row.station_id === null || row.station_id === undefined ? null : Number(row.station_id),
    pollutant_code: parsePollutantCode(row.pollutant_code),
    timestamp_hour_utc: parseIsoTimestamp(row.timestamp_hour_utc),
    hourly_mean_ugm3: toSafeNumber(row.hourly_mean_ugm3),
    rolling24h_mean_ugm3: toSafeNumber(row.rolling24h_mean_ugm3),
    hourly_sample_count: toSafeNumber(row.hourly_sample_count),
    daqi_index_level: toSafeNumber(row.daqi_index_level),
    eaqi_index_level: toSafeNumber(row.eaqi_index_level),
  };
}

function floatEqual(left, right, tolerance) {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function compareAqiRows({ expectedRows, actualRows, floatTolerance, maxSamples }) {
  const expectedMap = new Map();
  const actualMap = new Map();
  for (const row of expectedRows || []) {
    const normalized = normalizeAqiRow(row);
    if (!normalized.pollutant_code || !normalized.timestamp_hour_utc) continue;
    const key = buildAqiRowKey(normalized);
    expectedMap.set(key, normalized);
  }
  for (const row of actualRows || []) {
    const normalized = normalizeAqiRow(row);
    if (!normalized.pollutant_code || !normalized.timestamp_hour_utc) continue;
    const key = buildAqiRowKey(normalized);
    actualMap.set(key, normalized);
  }

  let missingInR2 = 0;
  let extraInR2 = 0;
  let fieldMismatches = 0;
  const samples = [];

  for (const [key, expected] of expectedMap.entries()) {
    const actual = actualMap.get(key);
    if (!actual) {
      missingInR2 += 1;
      if (samples.length < maxSamples) {
        samples.push({ kind: "missing_in_r2", key, expected });
      }
      continue;
    }

    const checks = [
      ["station_id", expected.station_id, actual.station_id, "int"],
      ["hourly_sample_count", expected.hourly_sample_count, actual.hourly_sample_count, "int"],
      ["daqi_index_level", expected.daqi_index_level, actual.daqi_index_level, "int"],
      ["eaqi_index_level", expected.eaqi_index_level, actual.eaqi_index_level, "int"],
      ["hourly_mean_ugm3", expected.hourly_mean_ugm3, actual.hourly_mean_ugm3, "float"],
      ["rolling24h_mean_ugm3", expected.rolling24h_mean_ugm3, actual.rolling24h_mean_ugm3, "float"],
    ];

    for (const [field, left, right, kind] of checks) {
      let equal = false;
      if (kind === "float") {
        equal = floatEqual(left, right, floatTolerance);
      } else {
        equal = left === right;
      }
      if (!equal) {
        fieldMismatches += 1;
        if (samples.length < maxSamples) {
          samples.push({
            kind: "field_mismatch",
            key,
            field,
            expected: left,
            actual: right,
          });
        }
      }
    }
  }

  for (const [key, actual] of actualMap.entries()) {
    if (!expectedMap.has(key)) {
      extraInR2 += 1;
      if (samples.length < maxSamples) {
        samples.push({ kind: "extra_in_r2", key, actual });
      }
    }
  }

  const mismatch = missingInR2 > 0 || extraInR2 > 0 || fieldMismatches > 0;
  return {
    mismatch,
    expected_row_count: expectedMap.size,
    actual_row_count: actualMap.size,
    missing_in_r2: missingInR2,
    extra_in_r2: extraInR2,
    field_mismatches: fieldMismatches,
    samples,
  };
}

function toCsvValue(value) {
  const text = value == null ? "" : String(value);
  if (!/[,"\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => toCsvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function resolveHistoryPrefixes(historyVersion) {
  if (historyVersion === "v2") {
    return {
      observationsPrefix: normalizePrefix(
        process.env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX,
        DEFAULT_OBSERVATIONS_PREFIX_V2,
      ),
      aqilevelsPrefix: normalizePrefix(
        process.env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX,
        DEFAULT_AQILEVELS_DATA_PREFIX_V2,
      ),
      corePrefix: resolveCorePrefixForVersion(historyVersion),
    };
  }
  return {
    observationsPrefix: normalizePrefix(
      process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX,
      DEFAULT_OBSERVATIONS_PREFIX_V1,
    ),
    aqilevelsPrefix: normalizePrefix(
      process.env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX,
      DEFAULT_AQILEVELS_PREFIX_V1,
    ),
    corePrefix: resolveCorePrefixForVersion(historyVersion),
  };
}

function resolveCorePrefixForVersion(historyVersion) {
  if (historyVersion === "v2") {
    return normalizePrefix(
      process.env.UK_AQ_R2_HISTORY_V2_CORE_PREFIX,
      DEFAULT_CORE_PREFIX_V2,
    );
  }
  return normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_CORE_PREFIX,
    DEFAULT_CORE_PREFIX_V1,
  );
}

function formatWriteCommand({ dayUtc, connectorIds, backfillScript, historyVersion }) {
  const connectorCsv = connectorIds.join(",");
  return [
    `UK_AQ_R2_HISTORY_VERSION=${historyVersion}`,
    `UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels`,
    `UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only`,
    `UK_AQ_BACKFILL_DRY_RUN=false`,
    `UK_AQ_BACKFILL_FORCE_REPLACE=true`,
    `UK_AQ_BACKFILL_FROM_DAY_UTC=${dayUtc}`,
    `UK_AQ_BACKFILL_TO_DAY_UTC=${dayUtc}`,
    `UK_AQ_BACKFILL_CONNECTOR_IDS=${connectorCsv}`,
    `${backfillScript}`,
  ].join(" ");
}

function executeWriteCommands({ groupedByDay, backfillScript, repoRoot, historyVersion }) {
  const runs = [];
  for (const [dayUtc, connectorSet] of groupedByDay.entries()) {
    const connectorIds = Array.from(connectorSet).sort((left, right) => left - right);
    const env = {
      ...process.env,
      UK_AQ_R2_HISTORY_VERSION: historyVersion,
      UK_AQ_BACKFILL_RUN_MODE: "r2_history_obs_to_aqilevels",
      UK_AQ_BACKFILL_OUTPUT_SCOPE: "aqilevels_only",
      UK_AQ_BACKFILL_DRY_RUN: "false",
      UK_AQ_BACKFILL_FORCE_REPLACE: "true",
      UK_AQ_BACKFILL_FROM_DAY_UTC: dayUtc,
      UK_AQ_BACKFILL_TO_DAY_UTC: dayUtc,
      UK_AQ_BACKFILL_CONNECTOR_IDS: connectorIds.join(","),
    };

    const result = spawnSync(backfillScript, [], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    runs.push({
      day_utc: dayUtc,
      connector_ids: connectorIds,
      exit_code: Number.isFinite(result.status) ? result.status : -1,
      ok: result.status === 0,
      stderr: String(result.stderr || "").trim(),
      stdout: String(result.stdout || "").trim(),
    });
  }
  return runs;
}

function writeOutput(outPath, text) {
  process.stdout.write(text);
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const writeR2 = args.mode === "write-r2";
  const dropboxRoot = findDropboxRoot(args.root);
  if (!dropboxRoot) {
    throw new Error("No Dropbox root found. Set --root or UK_AQ_R2_HISTORY_DROPBOX_ROOT.");
  }

  const { observationsPrefix, aqilevelsPrefix, corePrefix } = resolveHistoryPrefixes(args.historyVersion);

  const bindings = loadCoreTimeseriesBindings({ dropboxRoot, corePrefix });
  const targets = findObservationTargets({
    dropboxRoot,
    observationsPrefix,
    fromDay: args.fromDay,
    toDay: args.toDay,
    connectorIds: args.connectorIds,
    maxConnectorDays: args.maxConnectorDays,
  });

  const rows = [];
  const warnings = [];
  for (const target of targets) {
    const dayUtc = target.day_utc;
    const connectorId = target.connector_id;
    const prevDay = shiftIsoDay(dayUtc, -1);

    const currentObs = await loadObsRowsForDayConnector({
      dropboxRoot,
      observationsPrefix,
      dayUtc,
      connectorId,
    });
    if (!currentObs.rows) {
      rows.push({
        day_utc: dayUtc,
        connector_id: connectorId,
        status: "obs_manifest_missing",
        mismatch: true,
        expected_row_count: 0,
        actual_row_count: 0,
        missing_in_r2: 0,
        extra_in_r2: 0,
        field_mismatches: 0,
        notes: currentObs.issue || "obs_manifest_missing",
      });
      continue;
    }

    const prevObs = await loadObsRowsForDayConnector({
      dropboxRoot,
      observationsPrefix,
      dayUtc: prevDay,
      connectorId,
    });
    const sourceObsRows = [
      ...(prevObs.rows || []),
      ...currentObs.rows,
    ];

    const mappedSourceRows = mapR2ObservationRowsToSourceObservations({
      rows: sourceObsRows,
      bindingByTimeseriesId: bindings.binding_by_timeseries_id,
      windowStartIso: addUtcHours(utcDayStartIso(dayUtc), -23),
      windowEndIso: utcDayEndIso(dayUtc),
      stationIdFilter: null,
      connectorId,
    });
    const expectedRows = buildAqilevelHistoryRowsForDayFromSourceObservations(
      mappedSourceRows,
      dayUtc,
    ).map((row) => ({ ...row, connector_id: connectorId }));

    const actualAqi = await loadAqiRowsForDayConnector({
      dropboxRoot,
      aqilevelsPrefix,
      dayUtc,
      connectorId,
    });

    if (!actualAqi.rows) {
      rows.push({
        day_utc: dayUtc,
        connector_id: connectorId,
        status: "aqi_manifest_missing",
        mismatch: true,
        expected_row_count: expectedRows.length,
        actual_row_count: 0,
        missing_in_r2: expectedRows.length,
        extra_in_r2: 0,
        field_mismatches: 0,
        notes: actualAqi.issue || "aqi_manifest_missing",
        samples_json: JSON.stringify(expectedRows.slice(0, args.maxSamples).map((row) => ({
          kind: "missing_in_r2",
          key: buildAqiRowKey(normalizeAqiRow(row)),
        }))),
      });
      continue;
    }

    const compared = compareAqiRows({
      expectedRows,
      actualRows: actualAqi.rows,
      floatTolerance: args.floatTolerance,
      maxSamples: args.maxSamples,
    });
    rows.push({
      day_utc: dayUtc,
      connector_id: connectorId,
      status: compared.mismatch ? "mismatch" : "ok",
      mismatch: compared.mismatch,
      expected_row_count: compared.expected_row_count,
      actual_row_count: compared.actual_row_count,
      missing_in_r2: compared.missing_in_r2,
      extra_in_r2: compared.extra_in_r2,
      field_mismatches: compared.field_mismatches,
      notes: "",
      samples_json: compared.samples.length ? JSON.stringify(compared.samples) : "",
    });
  }

  const mismatchRows = rows.filter((row) => row.mismatch);
  const groupedByDay = new Map();
  for (const row of mismatchRows) {
    if (!groupedByDay.has(row.day_utc)) groupedByDay.set(row.day_utc, new Set());
    groupedByDay.get(row.day_utc).add(row.connector_id);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../..");
  const backfillScriptPath = path.isAbsolute(args.backfillScript)
    ? args.backfillScript
    : path.resolve(repoRoot, args.backfillScript);
  const plannedWriteCommands = Array.from(groupedByDay.entries()).map(([dayUtc, connectorSet]) =>
    formatWriteCommand({
      dayUtc,
      connectorIds: Array.from(connectorSet).sort((left, right) => left - right),
      backfillScript: backfillScriptPath,
      historyVersion: args.historyVersion,
    }));

  let writeRuns = [];
  if (writeR2 && groupedByDay.size > 0) {
    if (!fs.existsSync(backfillScriptPath)) {
      throw new Error(`Backfill script not found: ${backfillScriptPath}`);
    }
    writeRuns = executeWriteCommands({
      groupedByDay,
      backfillScript: backfillScriptPath,
      repoRoot,
      historyVersion: args.historyVersion,
    });
  }

  const outputRows = args.includeOk ? rows : mismatchRows;
  if (args.format === "json") {
    const payload = {
      ok: true,
      mode: args.mode,
      history_version: args.historyVersion,
      dry_run: !writeR2,
      write_r2: writeR2,
      dropbox_root: dropboxRoot,
      observations_prefix: observationsPrefix,
      aqilevels_prefix: aqilevelsPrefix,
      core_prefix: corePrefix,
      core_snapshot_day_utc: bindings.snapshot_day_utc,
      connector_days_checked: rows.length,
      mismatch_connector_days: mismatchRows.length,
      mismatch_days: groupedByDay.size,
      planned_write_runs: plannedWriteCommands.length,
      planned_write_commands: args.printWriteCommands ? plannedWriteCommands : undefined,
      write_runs: writeRuns,
      warnings,
      rows: outputRows,
    };
    writeOutput(args.outPath, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const csvColumns = [
    "day_utc",
    "connector_id",
    "status",
    "expected_row_count",
    "actual_row_count",
    "missing_in_r2",
    "extra_in_r2",
    "field_mismatches",
    "notes",
    "samples_json",
  ];
  const csvText = toCsv(outputRows, csvColumns);
  if (args.printWriteCommands && plannedWriteCommands.length > 0) {
    const commandsBlock = plannedWriteCommands.map((line) => `# ${line}`).join("\n");
    writeOutput(args.outPath, `${csvText}${commandsBlock}\n`);
    return;
  }
  writeOutput(args.outPath, csvText);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exit(1);
});
