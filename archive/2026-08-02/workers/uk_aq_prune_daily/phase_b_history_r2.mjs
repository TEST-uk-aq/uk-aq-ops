import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import Cursor from "pg-cursor";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";
import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";
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
import {
  classifyManifestFileIdentity,
  verifyManifestFileIdentity,
} from "../shared/uk_aq_r2_file_identity.mjs";
import { resolveR2HistoryVersion } from "../shared/uk_aq_r2_history_version.mjs";
import {
  normalizeObservationPropertyCode,
  OBSERVATION_PROPERTY_CODE_SQL_PATTERN,
} from "../shared/uk_aq_observation_property_code.mjs";
import {
  computeObservationContentHash,
  normalizeCanonicalObservationRow,
  normalizeUkAirVerificationStatus,
  validateObservationContentHashMetadata,
} from "../shared/uk_aq_observation_content_hash.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "../shared/uk_aq_observation_history_schema.mjs";
import {
  buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey,
  buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey,
  updateR2HistoryIndexesTargeted,
} from "../shared/uk_aq_r2_history_index.mjs";
import {
  canonicalObservationConnectorManifestKey,
  connectorDayGateKey,
  isValidConnectorHistoryGateEvidence,
  setConnectorDayGateComplete,
  setConnectorDayGateIncomplete,
} from "../shared/uk_aq_connector_day_gate.mjs";
import {
  comparePruneConnectorSourceIdentities,
  computePruneConnectorSourceIdentity,
  normalizePruneConnectorSourceIdentity,
  pruneConnectorSourceIdentityFailureReason,
} from "../shared/uk_aq_prune_connector_source_identity.mjs";
import {
  mergeConnectorManifestReferences,
  readParentManifestForBoundedRecovery,
  runCanonicalDayFinalizer,
  runCanonicalConnectorDayWriter,
  runCanonicalGlobalIndexFinalizer,
  withConnectorDayHistoryLock,
} from "../shared/uk_aq_r2_history_writer.mjs";
import { validateCanonicalHistoryV2Manifest } from "../shared/uk_aq_r2_history_manifest_validation.mjs";
import {
  buildHistoryV2ConnectorManifest as buildCanonicalHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey as buildCanonicalHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest as buildCanonicalHistoryV2DayManifest,
  buildHistoryV2DayManifestKey as buildCanonicalHistoryV2DayManifestKey,
  buildHistoryV2PartKey as buildCanonicalHistoryV2PartKey,
  buildHistoryV2PollutantManifest as buildCanonicalHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey as buildCanonicalHistoryV2PollutantManifestKey,
  serializeCanonicalAqilevelDataV2Parquet as serializeSharedAqilevelDataV2Parquet,
  serializeCanonicalAqilevelDebugV2Parquet as serializeSharedAqilevelDebugV2Parquet,
  serializeCanonicalObservationV2Parquet as serializeSharedObservationV2Parquet,
} from "../shared/uk_aq_r2_history_canonical.mjs";
import {
  AQI_SUPPORTED_POLLUTANTS,
  buildAqilevelHistoryRowsForDayFromHourlyRows,
  buildAqilevelHistoryRowsForDayFromSourceObservations,
  dedupeSourceObservationRows,
  mergeAqiHourlyRowsPreferTargetDay,
  sourceObservationsToNarrowRows,
} from "../../lib/aqi/aqi_levels.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PART_MAX_ROWS = 1_000_000;
const DEFAULT_OBSERVATIONS_PART_MAX_ROWS = 500_000;
const DEFAULT_AQILEVELS_PART_MAX_ROWS = DEFAULT_PART_MAX_ROWS;
const DEFAULT_CURSOR_FETCH_ROWS = 20_000;
const DEFAULT_ROW_GROUP_SIZE = 100_000;
const DEFAULT_OBSERVATIONS_ROW_GROUP_SIZE = 50_000;
const DEFAULT_AQILEVELS_ROW_GROUP_SIZE = DEFAULT_ROW_GROUP_SIZE;
const DEFAULT_MAX_CANDIDATES_PER_RUN = 500;
const DEFAULT_MAX_SECONDS_PER_RUN = 1_740;
const DEFAULT_STOP_BEFORE_TIMEOUT_SECONDS = 60;
const PHASE_B_PG_STATEMENT_TIMEOUT_MAX_MS = 600_000;
const PHASE_B_PG_CONNECTION_TIMEOUT_MAX_MS = 15_000;
const PHASE_B_PG_DEADLINE_GUARD_MS = 1_000;
const PHASE_B_STAGE_MIN_MS = Object.freeze({
  candidate_start: 300_000,
  observation_segment: 60_000,
  aqi_calculation: 180_000,
  aqi_object_write: 120_000,
  observation_index: 120_000,
  aqi_index: 120_000,
  day_finalization: 120_000,
  dropbox_comparison: 180_000,
});
const DEFAULT_STAGING_RETENTION_DAYS = 7;
const DEFAULT_STAGING_PREFIX = "history/v1/_ops/observations/staging";
const DEFAULT_RUNS_PREFIX_V2 = "history/v2/_ops/observations/runs";
const DEFAULT_INGESTDB_RETENTION_DAYS = 5;
const DEFAULT_OBSAQIDB_OBSERVS_RETENTION_DAYS = 14;
const DEFAULT_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS = 250_000;
const DEFAULT_PHASE_B_OBSERVATION_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_PHASE_B_PM_CONTEXT_RPC = "uk_aq_rpc_observs_aqi_pm_hourly_context";
const DEFAULT_PHASE_B_PM_CONTEXT_PAGE_SIZE = 1_000;
const DEFAULT_PHASE_B_PM_CONTEXT_MAX_PAGES = 100;
const DEFAULT_PHASE_B_PM_CONTEXT_MAX_ROWS = 50_000;
const DEFAULT_PHASE_B_SOS_CONNECTOR_ID = 1;
const DEFAULT_PRUNE_CHECK_DROPBOX_DIR = "prune_r2_check";
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";

const HISTORY_SCHEMA_NAME = "observations";
const HISTORY_SCHEMA_VERSION = 2;
const WRITER_VERSION = "parquet-wasm-zstd-v2";
const HISTORY_AQILEVELS_GRAIN = "hourly";
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
export const HISTORY_OBSERVATIONS_COLUMNS_R2_V2 =
  OBSERVATION_HISTORY_COLUMNS_V3;
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
const HISTORY_R2_V2_OBSERVATIONS_MANIFEST_SCHEMA_VERSION = 3;
const HISTORY_R2_V2_WRITER_VERSION = "parquet-wasm-zstd-v2";
const HISTORY_R2_V2_OBSERVATIONS_WRITER_VERSION =
  OBSERVATION_HISTORY_WRITER_VERSION_V3;
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
  nowMs = Date.now,
  startedAtMs = nowMs(),
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
    now_ms: nowMs,
  };
}

function budgetNowMs(runtime) {
  const now = runtime?.run_budget?.now_ms;
  return typeof now === "function" ? Number(now()) : Date.now();
}

function budgetSnapshot(runtime) {
  const budget = runtime?.run_budget;
  if (!budget) {
    return {
      elapsed_run_ms: null,
      remaining_budget_ms: null,
    };
  }
  const now = budgetNowMs(runtime);
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
  return budgetNowMs(runtime) + Math.max(0, minMs) < budget.deadline_ms;
}

function remainingBudgetMs(runtime) {
  const budget = runtime?.run_budget;
  return budget ? Math.max(0, budget.deadline_ms - budgetNowMs(runtime)) : null;
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
  constructor(message = "Phase B history run budget exhausted", operation = null) {
    super(message);
    this.name = "PhaseBHistoryBudgetExhaustedError";
    this.code = "PHASE_B_HISTORY_BUDGET_EXHAUSTED";
    this.operation = operation;
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
  throw new PhaseBHistoryBudgetExhaustedError(undefined, operation);
}

function rethrowIfBudgetDeadlineReached(runtime, error, operation, fields = {}) {
  if (error instanceof PhaseBHistoryBudgetExhaustedError) throw error;
  if (!hasBudgetFor(runtime, 2_000)) {
    logPhaseB(runtime, "WARNING", "phase_b_history_budget_exhausted", {
      operation,
      ...fields,
    });
    throw new PhaseBHistoryBudgetExhaustedError(undefined, operation);
  }
}

async function runBudgetedPhaseBStage({ runtime, operation, fields = {}, minMs, adapter }) {
  assertBudget(runtime, operation, fields, minMs);
  return await adapter({
    deadline_ms: runtime?.run_budget?.deadline_ms ?? null,
    remaining_ms: remainingBudgetMs(runtime),
  });
}

export async function runBudgetedPhaseBStageForTest(args) {
  try {
    const value = await runBudgetedPhaseBStage(args);
    return { status: "completed", value };
  } catch (error) {
    if (error instanceof PhaseBHistoryBudgetExhaustedError) {
      return { status: "stopped_budget", value: null };
    }
    throw error;
  }
}

function stopPhaseBForBudget(summary, runtime, { operation, candidate = null } = {}) {
  summary.status = "stopped_budget";
  summary.stopped_for_budget = true;
  summary.budget_stop = {
    operation: operation || "unknown",
    day_utc: candidate?.day_utc || null,
    connector_id: candidate?.connector_id ?? null,
    ...budgetSnapshot(runtime),
  };
  return summary;
}

export function stopPhaseBForBudgetForTest({ summary, runtime, operation, candidate = null }) {
  return stopPhaseBForBudget(summary, runtime, { operation, candidate });
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
  if (historyWriteVersion !== "v2") {
    throw new Error("R2 prune Phase B history writes require canonical history version v2");
  }
  const observationsPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || HISTORY_R2_V2_OBSERVATIONS_PREFIX,
  );
  const aqilevelsDataPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX || HISTORY_R2_V2_AQILEVELS_HOURLY_DATA_PREFIX,
  );
  const aqilevelsDebugPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX || HISTORY_R2_V2_AQILEVELS_HOURLY_DEBUG_PREFIX,
  );
  const runsPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_RUNS_PREFIX || DEFAULT_RUNS_PREFIX_V2,
  );

  return Object.freeze({
    history_write_version: historyWriteVersion,
    observations_prefix: observationsPrefixV2,
    observations_prefix_v2: observationsPrefixV2,
    aqilevels_prefix: aqilevelsDataPrefixV2,
    aqilevels_hourly_data_prefix_v2: aqilevelsDataPrefixV2,
    aqilevels_hourly_debug_prefix_v2: aqilevelsDebugPrefixV2,
    runs_prefix: runsPrefixV2,
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
  const value = normalizeObservationPropertyCode(pollutantCode);
  if (!value) {
    throw new Error(`Invalid pollutant_code for R2 path: ${String(pollutantCode || "")}`);
  }
  return value;
}

function pollutantPrefix(basePrefix, dayUtc, connectorId, pollutantCode) {
  return `${connectorPrefix(basePrefix, dayUtc, connectorId)}/pollutant_code=${normalizePollutantCodeForPath(pollutantCode)}`;
}

export function buildHistoryV2PollutantManifestKey(basePrefix, dayUtc, connectorId, pollutantCode) {
  return buildCanonicalHistoryV2PollutantManifestKey(basePrefix, dayUtc, connectorId, pollutantCode);
}

export function buildHistoryV2PartKey(basePrefix, dayUtc, connectorId, pollutantCode, partIndex) {
  return buildCanonicalHistoryV2PartKey(basePrefix, dayUtc, connectorId, pollutantCode, partIndex);
}

export function buildHistoryV2ConnectorManifestKey(basePrefix, dayUtc, connectorId) {
  return buildCanonicalHistoryV2ConnectorManifestKey(basePrefix, dayUtc, connectorId);
}

export function buildHistoryV2DayManifestKey(basePrefix, dayUtc) {
  return buildCanonicalHistoryV2DayManifestKey(basePrefix, dayUtc);
}

export function defaultHistoryV2PrefixesForTest() {
  return {
    observations: HISTORY_R2_V2_OBSERVATIONS_PREFIX,
    aqilevels_hourly_data: HISTORY_R2_V2_AQILEVELS_HOURLY_DATA_PREFIX,
    aqilevels_hourly_debug: HISTORY_R2_V2_AQILEVELS_HOURLY_DEBUG_PREFIX,
  };
}

function toPgConnectionConfig(connectionString, connectionTimeoutMs) {
  return {
    connectionString,
    statement_timeout: 0,
    query_timeout: 0,
    connectionTimeoutMillis: connectionTimeoutMs,
    application_name: "uk_aq_prune_daily_phase_b_history",
  };
}

export function derivePhaseBPgTimeoutsForTest(runtime) {
  const remainingMs = remainingBudgetMs(runtime);
  const usableMs = remainingMs === null
    ? PHASE_B_PG_STATEMENT_TIMEOUT_MAX_MS
    : Math.trunc(remainingMs) - PHASE_B_PG_DEADLINE_GUARD_MS;
  if (usableMs < 1) {
    throw new PhaseBHistoryBudgetExhaustedError(
      "Phase B history run budget exhausted before PostgreSQL control work",
      "control_database_connection",
    );
  }
  return {
    remaining_budget_ms: remainingMs,
    statement_timeout_ms: Math.max(1, Math.min(PHASE_B_PG_STATEMENT_TIMEOUT_MAX_MS, usableMs)),
    connection_timeout_ms: Math.max(1, Math.min(PHASE_B_PG_CONNECTION_TIMEOUT_MAX_MS, usableMs)),
  };
}

function isPgStatementTimeoutError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.code === "57014"
    && /statement timeout|canceling statement due to statement timeout/i.test(message);
}

