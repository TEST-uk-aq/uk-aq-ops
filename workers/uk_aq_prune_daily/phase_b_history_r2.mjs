import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import Cursor from "pg-cursor";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2DeleteObjects,
  r2GetObject,
  r2HeadObject,
  r2ListAllObjects,
  r2PutObject,
  sha256Hex,
} from "../shared/r2_sigv4.mjs";
import { resolveR2HistoryVersion } from "../shared/uk_aq_r2_history_version.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PART_MAX_ROWS = 1_000_000;
const DEFAULT_OBSERVATIONS_PART_MAX_ROWS = 500_000;
const DEFAULT_AQILEVELS_PART_MAX_ROWS = DEFAULT_PART_MAX_ROWS;
const DEFAULT_CURSOR_FETCH_ROWS = 20_000;
const DEFAULT_ROW_GROUP_SIZE = 100_000;
const DEFAULT_OBSERVATIONS_ROW_GROUP_SIZE = 50_000;
const DEFAULT_AQILEVELS_ROW_GROUP_SIZE = DEFAULT_ROW_GROUP_SIZE;
const DEFAULT_MAX_CANDIDATES_PER_RUN = 500;
const DEFAULT_MAX_SECONDS_PER_RUN = 840;
const DEFAULT_STOP_BEFORE_TIMEOUT_SECONDS = 60;
const DEFAULT_AQILEVELS_SOURCE_MAX_PAGES = 50_000;
const DEFAULT_STAGING_RETENTION_DAYS = 7;
const DEFAULT_STAGING_PREFIX = "history/v1/_ops/observations/staging";
const DEFAULT_COMMITTED_PREFIX = "history/v1/observations";
const DEFAULT_AQILEVELS_PREFIX = "history/v1/aqilevels/hourly";
const DEFAULT_RUNS_PREFIX = "history/v1/_ops/observations/runs";
const DEFAULT_RUNS_PREFIX_V2 = "history/v2/_ops/observations/runs";
const DEFAULT_INGESTDB_RETENTION_DAYS = 5;
const DEFAULT_PRUNE_CHECK_DROPBOX_DIR = "prune_r2_check";
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";

const HISTORY_SCHEMA_NAME = "observations";
const HISTORY_SCHEMA_VERSION = 2;
const WRITER_VERSION = "parquet-wasm-zstd-v2";
const HISTORY_AQILEVELS_SCHEMA_NAME = "aqilevels_hourly";
const HISTORY_AQILEVELS_SCHEMA_VERSION = 1;
const HISTORY_AQILEVELS_WRITER_VERSION = "parquet-wasm-zstd-v1";
const HISTORY_AQILEVELS_GRAIN = "hourly";
const AQILEVELS_CONNECTOR_COUNTS_RPC = "uk_aq_rpc_aqilevels_history_day_connector_counts";
const AQILEVELS_ROWS_RPC = "uk_aq_rpc_aqilevels_history_day_rows";
const DEFAULT_RPC_SCHEMA = "uk_aq_public";

export const HISTORY_OBSERVATIONS_COLUMNS_V1 = Object.freeze([
  "connector_id",
  "timeseries_id",
  "observed_at",
  "value",
  "status",
  "created_at",
]);
export const HISTORY_OBSERVATIONS_COLUMNS_V2 = Object.freeze([
  "connector_id",
  "timeseries_id",
  "observed_at",
  "value",
]);
const HISTORY_OBSERVATIONS_COLUMNS = HISTORY_OBSERVATIONS_COLUMNS_V2;
export const HISTORY_OBSERVATIONS_COLUMNS_R2_V2 = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "observed_at_utc",
  "value",
]);
export const HISTORY_AQILEVELS_COLUMNS = Object.freeze([
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
export const HISTORY_AQILEVELS_HOURLY_DATA_COLUMNS_R2_V2 = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "timestamp_hour_utc",
  "daqi_index_level",
  "eaqi_index_level",
  "daqi_calculation_status",
  "daqi_missing_reason",
  "eaqi_calculation_status",
  "eaqi_missing_reason",
]);
export const HISTORY_AQILEVELS_HOURLY_DEBUG_COLUMNS_R2_V2 = Object.freeze([
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
]);
const HISTORY_R2_V2_OBSERVATIONS_PREFIX = "history/v2/observations";
const HISTORY_R2_V2_AQILEVELS_HOURLY_DATA_PREFIX = "history/v2/aqilevels/hourly/data";
const HISTORY_R2_V2_AQILEVELS_HOURLY_DEBUG_PREFIX = "history/v2/aqilevels/hourly/debug";
const HISTORY_R2_V2_SCHEMA_VERSION = 2;
const HISTORY_R2_V2_WRITER_VERSION = "parquet-wasm-zstd-v2";
export const PRUNE_HISTORY_DAY_MANIFEST_KEY_REGEX_SOURCE = "^history/(v1/(observations|aqilevels/hourly)|v2/observations)/day_utc=[0-9]{4}-[0-9]{2}-[0-9]{2}/manifest\\.json$";
const PRUNE_HISTORY_DAY_MANIFEST_KEY_REGEX = new RegExp(PRUNE_HISTORY_DAY_MANIFEST_KEY_REGEX_SOURCE);

let parquetWasmInitialized = false;

function nowIso() {
  return new Date().toISOString();
}

function toIsoDateUtc(date) {
  return date.toISOString().slice(0, 10);
}

function utcMidnightFromIso(isoDate) {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function shiftIsoDay(isoDay, deltaDays) {
  const date = utcMidnightFromIso(isoDay);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return toIsoDateUtc(date);
}

function parsePositiveInt(raw, fallback, min = 1, max = 1_000_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function errorLogFields(error) {
  if (!(error instanceof Error)) {
    return { error_message: String(error) };
  }
  return {
    error_name: error.name,
    error_message: error.message,
    error_cause_code: error.cause?.code || error.code || null,
  };
}

export function createPhaseBRunBudgetForTest({
  startedAtMs = Date.now(),
  maxSecondsPerRun = DEFAULT_MAX_SECONDS_PER_RUN,
  stopBeforeTimeoutSeconds = DEFAULT_STOP_BEFORE_TIMEOUT_SECONDS,
} = {}) {
  const maxMs = Math.max(1, Math.trunc(Number(maxSecondsPerRun) || DEFAULT_MAX_SECONDS_PER_RUN)) * 1000;
  const stopBeforeMs = Math.max(0, Math.trunc(Number(stopBeforeTimeoutSeconds) || 0)) * 1000;
  const usableMs = Math.max(1, maxMs - stopBeforeMs);
  return {
    started_at_ms: startedAtMs,
    max_ms: maxMs,
    stop_before_timeout_ms: stopBeforeMs,
    deadline_ms: startedAtMs + usableMs,
  };
}

function budgetSnapshot(runtime) {
  const budget = runtime?.run_budget;
  if (!budget) {
    return {
      elapsed_run_ms: null,
      remaining_budget_ms: null,
    };
  }
  const now = Date.now();
  return {
    elapsed_run_ms: Math.max(0, now - budget.started_at_ms),
    remaining_budget_ms: Math.max(0, budget.deadline_ms - now),
  };
}

function hasBudgetFor(runtime, minMs = 0) {
  const budget = runtime?.run_budget;
  if (!budget) {
    return true;
  }
  return Date.now() + Math.max(0, minMs) < budget.deadline_ms;
}

function logPhaseB(runtime, severity, event, fields = {}) {
  const logStructured = runtime?.logStructured;
  if (typeof logStructured !== "function") {
    return;
  }
  logStructured(severity, event, {
    run_id: runtime.run_id,
    history_write_version: runtime.history_write_version,
    r2_bucket: runtime.r2?.bucket || null,
    ...budgetSnapshot(runtime),
    ...fields,
  });
}

class PhaseBHistoryBudgetExhaustedError extends Error {
  constructor(message = "Phase B history run budget exhausted") {
    super(message);
    this.name = "PhaseBHistoryBudgetExhaustedError";
    this.code = "PHASE_B_HISTORY_BUDGET_EXHAUSTED";
  }
}

function assertBudget(runtime, operation, fields = {}, minMs = 0) {
  if (hasBudgetFor(runtime, minMs)) {
    return;
  }
  logPhaseB(runtime, "WARNING", "phase_b_history_budget_exhausted", {
    operation,
    ...fields,
  });
  throw new PhaseBHistoryBudgetExhaustedError();
}

export function isAcceptedPruneHistoryDayManifestKey(value) {
  if (value === null || value === undefined) {
    return false;
  }
  const key = String(value).trim();
  return key !== "" && PRUNE_HISTORY_DAY_MANIFEST_KEY_REGEX.test(key);
}

export function resolvePhaseBHistoryWritePrefixes(env = process.env) {
  const historyWriteVersion = resolveR2HistoryVersion(env, { context: "R2 prune Phase B history writes" });
  const observationsPrefixV1 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || DEFAULT_COMMITTED_PREFIX,
  );
  const observationsPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || HISTORY_R2_V2_OBSERVATIONS_PREFIX,
  );
  const aqilevelsPrefixV1 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || DEFAULT_AQILEVELS_PREFIX,
  );
  const aqilevelsDataPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX || HISTORY_R2_V2_AQILEVELS_HOURLY_DATA_PREFIX,
  );
  const aqilevelsDebugPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX || HISTORY_R2_V2_AQILEVELS_HOURLY_DEBUG_PREFIX,
  );
  const runsPrefixV1 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_RUNS_PREFIX || DEFAULT_RUNS_PREFIX,
  );
  const runsPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_RUNS_PREFIX || DEFAULT_RUNS_PREFIX_V2,
  );

  return Object.freeze({
    history_write_version: historyWriteVersion,
    observations_prefix: historyWriteVersion === "v2" ? observationsPrefixV2 : observationsPrefixV1,
    observations_prefix_v1: observationsPrefixV1,
    observations_prefix_v2: observationsPrefixV2,
    aqilevels_prefix: historyWriteVersion === "v2" ? aqilevelsDataPrefixV2 : aqilevelsPrefixV1,
    aqilevels_prefix_v1: aqilevelsPrefixV1,
    aqilevels_hourly_data_prefix_v2: aqilevelsDataPrefixV2,
    aqilevels_hourly_debug_prefix_v2: aqilevelsDebugPrefixV2,
    runs_prefix: historyWriteVersion === "v2" ? runsPrefixV2 : runsPrefixV1,
    runs_prefix_v1: runsPrefixV1,
    runs_prefix_v2: runsPrefixV2,
  });
}

function parseBigInt(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    return 0n;
  }
  try {
    return BigInt(String(value));
  } catch {
    throw new Error(`Invalid bigint for ${fieldName}: ${String(value)}`);
  }
}

function toNullableText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toNullableInteger(value) {
  const number = toNullableNumber(value);
  return number === null ? null : Math.trunc(number);
}

function toNullablePositiveInteger(value) {
  const number = toNullableInteger(value);
  return number !== null && number > 0 ? number : null;
}

function toNullableIsoTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readResponseTextLimit(text, limit = 1000) {
  if (typeof text !== "string") {
    return "";
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

async function readResponseText(response, limit = 1000) {
  const raw = await response.text();
  return raw.length <= limit ? raw : raw.slice(0, limit);
}

function normalizeBaseUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function normalizeDropboxPath(raw) {
  const value = (raw || "").trim();
  if (!value) {
    return "";
  }
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/+$/, "");
}

function joinDropboxPath(root, suffix) {
  const rootPath = normalizeDropboxPath(root);
  const suffixPath = normalizeDropboxPath(suffix);
  if (!rootPath) {
    return suffixPath || "/";
  }
  if (!suffixPath) {
    return rootPath;
  }
  if (suffixPath === rootPath || suffixPath.startsWith(`${rootPath}/`)) {
    return suffixPath;
  }
  return `${rootPath}${suffixPath}`;
}

function normalizeDayUtc(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return "";
    }
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  const isoDateMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) {
    return isoDateMatch[1];
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return text.slice(0, 10);
}

function escapeSingleQuotes(value) {
  return String(value).replace(/'/g, "''");
}

function minIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left <= right ? left : right;
}

function maxIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left >= right ? left : right;
}

function buildManifestHash(payloadWithoutHash) {
  return sha256Hex(JSON.stringify(payloadWithoutHash));
}

function withManifestHash(payloadWithoutHash) {
  return {
    ...payloadWithoutHash,
    manifest_hash: buildManifestHash(payloadWithoutHash),
  };
}

function averageNumber(total, count) {
  if (!count) {
    return null;
  }
  return Number(total) / Number(count);
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
  for (let i = 1; i < bytes.length; i++) {
    const value = bytes[i];
    if (value < minBytes) {
      minBytes = value;
    }
    if (value > maxBytes) {
      maxBytes = value;
    }
  }

  return {
    bytes_per_row_estimate: totalRows > 0 ? totalBytes / Number(totalRows) : null,
    avg_file_bytes: averageNumber(totalBytes, bytes.length),
    min_file_bytes: minBytes,
    max_file_bytes: maxBytes,
  };
}

function summarizeObservationPartRows(rows) {
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let minObservedAt = null;
  let maxObservedAt = null;
  // Phase 6.5 Pass A: per-timeseries row counts. Cheaper for downstream
  // integrity checks to consume than reading parquets.
  const timeseriesRowCounts = {};

  for (const row of rows) {
    const timeseriesId = Number(row.timeseries_id);
    if (Number.isFinite(timeseriesId) && timeseriesId > 0) {
      const normalizedTimeseriesId = Math.trunc(timeseriesId);
      if (minTimeseriesId === null || normalizedTimeseriesId < minTimeseriesId) {
        minTimeseriesId = normalizedTimeseriesId;
      }
      if (maxTimeseriesId === null || normalizedTimeseriesId > maxTimeseriesId) {
        maxTimeseriesId = normalizedTimeseriesId;
      }
      const key = String(normalizedTimeseriesId);
      timeseriesRowCounts[key] = (timeseriesRowCounts[key] || 0) + 1;
    }
    const observedAt = typeof row.observed_at === "string" ? row.observed_at : null;
    if (observedAt) {
      minObservedAt = minIso(minObservedAt, observedAt);
      maxObservedAt = maxIso(maxObservedAt, observedAt);
    }
  }

  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    timeseries_row_counts: timeseriesRowCounts,
  };
}

function observedAtForHistoryRow(row) {
  return row?.observed_at_utc || row?.observed_at || null;
}

function summarizeObservationV2PartRows(rows) {
  const summary = summarizeObservationPartRows(
    rows.map((row) => ({
      ...row,
      observed_at: observedAtForHistoryRow(row),
    })),
  );
  return {
    min_timeseries_id: summary.min_timeseries_id,
    max_timeseries_id: summary.max_timeseries_id,
    min_observed_at_utc: summary.min_observed_at,
    max_observed_at_utc: summary.max_observed_at,
    timeseries_row_counts: summary.timeseries_row_counts,
  };
}

function groupRowsByPollutant(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const pollutantCode = normalizePollutantCodeForPath(row.pollutant_code);
    if (!grouped.has(pollutantCode)) {
      grouped.set(pollutantCode, []);
    }
    grouped.get(pollutantCode).push({
      ...row,
      pollutant_code: pollutantCode,
    });
  }
  return Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function normalizeTimeseriesRowCountsMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    const count = Number(value);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    out[String(Math.trunc(id))] = Math.trunc(count);
  }
  return Object.keys(out).length ? out : null;
}

function summarizeAqilevelPartRows(rows) {
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let minTimestampHourUtc = null;
  let maxTimestampHourUtc = null;
  const pollutantCodes = [];
  const timeseriesRowCounts = new Map();

  for (const row of rows) {
    const timeseriesId = Number(row.timeseries_id);
    if (Number.isFinite(timeseriesId) && timeseriesId > 0) {
      const normalizedTimeseriesId = Math.trunc(timeseriesId);
      if (minTimeseriesId === null || normalizedTimeseriesId < minTimeseriesId) {
        minTimeseriesId = normalizedTimeseriesId;
      }
      if (maxTimeseriesId === null || normalizedTimeseriesId > maxTimeseriesId) {
        maxTimeseriesId = normalizedTimeseriesId;
      }
      timeseriesRowCounts.set(
        normalizedTimeseriesId,
        (timeseriesRowCounts.get(normalizedTimeseriesId) || 0) + 1,
      );
    }
    const timestampHourUtc = typeof row.timestamp_hour_utc === "string"
      ? row.timestamp_hour_utc
      : null;
    if (timestampHourUtc) {
      minTimestampHourUtc = minIso(minTimestampHourUtc, timestampHourUtc);
      maxTimestampHourUtc = maxIso(maxTimestampHourUtc, timestampHourUtc);
    }
    const pollutantCode = String(row.pollutant_code || "").trim().toLowerCase();
    if (pollutantCode) {
      pollutantCodes.push(pollutantCode);
    }
  }

  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    pollutant_codes: uniqueSorted(pollutantCodes),
    timeseries_row_counts: Object.fromEntries(
      Array.from(timeseriesRowCounts.entries())
        .sort(([left], [right]) => left - right)
        .map(([timeseriesId, count]) => [String(timeseriesId), count]),
    ),
  };
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function ensureParquetWasmInitialized() {
  if (parquetWasmInitialized) {
    return;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const wasmPath = path.resolve(moduleDir, "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm");
  const wasmBytes = fs.readFileSync(wasmPath);
  parquetWasm.initSync({ module: wasmBytes });
  parquetWasmInitialized = true;
}

function connectorPrefix(basePrefix, dayUtc, connectorId) {
  return `${basePrefix}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

export function buildConnectorManifestKey(committedPrefix, dayUtc, connectorId) {
  return `${connectorPrefix(committedPrefix, dayUtc, connectorId)}/manifest.json`;
}

export function buildDayManifestKey(committedPrefix, dayUtc) {
  return `${committedPrefix}/day_utc=${dayUtc}/manifest.json`;
}

function buildRunManifestKey(runsPrefix, runId) {
  return `${runsPrefix}/run_id=${runId}/run_manifest.json`;
}

function buildPartKey(prefix, dayUtc, connectorId, partIndex) {
  return `${connectorPrefix(prefix, dayUtc, connectorId)}/part-${String(partIndex).padStart(5, "0")}.parquet`;
}

function normalizePollutantCodeForPath(pollutantCode) {
  const value = String(pollutantCode || "").trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Invalid pollutant_code for R2 path: ${String(pollutantCode || "")}`);
  }
  return value;
}

function pollutantPrefix(basePrefix, dayUtc, connectorId, pollutantCode) {
  return `${connectorPrefix(basePrefix, dayUtc, connectorId)}/pollutant_code=${normalizePollutantCodeForPath(pollutantCode)}`;
}

export function buildHistoryV2PollutantManifestKey(basePrefix, dayUtc, connectorId, pollutantCode) {
  return `${pollutantPrefix(basePrefix, dayUtc, connectorId, pollutantCode)}/manifest.json`;
}

export function buildHistoryV2PartKey(basePrefix, dayUtc, connectorId, pollutantCode, partIndex) {
  return `${pollutantPrefix(basePrefix, dayUtc, connectorId, pollutantCode)}/part-${String(partIndex).padStart(5, "0")}.parquet`;
}

export function buildHistoryV2ConnectorManifestKey(basePrefix, dayUtc, connectorId) {
  return buildConnectorManifestKey(basePrefix, dayUtc, connectorId);
}

export function buildHistoryV2DayManifestKey(basePrefix, dayUtc) {
  return buildDayManifestKey(basePrefix, dayUtc);
}

export function defaultHistoryV2PrefixesForTest() {
  return {
    observations: HISTORY_R2_V2_OBSERVATIONS_PREFIX,
    aqilevels_hourly_data: HISTORY_R2_V2_AQILEVELS_HOURLY_DATA_PREFIX,
    aqilevels_hourly_debug: HISTORY_R2_V2_AQILEVELS_HOURLY_DEBUG_PREFIX,
  };
}

function toPgConnectionConfig(connectionString) {
  return {
    connectionString,
    statement_timeout: 0,
    query_timeout: 0,
    application_name: "uk_aq_prune_daily_phase_b_history",
  };
}

