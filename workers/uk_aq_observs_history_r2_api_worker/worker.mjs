import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  parseR2HistoryVersion,
  resolveR2HistoryVersion,
} from "../shared/uk_aq_r2_history_version.mjs";

const DEFAULT_HISTORY_PREFIX = "history/v1/observations";
const DEFAULT_HISTORY_V2_PREFIX = "history/v2/observations";
const DEFAULT_HISTORY_INDEX_PREFIX = "history/_index";
const DEFAULT_HISTORY_V2_INDEX_PREFIX = "history/_index_v2";
const DEFAULT_TIMESERIES_INDEX_SUBPREFIX = "observations_timeseries";
const DEFAULT_TIMESERIES_METADATA_INDEX_SUBPREFIX = "timeseries";
const DEFAULT_CACHE_SECONDS = 300;
const DEFAULT_IMMUTABLE_CACHE_SECONDS = 86400;
const MAX_CACHE_SECONDS = 604800;
const MAX_LIMIT = 20000;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OBS_HISTORY_MUTABLE_WINDOW_MS = 24 * HOUR_MS;
const VALID_PATHS = new Set(["/", "/v1/observations", "/v1/timeseries-metadata"]);

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

function normalizePollutant(raw) {
  const compact = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
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

function parseMsOrNaN(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return Number.NaN;
  }
  const ms = Date.parse(String(raw).trim());
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function cacheControlHeader(cacheSeconds) {
  return `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${
    cacheSeconds * 2
  }`;
}

function resolveCachePolicy(env, endIso) {
  const mutableCacheSeconds = parsePositiveInt(
    env.UK_AQ_OBSERVS_HISTORY_R2_CACHE_MAX_AGE_SECONDS,
    DEFAULT_CACHE_SECONDS,
    30,
    MAX_CACHE_SECONDS,
  );
  const immutableCacheSeconds = Math.max(
    mutableCacheSeconds,
    parsePositiveInt(
      env.UK_AQ_OBSERVS_HISTORY_R2_IMMUTABLE_CACHE_MAX_AGE_SECONDS,
      DEFAULT_IMMUTABLE_CACHE_SECONDS,
      30,
      MAX_CACHE_SECONDS,
    ),
  );
  const endMs = Date.parse(endIso);
  const immutable = Number.isFinite(endMs) &&
    endMs <= (Date.now() - OBS_HISTORY_MUTABLE_WINDOW_MS);
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
    return {
      ok: false,
      status: 500,
      error: "Missing UK_AQ_EDGE_UPSTREAM_SECRET.",
    };
  }
  const supplied = String(request.headers.get(UPSTREAM_AUTH_HEADER) || "")
    .trim();
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
  if (
    !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
  ) {
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
  const normalizedPollutant = normalizePollutant(pollutantKey);
  if (!normalizedPollutant) {
    return null;
  }
  return `${indexPrefix}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${normalizedPollutant}/manifest.json`;
}

function createReadMetrics() {
  return {
    r2_object_reads: 0,
    parquet_bytes_read: 0,
    parquet_row_groups_scanned: 0,
    parquet_chunks_scanned: 0,
    parquet_matched_rows: 0,
  };
}

async function fetchJsonObjectFromR2(env, key, metrics = null) {
  if (metrics) {
    metrics.r2_object_reads += 1;
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

async function fetchFilteredParquetRowsFromR2(
  env,
  key,
  timeseriesId,
  rowChunkSize,
  metrics = null,
) {
  if (metrics) {
    metrics.r2_object_reads += 1;
  }
  const object = await env.UK_AQ_HISTORY_BUCKET.get(key);
  if (!object) {
    return { exists: false, rows: [] };
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
  const observedAtColumn = schemaColumns.includes("observed_at_utc")
    ? "observed_at_utc"
    : "observed_at";
  if (!schemaColumns.includes(observedAtColumn) || !schemaColumns.includes("value")) {
    return { exists: true, rows: [] };
  }

  const outRows = [];
  let rowGroupStart = 0;
  for (const rowGroup of metadata.row_groups ?? []) {
    if (metrics) {
      metrics.parquet_row_groups_scanned += 1;
    }
    const rowGroupRows = Number(rowGroup?.num_rows ?? 0);
    const rowGroupEnd = rowGroupStart + rowGroupRows;
    if (!Number.isFinite(rowGroupRows) || rowGroupRows <= 0) {
      rowGroupStart = rowGroupEnd;
      continue;
    }
    const stats = rowGroup?.columns?.[timeseriesStatsIndex]?.meta_data
      ?.statistics;
    const minTimeseries = Number(stats?.min_value ?? stats?.min);
    const maxTimeseries = Number(stats?.max_value ?? stats?.max);
    if (
      Number.isFinite(minTimeseries) &&
      Number.isFinite(maxTimeseries) &&
      (timeseriesId < minTimeseries || timeseriesId > maxTimeseries)
    ) {
      if (metrics) {
        metrics.parquet_chunks_scanned += 1;
      }
      rowGroupStart = rowGroupEnd;
      continue;
    }

    for (
      let chunkStart = rowGroupStart;
      chunkStart < rowGroupEnd;
      chunkStart += rowChunkSize
    ) {
      const chunkEnd = Math.min(rowGroupEnd, chunkStart + rowChunkSize);
      const timeseriesValues = await readParquetColumnValues(
        arrayBuffer,
        metadata,
        "timeseries_id",
        chunkStart,
        chunkEnd,
      );
      const matchedIndexes = [];
      for (let idx = 0; idx < timeseriesValues.length; idx += 1) {
        const rowTimeseriesId = Number(timeseriesValues[idx]);
        if (
          Number.isFinite(rowTimeseriesId) && rowTimeseriesId === timeseriesId
        ) {
          matchedIndexes.push(idx);
        }
      }
      if (matchedIndexes.length === 0) {
        continue;
      }
      const observedAtValues = await readParquetColumnValues(
        arrayBuffer,
        metadata,
        observedAtColumn,
        chunkStart,
        chunkEnd,
      );
      const valueValues = await readParquetColumnValues(
        arrayBuffer,
        metadata,
        "value",
        chunkStart,
        chunkEnd,
      );
      const statusValues = schemaColumns.includes("status")
        ? await readParquetColumnValues(
          arrayBuffer,
          metadata,
          "status",
          chunkStart,
          chunkEnd,
        )
        : [];
      for (const idx of matchedIndexes) {
        if (idx >= observedAtValues.length || idx >= valueValues.length) {
          continue;
        }
        outRows.push({
          observed_at: observedAtValues[idx],
          value: valueValues[idx],
          status: idx < statusValues.length && statusValues[idx] != null
            ? String(statusValues[idx])
            : null,
        });
      }
      if (metrics) {
        metrics.parquet_matched_rows += matchedIndexes.length;
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

function appendFilteredRows(rows, {
  startMs,
  endMs,
  sinceMs,
  outByObservedAt,
}) {
  for (const row of rows) {
    const observedAt = toIsoOrNull(row?.observed_at);
    if (!observedAt) {
      continue;
    }
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) {
      continue;
    }
    if (observedMs < startMs || observedMs >= endMs) {
      continue;
    }
    if (Number.isFinite(sinceMs) && observedMs <= sinceMs) {
      continue;
    }
    outByObservedAt.set(observedAt, {
      observed_at: observedAt,
      value: normalizeValue(row?.value),
    });
  }
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
    if (
      !Number.isFinite(entryConnectorId) || entryConnectorId !== connectorId
    ) {
      continue;
    }
    const entryKey = String(entry?.manifest_key || "").trim();
    if (entryKey) {
      return entryKey;
    }
  }
  return fallbackKey;
}

function parseObservationsRequest(url) {
  if (!VALID_PATHS.has(url.pathname)) {
    return { ok: false, status: 404, error: "Not found." };
  }

  const timeseriesId = parseRequiredPositiveInt(
    url.searchParams.get("timeseries_id"),
  );
  if (!timeseriesId) {
    return {
      ok: false,
      status: 400,
      error: "timeseries_id must be a positive integer.",
    };
  }

  const connectorId = parseRequiredPositiveInt(
    url.searchParams.get("connector_id"),
  );
  if (!connectorId) {
    return {
      ok: false,
      status: 400,
      error: "connector_id must be a positive integer.",
    };
  }

  const pollutantKey = url.searchParams.has("pollutant")
    ? normalizePollutant(url.searchParams.get("pollutant"))
    : null;
  if (url.searchParams.has("pollutant") && !pollutantKey) {
    return {
      ok: false,
      status: 400,
      error: "pollutant must be one of pm25, pm10, or no2 when provided.",
    };
  }

  const startIso = toIsoOrNull(url.searchParams.get("start_utc"));
  const endIso = toIsoOrNull(url.searchParams.get("end_utc"));
  if (!startIso || !endIso) {
    return {
      ok: false,
      status: 400,
      error: "start_utc and end_utc must be valid ISO timestamps.",
    };
  }
  if (Date.parse(endIso) <= Date.parse(startIso)) {
    return {
      ok: false,
      status: 400,
      error: "end_utc must be greater than start_utc.",
    };
  }

  const sinceIso = url.searchParams.has("since_utc")
    ? toIsoOrNull(url.searchParams.get("since_utc"))
    : null;
  if (url.searchParams.has("since_utc") && !sinceIso) {
    return {
      ok: false,
      status: 400,
      error: "since_utc must be a valid ISO timestamp when provided.",
    };
  }

  const limit = parseOptionalPositiveInt(
    url.searchParams.get("limit"),
    1,
    MAX_LIMIT,
  );
  if (url.searchParams.has("limit") && limit === null) {
    return {
      ok: false,
      status: 400,
      error: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
    };
  }

  return {
    ok: true,
    timeseriesId,
    connectorId,
    pollutantKey,
    startIso,
    endIso,
    sinceIso,
    limit,
  };
}

function parseTimeseriesMetadataRequest(url) {
  if (url.pathname !== "/v1/timeseries-metadata") {
    return { ok: false, status: 404, error: "Not found." };
  }
  const timeseriesId = parseRequiredPositiveInt(url.searchParams.get("timeseries_id"));
  if (!timeseriesId) {
    return {
      ok: false,
      status: 400,
      error: "timeseries_id must be a positive integer.",
    };
  }
  return { ok: true, timeseriesId };
}

function resolveTimeseriesMetadataIndexPrefix(env) {
  const historyIndexPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_INDEX_V2_PREFIX || DEFAULT_HISTORY_V2_INDEX_PREFIX,
  ) || DEFAULT_HISTORY_V2_INDEX_PREFIX;
  return normalizePrefix(
    env.UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX
      || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_METADATA_INDEX_SUBPREFIX}`,
  ) || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_METADATA_INDEX_SUBPREFIX}`;
}

function buildTimeseriesMetadataIndexKey(prefix, timeseriesId) {
  return `${normalizePrefix(prefix)}/timeseries_id=${timeseriesId}.json`;
}

function buildCanonicalCacheKey(requestUrl, {
  timeseriesId,
  connectorId,
  pollutantKey,
  startIso,
  endIso,
  sinceIso,
  limit,
}, readVersion = "v1") {
  const cacheUrl = new URL(requestUrl);
  cacheUrl.pathname = "/v1/observations";
  cacheUrl.search = "";
  cacheUrl.hash = "";
  cacheUrl.searchParams.set("timeseries_id", String(timeseriesId));
  cacheUrl.searchParams.set("connector_id", String(connectorId));
  cacheUrl.searchParams.set("__ukaq_observs_history_read_v", parseReadVersion(readVersion));
  if (pollutantKey) {
    cacheUrl.searchParams.set("pollutant", pollutantKey);
  }
  cacheUrl.searchParams.set("start_utc", startIso);
  cacheUrl.searchParams.set("end_utc", endIso);
  if (sinceIso) {
    cacheUrl.searchParams.set("since_utc", sinceIso);
  }
  if (limit !== null) {
    cacheUrl.searchParams.set("limit", String(limit));
  }
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function buildTimeseriesMetadataCacheKey(requestUrl, requestParams) {
  const cacheUrl = new URL(requestUrl);
  cacheUrl.pathname = "/v1/timeseries-metadata";
  cacheUrl.search = "";
  cacheUrl.hash = "";
  cacheUrl.searchParams.set("timeseries_id", String(requestParams.timeseriesId));
  cacheUrl.searchParams.set("__ukaq_observs_history_read_v", "v2");
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function extractParquetKeysFromTimeseriesIndex(
  indexPayload,
  timeseriesId,
  effectiveStartMs,
  endMs,
) {
  const files = Array.isArray(indexPayload?.files) ? indexPayload.files : [];
  const allKeys = [];
  let indexedFileCount = 0;
  let filesWithUnknownRange = 0;
  let filesSkippedByTimeRange = 0;
  let allFilesRangeBounded = files.length > 0;

  for (const entry of files) {
    const key = String(entry?.key || "").trim();
    if (!key) {
      continue;
    }
    const minTimeseriesId = Number(entry?.min_timeseries_id);
    const maxTimeseriesId = Number(entry?.max_timeseries_id);
    const hasRange =
      Number.isFinite(minTimeseriesId) &&
      Number.isFinite(maxTimeseriesId) &&
      minTimeseriesId > 0 &&
      maxTimeseriesId > 0 &&
      maxTimeseriesId >= minTimeseriesId;

    if (!hasRange) {
      allFilesRangeBounded = false;
      filesWithUnknownRange += 1;
      allKeys.push(key);
      continue;
    }

    const fileMinObservedMs = parseMsOrNaN(
      entry?.min_observed_at_utc ?? entry?.min_observed_at,
    );
    const fileMaxObservedMs = parseMsOrNaN(
      entry?.max_observed_at_utc ?? entry?.max_observed_at,
    );
    const hasTimeRange = Number.isFinite(fileMinObservedMs) &&
      Number.isFinite(fileMaxObservedMs) &&
      fileMaxObservedMs >= fileMinObservedMs;
    if (hasTimeRange) {
      // Query window is [effectiveStartMs, endMs). File range is [min, max].
      // Skip when there is definitely no overlap.
      if (fileMaxObservedMs < effectiveStartMs || fileMinObservedMs >= endMs) {
        filesSkippedByTimeRange += 1;
        continue;
      }
    }

    indexedFileCount += 1;
    if (timeseriesId >= minTimeseriesId && timeseriesId <= maxTimeseriesId) {
      allKeys.push(key);
    }
  }

  const dedupedKeys = Array.from(new Set(allKeys));

  // --- DIAG: file bounds filtering result ---
  const candidateCount = files.length - filesSkippedByTimeRange;
  const selectedCount = dedupedKeys.length;
  const skippedByBounds = candidateCount - selectedCount;
  // Build per-file selected_file diag logs (cap at 20)
  const MAX_FILE_DIAG = 20;
  const selectedFileEntries = [];
  for (const entry of files) {
    const key = String(entry?.key || "").trim();
    if (!key || !dedupedKeys.includes(key)) continue;
    selectedFileEntries.push({
      key,
      bytes: Number(entry?.bytes ?? entry?.file_bytes ?? null) || null,
      min_timeseries_id: Number(entry?.min_timeseries_id) || null,
      max_timeseries_id: Number(entry?.max_timeseries_id) || null,
      contains_timeseries_id:
        Number.isFinite(Number(entry?.min_timeseries_id)) &&
        Number.isFinite(Number(entry?.max_timeseries_id))
          ? timeseriesId >= Number(entry.min_timeseries_id) &&
            timeseriesId <= Number(entry.max_timeseries_id)
          : null,
    });
  }
  const selectedTotalBytes = selectedFileEntries.reduce(
    (sum, f) => sum + (f.bytes || 0),
    0,
  );
  console.log("UK_AQ_OBSERVS_DIAG", JSON.stringify({
    stage: "file_bounds_filter",
    timeseries_id: timeseriesId,
    candidate_file_count_before_bounds: candidateCount,
    selected_file_count_after_bounds: selectedCount,
    selected_file_total_bytes: selectedTotalBytes,
    skipped_by_bounds_count: skippedByBounds,
    skipped_by_time_range_count: filesSkippedByTimeRange,
    unknown_range_file_count: filesWithUnknownRange,
  }));
  const loggedFiles = selectedFileEntries.slice(0, MAX_FILE_DIAG);
  for (const f of loggedFiles) {
    console.log("UK_AQ_OBSERVS_DIAG", JSON.stringify({
      stage: "selected_file",
      timeseries_id: timeseriesId,
      key: f.key,
      bytes: f.bytes,
      min_timeseries_id: f.min_timeseries_id,
      max_timeseries_id: f.max_timeseries_id,
      contains_timeseries_id: f.contains_timeseries_id,
    }));
  }
  if (selectedFileEntries.length > MAX_FILE_DIAG) {
    console.log("UK_AQ_OBSERVS_DIAG", JSON.stringify({
      stage: "selected_file_truncated",
      selected_file_count_after_bounds: selectedCount,
      logged_file_count: MAX_FILE_DIAG,
    }));
  }
  // --- END DIAG ---

  return {
    keys: dedupedKeys,
    file_count: files.length,
    indexed_file_count: indexedFileCount,
    unknown_range_file_count: filesWithUnknownRange,
    skipped_by_time_range_file_count: filesSkippedByTimeRange,
    all_files_range_bounded: allFilesRangeBounded,
  };
}

function normalizeValue(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function normalizeAndSortRows(rowsByObservedAt, limit) {
  const rows = Array.from(rowsByObservedAt.values()).sort((left, right) => {
    const leftMs = Date.parse(String(left.observed_at || "")) || 0;
    const rightMs = Date.parse(String(right.observed_at || "")) || 0;
    return leftMs - rightMs;
  });
  if (limit !== null && rows.length > limit) {
    return {
      rows: rows.slice(0, limit),
      limited_by_limit: true,
      total_rows_before_limit: rows.length,
    };
  }
  return {
    rows,
    limited_by_limit: false,
    total_rows_before_limit: rows.length,
  };
}

function summarizeCoverageCompleteness(historyRead) {
  const partialReasons = [];
  if (historyRead.missing_day_manifest_keys.length > 0) {
    partialReasons.push("missing_day_manifest");
  }
  if (historyRead.missing_connector_manifest_keys.length > 0) {
    partialReasons.push("missing_connector_manifest");
  }
  if (historyRead.missing_parquet_keys.length > 0) {
    partialReasons.push("missing_parquet");
  }
  if (historyRead.limited_by_limit) {
    partialReasons.push("limited_by_limit");
  }
  const index = historyRead.timeseries_index || {};
  if (Number(index.skipped_days_by_file_range) > 0) {
    partialReasons.push("timeseries_index_skipped_day");
  }
  if (Array.isArray(index.warnings) && index.warnings.length > 0) {
    partialReasons.push("timeseries_index_warning");
  }
  const uniqueReasons = Array.from(new Set(partialReasons));
  return {
    response_complete: uniqueReasons.length === 0,
    has_gap: uniqueReasons.length > 0,
    coverage_state: uniqueReasons.length === 0 ? "complete" : "partial",
    partial_reasons: uniqueReasons,
  };
}

async function readHistoryRows({
  env,
  readVersion = "v1",
  historyPrefix,
  historyIndexPrefix,
  timeseriesIndexPrefix,
  timeseriesId,
  connectorId,
  pollutantKey,
  startIso,
  endIso,
  sinceIso,
  limit,
}) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const effectiveStartMs = Number.isFinite(sinceMs)
    ? Math.max(startMs, sinceMs + 1)
    : startMs;
  const parquetRowChunkSize = parsePositiveInt(
    env.UK_AQ_OBSERVS_HISTORY_R2_PARQUET_ROW_CHUNK_SIZE,
    5000,
    500,
    50000,
  );
  const normalizedReadVersion = parseReadVersion(readVersion);
  const normalizedHistoryIndexPrefix = normalizePrefix(historyIndexPrefix || (
    normalizedReadVersion === "v2"
      ? DEFAULT_HISTORY_V2_INDEX_PREFIX
      : DEFAULT_HISTORY_INDEX_PREFIX
  ));
  const normalizedTimeseriesIndexPrefix = normalizePrefix(timeseriesIndexPrefix || (
    `${normalizedHistoryIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`
  ));
  const timeseriesIndexEnabled = parseOptionalBoolean(
    env.UK_AQ_OBSERVS_HISTORY_R2_TIMESERIES_INDEX_ENABLED,
    true,
  );
  const normalizedPollutantKey = normalizePollutant(pollutantKey);

  const days = listUtcDays(startIso, endIso);
  // --- DIAG: index_plan ---
  console.log("UK_AQ_OBSERVS_DIAG", JSON.stringify({
    stage: "index_plan",
    read_version: normalizedReadVersion,
    day_count: days.length,
    first_day: days[0] ?? null,
    last_day: days[days.length - 1] ?? null,
    timeseries_index_enabled: timeseriesIndexEnabled,
    timeseries_index_prefix: normalizedTimeseriesIndexPrefix,
    history_prefix: historyPrefix,
    pollutant: normalizedPollutantKey,
  }));
  // --- END DIAG ---
  const metrics = createReadMetrics();
  const rowsByObservedAt = new Map();
  const missingDayManifestKeys = [];
  const missingConnectorManifestKeys = [];
  const missingParquetKeys = [];
  const scannedParquetKeys = [];
  const timeseriesIndexScannedKeys = [];
  const timeseriesIndexMissingKeys = [];
  const timeseriesIndexWarnings = [];
  let timeseriesIndexHitCount = 0;
  let timeseriesIndexMissCount = 0;
  let timeseriesIndexSkippedByRangeDays = 0;
  let timeseriesIndexSkippedByTimeRangeFiles = 0;
  let timeseriesIndexIndexedFileCount = 0;
  let timeseriesIndexUnknownRangeFileCount = 0;

  if (normalizedReadVersion === "v2" && !timeseriesIndexEnabled) {
    timeseriesIndexWarnings.push(
      "Skipped v2 observations history scan: v2 requires the observations timeseries index.",
    );
  }

  if (normalizedReadVersion === "v2" && !normalizedPollutantKey) {
    timeseriesIndexWarnings.push(
      "Skipped v2 observations history scan: pollutant is required for pollutant-partitioned v2 reads.",
    );
    return {
      rows: [],
      limited_by_limit: false,
      total_rows_before_limit: 0,
      days_scanned: 0,
      scanned_parquet_files: 0,
      missing_day_manifest_keys: [],
      missing_connector_manifest_keys: [],
      missing_parquet_keys: [],
      metrics,
      timeseries_index: {
        enabled: timeseriesIndexEnabled,
        prefix: normalizedTimeseriesIndexPrefix,
        read_version: normalizedReadVersion,
        index_version: normalizedReadVersion,
        pollutant_partition: null,
        scanned_connector_index_keys: 0,
        hit_count: 0,
        miss_count: 0,
        skipped_days_by_file_range: 0,
        skipped_files_by_time_range: 0,
        indexed_file_count_seen: 0,
        unknown_range_file_count_seen: 0,
        missing_connector_index_keys: [],
        warnings: timeseriesIndexWarnings,
      },
    };
  }

  for (const dayUtc of days) {
    let parquetKeys = null;
    let connectorManifestKey = null;

    if (timeseriesIndexEnabled) {
      const connectorIndexKey = normalizedReadVersion === "v2"
        ? buildTimeseriesPollutantIndexKey(
          normalizedTimeseriesIndexPrefix,
          dayUtc,
          connectorId,
          normalizedPollutantKey,
        )
        : buildTimeseriesConnectorIndexKey(
          normalizedTimeseriesIndexPrefix,
          dayUtc,
          connectorId,
        );
      if (!connectorIndexKey) {
        timeseriesIndexWarnings.push(
          `Skipped observations history index for day=${dayUtc}: pollutant is required for v2.`,
        );
        continue;
      }
      timeseriesIndexScannedKeys.push(connectorIndexKey);
      try {
        const connectorIndexObject = await fetchJsonObjectFromR2(
          env,
          connectorIndexKey,
          metrics,
        );
        if (connectorIndexObject.exists) {
          timeseriesIndexHitCount += 1;
          const extraction = extractParquetKeysFromTimeseriesIndex(
            connectorIndexObject.value,
            timeseriesId,
            effectiveStartMs,
            endMs,
          );
          timeseriesIndexIndexedFileCount += extraction.indexed_file_count;
          timeseriesIndexUnknownRangeFileCount +=
            extraction.unknown_range_file_count;
          timeseriesIndexSkippedByTimeRangeFiles +=
            extraction.skipped_by_time_range_file_count;
          parquetKeys = extraction.keys;
          if (extraction.keys.length === 0) {
            if (extraction.all_files_range_bounded) {
              timeseriesIndexSkippedByRangeDays += 1;
              continue;
            }
            parquetKeys = null;
            timeseriesIndexWarnings.push(
              `Optional timeseries index had no usable file entries for ${connectorIndexKey}; falling back to connector manifest scanning.`,
            );
          }
        } else {
          timeseriesIndexMissCount += 1;
          timeseriesIndexMissingKeys.push(connectorIndexKey);
          if (normalizedReadVersion === "v2") {
            timeseriesIndexWarnings.push(
              `Missing required v2 observations timeseries index: ${connectorIndexKey}`,
            );
          }
        }
      } catch (error) {
        timeseriesIndexMissCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        timeseriesIndexWarnings.push(
          `Optional timeseries index read failed for ${connectorIndexKey}: ${message}`,
        );
      }
    }

    if (normalizedReadVersion === "v2") {
      if (parquetKeys === null) {
        continue;
      }
    } else {
      const dayManifestKey = buildDayManifestKey(historyPrefix, dayUtc);
      const dayManifestObject = await fetchJsonObjectFromR2(env, dayManifestKey, metrics);
      if (!dayManifestObject.exists) {
        missingDayManifestKeys.push(dayManifestKey);
        continue;
      }

      const connectorManifestFallbackKey = buildConnectorManifestKey(
        historyPrefix,
        dayUtc,
        connectorId,
      );
      connectorManifestKey = findConnectorManifestKey(
        dayManifestObject.value,
        connectorId,
        connectorManifestFallbackKey,
      );
    }

    if (parquetKeys === null) {
      const connectorManifestObject = await fetchJsonObjectFromR2(
        env,
        connectorManifestKey,
        metrics,
      );
      if (!connectorManifestObject.exists) {
        missingConnectorManifestKeys.push(connectorManifestKey);
        continue;
      }

      const files = Array.isArray(connectorManifestObject.value?.files)
        ? connectorManifestObject.value.files
        : [];
      parquetKeys = files.map((fileEntry) =>
        String(fileEntry?.key || "").trim()
      ).filter(Boolean);
    }

    for (const parquetKey of Array.from(new Set(parquetKeys))) {
      scannedParquetKeys.push(parquetKey);
      // --- DIAG: parquet_fetch_start ---
      console.log("UK_AQ_OBSERVS_DIAG", JSON.stringify({
        stage: "parquet_fetch_start",
        key: parquetKey,
      }));
      // --- END DIAG ---
      const parquet = await fetchFilteredParquetRowsFromR2(
        env,
        parquetKey,
        timeseriesId,
        parquetRowChunkSize,
        metrics,
      );
      if (!parquet.exists) {
        missingParquetKeys.push(parquetKey);
        continue;
      }
      appendFilteredRows(parquet.rows, {
        startMs,
        endMs,
        sinceMs,
        outByObservedAt: rowsByObservedAt,
      });
    }
  }

  const normalizedRows = normalizeAndSortRows(rowsByObservedAt, limit);
  return {
    rows: normalizedRows.rows,
    limited_by_limit: normalizedRows.limited_by_limit,
    total_rows_before_limit: normalizedRows.total_rows_before_limit,
    days_scanned: days.length,
    scanned_parquet_files: scannedParquetKeys.length,
    missing_day_manifest_keys: missingDayManifestKeys,
    missing_connector_manifest_keys: missingConnectorManifestKeys,
    missing_parquet_keys: missingParquetKeys,
    metrics,
    timeseries_index: {
      enabled: timeseriesIndexEnabled,
      prefix: normalizedTimeseriesIndexPrefix,
      read_version: normalizedReadVersion,
      index_version: normalizedReadVersion,
      pollutant_partition: normalizedReadVersion === "v2" ? normalizedPollutantKey : null,
      scanned_connector_index_keys: timeseriesIndexScannedKeys.length,
      hit_count: timeseriesIndexHitCount,
      miss_count: timeseriesIndexMissCount,
      skipped_days_by_file_range: timeseriesIndexSkippedByRangeDays,
      skipped_files_by_time_range: timeseriesIndexSkippedByTimeRangeFiles,
      indexed_file_count_seen: timeseriesIndexIndexedFileCount,
      unknown_range_file_count_seen: timeseriesIndexUnknownRangeFileCount,
      missing_connector_index_keys: timeseriesIndexMissingKeys,
      warnings: timeseriesIndexWarnings,
    },
  };
}

async function handleRequest(requestParams, env) {
  const {
    timeseriesId,
    connectorId,
    pollutantKey,
    startIso,
    endIso,
    sinceIso,
    limit,
  } = requestParams;
  const readVersion = resolveR2HistoryVersion(env, { context: "R2 observations history API reads" });
  const historyPrefix = readVersion === "v2"
    ? (
      normalizePrefix(env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || DEFAULT_HISTORY_V2_PREFIX)
      || DEFAULT_HISTORY_V2_PREFIX
    )
    : (
      normalizePrefix(env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || DEFAULT_HISTORY_PREFIX)
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
        env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
          || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`,
      ) || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`
    )
    : (
      normalizePrefix(
        env.UK_AQ_OBSERVS_HISTORY_R2_TIMESERIES_INDEX_PREFIX
          || env.UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
          || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`,
      ) || `${historyIndexPrefix}/${DEFAULT_TIMESERIES_INDEX_SUBPREFIX}`
    );
  const cachePolicy = resolveCachePolicy(env, endIso);
  const { cacheSeconds, cacheScope } = cachePolicy;

  // --- DIAG: request_start ---
  const _diagRequestStart = Date.now();
  console.log("UK_AQ_OBSERVS_DIAG", JSON.stringify({
    stage: "request_start",
    read_version: readVersion,
    timeseries_id: timeseriesId,
    connector_id: connectorId,
    pollutant: pollutantKey,
    start_utc: startIso,
    end_utc: endIso,
    since_utc: sinceIso ?? null,
    limit: limit ?? null,
    observations_prefix: historyPrefix,
    history_index_prefix: historyIndexPrefix,
    timeseries_index_prefix: timeseriesIndexPrefix,
  }));
  // --- END DIAG ---

  const historyRead = await readHistoryRows({
    env,
    readVersion,
    historyPrefix,
    historyIndexPrefix,
    timeseriesIndexPrefix,
    timeseriesId,
    connectorId,
    pollutantKey,
    startIso,
    endIso,
    sinceIso,
    limit,
  });
  // --- DIAG: request_complete ---
  console.log("UK_AQ_OBSERVS_DIAG", JSON.stringify({
    stage: "request_complete",
    read_version: readVersion,
    timeseries_id: timeseriesId,
    connector_id: connectorId,
    pollutant: pollutantKey,
    start_utc: startIso,
    end_utc: endIso,
    r2_object_reads: historyRead.metrics?.r2_object_reads ?? null,
    parquet_bytes_read: historyRead.metrics?.parquet_bytes_read ?? null,
    parquet_row_groups_scanned: historyRead.metrics?.parquet_row_groups_scanned ?? null,
    matched_rows: historyRead.metrics?.parquet_matched_rows ?? null,
    scanned_parquet_files: historyRead.scanned_parquet_files,
    days_scanned: historyRead.days_scanned,
    ts_index_hits: historyRead.timeseries_index?.hit_count ?? null,
    ts_index_misses: historyRead.timeseries_index?.miss_count ?? null,
    ts_index_missing_keys_count: historyRead.timeseries_index?.missing_connector_index_keys?.length ?? null,
    row_count: historyRead.rows.length,
    duration_ms: Date.now() - _diagRequestStart,
  }));
  // --- END DIAG ---
  const completeness = summarizeCoverageCompleteness(historyRead);

  return jsonResponse({
    ok: true,
    generated_at_utc: new Date().toISOString(),
    read_version: readVersion,
    index_version: readVersion,
    pollutant: pollutantKey,
    history_prefix: historyPrefix,
    history_index_prefix: historyIndexPrefix,
    timeseries_index_prefix: timeseriesIndexPrefix,
    timeseries_id: timeseriesId,
    connector_id: connectorId,
    start_utc: startIso,
    end_utc: endIso,
    since_utc: sinceIso,
    cache_scope: cacheScope,
    row_count: historyRead.rows.length,
    response_complete: completeness.response_complete,
    has_gap: completeness.has_gap,
    coverage_state: completeness.coverage_state,
    partial_reasons: completeness.partial_reasons,
    rows: historyRead.rows,
    coverage: {
      read_version: readVersion,
      index_version: historyRead.timeseries_index?.index_version || readVersion,
      pollutant_partition: historyRead.timeseries_index?.pollutant_partition || null,
      history_prefix: historyPrefix,
      history_index_prefix: historyIndexPrefix,
      timeseries_index_prefix: timeseriesIndexPrefix,
      days_scanned: historyRead.days_scanned,
      scanned_parquet_files: historyRead.scanned_parquet_files,
      r2_object_reads: historyRead.metrics?.r2_object_reads ?? null,
      parquet_bytes_read: historyRead.metrics?.parquet_bytes_read ?? null,
      parquet_row_groups_scanned: historyRead.metrics?.parquet_row_groups_scanned ?? null,
      parquet_chunks_scanned: historyRead.metrics?.parquet_chunks_scanned ?? null,
      parquet_matched_rows: historyRead.metrics?.parquet_matched_rows ?? null,
      limited_by_limit: historyRead.limited_by_limit,
      total_rows_before_limit: historyRead.total_rows_before_limit,
      response_complete: completeness.response_complete,
      has_gap: completeness.has_gap,
      coverage_state: completeness.coverage_state,
      partial_reasons: completeness.partial_reasons,
      missing_day_manifest_keys: historyRead.missing_day_manifest_keys,
      missing_connector_manifest_keys:
        historyRead.missing_connector_manifest_keys,
      missing_parquet_keys: historyRead.missing_parquet_keys,
      timeseries_index: historyRead.timeseries_index,
    },
  }, {
    status: 200,
    cacheSeconds,
  });
}

async function handleTimeseriesMetadataRequest(requestParams, env) {
  const metadataIndexPrefix = resolveTimeseriesMetadataIndexPrefix(env);
  const metadataKey = buildTimeseriesMetadataIndexKey(
    metadataIndexPrefix,
    requestParams.timeseriesId,
  );
  const object = await fetchJsonObjectFromR2(env, metadataKey);
  if (!object.exists) {
    return jsonResponse({
      ok: false,
      error: "timeseries_metadata_not_found",
      timeseries_id: requestParams.timeseriesId,
      metadata_index_prefix: metadataIndexPrefix,
      metadata_key: metadataKey,
    }, {
      status: 404,
      cacheSeconds: 60,
    });
  }
  return jsonResponse({
    ok: true,
    timeseries_id: requestParams.timeseriesId,
    metadata_index_prefix: metadataIndexPrefix,
    metadata_key: metadataKey,
    metadata: object.value,
  }, {
    status: 200,
    cacheSeconds: DEFAULT_IMMUTABLE_CACHE_SECONDS,
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

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/v1/timeseries-metadata") {
      const requestParams = parseTimeseriesMetadataRequest(requestUrl);
      if (!requestParams.ok) {
        return jsonResponse({ ok: false, error: requestParams.error }, {
          status: requestParams.status,
          cacheSeconds: 30,
        });
      }
      const cacheKey = buildTimeseriesMetadataCacheKey(request.url, requestParams);
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        return withCacheMarker(cached, "HIT");
      }
      const response = await handleTimeseriesMetadataRequest(requestParams, env);
      if (response.ok) {
        ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      }
      return withCacheMarker(response, "MISS");
    }

    const requestParams = parseObservationsRequest(requestUrl);
    if (!requestParams.ok) {
      return jsonResponse({ ok: false, error: requestParams.error }, {
        status: requestParams.status,
        cacheSeconds: 30,
      });
    }

    const readVersion = resolveR2HistoryVersion(env, { context: "R2 observations history API reads" });
    const cacheKey = buildCanonicalCacheKey(request.url, requestParams, readVersion);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return withCacheMarker(cached, "HIT");
    }

    const _fetchStart = Date.now();
    let response;
    try {
      response = await handleRequest(requestParams, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const readVersion = resolveR2HistoryVersion(env, { context: "R2 observations history API reads" });
      // --- DIAG: error ---
      console.warn("UK_AQ_OBSERVS_ERROR", JSON.stringify({
        stage: "error",
        read_version: readVersion,
        route_path: requestUrl.pathname,
        timeseries_id: requestParams.timeseriesId,
        connector_id: requestParams.connectorId,
        pollutant: requestParams.pollutantKey,
        start_utc: requestParams.startIso,
        end_utc: requestParams.endIso,
        error_name: errorName,
        error_message: message,
        duration_ms: Date.now() - _fetchStart,
      }));
      // --- END DIAG ---
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
