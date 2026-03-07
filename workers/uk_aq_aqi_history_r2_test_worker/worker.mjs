import { parquetReadObjects } from "hyparquet";

const DEFAULT_PREFIX = "aqi-r2-test/v1";
const DEFAULT_CACHE_SECONDS = 300;
const DEFAULT_ROW_LIMIT = 5000;
const MAX_ROW_LIMIT = 20000;

const VALID_SCOPES = new Set(["station", "pcon", "la", "region"]);
const VALID_GRAINS = new Set(["hourly", "daily", "monthly"]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function normalizePrefix(raw) {
  return String(raw || "").trim().replace(/^\/+|\/+$/g, "");
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
}

function parsePositiveInt(raw, fallback, min = 1, max = 100000) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  const value = Math.trunc(num);
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function nowMs() {
  return Date.now();
}

function durationMs(startMs) {
  return Math.max(0, nowMs() - startMs);
}

function cacheControl(cacheSeconds) {
  return `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`;
}

function jsonStringify(body) {
  return JSON.stringify(body);
}

function jsonResponse(body, {
  status = 200,
  cacheSeconds = DEFAULT_CACHE_SECONDS,
  extraHeaders = {},
} = {}) {
  return new Response(jsonStringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl(cacheSeconds),
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

function buildServerTiming(timing) {
  const parts = [];
  for (const [label, value] of Object.entries(timing)) {
    const safeLabel = String(label || "").trim();
    if (!safeLabel) continue;
    const duration = Number(value);
    if (!Number.isFinite(duration) || duration < 0) continue;
    parts.push(`${safeLabel};dur=${duration.toFixed(2)}`);
  }
  return parts.join(", ");
}

async function fetchJsonObjectFromR2(env, key) {
  const object = await env.AQI_R2_TEST_BUCKET.get(key);
  if (!object) {
    return null;
  }
  const text = await object.text();
  return JSON.parse(text);
}

async function fetchManifest(env, prefix) {
  const manifestKey = `${prefix}/manifest.json`;
  const manifest = await fetchJsonObjectFromR2(env, manifestKey);
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.entities)) {
    throw new Error(`Manifest missing or invalid at ${manifestKey}`);
  }
  return {
    manifest,
    manifestKey,
  };
}

function filterManifestEntities(manifest, scope, grain) {
  let entities = manifest.entities;
  if (scope) {
    entities = entities.filter((entry) => String(entry.scope || "") === scope);
  }
  if (grain) {
    entities = entities.filter((entry) => String(entry.grain || "") === grain);
  }
  return entities;
}

function findManifestEntity(manifest, scope, grain, entityId) {
  return manifest.entities.find((entry) => {
    return String(entry.scope || "") === scope
      && String(entry.grain || "") === grain
      && String(entry.entity_id || "") === entityId;
  }) || null;
}

function normalizePoints(rows, rowLimit) {
  const normalized = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    normalized.push({
      period_start_utc: String(row.period_start_utc || "").trim() || null,
      daqi_index_level: numberOrNull(row.daqi_index_level),
      eaqi_index_level: numberOrNull(row.eaqi_index_level),
      station_count: numberOrNull(row.station_count),
      source_type: String(row.source_type || "").trim() || null,
    });
    if (normalized.length >= rowLimit) {
      break;
    }
  }

  normalized.sort((a, b) => {
    const left = Date.parse(String(a.period_start_utc || "")) || 0;
    const right = Date.parse(String(b.period_start_utc || "")) || 0;
    return left - right;
  });

  return normalized;
}

async function readParquetRowsFromR2(env, key, rowLimit) {
  const object = await env.AQI_R2_TEST_BUCKET.get(key);
  if (!object) {
    return {
      exists: false,
      rows: [],
      objectBytes: null,
      objectEtag: null,
    };
  }

  const arrayBuffer = await object.arrayBuffer();
  const rows = await parquetReadObjects({ file: arrayBuffer, rowFormat: "object" });

  return {
    exists: true,
    rows: normalizePoints(rows, rowLimit),
    objectBytes: Number(object.size || 0),
    objectEtag: object.httpEtag || null,
  };
}

function allowedPathname(pathname) {
  const allowed = new Set([
    "/",
    "/manifest",
    "/data",
    "/v1/aqi-history",
    "/v1/aqi-history/manifest",
    "/v1/aqi-history/data",
  ]);
  return allowed.has(pathname);
}

function routeKind(pathname) {
  if (pathname === "/manifest" || pathname === "/v1/aqi-history/manifest") {
    return "manifest";
  }
  return "data";
}