async function withPgClient(connectionString, fn) {
  const client = new Client(toPgConnectionConfig(connectionString));
  await client.connect();
  try {
    await client.query("set timezone = 'UTC'");
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function postgrestRpc({ baseUrl, privilegedKey, rpcSchema, rpcName, payload }) {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/rest/v1/rpc/${encodeURIComponent(rpcName)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: privilegedKey,
      Authorization: `Bearer ${privilegedKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Profile": rpcSchema,
      "Content-Profile": rpcSchema,
    },
    body: JSON.stringify(payload ?? {}),
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && parsed.message
      ? String(parsed.message)
      : readResponseTextLimit(text);
    throw new Error(`PostgREST RPC ${rpcName} failed (${response.status}): ${message}`);
  }

  return parsed;
}

function toResumePartEntry(value, index) {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid resume part entry at index ${index}`);
  }
  const key = String(value.key || "").trim();
  if (!key) {
    throw new Error(`Missing resume part key at index ${index}`);
  }
  const rowCount = Number(value.row_count);
  if (!Number.isFinite(rowCount) || rowCount <= 0) {
    throw new Error(`Invalid resume part row_count at index ${index}`);
  }
  const bytes = Number(value.bytes);
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`Invalid resume part bytes at index ${index}`);
  }
  const etagOrHash = value.etag_or_hash === null || value.etag_or_hash === undefined
    ? null
    : String(value.etag_or_hash);
  const minTimeseriesId = Number(value.min_timeseries_id);
  const maxTimeseriesId = Number(value.max_timeseries_id);
  const minObservedAt = typeof value.min_observed_at === "string"
    ? value.min_observed_at
    : null;
  const maxObservedAt = typeof value.max_observed_at === "string"
    ? value.max_observed_at
    : null;
  const minTimestampHourUtc = typeof value.min_timestamp_hour_utc === "string"
    ? value.min_timestamp_hour_utc
    : null;
  const maxTimestampHourUtc = typeof value.max_timestamp_hour_utc === "string"
    ? value.max_timestamp_hour_utc
    : null;
  const timeseriesRowCounts = normalizeTimeseriesRowCountsMap(value.timeseries_row_counts);

  return {
    key,
    row_count: Math.trunc(rowCount),
    bytes: Math.trunc(bytes),
    etag_or_hash: etagOrHash,
    min_timeseries_id:
      Number.isFinite(minTimeseriesId) && minTimeseriesId > 0 ? Math.trunc(minTimeseriesId) : null,
    max_timeseries_id:
      Number.isFinite(maxTimeseriesId) && maxTimeseriesId > 0 ? Math.trunc(maxTimeseriesId) : null,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    timeseries_row_counts: timeseriesRowCounts,
  };
}

function parseResumeParts(value) {
  if (value === null || value === undefined || value === "") {
    return [];
  }

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Invalid resume_parts_json payload.");
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error("resume_parts_json must be an array.");
  }

  return parsed.map((entry, index) => toResumePartEntry(entry, index));
}

function toConnectorDayRow(row) {
  return {
    day_utc: normalizeDayUtc(row.day_utc),
    connector_id: Number(row.connector_id),
    expected_row_count: parseBigInt(row.expected_row_count, "expected_row_count"),
    min_observed_at: row.min_observed_at ? new Date(row.min_observed_at).toISOString() : null,
    max_observed_at: row.max_observed_at ? new Date(row.max_observed_at).toISOString() : null,
    status: String(row.status || "pending"),
    run_id: row.run_id ? String(row.run_id) : null,
    manifest_key: row.manifest_key ? String(row.manifest_key) : null,
    history_row_count: row.history_row_count === null || row.history_row_count === undefined
      ? null
      : parseBigInt(row.history_row_count, "history_row_count"),
    history_file_count: row.history_file_count === null || row.history_file_count === undefined
      ? null
      : Number(row.history_file_count),
    history_total_bytes: row.history_total_bytes === null || row.history_total_bytes === undefined
      ? null
      : parseBigInt(row.history_total_bytes, "history_total_bytes"),
    resume_last_timeseries_id: row.resume_last_timeseries_id === null || row.resume_last_timeseries_id === undefined
      ? null
      : Number(row.resume_last_timeseries_id),
    resume_last_observed_at: row.resume_last_observed_at
      ? new Date(row.resume_last_observed_at).toISOString()
      : null,
    resume_part_index: row.resume_part_index === null || row.resume_part_index === undefined
      ? 0
      : Number(row.resume_part_index),
    resume_exported_row_count: row.resume_exported_row_count === null || row.resume_exported_row_count === undefined
      ? 0n
      : parseBigInt(row.resume_exported_row_count, "resume_exported_row_count"),
    resume_parts: parseResumeParts(row.resume_parts_json),
  };
}

async function populateBackupCandidates(client, latestEligibleWindowEndIso) {
  const sql = `
with eligible as (
  select
    (o.observed_at at time zone 'UTC')::date as day_utc,
    o.connector_id::integer as connector_id,
    count(*)::bigint as expected_row_count,
    min(o.observed_at) as min_observed_at,
    max(o.observed_at) as max_observed_at
  from uk_aq_core.observations o
  left join uk_aq_ops.history_candidates existing_complete
    on existing_complete.day_utc = (o.observed_at at time zone 'UTC')::date
   and existing_complete.connector_id = o.connector_id
   and existing_complete.status = 'complete'
  where o.observed_at < $1::timestamptz
    and existing_complete.day_utc is null
  group by 1, 2
),
upserted as (
  insert into uk_aq_ops.history_candidates (
    day_utc,
    connector_id,
    expected_row_count,
    min_observed_at,
    max_observed_at,
    status,
    run_id,
    last_error,
    manifest_key,
    history_row_count,
    history_file_count,
    history_total_bytes,
    history_completed_at,
    resume_last_timeseries_id,
    resume_last_observed_at,
    resume_part_index,
    resume_exported_row_count,
    resume_parts_json
  )
  select
    e.day_utc,
    e.connector_id,
    e.expected_row_count,
    e.min_observed_at,
    e.max_observed_at,
    'pending'::text,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    0,
    0,
    '[]'::jsonb
  from eligible e
  on conflict (day_utc, connector_id)
  do update set
    expected_row_count = excluded.expected_row_count,
    min_observed_at = excluded.min_observed_at,
    max_observed_at = excluded.max_observed_at,
    status = 'pending',
    run_id = null,
    last_error = null,
    manifest_key = null,
    history_row_count = null,
    history_file_count = null,
    history_total_bytes = null,
    history_completed_at = null,
    resume_last_timeseries_id = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.resume_last_timeseries_id
      else null
    end,
    resume_last_observed_at = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.resume_last_observed_at
      else null
    end,
    resume_part_index = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then coalesce(uk_aq_ops.history_candidates.resume_part_index, 0)
      else 0
    end,
    resume_exported_row_count = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then coalesce(uk_aq_ops.history_candidates.resume_exported_row_count, 0)
      else 0
    end,
    resume_parts_json = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then coalesce(uk_aq_ops.history_candidates.resume_parts_json, '[]'::jsonb)
      else '[]'::jsonb
    end,
    updated_at = now()
  where uk_aq_ops.history_candidates.status <> 'complete'
  returning
    day_utc,
    connector_id,
    expected_row_count,
    min_observed_at,
    max_observed_at,
    status,
    run_id,
    manifest_key,
    history_row_count,
    history_file_count,
    history_total_bytes,
    resume_last_timeseries_id,
    resume_last_observed_at,
    resume_part_index,
    resume_exported_row_count,
    resume_parts_json
)
select * from upserted
order by day_utc, connector_id
`;

  const result = await client.query(sql, [latestEligibleWindowEndIso]);
  return result.rows.map(toConnectorDayRow);
}

async function markIncompleteDaysAsBackupBlocked(client) {
  const sql = `
with day_status as (
  select
    c.day_utc,
    bool_and(c.status = 'complete') as all_complete
  from uk_aq_ops.history_candidates c
  group by c.day_utc
)
insert into uk_aq_ops.prune_day_gates (
  day_utc,
  history_done,
  history_run_id,
  history_manifest_key,
  history_row_count,
  history_file_count,
  history_total_bytes,
  history_completed_at,
  updated_at
)
select
  d.day_utc,
  false,
  null,
  null,
  null,
  null,
  null,
  null,
  now()
from day_status d
where d.all_complete = false
on conflict (day_utc)
do update set
  history_done = false,
  history_run_id = null,
  history_manifest_key = null,
  history_row_count = null,
  history_file_count = null,
  history_total_bytes = null,
  history_completed_at = null,
  updated_at = now()
`;
  await client.query(sql);
}

async function fetchPendingCandidates(client, maxCandidatesPerRun) {
  const sql = `
select
  c.day_utc,
  c.connector_id,
  c.expected_row_count,
  c.min_observed_at,
  c.max_observed_at,
  c.status,
  c.run_id,
  c.manifest_key,
  c.history_row_count,
  c.history_file_count,
  c.history_total_bytes,
  c.resume_last_timeseries_id,
  c.resume_last_observed_at,
  c.resume_part_index,
  c.resume_exported_row_count,
  c.resume_parts_json
from uk_aq_ops.history_candidates c
where c.status = 'pending'
order by c.day_utc, c.connector_id
limit $1
`;

  const result = await client.query(sql, [maxCandidatesPerRun]);
  return result.rows.map(toConnectorDayRow);
}

async function markCandidateInProgress(client, dayUtc, connectorId, runId) {
  const result = await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'in_progress',
  run_id = $3,
  last_error = null,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
  and status = 'pending'
returning day_utc
`,
    [dayUtc, connectorId, runId],
  );
  return result.rowCount > 0;
}

async function markCandidateComplete(client, {
  dayUtc,
  connectorId,
  runId,
  manifestKey,
  historyRowCount,
  historyFileCount,
  historyTotalBytes,
}) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'complete',
  run_id = $3,
  last_error = null,
  manifest_key = $4,
  history_row_count = $5,
  history_file_count = $6,
  history_total_bytes = $7,
  resume_last_timeseries_id = null,
  resume_last_observed_at = null,
  resume_part_index = 0,
  resume_exported_row_count = 0,
  resume_parts_json = '[]'::jsonb,
  history_completed_at = now(),
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [
      dayUtc,
      connectorId,
      runId,
      manifestKey,
      historyRowCount.toString(),
      historyFileCount,
      historyTotalBytes.toString(),
    ],
  );
}

async function updateCandidateResumeCheckpoint(client, {
  dayUtc,
  connectorId,
  runId,
  lastTimeseriesId,
  lastObservedAt,
  partIndex,
  exportedRowCount,
  parts,
}) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  resume_last_timeseries_id = $4,
  resume_last_observed_at = $5,
  resume_part_index = $6,
  resume_exported_row_count = $7,
  resume_parts_json = $8::jsonb,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
  and run_id = $3
`,
    [
      dayUtc,
      connectorId,
      runId,
      lastTimeseriesId,
      lastObservedAt,
      partIndex,
      exportedRowCount.toString(),
      JSON.stringify(parts),
    ],
  );
}

async function markCandidateFailed(client, { dayUtc, connectorId, runId, errorText }) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'failed',
  run_id = $3,
  last_error = left($4, 4000),
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [dayUtc, connectorId, runId, errorText],
  );
}

async function fetchDayCandidates(client, dayUtc) {
  const result = await client.query(
    `
select
  day_utc,
  connector_id,
  expected_row_count,
  min_observed_at,
  max_observed_at,
  status,
  run_id,
  manifest_key,
  history_row_count,
  history_file_count,
  history_total_bytes,
  resume_last_timeseries_id,
  resume_last_observed_at,
  resume_part_index,
  resume_exported_row_count,
  resume_parts_json
from uk_aq_ops.history_candidates
where day_utc = $1::date
order by connector_id
`,
    [dayUtc],
  );
  return result.rows.map(toConnectorDayRow);
}

export function computeDayGateState(dayCandidates) {
  const total = dayCandidates.length;
  const complete = dayCandidates.filter((row) => row.status === "complete").length;
  const failed = dayCandidates.filter((row) => row.status === "failed").length;
  const pending = dayCandidates.filter((row) => row.status === "pending").length;
  const inProgress = dayCandidates.filter((row) => row.status === "in_progress").length;
  const allComplete = total > 0 && complete === total;
  return {
    total,
    complete,
    failed,
    pending,
    in_progress: inProgress,
    all_complete: allComplete,
  };
}

async function updateDayGateBlocked(client, dayUtc) {
  await client.query(
    `
insert into uk_aq_ops.prune_day_gates (
  day_utc,
  history_done,
  history_run_id,
  history_manifest_key,
  history_row_count,
  history_file_count,
  history_total_bytes,
  history_completed_at,
  updated_at
)
values ($1::date, false, null, null, null, null, null, null, now())
on conflict (day_utc)
do update set
  history_done = false,
  history_run_id = null,
  history_manifest_key = null,
  history_row_count = null,
  history_file_count = null,
  history_total_bytes = null,
  history_completed_at = null,
  updated_at = now()
`,
    [dayUtc],
  );
}

async function updateDayGateComplete(client, {
  dayUtc,
  runId,
  manifestKey,
  rowCount,
  fileCount,
  totalBytes,
}) {
  await client.query(
    `
insert into uk_aq_ops.prune_day_gates (
  day_utc,
  history_done,
  history_run_id,
  history_manifest_key,
  history_row_count,
  history_file_count,
  history_total_bytes,
  history_completed_at,
  updated_at
)
values (
  $1::date,
  true,
  $2,
  $3,
  $4,
  $5,
  $6,
  now(),
  now()
)
on conflict (day_utc)
do update set
  history_done = true,
  history_run_id = excluded.history_run_id,
  history_manifest_key = excluded.history_manifest_key,
  history_row_count = excluded.history_row_count,
  history_file_count = excluded.history_file_count,
  history_total_bytes = excluded.history_total_bytes,
  history_completed_at = now(),
  updated_at = now()
`,
    [dayUtc, runId, manifestKey, rowCount.toString(), fileCount, totalBytes.toString()],
  );
}

function aggregateTimeseriesRowCounts(entriesWithCounts) {
  // Sum any top-level/per-file `timeseries_row_counts` maps into one map.
  // Returns null if no entry carries the field.
  const out = {};
  let sawAny = false;
  for (const entry of entriesWithCounts) {
    const map = entry && entry.timeseries_row_counts;
    if (!map || typeof map !== "object") continue;
    sawAny = true;
    for (const [key, value] of Object.entries(map)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      out[key] = (out[key] || 0) + Math.trunc(n);
    }
  }
  return sawAny ? out : null;
}

function stripTimeseriesCountsFromFileEntries(fileEntries) {
  return (Array.isArray(fileEntries) ? fileEntries : []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const { timeseries_row_counts: _ignored, ...rest } = entry;
    return rest;
  });
}


function createConnectorManifest({
  dayUtc,
  connectorId,
  runId,
  sourceRowCount,
  minObservedAt,
  maxObservedAt,
  fileEntries,
  writerGitSha,
  backedUpAtUtc,
}) {
  const manifestFileEntries = stripTimeseriesCountsFromFileEntries(fileEntries);
  const parquetObjectKeys = manifestFileEntries.map((entry) => entry.key);
  const totalBytes = manifestFileEntries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const stats = statsFromFileEntries(manifestFileEntries, sourceRowCount);
  const timeseriesRowCounts = aggregateTimeseriesRowCounts(fileEntries);

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: connectorId,
    run_id: runId,
    source_row_count: Number(sourceRowCount),
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    parquet_object_keys: parquetObjectKeys,
    file_count: fileEntries.length,
    total_bytes: totalBytes,
    files: manifestFileEntries,
    history_schema_name: HISTORY_SCHEMA_NAME,
    history_schema_version: HISTORY_SCHEMA_VERSION,
    columns: HISTORY_OBSERVATIONS_COLUMNS,
    writer_version: WRITER_VERSION,
    writer_git_sha: writerGitSha,
    ...stats,
    timeseries_row_counts: timeseriesRowCounts,
    backed_up_at_utc: backedUpAtUtc,
  });
}

export function buildConnectorManifestForTest(args) {
  return createConnectorManifest(args);
}

function createDayManifest({ dayUtc, runId, connectorManifests, writerGitSha, backedUpAtUtc }) {
  const files = connectorManifests.flatMap((manifest) =>
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

  const parquetObjectKeys = uniqueSorted(files.map((entry) => entry.key));
  const totalRows = connectorManifests.reduce((sum, manifest) => sum + Number(manifest.source_row_count || 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const connectorIds = connectorManifests.map((manifest) => Number(manifest.connector_id));

  const minObservedAt = connectorManifests.reduce(
    (current, manifest) => minIso(current, manifest.min_observed_at || null),
    null,
  );
  const maxObservedAt = connectorManifests.reduce(
    (current, manifest) => maxIso(current, manifest.max_observed_at || null),
    null,
  );

  const stats = statsFromFileEntries(files, totalRows);

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: runId,
    source_row_count: totalRows,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    parquet_object_keys: parquetObjectKeys,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    connector_manifests: connectorManifests.map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      source_row_count: manifest.source_row_count,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
    })),
    history_schema_name: HISTORY_SCHEMA_NAME,
    history_schema_version: HISTORY_SCHEMA_VERSION,
    columns: HISTORY_OBSERVATIONS_COLUMNS,
    writer_version: WRITER_VERSION,
    writer_git_sha: writerGitSha,
    ...stats,
    backed_up_at_utc: backedUpAtUtc,
  });
}

function createAqilevelConnectorManifest({
  dayUtc,
  connectorId,
  runId,
  sourceRowCount,
  minTimeseriesId,
  maxTimeseriesId,
  minTimestampHourUtc,
  maxTimestampHourUtc,
  fileEntries,
  writerGitSha,
  backedUpAtUtc,
}) {
  const parquetObjectKeys = fileEntries.map((entry) => entry.key);
  const totalBytes = fileEntries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const resolvedMinTimeseriesId = Number.isFinite(Number(minTimeseriesId))
    && Number(minTimeseriesId) > 0
    ? Math.trunc(Number(minTimeseriesId))
    : fileEntries.reduce((current, entry) => {
      const value = Number(entry.min_timeseries_id);
      if (!Number.isFinite(value) || value <= 0) {
        return current;
      }
      const normalized = Math.trunc(value);
      return current === null ? normalized : Math.min(current, normalized);
    }, null);
  const resolvedMaxTimeseriesId = Number.isFinite(Number(maxTimeseriesId))
    && Number(maxTimeseriesId) > 0
    ? Math.trunc(Number(maxTimeseriesId))
    : fileEntries.reduce((current, entry) => {
      const value = Number(entry.max_timeseries_id);
      if (!Number.isFinite(value) || value <= 0) {
        return current;
      }
      const normalized = Math.trunc(value);
      return current === null ? normalized : Math.max(current, normalized);
    }, null);
  const stats = statsFromFileEntries(fileEntries, sourceRowCount);
  const availablePollutants = uniqueSorted(
    fileEntries.flatMap((entry) =>
      Array.isArray(entry.pollutant_codes)
        ? entry.pollutant_codes.map((pollutantCode) => String(pollutantCode || "").trim().toLowerCase()).filter(Boolean)
        : []
    ),
  );

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: connectorId,
    run_id: runId,
    source_row_count: Number(sourceRowCount),
    min_timeseries_id: resolvedMinTimeseriesId,
    max_timeseries_id: resolvedMaxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    parquet_object_keys: parquetObjectKeys,
    file_count: fileEntries.length,
    total_bytes: totalBytes,
    files: fileEntries,
    grain: HISTORY_AQILEVELS_GRAIN,
    history_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    history_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    columns: HISTORY_AQILEVELS_COLUMNS,
    writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
    writer_git_sha: writerGitSha,
    available_pollutants: availablePollutants,
    ...stats,
    backed_up_at_utc: backedUpAtUtc,
  });
}

export function buildAqilevelConnectorManifestForTest(args) {
  return createAqilevelConnectorManifest(args);
}

