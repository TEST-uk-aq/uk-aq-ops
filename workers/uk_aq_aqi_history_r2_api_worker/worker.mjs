import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const DEFAULT_HISTORY_PREFIX = "history/v1/aqilevels";
const DEFAULT_HISTORY_BANDS_PREFIX = "history/v1/aqilevels/bands/v1";
const DEFAULT_HISTORY_INDEX_PREFIX = "history/_index";
const DEFAULT_TIMESERIES_INDEX_SUBPREFIX = "aqilevels_timeseries";
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
const DEFAULT_MAX_SCAN_ELAPSED_MS = 18000;
const MIN_MAX_SCAN_ELAPSED_MS = 1000;
const MAX_MAX_SCAN_ELAPSED_MS = 120000;
const UK_AQ_PUBLIC_SCHEMA_DEFAULT = "uk_aq_public";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AQI_HISTORY_MUTABLE_WINDOW_MS = 24 * HOUR_MS;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const VALID_PATHS = new Set(["/", "/v1/aqi-history"]);
const TIMESERIES_AQI_HOURLY_VIEW = "uk_aq_timeseries_aqi_hourly";
const AQI_PARQUET_COLUMNS = [
  "timeseries_id",
  "timestamp_hour_utc",
  "pollutant_code",
  "daqi_index_level",
  "eaqi_index_level",
  "daqi_no2_index_level",
  "daqi_pm25_rolling24h_index_level",
  "daqi_pm10_rolling24h_index_level",
  "eaqi_no2_index_level",
  "eaqi_pm25_index_level",
  "eaqi_pm10_index_level",
];
const AQI_BAND_CACHE_COLUMNS = [
  "period_start_utc",
  "timestamp_hour_utc",
  "timeseries_id",
  "station_id",
  "connector_id",
  "pollutant_code",
  "daqi_index_level",
  "eaqi_index_level",
  "daqi_no2_index_level",
  "daqi_pm25_rolling24h_index_level",
  "daqi_pm10_rolling24h_index_level",
  "eaqi_no2_index_level",
  "eaqi_pm25_index_level",
  "eaqi_pm10_index_level",
];
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

