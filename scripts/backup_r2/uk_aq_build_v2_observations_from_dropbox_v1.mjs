#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { parquetMetadataAsync, parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  buildHistoryV2ConnectorManifestForTest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifestForTest,
  buildHistoryV2DayManifestKey,
  buildHistoryV2PartKey,
  buildHistoryV2PollutantManifestForTest,
  buildHistoryV2PollutantManifestKey,
  rowsToObservationV2ParquetBufferForTest,
} from "../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  hasRequiredR2Config,
  r2HeadObject,
  r2PutObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";

const DEFAULT_SOURCE_OBSERVATIONS_PREFIX = "history/v1/observations";
const DEFAULT_SOURCE_CORE_PREFIX = "history/v1/core";
const DEFAULT_TARGET_OBSERVATIONS_PREFIX = "history/v2/observations";
const DEFAULT_PART_MAX_ROWS = 500_000;
const DEFAULT_MAX_CONNECTOR_DAYS = 0;

function buildDefaultDropboxLocalBackupRoot() {
  const dropboxRoot = String(process.env.UK_AQ_DROPBOX_ROOT || "").trim() || "CIC-Test";
  return `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/${dropboxRoot}/R2_history_backup`;
}

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs [options]",
    "",
    "Purpose:",
    "  Build history/v2/observations in R2 from the local Dropbox v1 observations mirror.",
    "  This script never writes parquet files into the Dropbox mirror.",
    "",
    "Default mode:",
    "  Dry-run report only. Use --write-r2 to upload v2 parquet and manifests to R2.",
    "",
    "Options:",
    "  --root <path>                 Local R2 Dropbox backup root",
    "  --from-day <YYYY-MM-DD>       Inclusive source day lower bound",
    "  --to-day <YYYY-MM-DD>         Inclusive source day upper bound",
    "  --connector-id <id>           Optional connector filter (repeatable)",
    "  --max-connector-days <n>      Cap connector-day builds (0=all, default 0)",
    "  --source-prefix <prefix>      Source observations prefix (default history/v1/observations)",
    "  --core-prefix <prefix>        Source core prefix (default UK_AQ_R2_HISTORY_V2_CORE_PREFIX, then v1 core)",
    "  --target-prefix <prefix>      Target v2 observations prefix (default history/v2/observations)",
    "  --part-max-rows <n>           Max rows per v2 parquet part (default 500000)",
    "  --dry-run                     Explicit no-write mode (default)",
    "  --write-r2                    Upload v2 observations parquet/manifests to R2",
    "  --replace                     Replace existing target pollutant manifests",
    "  --report-out <path>           Write JSON report as well as stdout",
    "  -h, --help                    Show this help",
    "",
    "Required env for --write-r2:",
    "  CFLARE_R2_ENDPOINT",
    "  CFLARE_R2_BUCKET or R2_BUCKET",
    "  CFLARE_R2_REGION",
    "  CFLARE_R2_ACCESS_KEY_ID",
    "  CFLARE_R2_SECRET_ACCESS_KEY",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    root: "",
    fromDay: "",
    toDay: "",
    connectorIds: new Set(),
    maxConnectorDays: DEFAULT_MAX_CONNECTOR_DAYS,
    sourcePrefix: process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || DEFAULT_SOURCE_OBSERVATIONS_PREFIX,
    corePrefix:
      process.env.UK_AQ_R2_HISTORY_V2_CORE_PREFIX ||
      process.env.UK_AQ_R2_HISTORY_CORE_PREFIX ||
      DEFAULT_SOURCE_CORE_PREFIX,
    targetPrefix: process.env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || DEFAULT_TARGET_OBSERVATIONS_PREFIX,
    partMaxRows: DEFAULT_PART_MAX_ROWS,
    mode: "dry-run",
    sawDryRun: false,
    sawWriteR2: false,
    replace: false,
    reportOut: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--from-day") {
      args.fromDay = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--to-day") {
      args.toDay = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--connector-id") {
      args.connectorIds.add(parsePositiveInt(argv[i + 1], "--connector-id"));
      i += 1;
    } else if (arg === "--max-connector-days") {
      args.maxConnectorDays = parseNonNegativeInt(argv[i + 1], "--max-connector-days");
      i += 1;
    } else if (arg === "--source-prefix") {
      args.sourcePrefix = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--core-prefix") {
      args.corePrefix = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--target-prefix") {
      args.targetPrefix = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--part-max-rows") {
      args.partMaxRows = parsePositiveInt(argv[i + 1], "--part-max-rows");
      i += 1;
    } else if (arg === "--dry-run") {
      args.mode = "dry-run";
      args.sawDryRun = true;
    } else if (arg === "--write-r2") {
      args.mode = "write-r2";
      args.sawWriteR2 = true;
    } else if (arg === "--replace") {
      args.replace = true;
    } else if (arg === "--report-out") {
      args.reportOut = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (args.sawDryRun && args.sawWriteR2) {
    throw new Error("Use either --dry-run or --write-r2, not both");
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

  args.sourcePrefix = normalizePrefix(args.sourcePrefix, DEFAULT_SOURCE_OBSERVATIONS_PREFIX);
  args.corePrefix = normalizePrefix(args.corePrefix, DEFAULT_SOURCE_CORE_PREFIX);
  args.targetPrefix = normalizePrefix(args.targetPrefix, DEFAULT_TARGET_OBSERVATIONS_PREFIX);
  return args;
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

function parseIsoDayUtc(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === text ? text : null;
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
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePrefix(rawValue, fallbackValue) {
  const prefix = String(rawValue || fallbackValue || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("Invalid empty prefix");
  return prefix;
}

function normalizePollutantCode(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "no2" || value.includes("nitrogen")) return "no2";
  if (value === "pm25" || value === "pm2.5" || value === "pm_25") return "pm25";
  if (value === "pm10" || value === "pm_10") return "pm10";
  if (value.includes("pm2.5") || value.includes("pm25") || value.includes("2_5")) return "pm25";
  if (value.includes("pm10")) return "pm10";
  if (value.includes("no2")) return "no2";
  return null;
}

function findDropboxRoot(cliValue) {
  const candidates = [
    String(cliValue || "").trim(),
    String(process.env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || "").trim(),
    String(process.env.UK_AQ_R2_HISTORY_DROPBOX_LOCAL_ROOT || "").trim(),
    buildDefaultDropboxLocalBackupRoot(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return "";
}

function buildR2Config() {
  return {
    endpoint: String(process.env.CFLARE_R2_ENDPOINT || process.env.R2_ENDPOINT || "").trim(),
    bucket: String(process.env.CFLARE_R2_BUCKET || process.env.R2_BUCKET || "").trim(),
    region: String(process.env.CFLARE_R2_REGION || process.env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(process.env.CFLARE_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(process.env.CFLARE_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "").trim(),
  };
}

function readNdjsonGz(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) return [];
  const text = zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed));
  }
  return rows;
}

function loadCoreTimeseriesBindings({ dropboxRoot, corePrefix, maxDayUtc = "" }) {
  const coreRoot = path.join(dropboxRoot, corePrefix);
  if (!fs.existsSync(coreRoot)) {
    throw new Error(`Core prefix not found in Dropbox root: ${coreRoot}`);
  }
  const dayEntries = fs.readdirSync(coreRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^day_utc=\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name.slice("day_utc=".length))
    .filter((dayUtc) => !maxDayUtc || dayUtc <= maxDayUtc)
    .sort((left, right) => right.localeCompare(left));

  for (const dayUtc of dayEntries) {
    const snapshotRoot = path.join(coreRoot, `day_utc=${dayUtc}`);
    const timeseriesPath = path.join(snapshotRoot, "table=timeseries", "rows.ndjson.gz");
    if (!fs.existsSync(timeseriesPath) || fs.statSync(timeseriesPath).size <= 0) continue;

    const lookupRows = [
      ...readNdjsonGz(path.join(snapshotRoot, "table=phenomena", "rows.ndjson.gz")),
      ...readNdjsonGz(path.join(snapshotRoot, "table=observed_properties", "rows.ndjson.gz")),
    ];
    const pollutantById = new Map();
    for (const row of lookupRows) {
      const id = Number(row?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const pollutant = normalizePollutantCode(
        row?.code || row?.pollutant_code || row?.phenomenon_code || row?.label || row?.display_name || row?.name,
      );
      if (pollutant) pollutantById.set(Math.trunc(id), pollutant);
    }

    const bindings = new Map();
    for (const row of readNdjsonGz(timeseriesPath)) {
      const timeseriesId = Number(row?.id ?? row?.timeseries_id);
      const stationId = Number(row?.station_id);
      if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) continue;
      if (!Number.isInteger(stationId) || stationId <= 0) continue;
      const connectorId = Number(row?.connector_id);
      const lookupId = Number(row?.phenomenon_id ?? row?.observed_property_id);
      const pollutant = normalizePollutantCode(
        row?.pollutant_code ||
          row?.phenomenon_code ||
          row?.observed_property_code ||
          row?.pollutant ||
          (Number.isInteger(lookupId) ? pollutantById.get(Math.trunc(lookupId)) : null) ||
          row?.timeseries_ref ||
          row?.label ||
          row?.display_name,
      );
      if (!pollutant) continue;
      bindings.set(Math.trunc(timeseriesId), {
        timeseries_id: Math.trunc(timeseriesId),
        station_id: Math.trunc(stationId),
        connector_id: Number.isInteger(connectorId) && connectorId > 0 ? Math.trunc(connectorId) : null,
        pollutant_code: pollutant,
      });
    }
    if (bindings.size > 0) {
      return { snapshot_day_utc: dayUtc, binding_by_timeseries_id: bindings };
    }
  }
  throw new Error("No usable core timeseries snapshot found in Dropbox backup.");
}

function parseManifestParquetKeys(manifest) {
  const keys = new Set();
  for (const keyRaw of Array.isArray(manifest?.parquet_object_keys) ? manifest.parquet_object_keys : []) {
    const key = String(keyRaw || "").trim();
    if (key) keys.add(key);
  }
  for (const fileEntry of Array.isArray(manifest?.files) ? manifest.files : []) {
    const key = String(fileEntry?.key || "").trim();
    if (key) keys.add(key);
  }
  return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

function readConnectorManifest({ dropboxRoot, sourcePrefix, dayUtc, connectorId }) {
  const manifestPath = path.join(
    dropboxRoot,
    sourcePrefix,
    `day_utc=${dayUtc}`,
    `connector_id=${connectorId}`,
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return { manifest: null, path: manifestPath, issue: "missing_manifest" };
  if (fs.statSync(manifestPath).size <= 0) return { manifest: null, path: manifestPath, issue: "zero_bytes_manifest" };
  try {
    return { manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")), path: manifestPath, issue: null };
  } catch (error) {
    return { manifest: null, path: manifestPath, issue: `invalid_manifest_json:${String(error)}` };
  }
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

async function readV1ObservationRowsFromParquetBytes(bytes) {
  const file = toArrayBufferView(bytes);
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) return [];
  const [connectorValues, timeseriesValues, observedAtValues, valueValues] = await Promise.all([
    readParquetColumnValues(file, metadata, "connector_id", 0, rowCount).catch(() => []),
    readParquetColumnValues(file, metadata, "timeseries_id", 0, rowCount),
    readParquetColumnValues(file, metadata, "observed_at", 0, rowCount),
    readParquetColumnValues(file, metadata, "value", 0, rowCount),
  ]);
  const rows = [];
  const length = Math.min(timeseriesValues.length, observedAtValues.length, valueValues.length);
  for (let i = 0; i < length; i += 1) {
    const timeseriesId = Number(timeseriesValues[i]);
    const observedAtUtc = parseIsoTimestamp(observedAtValues[i]);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0 || !observedAtUtc) continue;
    const connectorId = Number(connectorValues[i]);
    rows.push({
      connector_id: Number.isInteger(connectorId) && connectorId > 0 ? Math.trunc(connectorId) : null,
      timeseries_id: Math.trunc(timeseriesId),
      observed_at_utc: observedAtUtc,
      value: toSafeNumber(valueValues[i]),
    });
  }
  return rows;
}

async function loadV1RowsForConnectorDay({ dropboxRoot, sourcePrefix, dayUtc, connectorId }) {
  const { manifest, issue, path: manifestPath } = readConnectorManifest({
    dropboxRoot,
    sourcePrefix,
    dayUtc,
    connectorId,
  });
  if (!manifest) return { rows: null, manifest_path: manifestPath, issue };
  const rows = [];
  for (const key of parseManifestParquetKeys(manifest)) {
    const filePath = path.join(dropboxRoot, key);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) continue;
    const parsed = await readV1ObservationRowsFromParquetBytes(fs.readFileSync(filePath));
    for (const row of parsed) rows.push({ ...row, connector_id: connectorId });
  }
  return { rows, manifest_path: manifestPath, issue: null };
}

function convertV1ObservationRowsToV2({ rows, bindingByTimeseriesId, connectorId }) {
  const converted = [];
  let missingMetadata = 0;
  for (const row of rows || []) {
    const timeseriesId = Number(row?.timeseries_id);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) continue;
    const binding = bindingByTimeseriesId.get(Math.trunc(timeseriesId));
    if (!binding) {
      missingMetadata += 1;
      continue;
    }
    const observedAtUtc = parseIsoTimestamp(row?.observed_at_utc || row?.observed_at);
    if (!observedAtUtc) continue;
    const resolvedConnectorId = Number(connectorId || row?.connector_id || binding.connector_id);
    converted.push({
      connector_id: Number.isInteger(resolvedConnectorId) && resolvedConnectorId > 0
        ? Math.trunc(resolvedConnectorId)
        : Math.trunc(connectorId),
      station_id: binding.station_id,
      timeseries_id: Math.trunc(timeseriesId),
      pollutant_code: binding.pollutant_code,
      observed_at_utc: observedAtUtc,
      value: toSafeNumber(row?.value),
    });
  }
  return { rows: converted, missing_metadata_rows: missingMetadata };
}

function findObservationTargets({ dropboxRoot, sourcePrefix, fromDay, toDay, connectorIds, maxConnectorDays }) {
  const observationsRoot = path.join(dropboxRoot, sourcePrefix);
  if (!fs.existsSync(observationsRoot)) return [];
  const targets = [];
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
      targets.push({ day_utc: dayUtc, connector_id: Math.trunc(connectorId) });
    }
  }
  targets.sort((left, right) => {
    if (left.day_utc !== right.day_utc) return left.day_utc.localeCompare(right.day_utc);
    return left.connector_id - right.connector_id;
  });
  return maxConnectorDays > 0 ? targets.slice(0, maxConnectorDays) : targets;
}

function groupRowsByPollutant(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const pollutant = normalizePollutantCode(row.pollutant_code);
    if (!pollutant) continue;
    if (!grouped.has(pollutant)) grouped.set(pollutant, []);
    grouped.get(pollutant).push({ ...row, pollutant_code: pollutant });
  }
  return grouped;
}