function createAqilevelDayManifest({ dayUtc, runId, connectorManifests, writerGitSha, backedUpAtUtc }) {
  const files = connectorManifests.flatMap((manifest) =>
    (Array.isArray(manifest.files) ? manifest.files : []).map((entry) => ({
      connector_id: manifest.connector_id,
      key: entry.key,
      bytes: entry.bytes,
      row_count: entry.row_count,
      etag_or_hash: entry.etag_or_hash,
      min_timeseries_id: entry.min_timeseries_id ?? null,
      max_timeseries_id: entry.max_timeseries_id ?? null,
      min_timestamp_hour_utc: entry.min_timestamp_hour_utc ?? null,
      max_timestamp_hour_utc: entry.max_timestamp_hour_utc ?? null,
      pollutant_codes: Array.isArray(entry.pollutant_codes) ? entry.pollutant_codes : [],
    }))
  );

  const parquetObjectKeys = uniqueSorted(files.map((entry) => entry.key));
  const totalRows = connectorManifests.reduce((sum, manifest) => sum + Number(manifest.source_row_count || 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const connectorIds = connectorManifests.map((manifest) => Number(manifest.connector_id));
  const minTimeseriesId = connectorManifests.reduce((current, manifest) => {
    const value = Number(manifest.min_timeseries_id);
    if (!Number.isFinite(value) || value <= 0) {
      return current;
    }
    const normalized = Math.trunc(value);
    return current === null ? normalized : Math.min(current, normalized);
  }, null);
  const maxTimeseriesId = connectorManifests.reduce((current, manifest) => {
    const value = Number(manifest.max_timeseries_id);
    if (!Number.isFinite(value) || value <= 0) {
      return current;
    }
    const normalized = Math.trunc(value);
    return current === null ? normalized : Math.max(current, normalized);
  }, null);

  const minTimestampHourUtc = connectorManifests.reduce(
    (current, manifest) => minIso(current, manifest.min_timestamp_hour_utc || null),
    null,
  );
  const maxTimestampHourUtc = connectorManifests.reduce(
    (current, manifest) => maxIso(current, manifest.max_timestamp_hour_utc || null),
    null,
  );
  const availablePollutants = uniqueSorted(
    connectorManifests.flatMap((manifest) =>
      Array.isArray(manifest.available_pollutants)
        ? manifest.available_pollutants.map((pollutantCode) => String(pollutantCode || "").trim().toLowerCase()).filter(Boolean)
        : []
    ),
  );

  const stats = statsFromFileEntries(files, totalRows);

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: runId,
    source_row_count: totalRows,
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    parquet_object_keys: parquetObjectKeys,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    grain: HISTORY_AQILEVELS_GRAIN,
    connector_manifests: connectorManifests.map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      source_row_count: manifest.source_row_count,
      min_timeseries_id: manifest.min_timeseries_id ?? null,
      max_timeseries_id: manifest.max_timeseries_id ?? null,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      available_pollutants: Array.isArray(manifest.available_pollutants) ? manifest.available_pollutants : [],
    })),
    history_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    history_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    columns: HISTORY_AQILEVELS_COLUMNS,
    writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
    writer_git_sha: writerGitSha,
    available_pollutants: availablePollutants,
    ...stats,
    backed_up_at_utc: backedUpAtUtc,
  });
}

export function buildAqilevelDayManifestForTest(args) {
  return createAqilevelDayManifest(args);
}

function historyV2ColumnsFor(domain, profile = null) {
  if (domain === "observations") {
    return HISTORY_OBSERVATIONS_COLUMNS_R2_V2;
  }
  if (domain === "aqilevels" && profile === "data") {
    return HISTORY_AQILEVELS_HOURLY_DATA_COLUMNS_R2_V2;
  }
  if (domain === "aqilevels" && profile === "debug") {
    return HISTORY_AQILEVELS_HOURLY_DEBUG_COLUMNS_R2_V2;
  }
  throw new Error(`Unsupported R2 history v2 schema: domain=${domain} profile=${profile || "null"}`);
}

function minEntryValue(entries, fieldName) {
  return entries.reduce((current, entry) => minIso(current, entry?.[fieldName] || null), null);
}

function maxEntryValue(entries, fieldName) {
  return entries.reduce((current, entry) => maxIso(current, entry?.[fieldName] || null), null);
}

function minNumericEntryValue(entries, fieldName) {
  return entries.reduce((current, entry) => {
    const value = Number(entry?.[fieldName]);
    if (!Number.isFinite(value) || value <= 0) return current;
    const normalized = Math.trunc(value);
    return current === null ? normalized : Math.min(current, normalized);
  }, null);
}

function maxNumericEntryValue(entries, fieldName) {
  return entries.reduce((current, entry) => {
    const value = Number(entry?.[fieldName]);
    if (!Number.isFinite(value) || value <= 0) return current;
    const normalized = Math.trunc(value);
    return current === null ? normalized : Math.max(current, normalized);
  }, null);
}

function createHistoryV2PollutantManifest({
  domain,
  grain = null,
  profile = null,
  dayUtc,
  connectorId,
  pollutantCode,
  runId = null,
  manifestKey,
  sourceRowCount,
  fileEntries,
  writerGitSha,
  backedUpAtUtc,
}) {
  const normalizedPollutantCode = normalizePollutantCodeForPath(pollutantCode);
  const files = (Array.isArray(fileEntries) ? fileEntries : []).map((entry) => ({
    ...entry,
    pollutant_code: normalizedPollutantCode,
  }));
  const totalBytes = files.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const minObservedAtUtc = minEntryValue(files, "min_observed_at_utc") || minEntryValue(files, "min_observed_at");
  const maxObservedAtUtc = maxEntryValue(files, "max_observed_at_utc") || maxEntryValue(files, "max_observed_at");
  const minTimestampHourUtc = minEntryValue(files, "min_timestamp_hour_utc");
  const maxTimestampHourUtc = maxEntryValue(files, "max_timestamp_hour_utc");
  const payload = {
    manifest_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_version: "v2",
    manifest_kind: "pollutant",
    domain,
    grain,
    profile,
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: normalizedPollutantCode,
    pollutant_codes: [normalizedPollutantCode],
    run_id: runId,
    manifest_key: manifestKey,
    source_row_count: Number(sourceRowCount),
    row_count: Number(sourceRowCount),
    min_timeseries_id: minNumericEntryValue(files, "min_timeseries_id"),
    max_timeseries_id: maxNumericEntryValue(files, "max_timeseries_id"),
    min_observed_at_utc: minObservedAtUtc,
    max_observed_at_utc: maxObservedAtUtc,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    parquet_object_keys: uniqueSorted(files.map((entry) => entry.key)),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    child_manifests: [],
    columns: historyV2ColumnsFor(domain, profile),
    writer_version: HISTORY_R2_V2_WRITER_VERSION,
    writer_git_sha: writerGitSha,
    timeseries_row_counts: aggregateTimeseriesRowCounts(files),
    ...statsFromFileEntries(files, Number(sourceRowCount)),
    backed_up_at_utc: backedUpAtUtc,
  };
  return withManifestHash(payload);
}

function createHistoryV2ConnectorManifest({
  domain,
  grain = null,
  profile = null,
  dayUtc,
  connectorId,
  runId = null,
  manifestKey,
  pollutantManifests,
  writerGitSha,
  backedUpAtUtc,
}) {
  const manifests = Array.isArray(pollutantManifests) ? pollutantManifests : [];
  const childManifests = manifests
    .map((manifest) => ({
      pollutant_code: manifest.pollutant_code,
      manifest_key: manifest.manifest_key,
      manifest_hash: manifest.manifest_hash,
      source_row_count: manifest.source_row_count,
      row_count: manifest.row_count,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      min_timeseries_id: manifest.min_timeseries_id ?? null,
      max_timeseries_id: manifest.max_timeseries_id ?? null,
      min_observed_at_utc: manifest.min_observed_at_utc ?? null,
      max_observed_at_utc: manifest.max_observed_at_utc ?? null,
      min_timestamp_hour_utc: manifest.min_timestamp_hour_utc ?? null,
      max_timestamp_hour_utc: manifest.max_timestamp_hour_utc ?? null,
    }));
  const files = manifests.flatMap((manifest) => Array.isArray(manifest.files) ? manifest.files : []);
  const totalRows = manifests.reduce((sum, manifest) => sum + Number(manifest.source_row_count || 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const pollutantCodes = uniqueSorted(manifests.map((manifest) => manifest.pollutant_code).filter(Boolean));
  return withManifestHash({
    manifest_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_version: "v2",
    manifest_kind: "connector",
    domain,
    grain,
    profile,
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: null,
    pollutant_codes: pollutantCodes,
    run_id: runId,
    manifest_key: manifestKey,
    source_row_count: totalRows,
    row_count: totalRows,
    min_timeseries_id: minNumericEntryValue(manifests, "min_timeseries_id"),
    max_timeseries_id: maxNumericEntryValue(manifests, "max_timeseries_id"),
    min_observed_at_utc: minEntryValue(manifests, "min_observed_at_utc"),
    max_observed_at_utc: maxEntryValue(manifests, "max_observed_at_utc"),
    min_timestamp_hour_utc: minEntryValue(manifests, "min_timestamp_hour_utc"),
    max_timestamp_hour_utc: maxEntryValue(manifests, "max_timestamp_hour_utc"),
    parquet_object_keys: uniqueSorted(files.map((entry) => entry.key)),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    child_manifests: childManifests,
    pollutant_manifests: childManifests,
    columns: historyV2ColumnsFor(domain, profile),
    writer_version: HISTORY_R2_V2_WRITER_VERSION,
    writer_git_sha: writerGitSha,
    timeseries_row_counts: aggregateTimeseriesRowCounts(manifests),
    ...statsFromFileEntries(files, totalRows),
    backed_up_at_utc: backedUpAtUtc,
  });
}

function createHistoryV2DayManifest({
  domain,
  grain = null,
  profile = null,
  dayUtc,
  runId = null,
  manifestKey,
  connectorManifests,
  writerGitSha,
  backedUpAtUtc,
}) {
  const manifests = Array.isArray(connectorManifests) ? connectorManifests : [];
  const childManifests = manifests
    .map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      manifest_hash: manifest.manifest_hash,
      source_row_count: manifest.source_row_count,
      row_count: manifest.row_count,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      pollutant_codes: Array.isArray(manifest.pollutant_codes) ? manifest.pollutant_codes : [],
      min_timeseries_id: manifest.min_timeseries_id ?? null,
      max_timeseries_id: manifest.max_timeseries_id ?? null,
      min_observed_at_utc: manifest.min_observed_at_utc ?? null,
      max_observed_at_utc: manifest.max_observed_at_utc ?? null,
      min_timestamp_hour_utc: manifest.min_timestamp_hour_utc ?? null,
      max_timestamp_hour_utc: manifest.max_timestamp_hour_utc ?? null,
    }));
  const files = manifests.flatMap((manifest) => Array.isArray(manifest.files) ? manifest.files : []);
  const totalRows = manifests.reduce((sum, manifest) => sum + Number(manifest.source_row_count || 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const connectorIds = manifests.map((manifest) => Number(manifest.connector_id)).filter((value) => Number.isInteger(value));
  const pollutantCodes = uniqueSorted(manifests.flatMap((manifest) => (
    Array.isArray(manifest.pollutant_codes) ? manifest.pollutant_codes : []
  )));
  return withManifestHash({
    manifest_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_version: "v2",
    manifest_kind: "day",
    domain,
    grain,
    profile,
    day_utc: dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    pollutant_code: null,
    pollutant_codes: pollutantCodes,
    run_id: runId,
    manifest_key: manifestKey,
    source_row_count: totalRows,
    row_count: totalRows,
    min_timeseries_id: minNumericEntryValue(manifests, "min_timeseries_id"),
    max_timeseries_id: maxNumericEntryValue(manifests, "max_timeseries_id"),
    min_observed_at_utc: minEntryValue(manifests, "min_observed_at_utc"),
    max_observed_at_utc: maxEntryValue(manifests, "max_observed_at_utc"),
    min_timestamp_hour_utc: minEntryValue(manifests, "min_timestamp_hour_utc"),
    max_timestamp_hour_utc: maxEntryValue(manifests, "max_timestamp_hour_utc"),
    parquet_object_keys: uniqueSorted(files.map((entry) => entry.key)),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    child_manifests: childManifests,
    connector_manifests: childManifests,
    columns: historyV2ColumnsFor(domain, profile),
    writer_version: HISTORY_R2_V2_WRITER_VERSION,
    writer_git_sha: writerGitSha,
    ...statsFromFileEntries(files, totalRows),
    backed_up_at_utc: backedUpAtUtc,
  });
}

export function buildHistoryV2PollutantManifestForTest(args) {
  return createHistoryV2PollutantManifest(args);
}

export function buildHistoryV2ConnectorManifestForTest(args) {
  return createHistoryV2ConnectorManifest(args);
}

export function buildHistoryV2DayManifestForTest(args) {
  return createHistoryV2DayManifest(args);
}

const PARQUET_WRITER_PROPERTIES_CACHE = new Map();

function parquetWriterProperties(rowGroupSize, createdBy = WRITER_VERSION) {
  const key = Number(rowGroupSize);
  const cacheKey = `${key}:${createdBy}`;
  if (PARQUET_WRITER_PROPERTIES_CACHE.has(cacheKey)) {
    return PARQUET_WRITER_PROPERTIES_CACHE.get(cacheKey);
  }

  ensureParquetWasmInitialized();
  const writerProperties = new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.ZSTD)
    .setMaxRowGroupSize(key)
    .setCreatedBy(createdBy)
    .build();

  PARQUET_WRITER_PROPERTIES_CACHE.set(cacheKey, writerProperties);
  return writerProperties;
}

function rowsToParquetBuffer(rows, writerProperties) {
  ensureParquetWasmInitialized();
  const table = arrow.tableFromArrays({
    connector_id: Int32Array.from(rows.map((row) => Number(row.connector_id))),
    timeseries_id: Int32Array.from(rows.map((row) => Number(row.timeseries_id))),
    observed_at: rows.map((row) => new Date(row.observed_at)),
    value: rows.map((row) => (row.value === null || row.value === undefined ? null : Number(row.value))),
  });

  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const parquetBytes = parquetWasm.writeParquet(wasmTable, writerProperties);
  return Buffer.from(parquetBytes);
}

function rowsToAqilevelParquetBuffer(rows, writerProperties) {
  ensureParquetWasmInitialized();
  const int32Vector = (values) => arrow.vectorFromArray(values, new arrow.Int32());
  const float64Vector = (values) => arrow.vectorFromArray(values, new arrow.Float64());
  const textVector = (values) => arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values) => arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = arrow.tableFromArrays({
    connector_id: int32Vector(rows.map((row) => Number(row.connector_id))),
    station_id: int32Vector(rows.map((row) => (
      row.station_id === null || row.station_id === undefined
        ? null
        : Number(row.station_id)
    ))),
    timeseries_id: int32Vector(rows.map((row) => Number(row.timeseries_id))),
    pollutant_code: textVector(rows.map((row) => String(row.pollutant_code || ""))),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_input_value_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.daqi_input_value_ugm3))),
    daqi_input_averaging_code: textVector(rows.map((row) => toNullableText(row.daqi_input_averaging_code))),
    daqi_index_level: int32Vector(rows.map((row) => toNullableInteger(row.daqi_index_level))),
    daqi_source_observation_count: int32Vector(rows.map((row) => toNullableInteger(row.daqi_source_observation_count))),
    daqi_required_observation_count: int32Vector(rows.map((row) => toNullableInteger(row.daqi_required_observation_count))),
    daqi_calculation_status: textVector(rows.map((row) => toNullableText(row.daqi_calculation_status))),
    daqi_missing_reason: textVector(rows.map((row) => toNullableText(row.daqi_missing_reason))),
    eaqi_input_value_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.eaqi_input_value_ugm3))),
    eaqi_input_averaging_code: textVector(rows.map((row) => toNullableText(row.eaqi_input_averaging_code))),
    eaqi_index_level: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_index_level))),
    eaqi_source_observation_count: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_source_observation_count))),
    eaqi_required_observation_count: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_required_observation_count))),
    eaqi_calculation_status: textVector(rows.map((row) => toNullableText(row.eaqi_calculation_status))),
    eaqi_missing_reason: textVector(rows.map((row) => toNullableText(row.eaqi_missing_reason))),
    hourly_sample_count: int32Vector(rows.map((row) => toNullableInteger(row.hourly_sample_count))),
    algorithm_version: textVector(rows.map((row) => toNullableText(row.algorithm_version))),
    computed_at_utc: timestampVector(rows.map((row) => (row.computed_at_utc ? new Date(row.computed_at_utc) : null))),
    hourly_mean_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.hourly_mean_ugm3))),
    rolling24h_mean_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.rolling24h_mean_ugm3))),
    no2_hourly_mean_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.no2_hourly_mean_ugm3))),
    pm25_hourly_mean_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.pm25_hourly_mean_ugm3))),
    pm10_hourly_mean_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.pm10_hourly_mean_ugm3))),
    pm25_rolling24h_mean_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.pm25_rolling24h_mean_ugm3))),
    pm10_rolling24h_mean_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.pm10_rolling24h_mean_ugm3))),
    daqi_no2_index_level: int32Vector(rows.map((row) => toNullableInteger(row.daqi_no2_index_level))),
    daqi_pm25_rolling24h_index_level: int32Vector(rows.map((row) => toNullableInteger(row.daqi_pm25_rolling24h_index_level))),
    daqi_pm10_rolling24h_index_level: int32Vector(rows.map((row) => toNullableInteger(row.daqi_pm10_rolling24h_index_level))),
    eaqi_no2_index_level: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_no2_index_level))),
    eaqi_pm25_index_level: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_pm25_index_level))),
    eaqi_pm10_index_level: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_pm10_index_level))),
    updated_at: timestampVector(rows.map((row) => (row.updated_at ? new Date(row.updated_at) : null))),
  });

  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const parquetBytes = parquetWasm.writeParquet(wasmTable, writerProperties);
  return Buffer.from(parquetBytes);
}

export function rowsToAqilevelParquetBufferForTest(rows) {
  return rowsToAqilevelParquetBuffer(
    rows,
    parquetWriterProperties(DEFAULT_AQILEVELS_ROW_GROUP_SIZE, HISTORY_AQILEVELS_WRITER_VERSION),
  );
}

function rowsToObservationV2ParquetBuffer(rows, writerProperties) {
  ensureParquetWasmInitialized();
  const int32Vector = (values) => arrow.vectorFromArray(values, new arrow.Int32());
  const textVector = (values) => arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values) => arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = arrow.tableFromArrays({
    connector_id: int32Vector(rows.map((row) => Number(row.connector_id))),
    station_id: int32Vector(rows.map((row) => (
      row.station_id === null || row.station_id === undefined
        ? null
        : Number(row.station_id)
    ))),
    timeseries_id: int32Vector(rows.map((row) => Number(row.timeseries_id))),
    pollutant_code: textVector(rows.map((row) => String(row.pollutant_code || ""))),
    observed_at_utc: timestampVector(rows.map((row) => new Date(row.observed_at_utc || row.observed_at))),
    value: rows.map((row) => (row.value === null || row.value === undefined ? null : Number(row.value))),
  });

  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const parquetBytes = parquetWasm.writeParquet(wasmTable, writerProperties);
  return Buffer.from(parquetBytes);
}

function rowsToAqilevelDataV2ParquetBuffer(rows, writerProperties) {
  ensureParquetWasmInitialized();
  const int32Vector = (values) => arrow.vectorFromArray(values, new arrow.Int32());
  const textVector = (values) => arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values) => arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = arrow.tableFromArrays({
    connector_id: int32Vector(rows.map((row) => Number(row.connector_id))),
    station_id: int32Vector(rows.map((row) => (
      row.station_id === null || row.station_id === undefined
        ? null
        : Number(row.station_id)
    ))),
    timeseries_id: int32Vector(rows.map((row) => Number(row.timeseries_id))),
    pollutant_code: textVector(rows.map((row) => String(row.pollutant_code || ""))),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_index_level: int32Vector(rows.map((row) => toNullableInteger(row.daqi_index_level))),
    eaqi_index_level: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_index_level))),
    daqi_calculation_status: textVector(rows.map((row) => toNullableText(row.daqi_calculation_status))),
    daqi_missing_reason: textVector(rows.map((row) => toNullableText(row.daqi_missing_reason))),
    eaqi_calculation_status: textVector(rows.map((row) => toNullableText(row.eaqi_calculation_status))),
    eaqi_missing_reason: textVector(rows.map((row) => toNullableText(row.eaqi_missing_reason))),
  });

  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const parquetBytes = parquetWasm.writeParquet(wasmTable, writerProperties);
  return Buffer.from(parquetBytes);
}

