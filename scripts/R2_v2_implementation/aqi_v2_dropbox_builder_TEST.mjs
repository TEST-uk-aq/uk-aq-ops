#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import { parquetMetadataAsync, parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import * as parquetWasm from "parquet-wasm/esm";
import {
  buildAqilevelHistoryRowsForDayFromSourceObservations,
  normalizePollutantCode,
} from "../../lib/aqi/aqi_levels.mjs";
import { sha256Hex } from "../../workers/shared/r2_sigv4.mjs";
import {
  buildHistoryV2ConnectorManifestForTest,
  buildHistoryV2DayManifestForTest,
  buildHistoryV2PollutantManifestForTest,
  rowsToAqilevelDataV2ParquetBufferForTest,
  rowsToAqilevelDebugV2ParquetBufferForTest,
} from "../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

const DEFAULT_SOURCE_ROOT =
  "/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup";
const DEFAULT_WORK_ROOT = path.join(os.homedir(), "uk-aq-work", "aqilevels-v2-rebuild");
const DEFAULT_R2_TARGET = "uk_aq_r2:uk-aq-history-cic-test";
const OBS_PREFIX = "history/v2/observations";
const AQI_DATA_PREFIX = "history/v2/aqilevels/hourly/data";
const AQI_DEBUG_PREFIX = "history/v2/aqilevels/hourly/debug";
const CONFIRMATION = "REBUILD TEST AQI V2 LOCAL";
const AQI_SUPPORTED_POLLUTANTS = new Set(["no2", "pm25", "pm10"]);

let parquetWasmReady = false;

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function normalizeAbs(inputPath) {
  return path.resolve(String(inputPath || "").replace(/^~(?=$|\/)/, os.homedir()));
}

function isIsoDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
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

function toIso(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
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

function normalizeV2ObservationPollutant(raw) {
  const supported = normalizePollutantCode(raw);
  if (supported) return supported;
  const compact = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact === "o3" || compact === "ozone" || compact === "ozoneair") return "o3";
  return null;
}

async function readV2ObservationParquet(filePath, connectorId, counters) {
  const bytes = await fsp.readFile(filePath);
  const arrayBuffer = new Uint8Array(bytes).slice().buffer;
  const metadata = await parquetMetadataAsync(arrayBuffer);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) return [];

  const [connectorValues, stationValues, timeseriesValues, pollutantValues, observedValues, valueValues] = await Promise.all([
    readParquetColumnValues(arrayBuffer, metadata, "connector_id", 0, rowCount),
    readParquetColumnValues(arrayBuffer, metadata, "station_id", 0, rowCount),
    readParquetColumnValues(arrayBuffer, metadata, "timeseries_id", 0, rowCount),
    readParquetColumnValues(arrayBuffer, metadata, "pollutant_code", 0, rowCount),
    readParquetColumnValues(arrayBuffer, metadata, "observed_at_utc", 0, rowCount),
    readParquetColumnValues(arrayBuffer, metadata, "value", 0, rowCount),
  ]);

  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    counters.rows_read_observations += 1;
    const rowConnectorId = Number(connectorValues[index]);
    const stationId = Number(stationValues[index]);
    const timeseriesId = Number(timeseriesValues[index]);
    const pollutantCode = normalizeV2ObservationPollutant(pollutantValues[index]);
    const observedAt = toIso(observedValues[index]);
    const value = Number(valueValues[index]);
    const rawPollutant = String(pollutantValues[index] || "").trim() || "unknown";
    counters.pollutant_row_counts[rawPollutant] = (counters.pollutant_row_counts[rawPollutant] || 0) + 1;

    if (rowConnectorId !== connectorId || !Number.isInteger(stationId) || stationId <= 0 || !Number.isInteger(timeseriesId) || timeseriesId <= 0 || !pollutantCode || !observedAt || !Number.isFinite(value)) {
      counters.rows_skipped_invalid += 1;
      continue;
    }

    if (!AQI_SUPPORTED_POLLUTANTS.has(pollutantCode)) {
      counters.rows_skipped_unsupported_pollutant += 1;
      continue;
    }

    rows.push({
      connector_id: rowConnectorId,
      station_id: stationId,
      timeseries_id: timeseriesId,
      pollutant_code: pollutantCode,
      observed_at: observedAt,
      value,
    });
  }
  return rows;
}

