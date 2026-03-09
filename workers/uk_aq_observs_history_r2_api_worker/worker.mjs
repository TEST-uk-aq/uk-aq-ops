import { parquetReadObjects } from "hyparquet";

const DEFAULT_HISTORY_PREFIX = "history/v1/observations";
const DEFAULT_CACHE_SECONDS = 300;
const MAX_CACHE_SECONDS = 3600;
const MAX_LIMIT = 20000;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_PATHS = new Set(["/", "/v1/observations"]);

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
    columns: ["timeseries_id", "observed_at", "value"],
  });
  return { exists: true, rows: Array.isArray(rows) ? rows : [] };
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

function normalizeValue(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function appendFilteredRows(rows, {
  timeseriesId,
  startMs,
  endMs,
  sinceMs,
  outByObservedAt,
}) {
  for (const row of rows) {
    const rowTimeseriesId = Number(row?.timeseries_id);
    if (!Number.isFinite(rowTimeseriesId) || rowTimeseriesId !== timeseriesId) {
      continue;
    }
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

function normalizeAndSortRows(rowsByObservedAt, limit) {
  const rows = Array.from(rowsByObservedAt.values()).sort((left, right) => {
    const leftMs = Date.parse(String(left.observed_at || "")) || 0;
    const rightMs = Date.parse(String(right.observed_at || "")) || 0;
    return leftMs - rightMs;
  });
  if (limit !== null && rows.length > limit) {
    return rows.slice(0, limit);
  }
  return rows;
}

async function readHistoryRows({
  env,
  historyPrefix,
  timeseriesId,
  connectorId,
  startIso,
  endIso,
  sinceIso,
  limit,
}) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;

  const days = listUtcDays(startIso, endIso);
  const rowsByObservedAt = new Map();
  const missingDayManifestKeys = [];
  const missingConnectorManifestKeys = [];
  const missingParquetKeys = [];
  const scannedParquetKeys = [];

  for (const dayUtc of days) {
    const dayManifestKey = buildDayManifestKey(historyPrefix, dayUtc);
    const dayManifestObject = await fetchJsonObjectFromR2(env, dayManifestKey);
    if (!dayManifestObject.exists) {
      missingDayManifestKeys.push(dayManifestKey);
      continue;
    }

    const connectorManifestFallbackKey = buildConnectorManifestKey(
      historyPrefix,
      dayUtc,
      connectorId,
    );
    const connectorManifestKey = findConnectorManifestKey(
      dayManifestObject.value,
      connectorId,
      connectorManifestFallbackKey,
    );
    const connectorManifestObject = await fetchJsonObjectFromR2(env, connectorManifestKey);
    if (!connectorManifestObject.exists) {
      missingConnectorManifestKeys.push(connectorManifestKey);
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
      scannedParquetKeys.push(parquetKey);
      const parquet = await fetchParquetRowsFromR2(env, parquetKey);
      if (!parquet.exists) {
        missingParquetKeys.push(parquetKey);
        continue;
      }
      appendFilteredRows(parquet.rows, {
        timeseriesId,
        startMs,
        endMs,
        sinceMs,
        outByObservedAt: rowsByObservedAt,
      });
    }
  }

  const rows = normalizeAndSortRows(rowsByObservedAt, limit);
  return {
    rows,
    days_scanned: days.length,
    scanned_parquet_files: scannedParquetKeys.length,
    missing_day_manifest_keys: missingDayManifestKeys,
    missing_connector_manifest_keys: missingConnectorManifestKeys,
    missing_parquet_keys: missingParquetKeys,
  };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (!VALID_PATHS.has(url.pathname)) {
    return jsonResponse({ ok: false, error: "Not found." }, { status: 404, cacheSeconds: 30 });
  }

  const timeseriesId = parseRequiredPositiveInt(url.searchParams.get("timeseries_id"));
  if (!timeseriesId) {
    return jsonResponse({
      ok: false,
      error: "timeseries_id must be a positive integer.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const connectorId = parseRequiredPositiveInt(url.searchParams.get("connector_id"));
  if (!connectorId) {
    return jsonResponse({
      ok: false,
      error: "connector_id must be a positive integer.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const startIso = toIsoOrNull(url.searchParams.get("start_utc"));
  const endIso = toIsoOrNull(url.searchParams.get("end_utc"));
  if (!startIso || !endIso) {
    return jsonResponse({
      ok: false,
      error: "start_utc and end_utc must be valid ISO timestamps.",
    }, { status: 400, cacheSeconds: 30 });
  }
  if (Date.parse(endIso) <= Date.parse(startIso)) {
    return jsonResponse({
      ok: false,
      error: "end_utc must be greater than start_utc.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const sinceIso = url.searchParams.has("since_utc")
    ? toIsoOrNull(url.searchParams.get("since_utc"))
    : null;
  if (url.searchParams.has("since_utc") && !sinceIso) {
    return jsonResponse({
      ok: false,
      error: "since_utc must be a valid ISO timestamp when provided.",
    }, { status: 400, cacheSeconds: 30 });
  }

  const limit = parseOptionalPositiveInt(url.searchParams.get("limit"), 1, MAX_LIMIT);
  if (url.searchParams.has("limit") && limit === null) {
    return jsonResponse({
      ok: false,
      error: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
    }, { status: 400, cacheSeconds: 30 });
  }

  const historyPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || DEFAULT_HISTORY_PREFIX,
  ) || DEFAULT_HISTORY_PREFIX;
  const cacheSeconds = parsePositiveInt(
    env.UK_AQ_OBSERVS_HISTORY_R2_CACHE_MAX_AGE_SECONDS,
    DEFAULT_CACHE_SECONDS,
    30,
    MAX_CACHE_SECONDS,
  );

  const historyRead = await readHistoryRows({
    env,
    historyPrefix,
    timeseriesId,
    connectorId,
    startIso,
    endIso,
    sinceIso,
    limit,
  });

  return jsonResponse({
    ok: true,
    generated_at_utc: new Date().toISOString(),
    history_prefix: historyPrefix,
    timeseries_id: timeseriesId,
    connector_id: connectorId,
    start_utc: startIso,
    end_utc: endIso,
    since_utc: sinceIso,
    row_count: historyRead.rows.length,
    rows: historyRead.rows,
    coverage: {
      days_scanned: historyRead.days_scanned,
      scanned_parquet_files: historyRead.scanned_parquet_files,
      missing_day_manifest_keys: historyRead.missing_day_manifest_keys,
      missing_connector_manifest_keys: historyRead.missing_connector_manifest_keys,
      missing_parquet_keys: historyRead.missing_parquet_keys,
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