function rowsToAqilevelDebugV2ParquetBuffer(rows, writerProperties) {
  ensureParquetWasmInitialized();
  const int32Vector = (values) => arrow.vectorFromArray(values, new arrow.Int32());
  const float64Vector = (values) => arrow.vectorFromArray(values, new arrow.Float64());
  const textVector = (values) => arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values) => arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = arrow.tableFromArrays({
    connector_id: int32Vector(rows.map((row) => Number(row.connector_id))),
    station_id: int32Vector(rows.map((row) => (
      row.station_id === null || row.station_id === undefined
        ? null
        : Number(row.station_id)
    ))),
    timeseries_id: int32Vector(rows.map((row) => Number(row.timeseries_id))),
    pollutant_code: textVector(rows.map((row) => String(row.pollutant_code || ""))),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_input_value_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.daqi_input_value_ugm3))),
    daqi_input_averaging_code: textVector(rows.map((row) => toNullableText(row.daqi_input_averaging_code))),
    daqi_index_level: int32Vector(rows.map((row) => toNullableInteger(row.daqi_index_level))),
    daqi_source_observation_count: int32Vector(rows.map((row) => toNullableInteger(row.daqi_source_observation_count))),
    daqi_required_observation_count: int32Vector(rows.map((row) => toNullableInteger(row.daqi_required_observation_count))),
    daqi_calculation_status: textVector(rows.map((row) => toNullableText(row.daqi_calculation_status))),
    daqi_missing_reason: textVector(rows.map((row) => toNullableText(row.daqi_missing_reason))),
    eaqi_input_value_ugm3: float64Vector(rows.map((row) => toNullableNumber(row.eaqi_input_value_ugm3))),
    eaqi_input_averaging_code: textVector(rows.map((row) => toNullableText(row.eaqi_input_averaging_code))),
    eaqi_index_level: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_index_level))),
    eaqi_source_observation_count: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_source_observation_count))),
    eaqi_required_observation_count: int32Vector(rows.map((row) => toNullableInteger(row.eaqi_required_observation_count))),
    eaqi_calculation_status: textVector(rows.map((row) => toNullableText(row.eaqi_calculation_status))),
    eaqi_missing_reason: textVector(rows.map((row) => toNullableText(row.eaqi_missing_reason))),
    hourly_sample_count: int32Vector(rows.map((row) => toNullableInteger(row.hourly_sample_count))),
    algorithm_version: textVector(rows.map((row) => toNullableText(row.algorithm_version))),
    computed_at_utc: timestampVector(rows.map((row) => (row.computed_at_utc ? new Date(row.computed_at_utc) : null))),
  });

  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const parquetBytes = parquetWasm.writeParquet(wasmTable, writerProperties);
  return Buffer.from(parquetBytes);
}

export function rowsToObservationV2ParquetBufferForTest(rows) {
  return rowsToObservationV2ParquetBuffer(
    rows,
    parquetWriterProperties(DEFAULT_OBSERVATIONS_ROW_GROUP_SIZE, HISTORY_R2_V2_WRITER_VERSION),
  );
}

export function rowsToAqilevelDataV2ParquetBufferForTest(rows) {
  return rowsToAqilevelDataV2ParquetBuffer(
    rows,
    parquetWriterProperties(DEFAULT_AQILEVELS_ROW_GROUP_SIZE, HISTORY_R2_V2_WRITER_VERSION),
  );
}

export function rowsToAqilevelDebugV2ParquetBufferForTest(rows) {
  return rowsToAqilevelDebugV2ParquetBuffer(
    rows,
    parquetWriterProperties(DEFAULT_AQILEVELS_ROW_GROUP_SIZE, HISTORY_R2_V2_WRITER_VERSION),
  );
}

async function closeCursor(cursor) {
  await new Promise((resolve, reject) => {
    cursor.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function cursorRead(cursor, rowCount) {
  return await new Promise((resolve, reject) => {
    cursor.read(rowCount, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

async function writeCommittedPartAndCheckpoint({
  streamClient,
  runtime,
  dayUtc,
  connectorId,
  partIndex,
  rows,
  committedParts,
  observedRows,
  totalBytes,
}) {
  if (runtime.history_write_version === "v2") {
    return await writeCommittedV2PartAndCheckpoint({
      streamClient,
      runtime,
      dayUtc,
      connectorId,
      partIndex,
      rows,
      committedParts,
      observedRows,
      totalBytes,
    });
  }

  const parquetBuffer = rowsToParquetBuffer(
    rows,
    parquetWriterProperties(runtime.observations_row_group_size),
  );
  const committedKey = buildPartKey(runtime.committed_prefix, dayUtc, connectorId, partIndex);
  const putResult = await r2PutObject({
    r2: runtime.r2,
    key: committedKey,
    body: parquetBuffer,
    content_type: "application/octet-stream",
  });
  const head = await r2HeadObject({ r2: runtime.r2, key: committedKey });
  if (!head.exists) {
    throw new Error(`Missing committed object after write: ${committedKey}`);
  }

  const bytes = typeof head.bytes === "number" && Number.isFinite(head.bytes)
    ? Math.trunc(head.bytes)
    : Math.trunc(putResult.bytes);
  const etagOrHash = head.etag || putResult.etag || null;
  const partSummary = summarizeObservationPartRows(rows);
  const partEntry = {
    key: committedKey,
    row_count: rows.length,
    bytes,
    etag_or_hash: etagOrHash,
    min_timeseries_id: partSummary.min_timeseries_id,
    max_timeseries_id: partSummary.max_timeseries_id,
    min_observed_at: partSummary.min_observed_at,
    max_observed_at: partSummary.max_observed_at,
    timeseries_row_counts: partSummary.timeseries_row_counts,
  };
  const nextParts = [...committedParts, partEntry];
  const nextObservedRows = observedRows + BigInt(rows.length);
  const nextTotalBytes = totalBytes + BigInt(bytes);
  const nextPartIndex = partIndex + 1;
  const lastRow = rows[rows.length - 1];

  await updateCandidateResumeCheckpoint(streamClient, {
    dayUtc,
    connectorId,
    runId: runtime.run_id,
    lastTimeseriesId: Number(lastRow.timeseries_id),
    lastObservedAt: new Date(lastRow.observed_at).toISOString(),
    partIndex: nextPartIndex,
    exportedRowCount: nextObservedRows,
    parts: nextParts,
  });

  return {
    partIndex: nextPartIndex,
    committedParts: nextParts,
    observedRows: nextObservedRows,
    totalBytes: nextTotalBytes,
  };
}

async function writeCommittedV2PartAndCheckpoint({
  streamClient,
  runtime,
  dayUtc,
  connectorId,
  partIndex,
  rows,
  committedParts,
  observedRows,
  totalBytes,
}) {
  const groupedRows = groupRowsByPollutant(rows);
  const sourcePollutantCodes = groupedRows.map(([pollutantCode]) => pollutantCode);
  const writeGroups = groupedRows.filter(([pollutantCode]) => runtime.observations_pollutant_codes.includes(pollutantCode));
  const writePollutantCodes = writeGroups.map(([pollutantCode]) => pollutantCode);
  const excludedPollutantCodes = sourcePollutantCodes.filter((c) => !writePollutantCodes.includes(c));

  logPhaseB(runtime, "INFO", "phase_b_history_connector_pollutant_plan", {
    day_utc: dayUtc,
    connector_id: connectorId,
    source_pollutant_codes: sourcePollutantCodes,
    write_pollutant_codes: writePollutantCodes,
    excluded_pollutant_codes: excludedPollutantCodes,
    pollutant_filter_mode: "allow_list",
    pollutant_count: sourcePollutantCodes.length,
    write_pollutant_count: writePollutantCodes.length,
    row_count: rows.length,
  });
  const nextParts = [...committedParts];
  let bytesAdded = 0n;

  for (let pollutantIndex = 0; pollutantIndex < writeGroups.length; pollutantIndex += 1) {
    const [pollutantCode, pollutantRows] = writeGroups[pollutantIndex];
    assertBudget(runtime, "pollutant_part", { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode }, 15_000);
    const pollutantStartedAtMs = Date.now();
    logPhaseB(runtime, "INFO", "phase_b_history_pollutant_start", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      rows_selected: pollutantRows.length,
      part_count: 1,
      prefix: pollutantPrefix(runtime.committed_prefix, dayUtc, connectorId, pollutantCode),
    });
    logPhaseB(runtime, "INFO", "phase_b_history_parquet_build_start", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      rows_selected: pollutantRows.length,
    });
    const parquetStartedAtMs = Date.now();
    const parquetBuffer = rowsToObservationV2ParquetBuffer(
      pollutantRows,
      parquetWriterProperties(runtime.observations_row_group_size, HISTORY_R2_V2_WRITER_VERSION),
    );
    logPhaseB(runtime, "INFO", "phase_b_history_parquet_build_complete", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      rows_written: pollutantRows.length,
      duration_ms: Math.max(0, Date.now() - parquetStartedAtMs),
    });
    const committedKey = buildHistoryV2PartKey(
      runtime.committed_prefix,
      dayUtc,
      connectorId,
      pollutantCode,
      partIndex,
    );
    assertBudget(runtime, "r2_put", { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode, prefix: committedKey }, 15_000);
    logPhaseB(runtime, "INFO", "phase_b_history_r2_put_start", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      prefix: committedKey,
      rows_written: pollutantRows.length,
    });
    const putStartedAtMs = Date.now();
    const putResult = await r2PutObject({
      r2: runtime.r2,
      key: committedKey,
      body: parquetBuffer,
      content_type: "application/octet-stream",
    });
    const head = await r2HeadObject({ r2: runtime.r2, key: committedKey });
    if (!head.exists) {
      throw new Error(`Missing committed object after write: ${committedKey}`);
    }
    logPhaseB(runtime, "INFO", "phase_b_history_r2_put_complete", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      prefix: committedKey,
      duration_ms: Math.max(0, Date.now() - putStartedAtMs),
    });

    const bytes = typeof head.bytes === "number" && Number.isFinite(head.bytes)
      ? Math.trunc(head.bytes)
      : Math.trunc(putResult.bytes);
    const etagOrHash = head.etag || putResult.etag || null;
    const partSummary = summarizeObservationV2PartRows(pollutantRows);
    nextParts.push({
      key: committedKey,
      row_count: pollutantRows.length,
      bytes,
      etag_or_hash: etagOrHash,
      pollutant_code: pollutantCode,
      min_timeseries_id: partSummary.min_timeseries_id,
      max_timeseries_id: partSummary.max_timeseries_id,
      min_observed_at_utc: partSummary.min_observed_at_utc,
      max_observed_at_utc: partSummary.max_observed_at_utc,
      timeseries_row_counts: partSummary.timeseries_row_counts,
    });
    bytesAdded += BigInt(bytes);
    logPhaseB(runtime, "INFO", "phase_b_history_pollutant_complete", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      rows_written: pollutantRows.length,
      part_count: 1,
      duration_ms: Math.max(0, Date.now() - pollutantStartedAtMs),
    });
    logPhaseB(runtime, "INFO", "phase_b_history_pollutant_loop_after_complete", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      pollutant_index: pollutantIndex,
      pollutant_count: groupedRows.length,
      next_pollutant_code: groupedRows[pollutantIndex + 1]?.[0] || null,
      written_pollutant_count: pollutantIndex + 1,
    });
    assertBudget(runtime, "after_pollutant_complete", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      next_pollutant_code: groupedRows[pollutantIndex + 1]?.[0] || null,
    }, 15_000);
  }

  const nextObservedRows = observedRows + BigInt(rows.length);
  const nextTotalBytes = totalBytes + bytesAdded;
  const nextPartIndex = partIndex + 1;
  const lastRow = rows[rows.length - 1];
  const lastObservedAt = observedAtForHistoryRow(lastRow);

  const checkpointPayload = {
    dayUtc,
    connectorId,
    runId: runtime.run_id,
    lastTimeseriesId: Number(lastRow.timeseries_id),
    lastObservedAt: new Date(lastObservedAt).toISOString(),
    partIndex: nextPartIndex,
    exportedRowCount: nextObservedRows,
    parts: nextParts,
  };

  logPhaseB(runtime, "INFO", "phase_b_history_checkpoint_write_start", {
    day_utc: dayUtc,
    connector_id: connectorId,
    part_index: nextPartIndex,
    rows_written: nextObservedRows.toString(),
    part_count: nextParts.length,
  });
  const checkpointStartedAtMs = Date.now();
  try {
    if (runtime.checkpoint_client_for_test) {
      await updateCandidateResumeCheckpoint(runtime.checkpoint_client_for_test, checkpointPayload);
    } else if (runtime.supabase_db_url) {
      await withPgClient(runtime.supabase_db_url, async (checkpointClient) => {
        await updateCandidateResumeCheckpoint(checkpointClient, checkpointPayload);
      });
    } else {
      await updateCandidateResumeCheckpoint(streamClient, checkpointPayload);
    }
  } catch (error) {
    logPhaseB(runtime, "ERROR", "phase_b_history_checkpoint_write_failed", {
      day_utc: dayUtc,
      connector_id: connectorId,
      part_index: nextPartIndex,
      rows_written: nextObservedRows.toString(),
      part_count: nextParts.length,
      duration_ms: Math.max(0, Date.now() - checkpointStartedAtMs),
      ...errorLogFields(error),
    });
    throw error;
  }
  logPhaseB(runtime, "INFO", "phase_b_history_checkpoint_write_complete", {
    day_utc: dayUtc,
    connector_id: connectorId,
    part_index: nextPartIndex,
    rows_written: nextObservedRows.toString(),
    part_count: nextParts.length,
    duration_ms: Math.max(0, Date.now() - checkpointStartedAtMs),
  });

  return {
    partIndex: nextPartIndex,
    committedParts: nextParts,
    observedRows: nextObservedRows,
    totalBytes: nextTotalBytes,
  };
}

export async function writeCommittedV2PartAndCheckpointForTest(args) {
  return await writeCommittedV2PartAndCheckpoint(args);
}