function chunkRows(rows, maxRows) {
  const out = [];
  for (let i = 0; i < rows.length; i += maxRows) {
    out.push(rows.slice(i, i + maxRows));
  }
  return out;
}

function summarizePartRows(rows) {
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let minObservedAtUtc = null;
  let maxObservedAtUtc = null;
  const timeseriesRowCounts = {};
  for (const row of rows) {
    const timeseriesId = Number(row.timeseries_id);
    if (Number.isInteger(timeseriesId) && timeseriesId > 0) {
      const normalized = Math.trunc(timeseriesId);
      minTimeseriesId = minTimeseriesId === null ? normalized : Math.min(minTimeseriesId, normalized);
      maxTimeseriesId = maxTimeseriesId === null ? normalized : Math.max(maxTimeseriesId, normalized);
      timeseriesRowCounts[String(normalized)] = (timeseriesRowCounts[String(normalized)] || 0) + 1;
    }
    const observedAt = parseIsoTimestamp(row.observed_at_utc);
    if (observedAt) {
      minObservedAtUtc = !minObservedAtUtc || observedAt < minObservedAtUtc ? observedAt : minObservedAtUtc;
      maxObservedAtUtc = !maxObservedAtUtc || observedAt > maxObservedAtUtc ? observedAt : maxObservedAtUtc;
    }
  }
  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_observed_at_utc: minObservedAtUtc,
    max_observed_at_utc: maxObservedAtUtc,
    timeseries_row_counts: timeseriesRowCounts,
  };
}

