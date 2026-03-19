import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const DEFAULT_HISTORY_PREFIX = "history/v1/aqilevels";
const DEFAULT_CACHE_SECONDS = 300;
const MAX_CACHE_SECONDS = 3600;
const MAX_LIMIT = 20000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_OBSAQIDB_SOURCE_OF_TRUTH_HOURS = 24 * 7;
const MAX_OBSAQIDB_SOURCE_OF_TRUTH_HOURS = MAX_RANGE_DAYS * 24;
const DEFAULT_OBSAQIDB_TIMEOUT_MS = 10000;
const MIN_OBSAQIDB_TIMEOUT_MS = 2000;
const MAX_OBSAQIDB_TIMEOUT_MS = 30000;
const UK_AQ_PUBLIC_SCHEMA_DEFAULT = "uk_aq_public";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const VALID_PATHS = new Set(["/", "/v1/aqi-history"]);

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

function cacheControlHeader(cacheSeconds) {
  return `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`;
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

async function fetchParquetRowsFromR2(env, key) {
  const object = await env.UK_AQ_HISTORY_BUCKET.get(key);
  if (!object) {
    return { exists: false, rows: [] };
  }
  const arrayBuffer = await object.arrayBuffer();
  const rows = await parquetReadObjects({
    file: arrayBuffer,
    rowFormat: "object",
    columns: [
      "station_id",
      "timestamp_hour_utc",
      "daqi_no2_index_level",
      "daqi_pm25_rolling24h_index_level",
      "daqi_pm10_rolling24h_index_level",
      "eaqi_no2_index_level",
      "eaqi_pm25_index_level",
      "eaqi_pm10_index_level",
    ],
    compressors,
  });
  return { exists: true, rows: Array.isArray(rows) ? rows : [] };
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

function buildEmptyHistoryRead() {
  return {
    points: [],
    days_scanned: 0,
    scanned_connector_manifests: 0,
    scanned_parquet_files: 0,
    missing_day_manifest_keys: [],
    missing_connector_manifest_keys: [],
    missing_parquet_keys: [],
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
  stationId,
  startMs,
  endMs,
  sinceMs,
  outByPeriodStart,
}) {
  for (const row of rows) {
    const rowStationId = Number(row?.station_id);
    if (!Number.isFinite(rowStationId) || rowStationId !== stationId) {
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

    const daqi = maxFiniteIndex([
      row?.daqi_no2_index_level,
      row?.daqi_pm25_rolling24h_index_level,
      row?.daqi_pm10_rolling24h_index_level,
    ], 10);
    const eaqi = maxFiniteIndex([
      row?.eaqi_no2_index_level,
      row?.eaqi_pm25_index_level,
      row?.eaqi_pm10_index_level,
    ], 6);

    if (daqi === null && eaqi === null) {
      continue;
    }

    outByPeriodStart.set(periodStart, {
      period_start_utc: periodStart,
      daqi_index_level: daqi,
      eaqi_index_level: eaqi,
      station_id: rowStationId,
    });
  }
}

async function readHistoryRows({
  env,
  historyPrefix,
  stationId,
  startIso,
  endIso,
  sinceIso,
  limit,
}) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;

  const days = listUtcDays(startIso, endIso);
  const rowsByPeriodStart = new Map();
  const missingDayManifestKeys = [];
  const missingConnectorManifestKeys = new Set();
  const missingParquetKeys = new Set();
  const scannedParquetKeys = new Set();
  let scannedConnectorManifests = 0;

  for (const dayUtc of days) {
    const dayManifestKey = buildDayManifestKey(historyPrefix, dayUtc);
    const dayManifestObject = await fetchJsonObjectFromR2(env, dayManifestKey);
    if (!dayManifestObject.exists) {
      missingDayManifestKeys.push(dayManifestKey);
      continue;
    }

    const connectorManifestEntries = Array.isArray(dayManifestObject.value?.connector_manifests)
      ? dayManifestObject.value.connector_manifests
      : [];

    for (const connectorManifestEntry of connectorManifestEntries) {
      const connectorId = Number(connectorManifestEntry?.connector_id);
      if (!Number.isFinite(connectorId) || connectorId <= 0) {
        continue;
      }
      const connectorManifestKey = String(connectorManifestEntry?.manifest_key || "").trim()
        || buildConnectorManifestKey(historyPrefix, dayUtc, connectorId);

      scannedConnectorManifests += 1;
      const connectorManifestObject = await fetchJsonObjectFromR2(env, connectorManifestKey);
      if (!connectorManifestObject.exists) {
        missingConnectorManifestKeys.add(connectorManifestKey);
        continue;
      }

      const files = Array.isArray(connectorManifestObject.value?.files)
        ? connectorManifestObject.value.files
        : [];

      for (const fileEntry of files) {
        const parquetKey = String(fileEntry?.key || "").trim();
        if (!parquetKey) {
          continue;
        }
        scannedParquetKeys.add(parquetKey);
        const parquet = await fetchParquetRowsFromR2(env, parquetKey);
        if (!parquet.exists) {
          missingParquetKeys.add(parquetKey);
          continue;
        }
        appendFilteredRows(parquet.rows, {
          stationId,
          startMs,
          endMs,
          sinceMs,
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
  };
}

async function readRecentRowsFromObsAqiDb({
  env,
  stationId,
  startIso,
  endIso,
  sinceIso,
}) {
  const baseUrl = normalizeBaseUrl(env.OBS_AQIDB_SUPABASE_URL || "");
  const apiKey = String(env.OBS_AQIDB_SECRET_KEY || "").trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      "Missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY for recent AQI reads.",
    );
  }

  const schema = String(env.UK_AQ_PUBLIC_SCHEMA || UK_AQ_PUBLIC_SCHEMA_DEFAULT).trim()
    || UK_AQ_PUBLIC_SCHEMA_DEFAULT;
  const timeoutMs = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_OBSAQIDB_TIMEOUT_MS,
    DEFAULT_OBSAQIDB_TIMEOUT_MS,
    MIN_OBSAQIDB_TIMEOUT_MS,
    MAX_OBSAQIDB_TIMEOUT_MS,
  );

  const endpoint = new URL(`${baseUrl}/rest/v1/uk_aq_station_aqi_hourly`);
  endpoint.searchParams.set(
    "select",
    [
      "station_id",
      "timestamp_hour_utc",
      "daqi_no2_index_level",
      "daqi_pm25_rolling24h_index_level",
      "daqi_pm10_rolling24h_index_level",
      "eaqi_no2_index_level",
      "eaqi_pm25_index_level",
      "eaqi_pm10_index_level",
    ].join(","),
  );
  endpoint.searchParams.append("station_id", `eq.${stationId}`);
  endpoint.searchParams.append(
    "timestamp_hour_utc",
    `gte.${startIso}`,
  );
  endpoint.searchParams.append(
    "timestamp_hour_utc",
    `lt.${endIso}`,
  );
  if (sinceIso) {
    endpoint.searchParams.append(
      "timestamp_hour_utc",
      `gt.${sinceIso}`,
    );
  }
  endpoint.searchParams.set("order", "timestamp_hour_utc.asc");
  endpoint.searchParams.set("limit", String(MAX_LIMIT));

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
      throw new Error("ObsAQIDB request timed out.");
    }
    throw new Error(`ObsAQIDB request failed: ${String(error)}`);
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
      `ObsAQIDB response failed (${response.status}): ${String(message || "unknown error")}`,
    );
  }

  const rowsByPeriodStart = new Map();
  appendFilteredRows(payload, {
    stationId,
    startMs: Date.parse(startIso),
    endMs: Date.parse(endIso),
    sinceMs: sinceIso ? Date.parse(sinceIso) : Number.NaN,
    outByPeriodStart: rowsByPeriodStart,
  });

  return {
    source_path: `${schema}.uk_aq_station_aqi_hourly`,
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

  const scope = String(url.searchParams.get("scope") || "station").trim().toLowerCase();
  if (scope !== "station") {
    return jsonResponse({
      ok: false,
      error: "scope must be station.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const grain = String(url.searchParams.get("grain") || "hourly").trim().toLowerCase();
  if (grain !== "hourly") {
    return jsonResponse({
      ok: false,
      error: "grain must be hourly.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const stationId = parseRequiredPositiveInt(
    url.searchParams.get("station_id")
      || url.searchParams.get("entity")
      || url.searchParams.get("entity_id"),
  );
  if (!stationId) {
    return jsonResponse({
      ok: false,
      error: "station_id (or entity/entity_id) must be a positive integer.",
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
  const cacheSeconds = parsePositiveInt(
    env.UK_AQ_AQI_HISTORY_R2_CACHE_MAX_AGE_SECONDS,
    DEFAULT_CACHE_SECONDS,
    30,
    MAX_CACHE_SECONDS,
  );
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

  const historyRead = hasHistoryWindow
    ? await readHistoryRows({
      env,
      historyPrefix,
      stationId,
      startIso: new Date(historyStartMs).toISOString(),
      endIso: new Date(historyEndMs).toISOString(),
      sinceIso,
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
        stationId,
        startIso: new Date(recentStartMs).toISOString(),
        endIso: new Date(recentEndMs).toISOString(),
        sinceIso,
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
        recentHistoryFallbackRead = await readHistoryRows({
          env,
          historyPrefix,
          stationId,
          startIso: new Date(recentStartMs).toISOString(),
          endIso: new Date(recentEndMs).toISOString(),
          sinceIso,
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
    scope,
    grain,
    entity_id: String(stationId),
    station_id: stationId,
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