function cacheControlHeader(cacheSeconds) {
  return `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`;
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
  const endMs = Date.parse(endIso);
  const immutable = Number.isFinite(endMs) && endMs <= (Date.now() - AQI_HISTORY_MUTABLE_WINDOW_MS);
  return {
    cacheSeconds: immutable ? immutableCacheSeconds : mutableCacheSeconds,
    cacheScope: immutable ? "immutable" : "recent",
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

async function fetchJsonObjectFromR2(env, key) {
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

function getAqiBandCacheColumns() {
  return AQI_BAND_CACHE_COLUMNS.slice();
}

function rowToAqiBandCompactRow(row) {
  return AQI_BAND_CACHE_COLUMNS.map((columnName) => {
    if (columnName === "timestamp_hour_utc") {
      return row?.timestamp_hour_utc || row?.period_start_utc || null;
    }
    return row?.[columnName] ?? null;
  });
}

function expandAqiBandCompactPayload(payload) {
  const columns = Array.isArray(payload?.columns) ? payload.columns : [];
  const rawPoints = Array.isArray(payload?.points) ? payload.points : [];
  if (!columns.length || !rawPoints.length) {
    return [];
  }
  return rawPoints.map((row) => {
    const out = {};
    for (let index = 0; index < columns.length; index += 1) {
      out[columns[index]] = Array.isArray(row) ? row[index] ?? null : null;
    }
    if (!out.timestamp_hour_utc) {
      out.timestamp_hour_utc = out.period_start_utc || null;
    }
    return out;
  });
}

function buildAqiBandCachePayload({
  dayUtc,
  historyPrefix,
  connectorId,
  stationId,
  timeseriesIds,
  pollutantKey,
  rowsByPeriodStart,
  source,
  responseComplete,
  cacheScope,
}) {
  const normalizedTimeseriesIds = Array.isArray(timeseriesIds)
    ? Array.from(
      new Set(
        timeseriesIds
          .map((value) => parseRequiredPositiveInt(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    ).sort((left, right) => left - right)
    : [];
  const rows = Array.from(rowsByPeriodStart.values()).sort((left, right) => {
    const leftMs = Date.parse(String(left.period_start_utc || "")) || 0;
    const rightMs = Date.parse(String(right.period_start_utc || "")) || 0;
    return leftMs - rightMs;
  });
  const points = rows.map((row) => rowToAqiBandCompactRow(row));
  const dayStartMs = Date.parse(`${dayUtc}T00:00:00.000Z`);
  const generatedAtUtc = rows.length > 0
    ? String(rows[rows.length - 1]?.period_start_utc || "").trim() || (Number.isFinite(dayStartMs) ? new Date(dayStartMs + DAY_MS).toISOString() : new Date().toISOString())
    : (Number.isFinite(dayStartMs) ? new Date(dayStartMs + DAY_MS).toISOString() : new Date().toISOString());
  return {
    ok: true,
    schema_version: 1,
    wire_format: "json",
    data_format: "compact",
    columns: getAqiBandCacheColumns(),
    points,
    source: source || "r2_band_cache",
    cache_scope: cacheScope || "immutable",
    response_complete: responseComplete === true,
    generated_at_utc: generatedAtUtc,
    history_prefix: normalizePrefix(historyPrefix || DEFAULT_HISTORY_PREFIX),
    day_utc: dayUtc,
    connector_id: connectorId,
    station_id: stationId,
    timeseries_id: normalizedTimeseriesIds.length === 1 ? normalizedTimeseriesIds[0] : null,
    timeseries_ids: normalizedTimeseriesIds,
    pollutant: pollutantKey || null,
    row_count: points.length,
  };
}

async function fetchFilteredParquetRowsFromR2(
  env,
  key,
  rowChunkSize,
  targetTimeseriesIds = null,
  payloadColumns = AQI_PARQUET_COLUMNS,
) {
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
    }

    rowGroupStart = rowGroupEnd;
  }

  return { exists: true, rows: outRows };
}

function resolveAqiParquetPayloadColumns(pollutantKey) {
  const baseColumns = [
    "timeseries_id",
    "timestamp_hour_utc",
    "pollutant_code",
    "daqi_index_level",
    "eaqi_index_level",
  ];
  if (pollutantKey === "pm25") {
    return baseColumns.concat([
      "daqi_pm25_rolling24h_index_level",
      "eaqi_pm25_index_level",
    ]);
  }
  if (pollutantKey === "pm10") {
    return baseColumns.concat([
      "daqi_pm10_rolling24h_index_level",
      "eaqi_pm10_index_level",
    ]);
  }
  if (pollutantKey === "no2") {
    return baseColumns.concat([
      "daqi_no2_index_level",
      "eaqi_no2_index_level",
    ]);
  }
  return AQI_PARQUET_COLUMNS;
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
    aqi_band_cache: {
      enabled: true,
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

function normalizeAndSortRows(rowsByPeriodStart, limit) {
  const rows = Array.from(rowsByPeriodStart.values()).sort((left, right) => {
    const leftMs = Date.parse(String(left.period_start_utc || "")) || 0;
    const rightMs = Date.parse(String(right.period_start_utc || "")) || 0;
    return leftMs - rightMs;
  });
  if (limit !== null && rows.length > limit) {
    return rows.slice(rows.length - limit);
  }
  return rows;
}

function appendFilteredRows(rows, {
  targetTimeseriesIds = null,
  startMs,
  endMs,
  sinceMs,
  pollutantKey,
  outByPeriodStart,
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
    const rowStationId = parseRequiredPositiveInt(row?.station_id);
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
    if (pollutantKey && rowPollutant && rowPollutant !== pollutantKey) {
      continue;
    }

    const genericDaqi = normalizeFiniteIndex(row?.daqi_index_level, 10);
    const genericEaqi = normalizeFiniteIndex(row?.eaqi_index_level, 6);

    const daqiNo2Base = normalizeFiniteIndex(row?.daqi_no2_index_level, 10);
    const daqiPm25Base = normalizeFiniteIndex(row?.daqi_pm25_rolling24h_index_level, 10);
    const daqiPm10Base = normalizeFiniteIndex(row?.daqi_pm10_rolling24h_index_level, 10);
    const eaqiNo2Base = normalizeFiniteIndex(row?.eaqi_no2_index_level, 6);
    const eaqiPm25Base = normalizeFiniteIndex(row?.eaqi_pm25_index_level, 6);
    const eaqiPm10Base = normalizeFiniteIndex(row?.eaqi_pm10_index_level, 6);

    const rowDaqiNo2 = rowPollutant === "no2"
      ? maxFiniteIndex([daqiNo2Base, genericDaqi], 10)
      : daqiNo2Base;
    const rowDaqiPm25 = rowPollutant === "pm25"
      ? maxFiniteIndex([daqiPm25Base, genericDaqi], 10)
      : daqiPm25Base;
    const rowDaqiPm10 = rowPollutant === "pm10"
      ? maxFiniteIndex([daqiPm10Base, genericDaqi], 10)
      : daqiPm10Base;
    const rowEaqiNo2 = rowPollutant === "no2"
      ? maxFiniteIndex([eaqiNo2Base, genericEaqi], 6)
      : eaqiNo2Base;
    const rowEaqiPm25 = rowPollutant === "pm25"
      ? maxFiniteIndex([eaqiPm25Base, genericEaqi], 6)
      : eaqiPm25Base;
    const rowEaqiPm10 = rowPollutant === "pm10"
      ? maxFiniteIndex([eaqiPm10Base, genericEaqi], 6)
      : eaqiPm10Base;

    if (
      rowDaqiNo2 === null
      && rowDaqiPm25 === null
      && rowDaqiPm10 === null
      && rowEaqiNo2 === null
      && rowEaqiPm25 === null
      && rowEaqiPm10 === null
      && genericDaqi === null
      && genericEaqi === null
    ) {
      continue;
    }

    const existing = outByPeriodStart.get(periodStart) || {
      period_start_utc: periodStart,
      daqi_index_level: null,
      eaqi_index_level: null,
      daqi_no2_index_level: null,
      daqi_pm25_rolling24h_index_level: null,
      daqi_pm10_rolling24h_index_level: null,
      eaqi_no2_index_level: null,
      eaqi_pm25_index_level: null,
      eaqi_pm10_index_level: null,
      station_id: rowStationId,
      timeseries_id: rowTimeseriesId,
    };

    if (!existing.timeseries_id && rowTimeseriesId) {
      existing.timeseries_id = rowTimeseriesId;
    }

    existing.daqi_no2_index_level = maxFiniteIndex(
      [existing.daqi_no2_index_level, rowDaqiNo2],
      10,
    );
    existing.daqi_pm25_rolling24h_index_level = maxFiniteIndex(
      [existing.daqi_pm25_rolling24h_index_level, rowDaqiPm25],
      10,
    );
    existing.daqi_pm10_rolling24h_index_level = maxFiniteIndex(
      [existing.daqi_pm10_rolling24h_index_level, rowDaqiPm10],
      10,
    );
    existing.eaqi_no2_index_level = maxFiniteIndex(
      [existing.eaqi_no2_index_level, rowEaqiNo2],
      6,
    );
    existing.eaqi_pm25_index_level = maxFiniteIndex(
      [existing.eaqi_pm25_index_level, rowEaqiPm25],
      6,
    );
    existing.eaqi_pm10_index_level = maxFiniteIndex(
      [existing.eaqi_pm10_index_level, rowEaqiPm10],
      6,
    );

    if (pollutantKey === "no2") {
      existing.daqi_index_level = existing.daqi_no2_index_level;
      existing.eaqi_index_level = existing.eaqi_no2_index_level;
    } else if (pollutantKey === "pm25") {
      existing.daqi_index_level = existing.daqi_pm25_rolling24h_index_level;
      existing.eaqi_index_level = existing.eaqi_pm25_index_level;
    } else if (pollutantKey === "pm10") {
      existing.daqi_index_level = existing.daqi_pm10_rolling24h_index_level;
      existing.eaqi_index_level = existing.eaqi_pm10_index_level;
    } else {
      existing.daqi_index_level = maxFiniteIndex([
        existing.daqi_no2_index_level,
        existing.daqi_pm25_rolling24h_index_level,
        existing.daqi_pm10_rolling24h_index_level,
      ], 10);
      existing.eaqi_index_level = maxFiniteIndex([
        existing.eaqi_no2_index_level,
        existing.eaqi_pm25_index_level,
        existing.eaqi_pm10_index_level,
      ], 6);
    }

    outByPeriodStart.set(periodStart, existing);
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
    const filePollutants = Array.isArray(entry?.pollutant_codes)
      ? entry.pollutant_codes
        .map((value) => normalizeAqiPollutant(value))
        .filter(Boolean)
      : [];
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
  historyPrefix,
  connectorId,
  stationId = null,
  targetTimeseriesIds,
  startIso,
  endIso,
  sinceIso,
  pollutantKey,
  limit,
  bandCacheWrites = null,
}) {
  const scanStartedAtMs = Date.now();
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const bandCacheWriteQueue = Array.isArray(bandCacheWrites) ? bandCacheWrites : null;
  const parquetRowChunkSize = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_PARQUET_ROW_CHUNK_SIZE,
    DEFAULT_PARQUET_ROW_CHUNK_SIZE,
    MIN_PARQUET_ROW_CHUNK_SIZE,
    MAX_PARQUET_ROW_CHUNK_SIZE,
  );
  const historyIndexPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_INDEX_PREFIX || DEFAULT_HISTORY_INDEX_PREFIX,
  ) || DEFAULT_HISTORY_INDEX_PREFIX;
  const timeseriesIndexPrefix = normalizePrefix(
    env.UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_PREFIX
      || env.UK_AQ_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX
      || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`,
  ) || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`;
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
  let bandCacheHitCount = 0;
  let bandCacheMissCount = 0;
  let bandCacheWriteCount = 0;
  let bandCacheEligibleDayCount = 0;
  let bandCacheSkippedDayCount = 0;

  const days = listUtcDays(startIso, endIso);
  const daysToScan = days.slice().reverse();
  if (Array.isArray(targetTimeseriesIds) && targetTimeseriesIds.length === 0) {
    return {
      points: [],
      days_scanned: days.length,
      scanned_connector_manifests: 0,
      scanned_parquet_files: 0,
      missing_day_manifest_keys: [],
      missing_connector_manifest_keys: [],
      missing_parquet_keys: [],
      timeseries_index: {
        enabled: timeseriesIndexEnabled,
        prefix: timeseriesIndexPrefix,
        scanned_connector_index_keys: 0,
        hit_count: 0,
        miss_count: 0,
        skipped_days_by_file_range: 0,
        skipped_files_by_pollutant: 0,
        indexed_file_count_seen: 0,
        unknown_range_file_count_seen: 0,
        missing_connector_index_keys: [],
        warnings: [
          "No AQI timeseries IDs found in requested window; skipped R2 history scan.",
        ],
        target_timeseries_id_count: 0,
      },
    };
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
  let resolvedConnectorId = parseRequiredPositiveInt(connectorId) || null;
  let timeseriesIndexHitCount = 0;
  let timeseriesIndexMissCount = 0;
  let timeseriesIndexSkippedByRangeDays = 0;
  let timeseriesIndexSkippedByPollutantFiles = 0;
  let timeseriesIndexIndexedFileCount = 0;
  let timeseriesIndexUnknownRangeFileCount = 0;
  let scanStoppedReason = null;

  const isScanBudgetExceeded = () => {
    if (Date.now() - scanStartedAtMs > maxScanElapsedMs) {
      scanStoppedReason = `scan_elapsed_ms_budget_exceeded:${maxScanElapsedMs}`;
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
    const requestCoversFullDay = startMs <= dayStartMs && endMs >= dayEndMs;
    const sinceKeepsFullDay = !Number.isFinite(sinceMs) || sinceMs <= dayStartMs;
    const dayBandCacheEligible = requestCoversFullDay && sinceKeepsFullDay;
    const dayRowsByPeriodStart = new Map();
    let dayCacheComplete = true;
    let dayCacheLookupKey = null;

    if (dayBandCacheEligible && resolvedConnectorId) {
      dayCacheLookupKey = buildAqiBandCacheKey({
        bandsPrefix: bandCachePrefix,
        dayUtc,
        connectorId: resolvedConnectorId,
        timeseriesIds: targetTimeseriesIds,
        pollutantKey,
      });
      if (dayCacheLookupKey) {
        bandCacheEligibleDayCount += 1;
        try {
          const cachedBandObject = await fetchJsonObjectFromR2(env, dayCacheLookupKey);
          if (
            cachedBandObject.exists
            && cachedBandObject.value
            && cachedBandObject.value.response_complete === true
            && String(cachedBandObject.value.data_format || "").toLowerCase() === "compact"
          ) {
            const cachedBandRows = expandAqiBandCompactPayload(cachedBandObject.value);
            for (const row of cachedBandRows) {
              const periodStart = String(row?.period_start_utc || "").trim();
              if (periodStart) {
                dayRowsByPeriodStart.set(periodStart, row);
              }
            }
            bandCacheHitCount += 1;
            for (const [periodStart, row] of dayRowsByPeriodStart.entries()) {
              rowsByPeriodStart.set(periodStart, row);
            }
            continue;
          }
          bandCacheMissCount += 1;
        } catch (_error) {
          bandCacheMissCount += 1;
        }
      } else {
        bandCacheSkippedDayCount += 1;
      }
    } else {
      bandCacheSkippedDayCount += 1;
    }

    const dayManifestKey = buildDayManifestKey(historyPrefix, dayUtc);
    const dayManifestObject = await fetchJsonObjectFromR2(env, dayManifestKey);
    if (!dayManifestObject.exists) {
      missingDayManifestKeys.push(dayManifestKey);
      dayCacheComplete = false;
      continue;
    }

    const connectorManifestTargets = [];
    if (Number.isFinite(connectorId) && connectorId > 0) {
      const connectorManifestFallbackKey = buildConnectorManifestKey(
        historyPrefix,
        dayUtc,
        connectorId,
      );
      connectorManifestTargets.push({
        connector_id: connectorId,
        manifest_key: findConnectorManifestKey(
          dayManifestObject.value,
          connectorId,
          connectorManifestFallbackKey,
        ),
      });
    } else {
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
        const connectorIndexKey = buildTimeseriesConnectorIndexKey(
          timeseriesIndexPrefix,
          dayUtc,
          targetConnectorId,
        );
        timeseriesIndexScannedKeys.push(connectorIndexKey);
        try {
          const connectorIndexObject = await fetchJsonObjectFromR2(env, connectorIndexKey);
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
            if (!extraction.all_files_range_bounded) {
              dayCacheComplete = false;
            }
            parquetKeys = extraction.keys;
          } else {
            timeseriesIndexMissCount += 1;
            timeseriesIndexMissingKeys.push(connectorIndexKey);
            if (requireTimeseriesIndex && targetTimeseriesIdCount > 0) {
              timeseriesIndexWarnings.push(
                `Skipped fallback manifest scan for ${connectorIndexKey}: timeseries index is required.`,
              );
              dayCacheComplete = false;
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
            dayCacheComplete = false;
            continue;
          }
        }
      }

      if (parquetKeys === null) {
        scannedConnectorManifests += 1;
        const connectorManifestObject = await fetchJsonObjectFromR2(env, connectorManifestKey);
        if (!connectorManifestObject.exists) {
          missingConnectorManifestKeys.add(connectorManifestKey);
          dayCacheComplete = false;
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
        );
        if (!parquet.exists) {
          missingParquetKeys.add(parquetKey);
          dayCacheComplete = false;
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
        });
      }
    }
    for (const [periodStart, row] of dayRowsByPeriodStart.entries()) {
      rowsByPeriodStart.set(periodStart, row);
    }

    if (scanStoppedReason) {
      dayCacheComplete = false;
      break;
    }

    if (dayBandCacheEligible && dayCacheComplete && resolvedConnectorId) {
      const dayCacheWriteKey = buildAqiBandCacheKey({
        bandsPrefix: bandCachePrefix,
        dayUtc,
        connectorId: resolvedConnectorId,
        timeseriesIds: targetTimeseriesIds,
        pollutantKey,
      });
      if (!dayCacheWriteKey) {
        continue;
      }
      const dayCachePayload = buildAqiBandCachePayload({
        dayUtc,
        historyPrefix,
        connectorId: resolvedConnectorId,
        stationId,
        timeseriesIds: targetTimeseriesIds,
        pollutantKey,
        rowsByPeriodStart: dayRowsByPeriodStart,
        source: "r2_day_scan",
        responseComplete: true,
        cacheScope: "immutable",
      });
      if (bandCacheWriteQueue) {
        bandCacheWriteCount += 1;
        bandCacheWriteQueue.push(
          env.UK_AQ_HISTORY_BUCKET.put(
            dayCacheWriteKey,
            JSON.stringify(dayCachePayload),
            {
              httpMetadata: {
                contentType: "application/json; charset=utf-8",
              },
            },
          ),
        );
      }
    }
  }

  if (scanStoppedReason) {
    timeseriesIndexWarnings.push(`History scan stopped early: ${scanStoppedReason}`);
  }

  const points = normalizeAndSortRows(rowsByPeriodStart, limit);
  return {
    points,
    days_scanned: days.length,
    scanned_connector_manifests: scannedConnectorManifests,
      scanned_parquet_files: scannedParquetKeys.size,
      resolved_connector_id: resolvedConnectorId,
      missing_day_manifest_keys: missingDayManifestKeys,
      missing_connector_manifest_keys: Array.from(missingConnectorManifestKeys.values()),
      missing_parquet_keys: Array.from(missingParquetKeys.values()),
    timeseries_index: {
      enabled: timeseriesIndexEnabled,
      prefix: timeseriesIndexPrefix,
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
    aqi_band_cache: {
      enabled: true,
      prefix: bandCachePrefix,
      eligible_day_count: bandCacheEligibleDayCount,
      hit_count: bandCacheHitCount,
      miss_count: bandCacheMissCount,
      write_count: bandCacheWriteCount,
      skipped_day_count: bandCacheSkippedDayCount,
    },
  };
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
          "daqi_no2_index_level",
          "daqi_pm25_rolling24h_index_level",
          "daqi_pm10_rolling24h_index_level",
          "eaqi_no2_index_level",
          "eaqi_pm25_index_level",
          "eaqi_pm10_index_level",
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
  });

  return {
    source_path: result.source_path,
    points: normalizeAndSortRows(rowsByPeriodStart, null),
  };
}

function mergePointsPreferPrimary(primaryPoints, secondaryPoints, limit) {
  const merged = new Map();
  for (const point of secondaryPoints) {
    const key = String(point?.period_start_utc || "").trim();
    if (!key) {
      continue;
    }
    merged.set(key, point);
  }
  // Primary rows are source-of-truth and overwrite overlapping secondary rows.
  for (const point of primaryPoints) {
    const key = String(point?.period_start_utc || "").trim();
    if (!key) {
      continue;
    }
    merged.set(key, point);
  }
  const rows = Array.from(merged.values()).sort((left, right) => {
    const leftMs = Date.parse(String(left.period_start_utc || "")) || 0;
    const rightMs = Date.parse(String(right.period_start_utc || "")) || 0;
    return leftMs - rightMs;
  });
  if (limit !== null && rows.length > limit) {
    return rows.slice(rows.length - limit);
  }
  return rows;
}

function countAqiBandValues(points) {
  const rows = Array.isArray(points) ? points : [];
  return {
    parsed_point_count: rows.length,
    daqi_count: rows.filter((row) =>
      row?.daqi_index_level !== null && row?.daqi_index_level !== undefined
    ).length,
    eaqi_count: rows.filter((row) =>
      row?.eaqi_index_level !== null && row?.eaqi_index_level !== undefined
    ).length,
  };
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

function pointHourKey(point) {
  const periodStartMs = Date.parse(String(point?.period_start_utc || ""));
  if (!Number.isFinite(periodStartMs)) {
    return null;
  }
  return new Date(Math.floor(periodStartMs / HOUR_MS) * HOUR_MS).toISOString();
}

function filterPointsToMissingHours(candidatePoints, preferredPoints, startMs, endMs) {
  const preferredHourKeys = new Set();
  for (const point of filterPointsToWindow(preferredPoints, startMs, endMs)) {
    const key = pointHourKey(point);
    if (key) {
      preferredHourKeys.add(key);
    }
  }
  return filterPointsToWindow(candidatePoints, startMs, endMs).filter((point) => {
    const key = pointHourKey(point);
    return key !== null && !preferredHourKeys.has(key);
  });
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
  if (scanStoppedReason) {
    reasons.push(`r2_scan_stopped:${scanStoppedReason}`);
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

  const requestedPollutant = url.searchParams.has("pollutant")
    ? normalizeAqiPollutant(url.searchParams.get("pollutant"))
    : null;
  if (url.searchParams.has("pollutant") && !requestedPollutant) {
    return jsonResponse({
      ok: false,
      error: "pollutant must be one of pm25, pm10, or no2 when provided.",
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

  const historyPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || DEFAULT_HISTORY_PREFIX,
  ) || DEFAULT_HISTORY_PREFIX;
  const cachePolicy = resolveCachePolicy(env, endIso);
  const { cacheSeconds, cacheScope } = cachePolicy;
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
  const r2Window = makeWindow(
    startMs,
    Math.min(effectiveEndMs, retentionStartMs),
  );
  const obsAqiDbWindow = makeWindow(
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
  let windowContextSourcePath = null;
  let windowContextLookupError = null;
  let windowContextLookupCacheHit = false;
  let windowContextLookupAttempted = false;
  let targetConnectorId = null;
  let targetStationId = null;
  let targetTimeseriesIds = [timeseriesId];
  const bandCacheWriteTasks = [];

  const resolveTimeseriesWindowContext = async () => {
    if (windowContextLookupAttempted) {
      return {
        connector_id: targetConnectorId,
        station_id: targetStationId,
        timeseries_ids: targetTimeseriesIds,
      };
    }
    windowContextLookupAttempted = true;
    try {
      const lookup = await readTimeseriesWindowContextFromObsAqiDb({
        env,
        timeseriesId,
        startIso,
        endIso,
      });
      windowContextSourcePath = lookup.source_path;
      windowContextLookupCacheHit = lookup.cache_hit;
      targetConnectorId = parseRequiredPositiveInt(lookup.connector_id);
      targetStationId = parseRequiredPositiveInt(lookup.station_id);
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
      targetConnectorId = null;
      targetStationId = null;
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
      historyPrefix,
      connectorId: historyConnectorId,
      stationId: parseRequiredPositiveInt(historyContext.station_id),
      targetTimeseriesIds: historyTargetTimeseriesIds,
      startIso: r2Window.startIso,
      endIso: r2Window.endIso,
      sinceIso,
      pollutantKey: requestedPollutant,
      limit: null,
      bandCacheWrites: bandCacheWriteTasks,
    })
    : buildEmptyHistoryRead();
  const resolvedR2ConnectorId = parseRequiredPositiveInt(r2Read.resolved_connector_id);
  if (!targetConnectorId && resolvedR2ConnectorId) {
    targetConnectorId = resolvedR2ConnectorId;
  }
  if (bandCacheWriteTasks.length > 0 && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(Promise.allSettled(bandCacheWriteTasks));
  }

  let recentFallbackRead = buildEmptyRecentRead();
  const historyScanStoppedReason = r2Read?.timeseries_index?.scan_stopped_reason || null;
  const historyScanComplete = historyScanStoppedReason === null;
  const overlapR2Points = overlapWindow
    ? filterPointsToWindow(r2Read.points, overlapWindow.startMs, overlapWindow.endMs)
    : [];
  const recentR2PointCount = overlapWindow
    ? overlapR2Points.length
    : 0;
  const shouldFetchRecentFallback = hasObsAqiDbWindow;

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
      if (r2Read.points.length === 0) {
        throw new Error(
          `R2 AQI history is unavailable and ObsAQIDB fallback failed (${message}).`,
        );
      }
    }
  }

  const overlapObsAqiDbCandidatePoints = overlapWindow
    ? filterPointsToWindow(
      recentFallbackRead.points,
      overlapWindow.startMs,
      overlapWindow.endMs,
    )
    : [];
  const overlapObsAqiDbFillPoints = overlapWindow
    ? filterPointsToMissingHours(
      overlapObsAqiDbCandidatePoints,
      overlapR2Points,
      overlapWindow.startMs,
      overlapWindow.endMs,
    )
    : [];
  const retentionObsAqiDbPoints = retentionWindow
    ? filterPointsToWindow(
      recentFallbackRead.points,
      retentionWindow.startMs,
      retentionWindow.endMs,
    )
    : [];
  const obsAqiDbMergePoints = [
    ...overlapObsAqiDbFillPoints,
    ...retentionObsAqiDbPoints,
  ];

  // R2 is source-of-truth for historical/overlap AQI. ObsAQIDB fills only
  // missing overlap hours and the retention range.
  const points = mergePointsPreferPrimary(
    r2Read.points,
    obsAqiDbMergePoints,
    limit,
  );
  let source = "r2_only";
  if (points.length === 0) {
    source = "no_data_in_window";
  } else if (r2Read.points.length === 0 && obsAqiDbMergePoints.length > 0) {
    source = "obs_aqidb_retention_only";
  } else if (r2Read.points.length > 0 && obsAqiDbMergePoints.length > 0) {
    source = overlapObsAqiDbFillPoints.length > 0 && retentionObsAqiDbPoints.length > 0
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
  if (hasObsAqiDbWindow && recentFallbackRead.status === "fallback_error") {
    partialReasons.add(`obs_aqidb:${recentFallbackRead.error || "fallback_error"}`);
  }
  const responseComplete = partialReasons.size === 0;
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
  const sourceCoverage = [
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

  const responseRows = points;
  const responseColumns = getAqiBandCacheColumns();
  const compactPoints = responseRows.map((row) => rowToAqiBandCompactRow(row));
  const aqiCounts = countAqiBandValues(responseRows);
  const responsePayload = {
    ok: true,
    generated_at_utc: new Date().toISOString(),
    history_prefix: historyPrefix,
    source,
    source_split_boundary_utc: splitBoundaryIso,
    overlap_start_utc: overlapStartIso,
    retention_start_utc: splitBoundaryIso,
    source_of_truth_days: ingestRetentionDays,
    source_of_truth_hours: ingestRetentionDays * 24,
    cache_scope: cacheScope,
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
    response_complete: responseComplete,
    has_gap: hasGap,
    coverage_state: coverageState,
    partial_reasons: partialReasonList,
    wire_format: responseFormat === "tsv" ? "tsv" : "json",
    data_format: responseFormat === "objects" ? "objects" : "compact",
    columns: responseColumns,
    points: responseFormat === "objects" ? responseRows : compactPoints,
    meta: {
      source,
      response_complete: responseComplete,
      row_count: points.length,
      raw_row_count: points.length,
      parsed_point_count: aqiCounts.parsed_point_count,
      daqi_count: aqiCounts.daqi_count,
      eaqi_count: aqiCounts.eaqi_count,
      data_format: responseFormat === "objects" ? "objects" : "compact",
      wire_format: responseFormat === "tsv" ? "tsv" : "json",
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
      has_gap: hasGap,
      coverage_state: coverageState,
      partial_reasons: partialReasonList,
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
        obs_aqidb_status: recentFallbackRead.status,
      },
    },
    coverage: {
      days_scanned: r2Read.days_scanned,
      scanned_connector_manifests: r2Read.scanned_connector_manifests,
      scanned_parquet_files: r2Read.scanned_parquet_files,
      missing_day_manifest_keys: r2Read.missing_day_manifest_keys,
      missing_connector_manifest_keys: r2Read.missing_connector_manifest_keys,
      missing_parquet_keys: r2Read.missing_parquet_keys,
      target_connector_id: targetConnectorId,
      target_station_id: targetStationId,
      resolved_connector_id: resolvedR2ConnectorId,
      timeseries_window_context_lookup_source_path: windowContextSourcePath,
      timeseries_window_context_lookup_error: windowContextLookupError,
      timeseries_window_context_lookup_cache_hit: windowContextLookupAttempted
        ? windowContextLookupCacheHit
        : false,
      target_timeseries_id_count: Array.isArray(targetTimeseriesIds)
        ? targetTimeseriesIds.length
        : 0,
      ingest_retention_days: ingestRetentionDays,
      overlap_start_utc: overlapStartIso,
      retention_start_utc: splitBoundaryIso,
      response_complete: responseComplete,
      has_gap: hasGap,
      coverage_state: coverageState,
      partial_reasons: partialReasonList,
      source_coverage: sourceCoverage,
      history_scan_complete: historyScanComplete,
      history_scan_stopped_reason: historyScanStoppedReason,
      timeseries_index: r2Read.timeseries_index,
      obs_aqidb_source_path: recentFallbackRead.source_path,
      obs_aqidb_row_count: obsAqiDbMergePoints.length,
      obs_aqidb_raw_row_count: recentFallbackRead.points.length,
      obs_aqidb_status: recentFallbackRead.status,
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
      obs_aqidb_fallback_used: recentFallbackRead.status === "fallback_live",
      obs_aqidb_fallback_reason: shouldFetchRecentFallback
        ? "overlap_missing_hour_fill_and_retention"
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

  let response;
  if (responseFormat === "tsv") {
    response = new Response(buildTsvResponseBody(responseColumns, responseRows), {
      status: 200,
      headers: {
        "Content-Type": "text/tab-separated-values; charset=utf-8",
        "Cache-Control": cacheControlHeader(cacheSeconds),
        ...corsHeaders(),
      },
    });
  } else {
    response = jsonResponse(responsePayload, {
      status: 200,
      cacheSeconds,
    });
  }

  return response;
}

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

    const cacheKey = new Request(request.url, { method: "GET" });
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return withCacheMarker(cached, "HIT");
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

    if (response.ok) {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    }
    return withCacheMarker(response, "MISS");
  },
};