async function writeObservationV2ConnectorManifest({
  runtime,
  dayUtc,
  connectorId,
  committedParts,
  backedUpAtUtc,
}) {
  assertBudget(runtime, "connector_manifest_prepare", { day_utc: dayUtc, connector_id: connectorId }, 15_000);
  const prepareStartedAtMs = Date.now();
  logPhaseB(runtime, "INFO", "phase_b_history_connector_manifest_prepare_start", {
    day_utc: dayUtc,
    connector_id: connectorId,
    part_count: committedParts.length,
  });
  const partsByPollutant = new Map();
  for (const part of committedParts) {
    const pollutantCode = normalizePollutantCodeForPath(part.pollutant_code);
    if (!partsByPollutant.has(pollutantCode)) {
      partsByPollutant.set(pollutantCode, []);
    }
    partsByPollutant.get(pollutantCode).push(part);
  }

  const pollutantManifests = [];
  logPhaseB(runtime, "INFO", "phase_b_history_connector_manifest_prepare_complete", {
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_codes: Array.from(partsByPollutant.keys()).sort(),
    pollutant_count: partsByPollutant.size,
    part_count: committedParts.length,
    duration_ms: Math.max(0, Date.now() - prepareStartedAtMs),
  });
  for (const [pollutantCode, pollutantParts] of Array.from(partsByPollutant.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    assertBudget(runtime, "manifest_write", { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode }, 10_000);
    const pollutantManifestKey = buildHistoryV2PollutantManifestKey(
      runtime.committed_prefix,
      dayUtc,
      connectorId,
      pollutantCode,
    );
    const sourceRowCount = pollutantParts.reduce((sum, part) => sum + Number(part.row_count || 0), 0);
    const pollutantManifest = createHistoryV2PollutantManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      pollutantCode,
      runId: runtime.run_id,
      manifestKey: pollutantManifestKey,
      sourceRowCount,
      fileEntries: pollutantParts,
      writerGitSha: runtime.writer_git_sha,
      backedUpAtUtc,
    });
    logPhaseB(runtime, "INFO", "phase_b_history_manifest_write_start", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      manifest_path: pollutantManifestKey,
      part_count: pollutantParts.length,
    });
    const manifestStartedAtMs = Date.now();
    await r2PutObject({
      r2: runtime.r2,
      key: pollutantManifestKey,
      body: Buffer.from(JSON.stringify(pollutantManifest, null, 2), "utf8"),
      content_type: "application/json",
    });
    const pollutantManifestHead = await r2HeadObject({ r2: runtime.r2, key: pollutantManifestKey });
    if (!pollutantManifestHead.exists) {
      throw new Error(`V2 pollutant manifest missing after upload: ${pollutantManifestKey}`);
    }
    logPhaseB(runtime, "INFO", "phase_b_history_manifest_write_complete", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      manifest_path: pollutantManifestKey,
      part_count: pollutantParts.length,
      duration_ms: Math.max(0, Date.now() - manifestStartedAtMs),
    });
    pollutantManifests.push(pollutantManifest);
  }

  const connectorManifestKey = buildHistoryV2ConnectorManifestKey(runtime.committed_prefix, dayUtc, connectorId);
  const connectorManifest = createHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc,
    connectorId,
    runId: runtime.run_id,
    manifestKey: connectorManifestKey,
    pollutantManifests,
    writerGitSha: runtime.writer_git_sha,
    backedUpAtUtc,
  });
  logPhaseB(runtime, "INFO", "phase_b_history_manifest_write_start", {
    day_utc: dayUtc,
    connector_id: connectorId,
    manifest_path: connectorManifestKey,
    part_count: committedParts.length,
  });
  const connectorManifestStartedAtMs = Date.now();
  await r2PutObject({
    r2: runtime.r2,
    key: connectorManifestKey,
    body: Buffer.from(JSON.stringify(connectorManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  const connectorManifestHead = await r2HeadObject({ r2: runtime.r2, key: connectorManifestKey });
  if (!connectorManifestHead.exists) {
    throw new Error(`V2 connector manifest missing after upload: ${connectorManifestKey}`);
  }
  logPhaseB(runtime, "INFO", "phase_b_history_manifest_write_complete", {
    day_utc: dayUtc,
    connector_id: connectorId,
    manifest_path: connectorManifestKey,
    part_count: committedParts.length,
    duration_ms: Math.max(0, Date.now() - connectorManifestStartedAtMs),
  });
  return { connectorManifest, connectorManifestKey };
}

async function cleanupCandidatePartialOutput({ runtime, dayUtc, connectorId }) {
  const prefix = connectorPrefix(runtime.committed_prefix, dayUtc, connectorId);
  logPhaseB(runtime, "WARNING", "phase_b_history_partial_cleanup_start", {
    day_utc: dayUtc,
    connector_id: connectorId,
    prefix,
  });
  const entries = await r2ListAllObjects({ r2: runtime.r2, prefix: `${prefix}/`, max_keys: 1000 });
  const keys = entries.map((entry) => entry.key);
  let deletedCount = 0;
  let errorCount = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const result = await r2DeleteObjects({ r2: runtime.r2, keys: keys.slice(i, i + 1000) });
    deletedCount += result.deleted_count;
    errorCount += result.errors.length;
  }
  logPhaseB(runtime, "WARNING", "phase_b_history_partial_cleanup_complete", {
    day_utc: dayUtc,
    connector_id: connectorId,
    prefix,
    scanned_count: entries.length,
    deleted_count: deletedCount,
    error_count: errorCount,
  });
  return { scanned_count: entries.length, deleted_count: deletedCount, error_count: errorCount };
}

export function shouldResetManifestlessV2ResumeForTest({
  connectorManifestExists,
  existingEntryCount,
  resumePartIndex,
  resumeParts,
}) {
  return !connectorManifestExists && (
    Number(existingEntryCount || 0) > 0 ||
    Number(resumePartIndex || 0) > 0 ||
    (Array.isArray(resumeParts) && resumeParts.length > 0)
  );
}

async function exportCandidateToR2({ candidate, runtime }) {
  const dayUtc = candidate.day_utc;
  const connectorId = candidate.connector_id;
  const dayStart = `${dayUtc}T00:00:00.000Z`;
  const dayEnd = `${shiftIsoDay(dayUtc, 1)}T00:00:00.000Z`;

  const expectedRowCount = candidate.expected_row_count;
  let committedParts = [...candidate.resume_parts];
  let observedRows = candidate.resume_exported_row_count;
  const observedRowsFromParts = committedParts.reduce(
    (sum, part) => sum + BigInt(part.row_count),
    0n,
  );
  if (observedRows !== observedRowsFromParts) {
    observedRows = observedRowsFromParts;
  }
  let totalBytes = committedParts.reduce(
    (sum, part) => sum + BigInt(part.bytes),
    0n,
  );
  let partIndex = Number(candidate.resume_part_index || 0);
  let resumeTimeseriesId = candidate.resume_last_timeseries_id;
  let resumeObservedAt = candidate.resume_last_observed_at;
  logPhaseB(runtime, "INFO", "phase_b_history_connector_start", {
    day_utc: dayUtc,
    connector_id: connectorId,
    rows_selected: expectedRowCount.toString(),
    prefix: connectorPrefix(runtime.committed_prefix, dayUtc, connectorId),
    manifest_path: buildConnectorManifestKey(runtime.committed_prefix, dayUtc, connectorId),
  });

  if (runtime.history_write_version === "v2" && partIndex > committedParts.length) {
    throw new Error(
      `Resume checkpoint mismatch for day=${dayUtc} connector=${connectorId}: v2 part_index=${partIndex} parts=${committedParts.length}`,
    );
  }
  if (runtime.history_write_version !== "v2" && partIndex !== committedParts.length) {
    throw new Error(
      `Resume checkpoint mismatch for day=${dayUtc} connector=${connectorId}: part_index=${partIndex} parts=${committedParts.length}`,
    );
  }
  if (partIndex > 0 && (resumeTimeseriesId === null || !resumeObservedAt)) {
    throw new Error(
      `Resume checkpoint missing key tuple for day=${dayUtc} connector=${connectorId} with part_index=${partIndex}`,
    );
  }

  if (runtime.history_write_version === "v2") {
    const connectorManifestKey = buildHistoryV2ConnectorManifestKey(runtime.committed_prefix, dayUtc, connectorId);
    const connectorManifestHead = await r2HeadObject({ r2: runtime.r2, key: connectorManifestKey });
    if (!connectorManifestHead.exists) {
      const existingEntries = await r2ListAllObjects({
        r2: runtime.r2,
        prefix: `${connectorPrefix(runtime.committed_prefix, dayUtc, connectorId)}/`,
        max_keys: 1000,
      });
      if (shouldResetManifestlessV2ResumeForTest({
        connectorManifestExists: connectorManifestHead.exists,
        existingEntryCount: existingEntries.length,
        resumePartIndex: partIndex,
        resumeParts: committedParts,
      })) {
        logPhaseB(runtime, "WARNING", "phase_b_history_candidate_skipped", {
          day_utc: dayUtc,
          connector_id: connectorId,
          prefix: connectorPrefix(runtime.committed_prefix, dayUtc, connectorId),
          reason: "manifestless_partial_final_prefix_cleanup_before_retry",
        });
        if (existingEntries.length > 0) {
          await cleanupCandidatePartialOutput({ runtime, dayUtc, connectorId });
        }
        committedParts = [];
        observedRows = 0n;
        totalBytes = 0n;
        partIndex = 0;
        resumeTimeseriesId = null;
        resumeObservedAt = null;
      }
    }
  }

  for (const part of committedParts) {
    const head = await r2HeadObject({ r2: runtime.r2, key: part.key });
    if (!head.exists) {
      throw new Error(`Resume checkpoint references missing committed object: ${part.key}`);
    }
    if (typeof head.bytes === "number" && Number.isFinite(head.bytes)) {
      part.bytes = Math.trunc(head.bytes);
    }
    part.etag_or_hash = head.etag || part.etag_or_hash || null;
  }
  totalBytes = committedParts.reduce((sum, part) => sum + BigInt(part.bytes), 0n);

  await withPgClient(runtime.supabase_db_url, async (streamClient) => {
    const sql = runtime.history_write_version === "v2" ? `
select
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,
  observed_at_utc,
  value
from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  $4::integer,
  $5::timestamptz
)
` : `
select
  connector_id,
  timeseries_id,
  observed_at,
  value
from uk_aq_ops.uk_aq_phase_b_history_rows(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  $4::integer,
  $5::timestamptz
)
`;

    const cursor = streamClient.query(
      new Cursor(sql, [connectorId, dayStart, dayEnd, resumeTimeseriesId, resumeObservedAt]),
    );
    let pendingRows = [];

    try {
      for (;;) {
        assertBudget(runtime, "row_fetch", { day_utc: dayUtc, connector_id: connectorId }, 30_000);
        logPhaseB(runtime, "INFO", "phase_b_history_row_fetch_start", {
          day_utc: dayUtc,
          connector_id: connectorId,
          rows_selected: observedRows.toString(),
        });
        const fetchStartedAtMs = Date.now();
        const rows = await cursorRead(cursor, runtime.cursor_fetch_rows);
        logPhaseB(runtime, "INFO", "phase_b_history_row_fetch_complete", {
          day_utc: dayUtc,
          connector_id: connectorId,
          rows_selected: rows.length,
          duration_ms: Math.max(0, Date.now() - fetchStartedAtMs),
        });
        if (!rows.length) {
          break;
        }

        for (const row of rows) {
          if (runtime.history_write_version === "v2") {
            pendingRows.push({
              connector_id: Number(row.connector_id),
              station_id: row.station_id === null || row.station_id === undefined
                ? null
                : Number(row.station_id),
              timeseries_id: Number(row.timeseries_id),
              pollutant_code: normalizePollutantCodeForPath(row.pollutant_code),
              observed_at_utc: row.observed_at_utc,
              value: row.value,
            });
          } else {
            pendingRows.push({
              connector_id: Number(row.connector_id),
              timeseries_id: Number(row.timeseries_id),
              observed_at: row.observed_at,
              value: row.value,
            });
          }

          if (pendingRows.length >= runtime.observations_part_max_rows) {
            const flushed = await writeCommittedPartAndCheckpoint({
              streamClient,
              runtime,
              dayUtc,
              connectorId,
              partIndex,
              rows: pendingRows,
              committedParts,
              observedRows,
              totalBytes,
            });
            partIndex = flushed.partIndex;
            committedParts = flushed.committedParts;
            observedRows = flushed.observedRows;
            totalBytes = flushed.totalBytes;
            pendingRows = [];
          }
        }
      }

      if (pendingRows.length > 0) {
        const flushed = await writeCommittedPartAndCheckpoint({
          streamClient,
          runtime,
          dayUtc,
          connectorId,
          partIndex,
          rows: pendingRows,
          committedParts,
          observedRows,
          totalBytes,
        });
        partIndex = flushed.partIndex;
        committedParts = flushed.committedParts;
        observedRows = flushed.observedRows;
        totalBytes = flushed.totalBytes;
      }
    } finally {
      await closeCursor(cursor);
    }
  });

  if (observedRows !== expectedRowCount) {
    throw new Error(
      `Row count mismatch for day=${dayUtc} connector=${connectorId}: expected=${expectedRowCount.toString()} observed=${observedRows.toString()}`,
    );
  }

  const backedUpAtUtc = nowIso();
  if (runtime.history_write_version === "v2") {
    const { connectorManifest, connectorManifestKey } = await writeObservationV2ConnectorManifest({
      runtime,
      dayUtc,
      connectorId,
      committedParts,
      backedUpAtUtc,
    });

    logPhaseB(runtime, "INFO", "phase_b_history_connector_complete", {
      day_utc: dayUtc,
      connector_id: connectorId,
      rows_written: observedRows.toString(),
      part_count: committedParts.length,
      manifest_path: connectorManifestKey,
      prefix: connectorPrefix(runtime.committed_prefix, dayUtc, connectorId),
    });
    return {
      day_utc: dayUtc,
      connector_id: connectorId,
      manifest_key: connectorManifestKey,
      source_row_count: expectedRowCount,
      written_row_count: observedRows,
      file_count: committedParts.length,
      total_bytes: totalBytes,
      parquet_object_keys: connectorManifest.parquet_object_keys,
      files: committedParts,
    };
  }

  const connectorManifest = createConnectorManifest({
    dayUtc,
    connectorId,
    runId: runtime.run_id,
    sourceRowCount: Number(expectedRowCount),
    minObservedAt: candidate.min_observed_at,
    maxObservedAt: candidate.max_observed_at,
    fileEntries: committedParts,
    writerGitSha: runtime.writer_git_sha,
    backedUpAtUtc,
  });

  const connectorManifestKey = buildConnectorManifestKey(runtime.committed_prefix, dayUtc, connectorId);
  await r2PutObject({
    r2: runtime.r2,
    key: connectorManifestKey,
    body: Buffer.from(JSON.stringify(connectorManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  const manifestHead = await r2HeadObject({ r2: runtime.r2, key: connectorManifestKey });
  if (!manifestHead.exists) {
    throw new Error(`Connector manifest missing after upload: ${connectorManifestKey}`);
  }

  return {
    day_utc: dayUtc,
    connector_id: connectorId,
    manifest_key: connectorManifestKey,
    source_row_count: expectedRowCount,
    written_row_count: observedRows,
    file_count: committedParts.length,
    total_bytes: totalBytes,
    parquet_object_keys: committedParts.map((part) => part.key),
    files: committedParts,
  };
}

async function dropboxRefreshAccessToken(dropboxConfig) {
  const appKey = String(dropboxConfig?.app_key || "").trim();
  const appSecret = String(dropboxConfig?.app_secret || "").trim();
  const refreshToken = String(dropboxConfig?.refresh_token || "").trim();
  if (!(appKey && appSecret && refreshToken)) {
    throw new Error("Dropbox credentials missing (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN).");
  }

  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  });

  const tokenResp = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (!tokenResp.ok) {
    const text = await readResponseText(tokenResp);
    throw new Error(`Dropbox token request failed (${tokenResp.status}): ${text}`);
  }
  const tokenJson = await tokenResp.json();
  const token = String(tokenJson?.access_token || "").trim();
  if (!token) {
    throw new Error("Dropbox token response missing access_token.");
  }
  return token;
}

async function uploadBytesToDropbox({ accessToken, path, body, contentType = "application/octet-stream" }) {
  // Dropbox /2/files/upload rejects application/json; force JSON payloads to octet-stream.
  const normalizedContentType = /^application\/json\b/i.test(String(contentType || ""))
    ? "application/octet-stream"
    : contentType;
  const response = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": normalizedContentType,
      "Dropbox-API-Arg": JSON.stringify({
        path,
        mode: "overwrite",
        autorename: false,
        mute: true,
      }),
    },
    body,
  });
  if (!response.ok) {
    const text = await readResponseText(response);
    throw new Error(`Dropbox upload failed (${response.status}) path=${path}: ${text}`);
  }
}

function normalizeManifestParquetKeys(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [];
  }
  const fromParquetObjectKeys = Array.isArray(manifest.parquet_object_keys)
    ? manifest.parquet_object_keys
      .map((value) => String(value || "").trim())
      .filter(Boolean)
    : [];
  if (fromParquetObjectKeys.length > 0) {
    return fromParquetObjectKeys;
  }
  if (!Array.isArray(manifest.files)) {
    return [];
  }
  return manifest.files
    .map((entry) => (entry && typeof entry === "object") ? String(entry.key || "").trim() : "")
    .filter(Boolean);
}

function parseManifestBigInt(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`Missing required manifest field: ${fieldName}`);
  }
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) {
      throw new Error(`Negative value not allowed for ${fieldName}`);
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid manifest bigint ${fieldName}: ${message}`);
  }
}

function parseManifestPositiveInt(value, fieldName, allowZero = false) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`Missing required manifest field: ${fieldName}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid manifest integer ${fieldName}`);
  }
  if (allowZero ? parsed < 0 : parsed <= 0) {
    throw new Error(`Invalid manifest integer ${fieldName}=${parsed}`);
  }
  return parsed;
}

function validateAdoptedManifest({
  manifest,
  dayUtc,
  connectorId,
  manifestKey,
}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid manifest JSON object for ${manifestKey}`);
  }
  const manifestDay = normalizeDayUtc(manifest.day_utc);
  if (!manifestDay || manifestDay !== dayUtc) {
    throw new Error(`Manifest day mismatch for ${manifestKey}: expected=${dayUtc} actual=${manifestDay || "missing"}`);
  }
  const manifestConnector = Number(manifest.connector_id);
  if (!Number.isInteger(manifestConnector) || manifestConnector !== connectorId) {
    throw new Error(
      `Manifest connector mismatch for ${manifestKey}: expected=${connectorId} actual=${String(manifest.connector_id ?? "missing")}`,
    );
  }

  const manifestRowCount = parseManifestBigInt(manifest.source_row_count, "source_row_count");
  const manifestFileCount = parseManifestPositiveInt(manifest.file_count, "file_count", false);
  const manifestTotalBytes = parseManifestBigInt(manifest.total_bytes, "total_bytes");
  const parquetKeys = normalizeManifestParquetKeys(manifest);
  if (parquetKeys.length === 0) {
    throw new Error(`Manifest has no parquet object keys: ${manifestKey}`);
  }
  if (parquetKeys.length < manifestFileCount) {
    throw new Error(
      `Manifest file_count exceeds available parquet keys for ${manifestKey}: file_count=${manifestFileCount} keys=${parquetKeys.length}`,
    );
  }

  return {
    manifest,
    manifest_row_count: manifestRowCount,
    manifest_file_count: manifestFileCount,
    manifest_total_bytes: manifestTotalBytes,
    parquet_keys: parquetKeys,
  };
}

function createPruneComparisonManifest({
  baseManifest,
  canonicalManifestKey,
}) {
  const { manifest_hash: _discard, ...withoutHash } = baseManifest;
  return withManifestHash({
    ...withoutHash,
    comparison_only: true,
    safe_to_promote: false,
    source_owner: "phase_b_prune_check",
    storage_target: "dropbox",
    canonical_r2_manifest_key: canonicalManifestKey,
  });
}

