import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  coalesceAqiMissingHourWindows,
  mergeAqiRowsPreferR2,
  mergeObservationRowsPreferR2,
  buildAqilevelHistoryRowsForDayFromSourceObservations,
  summarizeAqiCalculationStatuses,
} from "../../lib/aqi/aqi_levels.mjs";
import {
  parseR2HistoryVersion,
  resolveR2HistoryVersion,
} from "../shared/uk_aq_r2_history_version.mjs";

const DEFAULT_HISTORY_PREFIX = "history/v1/aqilevels/hourly";
const DEFAULT_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX = "history/v2/aqilevels/hourly/data";
const DEFAULT_HISTORY_BANDS_PREFIX = "history/v1/aqilevels/hourly/bands/v1";
const DEFAULT_HISTORY_INDEX_PREFIX = "history/_index";
const DEFAULT_HISTORY_V2_INDEX_PREFIX = "history/_index_v2";
const DEFAULT_TIMESERIES_INDEX_SUBPREFIX = "aqilevels_timeseries";
const DEFAULT_V2_TIMESERIES_INDEX_SUBPREFIX = "aqilevels_hourly_data_timeseries";
const DEFAULT_V2_TIMESERIES_METADATA_INDEX_SUBPREFIX = "timeseries";
const DEFAULT_CACHE_SECONDS = 300;
const DEFAULT_IMMUTABLE_CACHE_SECONDS = 86400;
const MAX_CACHE_SECONDS = 604800;
const MAX_LIMIT = 20000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_INGESTDB_RETENTION_DAYS = 5;
const MAX_INGESTDB_RETENTION_DAYS = 3650;
const DEFAULT_OBSAQIDB_RECENT_OVERLAP_DAYS = 1;
const DEFAULT_OBSAQIDB_TIMEOUT_MS = 10000;
const MIN_OBSAQIDB_TIMEOUT_MS = 2000;
const MAX_OBSAQIDB_TIMEOUT_MS = 30000;
const DEFAULT_PARQUET_ROW_CHUNK_SIZE = 5000;
const MIN_PARQUET_ROW_CHUNK_SIZE = 500;
const MAX_PARQUET_ROW_CHUNK_SIZE = 50000;
const DEFAULT_MAX_PARQUET_FILES_PER_REQUEST = 200;
const MIN_MAX_PARQUET_FILES_PER_REQUEST = 10;
const MAX_MAX_PARQUET_FILES_PER_REQUEST = 5000;
const DEFAULT_MAX_R2_OBJECT_READS_PER_REQUEST = 80;
const MIN_MAX_R2_OBJECT_READS_PER_REQUEST = 10;
const MAX_MAX_R2_OBJECT_READS_PER_REQUEST = 5000;
const DEFAULT_MAX_PARQUET_ROW_GROUPS_PER_REQUEST = 300;
const MIN_MAX_PARQUET_ROW_GROUPS_PER_REQUEST = 10;
const MAX_MAX_PARQUET_ROW_GROUPS_PER_REQUEST = 10000;
const DEFAULT_MAX_PARQUET_CHUNKS_PER_REQUEST = 600;
const MIN_MAX_PARQUET_CHUNKS_PER_REQUEST = 10;
const MAX_MAX_PARQUET_CHUNKS_PER_REQUEST = 50000;
const DEFAULT_MAX_SCAN_ELAPSED_MS = 18000;
const MIN_MAX_SCAN_ELAPSED_MS = 1000;
const MAX_MAX_SCAN_ELAPSED_MS = 120000;
const UK_AQ_PUBLIC_SCHEMA_DEFAULT = "uk_aq_public";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AQI_MUTABLE_HOURS = 120;
const MIN_AQI_MUTABLE_HOURS = 1;
const MAX_AQI_MUTABLE_HOURS = 24 * 30;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const VALID_PATHS = new Set(["/", "/v1/aqi-history"]);
const TIMESERIES_AQI_HOURLY_VIEW = "uk_aq_timeseries_aqi_hourly";
const AQI_PARQUET_COLUMNS = [
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
];
const AQI_RESPONSE_COLUMNS = [
  "period_start_utc",
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "daqi_index_level",
  "eaqi_index_level",
  "daqi_input_value_ugm3",
  "daqi_input_averaging_code",
  "eaqi_input_value_ugm3",
  "eaqi_input_averaging_code",
  "daqi_calculation_status",
  "eaqi_calculation_status",
  "source",
  "source_coverage",
];
const AQI_HISTORY_RESPONSE_CACHE_VERSION = "2";
const DEFAULT_AQI_INTERNAL_RESPONSE_CACHE_ENABLED = true;
const DEFAULT_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED = false;
const AQI_RESPONSE_FORMATS = new Set(["json", "objects", "compact", "tsv"]);
const timeseriesWindowContextCache = new Map();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-uk-aq-upstream-auth",
  };
}

function normalizePrefix(raw) {
  return String(raw || "").trim().replace(/^\/+|\/+$/g, "");
}

function normalizeBaseUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function parsePositiveInt(raw, fallback, min = 1, max = 100000) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const value = Math.trunc(num);
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseOptionalPositiveInt(raw, min = 1, max = 100000) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return null;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return null;
  }
  const value = Math.trunc(num);
  if (value < min || value > max) {
    return null;
  }
  return value;
}

function parseOptionalBoolean(raw, fallback) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no" || value === "off") {
    return false;
  }
  return fallback;
}

function parseReadVersion(raw) {
  return parseR2HistoryVersion(raw, { varName: "readVersion" });
}

function createScanMetrics({
  requestId = null,
  maxR2ObjectReads,
  maxParquetRowGroups,
  maxParquetChunks,
} = {}) {
  return {
    request_id: requestId,
    r2_object_reads: 0,
    r2_list_operations: 0,
    r2_object_read_keys_by_kind: {
      day_manifest: 0,
      timeseries_index: 0,
      connector_manifest: 0,
      parquet_file: 0,
      other: 0,
    },
    parquet_row_groups_scanned: 0,
    parquet_chunks_scanned: 0,
    parquet_filter_rows_decoded: 0,
    parquet_payload_rows_decoded: 0,
    parquet_matched_rows: 0,
    parquet_bytes_read: 0,
    max_r2_object_reads: maxR2ObjectReads,
    max_r2_list_operations: 0,
    max_parquet_row_groups: maxParquetRowGroups,
    max_parquet_chunks: maxParquetChunks,
    stopped_early: false,
    stopped_reason: null,
  };
}

function stopScan(metrics, reason) {
  if (metrics && !metrics.stopped_reason) {
    metrics.stopped_early = true;
    metrics.stopped_reason = reason;
  }
  return reason;
}

function canReadR2Object(metrics, kind = "other") {
  if (!metrics) {
    return true;
  }
  if (metrics.r2_object_reads >= metrics.max_r2_object_reads) {
    stopScan(metrics, `max_r2_object_reads_budget_exceeded:${metrics.max_r2_object_reads}`);
    return false;
  }
  metrics.r2_object_reads += 1;
  const normalizedKind = Object.prototype.hasOwnProperty.call(
    metrics.r2_object_read_keys_by_kind,
    kind,
  )
    ? kind
    : "other";
  metrics.r2_object_read_keys_by_kind[normalizedKind] += 1;
  return true;
}

function canScanParquetRowGroup(metrics) {
  if (!metrics) {
    return true;
  }
  if (metrics.parquet_row_groups_scanned >= metrics.max_parquet_row_groups) {
    stopScan(metrics, `max_parquet_row_groups_budget_exceeded:${metrics.max_parquet_row_groups}`);
    return false;
  }
  metrics.parquet_row_groups_scanned += 1;
  return true;
}

function canScanParquetChunk(metrics) {
  if (!metrics) {
    return true;
  }
  if (metrics.parquet_chunks_scanned >= metrics.max_parquet_chunks) {
    stopScan(metrics, `max_parquet_chunks_budget_exceeded:${metrics.max_parquet_chunks}`);
    return false;
  }
  metrics.parquet_chunks_scanned += 1;
  return true;
}

function parseRequiredPositiveInt(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return null;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return null;
  }
  const value = Math.trunc(num);
  return value > 0 ? value : null;
}

function toIsoOrNull(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function normalizeAqiPollutant(raw) {
  const compact = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!compact) {
    return null;
  }
  if (compact === "pm25" || compact === "particulatematter25") {
    return "pm25";
  }
  if (compact === "pm10" || compact === "particulatematter10") {
    return "pm10";
  }
  if (compact === "no2" || compact === "nitrogendioxide") {
    return "no2";
  }
  return null;
}

function toNullableText(raw) {
  const text = String(raw ?? "").trim();
  return text.length > 0 ? text : null;
}

function toNullableFiniteNumber(raw) {
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeAqiStatus(raw) {
  const text = toNullableText(raw);
  return text ? text.toLowerCase() : null;
}

function cacheControlHeader(cacheSeconds) {
  return `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`;
}

function resolveAqiMutableHours(env = {}) {
  return parsePositiveInt(
    env.UK_AQ_AQI_MUTABLE_HOURS,
    DEFAULT_AQI_MUTABLE_HOURS,
    MIN_AQI_MUTABLE_HOURS,
    MAX_AQI_MUTABLE_HOURS,
  );
}

function resolveCachePolicy(env, endIso) {
  const mutableCacheSeconds = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_CACHE_MAX_AGE_SECONDS,
    DEFAULT_CACHE_SECONDS,
    30,
    MAX_CACHE_SECONDS,
  );
  const immutableCacheSeconds = Math.max(
    mutableCacheSeconds,
    parsePositiveInt(
      env.UK_AQ_AQI_HISTORY_R2_IMMUTABLE_CACHE_MAX_AGE_SECONDS,
      DEFAULT_IMMUTABLE_CACHE_SECONDS,
      30,
      MAX_CACHE_SECONDS,
    ),
  );
  const mutableHours = resolveAqiMutableHours(env);
  const endMs = Date.parse(endIso);
  const immutable = Number.isFinite(endMs) && endMs <= (Date.now() - mutableHours * HOUR_MS);
  return {
    cacheSeconds: immutable ? immutableCacheSeconds : mutableCacheSeconds,
    cacheScope: immutable ? "immutable" : "recent",
    mutableHours,
  };
}

function jsonResponse(payload, {
  status = 200,
  cacheSeconds = DEFAULT_CACHE_SECONDS,
  extraHeaders = {},
} = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControlHeader(cacheSeconds),
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function buildTsvResponseBody(columns, rows) {
  const safeColumns = Array.isArray(columns) ? columns : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const serialize = (value) => {
    if (value === null || value === undefined) {
      return "";
    }
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : "";
    }
    const text = String(value);
    return text.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  };
  const lines = [safeColumns.join("\t")];
  for (const row of safeRows) {
    if (Array.isArray(row)) {
      lines.push(row.map((value) => serialize(value)).join("\t"));
      continue;
    }
    if (row && typeof row === "object") {
      lines.push(safeColumns.map((column) => serialize(row[column])).join("\t"));
    }
  }
  return `${lines.join("\n")}\n`;
}

function isInternalResponseCacheEnabled(env = {}) {
  return parseOptionalBoolean(
    env.UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED,
    DEFAULT_AQI_INTERNAL_RESPONSE_CACHE_ENABLED,
  );
}

function forceDirectAuthenticatedNoStore(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-UK-AQ-Internal-Response-Cache", "disabled");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildAqiHistoryResponseCacheKey(request, env = {}) {
  const url = new URL(request.url);
  url.searchParams.set("__ukaq_aqi_history_response_v", AQI_HISTORY_RESPONSE_CACHE_VERSION);
  url.searchParams.set(
    "__ukaq_aqi_history_read_v",
    resolveR2HistoryVersion(env, { context: "R2 AQI history API reads" }),
  );
  return new Request(url.toString(), { method: "GET" });
}

function withCacheMarker(response, marker) {
  const headers = new Headers(response.headers);
  headers.set("x-ukaq-cache", marker);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorized(request, env) {
  const expected = String(env.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!expected) {
    return { ok: false, status: 500, error: "Missing UK_AQ_EDGE_UPSTREAM_SECRET." };
  }
  const supplied = String(request.headers.get(UPSTREAM_AUTH_HEADER) || "").trim();
  if (!supplied || !timingSafeEqual(supplied, expected)) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }
  return { ok: true };
}

function toUtcDayFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseIsoDay(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return toUtcDayFromMs(ms);
}

function utcMidnightMs(isoDay) {
  return Date.parse(`${isoDay}T00:00:00.000Z`);
}

function addUtcDays(isoDay, deltaDays) {
  return toUtcDayFromMs(utcMidnightMs(isoDay) + deltaDays * DAY_MS);
}

function makeWindow(startMs, endMs) {
  if (
    !Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || endMs <= startMs
  ) {
    return null;
  }
  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

function windowStartIso(window) {
  return window ? window.startIso : null;
}

function windowEndIso(window) {
  return window ? window.endIso : null;
}

function listUtcDays(startIso, endIso) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }
  const out = [];
  let day = toUtcDayFromMs(startMs);
  while (utcMidnightMs(day) < endMs) {
    out.push(day);
    day = addUtcDays(day, 1);
  }
  return out;
}

function buildDayManifestKey(prefix, dayUtc) {
  return `${prefix}/day_utc=${dayUtc}/manifest.json`;
}

function buildConnectorManifestKey(prefix, dayUtc, connectorId) {
  return `${prefix}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
}

function buildTimeseriesConnectorIndexKey(indexPrefix, dayUtc, connectorId) {
  return `${indexPrefix}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
}

function buildTimeseriesPollutantIndexKey(indexPrefix, dayUtc, connectorId, pollutantKey) {
  const normalizedPollutant = normalizeAqiPollutant(pollutantKey);
  if (!normalizedPollutant) {
    return null;
  }
  return `${indexPrefix}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${normalizedPollutant}/manifest.json`;
}

function findConnectorManifestKey(dayManifest, connectorId, fallbackKey) {
  if (!dayManifest || typeof dayManifest !== "object") {
    return fallbackKey;
  }
  const manifests = Array.isArray(dayManifest.connector_manifests)
    ? dayManifest.connector_manifests
    : [];
  for (const entry of manifests) {
    const entryConnectorId = Number(entry?.connector_id);
    if (!Number.isFinite(entryConnectorId) || entryConnectorId !== connectorId) {
      continue;
    }
    const entryKey = String(entry?.manifest_key || "").trim();
    if (entryKey) {
      return entryKey;
    }
  }
  return fallbackKey;
}

async function fetchJsonObjectFromR2(env, key, metrics = null, kind = "other") {
  if (!canReadR2Object(metrics, kind)) {
    return { exists: false, value: null, budget_exceeded: true };
  }
  const object = await env.UK_AQ_HISTORY_BUCKET.get(key);
  if (!object) {
    return { exists: false, value: null };
  }
  const text = await object.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_error) {
    throw new Error(`Invalid JSON object at ${key}`);
  }
  return { exists: true, value: parsed };
}

