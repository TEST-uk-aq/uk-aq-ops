import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const DEFAULT_HISTORY_PREFIX = "history/v1/aqilevels";
const DEFAULT_HISTORY_INDEX_PREFIX = "history/_index";
const DEFAULT_TIMESERIES_INDEX_SUBPREFIX = "aqilevels_timeseries";
const DEFAULT_CACHE_SECONDS = 300;
const DEFAULT_IMMUTABLE_CACHE_SECONDS = 86400;
const MAX_CACHE_SECONDS = 604800;
const MAX_LIMIT = 20000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_OBSAQIDB_SOURCE_OF_TRUTH_HOURS = 24 * 7;
const MAX_OBSAQIDB_SOURCE_OF_TRUTH_HOURS = MAX_RANGE_DAYS * 24;
const DEFAULT_OBSAQIDB_TIMEOUT_MS = 10000;
const MIN_OBSAQIDB_TIMEOUT_MS = 2000;
const MAX_OBSAQIDB_TIMEOUT_MS = 30000;
const DEFAULT_PARQUET_ROW_CHUNK_SIZE = 5000;
const MIN_PARQUET_ROW_CHUNK_SIZE = 500;
const MAX_PARQUET_ROW_CHUNK_SIZE = 50000;
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

function utcMidnightMs(isoDay) {
  return Date.parse(`${isoDay}T00:00:00.000Z`);
}