function formatRunFolderPrefix(nowUtcIso) {
  const dt = new Date(nowUtcIso);
  if (Number.isNaN(dt.getTime())) {
    return "unknown_0000_";
  }
  const yyyy = String(dt.getUTCFullYear());
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const min = String(dt.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}${min}_`;
}

function buildPruneComparisonBasePath({ runtime, dayUtc, connectorId }) {
  const configuredDir = String(runtime.prune_check_dropbox?.dir || DEFAULT_PRUNE_CHECK_DROPBOX_DIR).trim();
  const cleanDir = configuredDir.replace(/^\/+/, "").replace(/\/+$/, "") || DEFAULT_PRUNE_CHECK_DROPBOX_DIR;
  const runFolderPrefix = formatRunFolderPrefix(runtime.now_utc);
  const suffix = `/${cleanDir}/${runFolderPrefix}run_id=${runtime.run_id}/observations/day_utc=${dayUtc}/connector_id=${connectorId}`;
  return joinDropboxPath(runtime.dropbox?.root || "", suffix);
}

async function exportPruneComparisonToDropbox({
  candidate,
  runtime,
  adoptedManifestKey,
  adoptedManifest,
  logStructured,
}) {
  const dayUtc = candidate.day_utc;
  const connectorId = candidate.connector_id;
  const dayStart = `${dayUtc}T00:00:00.000Z`;
  const dayEnd = `${shiftIsoDay(dayUtc, 1)}T00:00:00.000Z`;
  const comparisonRoot = buildPruneComparisonBasePath({ runtime, dayUtc, connectorId });

  const accessToken = await dropboxRefreshAccessToken(runtime.dropbox);
  const committedParts = [];
  let observedRows = 0n;
  let totalBytes = 0n;
  let partIndex = 0;

  await withPgClient(runtime.supabase_db_url, async (streamClient) => {
    const sql = `
select
  connector_id,
  timeseries_id,
  observed_at,
  value
from uk_aq_ops.uk_aq_phase_b_history_rows(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  $4::integer,
  $5::timestamptz
)
`;

    const cursor = streamClient.query(
      new Cursor(sql, [connectorId, dayStart, dayEnd, null, null]),
    );
    let pendingRows = [];

    const flushPart = async () => {
      if (!pendingRows.length) {
        return;
      }
      const rows = pendingRows;
      pendingRows = [];
      const parquetBuffer = rowsToParquetBuffer(
        rows,
        parquetWriterProperties(runtime.observations_row_group_size),
      );
      const fileName = `part-${String(partIndex).padStart(5, "0")}.parquet`;
      const dropboxPath = `${comparisonRoot}/${fileName}`;
      await uploadBytesToDropbox({
        accessToken,
        path: dropboxPath,
        body: parquetBuffer,
      });

      const partSummary = summarizeObservationPartRows(rows);
      const bytes = Buffer.byteLength(parquetBuffer);
      committedParts.push({
        key: dropboxPath,
        row_count: rows.length,
        bytes,
        etag_or_hash: sha256Hex(parquetBuffer),
        min_timeseries_id: partSummary.min_timeseries_id,
        max_timeseries_id: partSummary.max_timeseries_id,
        min_observed_at: partSummary.min_observed_at,
        max_observed_at: partSummary.max_observed_at,
        timeseries_row_counts: partSummary.timeseries_row_counts,
      });
      observedRows += BigInt(rows.length);
      totalBytes += BigInt(bytes);
      partIndex += 1;
    };

    try {
      for (;;) {
        const rows = await cursorRead(cursor, runtime.cursor_fetch_rows);
        if (!rows.length) {
          break;
        }
        for (const row of rows) {
          pendingRows.push({
            connector_id: Number(row.connector_id),
            timeseries_id: Number(row.timeseries_id),
            observed_at: row.observed_at,
            value: row.value,
          });
          if (pendingRows.length >= runtime.observations_part_max_rows) {
            await flushPart();
          }
        }
      }
      if (pendingRows.length > 0) {
        await flushPart();
      }
    } finally {
      await closeCursor(cursor);
    }
  });

  const comparisonManifestBase = createConnectorManifest({
    dayUtc,
    connectorId,
    runId: runtime.run_id,
    sourceRowCount: Number(observedRows),
    minObservedAt: candidate.min_observed_at,
    maxObservedAt: candidate.max_observed_at,
    fileEntries: committedParts,
    writerGitSha: runtime.writer_git_sha,
    backedUpAtUtc: nowIso(),
  });
  const pruneManifest = createPruneComparisonManifest({
    baseManifest: comparisonManifestBase,
    canonicalManifestKey: adoptedManifestKey,
  });
  const adoptedRows = parseManifestBigInt(adoptedManifest?.source_row_count, "source_row_count");
  const adoptedFiles = parseManifestPositiveInt(adoptedManifest?.file_count, "file_count", false);
  const adoptedBytes = parseManifestBigInt(adoptedManifest?.total_bytes, "total_bytes");
  const rowCountDelta = observedRows - adoptedRows;

  const comparisonContext = {
    run_id: runtime.run_id,
    day_utc: dayUtc,
    connector_id: connectorId,
    adopted_r2_manifest_key: adoptedManifestKey,
    adopted_r2_manifest_hash: String(adoptedManifest?.manifest_hash || "").trim() || null,
    prune_manifest_hash: String(pruneManifest?.manifest_hash || "").trim() || null,
    adopted_r2_source_row_count: adoptedRows.toString(),
    prune_source_row_count: observedRows.toString(),
    row_count_delta: rowCountDelta.toString(),
    adopted_r2_file_count: adoptedFiles,
    prune_file_count: committedParts.length,
    adopted_r2_total_bytes: adoptedBytes.toString(),
    prune_total_bytes: totalBytes.toString(),
    comparison_output_root: comparisonRoot,
    notes: "comparison only; committed R2 was not overwritten",
  };

  await uploadBytesToDropbox({
    accessToken,
    path: `${comparisonRoot}/prune_manifest.json`,
    body: Buffer.from(JSON.stringify(pruneManifest, null, 2), "utf8"),
    contentType: "application/json",
  });
  await uploadBytesToDropbox({
    accessToken,
    path: `${comparisonRoot}/adopted_r2_manifest.json`,
    body: Buffer.from(JSON.stringify(adoptedManifest, null, 2), "utf8"),
    contentType: "application/json",
  });
  await uploadBytesToDropbox({
    accessToken,
    path: `${comparisonRoot}/comparison_context.json`,
    body: Buffer.from(JSON.stringify(comparisonContext, null, 2), "utf8"),
    contentType: "application/json",
  });

  logStructured("INFO", "phase_b_history_prune_check_dropbox_export_complete", {
    run_id: runtime.run_id,
    day_utc: dayUtc,
    connector_id: connectorId,
    comparison_output_root: comparisonRoot,
    prune_source_row_count: observedRows.toString(),
    adopted_source_row_count: adoptedRows.toString(),
    row_count_delta: rowCountDelta.toString(),
  });

  return {
    comparison_output_root: comparisonRoot,
    prune_source_row_count: observedRows,
    adopted_source_row_count: adoptedRows,
    row_count_delta: rowCountDelta,
  };
}

async function maybeAdoptExistingConnectorManifest({
  candidate,
  runtime,
  logStructured,
}) {
  if (!runtime.adopt_existing_manifest_enabled) {
    return { adopted: false, reason: "adoption_guard_disabled" };
  }

  const dayUtc = candidate.day_utc;
  const connectorId = candidate.connector_id;
  const connectorManifestKey = buildConnectorManifestKey(runtime.committed_prefix, dayUtc, connectorId);
  const manifestHead = await r2HeadObject({ r2: runtime.r2, key: connectorManifestKey });
  if (!manifestHead.exists) {
    return { adopted: false, reason: "manifest_missing" };
  }

  logStructured("INFO", "phase_b_history_existing_manifest_found", {
    run_id: runtime.run_id,
    day_utc: dayUtc,
    connector_id: connectorId,
    manifest_key: connectorManifestKey,
  });

  try {
    const object = await r2GetObject({ r2: runtime.r2, key: connectorManifestKey });
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(object.body.toString("utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Manifest JSON parse failed for ${connectorManifestKey}: ${message}`);
    }
    const validated = validateAdoptedManifest({
      manifest: parsedManifest,
      dayUtc,
      connectorId,
      manifestKey: connectorManifestKey,
    });

    const probeKey = validated.parquet_keys[0];
    const probeHead = await r2HeadObject({ r2: runtime.r2, key: probeKey });
    if (!probeHead.exists) {
      throw new Error(`Adopted manifest references missing parquet object: ${probeKey}`);
    }

    let comparison = null;
    if (runtime.prune_check_dropbox?.enabled) {
      logPhaseB(runtime, "INFO", "phase_b_history_dropbox_check_start", {
        day_utc: dayUtc,
        connector_id: connectorId,
        manifest_key: connectorManifestKey,
      });
      try {
        comparison = await exportPruneComparisonToDropbox({
          candidate,
          runtime,
          adoptedManifestKey: connectorManifestKey,
          adoptedManifest: validated.manifest,
          logStructured,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logPhaseB(runtime, "ERROR", "phase_b_history_dropbox_check_failed", {
          day_utc: dayUtc,
          connector_id: connectorId,
          manifest_key: connectorManifestKey,
          error: message,
          ...errorLogFields(error),
          required: runtime.prune_check_dropbox?.required === true,
        });
        if (runtime.prune_check_dropbox?.required) {
          throw error;
        }
      }
      if (comparison) {
        logPhaseB(runtime, "INFO", "phase_b_history_dropbox_check_complete", {
          day_utc: dayUtc,
          connector_id: connectorId,
          manifest_key: connectorManifestKey,
          comparison_output_root: comparison.comparison_output_root,
        });
      }
    }

    return {
      adopted: true,
      manifest_key: connectorManifestKey,
      history_row_count: validated.manifest_row_count,
      history_file_count: validated.manifest_file_count,
      history_total_bytes: validated.manifest_total_bytes,
      comparison,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStructured("ERROR", "phase_b_history_existing_manifest_adoption_failed", {
      run_id: runtime.run_id,
      day_utc: dayUtc,
      connector_id: connectorId,
      manifest_key: connectorManifestKey,
      error: message,
    });
    throw error;
  }
}

function toAqilevelConnectorCountRow(row) {
  const expectedRowCountValue = row.expected_row_count === undefined
    ? row.row_count
    : row.expected_row_count;
  return {
    connector_id: Number(row.connector_id),
    expected_row_count: parseBigInt(expectedRowCountValue, "aqi_expected_row_count"),
    min_timeseries_id: Number.isFinite(Number(row.min_timeseries_id))
      ? Math.max(1, Math.trunc(Number(row.min_timeseries_id)))
      : null,
    max_timeseries_id: Number.isFinite(Number(row.max_timeseries_id))
      ? Math.max(1, Math.trunc(Number(row.max_timeseries_id)))
      : null,
    min_timestamp_hour_utc: row.min_timestamp_hour_utc
      ? new Date(row.min_timestamp_hour_utc).toISOString()
      : null,
    max_timestamp_hour_utc: row.max_timestamp_hour_utc
      ? new Date(row.max_timestamp_hour_utc).toISOString()
      : null,
  };
}

function hasAqilevelSourceConfig(runtime) {
  const source = runtime?.aqilevels_source || {};
  return Boolean(
    String(source.base_url || "").trim()
    && String(source.privileged_key || "").trim()
    && String(source.rpc_schema || "").trim()
    && String(source.connector_counts_rpc || "").trim()
    && String(source.rows_rpc || "").trim(),
  );
}

function normalizeAqilevelHistoryRow(row, connectorIdFallback = null) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const pollutantCode = toNullableText(row.pollutant_code)?.toLowerCase() || null;
  const parsed = {
    connector_id: toNullablePositiveInteger(row.connector_id)
      ?? toNullablePositiveInteger(connectorIdFallback),
    station_id: toNullablePositiveInteger(row.station_id),
    timeseries_id: toNullablePositiveInteger(row.timeseries_id),
    pollutant_code: (
      pollutantCode === "no2" || pollutantCode === "pm25" || pollutantCode === "pm10"
    ) ? pollutantCode : null,
    timestamp_hour_utc: toNullableIsoTimestamp(row.timestamp_hour_utc),
    daqi_input_value_ugm3: toNullableNumber(row.daqi_input_value_ugm3),
    daqi_input_averaging_code: toNullableText(row.daqi_input_averaging_code),
    daqi_index_level: toNullableInteger(row.daqi_index_level),
    daqi_source_observation_count: toNullableInteger(row.daqi_source_observation_count),
    daqi_required_observation_count: toNullableInteger(row.daqi_required_observation_count),
    daqi_calculation_status: toNullableText(row.daqi_calculation_status),
    daqi_missing_reason: toNullableText(row.daqi_missing_reason),
    eaqi_input_value_ugm3: toNullableNumber(row.eaqi_input_value_ugm3),
    eaqi_input_averaging_code: toNullableText(row.eaqi_input_averaging_code),
    eaqi_index_level: toNullableInteger(row.eaqi_index_level),
    eaqi_source_observation_count: toNullableInteger(row.eaqi_source_observation_count),
    eaqi_required_observation_count: toNullableInteger(row.eaqi_required_observation_count),
    eaqi_calculation_status: toNullableText(row.eaqi_calculation_status),
    eaqi_missing_reason: toNullableText(row.eaqi_missing_reason),
    hourly_sample_count: toNullableInteger(row.hourly_sample_count),
    algorithm_version: toNullableText(row.algorithm_version),
    computed_at_utc: toNullableIsoTimestamp(row.computed_at_utc),
    hourly_mean_ugm3: toNullableNumber(row.hourly_mean_ugm3),
    rolling24h_mean_ugm3: toNullableNumber(row.rolling24h_mean_ugm3),
    no2_hourly_mean_ugm3: toNullableNumber(row.no2_hourly_mean_ugm3),
    pm25_hourly_mean_ugm3: toNullableNumber(row.pm25_hourly_mean_ugm3),
    pm10_hourly_mean_ugm3: toNullableNumber(row.pm10_hourly_mean_ugm3),
    pm25_rolling24h_mean_ugm3: toNullableNumber(row.pm25_rolling24h_mean_ugm3),
    pm10_rolling24h_mean_ugm3: toNullableNumber(row.pm10_rolling24h_mean_ugm3),
    daqi_no2_index_level: toNullableInteger(row.daqi_no2_index_level),
    daqi_pm25_rolling24h_index_level: toNullableInteger(row.daqi_pm25_rolling24h_index_level),
    daqi_pm10_rolling24h_index_level: toNullableInteger(row.daqi_pm10_rolling24h_index_level),
    eaqi_no2_index_level: toNullableInteger(row.eaqi_no2_index_level),
    eaqi_pm25_index_level: toNullableInteger(row.eaqi_pm25_index_level),
    eaqi_pm10_index_level: toNullableInteger(row.eaqi_pm10_index_level),
    updated_at: toNullableIsoTimestamp(row.updated_at),
  };

  if (
    !Number.isFinite(parsed.timeseries_id) || parsed.timeseries_id <= 0 ||
    !Number.isFinite(parsed.connector_id) || parsed.connector_id <= 0 ||
    !parsed.pollutant_code ||
    !parsed.timestamp_hour_utc
  ) {
    return null;
  }
  return parsed;
}

export function normalizeAqilevelHistoryRowForTest(row, connectorIdFallback = null) {
  return normalizeAqilevelHistoryRow(row, connectorIdFallback);
}

async function fetchAqilevelConnectorCounts(runtime, dayUtc) {
  const payload = await postgrestRpc({
    baseUrl: runtime.aqilevels_source.base_url,
    privilegedKey: runtime.aqilevels_source.privileged_key,
    rpcSchema: runtime.aqilevels_source.rpc_schema,
    rpcName: runtime.aqilevels_source.connector_counts_rpc,
    payload: {
      p_day_utc: dayUtc,
      p_connector_ids: null,
    },
  });

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map(toAqilevelConnectorCountRow)
    .filter((row) => Number.isInteger(row.connector_id) && row.connector_id > 0 && row.expected_row_count > 0n);
}

async function fetchAqilevelRowsPage(runtime, { dayUtc, connectorId, afterTimeseriesId, afterTimestampHourUtc, limit }) {
  const payload = await postgrestRpc({
    baseUrl: runtime.aqilevels_source.base_url,
    privilegedKey: runtime.aqilevels_source.privileged_key,
    rpcSchema: runtime.aqilevels_source.rpc_schema,
    rpcName: runtime.aqilevels_source.rows_rpc,
    payload: {
      p_day_utc: dayUtc,
      p_connector_id: connectorId,
      p_after_timeseries_id: afterTimeseriesId,
      p_after_timestamp_hour_utc: afterTimestampHourUtc,
      p_limit: limit,
    },
  });

  if (!Array.isArray(payload)) {
    return [];
  }

  const normalized = [];
  for (const row of payload) {
    const parsed = normalizeAqilevelHistoryRow(row, connectorId);
    if (parsed) {
      normalized.push(parsed);
    }
  }
  return normalized;
}

async function fetchAqilevelCandidateDays(client, latestEligibleDayUtc, scanLimit) {
  const sql = `
select g.day_utc::text as day_utc
from uk_aq_ops.prune_day_gates g
where g.history_done is true
  and g.day_utc <= $1::date
order by g.day_utc desc
limit $2
`;
  const result = await client.query(sql, [latestEligibleDayUtc, scanLimit]);
  return result.rows.map((row) => normalizeDayUtc(row.day_utc)).filter(Boolean);
}

async function discoverPendingAqilevelDays({ client, runtime, latestEligibleDayUtc }) {
  const scanLimit = Math.max(runtime.max_candidates_per_run * 4, runtime.max_candidates_per_run);
  const candidates = await fetchAqilevelCandidateDays(client, latestEligibleDayUtc, scanLimit);
  const pending = [];

  for (const dayUtc of candidates) {
    const manifestKeys = [buildDayManifestKey(runtime.aqilevels_prefix, dayUtc)];
    if (runtime.history_write_version === "v2") {
      manifestKeys.push(buildDayManifestKey(runtime.aqilevels_hourly_debug_prefix_v2, dayUtc));
    }

    for (const manifestKey of manifestKeys) {
      const head = await r2HeadObject({ r2: runtime.r2, key: manifestKey });
      if (!head.exists) {
        pending.push(dayUtc);
        break;
      }
    }
    if (pending.length >= runtime.max_candidates_per_run) {
      break;
    }
  }

  return uniqueSorted(pending);
}