function normalizeAqiResponseFormat(rawFormat) {
  const compact = String(rawFormat || "").trim().toLowerCase();
  if (compact === "tsv") {
    return "tsv";
  }
  if (compact === "objects") {
    return "objects";
  }
  if (compact === "compact" || compact === "json" || compact === "") {
    return "compact";
  }
  return "compact";
}

function buildAqiBandCacheKey({
  bandsPrefix,
  dayUtc,
  connectorId,
  timeseriesIds,
  pollutantKey,
}) {
  const normalizedPrefix = normalizePrefix(bandsPrefix || DEFAULT_HISTORY_BANDS_PREFIX);
  const normalizedDay = parseIsoDay(dayUtc);
  const normalizedConnectorId = parseRequiredPositiveInt(connectorId);
  const normalizedTimeseriesIds = Array.isArray(timeseriesIds)
    ? timeseriesIds
      .map((value) => parseRequiredPositiveInt(value))
      .filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const normalizedTimeseriesPart = normalizedTimeseriesIds.length > 0
    ? Array.from(new Set(normalizedTimeseriesIds)).sort((left, right) => left - right).join("_")
    : null;
  const normalizedPollutant = normalizeAqiPollutant(pollutantKey) || "all";
  if (!normalizedPrefix || !normalizedDay || !normalizedConnectorId || !normalizedTimeseriesPart) {
    return null;
  }
  return `${normalizedPrefix}/day_utc=${normalizedDay}/connector_id=${normalizedConnectorId}/timeseries_ids=${normalizedTimeseriesPart}/pollutant=${normalizedPollutant}.json`;
}

function getAqiHistoryResponseColumns() {
  return AQI_RESPONSE_COLUMNS.slice();
}

function projectAqiHistoryResponseRow(row) {
  const out = {};
  for (const columnName of AQI_RESPONSE_COLUMNS) {
    out[columnName] = row?.[columnName] ?? null;
  }
  return out;
}

function toAqiHistoryCompactRow(row) {
  return AQI_RESPONSE_COLUMNS.map((columnName) => row?.[columnName] ?? null);
}

function buildAqiHistoryCompactRows(rows) {
  return Array.isArray(rows) ? rows.map((row) => toAqiHistoryCompactRow(row)) : [];
}

function summarizeAqiHistoryRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const initCounts = () => Object.create(null);
  const increment = (counts, key) => {
    const normalizedKey = key === null || key === undefined || key === ""
      ? "null"
      : String(key);
    counts[normalizedKey] = (counts[normalizedKey] || 0) + 1;
  };
  const summary = {
    parsed_point_count: safeRows.length,
    daqi_count: 0,
    eaqi_count: 0,
    null_daqi_count: 0,
    null_eaqi_count: 0,
    source_counts: initCounts(),
    source_coverage_counts: initCounts(),
    pollutant_counts: initCounts(),
    daqi_status_counts: initCounts(),
    eaqi_status_counts: initCounts(),
    daqi_missing_reason_counts: initCounts(),
    eaqi_missing_reason_counts: initCounts(),
  };

  for (const row of safeRows) {
    if (row?.daqi_index_level !== null && row?.daqi_index_level !== undefined) {
      summary.daqi_count += 1;
    } else {
      summary.null_daqi_count += 1;
    }
    if (row?.eaqi_index_level !== null && row?.eaqi_index_level !== undefined) {
      summary.eaqi_count += 1;
    } else {
      summary.null_eaqi_count += 1;
    }
    increment(summary.source_counts, row?.source);
    increment(summary.source_coverage_counts, row?.source_coverage);
    increment(summary.pollutant_counts, row?.pollutant_code);
    increment(summary.daqi_status_counts, normalizeAqiStatus(row?.daqi_calculation_status));
    increment(summary.eaqi_status_counts, normalizeAqiStatus(row?.eaqi_calculation_status));
    increment(summary.daqi_missing_reason_counts, toNullableText(row?.daqi_missing_reason));
    increment(summary.eaqi_missing_reason_counts, toNullableText(row?.eaqi_missing_reason));
  }

  return summary;
}