async function withPgClient(
  connectionString,
  fn,
  {
    statementTimeoutMs = PHASE_B_PG_STATEMENT_TIMEOUT_MAX_MS,
    connectionTimeoutMs = PHASE_B_PG_CONNECTION_TIMEOUT_MAX_MS,
    createClient = (config) => new Client(config),
  } = {},
) {
  const boundedConnectionTimeoutMs = Math.max(
    1,
    Math.min(PHASE_B_PG_CONNECTION_TIMEOUT_MAX_MS, Math.trunc(Number(connectionTimeoutMs) || PHASE_B_PG_CONNECTION_TIMEOUT_MAX_MS)),
  );
  const client = createClient(toPgConnectionConfig(connectionString, boundedConnectionTimeoutMs));
  await client.connect();
  try {
    await client.query("set timezone = 'UTC'");
    const boundedStatementTimeoutMs = Math.max(
      1,
      Math.min(PHASE_B_PG_STATEMENT_TIMEOUT_MAX_MS, Math.trunc(Number(statementTimeoutMs) || PHASE_B_PG_STATEMENT_TIMEOUT_MAX_MS)),
    );
    await client.query(`set statement_timeout = '${boundedStatementTimeoutMs}ms'`);
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function postgrestRpc({ baseUrl, privilegedKey, rpcSchema, rpcName, payload, signal = undefined }) {
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
    signal,
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

class PhaseBPmContextError extends Error {
  constructor(message, diagnostics, code = "PHASE_B_PM_CONTEXT_INCOMPLETE") {
    super(message);
    this.name = "PhaseBPmContextError";
    this.code = code;
    this.pm_context_diagnostics = diagnostics;
  }
}

function pmContextWindowForDay(dayUtc) {
  return {
    start_utc: `${shiftIsoDay(dayUtc, -1)}T01:00:00.000Z`,
    end_utc: `${dayUtc}T00:00:00.000Z`,
  };
}

function obsAqidbRetentionBoundaryUtc(nowUtc, retentionDays) {
  const now = new Date(nowUtc);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid Phase B now_utc for ObsAQIDB retention guard: ${String(nowUtc)}`);
  }
  const boundary = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - retentionDays,
    0,
    0,
    0,
    0,
  ));
  return boundary.toISOString();
}

function normalizePmContextRow(raw, { connectorId, windowStartUtc, windowEndUtc }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PM context RPC returned a non-object row");
  }
  const row = raw;
  const rowConnectorId = toNullablePositiveInteger(row.connector_id);
  const stationId = toNullablePositiveInteger(row.station_id);
  const timeseriesId = toNullablePositiveInteger(row.timeseries_id);
  const pollutantCode = String(row.pollutant_code || "").trim().toLowerCase();
  const timestampHourUtc = toNullableIsoTimestamp(row.timestamp_hour_utc);
  const hourlyMean = toNullableNumber(row.hourly_mean_ugm3);
  const sampleCount = toNullablePositiveInteger(row.sample_count);
  if (rowConnectorId !== connectorId || !stationId || !timeseriesId) {
    throw new Error("PM context RPC returned an invalid connector, station or timeseries identifier");
  }
  if (pollutantCode !== "pm25" && pollutantCode !== "pm10") {
    throw new Error("PM context RPC returned a non-PM pollutant");
  }
  if (!timestampHourUtc || timestampHourUtc < windowStartUtc || timestampHourUtc >= windowEndUtc) {
    throw new Error("PM context RPC returned a row outside the requested context window");
  }
  const timestampDate = new Date(timestampHourUtc);
  if (
    timestampDate.getUTCMinutes() !== 0 || timestampDate.getUTCSeconds() !== 0 ||
    timestampDate.getUTCMilliseconds() !== 0
  ) {
    throw new Error("PM context RPC returned a non-hour-aligned timestamp");
  }
  if (hourlyMean === null || hourlyMean < 0 || !sampleCount) {
    throw new Error("PM context RPC returned an invalid hourly aggregate");
  }
  return {
    connector_id: rowConnectorId,
    station_id: stationId,
    timeseries_id: timeseriesId,
    pollutant_code: pollutantCode,
    timestamp_hour_utc: timestampHourUtc,
    hourly_mean_ugm3: hourlyMean,
    sample_count: sampleCount,
  };
}

function comparePmContextCursor(left, right) {
  if (left.timeseries_id !== right.timeseries_id) {
    return left.timeseries_id - right.timeseries_id;
  }
  return left.timestamp_hour_utc.localeCompare(right.timestamp_hour_utc);
}

async function fetchPmHourlyContext({ runtime, dayUtc, connectorId, targetPmTimeseries }) {
  const window = pmContextWindowForDay(dayUtc);
  const diagnostics = {
    pm_context_source: "obs_aqidb",
    pm_context_window_start_utc: window.start_utc,
    pm_context_window_end_utc: window.end_utc,
    pm_context_requested_connector_id: connectorId,
    pm_context_target_timeseries_count: targetPmTimeseries.size,
    pm_context_rows_fetched: 0,
    pm_context_rows_accepted: 0,
    pm_context_rows_discarded: 0,
    pm_context_page_count: 0,
    pm_context_complete: false,
  };

  if (targetPmTimeseries.size === 0) {
    return { rows: [], diagnostics: { ...diagnostics, pm_context_complete: true } };
  }

  const source = runtime.observs_source || {};
  if (
    !String(source.base_url || "").trim() || !String(source.privileged_key || "").trim() ||
    !String(source.rpc_schema || "").trim() || !String(source.pm_context_rpc || "").trim()
  ) {
    throw new PhaseBPmContextError(
      "Phase B PM context requires ObsAQIDB service-role RPC configuration.",
      diagnostics,
      "PHASE_B_PM_CONTEXT_CONFIG_MISSING",
    );
  }

  const retentionBoundaryUtc = obsAqidbRetentionBoundaryUtc(
    runtime.now_utc,
    runtime.observs_retention_days,
  );
  if (window.start_utc < retentionBoundaryUtc) {
    throw new PhaseBPmContextError(
      `PM context window starts before ObsAQIDB retention boundary: start=${window.start_utc} boundary=${retentionBoundaryUtc}`,
      { ...diagnostics, pm_context_retention_boundary_utc: retentionBoundaryUtc },
      "PHASE_B_PM_CONTEXT_OUTSIDE_RETENTION",
    );
  }

  const rows = [];
  const seenKeys = new Set();
  let afterTimeseriesId = null;
  let afterTimestampHourUtc = null;
  let previousCursor = null;
  try {
    for (;;) {
      assertBudget(runtime, "pm_context_fetch", {
        day_utc: dayUtc,
        connector_id: connectorId,
        ...diagnostics,
      }, PHASE_B_STAGE_MIN_MS.observation_segment);
      if (diagnostics.pm_context_page_count >= runtime.pm_context_max_pages) {
        throw new Error(`PM context RPC exceeded max pages (${runtime.pm_context_max_pages}) before completion`);
      }
      const payload = await postgrestRpc({
        baseUrl: source.base_url,
        privilegedKey: source.privileged_key,
        rpcSchema: source.rpc_schema,
        rpcName: source.pm_context_rpc,
        payload: {
          p_connector_id: connectorId,
          p_start_utc: window.start_utc,
          p_end_utc: window.end_utc,
          p_after_timeseries_id: afterTimeseriesId,
          p_after_timestamp_hour_utc: afterTimestampHourUtc,
          p_limit: runtime.pm_context_page_size,
        },
        signal: AbortSignal.timeout(Math.max(1, (remainingBudgetMs(runtime) ?? 60_000) - 1_000)),
      });
      if (!Array.isArray(payload)) {
        throw new Error("PM context RPC returned a non-array response");
      }
      diagnostics.pm_context_page_count += 1;
      diagnostics.pm_context_rows_fetched += payload.length;
      if (diagnostics.pm_context_rows_fetched > runtime.pm_context_max_rows) {
        throw new Error(`PM context RPC exceeded max rows (${runtime.pm_context_max_rows})`);
      }

      let pageCursor = null;
      for (const raw of payload) {
        const row = normalizePmContextRow(raw, {
          connectorId,
          windowStartUtc: window.start_utc,
          windowEndUtc: window.end_utc,
        });
        if (pageCursor && comparePmContextCursor(pageCursor, row) >= 0) {
          throw new Error("PM context RPC cursor did not advance within page");
        }
        pageCursor = row;
        if (previousCursor && comparePmContextCursor(previousCursor, row) >= 0) {
          throw new Error("PM context RPC cursor did not advance across pages");
        }
        const key = `${row.timeseries_id}|${row.pollutant_code}|${row.timestamp_hour_utc}`;
        if (seenKeys.has(key)) {
          throw new Error("PM context RPC returned a duplicate hourly key");
        }
        seenKeys.add(key);
        if (targetPmTimeseries.get(row.timeseries_id) === row.pollutant_code) {
          rows.push(row);
          diagnostics.pm_context_rows_accepted += 1;
        } else {
          diagnostics.pm_context_rows_discarded += 1;
        }
      }

      if (payload.length < runtime.pm_context_page_size) {
        diagnostics.pm_context_complete = true;
        break;
      }
      if (!pageCursor) {
        throw new Error("PM context RPC returned a full page without a cursor row");
      }
      previousCursor = pageCursor;
      afterTimeseriesId = pageCursor.timeseries_id;
      afterTimestampHourUtc = pageCursor.timestamp_hour_utc;
      if (diagnostics.pm_context_rows_fetched >= runtime.pm_context_max_rows) {
        throw new Error(`PM context RPC reached max rows (${runtime.pm_context_max_rows}) before completion`);
      }
    }
  } catch (error) {
    rethrowIfBudgetDeadlineReached(runtime, error, "pm_context_fetch", {
      day_utc: dayUtc,
      connector_id: connectorId,
    });
    if (error instanceof PhaseBPmContextError) throw error;
    throw new PhaseBPmContextError(
      error instanceof Error ? error.message : String(error),
      diagnostics,
    );
  }

  return { rows, diagnostics };
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
    source_row_count: row.source_row_count === null || row.source_row_count === undefined
      ? parseBigInt(row.expected_row_count, "expected_row_count")
      : parseBigInt(row.source_row_count, "source_row_count"),
    excluded_row_count: row.excluded_row_count === null || row.excluded_row_count === undefined
      ? 0n
      : parseBigInt(row.excluded_row_count, "excluded_row_count"),
    excluded_pollutant_counts: row.excluded_pollutant_counts && typeof row.excluded_pollutant_counts === "object"
      ? row.excluded_pollutant_counts
      : {},
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
    source_content_hash: row.source_content_hash ? String(row.source_content_hash) : null,
    source_content_hash_contract_version:
      row.source_content_hash_contract_version === null || row.source_content_hash_contract_version === undefined
        ? null
        : Number(row.source_content_hash_contract_version),
    source_content_hash_row_count:
      row.source_content_hash_row_count === null || row.source_content_hash_row_count === undefined
        ? null
        : parseBigInt(row.source_content_hash_row_count, "source_content_hash_row_count"),
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

async function readCanonicalConnectorDaySourceRows(client, dayUtc, connectorId) {
  const dayStart = `${dayUtc}T00:00:00.000Z`;
  const dayEnd = `${shiftIsoDay(dayUtc, 1)}T00:00:00.000Z`;
  const result = await client.query(
    `
select
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,
  observed_at_utc,
  value,
  status
from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  null::integer,
  null::timestamptz
)
`,
    [connectorId, dayStart, dayEnd],
  );
  return result.rows;
}

async function invalidateCandidateAndConnectorGateSourceIdentity(
  client,
  candidate,
  failureReason,
) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'pending',
  run_id = null,
  last_error = $3,
  manifest_key = null,
  history_row_count = null,
  history_file_count = null,
  history_total_bytes = null,
  history_completed_at = null,
  source_content_hash = null,
  source_content_hash_contract_version = null,
  source_content_hash_row_count = null,
  resume_last_timeseries_id = null,
  resume_last_observed_at = null,
  resume_part_index = 0,
  resume_exported_row_count = 0,
  resume_parts_json = '[]'::jsonb,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
  and status = 'complete'
`,
    [candidate.day_utc, candidate.connector_id, failureReason],
  );
  await setConnectorDayGateIncomplete(client, {
    day_utc: candidate.day_utc,
    connector_id: candidate.connector_id,
  });
}

async function revalidateCompleteCandidateSourceIdentity(client, candidate) {
  if (candidate.status !== "complete") return candidate;
  await client.query("begin isolation level repeatable read");
  try {
    const locked = await client.query(
      `
select *
from uk_aq_ops.history_candidates
where day_utc = $1::date
  and connector_id = $2::integer
for update
`,
      [candidate.day_utc, candidate.connector_id],
    );
    const currentCandidate = locked.rows[0] ? toConnectorDayRow(locked.rows[0]) : candidate;
    if (currentCandidate.status !== "complete") {
      await client.query("commit");
      return currentCandidate;
    }
    let currentIdentity;
    let failureReason = null;
    try {
      currentIdentity = computePruneConnectorSourceIdentity(
        await readCanonicalConnectorDaySourceRows(
          client,
          currentCandidate.day_utc,
          currentCandidate.connector_id,
        ),
      );
    } catch (error) {
      failureReason = pruneConnectorSourceIdentityFailureReason(error);
    }
    if (!failureReason) {
      try {
        const persistedIdentity = normalizePruneConnectorSourceIdentity(currentCandidate);
        const comparison = comparePruneConnectorSourceIdentities(
          persistedIdentity,
          currentIdentity,
        );
        if (!comparison.match) failureReason = comparison.failure_reason;
      } catch (error) {
        failureReason = pruneConnectorSourceIdentityFailureReason(error);
      }
    }
    if (failureReason) {
      await invalidateCandidateAndConnectorGateSourceIdentity(
        client,
        currentCandidate,
        failureReason,
      );
      await client.query("commit");
      return {
        ...currentCandidate,
        status: "pending",
        run_id: null,
        manifest_key: null,
        history_row_count: null,
        history_file_count: null,
        history_total_bytes: null,
        source_content_hash: null,
        source_content_hash_contract_version: null,
        source_content_hash_row_count: null,
        source_changed_connector_gate_invalidated: true,
        source_identity_match: false,
        source_identity_failure_reason: failureReason,
        source_identity_rows: currentIdentity?.source_content_hash_row_count ?? null,
        candidate_source_identity_present: Boolean(
          currentCandidate.source_content_hash
          && currentCandidate.source_content_hash_contract_version !== null
          && currentCandidate.source_content_hash_row_count !== null
        ),
        gate_source_identity_present: null,
        source_identity_invalidated_connector_days: 1,
        source_change_invalidation: {
          day_utc: currentCandidate.day_utc,
          connector_id: currentCandidate.connector_id,
          source_identity_failure_reason: failureReason,
        },
      };
    }
    await client.query("commit");
    return {
      ...currentCandidate,
      source_identity_match: true,
      source_identity_failure_reason: null,
      source_identity_rows: currentIdentity.source_content_hash_row_count,
      candidate_source_identity_present: true,
      gate_source_identity_present: null,
      source_identity_invalidated_connector_days: 0,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function revalidateCompleteCandidateSourceIdentityForTest(client, candidate) {
  return revalidateCompleteCandidateSourceIdentity(client, candidate);
}


async function populateBackupCandidates(client, latestEligibleWindowEndIso, runtime = {}) {
  if (runtime.history_write_version === "v2") {
    const invalidCodes = await client.query(`
select distinct op.code
from uk_aq_core.observations o
join uk_aq_core.timeseries ts on ts.id = o.timeseries_id and ts.connector_id = o.connector_id
join uk_aq_core.phenomena p on p.id = ts.phenomenon_id
join uk_aq_core.observed_properties op on op.id = p.observed_property_id
where o.observed_at < $1::timestamptz
  and (op.code is null or btrim(op.code) = '' or op.code !~ '${OBSERVATION_PROPERTY_CODE_SQL_PATTERN}')
order by op.code nulls first
limit 25
`, [latestEligibleWindowEndIso]);
    if (invalidCodes.rows.length > 0) {
      throw new Error(`Invalid observed_properties.code values for v2 history: ${invalidCodes.rows.map((row) => String(row.code)).join(", ")}`);
    }
    const sql = `
with source_aggregates as (
  select
    (o.observed_at at time zone 'UTC')::date as day_utc,
    o.connector_id::integer as connector_id,
    count(*)::bigint as expected_row_count,
    min(o.observed_at) as min_observed_at,
    max(o.observed_at) as max_observed_at
  from uk_aq_core.observations o
  join uk_aq_core.timeseries ts
    on ts.id = o.timeseries_id
   and ts.connector_id = o.connector_id
  join uk_aq_core.phenomena p
    on p.id = ts.phenomenon_id
  join uk_aq_core.observed_properties op
    on op.id = p.observed_property_id
  where o.observed_at < $1::timestamptz
    and op.code ~ '${OBSERVATION_PROPERTY_CODE_SQL_PATTERN}'
  group by 1, 2
),
source_changes as materialized (
  select
    sa.day_utc,
    sa.connector_id,
    hc.expected_row_count as previous_expected_row_count,
    sa.expected_row_count as current_expected_row_count,
    hc.min_observed_at as previous_min_observed_at,
    sa.min_observed_at as current_min_observed_at,
    hc.max_observed_at as previous_max_observed_at,
    sa.max_observed_at as current_max_observed_at
  from source_aggregates sa
  join uk_aq_ops.history_candidates hc
    on hc.day_utc = sa.day_utc
   and hc.connector_id = sa.connector_id
  where hc.status = 'complete'
    and (
      hc.expected_row_count is distinct from sa.expected_row_count
      or hc.min_observed_at is distinct from sa.min_observed_at
      or hc.max_observed_at is distinct from sa.max_observed_at
    )
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
    source_content_hash,
    source_content_hash_contract_version,
    source_content_hash_row_count,
    resume_last_timeseries_id,
    resume_last_observed_at,
    resume_part_index,
    resume_exported_row_count,
    resume_parts_json
  )
  select
    sa.day_utc,
    sa.connector_id,
    sa.expected_row_count,
    sa.min_observed_at,
    sa.max_observed_at,
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
    null,
    null,
    null,
    0,
    0,
    '[]'::jsonb
  from source_aggregates sa
  on conflict (day_utc, connector_id)
  do update set
    expected_row_count = excluded.expected_row_count,
    min_observed_at = excluded.min_observed_at,
    max_observed_at = excluded.max_observed_at,
    status = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then 'complete'
      else 'pending'
    end,
    run_id = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.run_id
      else null
    end,
    last_error = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.last_error
      else null
    end,
    manifest_key = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.manifest_key
      else null
    end,
    history_row_count = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.history_row_count
      else null
    end,
    history_file_count = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.history_file_count
      else null
    end,
    history_total_bytes = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.history_total_bytes
      else null
    end,
    history_completed_at = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.history_completed_at
      else null
    end,
    source_content_hash = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.source_content_hash
      else null
    end,
    source_content_hash_contract_version = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.source_content_hash_contract_version
      else null
    end,
    source_content_hash_row_count = case
      when uk_aq_ops.history_candidates.status = 'complete'
       and uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.source_content_hash_row_count
      else null
    end,
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
    source_content_hash,
    source_content_hash_contract_version,
    source_content_hash_row_count,
    resume_last_timeseries_id,
    resume_last_observed_at,
    resume_part_index,
    resume_exported_row_count,
    resume_parts_json
),
invalidated_connector_gates as (
  insert into uk_aq_ops.prune_connector_day_gates (
    day_utc,
    connector_id,
    history_done,
    updated_at
  )
  select
    sc.day_utc,
    sc.connector_id,
    false,
    now()
  from source_changes sc
  on conflict (day_utc, connector_id)
  do update set
    history_done = false,
    history_run_id = null,
    history_manifest_key = null,
    history_manifest_hash = null,
    history_row_count = null,
    history_file_count = null,
    history_total_bytes = null,
    history_completed_at = null,
    source_content_hash = null,
    source_content_hash_contract_version = null,
    source_content_hash_row_count = null,
    completion_source = null,
    updated_at = now()
  returning day_utc, connector_id
)
select
  u.*,
  u.expected_row_count::bigint as source_row_count,
  0::bigint as excluded_row_count,
  '{}'::jsonb as excluded_pollutant_counts,
  (ig.day_utc is not null) as source_changed_connector_gate_invalidated,
  sc.previous_expected_row_count,
  sc.current_expected_row_count,
  sc.previous_min_observed_at,
  sc.current_min_observed_at,
  sc.previous_max_observed_at,
  sc.current_max_observed_at
from upserted u
left join source_changes sc
  on sc.day_utc = u.day_utc
 and sc.connector_id = u.connector_id
left join invalidated_connector_gates ig
  on ig.day_utc = u.day_utc
 and ig.connector_id = u.connector_id
order by u.day_utc, u.connector_id
`;

    const result = await client.query(sql, [latestEligibleWindowEndIso]);
    const candidates = result.rows.map((row) => {
      const candidate = toConnectorDayRow(row);
      const invalidated = row.source_changed_connector_gate_invalidated === true;
      return {
        ...candidate,
        source_changed_connector_gate_invalidated: invalidated,
        source_change_invalidation: invalidated
          ? {
            day_utc: candidate.day_utc,
            connector_id: candidate.connector_id,
            previous_expected_row_count: String(row.previous_expected_row_count),
            current_expected_row_count: String(row.current_expected_row_count),
            previous_min_observed_at: row.previous_min_observed_at
              ? new Date(row.previous_min_observed_at).toISOString()
              : null,
            current_min_observed_at: row.current_min_observed_at
              ? new Date(row.current_min_observed_at).toISOString()
              : null,
            previous_max_observed_at: row.previous_max_observed_at
              ? new Date(row.previous_max_observed_at).toISOString()
              : null,
            current_max_observed_at: row.current_max_observed_at
              ? new Date(row.current_max_observed_at).toISOString()
              : null,
          }
          : null,
      };
    });
    const revalidated = [];
    for (const candidate of candidates) {
      const checked = await revalidateCompleteCandidateSourceIdentity(client, candidate);
      revalidated.push({
        ...candidate,
        ...checked,
        source_changed_connector_gate_invalidated:
          candidate.source_changed_connector_gate_invalidated === true
          || checked.source_changed_connector_gate_invalidated === true,
      });
    }
    return revalidated;
  }

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
    source_content_hash = null,
    source_content_hash_contract_version = null,
    source_content_hash_row_count = null,
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

export async function populateBackupCandidatesForTest({
  client,
  latestEligibleWindowEndIso,
  runtime,
}) {
  return populateBackupCandidates(client, latestEligibleWindowEndIso, runtime);
}

async function markActiveIncompleteDaysAsBackupBlocked(client, activeCandidates) {
  const activeScope = activeCandidateScopeJson(activeCandidates);
  if (activeScope === "[]") return;
  const sql = `
with active_scope as (
  select
    s.day_utc::date as day_utc,
    s.connector_id::integer as connector_id
  from jsonb_to_recordset($1::jsonb) as s(day_utc text, connector_id integer)
),
day_status as (
  select
    c.day_utc,
    bool_and(c.status = 'complete') as all_complete
  from uk_aq_ops.history_candidates c
  join active_scope s
    on s.day_utc = c.day_utc
   and s.connector_id = c.connector_id
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
  await client.query(sql, [activeScope]);
}

function activeCandidateScopeJson(candidates) {
  const distinct = new Map();
  for (const candidate of candidates || []) {
    const dayUtc = String(candidate?.day_utc || "").slice(0, 10);
    const connectorId = Number(candidate?.connector_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) || !Number.isInteger(connectorId) || connectorId <= 0) {
      continue;
    }
    distinct.set(`${dayUtc}:${connectorId}`, { day_utc: dayUtc, connector_id: connectorId });
  }
  return JSON.stringify(Array.from(distinct.values()));
}

async function fetchPendingCandidates(client, activeCandidates, maxCandidatesPerRun) {
  const sql = `
with active_scope as (
  select
    s.day_utc::date as day_utc,
    s.connector_id::integer as connector_id
  from jsonb_to_recordset($1::jsonb) as s(day_utc text, connector_id integer)
)
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
join active_scope s
  on s.day_utc = c.day_utc
 and s.connector_id = c.connector_id
where c.status = 'pending'
order by c.day_utc, c.connector_id
limit $2
`;

  const result = await client.query(sql, [activeCandidateScopeJson(activeCandidates), maxCandidatesPerRun]);
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
  source_content_hash = null,
  source_content_hash_contract_version = null,
  source_content_hash_row_count = null,
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
  sourceIdentity,
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
  source_content_hash = $8,
  source_content_hash_contract_version = $9,
  source_content_hash_row_count = $10,
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
      sourceIdentity.source_content_hash,
      sourceIdentity.source_content_hash_contract_version,
      sourceIdentity.source_content_hash_row_count,
    ],
  );
}

async function markCandidateAndConnectorGateComplete(client, {
  dayUtc,
  connectorId,
  runId,
  manifestKey,
  manifestHash,
  historyRowCount,
  historyFileCount,
  historyTotalBytes,
  sourceIdentity,
}) {
  await client.query("begin");
  try {
    await markCandidateComplete(client, {
      dayUtc,
      connectorId,
      runId,
      manifestKey,
      historyRowCount,
      historyFileCount,
      historyTotalBytes,
      sourceIdentity,
    });
    await setConnectorDayGateComplete(client, {
      day_utc: dayUtc,
      connector_id: connectorId,
      history_run_id: runId,
      history_manifest_key: manifestKey,
      history_manifest_hash: manifestHash,
      history_row_count: historyRowCount,
      history_file_count: historyFileCount,
      history_total_bytes: historyTotalBytes,
      ...sourceIdentity,
      completion_source: "prune_daily_phase_b",
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function markCandidateAndConnectorGateCompleteForTest(client, evidence) {
  return markCandidateAndConnectorGateComplete(client, evidence);
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
  source_content_hash = null,
  source_content_hash_contract_version = null,
  source_content_hash_row_count = null,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [dayUtc, connectorId, runId, errorText],
  );
}

async function markCandidateStoppedForBudget(client, {
  dayUtc,
  connectorId,
  runId,
  errorText,
  clearCheckpoint = false,
}) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'pending',
  run_id = $3,
  last_error = left($4, 4000),
  source_content_hash = null,
  source_content_hash_contract_version = null,
  source_content_hash_row_count = null,
  resume_last_timeseries_id = case when $5::boolean then null else resume_last_timeseries_id end,
  resume_last_observed_at = case when $5::boolean then null else resume_last_observed_at end,
  resume_part_index = case when $5::boolean then 0 else resume_part_index end,
  resume_exported_row_count = case when $5::boolean then 0 else resume_exported_row_count end,
  resume_parts_json = case when $5::boolean then '[]'::jsonb else resume_parts_json end,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [dayUtc, connectorId, runId, errorText, clearCheckpoint],
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

export function buildHistoryV2PollutantManifest(args) {
  return buildCanonicalHistoryV2PollutantManifest(args);
}

export function buildHistoryV2ConnectorManifest(args) {
  return buildCanonicalHistoryV2ConnectorManifest(args);
}

export function buildHistoryV2DayManifest(args) {
  return buildCanonicalHistoryV2DayManifest(args);
}

export const buildHistoryV2PollutantManifestForTest = buildHistoryV2PollutantManifest;
export const buildHistoryV2ConnectorManifestForTest = buildHistoryV2ConnectorManifest;
export const buildHistoryV2DayManifestForTest = buildHistoryV2DayManifest;

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


function rowsToObservationV2ParquetBuffer(rows, writerProperties, { includeVerificationStatus = true } = {}) {
  return serializeSharedObservationV2Parquet(rows, { writerProperties, includeVerificationStatus });
}

async function canonicalObservationRowsFromParquet(bytes, { isSos }) {
  const file = new Uint8Array(bytes).slice().buffer;
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Number(metadata.num_rows || 0);
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) {
    throw new Error("Committed observation Parquet must contain rows");
  }
  const schemaColumns = new Set(
    parquetSchema(metadata).children.map((column) => String(column.element.name)),
  );
  const requiredColumns = [
    "connector_id",
    "station_id",
    "timeseries_id",
    "pollutant_code",
    "observed_at_utc",
    "value",
  ];
  const missingColumns = requiredColumns.filter((column) =>
    !schemaColumns.has(column)
  );
  if (missingColumns.length) {
    throw new Error(
      `Committed observation Parquet is missing canonical columns: ${missingColumns.join(",")}`,
    );
  }
  const statusColumn = schemaColumns.has("verification_status")
    ? "verification_status"
    : schemaColumns.has("status")
    ? "status"
    : null;
  const columns = [
    ...requiredColumns,
    ...(statusColumn ? [statusColumn] : []),
  ];
  let decodedRows = [];
  await parquetRead({
    file,
    metadata,
    columns,
    rowStart: 0,
    rowEnd: rowCount,
    compressors,
    onComplete: (rows) => {
      decodedRows = Array.isArray(rows) ? rows : [];
    },
  });
  if (decodedRows.length !== rowCount) {
    throw new Error("Committed observation Parquet row count changed while reading");
  }
  return decodedRows.map((values) => {
    if (!Array.isArray(values)) {
      throw new Error("Committed observation Parquet contains an invalid row");
    }
    const rawStatus = statusColumn
      ? values[requiredColumns.length] ?? null
      : null;
    return normalizeCanonicalObservationRow({
      connector_id: Number(values[0]),
      station_id: values[1] === null || values[1] === undefined
        ? null
        : Number(values[1]),
      timeseries_id: Number(values[2]),
      pollutant_code: values[3],
      observed_at_utc: new Date(values[4]).toISOString(),
      value: Number(values[5]),
      verification_status: isSos
        ? normalizeUkAirVerificationStatus(rawStatus)
        : statusColumn === "verification_status"
        ? rawStatus
        : null,
    });
  });
}

function rowsToAqilevelDataV2ParquetBuffer(rows, writerProperties) {
  return serializeSharedAqilevelDataV2Parquet(rows, { writerProperties });
}

function rowsToAqilevelDebugV2ParquetBuffer(rows, writerProperties) {
  return serializeSharedAqilevelDebugV2Parquet(rows, { writerProperties });
}

export function serializeCanonicalObservationV2Parquet(rows, { rowGroupSize = DEFAULT_OBSERVATIONS_ROW_GROUP_SIZE } = {}) {
  return rowsToObservationV2ParquetBuffer(
    rows,
    parquetWriterProperties(
      rowGroupSize,
      HISTORY_R2_V2_OBSERVATIONS_WRITER_VERSION,
    ),
  );
}

export function rowsToObservationV2ParquetBufferForTest(rows) {
  return serializeCanonicalObservationV2Parquet(rows);
}

export function rowsToObservationV2LegacyParquetBufferForTest(rows) {
  return rowsToObservationV2ParquetBuffer(
    rows,
    parquetWriterProperties(
      DEFAULT_OBSERVATIONS_ROW_GROUP_SIZE,
      HISTORY_R2_V2_WRITER_VERSION,
    ),
    { includeVerificationStatus: false },
  );
}

export function serializeCanonicalAqilevelDataV2Parquet(rows, { rowGroupSize = DEFAULT_AQILEVELS_ROW_GROUP_SIZE } = {}) {
  return rowsToAqilevelDataV2ParquetBuffer(
    rows,
    parquetWriterProperties(rowGroupSize, HISTORY_R2_V2_WRITER_VERSION),
  );
}

export function serializeCanonicalAqilevelDebugV2Parquet(rows, { rowGroupSize = DEFAULT_AQILEVELS_ROW_GROUP_SIZE } = {}) {
  return rowsToAqilevelDebugV2ParquetBuffer(
    rows,
    parquetWriterProperties(rowGroupSize, HISTORY_R2_V2_WRITER_VERSION),
  );
}

export function rowsToAqilevelDataV2ParquetBufferForTest(rows) {
  return serializeCanonicalAqilevelDataV2Parquet(rows);
}

export function rowsToAqilevelDebugV2ParquetBufferForTest(rows) {
  return serializeCanonicalAqilevelDebugV2Parquet(rows);
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
  canonicalRowsByPollutant = null,
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
      canonicalRowsByPollutant,
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
  canonicalRowsByPollutant,
}) {
  if (!(canonicalRowsByPollutant instanceof Map)) {
    throw new Error("V2 observation writer requires a canonical pollutant-row accumulator");
  }
  const canonicalRows = rows.map((row) => normalizeCanonicalObservationRow({
    connector_id: row.connector_id,
    station_id: row.station_id,
    timeseries_id: row.timeseries_id,
    pollutant_code: normalizePollutantCodeForPath(row.pollutant_code),
    observed_at_utc: new Date(
      row.observed_at_utc || row.observed_at,
    ).toISOString(),
    value: row.value,
    verification_status: Number(row.connector_id) ===
        Number(runtime.sos_connector_id)
      ? normalizeUkAirVerificationStatus(
        row.verification_status ?? row.status ?? null,
      )
      : null,
  }));
  const groupedRows = groupRowsByPollutant(canonicalRows);
  const sourcePollutantCodes = groupedRows.map(([pollutantCode]) => pollutantCode);
  const writeGroups = groupedRows;
  const writePollutantCodes = writeGroups.map(([pollutantCode]) => pollutantCode);
  const excludedPollutantCodes = sourcePollutantCodes.filter((c) => !writePollutantCodes.includes(c));
  const excludedRowCount = groupedRows
    .filter(([pollutantCode]) => !writePollutantCodes.includes(pollutantCode))
    .reduce((sum, [, pollutantRows]) => sum + pollutantRows.length, 0);
  const writtenRowCount = writeGroups.reduce((sum, [, pollutantRows]) => sum + pollutantRows.length, 0);

  logPhaseB(runtime, "INFO", "phase_b_history_connector_pollutant_plan", {
    day_utc: dayUtc,
    connector_id: connectorId,
    source_pollutant_codes: sourcePollutantCodes,
    write_pollutant_codes: writePollutantCodes,
    excluded_pollutant_codes: excludedPollutantCodes,
    pollutant_filter_mode: "canonical_observed_properties",
    pollutant_count: sourcePollutantCodes.length,
    write_pollutant_count: writePollutantCodes.length,
    row_count: rows.length,
    eligible_for_history_count: writtenRowCount,
    excluded_row_count: excludedRowCount,
  });
  const nextParts = [...committedParts];
  let bytesAdded = 0n;

  for (let pollutantIndex = 0; pollutantIndex < writeGroups.length; pollutantIndex += 1) {
    const [pollutantCode, pollutantRows] = writeGroups[pollutantIndex];
    const accumulatedRows = canonicalRowsByPollutant.get(pollutantCode) || [];
    accumulatedRows.push(...pollutantRows);
    canonicalRowsByPollutant.set(pollutantCode, accumulatedRows);
    assertBudget(runtime, "pollutant_part", { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode }, PHASE_B_STAGE_MIN_MS.observation_segment);
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
      parquetWriterProperties(
        runtime.observations_row_group_size,
        HISTORY_R2_V2_OBSERVATIONS_WRITER_VERSION,
      ),
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
    assertBudget(runtime, "r2_put", { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode, prefix: committedKey }, PHASE_B_STAGE_MIN_MS.observation_segment);
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
    }, PHASE_B_STAGE_MIN_MS.observation_segment);
  }

  const nextObservedRows = observedRows + BigInt(writtenRowCount);
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
    source_row_count: rows.length,
    eligible_for_history_count: writtenRowCount,
    excluded_row_count: excludedRowCount,
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
      source_row_count: rows.length,
      eligible_for_history_count: writtenRowCount,
      excluded_row_count: excludedRowCount,
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
    source_row_count: rows.length,
    eligible_for_history_count: writtenRowCount,
    excluded_row_count: excludedRowCount,
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
  return await writeCommittedV2PartAndCheckpoint({
    ...args,
    canonicalRowsByPollutant:
      args.canonicalRowsByPollutant || new Map(),
  });
}

async function writeObservationV2ConnectorManifest({
  runtime,
  dayUtc,
  connectorId,
  committedParts,
  backedUpAtUtc,
  canonicalRowsByPollutant,
}) {
  if (!(canonicalRowsByPollutant instanceof Map)) {
    throw new Error("V2 observation manifest requires canonical pollutant rows");
  }
  assertBudget(runtime, "connector_manifest_prepare", { day_utc: dayUtc, connector_id: connectorId }, PHASE_B_STAGE_MIN_MS.observation_segment);
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
    assertBudget(runtime, "manifest_write", { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode }, PHASE_B_STAGE_MIN_MS.observation_segment);
    const pollutantManifestKey = buildHistoryV2PollutantManifestKey(
      runtime.committed_prefix,
      dayUtc,
      connectorId,
      pollutantCode,
    );
    const sourceRowCount = pollutantParts.reduce((sum, part) => sum + Number(part.row_count || 0), 0);
    const hashResult = computeObservationContentHash(
      canonicalRowsByPollutant.get(pollutantCode) || [],
    );
    const {
      canonical_rows: _canonicalRows,
      ...observationContentHash
    } = hashResult;
    const pollutantManifest = buildHistoryV2PollutantManifest({
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
      observationContentHash,
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
  const connectorManifest = buildHistoryV2ConnectorManifest({
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


function makePhaseBTargetDaySourceTempPath(runtime, dayUtc, connectorId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `uk-aq-phase-b-aqi-${dayUtc}-${connectorId}-`));
  return {
    root,
    ndjsonPath: path.join(root, "target_day_observations.ndjson"),
  };
}

function cleanupPhaseBTargetDaySourceTemp(temp) {
  if (!temp?.root) return;
  fs.rmSync(temp.root, { recursive: true, force: true });
}

function normalizeFrozenObservationRow(row) {
  const observedAt = new Date(row.observed_at_utc || row.observed_at).toISOString();
  return {
    connector_id: Number(row.connector_id),
    station_id: row.station_id === null || row.station_id === undefined ? null : Number(row.station_id),
    timeseries_id: Number(row.timeseries_id),
    pollutant_code: normalizePollutantCodeForPath(row.pollutant_code),
    observed_at: observedAt,
    observed_at_utc: observedAt,
    value: row.value,
    status: row.status ?? null,
  };
}

function isObservationRowInDay(row, dayUtc) {
  const observedMs = Date.parse(String(row?.observed_at_utc || row?.observed_at || ""));
  const startMs = Date.parse(`${dayUtc}T00:00:00.000Z`);
  return Number.isFinite(observedMs) && observedMs >= startMs && observedMs < startMs + DAY_MS;
}

async function* readFrozenSourceRows(ndjsonPath) {
  const input = fs.createReadStream(ndjsonPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed);
  }
}

async function stageFrozenSourceAndWriteObservations({ streamClient, candidate, runtime }) {
  const dayUtc = candidate.day_utc;
  const connectorId = candidate.connector_id;
  const dayStart = `${dayUtc}T00:00:00.000Z`;
  const dayEnd = `${shiftIsoDay(dayUtc, 1)}T00:00:00.000Z`;
  const temp = makePhaseBTargetDaySourceTempPath(runtime, dayUtc, connectorId);
  const output = fs.createWriteStream(temp.ndjsonPath, { encoding: "utf8" });
  const counts = {
    frozen_source_row_count: 0,
    frozen_source_bytes: 0,
    day_observation_row_count: 0,
    supported_aqi_source_row_count: 0,
    target_day_supported_aqi_source_row_count: 0,
    supported_pollutant_counts: {},
  };
  let committedParts = [];
  let observedRows = 0n;
  let totalBytes = 0n;
  let partIndex = 0;
  let pendingDayRows = [];
  const frozenSourceIdentityRows = [];
  const canonicalRowsByPollutant = new Map();

  const flushObservationRows = async () => {
    if (!pendingDayRows.length) return;
    const flushed = await writeCommittedPartAndCheckpoint({
      streamClient,
      runtime,
      dayUtc,
      connectorId,
      partIndex,
      rows: pendingDayRows,
      committedParts,
      observedRows,
      totalBytes,
      canonicalRowsByPollutant,
    });
    partIndex = flushed.partIndex;
    committedParts = flushed.committedParts;
    observedRows = flushed.observedRows;
    totalBytes = flushed.totalBytes;
    pendingDayRows = [];
  };

  const sql = `
select
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,
  observed_at_utc,
  value,
  status
from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  null::integer,
  null::timestamptz
)
`;
  const cursor = streamClient.query(new Cursor(sql, [connectorId, dayStart, dayEnd]));
  try {
    for (;;) {
      assertBudget(runtime, "frozen_source_fetch", { day_utc: dayUtc, connector_id: connectorId }, PHASE_B_STAGE_MIN_MS.observation_segment);
      const rows = await cursorRead(cursor, runtime.cursor_fetch_rows);
      if (!rows.length) break;
      for (const raw of rows) {
        const row = normalizeFrozenObservationRow(raw);
        if (!isObservationRowInDay(row, dayUtc)) {
          throw new Error(`Phase B target-day source returned an out-of-range row for day=${dayUtc} connector=${connectorId}`);
        }
        const encoded = `${JSON.stringify(row)}\n`;
        counts.frozen_source_row_count += 1;
        counts.frozen_source_bytes += Buffer.byteLength(encoded);
        if (counts.frozen_source_row_count > runtime.phase_b_observation_snapshot_max_rows) {
          throw new Error(`Phase B frozen source row cap exceeded for day=${dayUtc} connector=${connectorId}: max=${runtime.phase_b_observation_snapshot_max_rows}`);
        }
        if (counts.frozen_source_bytes > runtime.phase_b_observation_snapshot_max_bytes) {
          throw new Error(`Phase B frozen source byte cap exceeded for day=${dayUtc} connector=${connectorId}: max=${runtime.phase_b_observation_snapshot_max_bytes}`);
        }
        if (!output.write(encoded)) await new Promise((resolve) => output.once("drain", resolve));
        if (AQI_SUPPORTED_POLLUTANTS.includes(row.pollutant_code)) {
          counts.supported_aqi_source_row_count += 1;
          counts.supported_pollutant_counts[row.pollutant_code] = (counts.supported_pollutant_counts[row.pollutant_code] || 0) + 1;
          counts.target_day_supported_aqi_source_row_count += 1;
        }
        counts.day_observation_row_count += 1;
        frozenSourceIdentityRows.push(row);
        pendingDayRows.push(row);
        if (pendingDayRows.length >= runtime.observations_part_max_rows) await flushObservationRows();
      }
    }
    await flushObservationRows();
  } finally {
    await closeCursor(cursor);
    await new Promise((resolve, reject) => output.end((err) => err ? reject(err) : resolve()));
  }
  if (observedRows !== candidate.expected_row_count) {
    throw new Error(`Row count mismatch for day=${dayUtc} connector=${connectorId}: expected=${candidate.expected_row_count.toString()} observed=${observedRows.toString()}`);
  }
  const sourceIdentity = computePruneConnectorSourceIdentity(frozenSourceIdentityRows);
  if (BigInt(sourceIdentity.source_content_hash_row_count) !== observedRows) {
    throw new Error(`Source identity row count mismatch for day=${dayUtc} connector=${connectorId}`);
  }
  return {
    temp,
    counts,
    committedParts,
    observedRows,
    totalBytes,
    canonicalRowsByPollutant,
    sourceIdentity,
  };
}

async function buildAqiRowsFromFrozenSource({ runtime, dayUtc, connectorId, frozenSourcePath }) {
  const sourceRows = [];
  let targetDaySupportedRowCount = 0;
  let replayedRowCount = 0;
  for await (const row of readFrozenSourceRows(frozenSourcePath)) {
    replayedRowCount += 1;
    if (replayedRowCount % 10_000 === 0) {
      assertBudget(runtime, "aqi_calculation_replay", {
        day_utc: dayUtc,
        connector_id: connectorId,
        replayed_row_count: replayedRowCount,
      }, PHASE_B_STAGE_MIN_MS.observation_segment);
    }
    if (!AQI_SUPPORTED_POLLUTANTS.includes(row.pollutant_code)) continue;
    if (!isObservationRowInDay(row, dayUtc)) {
      throw new Error(`AQI target-day source contained an out-of-range row for day=${dayUtc} connector=${connectorId}`);
    }
    sourceRows.push(row);
    targetDaySupportedRowCount += 1;
    if (sourceRows.length > runtime.phase_b_observation_snapshot_max_rows) {
      throw new Error(`AQI source row cap exceeded while replaying frozen source for day=${dayUtc} connector=${connectorId}`);
    }
  }
  if (targetDaySupportedRowCount === 0) {
    return {
      status: "no_supported_aqi_source",
      rows: [],
      supported_source_row_count: sourceRows.length,
      target_day_supported_source_row_count: targetDaySupportedRowCount,
      pm_context: {
        pm_context_source: "obs_aqidb",
        pm_context_window_start_utc: null,
        pm_context_window_end_utc: null,
        pm_context_requested_connector_id: connectorId,
        pm_context_target_timeseries_count: 0,
        pm_context_rows_fetched: 0,
        pm_context_rows_accepted: 0,
        pm_context_rows_discarded: 0,
        pm_context_page_count: 0,
        pm_context_complete: true,
      },
      context_supported_aqi_hour_count: 0,
      daqi_status_counts: {},
      eaqi_status_counts: {},
    };
  }
  assertBudget(runtime, "aqi_calculation_normalize", {
    day_utc: dayUtc,
    connector_id: connectorId,
  }, PHASE_B_STAGE_MIN_MS.observation_segment);
  const acceptedRows = dedupeSourceObservationRows(sourceRows);
  const targetDayHourlyRows = sourceObservationsToNarrowRows(acceptedRows);
  if (acceptedRows.length === 0 || targetDayHourlyRows.length === 0) {
    throw new Error(`Phase B AQI source normalization produced zero output for day=${dayUtc} connector=${connectorId} despite ${targetDaySupportedRowCount} target-day supported source rows`);
  }
  const targetPmTimeseries = new Map(
    targetDayHourlyRows
      .filter((row) => row.pollutant_code === "pm25" || row.pollutant_code === "pm10")
      .map((row) => [row.timeseries_id, row.pollutant_code]),
  );
  const pmContext = await fetchPmHourlyContext({
    runtime,
    dayUtc,
    connectorId,
    targetPmTimeseries,
  });
  const mergedHourlyRows = mergeAqiHourlyRowsPreferTargetDay({
    contextRows: pmContext.rows,
    targetDayRows: targetDayHourlyRows,
  });
  assertBudget(runtime, "aqi_calculation_finalize", {
    day_utc: dayUtc,
    connector_id: connectorId,
  }, PHASE_B_STAGE_MIN_MS.observation_segment);
  const rows = buildAqilevelHistoryRowsForDayFromHourlyRows(mergedHourlyRows, dayUtc);
  if (rows.length === 0) {
    throw new Error(`Phase B AQI hourly calculation produced zero output for day=${dayUtc} connector=${connectorId} despite ${targetDaySupportedRowCount} target-day supported source rows`);
  }
  const countStatuses = (field) => rows.reduce((counts, row) => {
    const status = String(row[field] || "unknown");
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  return {
    status: "complete",
    rows,
    accepted_source_row_count: acceptedRows.length,
    rejected_source_row_count: Math.max(sourceRows.length - acceptedRows.length, 0),
    supported_source_row_count: sourceRows.length,
    target_day_supported_source_row_count: targetDaySupportedRowCount,
    pm_context: pmContext.diagnostics,
    context_supported_aqi_hour_count: pmContext.rows.length,
    daqi_status_counts: countStatuses("daqi_calculation_status"),
    eaqi_status_counts: countStatuses("eaqi_calculation_status"),
  };
}

async function writeEmptyAqilevelConnectorManifests({ runtime, dayUtc, connectorId, backedUpAtUtc }) {
  const writeProfile = async ({ prefix, profile }) => {
    const manifestKey = buildConnectorManifestKey(prefix, dayUtc, connectorId);
    const manifest = buildHistoryV2ConnectorManifest({
      domain: "aqilevels",
      grain: HISTORY_AQILEVELS_GRAIN,
      profile,
      dayUtc,
      connectorId,
      runId: runtime.run_id,
      manifestKey,
      pollutantManifests: [],
      writerGitSha: runtime.writer_git_sha,
      backedUpAtUtc,
    });
    await r2PutObject({
      r2: runtime.r2,
      key: manifestKey,
      body: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      content_type: "application/json",
    });
    const head = await r2HeadObject({ r2: runtime.r2, key: manifestKey });
    if (!head.exists) throw new Error(`AQI v2 ${profile} empty connector manifest missing after upload: ${manifestKey}`);
    return manifest;
  };
  const connectorManifest = await writeProfile({ prefix: runtime.aqilevels_prefix, profile: "data" });
  const debugConnectorManifest = await writeProfile({ prefix: runtime.aqilevels_hourly_debug_prefix_v2, profile: "debug" });
  return {
    status: "no_supported_aqi_source",
    source_row_count: 0n,
    file_count: 0,
    total_bytes: 0n,
    connector_manifest: connectorManifest,
    manifest_key: connectorManifest.manifest_key,
    debug_connector_manifest: debugConnectorManifest,
    debug_file_count: 0,
    debug_total_bytes: 0n,
  };
}

async function exportCandidateObservationsToR2({ candidate, runtime }) {
  if (runtime.history_write_version !== "v2") {
    throw new Error("Phase B observation-derived AQI writer requires R2 history write version v2.");
  }
  const dayUtc = candidate.day_utc;
  const connectorId = candidate.connector_id;
  return await withPgClient(runtime.supabase_db_url, async (streamClient) => {
      const staged = await stageFrozenSourceAndWriteObservations({ streamClient, candidate, runtime });
      const backedUpAtUtc = nowIso();
      const { connectorManifest, connectorManifestKey } = await writeObservationV2ConnectorManifest({
        runtime,
        dayUtc,
        connectorId,
        committedParts: staged.committedParts,
        backedUpAtUtc,
        canonicalRowsByPollutant: staged.canonicalRowsByPollutant,
      });
      return {
        day_utc: dayUtc,
        connector_id: connectorId,
        manifest_key: connectorManifestKey,
        source_row_count: candidate.expected_row_count,
        written_row_count: staged.observedRows,
        file_count: staged.committedParts.length,
        total_bytes: staged.totalBytes,
        parquet_object_keys: connectorManifest.parquet_object_keys,
        files: staged.committedParts,
        frozen_source_temp: staged.temp,
        frozen_source_counts: staged.counts,
        source_identity: staged.sourceIdentity,
      };
  }, { statementTimeoutMs: Math.max(1, (remainingBudgetMs(runtime) ?? 600_000) - 1_000) });
}

async function exportCandidateAqiFromFrozenSource({ candidate, runtime, observationResult }) {
  const dayUtc = candidate.day_utc;
  const connectorId = candidate.connector_id;
  const counts = observationResult.frozen_source_counts;
  const aqiBuild = await runBudgetedPhaseBStage({
    runtime,
    operation: "aqi_calculation",
    fields: { day_utc: dayUtc, connector_id: connectorId },
    minMs: PHASE_B_STAGE_MIN_MS.aqi_calculation,
    adapter: async () => await buildAqiRowsFromFrozenSource({
      runtime,
      dayUtc,
      connectorId,
      frozenSourcePath: observationResult.frozen_source_temp.ndjsonPath,
    }),
  });
  const aqiResult = await runBudgetedPhaseBStage({
    runtime,
    operation: "aqi_object_write",
    fields: { day_utc: dayUtc, connector_id: connectorId },
    minMs: PHASE_B_STAGE_MIN_MS.aqi_object_write,
    adapter: async () => aqiBuild.status !== "no_supported_aqi_source"
      ? await exportAqilevelConnectorRowsToR2({
        runtime,
        dayUtc,
        connector: { connector_id: connectorId, expected_row_count: BigInt(aqiBuild.rows.length), min_timeseries_id: null, max_timeseries_id: null },
        rows: aqiBuild.rows,
      })
      : await writeEmptyAqilevelConnectorManifests({ runtime, dayUtc, connectorId, backedUpAtUtc: nowIso() }),
  });
  return {
    status: aqiBuild.status,
    frozen_source_row_count: counts.frozen_source_row_count,
    frozen_source_bytes: counts.frozen_source_bytes,
    supported_aqi_source_row_count: counts.supported_aqi_source_row_count,
    target_day_supported_aqi_source_row_count: aqiBuild.target_day_supported_source_row_count ?? counts.target_day_supported_aqi_source_row_count,
    accepted_aqi_source_row_count: aqiBuild.accepted_source_row_count ?? 0,
    rejected_aqi_source_row_count: aqiBuild.rejected_source_row_count ?? 0,
    supported_pollutant_counts: counts.supported_pollutant_counts,
    ...(aqiBuild.pm_context || {}),
    context_supported_aqi_hour_count: aqiBuild.context_supported_aqi_hour_count ?? 0,
    daqi_status_counts: aqiBuild.daqi_status_counts ?? {},
    eaqi_status_counts: aqiBuild.eaqi_status_counts ?? {},
    output_row_count: aqiBuild.rows?.length || 0,
    manifest_key: aqiResult.manifest_key || aqiResult.connector_manifest?.manifest_key || null,
    debug_manifest_key: aqiResult.debug_connector_manifest?.manifest_key || null,
    file_count: aqiResult.file_count || 0,
    debug_file_count: aqiResult.debug_file_count || 0,
  };
}

async function exportCandidateToR2({ candidate, runtime }) {
  if (runtime.history_write_version !== "v2") {
    throw new Error("Phase B connector-day export requires canonical R2 history version v2");
  }
  return await exportCandidateObservationsToR2({ candidate, runtime });
}
async function dropboxRefreshAccessToken(dropboxConfig, { signal = undefined } = {}) {
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
    signal,
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

async function uploadBytesToDropbox({ accessToken, path, body, contentType = "application/octet-stream", signal = undefined }) {
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
    signal,
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

function requireManifestHash(manifest, manifestKey) {
  try {
    return validateCanonicalHistoryV2Manifest(manifest).manifest_hash;
  } catch (error) {
    throw new Error(`Manifest validation failed for ${manifestKey}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireNonNegativeSafeInteger(value, fieldName, manifestKey) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Manifest ${fieldName} is invalid: ${manifestKey}`);
  }
  return parsed;
}

export function validateObservationPollutantManifestForGate({
  childManifest,
  childReference,
  childKey,
  requiresActiveValidation,
}) {
  const childHash = requireManifestHash(childManifest, childKey);
  if (
    String(childReference?.manifest_hash || "").trim().toLowerCase()
      !== childHash
  ) {
    throw new Error(`Connector child manifest hash mismatch: ${childKey}`);
  }
  const rowCount = requireNonNegativeSafeInteger(
    childManifest.source_row_count,
    "source_row_count",
    childKey,
  );
  const fileCount = requireNonNegativeSafeInteger(
    childManifest.file_count,
    "file_count",
    childKey,
  );
  const totalBytes = requireNonNegativeSafeInteger(
    childManifest.total_bytes,
    "total_bytes",
    childKey,
  );
  if (requiresActiveValidation) {
    validateObservationContentHashMetadata(childManifest, { rowCount });
  }
  return {
    child_hash: childHash,
    row_count: rowCount,
    file_count: fileCount,
    total_bytes: totalBytes,
  };
}

export async function verifyOpaqueObservationFileForGate({
  r2,
  fileKey,
  manifestIdentity,
  expectedBytes,
  getObject = r2GetObject,
  headObject = r2HeadObject,
}) {
  const identity = classifyManifestFileIdentity(manifestIdentity, {
    objectKey: fileKey,
  });
  const liveFile = identity.type === "etag"
    ? await headObject({ r2, key: fileKey })
    : await getObject({ r2, key: fileKey });
  if (liveFile?.exists === false) {
    throw new Error(`Opaque observation Parquet object is missing: ${fileKey}`);
  }
  return verifyManifestFileIdentity({
    manifestIdentity,
    expectedBytes,
    liveObject: liveFile,
    objectKey: fileKey,
  });
}

export async function verifyObservationConnectorHistory({
  runtime,
  dayUtc,
  connectorId,
  manifestKey,
  expectedRowCount = null,
  activePollutants = null,
}) {
  assertBudget(runtime, "observation_history_verification", {
    day_utc: dayUtc,
    connector_id: connectorId,
  }, PHASE_B_STAGE_MIN_MS.observation_index);
  const expectedConnectorKey = canonicalObservationConnectorManifestKey(dayUtc, connectorId);
  if (manifestKey !== expectedConnectorKey || runtime.committed_prefix !== HISTORY_R2_V2_OBSERVATIONS_PREFIX) {
    throw new Error(`Observation connector manifest is not the canonical v2 key: ${manifestKey}`);
  }

  const connectorObject = await r2GetObject({ r2: runtime.r2, key: manifestKey });
  const connectorManifest = JSON.parse(connectorObject.body.toString("utf8"));
  if (
    connectorManifest?.history_version !== "v2"
    || connectorManifest?.domain !== "observations"
    || connectorManifest?.manifest_kind !== "connector"
    || connectorManifest?.day_utc !== dayUtc
    || Number(connectorManifest?.connector_id) !== connectorId
    || connectorManifest?.manifest_key !== manifestKey
  ) {
    throw new Error(`Observation connector manifest identity mismatch: ${manifestKey}`);
  }
  const connectorManifestHash = requireManifestHash(connectorManifest, manifestKey);
  const childReferences = Array.isArray(connectorManifest.pollutant_manifests)
    ? connectorManifest.pollutant_manifests
    : connectorManifest.child_manifests;
  if (!Array.isArray(childReferences) || childReferences.length === 0) {
    throw new Error(`Observation connector manifest has no pollutant children: ${manifestKey}`);
  }

  const activePollutantSet = activePollutants === null
    ? null
    : new Set([...activePollutants].map((value) =>
      normalizePollutantCodeForPath(value)
    ));

  const seenPollutants = new Set();
  const verifiedChildren = [];
  for (const reference of childReferences) {
    assertBudget(runtime, "observation_history_verification", {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: reference?.pollutant_code || null,
    }, PHASE_B_STAGE_MIN_MS.observation_segment);
    const pollutantCode = normalizePollutantCodeForPath(reference?.pollutant_code);
    if (seenPollutants.has(pollutantCode)) {
      throw new Error(`Duplicate pollutant child in connector manifest: ${manifestKey}`);
    }
    seenPollutants.add(pollutantCode);
    const childKey = buildHistoryV2PollutantManifestKey(
      HISTORY_R2_V2_OBSERVATIONS_PREFIX,
      dayUtc,
      connectorId,
      pollutantCode,
    );
    if (reference?.manifest_key !== childKey) {
      throw new Error(`Non-canonical pollutant child key in connector manifest: ${manifestKey}`);
    }
    const childObject = await r2GetObject({ r2: runtime.r2, key: childKey });
    const childManifest = JSON.parse(childObject.body.toString("utf8"));
    if (
      childManifest?.history_version !== "v2"
      || childManifest?.domain !== "observations"
      || childManifest?.manifest_kind !== "pollutant"
      || childManifest?.day_utc !== dayUtc
      || Number(childManifest?.connector_id) !== connectorId
      || childManifest?.pollutant_code !== pollutantCode
      || childManifest?.manifest_key !== childKey
    ) {
      throw new Error(`Observation pollutant manifest identity mismatch: ${childKey}`);
    }
    const requiresActiveValidation = activePollutantSet === null
      || activePollutantSet.has(pollutantCode);
    const childValidation = validateObservationPollutantManifestForGate({
      childManifest,
      childReference: reference,
      childKey,
      requiresActiveValidation,
    });
    const childHash = childValidation.child_hash;
    const rowCount = childValidation.row_count;
    const fileCount = childValidation.file_count;
    const totalBytes = childValidation.total_bytes;
    const files = Array.isArray(childManifest.files) ? childManifest.files : [];
    if (files.length !== fileCount || files.length === 0) {
      throw new Error(`Observation pollutant manifest file_count mismatch: ${childKey}`);
    }
    let childRows = 0;
    let childBytes = 0;
    for (const file of files) {
      assertBudget(runtime, "observation_history_part_verification", {
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_code: pollutantCode,
        part_key: file?.key || null,
      }, PHASE_B_STAGE_MIN_MS.observation_segment);
      const fileKey = String(file?.key || "").trim();
      const expectedPrefix = childKey.slice(0, -"manifest.json".length);
      if (!fileKey.startsWith(expectedPrefix) || !fileKey.endsWith(".parquet")) {
        throw new Error(`Observation pollutant manifest has a non-canonical Parquet key: ${childKey}`);
      }
      const fileRows = requireNonNegativeSafeInteger(file?.row_count, "files.row_count", childKey);
      const fileBytes = requireNonNegativeSafeInteger(file?.bytes, "files.bytes", childKey);
      if (requiresActiveValidation) {
        const liveFile = await r2GetObject({ r2: runtime.r2, key: fileKey });
        verifyManifestFileIdentity({
          manifestIdentity: file?.etag_or_hash,
          expectedBytes: fileBytes,
          liveObject: liveFile,
          objectKey: fileKey,
        });
      } else {
        await verifyOpaqueObservationFileForGate({
          r2: runtime.r2,
          fileKey,
          manifestIdentity: file?.etag_or_hash,
          expectedBytes: fileBytes,
        });
      }
      childRows += fileRows;
      childBytes += fileBytes;
    }
    if (childRows !== rowCount || childBytes !== totalBytes) {
      throw new Error(`Observation pollutant manifest aggregate mismatch: ${childKey}`);
    }
    verifiedChildren.push({
      pollutant_code: pollutantCode,
      manifest_key: childKey,
      manifest_hash: childHash,
      source_row_count: rowCount,
      file_count: fileCount,
      total_bytes: totalBytes,
      validation_scope: requiresActiveValidation ? "active" : "opaque_preserved",
    });
  }

  const rowCount = requireNonNegativeSafeInteger(connectorManifest.source_row_count, "source_row_count", manifestKey);
  const fileCount = requireNonNegativeSafeInteger(connectorManifest.file_count, "file_count", manifestKey);
  const totalBytes = requireNonNegativeSafeInteger(connectorManifest.total_bytes, "total_bytes", manifestKey);
  if (
    verifiedChildren.reduce((sum, child) => sum + child.source_row_count, 0) !== rowCount
    || verifiedChildren.reduce((sum, child) => sum + child.file_count, 0) !== fileCount
    || verifiedChildren.reduce((sum, child) => sum + child.total_bytes, 0) !== totalBytes
  ) {
    throw new Error(`Observation connector manifest aggregate mismatch: ${manifestKey}`);
  }
  if (expectedRowCount !== null && BigInt(rowCount) !== BigInt(expectedRowCount)) {
    throw new Error(
      `Observation connector manifest source row count mismatch: expected=${String(expectedRowCount)} actual=${rowCount} key=${manifestKey}`,
    );
  }

  const indexSummary = await runBudgetedPhaseBStage({
    runtime,
    operation: "observation_index",
    fields: { day_utc: dayUtc, connector_id: connectorId },
    minMs: PHASE_B_STAGE_MIN_MS.observation_index,
    adapter: async () => await updateR2HistoryIndexesTargeted({
      env: {
        ...process.env,
        UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX: HISTORY_R2_V2_OBSERVATIONS_PREFIX,
      },
      r2: runtime.r2,
      historyVersion: "v2",
      domains: ["observations"],
      fromDayUtc: dayUtc,
      toDayUtc: dayUtc,
      connectorId,
      connectorManifestKey: manifestKey,
      updateLatestIndex: false,
      strictMissingTimeseriesCounts: true,
      writeR2: true,
    }),
  });
  const indexResult = indexSummary.observations_timeseries;
  if (
    !indexResult
    || indexResult.warning_count !== 0
    || indexResult.rewritten_connector_index_count !== 1
    || !Array.isArray(indexResult.affected_pollutant_indexes)
  ) {
    throw new Error(`Observation connector-targeted index update failed: ${manifestKey}`);
  }
  for (const child of verifiedChildren) {
    const indexKey = buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
      indexResult.timeseries_index_prefix,
      dayUtc,
      connectorId,
      child.pollutant_code,
    );
    const affected = indexResult.affected_pollutant_indexes.find((entry) => entry?.key === indexKey);
    const liveIndex = JSON.parse((await r2GetObject({ r2: runtime.r2, key: indexKey })).body.toString("utf8"));
    if (
      !affected
      || liveIndex?.history_version !== "v2"
      || liveIndex?.domain !== "observations"
      || liveIndex?.day_utc !== dayUtc
      || Number(liveIndex?.connector_id) !== connectorId
      || liveIndex?.pollutant_code !== child.pollutant_code
      || liveIndex?.pollutant_manifest_key !== child.manifest_key
      || liveIndex?.pollutant_manifest_hash !== child.manifest_hash
      || Number(liveIndex?.source_row_count) !== child.source_row_count
      || Number(liveIndex?.file_count) !== child.file_count
      || Number(liveIndex?.indexed_file_count) !== child.file_count
      || liveIndex?.index_coverage !== "complete"
      || !liveIndex?.timeseries_row_counts
    ) {
      throw new Error(`Observation connector-targeted index verification failed: ${indexKey}`);
    }
  }

  return {
    connector_manifest: connectorManifest,
    history_manifest_key: manifestKey,
    history_manifest_hash: connectorManifestHash,
    history_row_count: rowCount,
    history_file_count: fileCount,
    history_total_bytes: totalBytes,
    connector_index_count: verifiedChildren.length,
    active_pollutant_count: verifiedChildren.filter((child) =>
      child.validation_scope === "active"
    ).length,
    opaque_preserved_pollutant_count: verifiedChildren.filter((child) =>
      child.validation_scope === "opaque_preserved"
    ).length,
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

function buildPruneComparisonRowsQuery({ runtime, connectorId, dayStart, dayEnd }) {
  if (runtime.history_write_version === "v2") {
    return {
      sql: `
select
  connector_id,
  timeseries_id,
  observed_at_utc as observed_at,
  value,
  status
from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  $4::integer,
  $5::timestamptz
)
`,
      params: [connectorId, dayStart, dayEnd, null, null],
      comparison_filter_mode: "canonical_observed_properties",
      comparison_pollutant_codes: [],
      comparison_scope: "all_canonical_observations",
    };
  }

  return {
    sql: `
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
`,
    params: [connectorId, dayStart, dayEnd, null, null],
    comparison_filter_mode: "v1_all_observations",
    comparison_pollutant_codes: [],
    comparison_scope: "all_observations",
  };
}

export function buildPruneComparisonRowsQueryForTest(args) {
  return buildPruneComparisonRowsQuery(args);
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
  const comparisonQuery = buildPruneComparisonRowsQuery({ runtime, connectorId, dayStart, dayEnd });
  assertBudget(runtime, "dropbox_comparison", {
    day_utc: dayUtc,
    connector_id: connectorId,
  }, PHASE_B_STAGE_MIN_MS.dropbox_comparison);
  const externalTimeoutMs = Math.max(1, (remainingBudgetMs(runtime) ?? 600_000) - 1_000);
  const externalSignal = AbortSignal.timeout(externalTimeoutMs);

  logStructured("INFO", "phase_b_history_prune_check_dropbox_filter", {
    run_id: runtime.run_id,
    day_utc: dayUtc,
    connector_id: connectorId,
    comparison_filter_mode: comparisonQuery.comparison_filter_mode,
    comparison_scope: comparisonQuery.comparison_scope,
    comparison_pollutant_codes: comparisonQuery.comparison_pollutant_codes,
  });

  const accessToken = await dropboxRefreshAccessToken(runtime.dropbox, { signal: externalSignal });
  const committedParts = [];
  let observedRows = 0n;
  let totalBytes = 0n;
  let partIndex = 0;

  await withPgClient(runtime.supabase_db_url, async (streamClient) => {
    const cursor = streamClient.query(
      new Cursor(comparisonQuery.sql, comparisonQuery.params),
    );
    let pendingRows = [];

    const flushPart = async () => {
      if (!pendingRows.length) {
        return;
      }
      const rows = pendingRows;
      pendingRows = [];
      assertBudget(runtime, "dropbox_comparison_upload", {
        day_utc: dayUtc,
        connector_id: connectorId,
        part_index: partIndex,
      }, PHASE_B_STAGE_MIN_MS.dropbox_comparison);
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
        signal: externalSignal,
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
        assertBudget(runtime, "dropbox_comparison_fetch", {
          day_utc: dayUtc,
          connector_id: connectorId,
          part_index: partIndex,
        }, PHASE_B_STAGE_MIN_MS.observation_segment);
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
  }, { statementTimeoutMs: Math.max(1, externalTimeoutMs) });

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
    comparison_filter_mode: comparisonQuery.comparison_filter_mode,
    comparison_scope: comparisonQuery.comparison_scope,
    comparison_pollutant_codes: comparisonQuery.comparison_pollutant_codes,
    notes: "comparison only; committed R2 was not overwritten",
  };

  await uploadBytesToDropbox({
    accessToken,
    path: `${comparisonRoot}/prune_manifest.json`,
    body: Buffer.from(JSON.stringify(pruneManifest, null, 2), "utf8"),
    contentType: "application/json",
    signal: externalSignal,
  });
  await uploadBytesToDropbox({
    accessToken,
    path: `${comparisonRoot}/adopted_r2_manifest.json`,
    body: Buffer.from(JSON.stringify(adoptedManifest, null, 2), "utf8"),
    contentType: "application/json",
    signal: externalSignal,
  });
  await uploadBytesToDropbox({
    accessToken,
    path: `${comparisonRoot}/comparison_context.json`,
    body: Buffer.from(JSON.stringify(comparisonContext, null, 2), "utf8"),
    contentType: "application/json",
    signal: externalSignal,
  });

  logStructured("INFO", "phase_b_history_prune_check_dropbox_export_complete", {
    run_id: runtime.run_id,
    day_utc: dayUtc,
    connector_id: connectorId,
    comparison_output_root: comparisonRoot,
    prune_source_row_count: observedRows.toString(),
    adopted_source_row_count: adoptedRows.toString(),
    row_count_delta: rowCountDelta.toString(),
    comparison_filter_mode: comparisonQuery.comparison_filter_mode,
    comparison_scope: comparisonQuery.comparison_scope,
    comparison_pollutant_codes: comparisonQuery.comparison_pollutant_codes,
  });

  return {
    comparison_output_root: comparisonRoot,
    prune_source_row_count: observedRows,
    adopted_source_row_count: adoptedRows,
    row_count_delta: rowCountDelta,
  };
}

async function ensureConnectorPruneComparison({
  candidate,
  runtime,
  manifestKey,
  manifest,
  existingComparison = null,
  logStructured,
}) {
  if (!runtime.prune_check_dropbox?.enabled || existingComparison) {
    return existingComparison;
  }
  try {
    return await exportPruneComparisonToDropbox({
      candidate,
      runtime,
      adoptedManifestKey: manifestKey,
      adoptedManifest: manifest,
      logStructured,
    });
  } catch (error) {
    rethrowIfBudgetDeadlineReached(runtime, error, "dropbox_comparison", {
      day_utc: candidate.day_utc,
      connector_id: candidate.connector_id,
    });
    logPhaseB(runtime, "ERROR", "phase_b_history_dropbox_check_failed", {
      day_utc: candidate.day_utc,
      connector_id: candidate.connector_id,
      manifest_key: manifestKey,
      required: runtime.prune_check_dropbox?.required === true,
      ...errorLogFields(error),
    });
    if (runtime.prune_check_dropbox?.required) throw error;
    return null;
  }
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

async function exportAqilevelConnectorRowsToR2({ runtime, dayUtc, connector, rows: sourceRows }) {
  if (runtime.history_write_version !== "v2" || !Array.isArray(sourceRows)) {
    throw new Error("Phase B AQI connector output requires observation-derived rows and canonical v2 history");
  }
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
  const normalizedSourceRows = [...sourceRows].sort((left, right) => {
      const leftKey = `${left.timeseries_id || 0}|${left.timestamp_hour_utc || ""}`;
      const rightKey = `${right.timeseries_id || 0}|${right.timestamp_hour_utc || ""}`;
      return leftKey.localeCompare(rightKey);
    });

  const flushPart = async () => {
    if (!pendingRows.length) {
      return;
    }
    const partRows = pendingRows;
    pendingRows = [];

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
          assertBudget(runtime, "aqi_object_write", {
            day_utc: dayUtc,
            connector_id: connectorId,
            pollutant_code: pollutantCode,
            profile,
          }, PHASE_B_STAGE_MIN_MS.aqi_object_write);
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
  };

  for (const row of normalizedSourceRows) {
      if (!minTimestampHourUtc || row.timestamp_hour_utc < minTimestampHourUtc) {
        minTimestampHourUtc = row.timestamp_hour_utc;
      }
      if (!maxTimestampHourUtc || row.timestamp_hour_utc > maxTimestampHourUtc) {
        maxTimestampHourUtc = row.timestamp_hour_utc;
      }
      pendingRows.push({ ...row, connector_id: connectorId });
      if (pendingRows.length >= runtime.aqilevels_part_max_rows) {
        await flushPart();
      }
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
    const createAndUploadProfileConnectorManifest = async ({ prefix, profile, profileFileEntries }) => {
      const pollutantManifests = [];
      const partsByPollutant = new Map();
      for (const fileEntry of profileFileEntries) {
        const pollutantCode = normalizePollutantCodeForPath(fileEntry.pollutant_code);
        if (!partsByPollutant.has(pollutantCode)) partsByPollutant.set(pollutantCode, []);
        partsByPollutant.get(pollutantCode).push(fileEntry);
      }
      for (const [pollutantCode, pollutantParts] of Array.from(partsByPollutant.entries()).sort(([left], [right]) => left.localeCompare(right))) {
        assertBudget(runtime, "aqi_object_write", {
          day_utc: dayUtc,
          connector_id: connectorId,
          pollutant_code: pollutantCode,
          profile,
        }, PHASE_B_STAGE_MIN_MS.aqi_object_write);
        const pollutantManifestKey = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, pollutantCode);
        const pollutantManifest = buildHistoryV2PollutantManifest({
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
      return { key: profileConnectorManifestKey, manifest: buildHistoryV2ConnectorManifest({
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
  assertBudget(runtime, "aqi_object_write", {
    day_utc: dayUtc,
    connector_id: connectorId,
    profile: "connector_manifest",
  }, PHASE_B_STAGE_MIN_MS.aqi_object_write);
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

    assertBudget(runtime, "aqi_object_write", {
      day_utc: dayUtc,
      connector_id: connectorId,
      profile: "debug_connector_manifest",
    }, PHASE_B_STAGE_MIN_MS.aqi_object_write);
    await r2PutObject({ r2: runtime.r2, key: debugConnectorManifestKey, body: Buffer.from(JSON.stringify(debugConnectorManifest, null, 2), "utf8"), content_type: "application/json" });
    const debugManifestHead = await r2HeadObject({ r2: runtime.r2, key: debugConnectorManifestKey });
    if (!debugManifestHead.exists) {
      throw new Error(`AQI debug connector manifest missing after upload: ${debugConnectorManifestKey}`);
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

export function summarizeFrozenObservationSourceForAqi({ rows = [], dayUtc, maxRows = DEFAULT_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS } = {}) {
  const dayStart = Date.parse(`${dayUtc}T00:00:00.000Z`);
  const prevStart = dayStart - DAY_MS;
  const nextStart = dayStart + DAY_MS;
  const normalized = [];
  const pollutantCounts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (normalized.length >= maxRows) {
      return {
        ok: false,
        status: "snapshot_row_limit_reached",
        max_rows: maxRows,
        source_row_count: normalized.length,
        rows: normalized,
        pollutant_counts: pollutantCounts,
      };
    }
    const observedAt = observedAtForHistoryRow(row);
    const observedMs = Date.parse(String(observedAt || ""));
    if (!Number.isFinite(observedMs) || observedMs < prevStart || observedMs >= nextStart) continue;
    const pollutantCode = normalizePollutantCodeForPath(row.pollutant_code);
    pollutantCounts[pollutantCode] = (pollutantCounts[pollutantCode] || 0) + 1;
    const canonicalObservedAt = new Date(observedMs).toISOString();
    normalized.push({ ...row, pollutant_code: pollutantCode, observed_at: canonicalObservedAt, observed_at_utc: canonicalObservedAt });
  }
  normalized.sort((left, right) => {
    const leftKey = `${left.connector_id || 0}|${left.timeseries_id || 0}|${left.pollutant_code || ""}|${left.observed_at_utc || left.observed_at || ""}`;
    const rightKey = `${right.connector_id || 0}|${right.timeseries_id || 0}|${right.pollutant_code || ""}|${right.observed_at_utc || right.observed_at || ""}`;
    return leftKey.localeCompare(rightKey);
  });
  const supportedRowCount = normalized.filter((row) => AQI_SUPPORTED_POLLUTANTS.includes(row.pollutant_code)).length;
  const targetDaySupportedRowCount = normalized.filter((row) => AQI_SUPPORTED_POLLUTANTS.includes(row.pollutant_code) && isObservationRowInDay(row, dayUtc)).length;
  const aqiRows = targetDaySupportedRowCount > 0
    ? buildAqilevelHistoryRowsForDayFromSourceObservations(normalized, dayUtc)
    : [];
  if (targetDaySupportedRowCount > 0 && aqiRows.length === 0) {
    return {
      ok: false,
      status: "supported_target_day_source_zero_aqi_output",
      max_rows: maxRows,
      source_row_count: normalized.length,
      supported_source_row_count: supportedRowCount,
      target_day_supported_source_row_count: targetDaySupportedRowCount,
      rows: normalized,
      pollutant_counts: pollutantCounts,
    };
  }
  return {
    ok: true,
    status: targetDaySupportedRowCount > 0 ? "supported_aqi_source" : "no_supported_aqi_source",
    max_rows: maxRows,
    source_row_count: normalized.length,
    supported_source_row_count: supportedRowCount,
    target_day_supported_source_row_count: targetDaySupportedRowCount,
    context_supported_source_row_count: Math.max(supportedRowCount - targetDaySupportedRowCount, 0),
    rows: normalized,
    day_aqi_rows: aqiRows,
    day_aqi_row_count: aqiRows.length,
    pollutant_counts: pollutantCounts,
  };
}

async function writeAqilevelDayManifestFromConnectorOutputs({ runtime, dayUtc, changedConnectorIds = [] }) {
  if (runtime.history_write_version !== "v2" || !runtime.phase_b_calculate_aqi_from_observations_enabled) {
    throw new Error("Phase B AQI day finalisation requires the canonical observation-derived v2 writer");
  }
  const readConnectorManifests = async (prefix) => {
    const dayManifestKey = buildDayManifestKey(prefix, dayUtc);
    const profile = prefix === runtime.aqilevels_hourly_debug_prefix_v2 ? "debug" : "data";
    const currentRead = await readParentManifestForBoundedRecovery({
      getObject: r2GetObject,
      r2: runtime.r2,
      key: dayManifestKey,
      validate: (current) => {
        validateCanonicalHistoryV2Manifest(current, {
          history_version: "v2",
          domain: "aqilevels",
          grain: HISTORY_AQILEVELS_GRAIN,
          profile,
          manifest_kind: "day",
          day_utc: dayUtc,
          manifest_key: dayManifestKey,
        });
        const references = Array.isArray(current.connector_manifests)
          ? current.connector_manifests
          : Array.isArray(current.child_manifests) ? current.child_manifests : [];
        const manifestKeys = references.map((entry) => String(entry.manifest_key || "").trim());
        if (!manifestKeys.length || manifestKeys.some((key) => !/\/connector_id=\d+\/manifest\.json$/.test(key))) {
          throw new Error("current AQI day manifest has invalid connector references");
        }
        return manifestKeys;
      },
    });
    let manifestKeys = currentRead.state === "valid" ? currentRead.value : [];
    if (currentRead.state !== "valid") {
      const entries = await r2ListAllObjects({
        r2: runtime.r2,
        prefix: `${prefix}/day_utc=${dayUtc}/`,
        max_keys: 10_000,
      });
      manifestKeys = entries
        .map((entry) => String(entry.key || ""))
        .filter((key) => /\/connector_id=\d+\/manifest\.json$/.test(key));
    }
    manifestKeys = uniqueSorted([
      ...manifestKeys,
      ...changedConnectorIds.map((connectorId) => buildConnectorManifestKey(prefix, dayUtc, connectorId)),
    ]);
    const manifests = [];
    for (const key of manifestKeys) {
      const object = await r2GetObject({ r2: runtime.r2, key });
      manifests.push({ ...JSON.parse(object.body.toString("utf8")), manifest_key: key });
    }
    return manifests;
  };
  const dataConnectorManifests = await readConnectorManifests(runtime.aqilevels_prefix);
  const debugConnectorManifests = await readConnectorManifests(runtime.aqilevels_hourly_debug_prefix_v2);
  validateAqilevelDataDebugConnectorManifests({
    runtime,
    dayUtc,
    dataConnectorManifests,
    debugConnectorManifests,
  });
  const backedUpAtUtc = nowIso();
  const dataDayManifestKey = buildDayManifestKey(runtime.aqilevels_prefix, dayUtc);
  const debugDayManifestKey = buildDayManifestKey(runtime.aqilevels_hourly_debug_prefix_v2, dayUtc);
  const dataDayManifest = buildHistoryV2DayManifest({
    domain: "aqilevels",
    grain: HISTORY_AQILEVELS_GRAIN,
    profile: "data",
    dayUtc,
    runId: runtime.run_id,
    manifestKey: dataDayManifestKey,
    connectorManifests: dataConnectorManifests,
    writerGitSha: runtime.writer_git_sha,
    backedUpAtUtc,
  });
  const debugDayManifest = buildHistoryV2DayManifest({
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
  await r2PutObject({ r2: runtime.r2, key: dataDayManifestKey, body: Buffer.from(JSON.stringify(dataDayManifest, null, 2), "utf8"), content_type: "application/json" });
  await r2PutObject({ r2: runtime.r2, key: debugDayManifestKey, body: Buffer.from(JSON.stringify(debugDayManifest, null, 2), "utf8"), content_type: "application/json" });
  const dataHead = await r2HeadObject({ r2: runtime.r2, key: dataDayManifestKey });
  const debugHead = await r2HeadObject({ r2: runtime.r2, key: debugDayManifestKey });
  if (!dataHead.exists || !debugHead.exists) {
    throw new Error(`AQI day manifest verification failed for day=${dayUtc}`);
  }
  const indexBuild = await buildAqilevelDayIndexes({
    runtime,
    dayUtc,
    connectorManifests: dataConnectorManifests,
  });
  const indexVerification = await verifyAqilevelDayIndexes({
    runtime,
    dayUtc,
    connectorManifests: dataConnectorManifests,
    indexBuild,
  });
  return {
    required: true,
    data_day_manifest_key: dataDayManifestKey,
    debug_day_manifest_key: debugDayManifestKey,
    connector_manifest_count: dataConnectorManifests.length,
    index_build: indexBuild,
    index_verification: indexVerification,
  };
}

export function validateAqilevelDataDebugConnectorManifests({ runtime, dayUtc, dataConnectorManifests, debugConnectorManifests }) {
  const expectedByProfile = {
    data: runtime.aqilevels_prefix,
    debug: runtime.aqilevels_hourly_debug_prefix_v2,
  };
  const normalizeSet = (manifests, profile) => {
    const out = new Map();
    for (const manifest of manifests || []) {
      const connectorId = parseManifestPositiveInt(manifest?.connector_id, "connector_id", false);
      const expectedKey = connectorId ? buildConnectorManifestKey(expectedByProfile[profile], dayUtc, connectorId) : null;
      const failures = [];
      if (!connectorId) failures.push("connector_id");
      if (manifest?.day_utc !== dayUtc) failures.push("day_utc");
      if (manifest?.domain !== "aqilevels") failures.push("domain");
      if (manifest?.grain !== HISTORY_AQILEVELS_GRAIN) failures.push("grain");
      if (manifest?.profile !== profile) failures.push("profile");
      if (manifest?.manifest_key !== expectedKey) failures.push("manifest_key");
      if (failures.length) {
        throw new Error(`AQI ${profile} connector manifest identity mismatch for day=${dayUtc} connector=${connectorId || "unknown"} fields=${failures.join(",")}`);
      }
      if (out.has(connectorId)) throw new Error(`AQI ${profile} connector manifest duplicate for day=${dayUtc} connector=${connectorId}`);
      out.set(connectorId, manifest);
    }
    return out;
  };
  const dataByConnector = normalizeSet(dataConnectorManifests, "data");
  const debugByConnector = normalizeSet(debugConnectorManifests, "debug");
  const dataIds = Array.from(dataByConnector.keys()).sort((a, b) => a - b);
  const debugIds = Array.from(debugByConnector.keys()).sort((a, b) => a - b);
  if (dataIds.join(",") !== debugIds.join(",")) {
    throw new Error(`AQI data/debug connector-set mismatch for day=${dayUtc}: data=[${dataIds.join(",")}] debug=[${debugIds.join(",")}]`);
  }
  return { connector_ids: dataIds, connector_manifest_count: dataIds.length };
}

export function extractAqilevelIndexPollutantsFromConnectorManifest(manifest) {
  const candidates = [];
  if (Array.isArray(manifest?.pollutant_codes)) candidates.push(...manifest.pollutant_codes);
  const childLists = [manifest?.pollutant_manifests, manifest?.child_manifests];
  for (const list of childLists) {
    if (!Array.isArray(list)) continue;
    for (const child of list) candidates.push(child?.pollutant_code);
  }
  return uniqueSorted(
    candidates
      .map((code) => normalizeObservationPropertyCode(code))
      .filter((code) => AQI_SUPPORTED_POLLUTANTS.includes(code)),
  );
}

export function requiredAqilevelDayIndexKeysForTest({ runtime, dayUtc, connectorManifests }) {
  return requiredAqilevelDayIndexTargets({ runtime, dayUtc, connectorManifests }).map((target) => target.index_key);
}

export function requiredAqilevelDayIndexTargets({ runtime, dayUtc, connectorManifests }) {
  const targets = new Map();
  for (const manifest of connectorManifests || []) {
    const connectorId = parseManifestPositiveInt(manifest?.connector_id, "connector_id", false);
    if (!connectorId) continue;
    const childLists = [manifest?.pollutant_manifests, manifest?.child_manifests];
    const manifestKeyByPollutant = new Map();
    for (const list of childLists) {
      if (!Array.isArray(list)) continue;
      for (const child of list) {
        const pollutant = normalizeObservationPropertyCode(child?.pollutant_code);
        if (pollutant && typeof child?.manifest_key === "string") {
          manifestKeyByPollutant.set(pollutant, child.manifest_key.trim());
        }
      }
    }
    for (const pollutant of extractAqilevelIndexPollutantsFromConnectorManifest(manifest)) {
      const indexKey = buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey(
        runtime.aqilevels_timeseries_index_prefix,
        dayUtc,
        connectorId,
        pollutant,
      );
      targets.set(`${connectorId}:${pollutant}`, {
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_code: pollutant,
        pollutant_manifest_key: manifestKeyByPollutant.get(pollutant) || `${runtime.aqilevels_prefix}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutant}/manifest.json`,
        index_key: indexKey,
      });
    }
  }
  return Array.from(targets.values()).sort((a, b) => a.index_key.localeCompare(b.index_key));
}

function buildAqilevelIndexEnv(runtime) {
  return {
    R2_ENDPOINT: runtime.r2?.endpoint,
    R2_BUCKET: runtime.r2?.bucket,
    R2_ACCESS_KEY_ID: runtime.r2?.access_key_id,
    R2_SECRET_ACCESS_KEY: runtime.r2?.secret_access_key,
    R2_REGION: runtime.r2?.region || "auto",
    UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX: runtime.aqilevels_prefix,
    UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX: runtime.aqilevels_timeseries_index_prefix,
    UK_AQ_R2_HISTORY_INDEX_V2_PREFIX: runtime.index_prefix_v2 || "history/_index_v2",
    UK_AQ_R2_HISTORY_STRICT_MISSING_TIMESERIES_COUNTS: "true",
  };
}

export async function buildAqilevelDayIndexes({ runtime, dayUtc, connectorManifests }) {
  const requiredTargets = requiredAqilevelDayIndexTargets({ runtime, dayUtc, connectorManifests });
  if (requiredTargets.length === 0 && (!Array.isArray(connectorManifests) || connectorManifests.length === 0 || !hasRequiredR2Config(runtime.r2))) {
    return { required: false, reason: "no_supported_aqi_source" };
  }
  assertBudget(runtime, "aqi_index", { day_utc: dayUtc }, PHASE_B_STAGE_MIN_MS.aqi_index);
  const summary = await updateR2HistoryIndexesTargeted({
    env: buildAqilevelIndexEnv(runtime),
    r2: runtime.r2,
    domains: ["aqilevels"],
    historyVersion: "v2",
    fromDayUtc: dayUtc,
    toDayUtc: dayUtc,
    connectorId: null,
    updateLatestIndex: false,
    strictMissingTimeseriesCounts: true,
    fetchConcurrency: 1,
    writeR2: true,
  });
  const aqilevelsResult = Array.isArray(summary?.results)
    ? summary.results.find((entry) => entry?.history_version === "v2" && entry?.domain === "aqilevels")
    : null;
  const affectedKeys = new Set(
    (Array.isArray(aqilevelsResult?.affected_pollutant_indexes) ? aqilevelsResult.affected_pollutant_indexes : [])
      .map((entry) => entry?.key)
      .filter(Boolean),
  );
  const omitted = requiredTargets.filter((target) => !affectedKeys.has(target.index_key));
  const warnings = [
    ...(Array.isArray(aqilevelsResult?.warnings) ? aqilevelsResult.warnings : []),
  ];
  if (warnings.length || omitted.length) {
    throw new Error(`AQI targeted index update failed for day=${dayUtc}; warnings=${warnings.length}; omitted_required_indexes=${omitted.map((entry) => entry.index_key).join(", ")}`);
  }
  if (requiredTargets.length === 0) return { required: false, reason: "no_supported_aqi_source", summary };
  return { required: true, required_index_manifest_count: requiredTargets.length, summary };
}

export async function verifyAqilevelDayIndexes({ runtime, dayUtc, connectorManifests, indexBuild = null }) {
  const requiredTargets = requiredAqilevelDayIndexTargets({ runtime, dayUtc, connectorManifests });
  if (requiredTargets.length === 0) {
    return { required: false, reason: "no_supported_aqi_source" };
  }
  assertBudget(runtime, "aqi_index_verify", { day_utc: dayUtc }, PHASE_B_STAGE_MIN_MS.aqi_index);
  const buildResult = Array.isArray(indexBuild?.summary?.results)
    ? indexBuild.summary.results.find((entry) => entry?.history_version === "v2" && entry?.domain === "aqilevels")
    : null;
  const buildWarnings = [
    ...(Array.isArray(buildResult?.warnings) ? buildResult.warnings : []),
  ];
  if (buildWarnings.length) {
    throw new Error(`AQI index verification failed for day=${dayUtc}; targeted update reported warnings: ${buildWarnings.join("; ")}`);
  }
  const buildKeys = new Set(
    (Array.isArray(buildResult?.affected_pollutant_indexes) ? buildResult.affected_pollutant_indexes : [])
      .map((entry) => entry?.key)
      .filter(Boolean),
  );
  const failures = [];
  for (const target of requiredTargets) {
    assertBudget(runtime, "aqi_index_verify", {
      day_utc: dayUtc,
      connector_id: target.connector_id,
      pollutant_code: target.pollutant_code,
    }, PHASE_B_STAGE_MIN_MS.aqi_index);
    if (buildResult && !buildKeys.has(target.index_key)) {
      failures.push(`${target.index_key}: not reported by current targeted build`);
      continue;
    }
    let pollutantManifest;
    let indexPayload;
    try {
      pollutantManifest = JSON.parse((await r2GetObject({ r2: runtime.r2, key: target.pollutant_manifest_key })).body.toString("utf8"));
      indexPayload = JSON.parse((await r2GetObject({ r2: runtime.r2, key: target.index_key })).body.toString("utf8"));
    } catch (error) {
      failures.push(`${target.index_key}: ${(error instanceof Error ? error.message : String(error))}`);
      continue;
    }
    const expectedHash = typeof pollutantManifest?.manifest_hash === "string" ? pollutantManifest.manifest_hash.trim() : null;
    const actualHash = typeof indexPayload?.pollutant_manifest_hash === "string" ? indexPayload.pollutant_manifest_hash.trim() : null;
    const manifestFiles = Array.isArray(pollutantManifest?.files) ? pollutantManifest.files : [];
    const expectedRowCount = Number(
      pollutantManifest?.source_row_count
      ?? pollutantManifest?.row_count
      ?? manifestFiles.reduce((sum, file) => sum + (Number(file?.row_count) || 0), 0),
    );
    const checks = [
      indexPayload?.history_version === "v2",
      indexPayload?.domain === "aqilevels",
      indexPayload?.grain === HISTORY_AQILEVELS_GRAIN,
      indexPayload?.profile === "data",
      indexPayload?.day_utc === dayUtc,
      Number(indexPayload?.connector_id) === target.connector_id,
      indexPayload?.pollutant_code === target.pollutant_code,
      indexPayload?.pollutant_manifest_key === target.pollutant_manifest_key || indexPayload?.connector_pollutant_manifest_key === target.pollutant_manifest_key,
      expectedHash && actualHash === expectedHash,
      Number(indexPayload?.source_row_count) === expectedRowCount,
      Number(indexPayload?.file_count) === manifestFiles.length,
      Number(indexPayload?.indexed_file_count) === Number(indexPayload?.file_count),
      indexPayload?.index_coverage === "complete",
      indexPayload?.timeseries_row_counts && typeof indexPayload.timeseries_row_counts === "object" && Object.keys(indexPayload.timeseries_row_counts).length > 0,
    ];
    if (checks.some((ok) => !ok)) {
      failures.push(`${target.index_key}: current-source identity or coverage mismatch`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`AQI index verification failed for day=${dayUtc}; ${failures.slice(0, 5).join("; ")}`);
  }
  return { required: true, verified_index_manifest_count: requiredTargets.length, verified_index_manifest_keys: requiredTargets.map((target) => target.index_key) };
}

export const extractAqilevelIndexPollutantsFromConnectorManifestForTest = extractAqilevelIndexPollutantsFromConnectorManifest;
export const buildAqilevelDayIndexesForTest = buildAqilevelDayIndexes;
export const verifyAqilevelDayIndexesForTest = verifyAqilevelDayIndexes;

export function summarizeVerifiedMergedDayManifestForGate({ manifest, manifestKey, dayUtc }) {
  if (!manifest || manifest.history_version !== "v2" || manifest.domain !== "observations"
    || manifest.manifest_kind !== "day" || manifest.day_utc !== dayUtc
    || manifest.manifest_key !== manifestKey) {
    throw new Error(`Verified day manifest identity mismatch: ${manifestKey}`);
  }
  requireManifestHash(manifest, manifestKey);
  const connectorReferences = Array.isArray(manifest.connector_manifests)
    ? manifest.connector_manifests
    : [];
  if (connectorReferences.length === 0) {
    throw new Error(`Verified day manifest has no connector evidence: ${manifestKey}`);
  }
  const rowCount = requireNonNegativeSafeInteger(manifest.source_row_count, "source_row_count", manifestKey);
  const fileCount = requireNonNegativeSafeInteger(manifest.file_count, "file_count", manifestKey);
  const totalBytes = requireNonNegativeSafeInteger(manifest.total_bytes, "total_bytes", manifestKey);
  const childTotals = connectorReferences.reduce((totals, child) => ({
    rows: totals.rows + requireNonNegativeSafeInteger(child?.source_row_count, "connector source_row_count", manifestKey),
    files: totals.files + requireNonNegativeSafeInteger(child?.file_count, "connector file_count", manifestKey),
    bytes: totals.bytes + requireNonNegativeSafeInteger(child?.total_bytes, "connector total_bytes", manifestKey),
  }), { rows: 0, files: 0, bytes: 0 });
  if (rowCount !== childTotals.rows || fileCount !== childTotals.files || totalBytes !== childTotals.bytes) {
    throw new Error(`Verified day manifest aggregate totals do not match merged connector evidence: ${manifestKey}`);
  }
  if ((rowCount === 0 && (fileCount !== 0 || totalBytes !== 0))
    || (rowCount > 0 && (fileCount === 0 || totalBytes === 0))) {
    throw new Error(`Verified day manifest aggregate totals are internally inconsistent: ${manifestKey}`);
  }
  return {
    history_manifest_hash: manifest.manifest_hash,
    history_row_count: BigInt(rowCount),
    history_file_count: fileCount,
    history_total_bytes: BigInt(totalBytes),
  };
}

async function finalizeDayGateIfReadyUnlocked({ client, runtime, dayUtc }) {
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

  assertBudget(runtime, "day_finalization", { day_utc: dayUtc }, PHASE_B_STAGE_MIN_MS.day_finalization);

  const dayManifestKey = buildHistoryV2DayManifestKey(runtime.committed_prefix, dayUtc);
  const dayPrefix = `${runtime.committed_prefix}/day_utc=${dayUtc}/`;
  const currentRead = await readParentManifestForBoundedRecovery({
    getObject: r2GetObject,
    r2: runtime.r2,
    key: dayManifestKey,
    validate: (current) => {
      validateCanonicalHistoryV2Manifest(current, {
        history_version: "v2",
        domain: "observations",
        manifest_kind: "day",
        day_utc: dayUtc,
        manifest_key: dayManifestKey,
      });
      const currentReferences = Array.isArray(current.connector_manifests)
        ? current.connector_manifests
        : Array.isArray(current.child_manifests) ? current.child_manifests : [];
      const references = currentReferences.map((entry) => ({
        connector_id: Number(entry.connector_id),
        manifest_key: String(entry.manifest_key || ""),
      }));
      if (references.some((entry) =>
        !Number.isInteger(entry.connector_id) || entry.connector_id <= 0 ||
        !entry.manifest_key.startsWith(dayPrefix) ||
        !entry.manifest_key.endsWith(`/connector_id=${entry.connector_id}/manifest.json`)
      )) {
        throw new Error(`Current day manifest has invalid connector references: ${dayManifestKey}`);
      }
      return references;
    },
  });
  let existingReferences = currentRead.state === "valid" ? currentRead.value : [];
  if (currentRead.state !== "valid") {
    const discovered = await r2ListAllObjects({
      r2: runtime.r2,
      prefix: dayPrefix,
      max_keys: 10_000,
    });
    existingReferences = discovered.flatMap((entry) => {
      const key = String(entry.key || "");
      const match = key.match(/\/connector_id=([1-9]\d*)\/manifest\.json$/);
      return match ? [{ connector_id: Number(match[1]), manifest_key: key }] : [];
    });
  }
  const replacementReferences = dayCandidates.map((candidate) => ({
    connector_id: candidate.connector_id,
    manifest_key: candidate.manifest_key,
  }));
  const mergedReferences = mergeConnectorManifestReferences(existingReferences, replacementReferences);
  const connectorManifests = [];
  for (const reference of mergedReferences) {
    assertBudget(runtime, "day_finalization", {
      day_utc: dayUtc,
      connector_id: reference.connector_id,
    }, PHASE_B_STAGE_MIN_MS.day_finalization);
    if (!reference.manifest_key) {
      throw new Error(`Missing connector manifest_key for day=${dayUtc} connector=${reference.connector_id}`);
    }
    const object = await r2GetObject({ r2: runtime.r2, key: reference.manifest_key });
    const parsed = JSON.parse(object.body.toString("utf8"));
    validateCanonicalHistoryV2Manifest(parsed, {
      history_version: "v2",
      domain: "observations",
      manifest_kind: "connector",
      day_utc: dayUtc,
      connector_id: reference.connector_id,
      manifest_key: reference.manifest_key,
    });
    connectorManifests.push({
      ...parsed,
      manifest_key: reference.manifest_key,
    });
  }

  const backedUpAtUtc = nowIso();
  const dayManifest = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc,
    runId: runtime.run_id,
    manifestKey: dayManifestKey,
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

  const verifiedDayManifest = JSON.parse(
    (await r2GetObject({ r2: runtime.r2, key: dayManifestKey })).body.toString("utf8"),
  );
  const verifiedDayTotals = summarizeVerifiedMergedDayManifestForGate({
    manifest: verifiedDayManifest,
    manifestKey: dayManifestKey,
    dayUtc,
  });

  const aqiDayManifest = await writeAqilevelDayManifestFromConnectorOutputs({
    runtime,
    dayUtc,
    changedConnectorIds: dayCandidates.map((candidate) => candidate.connector_id),
  });

  const totalRows = verifiedDayTotals.history_row_count;
  const totalFiles = verifiedDayTotals.history_file_count;
  const totalBytes = verifiedDayTotals.history_total_bytes;

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
    aqi_day_manifest: aqiDayManifest,
  };
}

async function finalizeDayGateIfReady({ client, runtime, dayUtc }) {
  return await runCanonicalDayFinalizer({
    client,
    dayUtc,
    diagnosticEnvironment: runtime.environment,
    timeoutMs: Math.min(15_000, Math.max(1, remainingBudgetMs(runtime) ?? 15_000)),
    finalize: async () => await finalizeDayGateIfReadyUnlocked({ client, runtime, dayUtc }),
  });
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

  const allowedPollutantCodes = [];
  const observsSource = {
    base_url: String(env.OBS_AQIDB_SUPABASE_URL || "").trim(),
    privileged_key: String(env.OBS_AQIDB_SECRET_KEY || "").trim(),
    rpc_schema: String(env.UK_AQ_PUBLIC_SCHEMA || DEFAULT_RPC_SCHEMA).trim() || DEFAULT_RPC_SCHEMA,
    pm_context_rpc: String(env.UK_AQ_PHASE_B_PM_CONTEXT_RPC || DEFAULT_PHASE_B_PM_CONTEXT_RPC).trim(),
  };

  return {
    enabled: String(env.UK_AQ_R2_HISTORY_PHASE_B_ENABLED || "true").trim().toLowerCase() !== "false",
    supabase_db_url: String(env.SUPABASE_DB_URL || "").trim(),
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
    phase_b_calculate_aqi_from_observations_enabled: true,
    phase_b_observation_snapshot_max_rows: parsePositiveInt(
      env.UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS,
      DEFAULT_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS,
      1,
      1_000_000,
    ),
    phase_b_observation_snapshot_max_bytes: parsePositiveInt(
      env.UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_BYTES,
      DEFAULT_PHASE_B_OBSERVATION_SNAPSHOT_MAX_BYTES,
      1024 * 1024,
      2 * 1024 * 1024 * 1024,
    ),
    sos_connector_id: parsePositiveInt(
      env.UK_AQ_PHASE_B_SOS_CONNECTOR_ID ||
        env.UK_AQ_BACKFILL_SOS_CONNECTOR_ID_FALLBACK,
      DEFAULT_PHASE_B_SOS_CONNECTOR_ID,
      1,
      2_147_483_647,
    ),
    observs_retention_days: parsePositiveInt(
      env.OBS_AQIDB_OBSERVS_RETENTION_DAYS,
      DEFAULT_OBSAQIDB_OBSERVS_RETENTION_DAYS,
      1,
      3650,
    ),
    pm_context_page_size: parsePositiveInt(
      env.UK_AQ_PHASE_B_PM_CONTEXT_PAGE_SIZE,
      DEFAULT_PHASE_B_PM_CONTEXT_PAGE_SIZE,
      1,
      5_000,
    ),
    pm_context_max_pages: parsePositiveInt(
      env.UK_AQ_PHASE_B_PM_CONTEXT_MAX_PAGES,
      DEFAULT_PHASE_B_PM_CONTEXT_MAX_PAGES,
      1,
      1_000,
    ),
    pm_context_max_rows: parsePositiveInt(
      env.UK_AQ_PHASE_B_PM_CONTEXT_MAX_ROWS,
      DEFAULT_PHASE_B_PM_CONTEXT_MAX_ROWS,
      1,
      250_000,
    ),
    max_candidates_per_run: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN,
      DEFAULT_MAX_CANDIDATES_PER_RUN,
      1,
      50_000,
    ),
    max_seconds_per_run: parsePositiveInt(
      env.UK_AQ_PRUNE_DAILY_PHASE_B_MAX_SECONDS_PER_RUN,
      DEFAULT_MAX_SECONDS_PER_RUN,
      30,
      86_400,
    ),
    stop_before_timeout_seconds: parsePositiveInt(
      env.UK_AQ_PRUNE_DAILY_PHASE_B_STOP_BEFORE_TIMEOUT_SECONDS,
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
    aqilevels_prefix: aqilevelsPrefix,
    history_write_version: historyWriteVersion,
    committed_prefix_v2: committedPrefixV2,
    aqilevels_hourly_data_prefix_v2: aqilevelsDataPrefixV2,
    aqilevels_hourly_debug_prefix_v2: aqilevelsDebugPrefixV2,
    aqilevels_timeseries_index_prefix: normalizePrefix(env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX || "history/_index_v2/aqilevels_hourly_data_timeseries"),
    runs_prefix: runsPrefix,
    runs_prefix_v2: writePrefixes.runs_prefix_v2,
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
    observs_source: observsSource,
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
  nowMs = Date.now,
  createPgClient = (config) => new Client(config),
}) {
  const runtime = {
    ...phaseB,
    run_id: runId,
    now_utc: nowUtc,
    staging_prefix: `${phaseB.staging_prefix_base}/run_id=${runId}`,
    logStructured,
    run_budget: createPhaseBRunBudgetForTest({
      nowMs,
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
    throw new Error("Phase B history export requires SUPABASE_DB_URL for streaming Postgres extraction and deletion safety.");
  }
  if (runtime.history_write_version !== "v2") {
    throw new Error("Phase B history writes require canonical R2 history version v2");
  }
  if (!hasRequiredR2Config(runtime.r2)) {
    throw new Error("Phase B history export requires R2 endpoint/bucket/region/access credentials.");
  }

  const window = dayWindowFromNow(nowUtc, ingestRetentionDays);
  const summary = {
    enabled: true,
    status: "completed",
    stopped_for_budget: false,
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
    failed_candidates: 0,
    source_changed_connector_gate_invalidated_count: 0,
    source_changed_connector_gate_invalidated_preview: [],
    source_identity_invalidated_connector_days: 0,
    total_written_rows: "0",
    total_written_bytes: "0",
    completed_days: 0,
    blocked_days: 0,
    failures: [],
    completed_preview: [],
    blocked_preview: [],
    aggregate_day_failures: [],
    prune_check_dropbox_exports: 0,
    prune_check_dropbox_failures: 0,
    pm_context: {
      source: "obs_aqidb",
      candidates: 0,
      complete_candidates: 0,
      rows_fetched: 0,
      rows_accepted: 0,
      rows_discarded: 0,
      page_count: 0,
    },
    aqilevels: null,
  };

  logStructured("INFO", "phase_b_history_run_start", {
    run_id: runId,
    dry_run: dryRun,
    now_utc: window.now_utc,
    ingest_retention_days: window.ingest_retention_days,
    phase_b_eligible_age_days: window.phase_b_eligible_age_days,
    latest_eligible_day_utc: window.latest_eligible_day_utc,
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
    observations_prefix_v2: runtime.committed_prefix_v2,
    cursor_fetch_rows: runtime.cursor_fetch_rows,
    row_group_size: runtime.row_group_size,
    observations_row_group_size: runtime.observations_row_group_size,
    observations_pollutant_codes: runtime.observations_pollutant_codes,
    aqilevels_row_group_size: runtime.aqilevels_row_group_size,
    r2_bucket: runtime.r2.bucket,
    observations_prefix: runtime.committed_prefix,
    aqilevels_prefix: runtime.aqilevels_prefix,
    aqilevels_hourly_data_prefix_v2: runtime.aqilevels_hourly_data_prefix_v2,
    aqilevels_hourly_debug_prefix_v2: runtime.aqilevels_hourly_debug_prefix_v2,
    runs_prefix: runtime.runs_prefix,
    runs_prefix_v2: runtime.runs_prefix_v2,
  });

  const dayResults = new Map();
  let totalWrittenRows = 0n;
  let totalWrittenBytes = 0n;

  const controlPgTimeouts = derivePhaseBPgTimeoutsForTest(runtime);
  try {
    await withPgClient(runtime.supabase_db_url, async (controlClient) => {
    if (!hasBudgetFor(runtime, PHASE_B_STAGE_MIN_MS.candidate_start)) {
      stopPhaseBForBudget(summary, runtime, { operation: "candidate_discovery" });
      return;
    }
    const upsertedCandidates = await populateBackupCandidates(
      controlClient,
      window.latest_eligible_window_end_utc,
      runtime,
    );
    summary.populated_candidates = upsertedCandidates.length;
    const sourceChangedInvalidations = upsertedCandidates
      .filter((candidate) => candidate.source_changed_connector_gate_invalidated === true)
      .map((candidate) => candidate.source_change_invalidation);
    summary.source_changed_connector_gate_invalidated_count = sourceChangedInvalidations.length;
    summary.source_changed_connector_gate_invalidated_preview = sourceChangedInvalidations.slice(0, 10);
    summary.source_identity_invalidated_connector_days = upsertedCandidates
      .reduce((count, candidate) => count + Number(candidate.source_identity_invalidated_connector_days || 0), 0);
    logStructured("INFO", "phase_b_history_source_changed_connector_gate_invalidation_summary", {
      run_id: runId,
      source_changed_connector_gate_invalidated_count: sourceChangedInvalidations.length,
      source_changed_connector_gate_invalidated_preview: sourceChangedInvalidations.slice(0, 10),
      source_identity_invalidated_connector_days: summary.source_identity_invalidated_connector_days,
    });
    if (upsertedCandidates.length > 0) {
      logStructured("INFO", "phase_b_history_candidate_eligibility_summary", {
        run_id: runId,
        history_write_version: runtime.history_write_version,
        eligible_pollutant_codes: runtime.observations_pollutant_codes,
        candidate_count: upsertedCandidates.length,
        source_row_count: upsertedCandidates
          .reduce((sum, row) => sum + row.source_row_count, 0n)
          .toString(),
        eligible_for_history_count: upsertedCandidates
          .reduce((sum, row) => sum + row.expected_row_count, 0n)
          .toString(),
        excluded_row_count: upsertedCandidates
          .reduce((sum, row) => sum + row.excluded_row_count, 0n)
          .toString(),
        candidates_preview: upsertedCandidates.slice(0, 25).map((row) => ({
          day_utc: row.day_utc,
          connector_id: row.connector_id,
          source_row_count: row.source_row_count.toString(),
          eligible_for_history_count: row.expected_row_count.toString(),
          excluded_row_count: row.excluded_row_count.toString(),
          excluded_pollutant_counts: row.excluded_pollutant_counts,
        })),
      });
    }

    if (!hasBudgetFor(runtime, PHASE_B_STAGE_MIN_MS.candidate_start)) {
      stopPhaseBForBudget(summary, runtime, { operation: "active_scope_gate_preparation" });
      return;
    }
    await markActiveIncompleteDaysAsBackupBlocked(controlClient, upsertedCandidates);

    const pendingCandidates = await fetchPendingCandidates(
      controlClient,
      upsertedCandidates,
      runtime.max_candidates_per_run,
    );
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
      if (!hasBudgetFor(runtime, PHASE_B_STAGE_MIN_MS.candidate_start)) {
        logPhaseB(runtime, "WARNING", "phase_b_history_budget_exhausted", {
          operation: "candidate_start",
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          candidate_index: candidateIndex,
          candidate_count: pendingCandidates.length,
        });
        stopPhaseBForBudget(summary, runtime, { operation: "candidate_start", candidate });
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
      let connectorGateCompleted = false;
      let frozenSourceTemp = null;
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
        let connectorGateEvidence = null;
        let connectorComparison = null;
        const lockDiagnostics = [];
        const connectorWrite = await runCanonicalConnectorDayWriter({
          client: controlClient,
          dayUtc: candidate.day_utc,
          connectorId: candidate.connector_id,
          diagnosticEnvironment: runtime.environment,
          diagnostics: lockDiagnostics,
          timeoutMs: Math.min(15_000, Math.max(1, remainingBudgetMs(runtime) ?? 15_000)),
          write: async () => {
            await setConnectorDayGateIncomplete(controlClient, {
              day_utc: candidate.day_utc,
              connector_id: candidate.connector_id,
            });
            const result = await exportCandidateToR2({ candidate, runtime });
            result.adopted = false;
            frozenSourceTemp = result.frozen_source_temp || null;
            return result;
          },
          verify: async (result) => {
            connectorGateEvidence = await verifyObservationConnectorHistory({
              runtime,
              dayUtc: candidate.day_utc,
              connectorId: candidate.connector_id,
              manifestKey: result.manifest_key,
              expectedRowCount: candidate.expected_row_count,
            });
            connectorComparison = await ensureConnectorPruneComparison({
              candidate,
              runtime,
              manifestKey: connectorGateEvidence.history_manifest_key,
              manifest: connectorGateEvidence.connector_manifest,
              existingComparison: null,
              logStructured,
            });
            return { connectorGateEvidence, connectorComparison };
          },
        });
        const exportResult = connectorWrite.written;
        logPhaseB(runtime, "INFO", "phase_b_history_connector_lock_complete", {
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          lock_diagnostics: lockDiagnostics,
        });
        await markCandidateAndConnectorGateComplete(controlClient, {
          dayUtc: candidate.day_utc,
          connectorId: candidate.connector_id,
          runId,
          manifestKey: connectorGateEvidence.history_manifest_key,
          manifestHash: connectorGateEvidence.history_manifest_hash,
          historyRowCount: connectorGateEvidence.history_row_count,
          historyFileCount: connectorGateEvidence.history_file_count,
          historyTotalBytes: connectorGateEvidence.history_total_bytes,
          sourceIdentity: exportResult.source_identity,
        });
        connectorGateCompleted = true;
        exportResult.written_row_count = BigInt(connectorGateEvidence.history_row_count);
        exportResult.file_count = connectorGateEvidence.history_file_count;
        exportResult.total_bytes = BigInt(connectorGateEvidence.history_total_bytes);

        try {
            exportResult.aqi = await withConnectorDayHistoryLock({
              client: controlClient,
              dayUtc: candidate.day_utc,
              connectorId: candidate.connector_id,
              diagnosticEnvironment: runtime.environment,
              timeoutMs: Math.min(15_000, Math.max(1, remainingBudgetMs(runtime) ?? 15_000)),
            }, async () => await exportCandidateAqiFromFrozenSource({
              candidate,
              runtime,
              observationResult: exportResult,
            }));
        } catch (aqiError) {
            exportResult.aqi = {
              status: "failed",
              error: aqiError instanceof Error ? aqiError.message : String(aqiError),
            };
            summary.aggregate_day_failures.push({
              day_utc: candidate.day_utc,
              connector_id: candidate.connector_id,
              domain: "aqilevels",
              error: exportResult.aqi.error,
            });
            logPhaseB(runtime, "ERROR", "phase_b_history_aqi_failed_gate_preserved", {
              day_utc: candidate.day_utc,
              connector_id: candidate.connector_id,
              connector_gate_preserved: true,
              error: exportResult.aqi.error,
            });
        } finally {
            cleanupPhaseBTargetDaySourceTemp(frozenSourceTemp);
            frozenSourceTemp = null;
        }

        summary.completed_candidates += 1;
        totalWrittenRows += exportResult.written_row_count;
        totalWrittenBytes += exportResult.total_bytes;
        if (connectorComparison) {
          summary.prune_check_dropbox_exports += 1;
        } else if (runtime.prune_check_dropbox?.enabled) {
          summary.prune_check_dropbox_failures += 1;
        }
        if (exportResult.aqi?.pm_context_source === "obs_aqidb") {
          summary.pm_context.candidates += 1;
          summary.pm_context.complete_candidates += exportResult.aqi.pm_context_complete ? 1 : 0;
          summary.pm_context.rows_fetched += Number(exportResult.aqi.pm_context_rows_fetched || 0);
          summary.pm_context.rows_accepted += Number(exportResult.aqi.pm_context_rows_accepted || 0);
          summary.pm_context.rows_discarded += Number(exportResult.aqi.pm_context_rows_discarded || 0);
          summary.pm_context.page_count += Number(exportResult.aqi.pm_context_page_count || 0);
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
          source_identity_contract_version: exportResult.source_identity.source_content_hash_contract_version,
          source_identity_match: true,
          source_identity_failure_reason: null,
          source_identity_rows: exportResult.source_identity.source_content_hash_row_count,
          candidate_source_identity_present: true,
          gate_source_identity_present: true,
          source_content_hash: exportResult.source_identity.source_content_hash,
          source_owner: exportResult.adopted ? "adopted_existing_r2_manifest" : "phase_b_export",
          comparison_output_root: connectorComparison?.comparison_output_root || null,
          pm_context: exportResult.aqi ? {
            pm_context_source: exportResult.aqi.pm_context_source || null,
            pm_context_window_start_utc: exportResult.aqi.pm_context_window_start_utc || null,
            pm_context_window_end_utc: exportResult.aqi.pm_context_window_end_utc || null,
            pm_context_requested_connector_id: exportResult.aqi.pm_context_requested_connector_id ?? null,
            pm_context_target_timeseries_count: exportResult.aqi.pm_context_target_timeseries_count ?? 0,
            pm_context_rows_fetched: exportResult.aqi.pm_context_rows_fetched ?? 0,
            pm_context_rows_accepted: exportResult.aqi.pm_context_rows_accepted ?? 0,
            pm_context_rows_discarded: exportResult.aqi.pm_context_rows_discarded ?? 0,
            pm_context_page_count: exportResult.aqi.pm_context_page_count ?? 0,
            pm_context_complete: exportResult.aqi.pm_context_complete === true,
            target_day_supported_aqi_source_row_count: exportResult.aqi.target_day_supported_aqi_source_row_count ?? 0,
            context_supported_aqi_hour_count: exportResult.aqi.context_supported_aqi_hour_count ?? 0,
            daqi_status_counts: exportResult.aqi.daqi_status_counts ?? {},
            eaqi_status_counts: exportResult.aqi.eaqi_status_counts ?? {},
          } : null,
          duration_ms: durationMs,
        });
      } catch (error) {
        cleanupPhaseBTargetDaySourceTemp(frozenSourceTemp);
        frozenSourceTemp = null;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof PhaseBHistoryBudgetExhaustedError) {
          if (!connectorGateCompleted) {
            try {
              await cleanupCandidatePartialOutput({
                runtime,
                dayUtc: candidate.day_utc,
                connectorId: candidate.connector_id,
              });
            } catch (cleanupError) {
              logPhaseB(runtime, "ERROR", "phase_b_history_partial_cleanup_failed", {
                day_utc: candidate.day_utc,
                connector_id: candidate.connector_id,
                ...errorLogFields(cleanupError),
              });
            }
            await markCandidateStoppedForBudget(controlClient, {
              dayUtc: candidate.day_utc,
              connectorId: candidate.connector_id,
              runId,
              errorText: message,
              clearCheckpoint: true,
            });
          }
          await updateDayGateBlocked(controlClient, candidate.day_utc);
          dayResults.set(candidate.day_utc, {
            day_utc: candidate.day_utc,
            history_done: false,
            pending_connectors: connectorGateCompleted ? 0 : 1,
            reason: "phase_b_history_budget_exhausted",
          });
          stopPhaseBForBudget(summary, runtime, {
            operation: error.operation || "candidate_work",
            candidate,
          });
          logPhaseB(runtime, "WARNING", "phase_b_history_stopped_budget", {
            operation: summary.budget_stop.operation,
            day_utc: candidate.day_utc,
            connector_id: candidate.connector_id,
            connector_gate_preserved: connectorGateCompleted,
          });
          break;
        }
        if (connectorGateCompleted) {
          await updateDayGateBlocked(controlClient, candidate.day_utc);
          dayResults.set(candidate.day_utc, {
            day_utc: candidate.day_utc,
            history_done: false,
            pending_connectors: 0,
            reason: "aggregate_day_finalization_failed",
          });
          summary.aggregate_day_failures.push({
            day_utc: candidate.day_utc,
            connector_id: candidate.connector_id,
            error: message,
          });
          logStructured("ERROR", "phase_b_history_aggregate_day_finalization_failed", {
            run_id: runId,
            day_utc: candidate.day_utc,
            connector_id: candidate.connector_id,
            error: message,
            connector_gate_preserved: true,
            aggregate_day_gate_complete: false,
            next_action: "targeted_aqi_history_repair",
          });
          continue;
        }
        try {
          if (!connectorGateCompleted) {
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
        if (!connectorGateCompleted) {
          await markCandidateFailed(controlClient, {
            dayUtc: candidate.day_utc,
            connectorId: candidate.connector_id,
            runId,
            errorText: message,
          });
        }
        const dayState = await finalizeDayGateIfReady({
          client: controlClient,
          runtime,
          dayUtc: candidate.day_utc,
        });
        dayResults.set(candidate.day_utc, dayState);
        summary.failed_candidates += 1;
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
          pm_context: error?.pm_context_diagnostics || null,
          ...errorLogFields(error),
          ...budgetSnapshot(runtime),
          next_action: "retry_safe",
          prune_blocked_for_day: true,
        });
      }
    }

    const finalizedDays = Array.from(dayResults.values())
      .filter((state) => state.history_done === true)
      .map((state) => state.day_utc)
      .sort();
    if (finalizedDays.length > 0 && summary.status !== "stopped_budget") {
      summary.global_index_finalization = await runCanonicalGlobalIndexFinalizer({
        client: controlClient,
        diagnosticEnvironment: runtime.environment,
        timeoutMs: Math.min(15_000, Math.max(1, remainingBudgetMs(runtime) ?? 15_000)),
        finalize: async () => await updateR2HistoryIndexesTargeted({
        env: {
          ...process.env,
          UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX: runtime.committed_prefix,
          UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX: runtime.aqilevels_prefix,
          UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX: runtime.aqilevels_timeseries_index_prefix,
          UK_AQ_R2_HISTORY_INDEX_V2_PREFIX: runtime.index_prefix_v2,
        },
        r2: runtime.r2,
        historyVersion: "v2",
        domains: ["observations", "aqilevels"],
        affectedDaysUtc: finalizedDays,
        connectorId: null,
        updateLatestIndex: true,
        strictMissingTimeseriesCounts: true,
        writeR2: true,
        }),
      });
    }
    }, {
      statementTimeoutMs: controlPgTimeouts.statement_timeout_ms,
      connectionTimeoutMs: controlPgTimeouts.connection_timeout_ms,
      createClient: createPgClient,
    });
  } catch (error) {
    if (
      (error instanceof PhaseBHistoryBudgetExhaustedError)
      || (isPgStatementTimeoutError(error) && !hasBudgetFor(runtime, 2_000))
    ) {
      stopPhaseBForBudget(summary, runtime, {
        operation: error.operation || "control_database_statement",
      });
      logPhaseB(runtime, "WARNING", "phase_b_history_control_database_stopped_budget", {
        operation: summary.budget_stop.operation,
        postgres_error_code: error?.code || null,
        postgres_statement_timeout_ms: controlPgTimeouts.statement_timeout_ms,
        postgres_connection_timeout_ms: controlPgTimeouts.connection_timeout_ms,
      });
    } else {
      throw error;
    }
  }

  if (summary.status === "stopped_budget") {
    summary.aqilevels = { skipped: true, reason: "phase_b_history_budget_exhausted" };
  } else if (runtime.phase_b_calculate_aqi_from_observations_enabled) {
    summary.aqilevels = {
      enabled: true,
      source_mode: "frozen_observations_per_candidate",
      status: "completed_with_phase_b_candidates",
      snapshot_max_rows: runtime.phase_b_observation_snapshot_max_rows,
      snapshot_max_bytes: runtime.phase_b_observation_snapshot_max_bytes,
    };
  } else {
    summary.aqilevels = { skipped: true, reason: "phase_b_history_not_completed" };
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
  summary.aggregate_day_failures = summary.aggregate_day_failures.slice(0, 25);
  summary.failures = summary.failures.slice(0, 25);

  const cleanupSummary = summary.status === "stopped_budget"
    ? { skipped: true, reason: "reserved_for_final_reporting" }
    : await cleanupStaging({ runtime, logStructured });
  summary.staging_cleanup = cleanupSummary;

  if (summary.status === "stopped_budget") {
    summary.run_manifest_key = null;
    summary.run_manifest = { skipped: true, reason: "reserved_for_final_reporting" };
  } else {
    summary.run_manifest_key = await writeRunManifest({ runtime, runSummary: summary });
  }

  if (runtime.prune_check_dropbox?.enabled) {
    logStructured("INFO", "phase_b_history_prune_check_summary", {
      run_id: runId,
      dropbox_exports: summary.prune_check_dropbox_exports,
      dropbox_failures: summary.prune_check_dropbox_failures,
      required: runtime.prune_check_dropbox?.required === true,
    });
  }

  logStructured("INFO", "phase_b_history_run_summary", summary);
  return summary;
}

export async function fetchBackupDoneConnectorDays({ supabaseDbUrl, connectorDays }) {
  if (!Array.isArray(connectorDays) || connectorDays.length === 0) {
    return new Map();
  }

  const distinctPairs = new Map();
  for (const entry of connectorDays) {
    const dayUtc = String(entry?.day_utc || "").slice(0, 10);
    const connectorId = Number(entry?.connector_id);
    try {
      distinctPairs.set(connectorDayGateKey(dayUtc, connectorId), {
        day_utc: dayUtc,
        connector_id: connectorId,
      });
    } catch (_error) {
      // Invalid bucket identities cannot acquire deletion authority.
    }
  }
  if (distinctPairs.size === 0) {
    return new Map();
  }

  return await withPgClient(supabaseDbUrl, async (client) => {
    const sql = `
with requested as (
  select
    r.day_utc::date as day_utc,
    r.connector_id::integer as connector_id
  from jsonb_to_recordset($1::jsonb) as r(day_utc text, connector_id integer)
)
select
  g.day_utc::text as day_utc,
  g.connector_id,
  g.history_done,
  g.history_manifest_key,
  g.history_manifest_hash,
  g.history_row_count,
  g.history_file_count,
  g.history_total_bytes,
  g.history_completed_at,
  g.source_content_hash,
  g.source_content_hash_contract_version,
  g.source_content_hash_row_count,
  g.completion_source
from uk_aq_ops.prune_connector_day_gates g
join requested r
  on r.day_utc = g.day_utc
 and r.connector_id = g.connector_id
`;
    const result = await client.query(sql, [JSON.stringify(Array.from(distinctPairs.values()))]);
    const map = new Map();
    for (const row of result.rows) {
      if (isValidConnectorHistoryGateEvidence(row)) {
        map.set(connectorDayGateKey(row.day_utc, row.connector_id), true);
      }
    }
    return map;
  });
}