async function exportAqilevelConnectorDayToR2({ runtime, dayUtc, connector }) {
  const connectorId = Number(connector.connector_id);
  const expectedRowCount = connector.expected_row_count;
  const fileEntries = [];
  const debugFileEntries = [];
  let partIndex = 0;
  let pendingRows = [];
  let observedRows = 0n;
  let totalBytes = 0n;
  let debugTotalBytes = 0n;
  let minTimestampHourUtc = null;
  let maxTimestampHourUtc = null;
  let cursorAfterTimeseriesId = null;
  let cursorAfterTimestampHourUtc = null;
  let pageCount = 0;

  const flushPart = async () => {
    if (!pendingRows.length) {
      return;
    }
    const partRows = pendingRows;
    pendingRows = [];

    if (runtime.history_write_version === "v2") {
      const groupedRows = groupRowsByPollutant(partRows);
      logPhaseB(runtime, "INFO", "phase_b_aqilevels_v2_pollutant_plan", {
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_codes: groupedRows.map(([pollutantCode]) => pollutantCode),
        pollutant_count: groupedRows.length,
        row_count: partRows.length,
      });

      for (const [pollutantCode, pollutantRows] of groupedRows) {
        const partSummary = summarizeAqilevelPartRows(pollutantRows);
        const writeProfilePart = async ({ prefix, profile, toParquetBuffer, targetFileEntries }) => {
          const partKey = buildHistoryV2PartKey(prefix, dayUtc, connectorId, pollutantCode, partIndex);
          const parquetBuffer = toParquetBuffer(
            pollutantRows,
            parquetWriterProperties(
              runtime.aqilevels_row_group_size,
              HISTORY_R2_V2_WRITER_VERSION,
            ),
          );
          const putResult = await r2PutObject({
            r2: runtime.r2,
            key: partKey,
            body: parquetBuffer,
            content_type: "application/octet-stream",
          });
          const head = await r2HeadObject({ r2: runtime.r2, key: partKey });
          if (!head.exists) {
            throw new Error(`Missing AQI v2 ${profile} committed object after write: ${partKey}`);
          }
          const bytes = typeof head.bytes === "number" && Number.isFinite(head.bytes)
            ? Math.trunc(head.bytes)
            : Math.trunc(putResult.bytes);
          const etagOrHash = head.etag || putResult.etag || null;
          targetFileEntries.push({
            key: partKey,
            row_count: pollutantRows.length,
            bytes,
            etag_or_hash: etagOrHash,
            pollutant_code: pollutantCode,
            min_timeseries_id: partSummary.min_timeseries_id,
            max_timeseries_id: partSummary.max_timeseries_id,
            min_timestamp_hour_utc: partSummary.min_timestamp_hour_utc,
            max_timestamp_hour_utc: partSummary.max_timestamp_hour_utc,
            timeseries_row_counts: partSummary.timeseries_row_counts,
          });
          return bytes;
        };
        const dataBytes = await writeProfilePart({ prefix: runtime.aqilevels_prefix, profile: "data", toParquetBuffer: rowsToAqilevelDataV2ParquetBuffer, targetFileEntries: fileEntries });
        const debugBytes = await writeProfilePart({ prefix: runtime.aqilevels_hourly_debug_prefix_v2, profile: "debug", toParquetBuffer: rowsToAqilevelDebugV2ParquetBuffer, targetFileEntries: debugFileEntries });
        totalBytes += BigInt(dataBytes);
        debugTotalBytes += BigInt(debugBytes);
      }
      partIndex += 1;
      observedRows += BigInt(partRows.length);
      return;
    }

    const partSummary = summarizeAqilevelPartRows(partRows);
    const partKey = buildPartKey(runtime.aqilevels_prefix, dayUtc, connectorId, partIndex);
    const parquetBuffer = rowsToAqilevelParquetBuffer(
      partRows,
      parquetWriterProperties(
        runtime.aqilevels_row_group_size,
        HISTORY_AQILEVELS_WRITER_VERSION,
      ),
    );
    const putResult = await r2PutObject({
      r2: runtime.r2,
      key: partKey,
      body: parquetBuffer,
      content_type: "application/octet-stream",
    });
    const head = await r2HeadObject({ r2: runtime.r2, key: partKey });
    if (!head.exists) {
      throw new Error(`Missing AQI committed object after write: ${partKey}`);
    }
    const bytes = typeof head.bytes === "number" && Number.isFinite(head.bytes)
      ? Math.trunc(head.bytes)
      : Math.trunc(putResult.bytes);
    const etagOrHash = head.etag || putResult.etag || null;

    fileEntries.push({
      key: partKey,
      row_count: partRows.length,
      bytes,
      etag_or_hash: etagOrHash,
      min_timeseries_id: partSummary.min_timeseries_id,
      max_timeseries_id: partSummary.max_timeseries_id,
      min_timestamp_hour_utc: partSummary.min_timestamp_hour_utc,
      max_timestamp_hour_utc: partSummary.max_timestamp_hour_utc,
      pollutant_codes: partSummary.pollutant_codes,
    });
    partIndex += 1;
    observedRows += BigInt(partRows.length);
    totalBytes += BigInt(bytes);
  };

  for (;;) {
    pageCount += 1;
    if (pageCount > runtime.aqilevels_source_max_pages) {
      throw new Error(
        `AQI source RPC exceeded max pages (${runtime.aqilevels_source_max_pages}) for day=${dayUtc} connector=${connectorId}`,
      );
    }

    const pageRows = await fetchAqilevelRowsPage(runtime, {
      dayUtc,
      connectorId,
      afterTimeseriesId: cursorAfterTimeseriesId,
      afterTimestampHourUtc: cursorAfterTimestampHourUtc,
      limit: runtime.cursor_fetch_rows,
    });
    if (!pageRows.length) {
      break;
    }

    for (const row of pageRows) {
      if (!minTimestampHourUtc || row.timestamp_hour_utc < minTimestampHourUtc) {
        minTimestampHourUtc = row.timestamp_hour_utc;
      }
      if (!maxTimestampHourUtc || row.timestamp_hour_utc > maxTimestampHourUtc) {
        maxTimestampHourUtc = row.timestamp_hour_utc;
      }

      pendingRows.push({
        ...row,
        connector_id: connectorId,
      });

      if (pendingRows.length >= runtime.aqilevels_part_max_rows) {
        await flushPart();
      }
    }

    const last = pageRows[pageRows.length - 1];
    const nextAfterTimeseriesId = Number(last.timeseries_id);
    const nextAfterTimestampHourUtc = String(last.timestamp_hour_utc);
    const cursorUnchanged = nextAfterTimeseriesId === cursorAfterTimeseriesId
      && nextAfterTimestampHourUtc === cursorAfterTimestampHourUtc;
    if (cursorUnchanged) {
      throw new Error(
        `AQI source RPC cursor did not advance for day=${dayUtc} connector=${connectorId}`,
      );
    }
    cursorAfterTimeseriesId = nextAfterTimeseriesId;
    cursorAfterTimestampHourUtc = nextAfterTimestampHourUtc;
  }

  if (pendingRows.length > 0) {
    await flushPart();
  }

  if (observedRows !== expectedRowCount) {
    throw new Error(
      `AQI row count mismatch for day=${dayUtc} connector=${connectorId}: expected=${expectedRowCount.toString()} observed=${observedRows.toString()}`,
    );
  }

  const backedUpAtUtc = nowIso();
  let connectorManifestKey = buildConnectorManifestKey(runtime.aqilevels_prefix, dayUtc, connectorId);
  let connectorManifest;
  let debugConnectorManifestKey = null;
  let debugConnectorManifest = null;
  if (runtime.history_write_version === "v2") {
    const createAndUploadProfileConnectorManifest = async ({ prefix, profile, profileFileEntries }) => {
      const pollutantManifests = [];
      const partsByPollutant = new Map();
      for (const fileEntry of profileFileEntries) {
        const pollutantCode = normalizePollutantCodeForPath(fileEntry.pollutant_code);
        if (!partsByPollutant.has(pollutantCode)) partsByPollutant.set(pollutantCode, []);
        partsByPollutant.get(pollutantCode).push(fileEntry);
      }
      for (const [pollutantCode, pollutantParts] of Array.from(partsByPollutant.entries()).sort(([left], [right]) => left.localeCompare(right))) {
        const pollutantManifestKey = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, pollutantCode);
        const pollutantManifest = createHistoryV2PollutantManifest({
          domain: "aqilevels", grain: HISTORY_AQILEVELS_GRAIN, profile, dayUtc, connectorId, pollutantCode,
          runId: runtime.run_id, manifestKey: pollutantManifestKey,
          sourceRowCount: pollutantParts.reduce((sum, part) => sum + Number(part.row_count || 0), 0),
          fileEntries: pollutantParts, writerGitSha: runtime.writer_git_sha, backedUpAtUtc,
        });
        await r2PutObject({ r2: runtime.r2, key: pollutantManifestKey, body: Buffer.from(JSON.stringify(pollutantManifest, null, 2), "utf8"), content_type: "application/json" });
        const pollutantManifestHead = await r2HeadObject({ r2: runtime.r2, key: pollutantManifestKey });
        if (!pollutantManifestHead.exists) throw new Error(`AQI v2 ${profile} pollutant manifest missing after upload: ${pollutantManifestKey}`);
        pollutantManifests.push(pollutantManifest);
      }
      const profileConnectorManifestKey = buildConnectorManifestKey(prefix, dayUtc, connectorId);
      return { key: profileConnectorManifestKey, manifest: createHistoryV2ConnectorManifest({
        domain: "aqilevels", grain: HISTORY_AQILEVELS_GRAIN, profile, dayUtc, connectorId,
        runId: runtime.run_id, manifestKey: profileConnectorManifestKey, pollutantManifests,
        writerGitSha: runtime.writer_git_sha, backedUpAtUtc,
      }) };
    };
    const dataProfile = await createAndUploadProfileConnectorManifest({ prefix: runtime.aqilevels_prefix, profile: "data", profileFileEntries: fileEntries });
    connectorManifestKey = dataProfile.key;
    connectorManifest = dataProfile.manifest;
    const debugProfile = await createAndUploadProfileConnectorManifest({ prefix: runtime.aqilevels_hourly_debug_prefix_v2, profile: "debug", profileFileEntries: debugFileEntries });
    debugConnectorManifestKey = debugProfile.key;
    debugConnectorManifest = debugProfile.manifest;
  } else {
    connectorManifest = createAqilevelConnectorManifest({
      dayUtc,
      connectorId,
      runId: runtime.run_id,
      sourceRowCount: Number(observedRows),
      minTimeseriesId: connector.min_timeseries_id ?? null,
      maxTimeseriesId: connector.max_timeseries_id ?? null,
      minTimestampHourUtc: minTimestampHourUtc || connector.min_timestamp_hour_utc || null,
      maxTimestampHourUtc: maxTimestampHourUtc || connector.max_timestamp_hour_utc || null,
      fileEntries,
      writerGitSha: runtime.writer_git_sha,
      backedUpAtUtc,
    });
  }
  await r2PutObject({
    r2: runtime.r2,
    key: connectorManifestKey,
    body: Buffer.from(JSON.stringify(connectorManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  const manifestHead = await r2HeadObject({ r2: runtime.r2, key: connectorManifestKey });
  if (!manifestHead.exists) {
    throw new Error(`AQI connector manifest missing after upload: ${connectorManifestKey}`);
  }

  if (runtime.history_write_version === "v2") {
    await r2PutObject({ r2: runtime.r2, key: debugConnectorManifestKey, body: Buffer.from(JSON.stringify(debugConnectorManifest, null, 2), "utf8"), content_type: "application/json" });
    const debugManifestHead = await r2HeadObject({ r2: runtime.r2, key: debugConnectorManifestKey });
    if (!debugManifestHead.exists) {
      throw new Error(`AQI debug connector manifest missing after upload: ${debugConnectorManifestKey}`);
    }
  }

  return {
    connector_id: connectorId,
    manifest_key: connectorManifestKey,
    source_row_count: observedRows,
    file_count: fileEntries.length,
    total_bytes: totalBytes,
    connector_manifest: {
      ...connectorManifest,
      manifest_key: connectorManifestKey,
    },
    debug_file_count: debugFileEntries.length,
    debug_total_bytes: debugTotalBytes,
    debug_connector_manifest: debugConnectorManifest ? {
      ...debugConnectorManifest,
      manifest_key: debugConnectorManifestKey,
    } : null,
  };
}

export async function discoverPendingAqilevelDaysForTest(args) {
  return await discoverPendingAqilevelDays(args);
}

export async function exportAqilevelDayToR2ForTest(args) {
  return await exportAqilevelDayToR2(args);
}

async function exportAqilevelDayToR2({ runtime, dayUtc }) {
  const connectorCounts = await fetchAqilevelConnectorCounts(runtime, dayUtc);
  if (connectorCounts.length === 0) {
    return {
      status: "skipped_no_source_rows",
      day_utc: dayUtc,
      connector_count: 0,
      source_row_count: 0n,
      file_count: 0,
      total_bytes: 0n,
      day_manifest_key: null,
    };
  }

  const connectorManifests = [];
  const debugConnectorManifests = [];
  let totalRows = 0n;
  let totalBytes = 0n;
  let totalFiles = 0;
  let debugTotalBytes = 0n;
  let debugTotalFiles = 0;

  for (const connector of connectorCounts) {
    const result = await exportAqilevelConnectorDayToR2({
      runtime,
      dayUtc,
      connector,
    });
    totalRows += result.source_row_count;
    totalBytes += result.total_bytes;
    totalFiles += result.file_count;
    debugTotalBytes += result.debug_total_bytes || 0n;
    debugTotalFiles += result.debug_file_count || 0;
    connectorManifests.push(result.connector_manifest);
    if (result.debug_connector_manifest) {
      debugConnectorManifests.push(result.debug_connector_manifest);
    }
  }

  const backedUpAtUtc = nowIso();
  const dayManifestKey = buildDayManifestKey(runtime.aqilevels_prefix, dayUtc);
  const dayManifest = runtime.history_write_version === "v2"
    ? createHistoryV2DayManifest({
      domain: "aqilevels",
      grain: HISTORY_AQILEVELS_GRAIN,
      profile: "data",
      dayUtc,
      runId: runtime.run_id,
      manifestKey: dayManifestKey,
      connectorManifests,
      writerGitSha: runtime.writer_git_sha,
      backedUpAtUtc,
    })
    : createAqilevelDayManifest({
      dayUtc,
      runId: runtime.run_id,
      connectorManifests,
      writerGitSha: runtime.writer_git_sha,
      backedUpAtUtc,
    });
  await r2PutObject({
    r2: runtime.r2,
    key: dayManifestKey,
    body: Buffer.from(JSON.stringify(dayManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  let debugDayManifestKey = null;
  if (runtime.history_write_version === "v2") {
    debugDayManifestKey = buildDayManifestKey(runtime.aqilevels_hourly_debug_prefix_v2, dayUtc);
    const debugDayManifest = createHistoryV2DayManifest({
      domain: "aqilevels",
      grain: HISTORY_AQILEVELS_GRAIN,
      profile: "debug",
      dayUtc,
      runId: runtime.run_id,
      manifestKey: debugDayManifestKey,
      connectorManifests: debugConnectorManifests,
      writerGitSha: runtime.writer_git_sha,
      backedUpAtUtc,
    });
    await r2PutObject({
      r2: runtime.r2,
      key: debugDayManifestKey,
      body: Buffer.from(JSON.stringify(debugDayManifest, null, 2), "utf8"),
      content_type: "application/json",
    });
  }

  const dayHead = await r2HeadObject({ r2: runtime.r2, key: dayManifestKey });
  if (!dayHead.exists) {
    throw new Error(`AQI day manifest missing after upload: ${dayManifestKey}`);
  }
  if (runtime.history_write_version === "v2") {
    const debugDayHead = await r2HeadObject({ r2: runtime.r2, key: debugDayManifestKey });
    if (!debugDayHead.exists) {
      throw new Error(`AQI debug day manifest missing after upload: ${debugDayManifestKey}`);
    }
  }

  return {
    status: "complete",
    day_utc: dayUtc,
    connector_count: connectorCounts.length,
    source_row_count: totalRows,
    file_count: totalFiles,
    total_bytes: totalBytes,
    day_manifest_key: dayManifestKey,
    debug_file_count: debugTotalFiles,
    debug_total_bytes: debugTotalBytes,
    debug_day_manifest_key: debugDayManifestKey,
  };
}

async function runAqilevelsBackup({ runtime, latestEligibleDayUtc, dryRun, logStructured }) {
  const summary = {
    enabled: true,
    dry_run: dryRun,
    latest_eligible_day_utc: latestEligibleDayUtc,
    pending_days: 0,
    completed_days: 0,
    skipped_days_no_source_rows: 0,
    failed_days: 0,
    total_written_rows: "0",
    total_written_bytes: "0",
    pending_preview: [],
    completed_preview: [],
    failures: [],
    aqilevels_prefix: runtime.aqilevels_prefix,
    aqilevels_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    aqilevels_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    aqilevels_grain: HISTORY_AQILEVELS_GRAIN,
    aqilevels_writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
  };

  logStructured("INFO", "phase_b_aqilevels_run_start", {
    run_id: runtime.run_id,
    dry_run: dryRun,
    latest_eligible_day_utc: latestEligibleDayUtc,
    max_candidates_per_run: runtime.max_candidates_per_run,
    aqilevels_prefix: runtime.aqilevels_prefix,
    aqilevels_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    aqilevels_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    aqilevels_grain: HISTORY_AQILEVELS_GRAIN,
    aqilevels_writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
    aqilevels_rpc_schema: runtime.aqilevels_source?.rpc_schema || null,
    aqilevels_rows_rpc: runtime.aqilevels_source?.rows_rpc || null,
    aqilevels_connector_counts_rpc: runtime.aqilevels_source?.connector_counts_rpc || null,
  });

  if (!hasAqilevelSourceConfig(runtime)) {
    throw new Error("Phase B AQI export requires OBS_AQIDB_SUPABASE_URL and OBS_AQIDB_SECRET_KEY with AQI history RPCs.");
  }

  const pendingDays = await withPgClient(runtime.supabase_db_url, async (client) => {
    return await discoverPendingAqilevelDays({
      client,
      runtime,
      latestEligibleDayUtc,
    });
  });

  summary.pending_days = pendingDays.length;
  summary.pending_preview = pendingDays.slice(0, 25);
  if (dryRun) {
    summary.completed_preview = summary.completed_preview.slice(0, 25);
    summary.failures = summary.failures.slice(0, 25);
    logStructured("INFO", "phase_b_aqilevels_run_summary", {
      run_id: runtime.run_id,
      ...summary,
    });
    return summary;
  }

  let totalRows = 0n;
  let totalBytes = 0n;
  for (const dayUtc of pendingDays) {
    const startedAtMs = Date.now();
    try {
      const dayResult = await exportAqilevelDayToR2({
        runtime,
        dayUtc,
      });

      if (dayResult.status === "skipped_no_source_rows") {
        summary.skipped_days_no_source_rows += 1;
        logStructured("INFO", "phase_b_aqilevels_day_skipped_no_source_rows", {
          run_id: runtime.run_id,
          day_utc: dayUtc,
        });
        continue;
      }

      summary.completed_days += 1;
      totalRows += dayResult.source_row_count;
      totalBytes += dayResult.total_bytes;
      summary.completed_preview.push({
        day_utc: dayUtc,
        connector_count: dayResult.connector_count,
        source_row_count: dayResult.source_row_count.toString(),
        file_count: dayResult.file_count,
        total_bytes: dayResult.total_bytes.toString(),
        day_manifest_key: dayResult.day_manifest_key,
      });
      logStructured("INFO", "phase_b_aqilevels_day_complete", {
        run_id: runtime.run_id,
        day_utc: dayUtc,
        connector_count: dayResult.connector_count,
        source_row_count: dayResult.source_row_count.toString(),
        file_count: dayResult.file_count,
        total_bytes: dayResult.total_bytes.toString(),
        day_manifest_key: dayResult.day_manifest_key,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed_days += 1;
      summary.failures.push({
        day_utc: dayUtc,
        error: message,
        next_action: "retry_safe",
      });
      logStructured("ERROR", "phase_b_aqilevels_day_failed", {
        run_id: runtime.run_id,
        day_utc: dayUtc,
        error: message,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        next_action: "retry_safe",
      });
    }
  }

  summary.total_written_rows = totalRows.toString();
  summary.total_written_bytes = totalBytes.toString();

  summary.completed_preview = summary.completed_preview.slice(0, 25);
  summary.failures = summary.failures.slice(0, 25);
  logStructured("INFO", "phase_b_aqilevels_run_summary", {
    run_id: runtime.run_id,
    ...summary,
  });
  return summary;
}

async function finalizeDayGateIfReady({ client, runtime, dayUtc }) {
  const dayCandidates = await fetchDayCandidates(client, dayUtc);
  const dayState = computeDayGateState(dayCandidates);

  if (!dayState.all_complete) {
    await updateDayGateBlocked(client, dayUtc);
    return {
      day_utc: dayUtc,
      history_done: false,
      pending_connectors: dayState.pending + dayState.in_progress + dayState.failed,
    };
  }

  const connectorManifests = [];
  for (const candidate of dayCandidates) {
    if (!candidate.manifest_key) {
      throw new Error(`Missing connector manifest_key for day=${dayUtc} connector=${candidate.connector_id}`);
    }
    const object = await r2GetObject({ r2: runtime.r2, key: candidate.manifest_key });
    const parsed = JSON.parse(object.body.toString("utf8"));
    connectorManifests.push({
      ...parsed,
      manifest_key: candidate.manifest_key,
    });
  }

  const backedUpAtUtc = nowIso();
  const dayManifestKey = runtime.history_write_version === "v2"
    ? buildHistoryV2DayManifestKey(runtime.committed_prefix, dayUtc)
    : buildDayManifestKey(runtime.committed_prefix, dayUtc);
  const dayManifest = runtime.history_write_version === "v2"
    ? createHistoryV2DayManifest({
      domain: "observations",
      dayUtc,
      runId: runtime.run_id,
      manifestKey: dayManifestKey,
      connectorManifests,
      writerGitSha: runtime.writer_git_sha,
      backedUpAtUtc,
    })
    : createDayManifest({
      dayUtc,
      runId: runtime.run_id,
      connectorManifests,
      writerGitSha: runtime.writer_git_sha,
      backedUpAtUtc,
    });

  await r2PutObject({
    r2: runtime.r2,
    key: dayManifestKey,
    body: Buffer.from(JSON.stringify(dayManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  const manifestHead = await r2HeadObject({ r2: runtime.r2, key: dayManifestKey });
  if (!manifestHead.exists) {
    throw new Error(`Day manifest missing after upload: ${dayManifestKey}`);
  }

  const totalRows = dayCandidates.reduce(
    (sum, row) => sum + (row.history_row_count || 0n),
    0n,
  );
  const totalFiles = dayCandidates.reduce(
    (sum, row) => sum + Number(row.history_file_count || 0),
    0,
  );
  const totalBytes = dayCandidates.reduce(
    (sum, row) => sum + (row.history_total_bytes || 0n),
    0n,
  );

  await updateDayGateComplete(client, {
    dayUtc,
    runId: runtime.run_id,
    manifestKey: dayManifestKey,
    rowCount: totalRows,
    fileCount: totalFiles,
    totalBytes,
  });

  return {
    day_utc: dayUtc,
    history_done: true,
    pending_connectors: 0,
    history_manifest_key: dayManifestKey,
    history_row_count: totalRows.toString(),
    history_file_count: totalFiles,
    history_total_bytes: totalBytes.toString(),
  };
}

async function cleanupStaging({ runtime, logStructured }) {
  const thresholdMs = (Date.now() - (runtime.staging_retention_days * DAY_MS));
  const entries = await r2ListAllObjects({
    r2: runtime.r2,
    prefix: `${runtime.staging_prefix_base}/`,
    max_keys: 1000,
  });

  const staleKeys = entries
    .filter((entry) => {
      if (!entry.last_modified) {
        return false;
      }
      const lastModifiedMs = Date.parse(entry.last_modified);
      if (Number.isNaN(lastModifiedMs)) {
        return false;
      }
      return lastModifiedMs < thresholdMs;
    })
    .map((entry) => entry.key);

  if (!staleKeys.length) {
    return {
      scanned_count: entries.length,
      deleted_count: 0,
      error_count: 0,
    };
  }

  let deletedCount = 0;
  let errorCount = 0;
  for (let i = 0; i < staleKeys.length; i += 1000) {
    const batch = staleKeys.slice(i, i + 1000);
    const result = await r2DeleteObjects({ r2: runtime.r2, keys: batch });
    deletedCount += result.deleted_count;
    errorCount += result.errors.length;
    if (result.errors.length > 0) {
      logStructured("WARNING", "phase_b_history_staging_cleanup_batch_errors", {
        run_id: runtime.run_id,
        batch_size: batch.length,
        error_count: result.errors.length,
        errors_sample: result.errors.slice(0, 10),
      });
    }
  }

  return {
    scanned_count: entries.length,
    deleted_count: deletedCount,
    error_count: errorCount,
  };
}

async function writeRunManifest({ runtime, runSummary }) {
  const key = buildRunManifestKey(runtime.runs_prefix, runtime.run_id);
  const payloadWithoutHash = {
    run_id: runtime.run_id,
    backed_up_at_utc: nowIso(),
    summary: runSummary,
  };
  const payload = withManifestHash(payloadWithoutHash);

  await r2PutObject({
    r2: runtime.r2,
    key,
    body: Buffer.from(JSON.stringify(payload, null, 2), "utf8"),
    content_type: "application/json",
  });

  const head = await r2HeadObject({ r2: runtime.r2, key });
  if (!head.exists) {
    throw new Error(`Run manifest missing after upload: ${key}`);
  }

  return key;
}

export function dayWindowFromNow(
  nowUtcIso,
  ingestRetentionDays = DEFAULT_INGESTDB_RETENTION_DAYS,
) {
  const now = new Date(nowUtcIso);
  const todayUtc = toIsoDateUtc(new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  )));
  // Phase B must finish one full UTC day earlier than the prune cutoff day.
  const retentionDays = parsePositiveInt(
    ingestRetentionDays,
    DEFAULT_INGESTDB_RETENTION_DAYS,
    1,
    3650,
  );
  const phaseBEligibleAgeDays = retentionDays + 1;
  const latestEligibleDayUtc = shiftIsoDay(todayUtc, -phaseBEligibleAgeDays);
  const latestEligibleWindowEndIso = `${shiftIsoDay(latestEligibleDayUtc, 1)}T00:00:00.000Z`;
  return {
    now_utc: now.toISOString(),
    today_utc: todayUtc,
    ingest_retention_days: retentionDays,
    phase_b_eligible_age_days: phaseBEligibleAgeDays,
    latest_eligible_day_utc: latestEligibleDayUtc,
    latest_eligible_window_end_utc: latestEligibleWindowEndIso,
  };
}

function resolveR2Bucket(env) {
  const explicitBucket = (env.R2_BUCKET || env.CFLARE_R2_BUCKET || "").trim();
  if (explicitBucket) {
    return explicitBucket;
  }
  return "";
}

export function resolvePhaseBRuntimeConfig(env = process.env) {
  const stagingBasePrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_STAGING_PREFIX || DEFAULT_STAGING_PREFIX,
  );
  const writePrefixes = resolvePhaseBHistoryWritePrefixes(env);
  const committedPrefix = writePrefixes.observations_prefix_v1;
  const committedPrefixV2 = writePrefixes.observations_prefix_v2;
  const activeCommittedPrefix = writePrefixes.observations_prefix;
  const aqilevelsPrefix = writePrefixes.aqilevels_prefix;
  const aqilevelsDataPrefixV2 = writePrefixes.aqilevels_hourly_data_prefix_v2;
  const aqilevelsDebugPrefixV2 = writePrefixes.aqilevels_hourly_debug_prefix_v2;
  const runsPrefix = writePrefixes.runs_prefix;
  const historyWriteVersion = writePrefixes.history_write_version;
  const sharedPartMaxRows = parsePositiveInt(
    env.UK_AQ_R2_HISTORY_PART_MAX_ROWS,
    DEFAULT_PART_MAX_ROWS,
    1,
    5_000_000,
  );
  const sharedRowGroupSize = parsePositiveInt(
    env.UK_AQ_R2_HISTORY_ROW_GROUP_SIZE,
    DEFAULT_ROW_GROUP_SIZE,
    10_000,
    2_000_000,
  );

  const rawPollutantCodes = String(
    env.UK_AQ_R2_HISTORY_OBSERVATIONS_POLLUTANT_CODES ||
      "pm25,pm10,no2,pm25index,pm10index,no2index",
  ).trim();
  const allowedPollutantCodes = rawPollutantCodes.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return {
    enabled: String(env.UK_AQ_R2_HISTORY_PHASE_B_ENABLED || "true").trim().toLowerCase() !== "false",
    supabase_db_url: String(env.SUPABASE_DB_URL || env.DATABASE_URL || "").trim(),
    r2: {
      endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
      bucket: resolveR2Bucket(env),
      region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
      access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
      secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim(),
    },
    part_max_rows: sharedPartMaxRows,
    cursor_fetch_rows: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_CURSOR_FETCH_ROWS,
      DEFAULT_CURSOR_FETCH_ROWS,
      1_000,
      500_000,
    ),
    row_group_size: sharedRowGroupSize,
    observations_part_max_rows: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_OBSERVATIONS_PART_MAX_ROWS || env.UK_AQ_R2_HISTORY_PART_MAX_ROWS,
      DEFAULT_OBSERVATIONS_PART_MAX_ROWS,
      1,
      5_000_000,
    ),
    observations_row_group_size: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_OBSERVATIONS_ROW_GROUP_SIZE || env.UK_AQ_R2_HISTORY_ROW_GROUP_SIZE,
      DEFAULT_OBSERVATIONS_ROW_GROUP_SIZE,
      10_000,
      2_000_000,
    ),
    observations_pollutant_codes: allowedPollutantCodes,
    aqilevels_part_max_rows: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_AQILEVELS_PART_MAX_ROWS || env.UK_AQ_R2_HISTORY_PART_MAX_ROWS,
      DEFAULT_AQILEVELS_PART_MAX_ROWS,
      1,
      5_000_000,
    ),
    aqilevels_row_group_size: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_AQILEVELS_ROW_GROUP_SIZE || env.UK_AQ_R2_HISTORY_ROW_GROUP_SIZE,
      DEFAULT_AQILEVELS_ROW_GROUP_SIZE,
      10_000,
      2_000_000,
    ),
    aqilevels_source_max_pages: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_AQILEVELS_SOURCE_MAX_PAGES,
      DEFAULT_AQILEVELS_SOURCE_MAX_PAGES,
      10,
      1_000_000,
    ),
    max_candidates_per_run: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN,
      DEFAULT_MAX_CANDIDATES_PER_RUN,
      1,
      50_000,
    ),
    max_seconds_per_run: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_MAX_SECONDS_PER_RUN,
      DEFAULT_MAX_SECONDS_PER_RUN,
      30,
      86_400,
    ),
    stop_before_timeout_seconds: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_STOP_BEFORE_TIMEOUT_SECONDS,
      DEFAULT_STOP_BEFORE_TIMEOUT_SECONDS,
      0,
      3_600,
    ),
    staging_retention_days: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_STAGING_RETENTION_DAYS,
      DEFAULT_STAGING_RETENTION_DAYS,
      1,
      90,
    ),
    staging_prefix_base: stagingBasePrefix,
    committed_prefix: activeCommittedPrefix,
    committed_prefix_v1: committedPrefix,
    aqilevels_prefix: aqilevelsPrefix,
    aqilevels_prefix_v1: writePrefixes.aqilevels_prefix_v1,
    history_write_version: historyWriteVersion,
    committed_prefix_v2: committedPrefixV2,
    aqilevels_hourly_data_prefix_v2: aqilevelsDataPrefixV2,
    aqilevels_hourly_debug_prefix_v2: aqilevelsDebugPrefixV2,
    runs_prefix: runsPrefix,
    runs_prefix_v1: writePrefixes.runs_prefix_v1,
    runs_prefix_v2: writePrefixes.runs_prefix_v2,
    adopt_existing_manifest_enabled: parseBoolean(
      env.UK_AQ_R2_HISTORY_ADOPT_EXISTING_MANIFEST_ENABLED,
      true,
    ),
    prune_check_dropbox: {
      enabled: parseBoolean(env.UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_ENABLED, false),
      required: parseBoolean(env.UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_REQUIRED, false),
      dir: String(env.UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_DIR || DEFAULT_PRUNE_CHECK_DROPBOX_DIR).trim(),
    },
    dropbox: {
      root: String(env.UK_AQ_DROPBOX_ROOT || "").trim(),
      app_key: String(env.DROPBOX_APP_KEY || "").trim(),
      app_secret: String(env.DROPBOX_APP_SECRET || "").trim(),
      refresh_token: String(env.DROPBOX_REFRESH_TOKEN || "").trim(),
    },
    aqilevels_source: {
      base_url: String(env.OBS_AQIDB_SUPABASE_URL || "").trim(),
      privileged_key: String(env.OBS_AQIDB_SECRET_KEY || "").trim(),
      rpc_schema: String(env.UK_AQ_PUBLIC_SCHEMA || DEFAULT_RPC_SCHEMA).trim() || DEFAULT_RPC_SCHEMA,
      connector_counts_rpc: String(env.UK_AQ_BACKFILL_AQI_R2_CONNECTOR_COUNTS_RPC || AQILEVELS_CONNECTOR_COUNTS_RPC)
        .trim(),
      rows_rpc: String(env.UK_AQ_BACKFILL_AQI_R2_SOURCE_RPC || AQILEVELS_ROWS_RPC).trim(),
    },
    writer_git_sha: String(env.GITHUB_SHA || "").trim() || null,
  };
}