async function fetchFilteredParquetRowsFromR2(
  env,
  key,
  rowChunkSize,
  targetTimeseriesIds = null,
  payloadColumns = AQI_PARQUET_COLUMNS,
  metrics = null,
) {
  if (!canReadR2Object(metrics, "parquet_file")) {
    return { exists: false, rows: [], budget_exceeded: true };
  }
  const object = await env.UK_AQ_HISTORY_BUCKET.get(key);
  if (!object) {
    return { exists: false, rows: [] };
  }
  const normalizedTimeseriesIds = Array.isArray(targetTimeseriesIds)
    ? Array.from(
      new Set(
        targetTimeseriesIds
          .map((value) => parseRequiredPositiveInt(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    )
    : [];
  const hasTimeseriesFilter = normalizedTimeseriesIds.length > 0;
  const targetTimeseriesSet = hasTimeseriesFilter ? new Set(normalizedTimeseriesIds) : null;
  if (!hasTimeseriesFilter) {
    return { exists: true, rows: [] };
  }

  const arrayBuffer = await object.arrayBuffer();
  if (metrics) {
    metrics.parquet_bytes_read += arrayBuffer.byteLength;
  }
  const metadata = await parquetMetadataAsync(arrayBuffer, { compressors });
  const schemaColumns = parquetSchema(metadata).children.map((column) =>
    column.element.name
  );
  const timeseriesStatsIndex = schemaColumns.indexOf("timeseries_id");
  if (timeseriesStatsIndex < 0) {
    return { exists: true, rows: [] };
  }

  const requestedPayloadColumns = Array.isArray(payloadColumns) && payloadColumns.length > 0
    ? payloadColumns
    : AQI_PARQUET_COLUMNS;
  const availableColumns = requestedPayloadColumns.filter((columnName) =>
    schemaColumns.includes(columnName)
  );
  const filterColumns = Array.from(
    new Set(
      [
        hasTimeseriesFilter ? "timeseries_id" : null,
      ].filter(Boolean),
    ),
  );
  const filterColumnIndexByName = new Map(
    filterColumns.map((columnName, idx) => [columnName, idx])
  );
  const payloadColumnIndexByName = new Map(
    availableColumns.map((columnName, idx) => [columnName, idx])
  );

  const outRows = [];
  let rowGroupStart = 0;
  for (const rowGroup of metadata.row_groups ?? []) {
    if (!canScanParquetRowGroup(metrics)) {
      break;
    }
    const rowGroupRows = Number(rowGroup?.num_rows ?? 0);
    const rowGroupEnd = rowGroupStart + rowGroupRows;
    if (!Number.isFinite(rowGroupRows) || rowGroupRows <= 0) {
      rowGroupStart = rowGroupEnd;
      continue;
    }

    if (hasTimeseriesFilter) {
      const tsStats = rowGroup?.columns?.[timeseriesStatsIndex]?.meta_data?.statistics;
      const minTimeseries = Number(tsStats?.min_value ?? tsStats?.min);
      const maxTimeseries = Number(tsStats?.max_value ?? tsStats?.max);
      if (Number.isFinite(minTimeseries) && Number.isFinite(maxTimeseries)) {
        let intersects = false;
        for (const targetTimeseriesId of normalizedTimeseriesIds) {
          if (targetTimeseriesId >= minTimeseries && targetTimeseriesId <= maxTimeseries) {
            intersects = true;
            break;
          }
        }
        if (!intersects) {
          rowGroupStart = rowGroupEnd;
          continue;
        }
      }
    }

    for (
      let chunkStart = rowGroupStart;
      chunkStart < rowGroupEnd;
      chunkStart += rowChunkSize
    ) {
      if (!canScanParquetChunk(metrics)) {
        break;
      }
      const chunkEnd = Math.min(rowGroupEnd, chunkStart + rowChunkSize);
      const matchedIndexes = [];
      if (filterColumns.length > 0) {
        const filterRows = await readParquetRowsForColumns(
          arrayBuffer,
          metadata,
          filterColumns,
          chunkStart,
          chunkEnd,
        );
        if (filterRows.length === 0) {
          continue;
        }
        if (metrics) {
          metrics.parquet_filter_rows_decoded += filterRows.length;
        }
        for (let idx = 0; idx < filterRows.length; idx += 1) {
          const rowEntry = filterRows[idx];
          if (hasTimeseriesFilter) {
            const rowTimeseriesId = parseRequiredPositiveInt(
              getParquetRowValue(rowEntry, "timeseries_id", filterColumnIndexByName),
            );
            if (!Number.isFinite(rowTimeseriesId) || !targetTimeseriesSet.has(rowTimeseriesId)) {
              continue;
            }
          }
          matchedIndexes.push(idx);
        }
      }

      if (matchedIndexes.length === 0) {
        continue;
      }

      const payloadRows = await readParquetRowsForColumns(
        arrayBuffer,
        metadata,
        availableColumns,
        chunkStart,
        chunkEnd,
      );
      if (payloadRows.length === 0) {
        continue;
      }
      if (metrics) {
        metrics.parquet_payload_rows_decoded += payloadRows.length;
      }

      for (const idx of matchedIndexes) {
        const rowEntry = idx < payloadRows.length ? payloadRows[idx] : null;
        const row = {};
        if (hasTimeseriesFilter && normalizedTimeseriesIds.length === 1) {
          row.timeseries_id = normalizedTimeseriesIds[0];
        }
        for (const columnName of availableColumns) {
          row[columnName] = getParquetRowValue(rowEntry, columnName, payloadColumnIndexByName);
        }
        outRows.push(row);
      }
      if (metrics) {
        metrics.parquet_matched_rows += matchedIndexes.length;
      }
    }

    rowGroupStart = rowGroupEnd;
    if (metrics?.stopped_reason) {
      break;
    }
  }

  return { exists: true, rows: outRows };
}

function resolveAqiParquetPayloadColumns(pollutantKey) {
  void pollutantKey;
  return AQI_PARQUET_COLUMNS.slice();
}

function getParquetRowValue(rowEntry, columnName, columnIndexByName) {
  const columnIndex = columnIndexByName.get(columnName);
  if (!Number.isFinite(columnIndex)) {
    return undefined;
  }
  if (Array.isArray(rowEntry)) {
    return rowEntry[columnIndex];
  }
  if (rowEntry && typeof rowEntry === "object") {
    return rowEntry[columnName];
  }
  return columnIndex === 0 ? rowEntry : undefined;
}

async function readParquetRowsForColumns(
  file,
  metadata,
  columns,
  rowStart,
  rowEnd,
) {
  if (!Array.isArray(columns) || columns.length === 0 || rowEnd <= rowStart) {
    return [];
  }
  let rows = [];
  await parquetRead({
    file,
    metadata,
    columns,
    rowStart,
    rowEnd,
    compressors,
    onComplete: (columnRows) => {
      if (Array.isArray(columnRows)) {
        rows = columnRows;
      }
    },
  });
  return rows;
}

function maxFiniteIndex(values, maxValue) {
  let out = null;
  for (const value of values) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      continue;
    }
    out = out === null ? numeric : Math.max(out, numeric);
  }
  if (out === null) {
    return null;
  }
  return Math.max(1, Math.min(maxValue, Math.trunc(out)));
}

function normalizeFiniteIndex(value, maxValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(1, Math.min(maxValue, Math.trunc(numeric)));
}

function buildEmptyHistoryRead() {
  return {
    points: [],
    days_requested: 0,
    days_scanned: 0,
    scanned_connector_manifests: 0,
    scanned_parquet_files: 0,
    missing_day_manifest_keys: [],
    missing_connector_manifest_keys: [],
    missing_parquet_keys: [],
    timeseries_index: {
      enabled: false,
      prefix: null,
      scanned_connector_index_keys: 0,
      hit_count: 0,
      miss_count: 0,
      skipped_days_by_file_range: 0,
      skipped_files_by_pollutant: 0,
      indexed_file_count_seen: 0,
      unknown_range_file_count_seen: 0,
      missing_connector_index_keys: [],
      warnings: [],
      target_timeseries_id_count: 0,
      scan_stopped_reason: null,
    },
    scan_metrics: createScanMetrics({
      maxR2ObjectReads: 0,
      maxParquetRowGroups: 0,
      maxParquetChunks: 0,
    }),
    aqi_band_cache: {
      enabled: false,
      prefix: DEFAULT_HISTORY_BANDS_PREFIX,
      eligible_day_count: 0,
      hit_count: 0,
      miss_count: 0,
      write_count: 0,
      skipped_day_count: 0,
    },
  };
}

function buildEmptyRecentRead(status = "not_requested", error = null) {
  return {
    source_path: null,
    points: [],
    status,
    error,
  };
}

async function fetchObsAqiDbArray({
  env,
  path,
  schema,
  queryParams,
}) {
  const baseUrl = normalizeBaseUrl(env.OBS_AQIDB_SUPABASE_URL || "");
  const apiKey = String(env.OBS_AQIDB_SECRET_KEY || "").trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      "Missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY for recent AQI reads.",
    );
  }

  const timeoutMs = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_OBSAQIDB_TIMEOUT_MS,
    DEFAULT_OBSAQIDB_TIMEOUT_MS,
    MIN_OBSAQIDB_TIMEOUT_MS,
    MAX_OBSAQIDB_TIMEOUT_MS,
  );

  const endpoint = new URL(`${baseUrl}/rest/v1/${path}`);
  for (const [key, value] of queryParams) {
    endpoint.searchParams.append(key, value);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Accept-Profile": schema,
        "x-ukaq-egress-caller": "uk_aq_aqi_history_r2_api_worker",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`ObsAQIDB request timed out for ${schema}.${path}.`);
    }
    throw new Error(`ObsAQIDB request failed for ${schema}.${path}: ${String(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const responseText = await response.text();
  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch (_error) {
    payload = null;
  }
  if (!response.ok || !Array.isArray(payload)) {
    const message = payload && typeof payload === "object"
      ? (payload.message || payload.error || payload.hint || JSON.stringify(payload))
      : responseText;
    throw new Error(
      `ObsAQIDB response failed for ${schema}.${path} (${response.status}): ${
        String(message || "unknown error")
      }`,
    );
  }

  return {
    source_path: `${schema}.${path}`,
    rows: payload,
  };
}

function buildTimeseriesWindowContextCacheKey(timeseriesId, startIso, endIso) {
  const timeseriesPart = Number.isFinite(Number(timeseriesId)) ? Math.trunc(Number(timeseriesId)) : 0;
  const startMs = Date.parse(String(startIso || ""));
  const endMs = Date.parse(String(endIso || ""));
  const startDay = Number.isFinite(startMs) ? toUtcDayFromMs(startMs) : "na";
  const endDay = Number.isFinite(endMs) ? toUtcDayFromMs(endMs) : "na";
  return `${timeseriesPart}:${startDay}:${endDay}`;
}

async function readTimeseriesWindowContextFromObsAqiDb({
  env,
  timeseriesId,
  startIso,
  endIso,
}) {
  const cacheKey = buildTimeseriesWindowContextCacheKey(timeseriesId, startIso, endIso);
  if (timeseriesWindowContextCache.has(cacheKey)) {
    const cached = timeseriesWindowContextCache.get(cacheKey) || {};
    return {
      source_path: String(cached.source_path || `${UK_AQ_PUBLIC_SCHEMA_DEFAULT}.${TIMESERIES_AQI_HOURLY_VIEW}`),
      timeseries_ids: Array.isArray(cached.timeseries_ids) ? cached.timeseries_ids : [],
      station_id: parseRequiredPositiveInt(cached.station_id) || null,
      connector_id: parseRequiredPositiveInt(cached.connector_id) || null,
      cache_hit: true,
    };
  }

  const schema = String(env.UK_AQ_PUBLIC_SCHEMA || UK_AQ_PUBLIC_SCHEMA_DEFAULT).trim()
    || UK_AQ_PUBLIC_SCHEMA_DEFAULT;
  const parsedTimeseriesId = parseRequiredPositiveInt(timeseriesId);
  const windowResult = await fetchObsAqiDbArray({
    env,
    path: TIMESERIES_AQI_HOURLY_VIEW,
    schema,
    queryParams: [
      ["select", "timeseries_id,station_id,connector_id,timestamp_hour_utc"],
      ["timeseries_id", `eq.${parsedTimeseriesId}`],
      ["timestamp_hour_utc", `gte.${startIso}`],
      ["timestamp_hour_utc", `lt.${endIso}`],
      ["order", "timestamp_hour_utc.desc"],
      ["limit", "1"],
    ],
  });
  let firstRow = Array.isArray(windowResult.rows) ? windowResult.rows[0] : null;
  let sourcePath = windowResult.source_path;
  if (!firstRow) {
    // Fallback: resolve connector/station context from the latest known row for
    // this timeseries so history scans remain connector-targeted even when the
    // requested window currently has no AQI rows.
    const latestResult = await fetchObsAqiDbArray({
      env,
      path: TIMESERIES_AQI_HOURLY_VIEW,
      schema,
      queryParams: [
        ["select", "timeseries_id,station_id,connector_id,timestamp_hour_utc"],
        ["timeseries_id", `eq.${parsedTimeseriesId}`],
        ["order", "timestamp_hour_utc.desc"],
        ["limit", "1"],
      ],
    });
    firstRow = Array.isArray(latestResult.rows) ? latestResult.rows[0] : null;
    sourcePath = latestResult.source_path;
  }

  const hasTimeseriesRow = Boolean(firstRow);
  const resolvedStationId = parseRequiredPositiveInt(firstRow?.station_id) || null;
  const resolvedConnectorId = parseRequiredPositiveInt(firstRow?.connector_id) || null;
  const resolvedTimeseriesIds = hasTimeseriesRow ? [parsedTimeseriesId] : [];

  const context = {
    source_path: sourcePath,
    timeseries_ids: resolvedTimeseriesIds,
    station_id: resolvedStationId,
    connector_id: resolvedConnectorId,
  };
  timeseriesWindowContextCache.set(cacheKey, context);

  return {
    ...context,
    cache_hit: false,
  };
}

function buildTimeseriesMetadataIndexKey(historyIndexPrefix, timeseriesId) {
  const normalizedPrefix = normalizePrefix(
    `${historyIndexPrefix || DEFAULT_HISTORY_V2_INDEX_PREFIX}/${DEFAULT_V2_TIMESERIES_METADATA_INDEX_SUBPREFIX}`,
  );
  const normalizedTimeseriesId = parseRequiredPositiveInt(timeseriesId);
  if (!normalizedPrefix || !normalizedTimeseriesId) {
    return null;
  }
  return `${normalizedPrefix}/timeseries_id=${normalizedTimeseriesId}.json`;
}

async function readTimeseriesWindowContextFromR2Metadata({
  env,
  historyIndexPrefix,
  timeseriesId,
}) {
  const metadataKey = buildTimeseriesMetadataIndexKey(historyIndexPrefix, timeseriesId);
  if (
    !metadataKey
    || !env.UK_AQ_HISTORY_BUCKET
    || typeof env.UK_AQ_HISTORY_BUCKET.get !== "function"
  ) {
    return {
      found: false,
      source_path: metadataKey,
      connector_id: null,
      station_id: null,
      timeseries_ids: [timeseriesId],
      metadata: null,
    };
  }

  const object = await fetchJsonObjectFromR2(env, metadataKey, null, "timeseries_metadata");
  if (!object.exists) {
    return {
      found: false,
      source_path: metadataKey,
      connector_id: null,
      station_id: null,
      timeseries_ids: [timeseriesId],
      metadata: null,
    };
  }

  const metadata = object.value && typeof object.value === "object" && !Array.isArray(object.value)
    ? object.value
    : {};
  const connectorIds = Array.isArray(metadata.connector_ids)
    ? metadata.connector_ids.map((value) => parseRequiredPositiveInt(value)).filter(Boolean)
    : [];
  const connectorId =
    parseRequiredPositiveInt(metadata.connector_id)
    || (connectorIds.length === 1 ? connectorIds[0] : null);
  return {
    found: Boolean(connectorId),
    source_path: metadataKey,
    connector_id: connectorId,
    station_id: null,
    timeseries_ids: [timeseriesId],
    metadata,
  };
}

function normalizeAndSortRows(rowsByPeriodStart, limit) {
  const rows = Array.from(rowsByPeriodStart.values()).sort((left, right) => {
    const leftMs = Date.parse(String(left.period_start_utc || "")) || 0;
    const rightMs = Date.parse(String(right.period_start_utc || "")) || 0;
    if (leftMs !== rightMs) {
      return leftMs - rightMs;
    }
    const leftTimeseries = Number(left.timeseries_id) || 0;
    const rightTimeseries = Number(right.timeseries_id) || 0;
    if (leftTimeseries !== rightTimeseries) {
      return leftTimeseries - rightTimeseries;
    }
    const leftPollutant = String(left.pollutant_code || "");
    const rightPollutant = String(right.pollutant_code || "");
    if (leftPollutant !== rightPollutant) {
      return leftPollutant.localeCompare(rightPollutant);
    }
    const leftConnector = Number(left.connector_id) || 0;
    const rightConnector = Number(right.connector_id) || 0;
    if (leftConnector !== rightConnector) {
      return leftConnector - rightConnector;
    }
    const leftStation = Number(left.station_id) || 0;
    const rightStation = Number(right.station_id) || 0;
    return leftStation - rightStation;
  });
  if (limit !== null && rows.length > limit) {
    return rows.slice(rows.length - limit);
  }
  return rows;
}

function aqiHistoryRowKey(row) {
  const periodStart = toIsoOrNull(row?.timestamp_hour_utc || row?.period_start_utc);
  if (!periodStart) {
    return null;
  }
  const timeseriesId = parseRequiredPositiveInt(row?.timeseries_id);
  const pollutantCode = normalizeAqiPollutant(row?.pollutant_code);
  if (!timeseriesId || !pollutantCode) {
    return null;
  }
  return `${periodStart}|${timeseriesId}|${pollutantCode}`;
}

function normalizeAqiHistoryRow(row, {
  source = null,
  sourceCoverage = null,
} = {}) {
  const periodStart = toIsoOrNull(row?.timestamp_hour_utc || row?.period_start_utc);
  if (!periodStart) {
    return null;
  }
  const timeseriesId = parseRequiredPositiveInt(row?.timeseries_id);
  const pollutantCode = normalizeAqiPollutant(row?.pollutant_code);
  if (!timeseriesId || !pollutantCode) {
    return null;
  }

  return {
    period_start_utc: periodStart,
    connector_id: parseRequiredPositiveInt(row?.connector_id) || null,
    station_id: parseRequiredPositiveInt(row?.station_id) || null,
    timeseries_id: timeseriesId,
    pollutant_code: pollutantCode,
    daqi_index_level: normalizeFiniteIndex(row?.daqi_index_level, 10),
    eaqi_index_level: normalizeFiniteIndex(row?.eaqi_index_level, 6),
    daqi_input_value_ugm3: toNullableFiniteNumber(row?.daqi_input_value_ugm3),
    daqi_input_averaging_code: toNullableText(row?.daqi_input_averaging_code),
    eaqi_input_value_ugm3: toNullableFiniteNumber(row?.eaqi_input_value_ugm3),
    eaqi_input_averaging_code: toNullableText(row?.eaqi_input_averaging_code),
    daqi_calculation_status: normalizeAqiStatus(row?.daqi_calculation_status),
    eaqi_calculation_status: normalizeAqiStatus(row?.eaqi_calculation_status),
    daqi_missing_reason: toNullableText(row?.daqi_missing_reason),
    eaqi_missing_reason: toNullableText(row?.eaqi_missing_reason),
    daqi_source_observation_count: parseOptionalPositiveInt(row?.daqi_source_observation_count, 0, 1000000),
    daqi_required_observation_count: parseOptionalPositiveInt(row?.daqi_required_observation_count, 0, 1000000),
    eaqi_source_observation_count: parseOptionalPositiveInt(row?.eaqi_source_observation_count, 0, 1000000),
    eaqi_required_observation_count: parseOptionalPositiveInt(row?.eaqi_required_observation_count, 0, 1000000),
    hourly_sample_count: parseOptionalPositiveInt(row?.hourly_sample_count, 0, 1000000),
    algorithm_version: toNullableText(row?.algorithm_version),
    computed_at_utc: toIsoOrNull(row?.computed_at_utc),
    source: source ? String(source) : null,
    source_coverage: sourceCoverage ? String(sourceCoverage) : null,
  };
}

function appendFilteredRows(rows, {
  targetTimeseriesIds = null,
  startMs,
  endMs,
  sinceMs,
  pollutantKey,
  outByPeriodStart,
  source = null,
}) {
  const normalizedTimeseriesIds = Array.isArray(targetTimeseriesIds)
    ? Array.from(
      new Set(
        targetTimeseriesIds
          .map((value) => parseRequiredPositiveInt(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    )
    : [];
  const hasTimeseriesFilter = normalizedTimeseriesIds.length > 0;
  const targetTimeseriesIdSet = hasTimeseriesFilter ? new Set(normalizedTimeseriesIds) : null;

  for (const row of rows) {
    const rowTimeseriesId = parseRequiredPositiveInt(row?.timeseries_id);
    if (hasTimeseriesFilter && (!rowTimeseriesId || !targetTimeseriesIdSet.has(rowTimeseriesId))) {
      continue;
    }
    const periodStart = toIsoOrNull(row?.timestamp_hour_utc || row?.period_start_utc);
    if (!periodStart) {
      continue;
    }
    const periodMs = Date.parse(periodStart);
    if (!Number.isFinite(periodMs)) {
      continue;
    }
    if (periodMs < startMs || periodMs >= endMs) {
      continue;
    }
    if (Number.isFinite(sinceMs) && periodMs <= sinceMs) {
      continue;
    }

    const rowPollutant = normalizeAqiPollutant(row?.pollutant_code);
    if (!rowPollutant) {
      continue;
    }
    if (pollutantKey && rowPollutant !== pollutantKey) {
      continue;
    }

    const normalizedRow = normalizeAqiHistoryRow(row, {
      source,
    });
    if (!normalizedRow) {
      continue;
    }

    const rowKey = aqiHistoryRowKey(row);
    if (!rowKey) {
      continue;
    }
    const existing = outByPeriodStart.get(rowKey);
    if (existing) {
      outByPeriodStart.set(
        rowKey,
        {
          ...existing,
          ...normalizedRow,
          source: existing.source || normalizedRow.source,
        },
      );
      continue;
    }
    outByPeriodStart.set(rowKey, normalizedRow);
  }
}

function extractParquetKeysFromTimeseriesIndex(
  indexPayload,
  targetTimeseriesIds,
  pollutantKey,
) {
  const files = Array.isArray(indexPayload?.files) ? indexPayload.files : [];
  const requestedIds = Array.isArray(targetTimeseriesIds)
    ? targetTimeseriesIds.filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      .map((value) => Math.trunc(Number(value)))
    : [];
  const allKeys = [];
  let indexedFileCount = 0;
  let filesWithUnknownRange = 0;
  let filesSkippedByPollutant = 0;
  let allFilesRangeBounded = files.length > 0;

  for (const entry of files) {
    const key = String(entry?.key || "").trim();
    if (!key) {
      continue;
    }
    const filePollutants = Array.from(new Set([
      ...(Array.isArray(entry?.pollutant_codes) ? entry.pollutant_codes : []),
      entry?.pollutant_code,
    ]
      .map((value) => normalizeAqiPollutant(value))
      .filter(Boolean)));
    if (pollutantKey && filePollutants.length > 0 && !filePollutants.includes(pollutantKey)) {
      filesSkippedByPollutant += 1;
      continue;
    }
    const minTimeseriesId = Number(entry?.min_timeseries_id);
    const maxTimeseriesId = Number(entry?.max_timeseries_id);
    const hasRange =
      Number.isFinite(minTimeseriesId)
      && Number.isFinite(maxTimeseriesId)
      && minTimeseriesId > 0
      && maxTimeseriesId > 0
      && maxTimeseriesId >= minTimeseriesId;

    if (!hasRange) {
      allFilesRangeBounded = false;
      filesWithUnknownRange += 1;
      allKeys.push(key);
      continue;
    }

    indexedFileCount += 1;
    if (requestedIds.length === 0) {
      allFilesRangeBounded = false;
      allKeys.push(key);
      continue;
    }
    for (const requestedId of requestedIds) {
      if (requestedId >= minTimeseriesId && requestedId <= maxTimeseriesId) {
        allKeys.push(key);
        break;
      }
    }
  }

  return {
    keys: Array.from(new Set(allKeys)),
    file_count: files.length,
    indexed_file_count: indexedFileCount,
    unknown_range_file_count: filesWithUnknownRange,
    skipped_by_pollutant_file_count: filesSkippedByPollutant,
    all_files_range_bounded: allFilesRangeBounded,
  };
}

async function readHistoryRows({
  env,
  readVersion = "v1",
  historyPrefix,
  historyIndexPrefix,
  timeseriesIndexPrefix,
  connectorId,
  stationId = null,
  targetTimeseriesIds,
  startIso,
  endIso,
  sinceIso,
  pollutantKey,
  limit,
}) {
  const scanStartedAtMs = Date.now();
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const parquetRowChunkSize = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_PARQUET_ROW_CHUNK_SIZE,
    DEFAULT_PARQUET_ROW_CHUNK_SIZE,
    MIN_PARQUET_ROW_CHUNK_SIZE,
    MAX_PARQUET_ROW_CHUNK_SIZE,
  );
  const normalizedReadVersion = parseReadVersion(readVersion);
  const normalizedHistoryIndexPrefix = normalizePrefix(historyIndexPrefix || (
    normalizedReadVersion === "v2"
      ? DEFAULT_HISTORY_V2_INDEX_PREFIX
      : DEFAULT_HISTORY_INDEX_PREFIX
  ));
  const normalizedTimeseriesIndexPrefix = normalizePrefix(timeseriesIndexPrefix || (
    normalizedReadVersion === "v2"
      ? `${normalizedHistoryIndexPrefix}/${DEFAULT_V2_TIMESERIES_INDEX_SUBPREFIX}`
      : `${normalizedHistoryIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`
  ));
  const timeseriesIndexEnabled = parseOptionalBoolean(
    env.UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED,
    true,
  );
  const requireTimeseriesIndex = parseOptionalBoolean(
    env.UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX,
    true,
  );
  const maxParquetFilesPerRequest = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_FILES_PER_REQUEST,
    DEFAULT_MAX_PARQUET_FILES_PER_REQUEST,
    MIN_MAX_PARQUET_FILES_PER_REQUEST,
    MAX_MAX_PARQUET_FILES_PER_REQUEST,
  );
  const maxR2ObjectReadsPerRequest = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_MAX_R2_OBJECT_READS_PER_REQUEST,
    DEFAULT_MAX_R2_OBJECT_READS_PER_REQUEST,
    MIN_MAX_R2_OBJECT_READS_PER_REQUEST,
    MAX_MAX_R2_OBJECT_READS_PER_REQUEST,
  );
  const maxParquetRowGroupsPerRequest = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_ROW_GROUPS_PER_REQUEST,
    DEFAULT_MAX_PARQUET_ROW_GROUPS_PER_REQUEST,
    MIN_MAX_PARQUET_ROW_GROUPS_PER_REQUEST,
    MAX_MAX_PARQUET_ROW_GROUPS_PER_REQUEST,
  );
  const maxParquetChunksPerRequest = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_CHUNKS_PER_REQUEST,
    DEFAULT_MAX_PARQUET_CHUNKS_PER_REQUEST,
    MIN_MAX_PARQUET_CHUNKS_PER_REQUEST,
    MAX_MAX_PARQUET_CHUNKS_PER_REQUEST,
  );
  const maxScanElapsedMs = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_MAX_SCAN_ELAPSED_MS,
    DEFAULT_MAX_SCAN_ELAPSED_MS,
    MIN_MAX_SCAN_ELAPSED_MS,
    MAX_MAX_SCAN_ELAPSED_MS,
  );
  const parquetPayloadColumns = resolveAqiParquetPayloadColumns(pollutantKey);
  const targetTimeseriesIdCount = Array.isArray(targetTimeseriesIds)
    ? targetTimeseriesIds.length
    : 0;
  const bandCachePrefix = DEFAULT_HISTORY_BANDS_PREFIX;
  const bandCacheHitCount = 0;
  const bandCacheMissCount = 0;
  const bandCacheWriteCount = 0;
  const bandCacheEligibleDayCount = 0;
  const bandCacheSkippedDayCount = 0;
  const scanMetrics = createScanMetrics({
    maxR2ObjectReads: maxR2ObjectReadsPerRequest,
    maxParquetRowGroups: maxParquetRowGroupsPerRequest,
    maxParquetChunks: maxParquetChunksPerRequest,
  });

  const days = listUtcDays(startIso, endIso);
  const daysToScan = days.slice().reverse();
  if (Array.isArray(targetTimeseriesIds) && targetTimeseriesIds.length === 0) {
    const emptyRead = buildEmptyHistoryRead();
    emptyRead.timeseries_index.warnings = [
      "No AQI timeseries IDs found in requested window; skipped R2 history scan.",
    ];
    return emptyRead;
  }

  const rowsByPeriodStart = new Map();
  const missingDayManifestKeys = [];
  const missingConnectorManifestKeys = new Set();
  const missingParquetKeys = new Set();
  const scannedParquetKeys = new Set();
  const timeseriesIndexScannedKeys = [];
  const timeseriesIndexMissingKeys = [];
  const timeseriesIndexWarnings = [];
  let scannedConnectorManifests = 0;
  let scannedDays = 0;
  let resolvedConnectorId = parseRequiredPositiveInt(connectorId) || null;
  let timeseriesIndexHitCount = 0;
  let timeseriesIndexMissCount = 0;
  let timeseriesIndexSkippedByRangeDays = 0;
  let timeseriesIndexSkippedByPollutantFiles = 0;
  let timeseriesIndexIndexedFileCount = 0;
  let timeseriesIndexUnknownRangeFileCount = 0;
  let scanStoppedReason = null;
  if (normalizedReadVersion === "v2" && !pollutantKey) {
    scanStoppedReason = "v2_requires_pollutant_partition";
    stopScan(scanMetrics, scanStoppedReason);
    timeseriesIndexWarnings.push(
      "Skipped v2 R2 scan: pollutant is required to read pollutant-partitioned AQI history.",
    );
  }
  if (!timeseriesIndexEnabled && requireTimeseriesIndex && targetTimeseriesIdCount > 0) {
    scanStoppedReason = "timeseries_index_required_but_disabled";
    stopScan(scanMetrics, scanStoppedReason);
    timeseriesIndexWarnings.push(
      "Skipped broad history scan: timeseries index is required but disabled by Worker configuration.",
    );
  }
  if (
    timeseriesIndexEnabled
    && requireTimeseriesIndex
    && targetTimeseriesIdCount > 0
    && !resolvedConnectorId
  ) {
    scanStoppedReason = "missing_connector_context_for_required_timeseries_index";
    stopScan(scanMetrics, scanStoppedReason);
    timeseriesIndexWarnings.push(
      "Skipped broad connector manifest scan: timeseries index is required but connector_id could not be resolved.",
    );
  }

  const isScanBudgetExceeded = () => {
    if (scanMetrics.stopped_reason) {
      scanStoppedReason = scanMetrics.stopped_reason;
      return true;
    }
    if (Date.now() - scanStartedAtMs > maxScanElapsedMs) {
      scanStoppedReason = `scan_elapsed_ms_budget_exceeded:${maxScanElapsedMs}`;
      stopScan(scanMetrics, scanStoppedReason);
      return true;
    }
    return false;
  };

  for (const dayUtc of daysToScan) {
    if (isScanBudgetExceeded()) {
      break;
    }
    const dayStartMs = utcMidnightMs(dayUtc);
    const dayEndMs = dayStartMs + DAY_MS;
    const dayRowsByPeriodStart = new Map();
    scannedDays += 1;

    const connectorManifestTargets = [];
    if (Number.isFinite(resolvedConnectorId) && resolvedConnectorId > 0) {
      const connectorManifestFallbackKey = buildConnectorManifestKey(
        historyPrefix,
        dayUtc,
        resolvedConnectorId,
      );
      connectorManifestTargets.push({
        connector_id: resolvedConnectorId,
        manifest_key: connectorManifestFallbackKey,
      });
    } else {
      const dayManifestKey = buildDayManifestKey(historyPrefix, dayUtc);
      const dayManifestObject = await fetchJsonObjectFromR2(env, dayManifestKey, scanMetrics, "day_manifest");
      if (dayManifestObject.budget_exceeded) {
        scanStoppedReason = scanMetrics.stopped_reason;
        break;
      }
      if (!dayManifestObject.exists) {
        missingDayManifestKeys.push(dayManifestKey);
        continue;
      }
      const connectorManifestEntries = Array.isArray(dayManifestObject.value?.connector_manifests)
        ? dayManifestObject.value.connector_manifests
        : [];
      for (const connectorManifestEntry of connectorManifestEntries) {
        const entryConnectorId = Number(connectorManifestEntry?.connector_id);
        if (!Number.isFinite(entryConnectorId) || entryConnectorId <= 0) {
          continue;
        }
        connectorManifestTargets.push({
          connector_id: entryConnectorId,
          manifest_key: String(connectorManifestEntry?.manifest_key || "").trim()
            || buildConnectorManifestKey(historyPrefix, dayUtc, entryConnectorId),
        });
      }
    }

    for (const connectorManifestTarget of connectorManifestTargets) {
      if (isScanBudgetExceeded()) {
        break;
      }
      const connectorManifestKey = String(connectorManifestTarget.manifest_key || "").trim();
      if (!connectorManifestKey) {
        continue;
      }
      let parquetKeys = null;
      const targetConnectorId = Number(connectorManifestTarget.connector_id);

      if (timeseriesIndexEnabled && Number.isFinite(targetConnectorId) && targetConnectorId > 0) {
        const connectorIndexKey = normalizedReadVersion === "v2"
          ? buildTimeseriesPollutantIndexKey(
            normalizedTimeseriesIndexPrefix,
            dayUtc,
            targetConnectorId,
            pollutantKey,
          )
          : buildTimeseriesConnectorIndexKey(
            normalizedTimeseriesIndexPrefix,
            dayUtc,
            targetConnectorId,
          );
        if (!connectorIndexKey) {
          scanStoppedReason = "v2_requires_pollutant_partition";
          stopScan(scanMetrics, scanStoppedReason);
          timeseriesIndexWarnings.push(
            "Skipped v2 R2 scan: pollutant is required to build the v2 timeseries index key.",
          );
          break;
        }
        timeseriesIndexScannedKeys.push(connectorIndexKey);
        try {
          const connectorIndexObject = await fetchJsonObjectFromR2(env, connectorIndexKey, scanMetrics, "timeseries_index");
          if (connectorIndexObject.budget_exceeded) {
            scanStoppedReason = scanMetrics.stopped_reason;
            break;
          }
          if (connectorIndexObject.exists) {
            timeseriesIndexHitCount += 1;
            const extraction = extractParquetKeysFromTimeseriesIndex(
              connectorIndexObject.value,
              targetTimeseriesIds,
              pollutantKey,
            );
            timeseriesIndexIndexedFileCount += extraction.indexed_file_count;
            timeseriesIndexUnknownRangeFileCount += extraction.unknown_range_file_count;
            timeseriesIndexSkippedByPollutantFiles += extraction.skipped_by_pollutant_file_count;
            if (extraction.all_files_range_bounded && extraction.keys.length === 0) {
              timeseriesIndexSkippedByRangeDays += 1;
              continue;
            }
            parquetKeys = extraction.keys;
          } else {
            timeseriesIndexMissCount += 1;
            timeseriesIndexMissingKeys.push(connectorIndexKey);
            if (requireTimeseriesIndex && targetTimeseriesIdCount > 0) {
              timeseriesIndexWarnings.push(
                `Skipped fallback manifest scan for ${connectorIndexKey}: timeseries index is required.`,
              );
              continue;
            }
          }
        } catch (error) {
          timeseriesIndexMissCount += 1;
          const message = error instanceof Error ? error.message : String(error);
          timeseriesIndexWarnings.push(
            `Optional timeseries index read failed for ${connectorIndexKey}: ${message}`,
          );
          if (requireTimeseriesIndex && targetTimeseriesIdCount > 0) {
            continue;
          }
        }
      }

      if (parquetKeys === null) {
        if (normalizedReadVersion === "v2" && requireTimeseriesIndex && targetTimeseriesIdCount > 0) {
          timeseriesIndexWarnings.push(
            `Skipped fallback manifest scan for ${connectorManifestKey}: v2 read mode requires the pollutant timeseries index.`,
          );
          continue;
        }
        scannedConnectorManifests += 1;
        const connectorManifestObject = await fetchJsonObjectFromR2(env, connectorManifestKey, scanMetrics, "connector_manifest");
        if (connectorManifestObject.budget_exceeded) {
          scanStoppedReason = scanMetrics.stopped_reason;
          break;
        }
        if (!connectorManifestObject.exists) {
          missingConnectorManifestKeys.add(connectorManifestKey);
          continue;
        }

        const files = Array.isArray(connectorManifestObject.value?.files)
          ? connectorManifestObject.value.files
          : [];
        parquetKeys = files.map((fileEntry) => String(fileEntry?.key || "").trim()).filter(Boolean);
      }

      for (const parquetKey of parquetKeys) {
        if (isScanBudgetExceeded()) {
          break;
        }
        if (!parquetKey) {
          continue;
        }
        if (scannedParquetKeys.size >= maxParquetFilesPerRequest) {
          scanStoppedReason = `max_parquet_files_budget_exceeded:${maxParquetFilesPerRequest}`;
          break;
        }
        scannedParquetKeys.add(parquetKey);
        const parquet = await fetchFilteredParquetRowsFromR2(
          env,
          parquetKey,
          parquetRowChunkSize,
          targetTimeseriesIds,
          parquetPayloadColumns,
          scanMetrics,
        );
        if (parquet.budget_exceeded) {
          scanStoppedReason = scanMetrics.stopped_reason;
          break;
        }
        if (scanMetrics.stopped_reason && !scanStoppedReason) {
          scanStoppedReason = scanMetrics.stopped_reason;
        }
        if (!parquet.exists) {
          missingParquetKeys.add(parquetKey);
          continue;
        }
        if (!resolvedConnectorId) {
          resolvedConnectorId = targetConnectorId;
        }
        appendFilteredRows(parquet.rows, {
          targetTimeseriesIds,
          startMs,
          endMs,
          sinceMs,
          pollutantKey,
          outByPeriodStart: dayRowsByPeriodStart,
          source: "r2",
        });
        if (scanStoppedReason) {
          break;
        }
      }
    }
    for (const [periodStart, row] of dayRowsByPeriodStart.entries()) {
      rowsByPeriodStart.set(periodStart, row);
    }

    if (scanStoppedReason) {
      break;
    }
  }

  if (scanStoppedReason) {
    timeseriesIndexWarnings.push(`History scan stopped early: ${scanStoppedReason}`);
  }

  const points = normalizeAndSortRows(rowsByPeriodStart, limit);
  return {
    points,
    days_requested: days.length,
    days_scanned: scannedDays,
    scanned_connector_manifests: scannedConnectorManifests,
    scanned_parquet_files: scannedParquetKeys.size,
    resolved_connector_id: resolvedConnectorId,
    missing_day_manifest_keys: missingDayManifestKeys,
    missing_connector_manifest_keys: Array.from(missingConnectorManifestKeys.values()),
    missing_parquet_keys: Array.from(missingParquetKeys.values()),
    timeseries_index: {
      enabled: timeseriesIndexEnabled,
      prefix: normalizedTimeseriesIndexPrefix,
      read_version: normalizedReadVersion,
      index_version: normalizedReadVersion,
      data_profile: normalizedReadVersion === "v2" ? "hourly_data" : "v1",
      pollutant_partition: normalizedReadVersion === "v2" ? (pollutantKey || null) : null,
      scanned_connector_index_keys: timeseriesIndexScannedKeys.length,
      hit_count: timeseriesIndexHitCount,
      miss_count: timeseriesIndexMissCount,
      skipped_days_by_file_range: timeseriesIndexSkippedByRangeDays,
      skipped_files_by_pollutant: timeseriesIndexSkippedByPollutantFiles,
      indexed_file_count_seen: timeseriesIndexIndexedFileCount,
      unknown_range_file_count_seen: timeseriesIndexUnknownRangeFileCount,
      missing_connector_index_keys: timeseriesIndexMissingKeys,
      warnings: timeseriesIndexWarnings,
      target_timeseries_id_count: targetTimeseriesIdCount,
      require_timeseries_index: requireTimeseriesIndex,
      max_parquet_files_per_request: maxParquetFilesPerRequest,
      max_scan_elapsed_ms: maxScanElapsedMs,
      scan_stopped_reason: scanStoppedReason,
    },
    scan_metrics: {
      ...scanMetrics,
      duration_ms: Date.now() - scanStartedAtMs,
    },
    aqi_band_cache: {
      enabled: false,
      prefix: bandCachePrefix,
      eligible_day_count: bandCacheEligibleDayCount,
      hit_count: bandCacheHitCount,
      miss_count: bandCacheMissCount,
      write_count: bandCacheWriteCount,
      skipped_day_count: bandCacheSkippedDayCount,
    },
  };
}


function dayUtcFromIso(iso) {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
}

function normalizeLiveObservationRow(row, { connectorId = null, stationId = null, pollutantCode = null } = {}) {
  const timeseriesId = parseRequiredPositiveInt(row?.timeseries_id);
  const observedAt = toIsoOrNull(row?.observed_at_utc || row?.observed_at || row?.timestamp_utc || row?.time);
  if (!timeseriesId || !observedAt) return null;
  const value = row?.value === null || row?.value === undefined ? null : Number(row.value);
  if (!Number.isFinite(value)) return null;
  return {
    connector_id: parseRequiredPositiveInt(row?.connector_id) || connectorId,
    station_id: parseRequiredPositiveInt(row?.station_id) || stationId,
    timeseries_id: timeseriesId,
    pollutant_code: normalizeAqiPollutant(row?.pollutant_code || pollutantCode),
    observed_at_utc: observedAt,
    value,
  };
}

async function readLiveR2ObservationRows({ env, timeseriesId, connectorId, stationId, pollutantKey, startIso, endIso, authHeader }) {
  const baseUrl = normalizeBaseUrl(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL || env.UK_AQ_OBSERVATIONS_HISTORY_R2_API_URL || "");
  if (!baseUrl) return { rows: [], source: "not_configured", error: null };
  const url = new URL(`${baseUrl}/v1/observations-history`);
  url.searchParams.set("scope", "timeseries");
  url.searchParams.set("timeseries_id", String(timeseriesId));
  if (connectorId) url.searchParams.set("connector_id", String(connectorId));
  if (stationId) url.searchParams.set("station_id", String(stationId));
  url.searchParams.set("pollutant", pollutantKey);
  url.searchParams.set("start_utc", startIso);
  url.searchParams.set("end_utc", endIso);
  url.searchParams.set("format", "objects");
  const headers = authHeader ? { [UPSTREAM_AUTH_HEADER]: authHeader } : {};
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) throw new Error(`R2 observation history read failed (${response.status})`);
  const payload = await response.json();
  const rawRows = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.points) ? payload.points : [];
  return {
    rows: rawRows.map((row) => normalizeLiveObservationRow(row, { connectorId, stationId, pollutantCode: pollutantKey })).filter(Boolean),
    source: "r2_observations_api",
    error: null,
  };
}

async function readRecentIngestObservationRows({ env, timeseriesId, connectorId, stationId, pollutantKey, startIso, endIso }) {
  const path = String(env.UK_AQ_OBSAQIDB_OBSERVATIONS_PATH || "uk_aq_observations").trim();
  const schema = String(env.UK_AQ_PUBLIC_SCHEMA || UK_AQ_PUBLIC_SCHEMA_DEFAULT).trim() || UK_AQ_PUBLIC_SCHEMA_DEFAULT;
  const result = await fetchObsAqiDbArray({
    env,
    path,
    schema,
    queryParams: [
      ["select", "connector_id,station_id,timeseries_id,pollutant_code,observed_at_utc,value"],
      ["timeseries_id", `eq.${timeseriesId}`],
      ["observed_at_utc", `gte.${startIso}`],
      ["observed_at_utc", `lt.${endIso}`],
      ["order", "observed_at_utc.asc"],
      ["limit", String(MAX_LIMIT)],
    ],
  });
  return {
    rows: result.rows.map((row) => normalizeLiveObservationRow(row, { connectorId, stationId, pollutantCode: pollutantKey })).filter(Boolean),
    source: result.source_path,
  };
}

function projectLiveAqiRowsToResponseRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    period_start_utc: row.timestamp_hour_utc,
    connector_id: row.connector_id,
    station_id: row.station_id,
    timeseries_id: row.timeseries_id,
    pollutant_code: row.pollutant_code,
    daqi_index_level: row.daqi_index_level,
    eaqi_index_level: row.eaqi_index_level,
    daqi_input_value_ugm3: row.daqi_input_value_ugm3,
    daqi_input_averaging_code: row.daqi_input_averaging_code,
    eaqi_input_value_ugm3: row.eaqi_input_value_ugm3,
    eaqi_input_averaging_code: row.eaqi_input_averaging_code,
    daqi_calculation_status: row.daqi_calculation_status,
    eaqi_calculation_status: row.eaqi_calculation_status,
    daqi_missing_reason: row.daqi_missing_reason,
    eaqi_missing_reason: row.eaqi_missing_reason,
    source: "live_calculated",
    source_coverage: "live_observation_fallback",
  }));
}

async function readRecentRowsFromObsAqiDb({
  env,
  timeseriesId,
  startIso,
  endIso,
  sinceIso,
  pollutantKey,
}) {
  const schema = String(env.UK_AQ_PUBLIC_SCHEMA || UK_AQ_PUBLIC_SCHEMA_DEFAULT).trim()
    || UK_AQ_PUBLIC_SCHEMA_DEFAULT;
  const result = await fetchObsAqiDbArray({
    env,
    path: "uk_aq_timeseries_aqi_hourly",
    schema,
    queryParams: [
      [
        "select",
        [
          "timeseries_id",
          "station_id",
          "connector_id",
          "timestamp_hour_utc",
          "pollutant_code",
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
        ].join(","),
      ],
      ["timeseries_id", `eq.${timeseriesId}`],
      ["timestamp_hour_utc", `gte.${startIso}`],
      ["timestamp_hour_utc", `lt.${endIso}`],
      ...(sinceIso ? [["timestamp_hour_utc", `gt.${sinceIso}`]] : []),
      ["order", "timestamp_hour_utc.asc"],
      ["limit", String(MAX_LIMIT)],
    ],
  });

  const rowsByPeriodStart = new Map();
  appendFilteredRows(result.rows, {
    targetTimeseriesIds: [timeseriesId],
    startMs: Date.parse(startIso),
    endMs: Date.parse(endIso),
    sinceMs: sinceIso ? Date.parse(sinceIso) : Number.NaN,
    pollutantKey,
    outByPeriodStart: rowsByPeriodStart,
    source: "obs_aqidb",
  });

  return {
    source_path: result.source_path,
    points: normalizeAndSortRows(rowsByPeriodStart, null),
  };
}

function mergePointsPreferPrimary(primaryPoints, secondaryPoints, limit) {
  const merged = new Map();
  for (const point of secondaryPoints) {
    const key = aqiHistoryRowKey(point);
    if (!key) {
      continue;
    }
    merged.set(key, point);
  }
  // Primary rows are source-of-truth and overwrite overlapping secondary rows.
  for (const point of primaryPoints) {
    const key = aqiHistoryRowKey(point);
    if (!key) {
      continue;
    }
    merged.set(key, point);
  }
  const rows = Array.from(merged.values()).sort((left, right) => {
    const leftMs = Date.parse(String(left.period_start_utc || "")) || 0;
    const rightMs = Date.parse(String(right.period_start_utc || "")) || 0;
    if (leftMs !== rightMs) {
      return leftMs - rightMs;
    }
    const leftTimeseries = Number(left.timeseries_id) || 0;
    const rightTimeseries = Number(right.timeseries_id) || 0;
    if (leftTimeseries !== rightTimeseries) {
      return leftTimeseries - rightTimeseries;
    }
    const leftPollutant = String(left.pollutant_code || "");
    const rightPollutant = String(right.pollutant_code || "");
    if (leftPollutant !== rightPollutant) {
      return leftPollutant.localeCompare(rightPollutant);
    }
    const leftConnector = Number(left.connector_id) || 0;
    const rightConnector = Number(right.connector_id) || 0;
    if (leftConnector !== rightConnector) {
      return leftConnector - rightConnector;
    }
    const leftStation = Number(left.station_id) || 0;
    const rightStation = Number(right.station_id) || 0;
    return leftStation - rightStation;
  });
  if (limit !== null && rows.length > limit) {
    return rows.slice(rows.length - limit);
  }
  return rows;
}

function countPointsInWindow(points, startMs, endMs) {
  if (!Array.isArray(points) || points.length === 0) {
    return 0;
  }
  let count = 0;
  for (const point of points) {
    const periodStartMs = Date.parse(String(point?.period_start_utc || ""));
    if (!Number.isFinite(periodStartMs)) {
      continue;
    }
    if (periodStartMs >= startMs && periodStartMs < endMs) {
      count += 1;
    }
  }
  return count;
}

function filterPointsToWindow(points, startMs, endMs) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }
  return points.filter((point) => {
    const periodStartMs = Date.parse(String(point?.period_start_utc || ""));
    return Number.isFinite(periodStartMs)
      && periodStartMs >= startMs
      && periodStartMs < endMs;
  });
}

function filterPointsToMissingRows(candidatePoints, preferredPoints, startMs, endMs) {
  const preferredKeys = new Set();
  for (const point of filterPointsToWindow(preferredPoints, startMs, endMs)) {
    const key = aqiHistoryRowKey(point);
    if (key) {
      preferredKeys.add(key);
    }
  }
  return filterPointsToWindow(candidatePoints, startMs, endMs).filter((point) => {
    const key = aqiHistoryRowKey(point);
    return key !== null && !preferredKeys.has(key);
  });
}

function buildExpectedAqiHourBuckets(startIso, endIso, sinceIso = null) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }
  const buckets = [];
  let hourMs = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  while (hourMs < endMs) {
    if (!Number.isFinite(sinceMs) || hourMs > sinceMs) {
      buckets.push(new Date(hourMs).toISOString());
    }
    hourMs += HOUR_MS;
  }
  return buckets;
}

function summarizeExpectedAqiHourCoverage(points, {
  startIso,
  endIso,
  sinceIso = null,
  timeseriesId,
  pollutantKey,
} = {}) {
  const expectedHours = buildExpectedAqiHourBuckets(startIso, endIso, sinceIso);
  const requestedTimeseriesId = parseRequiredPositiveInt(timeseriesId);
  const requestedPollutant = normalizeAqiPollutant(pollutantKey);
  const expectedHourSet = new Set(expectedHours);
  const presentHours = new Set();
  for (const point of Array.isArray(points) ? points : []) {
    const pointTimeseriesId = parseRequiredPositiveInt(point?.timeseries_id);
    if (requestedTimeseriesId && pointTimeseriesId !== requestedTimeseriesId) {
      continue;
    }
    if (requestedPollutant && normalizeAqiPollutant(point?.pollutant_code) !== requestedPollutant) {
      continue;
    }
    const periodStartMs = Date.parse(String(point?.period_start_utc || ""));
    if (!Number.isFinite(periodStartMs)) {
      continue;
    }
    const periodStartIso = new Date(periodStartMs).toISOString();
    if (expectedHourSet.has(periodStartIso)) {
      presentHours.add(periodStartIso);
    }
  }
  const missingHours = expectedHours.filter((hourIso) => !presentHours.has(hourIso));
  return {
    expected_hour_count: expectedHours.length,
    present_hour_count: presentHours.size,
    missing_hour_count: missingHours.length,
    missing_hours: missingHours,
    complete: missingHours.length === 0,
  };
}

function makeWindowCoveringIsoHours(hourIsoValues) {
  const hourMsValues = Array.isArray(hourIsoValues)
    ? hourIsoValues
      .map((value) => Date.parse(String(value || "")))
      .filter((value) => Number.isFinite(value))
    : [];
  if (hourMsValues.length === 0) {
    return null;
  }
  const startMs = Math.min(...hourMsValues);
  const endMs = Math.max(...hourMsValues) + HOUR_MS;
  return makeWindow(startMs, endMs);
}

function hasMissingKeyInWindow(keys, startMs, endMs) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return false;
  }
  const pattern = /day_utc=(\d{4}-\d{2}-\d{2})/;
  for (const key of keys) {
    const text = String(key || "");
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }
    const dayStartMs = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(dayStartMs)) {
      continue;
    }
    const dayEndMs = dayStartMs + DAY_MS;
    if (dayStartMs < endMs && dayEndMs > startMs) {
      return true;
    }
  }
  return false;
}

function collectR2PartialReasonsForWindow(r2Read, window) {
  if (!window) {
    return [];
  }
  const reasons = [];
  const scanStoppedReason = r2Read?.timeseries_index?.scan_stopped_reason || null;
  const timeseriesIndex = r2Read?.timeseries_index || {};
  if (scanStoppedReason) {
    reasons.push(`r2_scan_stopped:${scanStoppedReason}`);
  }
  if (timeseriesIndex.require_timeseries_index && timeseriesIndex.enabled === false) {
    reasons.push("timeseries_index_required_but_disabled");
  }
  if (
    timeseriesIndex.require_timeseries_index
    && Number(timeseriesIndex.miss_count || 0) > 0
  ) {
    reasons.push("required_timeseries_index_miss");
  }
  if (Array.isArray(timeseriesIndex.warnings) && timeseriesIndex.warnings.length > 0) {
    reasons.push("timeseries_index_warning");
  }
  if (hasMissingKeyInWindow(r2Read?.missing_day_manifest_keys, window.startMs, window.endMs)) {
    reasons.push("missing_day_manifest");
  }
  if (
    hasMissingKeyInWindow(
      r2Read?.missing_connector_manifest_keys,
      window.startMs,
      window.endMs,
    )
  ) {
    reasons.push("missing_connector_manifest");
  }
  if (hasMissingKeyInWindow(r2Read?.missing_parquet_keys, window.startMs, window.endMs)) {
    reasons.push("missing_parquet");
  }
  return Array.from(new Set(reasons));
}

function resolveTimeRange(url) {
  const explicitStart = toIsoOrNull(
    url.searchParams.get("start_utc")
      || url.searchParams.get("from_utc")
      || url.searchParams.get("start")
      || url.searchParams.get("from"),
  );
  const explicitEnd = toIsoOrNull(
    url.searchParams.get("end_utc")
      || url.searchParams.get("to_utc")
      || url.searchParams.get("end")
      || url.searchParams.get("to"),
  );

  if (explicitStart || explicitEnd) {
    if (!explicitStart || !explicitEnd) {
      return { ok: false, error: "start_utc/from_utc and end_utc/to_utc must be provided together." };
    }
    return { ok: true, startIso: explicitStart, endIso: explicitEnd };
  }

  const days = parsePositiveInt(url.searchParams.get("days"), 1, 1, MAX_RANGE_DAYS);
  const end = new Date();
  const start = new Date(end.getTime() - (days * DAY_MS));
  return { ok: true, startIso: start.toISOString(), endIso: end.toISOString() };
}

async function handleRequest(request, env, ctx) {
  const requestId = crypto.randomUUID();
  const requestStartedAtMs = Date.now();
  const url = new URL(request.url);
  if (!VALID_PATHS.has(url.pathname)) {
    return jsonResponse({ ok: false, error: "Not found." }, { status: 404, cacheSeconds: 30 });
  }

  const scope = String(url.searchParams.get("scope") || "timeseries").trim().toLowerCase();
  if (scope !== "timeseries") {
    return jsonResponse({
      ok: false,
      error: "scope must be timeseries.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const grain = String(url.searchParams.get("grain") || "hourly").trim().toLowerCase();
  if (grain !== "hourly") {
    return jsonResponse({
      ok: false,
      error: "grain must be hourly.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const timeseriesId = parseRequiredPositiveInt(
    url.searchParams.get("timeseries_id")
      || url.searchParams.get("entity")
      || url.searchParams.get("entity_id"),
  );
  if (!timeseriesId) {
    return jsonResponse({
      ok: false,
      error: "timeseries_id (or entity/entity_id) must be a positive integer.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const requestedConnectorId = parseRequiredPositiveInt(url.searchParams.get("connector_id"));
  if (url.searchParams.has("connector_id") && !requestedConnectorId) {
    return jsonResponse({
      ok: false,
      error: "connector_id must be a positive integer when provided.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const requestedStationId = parseRequiredPositiveInt(url.searchParams.get("station_id"));
  if (url.searchParams.has("station_id") && !requestedStationId) {
    return jsonResponse({
      ok: false,
      error: "station_id must be a positive integer when provided.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const requestedPollutant = url.searchParams.has("pollutant")
    ? normalizeAqiPollutant(url.searchParams.get("pollutant"))
    : null;
  if (!requestedPollutant) {
    return jsonResponse({
      ok: false,
      error: "pollutant is required and must be one of pm25, pm10, or no2.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const range = resolveTimeRange(url);
  if (!range.ok) {
    return jsonResponse({ ok: false, error: range.error }, { status: 400, cacheSeconds: 30 });
  }
  const { startIso, endIso } = range;
  if (Date.parse(endIso) <= Date.parse(startIso)) {
    return jsonResponse({
      ok: false,
      error: "end_utc/to_utc must be greater than start_utc/from_utc.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const sinceIso = url.searchParams.has("since") || url.searchParams.has("since_utc")
    ? toIsoOrNull(url.searchParams.get("since") || url.searchParams.get("since_utc"))
    : null;
  if ((url.searchParams.has("since") || url.searchParams.has("since_utc")) && !sinceIso) {
    return jsonResponse({
      ok: false,
      error: "since/since_utc must be a valid ISO timestamp when provided.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const limit = parseOptionalPositiveInt(
    url.searchParams.get("row_limit") || url.searchParams.get("limit"),
    1,
    MAX_LIMIT,
  );
  if ((url.searchParams.has("row_limit") || url.searchParams.has("limit")) && limit === null) {
    return jsonResponse({
      ok: false,
      error: `row_limit/limit must be an integer between 1 and ${MAX_LIMIT}.`,
    }, { status: 400, cacheSeconds: 30 });
  }

  const responseFormatRaw = String(url.searchParams.get("format") || "").trim().toLowerCase();
  if (url.searchParams.has("format") && !AQI_RESPONSE_FORMATS.has(responseFormatRaw)) {
    return jsonResponse({
      ok: false,
      error: "format must be one of json, compact, objects, or tsv.",
    }, { status: 400, cacheSeconds: 30 });
  }
  const responseFormat = normalizeAqiResponseFormat(responseFormatRaw);

  const readVersion = resolveR2HistoryVersion(env, { context: "R2 AQI history API reads" });
  const historyPrefix = readVersion === "v2"
    ? (
      normalizePrefix(
        env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX
          || DEFAULT_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX,
      ) || DEFAULT_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX
    )
    : (
      normalizePrefix(env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || DEFAULT_HISTORY_PREFIX)
      || DEFAULT_HISTORY_PREFIX
    );
  const historyIndexPrefix = readVersion === "v2"
    ? (
      normalizePrefix(env.UK_AQ_R2_HISTORY_INDEX_V2_PREFIX || DEFAULT_HISTORY_V2_INDEX_PREFIX)
      || DEFAULT_HISTORY_V2_INDEX_PREFIX
    )
    : (
      normalizePrefix(env.UK_AQ_R2_HISTORY_INDEX_PREFIX || DEFAULT_HISTORY_INDEX_PREFIX)
      || DEFAULT_HISTORY_INDEX_PREFIX
    );
  const timeseriesIndexPrefix = readVersion === "v2"
    ? (
      normalizePrefix(
        env.UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_V2_PREFIX
          || env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX
          || `${historyIndexPrefix}/${DEFAULT_V2_TIMESERIES_INDEX_SUBPREFIX}`,
      ) || `${historyIndexPrefix}/${DEFAULT_V2_TIMESERIES_INDEX_SUBPREFIX}`
    )
    : (
      normalizePrefix(
        env.UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_PREFIX
          || env.UK_AQ_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX
          || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`,
      ) || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`
    );
  const liveObservationFallbackEnabled = parseOptionalBoolean(
    env.UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED,
    DEFAULT_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED,
  );
  const cachePolicy = resolveCachePolicy(env, endIso);
  const { cacheSeconds, cacheScope, mutableHours } = cachePolicy;
  const ingestRetentionDays = parsePositiveInt(
    env.INGESTDB_RETENTION_DAYS,
    DEFAULT_INGESTDB_RETENTION_DAYS,
    1,
    MAX_INGESTDB_RETENTION_DAYS,
  );

  const nowMs = Date.now();
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const effectiveEndMs = Math.min(endMs, nowMs);
  const retentionStartMs = nowMs - ingestRetentionDays * DAY_MS;
  const overlapStartMs = retentionStartMs -
    DEFAULT_OBSAQIDB_RECENT_OVERLAP_DAYS * DAY_MS;
  const splitBoundaryIso = new Date(retentionStartMs).toISOString();
  const overlapStartIso = new Date(overlapStartMs).toISOString();

  const historicalWindow = makeWindow(
    startMs,
    Math.min(effectiveEndMs, overlapStartMs),
  );
  const overlapWindow = makeWindow(
    Math.max(startMs, overlapStartMs),
    Math.min(effectiveEndMs, retentionStartMs),
  );
  const retentionWindow = makeWindow(
    Math.max(startMs, retentionStartMs),
    effectiveEndMs,
  );
  const r2Window = readVersion === "v2"
    ? makeWindow(startMs, effectiveEndMs)
    : makeWindow(
      startMs,
      Math.min(effectiveEndMs, retentionStartMs),
    );
  let obsAqiDbWindow = readVersion === "v2"
    ? null
    : makeWindow(
      Math.min(
        overlapWindow ? overlapWindow.startMs : Number.POSITIVE_INFINITY,
        retentionWindow ? retentionWindow.startMs : Number.POSITIVE_INFINITY,
      ),
      Math.max(
        overlapWindow ? overlapWindow.endMs : Number.NEGATIVE_INFINITY,
        retentionWindow ? retentionWindow.endMs : Number.NEGATIVE_INFINITY,
      ),
    );
  const hasHistoryWindow = Boolean(r2Window);
  const hasObsAqiDbWindow = Boolean(obsAqiDbWindow);
  const isHistoricalOnlyWindow = readVersion === "v2"
    ? false
    : hasHistoryWindow && !hasObsAqiDbWindow;
  let windowContextSourcePath = null;
  let windowContextLookupError = null;
  let windowContextLookupCacheHit = false;
  let windowContextLookupAttempted = false;
  let windowContextLookupSource = null;
  let r2TimeseriesMetadataLookupAttempted = false;
  let r2TimeseriesMetadataLookupFound = false;
  let r2TimeseriesMetadataIndexKey = null;
  let r2TimeseriesMetadata = null;
  let obsAqiDbContextLookupAttempted = false;
  let targetConnectorId = requestedConnectorId || null;
  let targetStationId = requestedStationId || null;
  let targetTimeseriesIds = [timeseriesId];

  const resolveTimeseriesWindowContext = async () => {
    if (windowContextLookupAttempted) {
      return {
        connector_id: targetConnectorId,
        station_id: targetStationId,
        timeseries_ids: targetTimeseriesIds,
      };
    }
    windowContextLookupAttempted = true;

    if (targetConnectorId && (isHistoricalOnlyWindow || readVersion === "v2")) {
      windowContextLookupSource = "request";
      return {
        connector_id: targetConnectorId,
        station_id: targetStationId,
        timeseries_ids: targetTimeseriesIds,
      };
    }

    if (!targetConnectorId && readVersion === "v2" && hasHistoryWindow) {
      r2TimeseriesMetadataLookupAttempted = true;
      try {
        const metadataLookup = await readTimeseriesWindowContextFromR2Metadata({
          env,
          historyIndexPrefix,
          timeseriesId,
        });
        r2TimeseriesMetadataIndexKey = metadataLookup.source_path;
        r2TimeseriesMetadataLookupFound = Boolean(metadataLookup.found);
        r2TimeseriesMetadata = metadataLookup.metadata || null;
        if (metadataLookup.found) {
          windowContextLookupSource = "r2_metadata";
          targetConnectorId = parseRequiredPositiveInt(metadataLookup.connector_id) || targetConnectorId;
          targetStationId = parseRequiredPositiveInt(metadataLookup.station_id) || targetStationId;
          targetTimeseriesIds = Array.isArray(metadataLookup.timeseries_ids)
            && metadataLookup.timeseries_ids.length > 0
            ? metadataLookup.timeseries_ids
            : [timeseriesId];
          if (isHistoricalOnlyWindow || readVersion === "v2") {
            return {
              connector_id: targetConnectorId,
              station_id: targetStationId,
              timeseries_ids: targetTimeseriesIds,
            };
          }
        }
      } catch (error) {
        windowContextLookupError = error instanceof Error ? error.message : String(error);
      }
    }

    if (liveObservationFallbackEnabled && readVersion === "v2") {
      windowContextLookupSource = windowContextLookupSource || "live_observation_no_materialised_context";
      return { connector_id: targetConnectorId, station_id: targetStationId, timeseries_ids: targetTimeseriesIds };
    }

    try {
      obsAqiDbContextLookupAttempted = true;
      const lookup = await readTimeseriesWindowContextFromObsAqiDb({
        env,
        timeseriesId,
        startIso,
        endIso,
      });
      windowContextLookupSource = "obs_aqidb";
      windowContextSourcePath = lookup.source_path;
      windowContextLookupCacheHit = lookup.cache_hit;
      targetConnectorId = parseRequiredPositiveInt(lookup.connector_id) || targetConnectorId;
      targetStationId = parseRequiredPositiveInt(lookup.station_id) || targetStationId;
      const windowTimeseriesIds = Array.isArray(lookup.timeseries_ids)
        ? lookup.timeseries_ids
          .map((value) => parseRequiredPositiveInt(value))
          .filter((value) => Number.isFinite(value) && value > 0)
        : [];
      targetTimeseriesIds = windowTimeseriesIds.length > 0
        ? Array.from(new Set(windowTimeseriesIds))
        : [timeseriesId];
    } catch (error) {
      windowContextLookupError = error instanceof Error ? error.message : String(error);
      targetConnectorId = requestedConnectorId || null;
      targetStationId = requestedStationId || null;
      targetTimeseriesIds = [timeseriesId];
    }

    return {
      connector_id: targetConnectorId,
      station_id: targetStationId,
      timeseries_ids: targetTimeseriesIds,
    };
  };

  const historyContext = await resolveTimeseriesWindowContext();
  const historyConnectorId = parseRequiredPositiveInt(historyContext.connector_id);
  const historyTargetTimeseriesIds = Array.isArray(historyContext.timeseries_ids)
    ? historyContext.timeseries_ids
    : [timeseriesId];

  const r2Read = hasHistoryWindow
    ? await readHistoryRows({
      env,
      readVersion,
      historyPrefix,
      historyIndexPrefix,
      timeseriesIndexPrefix,
      connectorId: historyConnectorId,
      stationId: parseRequiredPositiveInt(historyContext.station_id),
      targetTimeseriesIds: historyTargetTimeseriesIds,
      startIso: r2Window.startIso,
      endIso: r2Window.endIso,
      sinceIso,
      pollutantKey: requestedPollutant,
      limit: null,
    })
    : buildEmptyHistoryRead();
  const resolvedR2ConnectorId = parseRequiredPositiveInt(r2Read.resolved_connector_id);
  if (!targetConnectorId && resolvedR2ConnectorId) {
    targetConnectorId = resolvedR2ConnectorId;
  }

  let recentFallbackRead = buildEmptyRecentRead();
  const historyScanStoppedReason = r2Read?.timeseries_index?.scan_stopped_reason || null;
  const historyScanComplete = historyScanStoppedReason === null;
  const historicalR2Points = historicalWindow
    ? filterPointsToWindow(r2Read.points, historicalWindow.startMs, historicalWindow.endMs)
    : [];
  const overlapR2Points = overlapWindow
    ? filterPointsToWindow(r2Read.points, overlapWindow.startMs, overlapWindow.endMs)
    : [];
  const recentR2PointCount = overlapWindow
    ? overlapR2Points.length
    : 0;
  const v2R2FullRangePoints = readVersion === "v2" && r2Window
    ? filterPointsToWindow(r2Read.points, r2Window.startMs, r2Window.endMs)
    : [];
  const r2ExpectedCoverage = readVersion === "v2"
    ? summarizeExpectedAqiHourCoverage(v2R2FullRangePoints, {
      startIso,
      endIso,
      sinceIso,
      timeseriesId,
      pollutantKey: requestedPollutant,
    })
    : null;
  if (readVersion === "v2" && r2Window && r2ExpectedCoverage && !r2ExpectedCoverage.complete) {
    obsAqiDbWindow = makeWindowCoveringIsoHours(r2ExpectedCoverage.missing_hours);
  }
  const hasResolvedObsAqiDbWindow = Boolean(obsAqiDbWindow);
  // Temporary legacy rollback path: while UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED is false,
  // preserve the deployed materialised Supabase AQI fallback. When true, do not read
  // materialised AQI; the enabled path is R2 AQI > live observation calculation > no row.
  const shouldFetchRecentFallback = hasResolvedObsAqiDbWindow && !liveObservationFallbackEnabled;

  if (shouldFetchRecentFallback) {
    try {
      const obsAqiRecentRead = await readRecentRowsFromObsAqiDb({
        env,
        timeseriesId,
        startIso: obsAqiDbWindow.startIso,
        endIso: obsAqiDbWindow.endIso,
        sinceIso,
        pollutantKey: requestedPollutant,
      });
      recentFallbackRead = {
        ...obsAqiRecentRead,
        status: "fallback_live",
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recentFallbackRead = buildEmptyRecentRead("fallback_error", message);
      if (readVersion !== "v2" && r2Read.points.length === 0) {
        throw new Error(
          `R2 AQI history is unavailable and ObsAQIDB fallback failed (${message}).`,
        );
      }
    }
  }

  let liveCalculatedPoints = [];
  let liveFallbackError = null;
  const missingHourWindows = coalesceAqiMissingHourWindows(r2ExpectedCoverage?.missing_hours || [], {
    contextHours: requestedPollutant === "pm25" || requestedPollutant === "pm10" ? 23 : 0,
  });
  const liveFallbackDiagnostics = {
    requested: Boolean(readVersion === "v2" && obsAqiDbWindow),
    enabled: liveObservationFallbackEnabled,
    materialised_aqi_fallback_queried: shouldFetchRecentFallback,
    mutable_hours: mutableHours,
    ingest_retention_boundary_utc: splitBoundaryIso,
    missing_aqi_hour_count: r2ExpectedCoverage?.missing_hour_count || 0,
    missing_hour_windows: liveObservationFallbackEnabled ? missingHourWindows : [],
    r2_observation_row_count: 0,
    ingest_observation_row_count: 0,
    discarded_ingest_overlap_count: 0,
    invalid_observation_count: 0,
    live_calculated_row_count: 0,
    status: liveObservationFallbackEnabled ? "not_requested" : "legacy_materialised_fallback",
  };
  if (liveObservationFallbackEnabled && readVersion === "v2" && obsAqiDbWindow && missingHourWindows.length > 0) {
    try {
      const liveWindowStartIso = missingHourWindows[0].start_utc;
      const liveWindowEndIso = missingHourWindows[missingHourWindows.length - 1].end_utc;
      const retentionLimitedStartMs = Math.max(Date.parse(liveWindowStartIso), retentionStartMs, nowMs - mutableHours * HOUR_MS);
      if (!Number.isFinite(retentionLimitedStartMs) || retentionLimitedStartMs >= Date.parse(liveWindowEndIso)) {
        liveFallbackDiagnostics.status = "outside_live_calculation_horizon";
      } else {
        const boundedStartIso = new Date(retentionLimitedStartMs).toISOString();
        const authHeader = request.headers.get(UPSTREAM_AUTH_HEADER) || env.UK_AQ_EDGE_UPSTREAM_SECRET || "";
        const r2ObsRead = await readLiveR2ObservationRows({
          env,
          timeseriesId,
          connectorId: targetConnectorId,
          stationId: targetStationId,
          pollutantKey: requestedPollutant,
          startIso: boundedStartIso,
          endIso: liveWindowEndIso,
          authHeader,
        });
        const ingestRead = await readRecentIngestObservationRows({
          env,
          timeseriesId,
          connectorId: targetConnectorId,
          stationId: targetStationId,
          pollutantKey: requestedPollutant,
          startIso: boundedStartIso,
          endIso: liveWindowEndIso,
        });
        const mergedObservations = mergeObservationRowsPreferR2({ r2Rows: r2ObsRead.rows, ingestRows: ingestRead.rows });
        liveFallbackDiagnostics.r2_observation_row_count = r2ObsRead.rows.length;
        liveFallbackDiagnostics.ingest_observation_row_count = ingestRead.rows.length;
        liveFallbackDiagnostics.discarded_ingest_overlap_count = mergedObservations.discarded_ingest_overlap_count;
        const dayRowsByKey = new Map();
        for (const hour of r2ExpectedCoverage?.missing_hours || []) {
          const hourMs = Date.parse(hour);
          if (!Number.isFinite(hourMs) || hourMs < retentionLimitedStartMs) continue;
          const dayUtc = dayUtcFromIso(hour);
          const calculated = buildAqilevelHistoryRowsForDayFromSourceObservations(mergedObservations.rows, dayUtc)
            .filter((row) => row.timeseries_id === timeseriesId && row.pollutant_code === requestedPollutant);
          for (const row of calculated) {
            const key = `${row.timeseries_id}|${row.pollutant_code}|${row.timestamp_hour_utc}`;
            dayRowsByKey.set(key, row);
          }
        }
        const missingSet = new Set(r2ExpectedCoverage?.missing_hours || []);
        const liveRows = Array.from(dayRowsByKey.values()).filter((row) => missingSet.has(row.timestamp_hour_utc));
        liveCalculatedPoints = projectLiveAqiRowsToResponseRows(liveRows);
        liveFallbackDiagnostics.live_calculated_row_count = liveCalculatedPoints.length;
        liveFallbackDiagnostics.status = "calculated";
      }
    } catch (error) {
      liveFallbackError = error instanceof Error ? error.message : String(error);
      liveFallbackDiagnostics.status = "error";
      liveFallbackDiagnostics.error = liveFallbackError;
    }
  }

  const v2ObsAqiDbCandidatePoints = readVersion === "v2" && obsAqiDbWindow
    ? filterPointsToWindow(recentFallbackRead.points, obsAqiDbWindow.startMs, obsAqiDbWindow.endMs)
    : [];
  const v2ObsAqiDbFillPoints = readVersion === "v2" && obsAqiDbWindow
    ? filterPointsToMissingRows(
      v2ObsAqiDbCandidatePoints,
      v2R2FullRangePoints,
      obsAqiDbWindow.startMs,
      obsAqiDbWindow.endMs,
    )
    : [];
  const overlapObsAqiDbCandidatePoints = overlapWindow
    ? filterPointsToWindow(recentFallbackRead.points, overlapWindow.startMs, overlapWindow.endMs)
    : [];
  const overlapObsAqiDbFillPoints = overlapWindow
    ? filterPointsToMissingRows(
      overlapObsAqiDbCandidatePoints,
      overlapR2Points,
      overlapWindow.startMs,
      overlapWindow.endMs,
    )
    : [];
  const retentionObsAqiDbPoints = retentionWindow
    ? filterPointsToWindow(recentFallbackRead.points, retentionWindow.startMs, retentionWindow.endMs)
    : [];
  const annotatedHistoricalR2Points = historicalR2Points.map((row) => ({
    ...row,
    source_coverage: "historical",
  }));
  const annotatedOverlapR2Points = overlapR2Points.map((row) => ({
    ...row,
    source_coverage: "overlap",
  }));
  const annotatedOverlapObsAqiDbFillPoints = overlapObsAqiDbFillPoints.map((row) => ({
    ...row,
    source_coverage: "overlap",
  }));
  const annotatedRetentionObsAqiDbPoints = retentionObsAqiDbPoints.map((row) => ({
    ...row,
    source_coverage: "retention",
  }));
  const annotatedV2R2FullRangePoints = v2R2FullRangePoints.map((row) => ({
    ...row,
    source_coverage: "r2_first_full_range",
  }));
  const annotatedV2ObsAqiDbFillPoints = v2ObsAqiDbFillPoints.map((row) => ({
    ...row,
    source_coverage: "obs_aqidb_fill",
  }));
  const obsAqiDbMergePoints = readVersion === "v2"
    ? (liveObservationFallbackEnabled ? liveCalculatedPoints : annotatedV2ObsAqiDbFillPoints)
    : [
      ...annotatedOverlapObsAqiDbFillPoints,
      ...annotatedRetentionObsAqiDbPoints,
    ];
  const r2MergePoints = readVersion === "v2"
    ? annotatedV2R2FullRangePoints
    : [
      ...annotatedHistoricalR2Points,
      ...annotatedOverlapR2Points,
    ];
  const preLimitPoints = liveObservationFallbackEnabled && readVersion === "v2"
    ? mergeAqiRowsPreferR2({ r2Rows: r2MergePoints, liveRows: [] })
    : mergePointsPreferPrimary(
      r2MergePoints,
      obsAqiDbMergePoints,
      null,
    );
  const points = limit !== null && preLimitPoints.length > limit
    ? preLimitPoints.slice(preLimitPoints.length - limit)
    : preLimitPoints;
  const rowLimitApplied = limit !== null && preLimitPoints.length > points.length;
  const rowSummary = summarizeAqiHistoryRows(points);
  let source = readVersion === "v2" ? "r2_first" : "r2_only";
  if (points.length === 0) {
    source = "no_data_in_window";
  } else if (r2MergePoints.length === 0 && obsAqiDbMergePoints.length > 0) {
    source = readVersion === "v2" ? "obs_aqidb_fill_only_r2_unavailable" : "obs_aqidb_retention_only";
  } else if (r2MergePoints.length > 0 && obsAqiDbMergePoints.length > 0) {
    source = readVersion === "v2"
      ? "r2_first_with_obs_aqidb_fill"
      : overlapObsAqiDbFillPoints.length > 0 && retentionObsAqiDbPoints.length > 0
      ? "r2_plus_obs_aqidb_overlap_fill_and_retention"
      : overlapObsAqiDbFillPoints.length > 0
      ? "r2_plus_obs_aqidb_overlap_fill"
      : "r2_plus_obs_aqidb_retention";
  }
  const historicalR2PartialReasons = collectR2PartialReasonsForWindow(
    r2Read,
    historicalWindow,
  );
  const overlapR2PartialReasons = collectR2PartialReasonsForWindow(
    r2Read,
    overlapWindow,
  );
  const partialReasons = new Set([
    ...historicalR2PartialReasons.map((reason) => `historical:${reason}`),
  ]);
  if (liveFallbackError) {
    partialReasons.add("live_observation_read_failed");
  }
  if (hasResolvedObsAqiDbWindow && recentFallbackRead.status === "fallback_error") {
    partialReasons.add(`obs_aqidb:${recentFallbackRead.error || "fallback_error"}`);
  }
  const expectedCoverage = summarizeExpectedAqiHourCoverage(preLimitPoints, {
    startIso,
    endIso,
    sinceIso,
    timeseriesId,
    pollutantKey: requestedPollutant,
  });
  const mergedExpectedCoverage = expectedCoverage;
  if (!expectedCoverage.complete) {
    partialReasons.add("missing_expected_aqi_hours");
  }
  const responseComplete = partialReasons.size === 0 && expectedCoverage.complete;
  const hasGap = !responseComplete;
  const coverageState = responseComplete ? "complete" : "partial";
  const partialReasonList = Array.from(partialReasons);
  const historicalR2PointCount = historicalWindow
    ? countPointsInWindow(r2Read.points, historicalWindow.startMs, historicalWindow.endMs)
    : 0;
  const retentionObsAqiStatus = retentionWindow
    ? recentFallbackRead.status === "fallback_live"
      ? "obs_aqidb_live"
      : recentFallbackRead.status
    : "not_requested";
  const overlapObsAqiStatus = overlapWindow
    ? recentFallbackRead.status === "fallback_live"
      ? "obs_aqidb_live"
      : recentFallbackRead.status
    : "not_requested";
  const liveCalculationStatusCounts = summarizeAqiCalculationStatuses(liveCalculatedPoints);
  const legacySourceCoverage = [
    historicalWindow
      ? {
        zone: "historical",
        source: "r2",
        from_utc: historicalWindow.startIso,
        to_utc: historicalWindow.endIso,
        status: historicalR2PartialReasons.length === 0 ? "complete" : "partial",
        row_count: historicalR2PointCount,
        partial_reasons: historicalR2PartialReasons,
      }
      : null,
    overlapWindow
      ? {
        zone: "overlap",
        source: "r2_preferred_obs_aqidb_missing_hour_fill",
        from_utc: overlapWindow.startIso,
        to_utc: overlapWindow.endIso,
        status: recentFallbackRead.status === "fallback_error" ? "partial" : "complete",
        r2_row_count: overlapR2Points.length,
        obs_aqidb_candidate_row_count: overlapObsAqiDbCandidatePoints.length,
        obs_aqidb_fill_row_count: overlapObsAqiDbFillPoints.length,
        r2_partial_reasons: overlapR2PartialReasons,
        obs_aqidb_status: overlapObsAqiStatus,
      }
      : null,
    retentionWindow
      ? {
        zone: "retention",
        source: "obs_aqidb",
        from_utc: retentionWindow.startIso,
        to_utc: retentionWindow.endIso,
        status: recentFallbackRead.status === "fallback_live" ? "complete" : "partial",
        row_count: retentionObsAqiDbPoints.length,
        obs_aqidb_status: retentionObsAqiStatus,
      }
      : null,
  ].filter(Boolean);
  const sourceCoverage = readVersion === "v2"
    ? [
      r2Window
        ? {
          zone: "full_range",
          source: "r2_first",
          from_utc: r2Window.startIso,
          to_utc: r2Window.endIso,
          status: r2ExpectedCoverage?.complete ? "complete" : "partial",
          row_count: v2R2FullRangePoints.length,
          expected_hour_coverage: r2ExpectedCoverage,
          partial_reasons: r2ExpectedCoverage?.complete ? [] : ["missing_expected_aqi_hours"],
        }
        : null,
      obsAqiDbWindow
        ? {
          zone: "fill",
          source: "obs_aqidb_fill",
          from_utc: obsAqiDbWindow.startIso,
          to_utc: obsAqiDbWindow.endIso,
          status: recentFallbackRead.status === "fallback_error" ? "partial" : "complete",
          obs_aqidb_candidate_row_count: v2ObsAqiDbCandidatePoints.length,
          obs_aqidb_fill_row_count: v2ObsAqiDbFillPoints.length,
          obs_aqidb_status: recentFallbackRead.status === "fallback_live"
            ? "obs_aqidb_live"
            : recentFallbackRead.status,
        }
        : null,
    ].filter(Boolean)
    : legacySourceCoverage;

  const responseRows = points.map((row) => projectAqiHistoryResponseRow(row));
  const responseColumns = getAqiHistoryResponseColumns();
  const compactPoints = buildAqiHistoryCompactRows(responseRows);
  const responsePayload = {
    ok: true,
    request_id: requestId,
    generated_at_utc: new Date().toISOString(),
    read_version: readVersion,
    index_version: readVersion,
    data_profile: readVersion === "v2" ? "hourly_data" : "v1",
    history_prefix: historyPrefix,
    history_index_prefix: historyIndexPrefix,
    timeseries_index_prefix: timeseriesIndexPrefix,
    source,
    source_split_boundary_utc: splitBoundaryIso,
    overlap_start_utc: overlapStartIso,
    retention_start_utc: splitBoundaryIso,
    source_of_truth_days: ingestRetentionDays,
    source_of_truth_hours: ingestRetentionDays * 24,
    cache_scope: cacheScope,
    aqi_mutable_hours: mutableHours,
    scope,
    grain,
    pollutant: requestedPollutant,
    entity_id: String(timeseriesId),
    timeseries_id: timeseriesId,
    station_id: targetStationId,
    connector_id: targetConnectorId,
    query_from_utc: startIso,
    query_to_utc: endIso,
    since_utc: sinceIso,
    row_count: points.length,
    row_limit_applied: rowLimitApplied,
    row_limit: limit,
    pre_limit_row_count: preLimitPoints.length,
    returned_row_count: points.length,
    response_complete: responseComplete,
    has_gap: hasGap,
    coverage_state: coverageState,
    partial_reasons: partialReasonList,
    expected_hour_count: expectedCoverage.expected_hour_count,
    present_expected_hour_count: expectedCoverage.present_hour_count,
    missing_expected_hour_count: expectedCoverage.missing_hour_count,
    missing_expected_hours: expectedCoverage.missing_hours,
    wire_format: responseFormat === "tsv" ? "tsv" : "json",
    data_format: responseFormat === "objects" ? "objects" : "compact",
    columns: responseColumns,
    points: responseFormat === "objects" ? responseRows : compactPoints,
    meta: {
      source,
      response_complete: responseComplete,
      row_count: points.length,
      raw_row_count: preLimitPoints.length,
      row_limit_applied: rowLimitApplied,
      row_limit: limit,
      pre_limit_row_count: preLimitPoints.length,
      returned_row_count: points.length,
      parsed_point_count: rowSummary.parsed_point_count,
      daqi_count: rowSummary.daqi_count,
      eaqi_count: rowSummary.eaqi_count,
      null_daqi_count: rowSummary.null_daqi_count,
      null_eaqi_count: rowSummary.null_eaqi_count,
      source_counts: rowSummary.source_counts,
      source_coverage_counts: rowSummary.source_coverage_counts,
      pollutant_counts: rowSummary.pollutant_counts,
      daqi_status_counts: rowSummary.daqi_status_counts,
      eaqi_status_counts: rowSummary.eaqi_status_counts,
      daqi_missing_reason_counts: rowSummary.daqi_missing_reason_counts,
      eaqi_missing_reason_counts: rowSummary.eaqi_missing_reason_counts,
      data_format: responseFormat === "objects" ? "objects" : "compact",
      wire_format: responseFormat === "tsv" ? "tsv" : "json",
      read_version: readVersion,
      index_version: readVersion,
      data_profile: readVersion === "v2" ? "hourly_data" : "v1",
      history_prefix: historyPrefix,
      history_index_prefix: historyIndexPrefix,
      timeseries_index_prefix: timeseriesIndexPrefix,
      used_r2: r2MergePoints.length > 0 || hasHistoryWindow,
      used_supabase: obsAqiDbContextLookupAttempted || recentFallbackRead.status === "fallback_live",
      connector_id_source: windowContextLookupSource,
      used_r2_timeseries_metadata_lookup: r2TimeseriesMetadataLookupFound,
      used_supabase_connector_lookup: obsAqiDbContextLookupAttempted,
      timeseries_id: timeseriesId,
      station_id: targetStationId,
      connector_id: targetConnectorId,
      pollutant: requestedPollutant,
      query_from_utc: startIso,
      query_to_utc: endIso,
      source_split_boundary_utc: splitBoundaryIso,
      overlap_start_utc: overlapStartIso,
      retention_start_utc: splitBoundaryIso,
      source_of_truth_days: ingestRetentionDays,
      source_of_truth_hours: ingestRetentionDays * 24,
      aqi_mutable_hours: mutableHours,
      has_gap: hasGap,
      coverage_state: coverageState,
      partial_reasons: partialReasonList,
      r2_expected_hour_coverage: r2ExpectedCoverage,
      expected_hour_coverage: mergedExpectedCoverage,
      row_summary: rowSummary,
      scan_metrics: r2Read.scan_metrics,
      coverage: {
        ingest_retention_days: ingestRetentionDays,
        overlap_start_utc: overlapStartIso,
        retention_start_utc: splitBoundaryIso,
        historical_window_from_utc: windowStartIso(historicalWindow),
        historical_window_to_utc: windowEndIso(historicalWindow),
        overlap_window_from_utc: windowStartIso(overlapWindow),
        overlap_window_to_utc: windowEndIso(overlapWindow),
        retention_window_from_utc: windowStartIso(retentionWindow),
        retention_window_to_utc: windowEndIso(retentionWindow),
        r2_window_from_utc: windowStartIso(r2Window),
        r2_window_to_utc: windowEndIso(r2Window),
        obs_aqidb_window_from_utc: windowStartIso(obsAqiDbWindow),
        obs_aqidb_window_to_utc: windowEndIso(obsAqiDbWindow),
        source_coverage: sourceCoverage,
        history_scan_complete: historyScanComplete,
        history_scan_stopped_reason: historyScanStoppedReason,
        obs_aqidb_status: hasResolvedObsAqiDbWindow ? recentFallbackRead.status : "not_requested",
        row_summary: rowSummary,
        r2_expected_hour_coverage: r2ExpectedCoverage,
        merged_expected_hour_coverage: mergedExpectedCoverage,
        expected_hour_coverage: mergedExpectedCoverage,
      },
    },
    coverage: {
      read_version: readVersion,
      index_version: r2Read.timeseries_index?.index_version || readVersion,
      data_profile: r2Read.timeseries_index?.data_profile || (readVersion === "v2" ? "hourly_data" : "v1"),
      history_prefix: historyPrefix,
      history_index_prefix: historyIndexPrefix,
      timeseries_index_prefix: timeseriesIndexPrefix,
      pollutant_partition: r2Read.timeseries_index?.pollutant_partition || null,
      days_requested: r2Read.days_requested ?? r2Read.days_scanned,
      days_scanned: r2Read.days_scanned,
      scanned_connector_manifests: r2Read.scanned_connector_manifests,
      scanned_parquet_files: r2Read.scanned_parquet_files,
      r2_object_reads: r2Read.scan_metrics?.r2_object_reads ?? null,
      r2_list_operations: r2Read.scan_metrics?.r2_list_operations ?? 0,
      parquet_row_groups_scanned: r2Read.scan_metrics?.parquet_row_groups_scanned ?? null,
      parquet_chunks_scanned: r2Read.scan_metrics?.parquet_chunks_scanned ?? null,
      parquet_filter_rows_decoded: r2Read.scan_metrics?.parquet_filter_rows_decoded ?? null,
      parquet_payload_rows_decoded: r2Read.scan_metrics?.parquet_payload_rows_decoded ?? null,
      parquet_matched_rows: r2Read.scan_metrics?.parquet_matched_rows ?? null,
      parquet_bytes_read: r2Read.scan_metrics?.parquet_bytes_read ?? null,
      scan_metrics: r2Read.scan_metrics,
      missing_day_manifest_keys: r2Read.missing_day_manifest_keys,
      missing_connector_manifest_keys: r2Read.missing_connector_manifest_keys,
      missing_parquet_keys: r2Read.missing_parquet_keys,
      target_connector_id: targetConnectorId,
      target_station_id: targetStationId,
      resolved_connector_id: resolvedR2ConnectorId,
      connector_id_source: windowContextLookupSource,
      timeseries_metadata_index_key: r2TimeseriesMetadataIndexKey,
      r2_timeseries_metadata_lookup_attempted: r2TimeseriesMetadataLookupAttempted,
      r2_timeseries_metadata_lookup_found: r2TimeseriesMetadataLookupFound,
      used_r2_timeseries_metadata_lookup: r2TimeseriesMetadataLookupFound,
      used_supabase_connector_lookup: obsAqiDbContextLookupAttempted,
      r2_timeseries_metadata: r2TimeseriesMetadata,
      timeseries_window_context_lookup_source_path: windowContextSourcePath,
      timeseries_window_context_lookup_source: windowContextLookupSource,
      timeseries_window_context_lookup_error: windowContextLookupError,
      timeseries_window_context_lookup_cache_hit: windowContextLookupAttempted
        ? windowContextLookupCacheHit
        : false,
      target_timeseries_id_count: Array.isArray(targetTimeseriesIds)
        ? targetTimeseriesIds.length
        : 0,
      row_summary: rowSummary,
      ingest_retention_days: ingestRetentionDays,
      overlap_start_utc: overlapStartIso,
      retention_start_utc: splitBoundaryIso,
      response_complete: responseComplete,
      has_gap: hasGap,
      coverage_state: coverageState,
      partial_reasons: partialReasonList,
      r2_expected_hour_coverage: r2ExpectedCoverage,
      merged_expected_hour_coverage: mergedExpectedCoverage,
      expected_hour_coverage: mergedExpectedCoverage,
      source_coverage: sourceCoverage,
      history_scan_complete: historyScanComplete,
      history_scan_stopped_reason: historyScanStoppedReason,
      timeseries_index: r2Read.timeseries_index,
      obs_aqidb_source_path: recentFallbackRead.source_path,
      obs_aqidb_row_count: obsAqiDbMergePoints.length,
      obs_aqidb_raw_row_count: recentFallbackRead.points.length,
      obs_aqidb_status: hasResolvedObsAqiDbWindow ? recentFallbackRead.status : "not_requested",
      obs_aqidb_error: recentFallbackRead.error,
      historical_window_from_utc: windowStartIso(historicalWindow),
      historical_window_to_utc: windowEndIso(historicalWindow),
      overlap_window_from_utc: windowStartIso(overlapWindow),
      overlap_window_to_utc: windowEndIso(overlapWindow),
      retention_window_from_utc: windowStartIso(retentionWindow),
      retention_window_to_utc: windowEndIso(retentionWindow),
      r2_window_from_utc: windowStartIso(r2Window),
      r2_window_to_utc: windowEndIso(r2Window),
      obs_aqidb_window_from_utc: windowStartIso(obsAqiDbWindow),
      obs_aqidb_window_to_utc: windowEndIso(obsAqiDbWindow),
      obs_aqidb_fallback_used: hasResolvedObsAqiDbWindow && recentFallbackRead.status === "fallback_live",
      obs_aqidb_fallback_reason: shouldFetchRecentFallback
        ? (readVersion === "v2" ? "r2_missing_expected_hour_fill" : "overlap_missing_hour_fill_and_retention")
        : null,
      obs_aqidb_fallback_recent_r2_point_count: recentR2PointCount,
      historical_r2_point_count: historicalR2PointCount,
      overlap_r2_point_count: overlapR2Points.length,
      overlap_obs_aqidb_candidate_row_count: overlapObsAqiDbCandidatePoints.length,
      overlap_obs_aqidb_fill_row_count: overlapObsAqiDbFillPoints.length,
      retention_obs_aqidb_row_count: retentionObsAqiDbPoints.length,
      obs_aqidb_fallback_error: recentFallbackRead.status === "fallback_error"
        ? recentFallbackRead.error
        : null,
    },
  };
  const durationMs = Date.now() - requestStartedAtMs;
  console.log(JSON.stringify({
    event: "aqi_history_request",
    request_id: requestId,
    read_version: readVersion,
    index_version: r2Read.timeseries_index?.index_version || readVersion,
    data_profile: r2Read.timeseries_index?.data_profile || (readVersion === "v2" ? "hourly_data" : "v1"),
    timeseries_id: timeseriesId,
    station_id: targetStationId,
    connector_id: targetConnectorId,
    connector_id_source: windowContextLookupSource,
    used_r2_timeseries_metadata_lookup: r2TimeseriesMetadataLookupFound,
    used_supabase_connector_lookup: obsAqiDbContextLookupAttempted,
    pollutant: requestedPollutant,
    from_utc: startIso,
    to_utc: endIso,
    days_requested: r2Read.days_requested ?? r2Read.days_scanned,
    days_scanned: r2Read.days_scanned,
    manifests_scanned: r2Read.scanned_connector_manifests,
    parquet_files_scanned: r2Read.scanned_parquet_files,
    index_hit_count: r2Read.timeseries_index?.hit_count ?? 0,
    index_miss_count: r2Read.timeseries_index?.miss_count ?? 0,
    r2_object_reads: r2Read.scan_metrics?.r2_object_reads ?? null,
    r2_list_operations: r2Read.scan_metrics?.r2_list_operations ?? 0,
    parquet_bytes_read: r2Read.scan_metrics?.parquet_bytes_read ?? null,
    row_count: points.length,
    duration_ms: durationMs,
    response_complete: responseComplete,
    stopped_early: Boolean(r2Read.scan_metrics?.stopped_early),
    stopped_reason: historyScanStoppedReason,
    timeseries_index_enabled: r2Read.timeseries_index?.enabled ?? null,
    timeseries_index_prefix: r2Read.timeseries_index?.prefix ?? null,
    pollutant_partition: r2Read.timeseries_index?.pollutant_partition ?? null,
  }));

  let response;
  const responseExtraHeaders = {
    "X-UK-AQ-Request-ID": requestId,
    "X-UK-AQ-Response-Complete": responseComplete ? "true" : "false",
    ...(responseComplete ? {} : { "Cache-Control": "no-store" }),
  };
  if (responseFormat === "tsv") {
    response = new Response(buildTsvResponseBody(responseColumns, responseRows), {
      status: 200,
      headers: {
        "Content-Type": "text/tab-separated-values; charset=utf-8",
        "Cache-Control": responseComplete ? cacheControlHeader(cacheSeconds) : "no-store",
        "X-UK-AQ-Request-ID": requestId,
        "X-UK-AQ-Response-Complete": responseComplete ? "true" : "false",
        ...corsHeaders(),
      },
    });
  } else {
    response = jsonResponse(responsePayload, {
      status: 200,
      cacheSeconds,
      extraHeaders: responseExtraHeaders,
    });
  }

  return response;
}

export {
  buildExpectedAqiHourBuckets,
  summarizeExpectedAqiHourCoverage,
  mergePointsPreferPrimary,
  filterPointsToMissingRows,
  extractParquetKeysFromTimeseriesIndex,
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "Method not allowed." }, {
        status: 405,
        cacheSeconds: 30,
      });
    }

    const authResult = authorized(request, env);
    if (!authResult.ok) {
      return jsonResponse({ ok: false, error: authResult.error }, {
        status: authResult.status,
        cacheSeconds: 30,
      });
    }

    const internalResponseCacheEnabled = isInternalResponseCacheEnabled(env);
    const cacheKey = internalResponseCacheEnabled
      ? buildAqiHistoryResponseCacheKey(request, env)
      : null;
    if (internalResponseCacheEnabled && cacheKey) {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        return withCacheMarker(cached, "HIT");
      }
    }

    let response;
    try {
      response = await handleRequest(request, env, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response = jsonResponse({ ok: false, error: message }, {
        status: 500,
        cacheSeconds: 30,
      });
    }

    if (!internalResponseCacheEnabled) {
      return withCacheMarker(forceDirectAuthenticatedNoStore(response), "BYPASS");
    }

    if (
      response.ok
      && response.headers.get("X-UK-AQ-Response-Complete") !== "false"
      && cacheKey
      && ctx
      && typeof ctx.waitUntil === "function"
    ) {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    }
    return withCacheMarker(response, "MISS");
  },
};