async function buildConnectorDayPlan({ targetPrefix, dayUtc, connectorId, rows, partMaxRows }) {
  const rowsByPollutant = groupRowsByPollutant(rows);
  const pollutantPlans = [];
  for (const [pollutantCode, pollutantRowsRaw] of rowsByPollutant.entries()) {
    const pollutantRows = [...pollutantRowsRaw].sort((left, right) => {
      if (left.timeseries_id !== right.timeseries_id) return left.timeseries_id - right.timeseries_id;
      return left.observed_at_utc.localeCompare(right.observed_at_utc);
    });
    const fileEntries = [];
    const parts = [];
    for (const [partIndex, chunk] of chunkRows(pollutantRows, partMaxRows).entries()) {
      const body = rowsToObservationV2ParquetBufferForTest(chunk);
      const key = buildHistoryV2PartKey(targetPrefix, dayUtc, connectorId, pollutantCode, partIndex);
      const summary = summarizePartRows(chunk);
      const entry = {
        key,
        row_count: chunk.length,
        bytes: body.byteLength,
        etag_or_hash: sha256Hex(body),
        ...summary,
      };
      fileEntries.push(entry);
      parts.push({ key, body, entry });
    }
    const manifestKey = buildHistoryV2PollutantManifestKey(targetPrefix, dayUtc, connectorId, pollutantCode);
    const pollutantManifest = buildHistoryV2PollutantManifestForTest({
      domain: "observations",
      dayUtc,
      connectorId,
      pollutantCode,
      manifestKey,
      sourceRowCount: pollutantRows.length,
      fileEntries,
      writerGitSha: process.env.GITHUB_SHA || null,
      backedUpAtUtc: new Date().toISOString(),
    });
    pollutantPlans.push({ pollutant_code: pollutantCode, manifest_key: manifestKey, manifest: pollutantManifest, parts });
  }
  const connectorManifestKey = buildHistoryV2ConnectorManifestKey(targetPrefix, dayUtc, connectorId);
  const connectorManifest = buildHistoryV2ConnectorManifestForTest({
    domain: "observations",
    dayUtc,
    connectorId,
    manifestKey: connectorManifestKey,
    pollutantManifests: pollutantPlans.map((plan) => plan.manifest),
    writerGitSha: process.env.GITHUB_SHA || null,
    backedUpAtUtc: new Date().toISOString(),
  });
  return {
    day_utc: dayUtc,
    connector_id: connectorId,
    row_count: rows.length,
    pollutant_plans: pollutantPlans,
    connector_manifest_key: connectorManifestKey,
    connector_manifest: connectorManifest,
  };
}