export async function runPhaseBBackup({
  dryRun,
  phaseB,
  ingestRetentionDays = DEFAULT_INGESTDB_RETENTION_DAYS,
  logStructured,
  runId = randomUUID(),
  nowUtc = nowIso(),
}) {
  const runtime = {
    ...phaseB,
    run_id: runId,
    now_utc: nowUtc,
    staging_prefix: `${phaseB.staging_prefix_base}/run_id=${runId}`,
    logStructured,
    run_budget: createPhaseBRunBudgetForTest({
      maxSecondsPerRun: phaseB.max_seconds_per_run,
      stopBeforeTimeoutSeconds: phaseB.stop_before_timeout_seconds,
    }),
  };

  if (!runtime.enabled) {
    return {
      enabled: false,
      run_id: runId,
      reason: "phase_b_disabled",
    };
  }

  if (!runtime.supabase_db_url) {
    throw new Error("Phase B history export requires SUPABASE_DB_URL (or DATABASE_URL) for streaming Postgres extraction.");
  }
  if (!hasRequiredR2Config(runtime.r2)) {
    throw new Error("Phase B history export requires R2 endpoint/bucket/region/access credentials.");
  }

  const window = dayWindowFromNow(nowUtc, ingestRetentionDays);
  const summary = {
    enabled: true,
    run_id: runId,
    now_utc: window.now_utc,
    ingest_retention_days: window.ingest_retention_days,
    phase_b_eligible_age_days: window.phase_b_eligible_age_days,
    latest_eligible_day_utc: window.latest_eligible_day_utc,
    latest_eligible_window_end_utc: window.latest_eligible_window_end_utc,
    dry_run: dryRun,
    populated_candidates: 0,
    pending_candidates: 0,
    processed_candidates: 0,
    completed_candidates: 0,
    adopted_candidates: 0,
    failed_candidates: 0,
    total_written_rows: "0",
    total_written_bytes: "0",
    completed_days: 0,
    blocked_days: 0,
    failures: [],
    completed_preview: [],
    blocked_preview: [],
    adoption_failures: [],
    prune_check_dropbox_exports: 0,
    prune_check_dropbox_failures: 0,
    aqilevels: null,
  };

  logStructured("INFO", "phase_b_history_run_start", {
    run_id: runId,
    dry_run: dryRun,
    now_utc: window.now_utc,
    ingest_retention_days: window.ingest_retention_days,
    phase_b_eligible_age_days: window.phase_b_eligible_age_days,
    latest_eligible_day_utc: window.latest_eligible_day_utc,
    adopt_existing_manifest_enabled: runtime.adopt_existing_manifest_enabled,
    prune_check_dropbox_enabled: runtime.prune_check_dropbox?.enabled === true,
    prune_check_dropbox_required: runtime.prune_check_dropbox?.required === true,
    prune_check_dropbox_dir: runtime.prune_check_dropbox?.dir || DEFAULT_PRUNE_CHECK_DROPBOX_DIR,
    max_candidates_per_run: runtime.max_candidates_per_run,
    max_seconds_per_run: runtime.max_seconds_per_run,
    stop_before_timeout_seconds: runtime.stop_before_timeout_seconds,
    part_max_rows: runtime.part_max_rows,
    observations_part_max_rows: runtime.observations_part_max_rows,
    aqilevels_part_max_rows: runtime.aqilevels_part_max_rows,
    history_write_version: runtime.history_write_version,
    observations_prefix_v1: runtime.committed_prefix_v1,
    observations_prefix_v2: runtime.committed_prefix_v2,
    cursor_fetch_rows: runtime.cursor_fetch_rows,
    row_group_size: runtime.row_group_size,
    observations_row_group_size: runtime.observations_row_group_size,
    aqilevels_row_group_size: runtime.aqilevels_row_group_size,
    r2_bucket: runtime.r2.bucket,
    observations_prefix: runtime.committed_prefix,
    aqilevels_prefix: runtime.aqilevels_prefix,
    aqilevels_prefix_v1: runtime.aqilevels_prefix_v1,
    aqilevels_hourly_data_prefix_v2: runtime.aqilevels_hourly_data_prefix_v2,
    aqilevels_hourly_debug_prefix_v2: runtime.aqilevels_hourly_debug_prefix_v2,
    runs_prefix: runtime.runs_prefix,
    runs_prefix_v1: runtime.runs_prefix_v1,
    runs_prefix_v2: runtime.runs_prefix_v2,
  });

  const dayResults = new Map();
  let totalWrittenRows = 0n;
  let totalWrittenBytes = 0n;

  await withPgClient(runtime.supabase_db_url, async (controlClient) => {
    const upsertedCandidates = await populateBackupCandidates(controlClient, window.latest_eligible_window_end_utc);
    summary.populated_candidates = upsertedCandidates.length;

    await markIncompleteDaysAsBackupBlocked(controlClient);

    const pendingCandidates = await fetchPendingCandidates(controlClient, runtime.max_candidates_per_run);
    summary.pending_candidates = pendingCandidates.length;

    if (dryRun) {
      const planned = pendingCandidates.map((candidate) => ({
        day_utc: candidate.day_utc,
        connector_id: candidate.connector_id,
        expected_row_count: candidate.expected_row_count.toString(),
        resume_part_index: Number(candidate.resume_part_index || 0),
        resume_exported_row_count: candidate.resume_exported_row_count.toString(),
        planned_committed_prefix: connectorPrefix(runtime.committed_prefix, candidate.day_utc, candidate.connector_id),
        planned_manifest_key: buildConnectorManifestKey(
          runtime.committed_prefix,
          candidate.day_utc,
          candidate.connector_id,
        ),
      }));

      summary.completed_preview = planned.slice(0, 25);
      summary.blocked_days = uniqueSorted(pendingCandidates.map((candidate) => candidate.day_utc)).length;

      logStructured("INFO", "phase_b_history_dry_run_plan", {
        run_id: runId,
        pending_candidates: pendingCandidates.length,
        planned_preview: planned.slice(0, 25),
      });
      return;
    }

    for (let candidateIndex = 0; candidateIndex < pendingCandidates.length; candidateIndex += 1) {
      const candidate = pendingCandidates[candidateIndex];
      if (!hasBudgetFor(runtime, 60_000)) {
        logPhaseB(runtime, "WARNING", "phase_b_history_budget_exhausted", {
          operation: "candidate_start",
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          candidate_index: candidateIndex,
          candidate_count: pendingCandidates.length,
        });
        break;
      }
      summary.processed_candidates += 1;

      const claimed = await markCandidateInProgress(controlClient, candidate.day_utc, candidate.connector_id, runId);
      if (!claimed) {
        logPhaseB(runtime, "INFO", "phase_b_history_candidate_skipped", {
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          candidate_index: candidateIndex,
          candidate_count: pendingCandidates.length,
          reason: "not_claimed",
        });
        continue;
      }

      const startedAtMs = Date.now();
      try {
        logPhaseB(runtime, "INFO", "phase_b_history_candidate_start", {
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          candidate_index: candidateIndex,
          candidate_count: pendingCandidates.length,
          rows_selected: candidate.expected_row_count.toString(),
          prefix: connectorPrefix(runtime.committed_prefix, candidate.day_utc, candidate.connector_id),
          manifest_path: buildConnectorManifestKey(runtime.committed_prefix, candidate.day_utc, candidate.connector_id),
        });
        const adoptResult = await maybeAdoptExistingConnectorManifest({
          candidate,
          runtime,
          logStructured,
        });

        let exportResult;
        if (adoptResult.adopted) {
          exportResult = {
            manifest_key: adoptResult.manifest_key,
            written_row_count: adoptResult.history_row_count,
            file_count: adoptResult.history_file_count,
            total_bytes: adoptResult.history_total_bytes,
            adopted: true,
          };
        } else {
          exportResult = await exportCandidateToR2({
            candidate,
          runtime,
        });
          exportResult.adopted = false;
        }

        await markCandidateComplete(controlClient, {
          dayUtc: candidate.day_utc,
          connectorId: candidate.connector_id,
          runId,
          manifestKey: exportResult.manifest_key,
          historyRowCount: exportResult.written_row_count,
          historyFileCount: exportResult.file_count,
          historyTotalBytes: exportResult.total_bytes,
        });

        summary.completed_candidates += 1;
        if (exportResult.adopted) {
          summary.adopted_candidates += 1;
          logStructured("INFO", "phase_b_history_existing_manifest_adopted", {
            run_id: runId,
            day_utc: candidate.day_utc,
            connector_id: candidate.connector_id,
            manifest_key: exportResult.manifest_key,
            history_row_count: exportResult.written_row_count.toString(),
            history_file_count: exportResult.file_count,
            history_total_bytes: exportResult.total_bytes.toString(),
          });
        } else {
          totalWrittenRows += exportResult.written_row_count;
          totalWrittenBytes += exportResult.total_bytes;
        }
        if (adoptResult.adopted && adoptResult.comparison) {
          summary.prune_check_dropbox_exports += 1;
        } else if (adoptResult.adopted && runtime.prune_check_dropbox?.enabled) {
          summary.prune_check_dropbox_failures += 1;
        }

        const dayState = await finalizeDayGateIfReady({
          client: controlClient,
          runtime,
          dayUtc: candidate.day_utc,
        });
        dayResults.set(candidate.day_utc, dayState);

        const durationMs = Math.max(0, Date.now() - startedAtMs);
        logStructured("INFO", "phase_b_history_candidate_complete", {
          run_id: runId,
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          resumed_from_part_index: Number(candidate.resume_part_index || 0),
          resumed_from_row_count: candidate.resume_exported_row_count.toString(),
          expected_row_count: candidate.expected_row_count.toString(),
          written_row_count: exportResult.written_row_count.toString(),
          file_count: exportResult.file_count,
          total_bytes: exportResult.total_bytes.toString(),
          manifest_key: exportResult.manifest_key,
          source_owner: exportResult.adopted ? "adopted_existing_r2_manifest" : "phase_b_export",
          comparison_output_root: adoptResult.comparison?.comparison_output_root || null,
          duration_ms: durationMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          if (runtime.history_write_version === "v2") {
            await cleanupCandidatePartialOutput({
              runtime,
              dayUtc: candidate.day_utc,
              connectorId: candidate.connector_id,
            });
          }
        } catch (cleanupError) {
          logPhaseB(runtime, "ERROR", "phase_b_history_partial_cleanup_failed", {
            day_utc: candidate.day_utc,
            connector_id: candidate.connector_id,
            ...errorLogFields(cleanupError),
          });
        }
        await markCandidateFailed(controlClient, {
          dayUtc: candidate.day_utc,
          connectorId: candidate.connector_id,
          runId,
          errorText: message,
        });
        const dayState = await finalizeDayGateIfReady({
          client: controlClient,
          runtime,
          dayUtc: candidate.day_utc,
        });
        dayResults.set(candidate.day_utc, dayState);
        summary.failed_candidates += 1;
        summary.adoption_failures.push({
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          run_id: runId,
          error: message,
        });
        summary.failures.push({
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          run_id: runId,
          error: message,
          next_action: "retry_safe",
        });
        logStructured("ERROR", "phase_b_history_candidate_failed", {
          run_id: runId,
          history_write_version: runtime.history_write_version,
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          candidate_index: candidateIndex,
          candidate_count: pendingCandidates.length,
          resumed_from_part_index: Number(candidate.resume_part_index || 0),
          resumed_from_row_count: candidate.resume_exported_row_count.toString(),
          error: message,
          ...errorLogFields(error),
          ...budgetSnapshot(runtime),
          next_action: "retry_safe",
          prune_blocked_for_day: true,
        });
        if (error instanceof PhaseBHistoryBudgetExhaustedError) {
          break;
        }
      }
    }
  });

  if (hasBudgetFor(runtime, 120_000)) {
    summary.aqilevels = await runAqilevelsBackup({
      runtime,
      latestEligibleDayUtc: window.latest_eligible_day_utc,
      dryRun,
      logStructured,
    });
  } else {
    logPhaseB(runtime, "WARNING", "phase_b_history_budget_exhausted", {
      operation: "aqilevels_backup_start",
    });
    summary.aqilevels = { skipped: true, reason: "phase_b_history_budget_exhausted" };
  }

  if (dryRun) {
    logStructured("INFO", "phase_b_history_run_summary", summary);
    return summary;
  }

  summary.total_written_rows = totalWrittenRows.toString();
  summary.total_written_bytes = totalWrittenBytes.toString();

  const dayStates = Array.from(dayResults.values());
  summary.completed_days = dayStates.filter((state) => state.history_done === true).length;
  summary.blocked_days = dayStates.filter((state) => state.history_done !== true).length;
  summary.completed_preview = dayStates.slice(0, 25);
  summary.blocked_preview = dayStates.filter((state) => state.history_done !== true).slice(0, 25);
  summary.adoption_failures = summary.adoption_failures.slice(0, 25);
  summary.failures = summary.failures.slice(0, 25);

  const cleanupSummary = await cleanupStaging({ runtime, logStructured });
  summary.staging_cleanup = cleanupSummary;

  const runManifestKey = await writeRunManifest({ runtime, runSummary: summary });
  summary.run_manifest_key = runManifestKey;

  if (runtime.prune_check_dropbox?.enabled) {
    logStructured("INFO", "phase_b_history_prune_check_summary", {
      run_id: runId,
      adopted_candidates: summary.adopted_candidates,
      dropbox_exports: summary.prune_check_dropbox_exports,
      dropbox_failures: summary.prune_check_dropbox_failures,
      required: runtime.prune_check_dropbox?.required === true,
    });
  }

  logStructured("INFO", "phase_b_history_run_summary", summary);
  return summary;
}

export async function fetchBackupDoneDays({ supabaseDbUrl, dayUtcList }) {
  if (!Array.isArray(dayUtcList) || dayUtcList.length === 0) {
    return new Map();
  }

  const distinctDays = uniqueSorted(dayUtcList.map((day) => String(day).slice(0, 10)));
  if (distinctDays.length === 0) {
    return new Map();
  }

  return await withPgClient(supabaseDbUrl, async (client) => {
    const literalList = distinctDays.map((day) => `'${escapeSingleQuotes(day)}'::date`).join(", ");
    const sql = `
select g.day_utc::text as day_utc
from uk_aq_ops.prune_day_gates g
where g.day_utc in (${literalList})
  and g.history_done is true
  and nullif(btrim(g.history_manifest_key), '') is not null
  and g.history_manifest_key ~ '${PRUNE_HISTORY_DAY_MANIFEST_KEY_REGEX_SOURCE}'
  and g.history_completed_at is not null
`;
    const result = await client.query(sql);
    const map = new Map();
    for (const row of result.rows) {
      map.set(normalizeDayUtc(row.day_utc), true);
    }
    return map;
  });
}