async function connectorIdsForDay(sourceRoot, dayUtc) {
  const dayRoot = path.join(sourceRoot, OBS_PREFIX, `day_utc=${dayUtc}`);
  const manifestPath = path.join(dayRoot, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = await readJson(manifestPath);
    const ids = Array.isArray(manifest.connector_ids) ? manifest.connector_ids : [];
    if (ids.length) return ids.map(Number).filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  }
  if (!fs.existsSync(dayRoot)) return [];
  const entries = await fsp.readdir(dayRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^connector_id=\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice("connector_id=".length)))
    .sort((a, b) => a - b);
}

async function v2ObservationPartPathsForConnectorDay(sourceRoot, dayUtc, connectorId) {
  const connectorRoot = path.join(sourceRoot, OBS_PREFIX, `day_utc=${dayUtc}`, `connector_id=${connectorId}`);
  if (!fs.existsSync(connectorRoot)) return [];

  const manifestPath = path.join(connectorRoot, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = await readJson(manifestPath);
    const keys = new Set();
    if (Array.isArray(manifest.parquet_object_keys)) {
      for (const key of manifest.parquet_object_keys) keys.add(key);
    }
    if (Array.isArray(manifest.files)) {
      for (const file of manifest.files) if (file?.key) keys.add(file.key);
    }
    if (Array.isArray(manifest.pollutant_manifests)) {
      for (const item of manifest.pollutant_manifests) {
        const childPath = item?.manifest_key ? path.join(sourceRoot, item.manifest_key) : null;
        if (childPath && fs.existsSync(childPath)) {
          const child = await readJson(childPath);
          for (const key of child.parquet_object_keys || []) keys.add(key);
          for (const file of child.files || []) if (file?.key) keys.add(file.key);
        }
      }
    }
    const fromManifest = Array.from(keys).filter((key) => key.endsWith(".parquet")).map((key) => path.join(sourceRoot, key));
    if (fromManifest.length) return fromManifest.sort();
  }

  const found = [];
  const stack = [connectorRoot];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".parquet")) found.push(fullPath);
    }
  }
  return found.sort();
}