async function writeConnectorDayPlanToR2({ r2, plan, replace }) {
  const skipped = [];
  let objectsWritten = 0;
  const writablePollutantPlans = [];
  for (const pollutantPlan of plan.pollutant_plans) {
    if (!replace) {
      const head = await r2HeadObject({ r2, key: pollutantPlan.manifest_key });
      if (head.exists) {
        skipped.push({
          pollutant_code: pollutantPlan.pollutant_code,
          manifest_key: pollutantPlan.manifest_key,
          reason: "target_manifest_exists",
        });
        continue;
      }
    }
    writablePollutantPlans.push(pollutantPlan);
  }
  for (const pollutantPlan of writablePollutantPlans) {
    for (const part of pollutantPlan.parts) {
      await r2PutObject({
        r2,
        key: part.key,
        body: part.body,
        content_type: "application/vnd.apache.parquet",
      });
      objectsWritten += 1;
    }
    await r2PutObject({
      r2,
      key: pollutantPlan.manifest_key,
      body: `${JSON.stringify(pollutantPlan.manifest, null, 2)}\n`,
      content_type: "application/json",
    });
    objectsWritten += 1;
  }
  if (writablePollutantPlans.length > 0 || replace) {
    await r2PutObject({
      r2,
      key: plan.connector_manifest_key,
      body: `${JSON.stringify(plan.connector_manifest, null, 2)}\n`,
      content_type: "application/json",
    });
    objectsWritten += 1;
  }
  return { objects_written_r2: objectsWritten, skipped_pollutants: skipped };
}