async function handleManifestRequest(request, env, prefix) {
  const routeStart = nowMs();
  const { manifest, manifestKey } = await fetchManifest(env, prefix);

  const url = new URL(request.url);
  const scope = (url.searchParams.get("scope") || "").trim();
  const grain = (url.searchParams.get("grain") || "").trim();

  const entities = filterManifestEntities(manifest, scope || null, grain || null);

  const timing = {
    total: durationMs(routeStart),
  };

  return jsonResponse({
    ok: true,
    generated_at_utc: new Date().toISOString(),
    prefix,
    manifest_key: manifestKey,
    scope: scope || null,
    grain: grain || null,
    dataset_count: entities.length,
    entities,
  }, {
    cacheSeconds: 120,
    extraHeaders: {
      "Server-Timing": buildServerTiming(timing),
    },
  });
}

async function handleDataRequest(request, env, prefix) {
  const totalStart = nowMs();

  const url = new URL(request.url);
  const scope = (url.searchParams.get("scope") || "").trim().toLowerCase();
  const grain = (url.searchParams.get("grain") || "").trim().toLowerCase();
  const entityId = (url.searchParams.get("entity") || url.searchParams.get("entity_id") || "").trim();
  const cacheBuster = (url.searchParams.get("v") || "").trim() || null;

  if (!VALID_SCOPES.has(scope)) {
    return jsonResponse({ ok: false, error: "Invalid scope" }, { status: 400, cacheSeconds: 30 });
  }
  if (!VALID_GRAINS.has(grain)) {
    return jsonResponse({ ok: false, error: "Invalid grain" }, { status: 400, cacheSeconds: 30 });
  }
  if (!entityId) {
    return jsonResponse({ ok: false, error: "entity or entity_id is required" }, { status: 400, cacheSeconds: 30 });
  }

  const rowLimit = parsePositiveInt(url.searchParams.get("row_limit"), DEFAULT_ROW_LIMIT, 1, MAX_ROW_LIMIT);

  const manifestStart = nowMs();
  const { manifest } = await fetchManifest(env, prefix);
  const manifestMs = durationMs(manifestStart);

  const entry = findManifestEntity(manifest, scope, grain, entityId);
  if (!entry) {
    return jsonResponse({
      ok: false,
      error: "Dataset not found for scope/grain/entity",
      scope,
      grain,
      entity_id: entityId,
      prefix,
    }, {
      status: 404,
      cacheSeconds: 30,
      extraHeaders: {
        "Server-Timing": buildServerTiming({ manifest: manifestMs, total: durationMs(totalStart) }),
      },
    });
  }

  const parquetStart = nowMs();
  const parquet = await readParquetRowsFromR2(env, String(entry.fetch_path), rowLimit);
  const parquetMs = durationMs(parquetStart);

  if (!parquet.exists) {
    return jsonResponse({
      ok: false,
      error: "Parquet object missing in R2",
      scope,
      grain,
      entity_id: entityId,
      source_path: entry.fetch_path,
      prefix,
    }, {
      status: 404,
      cacheSeconds: 30,
      extraHeaders: {
        "Server-Timing": buildServerTiming({ manifest: manifestMs, parquet: parquetMs, total: durationMs(totalStart) }),
      },
    });
  }

  const payload = {
    ok: true,
    generated_at_utc: new Date().toISOString(),
    prefix,
    scope,
    grain,
    entity_id: entityId,
    entity_name: String(entry.entity_name || entityId),
    source_path: String(entry.fetch_path),
    cache_buster: cacheBuster,
    object_bytes: parquet.objectBytes,
    object_etag: parquet.objectEtag,
    row_count: parquet.rows.length,
    points: parquet.rows,
  };

  const timing = {
    manifest: manifestMs,
    parquet: parquetMs,
    total: durationMs(totalStart),
  };

  return jsonResponse(payload, {
    cacheSeconds: parsePositiveInt(env.AQI_R2_TEST_CACHE_MAX_AGE_SECONDS, DEFAULT_CACHE_SECONDS, 30, 3600),
    extraHeaders: {
      "Server-Timing": buildServerTiming(timing),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405, cacheSeconds: 30 });
    }

    const url = new URL(request.url);
    if (!allowedPathname(url.pathname)) {
      return jsonResponse({ ok: false, error: "Not found" }, { status: 404, cacheSeconds: 30 });
    }

    const prefix = normalizePrefix(env.AQI_R2_TEST_PREFIX || DEFAULT_PREFIX) || DEFAULT_PREFIX;
    const cacheKey = new Request(url.toString(), { method: "GET" });

    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return withCacheMarker(cached, "HIT");
    }

    let response;
    try {
      const kind = routeKind(url.pathname);
      response = kind === "manifest"
        ? await handleManifestRequest(request, env, prefix)
        : await handleDataRequest(request, env, prefix);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response = jsonResponse({
        ok: false,
        error: message,
        prefix,
      }, {
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