async function loadSourceObservationsForTargetDay({ sourceRoot, dayUtc, connectorId, counters }) {
  const daysToRead = [shiftDay(dayUtc, -1), dayUtc];
  const rows = [];
  for (const sourceDay of daysToRead) {
    const partPaths = await v2ObservationPartPathsForConnectorDay(sourceRoot, sourceDay, connectorId);
    for (const partPath of partPaths) {
      if (!fs.existsSync(partPath)) continue;
      const partRows = await readV2ObservationParquet(partPath, connectorId, counters);
      for (const row of partRows) rows.push(row);
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

async function rowsToAqiParquetBuffer(rows, objectType) {
  if (objectType === "data") return rowsToAqilevelDataV2ParquetBufferForTest(rows);
  if (objectType === "debug") return rowsToAqilevelDebugV2ParquetBufferForTest(rows);
  throw new Error(`Unsupported AQI v2 object type: ${objectType}`);
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

function groupRowsByPollutant(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.pollutant_code;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

async function writeConnectorOutputForPrefix({ workRoot, prefix, dayUtc, connectorId, runId, rows, computedAtUtc, objectType }) {
  const pollutantManifests = [];
  for (const [pollutantCode, pollutantRows] of groupRowsByPollutant(rows)) {
    const pollutantRelPrefix = `${prefix}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
    const pollutantDir = path.join(workRoot, pollutantRelPrefix);
    await fsp.mkdir(pollutantDir, { recursive: true });
    const partRelKey = `${pollutantRelPrefix}/part-00000.parquet`;
    const partPath = path.join(workRoot, partRelKey);
    const parquetBuffer = await rowsToAqiParquetBuffer(pollutantRows, objectType);
    await fsp.writeFile(partPath, parquetBuffer);
    const summary = summarizeRows(pollutantRows);
    const fileEntry = {
      key: partRelKey,
      row_count: pollutantRows.length,
      bytes: parquetBuffer.length,
      etag_or_hash: sha256Hex(parquetBuffer),
      ...summary,
    };
    const manifestRelKey = `${pollutantRelPrefix}/manifest.json`;
    const manifest = buildHistoryV2PollutantManifestForTest({
      domain: "aqilevels",
      grain: "hourly",
      profile: objectType,
      dayUtc,
      connectorId,
      pollutantCode,
      runId,
      manifestKey: manifestRelKey,
      sourceRowCount: pollutantRows.length,
      fileEntries: [fileEntry],
      writerGitSha: null,
      backedUpAtUtc: computedAtUtc,
    });
    await writeJson(path.join(workRoot, manifestRelKey), manifest);
    pollutantManifests.push(manifest);
  }

  const connectorRelPrefix = `${prefix}/day_utc=${dayUtc}/connector_id=${connectorId}`;
  const connectorManifestRelKey = `${connectorRelPrefix}/manifest.json`;
  const connectorManifest = buildHistoryV2ConnectorManifestForTest({
    domain: "aqilevels",
    grain: "hourly",
    profile: objectType,
    dayUtc,
    connectorId,
    runId,
    manifestKey: connectorManifestRelKey,
    pollutantManifests,
    writerGitSha: null,
    backedUpAtUtc: computedAtUtc,
  });
  await writeJson(path.join(workRoot, connectorManifestRelKey), connectorManifest);
  return connectorManifest;
}

function manifestTreeObjectKeys(manifest) {
  const keys = new Set();
  if (manifest?.manifest_key) keys.add(manifest.manifest_key);
  for (const key of manifest?.parquet_object_keys || []) keys.add(key);
  for (const child of manifest?.child_manifests || []) {
    if (child?.manifest_key) keys.add(child.manifest_key);
  }
  return Array.from(keys).sort();
}

async function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) return null;
  return readJson(filePath);
}

async function readManifestFromRoots({ roots, key }) {
  for (const root of roots) {
    const manifest = await readJsonIfExists(path.join(root, key));
    if (manifest) return manifest;
  }
  return null;
}

async function discoverConnectorIdsForAqiDay({ roots, prefix, dayUtc }) {
  const ids = new Set();
  for (const root of roots) {
    const dayRoot = path.join(root, prefix, `day_utc=${dayUtc}`);
    if (!fs.existsSync(dayRoot)) continue;
    const entries = await fsp.readdir(dayRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^connector_id=\d+$/.test(entry.name)) continue;
      const connectorId = Number(entry.name.slice("connector_id=".length));
      if (Number.isInteger(connectorId) && connectorId > 0) ids.add(connectorId);
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

async function discoverPollutantCodesForAqiConnector({ roots, prefix, dayUtc, connectorId }) {
  const codes = new Set();
  for (const root of roots) {
    const connectorRoot = path.join(root, prefix, `day_utc=${dayUtc}`, `connector_id=${connectorId}`);
    if (!fs.existsSync(connectorRoot)) continue;
    const entries = await fsp.readdir(connectorRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^pollutant_code=[a-z0-9_]+$/i.test(entry.name)) continue;
      const pollutantCode = entry.name.slice("pollutant_code=".length).trim().toLowerCase();
      if (pollutantCode) codes.add(pollutantCode);
    }
  }
  return Array.from(codes).sort((left, right) => left.localeCompare(right));
}

function connectorIdsFromManifest(manifest) {
  return (Array.isArray(manifest?.connector_ids) ? manifest.connector_ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
}

function pollutantCodesFromManifest(manifest) {
  const raw = Array.isArray(manifest?.pollutant_codes)
    ? manifest.pollutant_codes
    : Array.isArray(manifest?.available_pollutants)
      ? manifest.available_pollutants
      : [];
  return Array.from(new Set(raw.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function parquetKeysFromManifest(manifest) {
  return Array.from(new Set([
    ...(Array.isArray(manifest?.parquet_object_keys) ? manifest.parquet_object_keys : []),
    ...(Array.isArray(manifest?.files)
      ? manifest.files.map((file) => file?.key).filter((key) => String(key || "").endsWith(".parquet"))
      : []),
  ].map((key) => String(key || "").trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function rowCountFromManifest(manifest) {
  const rowCount = Number(manifest?.row_count ?? manifest?.source_row_count);
  return Number.isFinite(rowCount) ? rowCount : 0;
}

function fileCountFromManifest(manifest) {
  const fileCount = Number(manifest?.file_count);
  return Number.isFinite(fileCount) ? fileCount : parquetKeysFromManifest(manifest).length;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUniqueConnectorIds(ids) {
  return Array.from(new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))).sort((a, b) => a - b);
}

async function rebuildAqiConnectorManifestFromFolders({
  roots,
  workRoot,
  prefix,
  dayUtc,
  connectorId,
  runId,
  computedAtUtc,
  objectType,
  writeLocal,
  warnings,
}) {
  const manifestKey = `${prefix}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
  const before = await readManifestFromRoots({ roots, key: manifestKey });
  const folderPollutants = await discoverPollutantCodesForAqiConnector({ roots, prefix, dayUtc, connectorId });
  const pollutantManifests = [];
  for (const pollutantCode of folderPollutants) {
    const pollutantManifestKey = `${prefix}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
    const pollutantManifest = await readManifestFromRoots({ roots, key: pollutantManifestKey });
    if (pollutantManifest) {
      pollutantManifests.push(pollutantManifest);
    } else {
      warnings.push({
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_code: pollutantCode,
        profile: objectType,
        warning: "missing_pollutant_manifest",
      });
    }
  }

  const manifest = buildHistoryV2ConnectorManifestForTest({
    domain: "aqilevels",
    grain: "hourly",
    profile: objectType,
    dayUtc,
    connectorId,
    runId,
    manifestKey,
    pollutantManifests,
    writerGitSha: null,
    backedUpAtUtc: computedAtUtc,
  });
  const beforePollutants = pollutantCodesFromManifest(before);
  const afterPollutants = pollutantCodesFromManifest(manifest);
  const changed = !before
    || !arraysEqual(beforePollutants, afterPollutants)
    || rowCountFromManifest(before) !== rowCountFromManifest(manifest)
    || fileCountFromManifest(before) !== fileCountFromManifest(manifest)
    || !arraysEqual(parquetKeysFromManifest(before), parquetKeysFromManifest(manifest));
  if (writeLocal && changed) await writeJson(path.join(workRoot, manifestKey), manifest);
  return {
    manifest,
    result: {
      day_utc: dayUtc,
      connector_id: connectorId,
      profile: objectType,
      manifest_key: manifestKey,
      connector_manifest_pollutant_codes_before: beforePollutants,
      folder_pollutant_codes: folderPollutants,
      connector_manifest_pollutant_codes_after: afterPollutants,
      row_count_before: before ? rowCountFromManifest(before) : null,
      row_count_after: rowCountFromManifest(manifest),
      file_count_before: before ? fileCountFromManifest(before) : null,
      file_count_after: fileCountFromManifest(manifest),
      changed,
      written_local: Boolean(writeLocal && changed),
    },
  };
}

async function rebuildAqiDayManifestFromFolders({
  sourceRoot,
  workRoot,
  prefix,
  dayUtc,
  runId,
  computedAtUtc,
  objectType,
  writeLocal,
  warnings,
  errors,
}) {
  const roots = [workRoot, sourceRoot];
  const manifestKey = `${prefix}/day_utc=${dayUtc}/manifest.json`;
  const before = await readManifestFromRoots({ roots: [sourceRoot], key: manifestKey });
  const folderConnectorIds = await discoverConnectorIdsForAqiDay({ roots, prefix, dayUtc });
  const connectorManifests = [];
  const connectorResults = [];
  for (const connectorId of folderConnectorIds) {
    const { manifest, result } = await rebuildAqiConnectorManifestFromFolders({
      roots,
      workRoot,
      prefix,
      dayUtc,
      connectorId,
      runId,
      computedAtUtc,
      objectType,
      writeLocal,
      warnings,
    });
    connectorManifests.push(manifest);
    connectorResults.push(result);
  }
  const manifest = buildHistoryV2DayManifestForTest({
    domain: "aqilevels",
    grain: "hourly",
    profile: objectType,
    dayUtc,
    runId,
    manifestKey,
    connectorManifests,
    writerGitSha: null,
    backedUpAtUtc: computedAtUtc,
  });
  const beforeConnectorIds = connectorIdsFromManifest(before);
  const afterConnectorIds = connectorIdsFromManifest(manifest);
  const missingConnectorIds = folderConnectorIds.filter((connectorId) => !afterConnectorIds.includes(connectorId));
  if (missingConnectorIds.length) {
    errors.push({
      day_utc: dayUtc,
      profile: objectType,
      error: "refusing_incomplete_day_manifest",
      folder_connector_ids: folderConnectorIds,
      day_manifest_connector_ids_after: afterConnectorIds,
      missing_connector_ids: missingConnectorIds,
    });
  }
  const changed = !before
    || !arraysEqual(beforeConnectorIds, afterConnectorIds)
    || rowCountFromManifest(before) !== rowCountFromManifest(manifest)
    || fileCountFromManifest(before) !== fileCountFromManifest(manifest)
    || !arraysEqual(parquetKeysFromManifest(before), parquetKeysFromManifest(manifest));
  if (writeLocal && changed && !missingConnectorIds.length) await writeJson(path.join(workRoot, manifestKey), manifest);
  return {
    manifest,
    connectorResults,
    result: {
      day_utc: dayUtc,
      profile: objectType,
      manifest_key: manifestKey,
      day_manifest_connector_ids_before: beforeConnectorIds,
      folder_connector_ids: folderConnectorIds,
      day_manifest_connector_ids_after: afterConnectorIds,
      row_count_before: before ? rowCountFromManifest(before) : null,
      row_count_after: rowCountFromManifest(manifest),
      file_count_before: before ? fileCountFromManifest(before) : null,
      file_count_after: fileCountFromManifest(manifest),
      parquet_object_key_count_before: before ? parquetKeysFromManifest(before).length : null,
      parquet_object_key_count_after: parquetKeysFromManifest(manifest).length,
      changed,
      written_local: Boolean(writeLocal && changed && !missingConnectorIds.length),
    },
  };
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
  for (const prefix of [AQI_DATA_PREFIX, AQI_DEBUG_PREFIX]) {
    for (const day of report.days_processed) {
      const source = path.join(config.workRoot, prefix, `day_utc=${day}`);
      const target = `${config.r2Target}/${prefix}/day_utc=${day}`;
      if (!fs.existsSync(source)) continue;
      if (config.replace && !report.rebuild_day_manifests) {
        const connectorIds = Array.isArray(report.connector_ids_processed)
          ? report.connector_ids_processed
          : [];
        for (const connectorId of connectorIds) {
          runRclone(["purge", `${target}/connector_id=${connectorId}`]);
        }
      }
      runRclone(["copy", source, target]);
    }
  }
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
  if (!process.stdin.isTTY) throw new Error(`Upload requires confirmation: ${CONFIRMATION}`);
  process.stdout.write(`Type ${CONFIRMATION} to upload to TEST R2: `);
  const input = fs.readFileSync(0, "utf8").trim();
  if (input !== CONFIRMATION) throw new Error("Confirmation did not match; aborting upload");
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const config = {
    fromDayUtc: env.UK_AQ_LOCAL_AQI_V2_FROM_DAY_UTC || env.UK_AQ_LOCAL_AQI_FROM_DAY_UTC || null,
    toDayUtc: env.UK_AQ_LOCAL_AQI_V2_TO_DAY_UTC || env.UK_AQ_LOCAL_AQI_TO_DAY_UTC || null,
    connectorIds: parseConnectorIds(env.UK_AQ_LOCAL_AQI_V2_CONNECTOR_IDS || env.UK_AQ_LOCAL_AQI_CONNECTOR_IDS || ""),
    sourceRoot: normalizeAbs(env.UK_AQ_LOCAL_AQI_V2_SOURCE_ROOT || env.UK_AQ_LOCAL_AQI_SOURCE_ROOT || DEFAULT_SOURCE_ROOT),
    workRoot: normalizeAbs(env.UK_AQ_LOCAL_AQI_V2_WORK_ROOT || env.UK_AQ_LOCAL_AQI_WORK_ROOT || DEFAULT_WORK_ROOT),
    r2Target: env.UK_AQ_LOCAL_AQI_V2_R2_TARGET || env.UK_AQ_LOCAL_AQI_R2_TARGET || DEFAULT_R2_TARGET,
    mode: "dry-run",
    replace: false,
    rebuildDayManifests: false,
    keepLocalWork: parseBoolean(env.KEEP_LOCAL_AQI_WORK, true),
    confirmation: env.UK_AQ_LOCAL_AQI_V2_CONFIRMATION || env.UK_AQ_LOCAL_AQI_CONFIRMATION || "",
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
    else if (arg === "--rebuild-day-manifests") config.rebuildDayManifests = true;
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
  if (!isIsoDay(config.fromDayUtc) || !isIsoDay(config.toDayUtc)) throw new Error("Both --from-day and --to-day are required in YYYY-MM-DD format");
  if (config.toDayUtc < config.fromDayUtc) throw new Error("--to-day must be >= --from-day");
  if (config.r2Target.toLowerCase().includes("live")) throw new Error("Refusing to use a LIVE R2 target");
  if (!config.r2Target.includes("uk-aq-history-cic-test")) throw new Error("Refusing non TEST R2 target");
  if (!config.sourceRoot.includes("CIC-Test") || !config.sourceRoot.includes("R2_history_backup")) throw new Error("Refusing source root unless it is the CIC-Test R2_history_backup Dropbox directory");
  if (!fs.existsSync(path.join(config.sourceRoot, OBS_PREFIX))) throw new Error(`Source v2 observation backup directory does not exist: ${path.join(config.sourceRoot, OBS_PREFIX)}`);
  if (isPathInsideDropbox(config.workRoot)) throw new Error(`Refusing to use a Dropbox work directory: ${config.workRoot}`);
  if (isSameOrSubpath(config.workRoot, config.sourceRoot) || isSameOrSubpath(path.join(config.workRoot, AQI_DATA_PREFIX), config.sourceRoot)) throw new Error("Refusing to write generated AQI parquet inside the Dropbox source backup");
}

function printUsage() {
  console.log(`Usage:
  node scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs \\
    --from-day YYYY-MM-DD --to-day YYYY-MM-DD [--connector-ids 1,3,6,7] [--dry-run|--local-only|--upload] [--replace] [--rebuild-day-manifests]

Source: local Dropbox ${OBS_PREFIX}
Output: TEST R2 ${AQI_DATA_PREFIX} and ${AQI_DEBUG_PREFIX}
`);
}

export async function runLocalAqilevelsV2Rebuild(config) {
  validateConfig(config);
  await maybeConfirm(config);
  const runStartedAt = new Date().toISOString();
  const stamp = runStartedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const runId = `local-aqilevels-v2-${stamp}`;
  const report = {
    ok: false,
    from_day_utc: config.fromDayUtc,
    to_day_utc: config.toDayUtc,
    source_root: config.sourceRoot,
    source_observations_prefix: OBS_PREFIX,
    work_root: config.workRoot,
    r2_target: config.r2Target,
    target_data_prefix: AQI_DATA_PREFIX,
    target_debug_prefix: AQI_DEBUG_PREFIX,
    mode: config.mode,
    replace: config.replace,
    rebuild_day_manifests: config.rebuildDayManifests,
    days_processed: [],
    connector_ids_processed: [],
    connector_day_complete: 0,
    connector_day_error: 0,
    dry_run_manifest_note: config.mode === "dry-run"
      ? "Dry-run does not write AQI output folders. Day manifest scan fields reflect existing local/Dropbox output only; expected-after-write fields are projections when AQI rows were calculable."
      : null,
    rows_read_observations: 0,
    rows_used_for_aqi: 0,
    rows_skipped_unsupported_pollutant: 0,
    rows_skipped_invalid: 0,
    rows_written_aqilevels_data: 0,
    rows_written_aqilevels_debug: 0,
    objects_written_r2: 0,
    parquet_files_written: 0,
    files_written: [],
    files_uploaded: [],
    pollutant_row_counts: {},
    day_manifest_results: [],
    connector_manifest_results: [],
    manifest_integrity_warnings: [],
    manifest_integrity_errors: [],
    sampled_schema_verification_result: null,
    errors: [],
    index_rebuild_skipped_intentionally: true,
    inventory_rebuild_skipped_intentionally: true,
    dropbox_sync_skipped_intentionally: true,
  };
  const reportPath = path.join(config.workRoot, "reports", `local_aqilevels_v2_rebuild_TEST_${stamp}.json`);

  try {
    if (config.rebuildDayManifests) {
      report.message = "Running manifest-only rebuild mode for v2 aqilevels day manifests.";
    } else if (config.mode === "dry-run") {
      report.message = "Dry run only; observations were read but no local AQI parquet was written and no R2 upload was attempted.";
    }
    for (const dayUtc of dayRange(config.fromDayUtc, config.toDayUtc)) {
      let dayConnectorIds = [];
      if (config.rebuildDayManifests) {
        const [dataConnectorIds, debugConnectorIds] = await Promise.all([
          discoverConnectorIdsForAqiDay({ roots: [config.workRoot, config.sourceRoot], prefix: AQI_DATA_PREFIX, dayUtc }),
          discoverConnectorIdsForAqiDay({ roots: [config.workRoot, config.sourceRoot], prefix: AQI_DEBUG_PREFIX, dayUtc }),
        ]);
        dayConnectorIds = Array.from(new Set([...dataConnectorIds, ...debugConnectorIds])).sort((a, b) => a - b);
      } else {
        dayConnectorIds = await connectorIdsForDay(config.sourceRoot, dayUtc);
      }
      const targetConnectorIds = (config.connectorIds || dayConnectorIds).filter((id) => dayConnectorIds.includes(id));
      const connectorsWithAqiRows = [];

      if (!config.rebuildDayManifests) {
        for (const connectorId of targetConnectorIds) {
          const beforeRowsRead = report.rows_read_observations;
          const sourceRows = await loadSourceObservationsForTargetDay({
            sourceRoot: config.sourceRoot,
            dayUtc,
            connectorId,
            counters: report,
          });
          report.rows_used_for_aqi += sourceRows.length;
          const aqiRows = buildAqilevelHistoryRowsForDayFromSourceObservations(sourceRows, dayUtc, { computedAtUtc: runStartedAt });
          if (!aqiRows.length) continue;
          connectorsWithAqiRows.push(connectorId);
          if (config.mode !== "dry-run") {
            const dataManifest = await writeConnectorOutputForPrefix({
              workRoot: config.workRoot,
              prefix: AQI_DATA_PREFIX,
              dayUtc,
              connectorId,
              runId,
              rows: aqiRows,
              computedAtUtc: runStartedAt,
              objectType: "data",
            });
            const debugManifest = await writeConnectorOutputForPrefix({
              workRoot: config.workRoot,
              prefix: AQI_DEBUG_PREFIX,
              dayUtc,
              connectorId,
              runId,
              rows: aqiRows,
              computedAtUtc: runStartedAt,
              objectType: "debug",
            });
            report.files_written.push(
              ...manifestTreeObjectKeys(dataManifest),
              ...manifestTreeObjectKeys(debugManifest),
            );
            report.rows_written_aqilevels_data += aqiRows.length;
            report.rows_written_aqilevels_debug += aqiRows.length;
            report.parquet_files_written += (dataManifest.parquet_object_keys || []).length + (debugManifest.parquet_object_keys || []).length;
          }
          report.connector_day_complete += 1;
          report.connector_ids_processed.push(connectorId);
          if (report.rows_read_observations === beforeRowsRead) report.connector_day_error += 1;
        }
      } else {
        report.connector_day_complete += targetConnectorIds.length;
        for (const connectorId of targetConnectorIds) {
          report.connector_ids_processed.push(connectorId);
        }
      }

      if (targetConnectorIds.length) {
        report.days_processed.push(dayUtc);
      }

      for (const [prefix, objectType] of [[AQI_DATA_PREFIX, "data"], [AQI_DEBUG_PREFIX, "debug"]]) {
        const { result, connectorResults } = await rebuildAqiDayManifestFromFolders({
          sourceRoot: config.sourceRoot,
          workRoot: config.workRoot,
          prefix,
          dayUtc,
          runId,
          computedAtUtc: runStartedAt,
          objectType,
          writeLocal: config.mode !== "dry-run",
          warnings: report.manifest_integrity_warnings,
          errors: report.manifest_integrity_errors,
        });
        result.manifest_result_basis = config.mode === "dry-run"
          ? "existing_output_scan_only"
          : "after_local_output_write";
        result.manifest_scan_existing_folder_connector_ids = result.folder_connector_ids;
        result.manifest_target_connector_ids = targetConnectorIds;
        result.manifest_expected_connector_ids_after_write = config.mode === "dry-run" && !config.rebuildDayManifests
          ? sortedUniqueConnectorIds([...result.folder_connector_ids, ...connectorsWithAqiRows])
          : result.day_manifest_connector_ids_after;
        result.manifest_actual_connector_ids_after_write = config.mode === "dry-run"
          ? null
          : result.day_manifest_connector_ids_after;
        report.day_manifest_results.push(result);
        for (const result of connectorResults) {
          report.connector_manifest_results.push(result);
        }
        if (result.written_local) report.files_written.push(result.manifest_key);
        for (const connectorResult of connectorResults) {
          if (connectorResult.written_local) report.files_written.push(connectorResult.manifest_key);
        }
      }
    }
    report.connector_ids_processed = Array.from(new Set(report.connector_ids_processed)).sort((a, b) => a - b);

    for (const dayResult of report.day_manifest_results) {
      const missing = dayResult.folder_connector_ids.filter((connectorId) => !dayResult.day_manifest_connector_ids_after.includes(connectorId));
      if (missing.length) {
        report.manifest_integrity_errors.push({
          day_utc: dayResult.day_utc,
          profile: dayResult.profile,
          error: "day_manifest_would_drop_discovered_connectors",
          folder_connector_ids: dayResult.folder_connector_ids,
          day_manifest_connector_ids_after: dayResult.day_manifest_connector_ids_after,
          missing_connector_ids: missing,
        });
      }
    }
    if (report.manifest_integrity_errors.length) {
      throw new Error(`Manifest integrity errors: ${JSON.stringify(report.manifest_integrity_errors)}`);
    }

    const sampleFile = report.files_written.find((file) => file.endsWith(".parquet"));
    if (sampleFile) {
      const schema = await describeParquetSchema(path.join(config.workRoot, sampleFile));
      report.sampled_schema_verification_result = { sample_file: sampleFile, schema };
    }
    if (config.mode === "upload") {
      await uploadToTestR2(config, report);
      await verifyUploaded(config, report);
      report.objects_written_r2 = report.files_uploaded.length;
    }
    if (config.mode === "upload" && config.keepLocalWork === false) {
      await fsp.rm(path.join(config.workRoot, "history", "v2", "aqilevels"), { recursive: true, force: true });
      report.local_work_output_deleted = true;
    }
    report.ok = true;
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

1. Rebuild the v2 aqilevels data inventory/index only after checking sample parquet and manifests.
2. Sync Dropbox only after R2 output, indexes, and inventory have been checked.
3. Keep observations and aqilevels rebuilds separate.
`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  try {
    const config = parseArgs();
    await runLocalAqilevelsV2Rebuild(config);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack || error.message) : String(error));
    process.exitCode = 1;
  }
}