async function refreshDayManifests({ r2, targetPrefix, dayPlansByDay, writeR2, replace }) {
  const dayReports = [];
  for (const [dayUtc, connectorPlans] of dayPlansByDay.entries()) {
    const dayManifestKey = buildHistoryV2DayManifestKey(targetPrefix, dayUtc);
    const dayManifest = buildHistoryV2DayManifestForTest({
      domain: "observations",
      dayUtc,
      manifestKey: dayManifestKey,
      connectorManifests: connectorPlans.map((plan) => plan.connector_manifest),
      writerGitSha: process.env.GITHUB_SHA || null,
      backedUpAtUtc: new Date().toISOString(),
    });
    let written = false;
    let skipped = false;
    if (writeR2) {
      const existing = await r2HeadObject({ r2, key: dayManifestKey });
      if (existing.exists && !replace) {
        skipped = true;
      } else {
        await r2PutObject({
          r2,
          key: dayManifestKey,
          body: `${JSON.stringify(dayManifest, null, 2)}\n`,
          content_type: "application/json",
        });
        written = true;
      }
    }
    dayReports.push({
      day_utc: dayUtc,
      manifest_key: dayManifestKey,
      connector_count: connectorPlans.length,
      row_count: dayManifest.row_count,
      file_count: dayManifest.file_count,
      written,
      skipped,
      skip_reason: skipped ? "target_day_manifest_exists" : null,
    });
  }
  return dayReports;
}