function addUtcDays(isoDay, deltaDays) {
  return toUtcDayFromMs(utcMidnightMs(isoDay) + deltaDays * DAY_MS);
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

async function fetchFilteredParquetRowsFromR2(
  env,
  key,
  stationId,
  rowChunkSize,
  targetTimeseriesIds = null,
) {
  const object = await env.UK_AQ_HISTORY_BUCKET.get(key);
  if (!object) {
    return { exists: false, rows: [] };
  }
  const hasStationFilter = Number.isFinite(Number(stationId)) && Number(stationId) > 0;
  const normalizedStationId = hasStationFilter ? Math.trunc(Number(stationId)) : null;
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
  if (!hasStationFilter && !hasTimeseriesFilter) {
    return { exists: true, rows: [] };
  }

  const arrayBuffer = await object.arrayBuffer();
  const metadata = await parquetMetadataAsync(arrayBuffer, { compressors });
  const schemaColumns = parquetSchema(metadata).children.map((column) =>
    column.element.name
  );
  const stationStatsIndex = schemaColumns.indexOf("station_id");
  const timeseriesStatsIndex = schemaColumns.indexOf("timeseries_id");
  if ((hasStationFilter && stationStatsIndex < 0) || (hasTimeseriesFilter && timeseriesStatsIndex < 0)) {
    return { exists: true, rows: [] };
  }

  const outRows = [];
  let rowGroupStart = 0;
  for (const rowGroup of metadata.row_groups ?? []) {
    const rowGroupRows = Number(rowGroup?.num_rows ?? 0);
    const rowGroupEnd = rowGroupStart + rowGroupRows;
    if (!Number.isFinite(rowGroupRows) || rowGroupRows <= 0) {
      rowGroupStart = rowGroupEnd;
      continue;
    }
    const stats = rowGroup?.columns?.[stationStatsIndex]?.meta_data?.statistics;
    const minStation = Number(stats?.min_value ?? stats?.min);
    const maxStation = Number(stats?.max_value ?? stats?.max);
    if (hasStationFilter) {
      if (
        Number.isFinite(minStation) &&
        Number.isFinite(maxStation) &&
        (normalizedStationId < minStation || normalizedStationId > maxStation)
      ) {
        rowGroupStart = rowGroupEnd;
        continue;
      }
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
      const stationValues = hasStationFilter
        ? await readParquetColumnValues(
          arrayBuffer,
          metadata,
          "station_id",
          chunkStart,
          chunkEnd,
        )
        : [];
      const timeseriesValues = hasTimeseriesFilter
        ? await readParquetColumnValues(
          arrayBuffer,
          metadata,
          "timeseries_id",
          chunkStart,
          chunkEnd,
        )
        : [];
      const matchedIndexes = [];
      const chunkLength = hasStationFilter
        ? stationValues.length
        : hasTimeseriesFilter
        ? timeseriesValues.length
        : 0;
      for (let idx = 0; idx < chunkLength; idx += 1) {
        if (hasStationFilter) {
          const rowStationId = Number(stationValues[idx]);
          if (!Number.isFinite(rowStationId) || rowStationId !== normalizedStationId) {
            continue;
          }
        }
        if (hasTimeseriesFilter) {
          const rowTimeseriesId = parseRequiredPositiveInt(timeseriesValues[idx]);
          if (!Number.isFinite(rowTimeseriesId) || !targetTimeseriesSet.has(rowTimeseriesId)) {
            continue;
          }
        }
        matchedIndexes.push(idx);
      }
      if (matchedIndexes.length === 0) {
        continue;
      }

      const columnValues = {};
      const availableColumns = AQI_PARQUET_COLUMNS.filter((columnName) =>
        schemaColumns.includes(columnName)
      );
      for (const columnName of availableColumns) {
        columnValues[columnName] = await readParquetColumnValues(
          arrayBuffer,
          metadata,
          columnName,
          chunkStart,
          chunkEnd,
        );
      }
      for (const idx of matchedIndexes) {
        const row = {};
        if (hasStationFilter) {
          row.station_id = normalizedStationId;
        }
        if (hasTimeseriesFilter && normalizedTimeseriesIds.length === 1) {
          row.timeseries_id = normalizedTimeseriesIds[0];
        }
        for (const columnName of availableColumns) {
          const values = columnValues[columnName];
          row[columnName] = idx < values.length ? values[idx] : undefined;
        }
        outRows.push(row);
      }
    }

    rowGroupStart = rowGroupEnd;
  }

  return { exists: true, rows: outRows };
}

async function readParquetColumnValues(
  file,
  metadata,
  columnName,
  rowStart,
  rowEnd,
) {
  let rows = [];
  await parquetRead({
    file,
    metadata,
    columns: [columnName],
    rowStart,
    rowEnd,
    compressors,
    onComplete: (columnRows) => {
      if (Array.isArray(columnRows)) {
        rows = columnRows;
      }
    },
  });
  return rows.map((entry) => Array.isArray(entry) ? entry[0] : undefined);
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
  stationId = null,
  targetTimeseriesIds = null,
  startMs,
  endMs,
  sinceMs,
  pollutantKey,
  outByPeriodStart,
}) {
  const normalizedStationId = parseRequiredPositiveInt(stationId);
  const hasStationFilter = Number.isFinite(normalizedStationId) && normalizedStationId > 0;
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
    if (hasStationFilter && rowStationId !== normalizedStationId) {
      continue;
    }
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
  targetTimeseriesIds,
  targetStationId = null,
  startIso,
  endIso,
  sinceIso,
  pollutantKey,
  limit,
}) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
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
  const targetTimeseriesIdCount = Array.isArray(targetTimeseriesIds)
    ? targetTimeseriesIds.length
    : 0;

  const days = listUtcDays(startIso, endIso);
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

  if (!Number.isFinite(Number(connectorId)) || Number(connectorId) <= 0) {
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
          "No connector context available for target timeseries; skipped R2 history scan.",
        ],
        target_timeseries_id_count: targetTimeseriesIdCount,
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
  let timeseriesIndexHitCount = 0;
  let timeseriesIndexMissCount = 0;
  let timeseriesIndexSkippedByRangeDays = 0;
  let timeseriesIndexSkippedByPollutantFiles = 0;
  let timeseriesIndexIndexedFileCount = 0;
  let timeseriesIndexUnknownRangeFileCount = 0;

  for (const dayUtc of days) {
    const dayManifestKey = buildDayManifestKey(historyPrefix, dayUtc);
    const dayManifestObject = await fetchJsonObjectFromR2(env, dayManifestKey);
    if (!dayManifestObject.exists) {
      missingDayManifestKeys.push(dayManifestKey);
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
            parquetKeys = extraction.keys;
            if (extraction.all_files_range_bounded && extraction.keys.length === 0) {
              timeseriesIndexSkippedByRangeDays += 1;
              continue;
            }
          } else {
            timeseriesIndexMissCount += 1;
            timeseriesIndexMissingKeys.push(connectorIndexKey);
          }
        } catch (error) {
          timeseriesIndexMissCount += 1;
          const message = error instanceof Error ? error.message : String(error);
          timeseriesIndexWarnings.push(
            `Optional timeseries index read failed for ${connectorIndexKey}: ${message}`,
          );
        }
      }

      if (parquetKeys === null) {
        scannedConnectorManifests += 1;
        const connectorManifestObject = await fetchJsonObjectFromR2(env, connectorManifestKey);
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
        if (!parquetKey) {
          continue;
        }
        scannedParquetKeys.add(parquetKey);
        const parquet = await fetchFilteredParquetRowsFromR2(
          env,
          parquetKey,
          targetStationId,
          parquetRowChunkSize,
          targetTimeseriesIds,
        );
        if (!parquet.exists) {
          missingParquetKeys.add(parquetKey);
          continue;
        }
        appendFilteredRows(parquet.rows, {
          stationId: targetStationId,
          targetTimeseriesIds,
          startMs,
          endMs,
          sinceMs,
          pollutantKey,
          outByPeriodStart: rowsByPeriodStart,
        });
      }
    }
  }

  const points = normalizeAndSortRows(rowsByPeriodStart, limit);
  return {
    points,
    days_scanned: days.length,
    scanned_connector_manifests: scannedConnectorManifests,
    scanned_parquet_files: scannedParquetKeys.size,
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
          "daqi_index_level",
          "eaqi_index_level",
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
    stationId: null,
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

function mergePointsPreferRecent(historyPoints, recentPoints, limit) {
  const merged = new Map();
  for (const point of historyPoints) {
    const key = String(point?.period_start_utc || "").trim();
    if (!key) {
      continue;
    }
    merged.set(key, point);
  }
  // Recent ObsAQIDB rows are source of truth and overwrite overlapping R2 rows.
  for (const point of recentPoints) {
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

async function handleRequest(request, env) {
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

  const historyPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || DEFAULT_HISTORY_PREFIX,
  ) || DEFAULT_HISTORY_PREFIX;
  const cachePolicy = resolveCachePolicy(env, endIso);
  const { cacheSeconds, cacheScope } = cachePolicy;
  const obsAqiDbSourceOfTruthHours = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_SOURCE_OF_TRUTH_HOURS,
    DEFAULT_OBSAQIDB_SOURCE_OF_TRUTH_HOURS,
    1,
    MAX_OBSAQIDB_SOURCE_OF_TRUTH_HOURS,
  );

  const nowMs = Date.now();
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const splitBoundaryMs = nowMs - obsAqiDbSourceOfTruthHours * HOUR_MS;
  const splitBoundaryIso = new Date(splitBoundaryMs).toISOString();

  const historyStartMs = startMs;
  const historyEndMs = endMs < splitBoundaryMs ? endMs : splitBoundaryMs;
  const recentStartMs = startMs > splitBoundaryMs ? startMs : splitBoundaryMs;
  const recentEndMs = endMs;
  const hasHistoryWindow = historyEndMs > historyStartMs;
  const hasRecentWindow = recentEndMs > recentStartMs;
  let windowContextSourcePath = null;
  let windowContextLookupError = null;
  let windowContextLookupCacheHit = false;
  let windowContextLookupAttempted = false;
  let targetConnectorId = null;
  let targetStationId = null;
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

  const historyContext = hasHistoryWindow
    ? await resolveTimeseriesWindowContext()
    : {
      connector_id: null,
      station_id: null,
      timeseries_ids: [timeseriesId],
    };
  const historyConnectorId = parseRequiredPositiveInt(historyContext.connector_id);
  const historyTargetTimeseriesIds = Array.isArray(historyContext.timeseries_ids)
    ? historyContext.timeseries_ids
    : [timeseriesId];

  const historyRead = hasHistoryWindow
    ? await readHistoryRows({
      env,
      historyPrefix,
      connectorId: historyConnectorId,
      targetTimeseriesIds: historyTargetTimeseriesIds,
      targetStationId: null,
      startIso: new Date(historyStartMs).toISOString(),
      endIso: new Date(historyEndMs).toISOString(),
      sinceIso,
      pollutantKey: requestedPollutant,
      limit: null,
    })
    : buildEmptyHistoryRead();

  let recentRead = buildEmptyRecentRead();
  let recentHistoryFallbackRead = buildEmptyHistoryRead();
  let recentHistoryFallbackError = null;

  if (hasRecentWindow) {
    try {
      const obsAqiRecentRead = await readRecentRowsFromObsAqiDb({
        env,
        timeseriesId,
        startIso: new Date(recentStartMs).toISOString(),
        endIso: new Date(recentEndMs).toISOString(),
        sinceIso,
        pollutantKey: requestedPollutant,
      });
      recentRead = {
        ...obsAqiRecentRead,
        status: "live",
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recentRead = buildEmptyRecentRead("history_fallback", message);

      // Keep the endpoint available when the live ObsAQIDB slice is unavailable by
      // falling back to R2 for the same recent window on a best-effort basis.
      try {
        const recentContext = await resolveTimeseriesWindowContext();
        const recentFallbackConnectorId = parseRequiredPositiveInt(recentContext.connector_id);
        const recentFallbackTargetTimeseriesIds = Array.isArray(recentContext.timeseries_ids)
          ? recentContext.timeseries_ids
          : [timeseriesId];
        recentHistoryFallbackRead = await readHistoryRows({
          env,
          historyPrefix,
          connectorId: recentFallbackConnectorId,
          targetTimeseriesIds: recentFallbackTargetTimeseriesIds,
          targetStationId: null,
          startIso: new Date(recentStartMs).toISOString(),
          endIso: new Date(recentEndMs).toISOString(),
          sinceIso,
          pollutantKey: requestedPollutant,
          limit: null,
        });
      } catch (fallbackError) {
        recentHistoryFallbackError = fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      }

      if (
        recentHistoryFallbackError
        && historyRead.points.length === 0
        && recentHistoryFallbackRead.points.length === 0
      ) {
        throw new Error(
          `ObsAQIDB recent AQI failed (${message}) and R2 recent fallback failed (${recentHistoryFallbackError}).`,
        );
      }
    }
  }

  const historyBackedPoints = mergePointsPreferRecent(
    historyRead.points,
    recentHistoryFallbackRead.points,
    null,
  );
  const points = mergePointsPreferRecent(historyBackedPoints, recentRead.points, limit);
  const source = recentRead.status === "live"
    ? hasHistoryWindow
      ? "obs_aqidb_history_stitched"
      : "obs_aqidb_only"
    : recentRead.status === "history_fallback"
    ? "history_r2_fallback"
    : "history_only";

  return jsonResponse({
    ok: true,
    generated_at_utc: new Date().toISOString(),
    history_prefix: historyPrefix,
    source,
    source_split_boundary_utc: splitBoundaryIso,
    source_of_truth_hours: obsAqiDbSourceOfTruthHours,
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
    points,
    coverage: {
      days_scanned: historyRead.days_scanned,
      scanned_connector_manifests: historyRead.scanned_connector_manifests,
      scanned_parquet_files: historyRead.scanned_parquet_files,
      missing_day_manifest_keys: historyRead.missing_day_manifest_keys,
      missing_connector_manifest_keys: historyRead.missing_connector_manifest_keys,
      missing_parquet_keys: historyRead.missing_parquet_keys,
      target_connector_id: targetConnectorId,
      target_station_id: targetStationId,
      timeseries_window_context_lookup_source_path: windowContextSourcePath,
      timeseries_window_context_lookup_error: windowContextLookupError,
      timeseries_window_context_lookup_cache_hit: windowContextLookupAttempted
        ? windowContextLookupCacheHit
        : false,
      target_timeseries_id_count: Array.isArray(targetTimeseriesIds)
        ? targetTimeseriesIds.length
        : 0,
      timeseries_index: historyRead.timeseries_index,
      obs_aqidb_source_path: recentRead.source_path,
      obs_aqidb_row_count: recentRead.points.length,
      obs_aqidb_status: recentRead.status,
      obs_aqidb_error: recentRead.error,
      history_window_from_utc: hasHistoryWindow ? new Date(historyStartMs).toISOString() : null,
      history_window_to_utc: hasHistoryWindow ? new Date(historyEndMs).toISOString() : null,
      obs_aqidb_window_from_utc: hasRecentWindow ? new Date(recentStartMs).toISOString() : null,
      obs_aqidb_window_to_utc: hasRecentWindow ? new Date(recentEndMs).toISOString() : null,
      r2_recent_fallback_used: recentRead.status === "history_fallback",
      r2_recent_fallback_row_count: recentHistoryFallbackRead.points.length,
      r2_recent_fallback_from_utc: recentRead.status === "history_fallback"
        ? new Date(recentStartMs).toISOString()
        : null,
      r2_recent_fallback_to_utc: recentRead.status === "history_fallback"
        ? new Date(recentEndMs).toISOString()
        : null,
      r2_recent_fallback_days_scanned: recentHistoryFallbackRead.days_scanned,
      r2_recent_fallback_scanned_connector_manifests:
        recentHistoryFallbackRead.scanned_connector_manifests,
      r2_recent_fallback_scanned_parquet_files:
        recentHistoryFallbackRead.scanned_parquet_files,
      r2_recent_fallback_missing_day_manifest_keys:
        recentHistoryFallbackRead.missing_day_manifest_keys,
      r2_recent_fallback_missing_connector_manifest_keys:
        recentHistoryFallbackRead.missing_connector_manifest_keys,
      r2_recent_fallback_missing_parquet_keys:
        recentHistoryFallbackRead.missing_parquet_keys,
      r2_recent_fallback_timeseries_index: recentHistoryFallbackRead.timeseries_index,
      r2_recent_fallback_error: recentHistoryFallbackError,
    },
  }, {
    status: 200,
    cacheSeconds,
  });
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
      response = await handleRequest(request, env);
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