async function runBuild(args) {
  const writeR2 = args.mode === "write-r2";
  const r2 = buildR2Config();
  if (writeR2 && !hasRequiredR2Config(r2)) {
    throw new Error("R2 credentials are required for --write-r2.");
  }
  const dropboxRoot = findDropboxRoot(args.root);
  if (!dropboxRoot) {
    throw new Error("No Dropbox root found. Set --root or UK_AQ_R2_HISTORY_DROPBOX_ROOT.");
  }
  const bindings = loadCoreTimeseriesBindings({
    dropboxRoot,
    corePrefix: args.corePrefix,
    maxDayUtc: args.toDay || "",
  });
  const targets = findObservationTargets({
    dropboxRoot,
    sourcePrefix: args.sourcePrefix,
    fromDay: args.fromDay,
    toDay: args.toDay,
    connectorIds: args.connectorIds,
    maxConnectorDays: args.maxConnectorDays,
  });

  const dayPlansByDay = new Map();
  const connectorReports = [];
  let rowsRead = 0;
  let rowsConverted = 0;
  let rowsMissingMetadata = 0;
  let parquetFilesPlanned = 0;
  let parquetBytesPlanned = 0;
  let objectsWritten = 0;

  for (const target of targets) {
    const loaded = await loadV1RowsForConnectorDay({
      dropboxRoot,
      sourcePrefix: args.sourcePrefix,
      dayUtc: target.day_utc,
      connectorId: target.connector_id,
    });
    if (!loaded.rows) {
      connectorReports.push({
        ...target,
        status: "skipped",
        issue: loaded.issue,
        rows_read: 0,
        rows_converted: 0,
        objects_written_r2: 0,
      });
      continue;
    }
    rowsRead += loaded.rows.length;
    const converted = convertV1ObservationRowsToV2({
      rows: loaded.rows,
      bindingByTimeseriesId: bindings.binding_by_timeseries_id,
      connectorId: target.connector_id,
    });
    rowsConverted += converted.rows.length;
    rowsMissingMetadata += converted.missing_metadata_rows;
    if (!converted.rows.length) {
      connectorReports.push({
        ...target,
        status: "skipped",
        issue: "no_rows_after_v2_metadata_mapping",
        rows_read: loaded.rows.length,
        rows_converted: 0,
        missing_metadata_rows: converted.missing_metadata_rows,
        objects_written_r2: 0,
      });
      continue;
    }
    const plan = await buildConnectorDayPlan({
      targetPrefix: args.targetPrefix,
      dayUtc: target.day_utc,
      connectorId: target.connector_id,
      rows: converted.rows,
      partMaxRows: args.partMaxRows,
    });
    parquetFilesPlanned += plan.pollutant_plans.reduce((sum, item) => sum + item.parts.length, 0);
    parquetBytesPlanned += plan.pollutant_plans.reduce((sum, item) =>
      sum + item.parts.reduce((partSum, part) => partSum + part.body.byteLength, 0), 0);

    let writeResult = { objects_written_r2: 0, skipped_pollutants: [] };
    if (writeR2) {
      writeResult = await writeConnectorDayPlanToR2({ r2, plan, replace: args.replace });
      objectsWritten += writeResult.objects_written_r2;
    }
    if (!dayPlansByDay.has(target.day_utc)) dayPlansByDay.set(target.day_utc, []);
    dayPlansByDay.get(target.day_utc).push(plan);
    connectorReports.push({
      ...target,
      status: writeR2 ? "complete" : "dry_run",
      rows_read: loaded.rows.length,
      rows_converted: converted.rows.length,
      missing_metadata_rows: converted.missing_metadata_rows,
      pollutant_codes: plan.pollutant_plans.map((item) => item.pollutant_code),
      parquet_files: plan.pollutant_plans.reduce((sum, item) => sum + item.parts.length, 0),
      connector_manifest_key: plan.connector_manifest_key,
      objects_written_r2: writeResult.objects_written_r2,
      skipped_pollutants: writeResult.skipped_pollutants,
    });
  }

  const dayReports = await refreshDayManifests({
    r2,
    targetPrefix: args.targetPrefix,
    dayPlansByDay,
    writeR2,
    replace: args.replace,
  });
  if (writeR2) objectsWritten += dayReports.filter((report) => report.written).length;

  return {
    ok: true,
    mode: args.mode,
    dry_run: !writeR2,
    write_r2: writeR2,
    replace: args.replace,
    dropbox_root: dropboxRoot,
    source_observations_prefix: args.sourcePrefix,
    source_core_prefix: args.corePrefix,
    target_observations_prefix: args.targetPrefix,
    core_snapshot_day_utc: bindings.snapshot_day_utc,
    connector_days_discovered: targets.length,
    connector_days_planned: connectorReports.length,
    rows_read: rowsRead,
    rows_converted_v2: rowsConverted,
    rows_missing_metadata: rowsMissingMetadata,
    parquet_files_planned: parquetFilesPlanned,
    parquet_bytes_planned: parquetBytesPlanned,
    objects_written_r2: objectsWritten,
    day_manifests: dayReports,
    connector_days: connectorReports,
  };
}

function writeReport(outPath, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  process.stdout.write(text);
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runBuild(args);
  writeReport(args.reportOut, report);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    process.exit(1);
  });
}

export {
  buildConnectorDayPlan,
  convertV1ObservationRowsToV2,
  normalizePollutantCode,
  parseArgs,
  runBuild,
};
