import { resolveTimeseriesWindowBounds } from "../timeseries_v2_stitch.mjs";
import { RequestValidationError } from "./contracts.mjs";

const TIMESERIES_V2_VERSION = "2";
const TIMESERIES_V2_ALLOWED_WINDOWS = new Set(["12h", "24h", "7d", "31d", "90d"]);
const TIMESERIES_V2_CACHE_BUSTER_KEYS = new Set(["_t", "timestamp", "cache_bust", "random"]);
const TIMESERIES_V2_PRIMARY_QUERY_KEYS = [
  "timeseries_id", "connector_id", "pollutant", "window", "since", "start_utc", "end_utc", "stable_head_start_utc", "format", "v",
];
const TIMESERIES_V2_DEFAULT_MAX_WINDOW_DAYS = 90;
const TIMESERIES_V2_MAX_WINDOW_DAYS_LIMIT = 365;
const TIMESERIES_V2_DEFAULT_MAX_R2_OBJECTS_PER_REQUEST = 1000;
const TIMESERIES_V2_DEFAULT_MAX_SUPABASE_TAIL_HOURS = 168;
const TIMESERIES_V2_DEFAULT_INCREMENTAL_OVERLAP_MINUTES = 180;
const TIMESERIES_V2_MAX_INCREMENTAL_OVERLAP_MINUTES = 720;

function parseBooleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function parseIntInRange(value, fallback, min, max) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return rounded < min || rounded > max ? fallback : rounded;
}

export function parseIsoMsOrNull(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getFirstSearchParam(url, keys) {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (String(value ?? "").trim()) return value;
  }
  return null;
}

function parsePositiveIntegerStringOrNull(value, min = 1, max = 2_147_483_647) {
  const text = String(value ?? "").trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) return null;
  return String(Math.floor(numeric));
}

function normalizeIsoOrNull(value) {
  const ms = parseIsoMsOrNull(value);
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function normalizeTimeseriesPollutantKey(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s._-]+/g, "");
  return normalized === "pm25" || normalized === "pm10" || normalized === "no2" ? normalized : null;
}

export function resolveTimeseriesV2FlagsFromEnv(envValues) {
  return {
    enabled: parseBooleanFlag(envValues.v2EnabledRaw),
    proxyFirst: parseBooleanFlag(envValues.proxyFirstRaw),
    r2First: parseBooleanFlag(envValues.r2FirstRaw),
    allowIngestOverwrite: parseBooleanFlag(envValues.allowIngestOverwriteRaw),
  };
}

export function isTimeseriesV2Request(url, upstreamFunction, flags, timeseriesUpstreamFunction) {
  return upstreamFunction === timeseriesUpstreamFunction
    && flags.enabled
    && flags.proxyFirst
    && String(url.searchParams.get("v") ?? "").trim() === TIMESERIES_V2_VERSION;
}

export function isProgressiveStationHistoryChunkRequest(url) {
  const startMs = parseIsoMsOrNull(url.searchParams.get("start_utc") || url.searchParams.get("from_utc"));
  const endMs = parseIsoMsOrNull(url.searchParams.get("end_utc") || url.searchParams.get("to_utc"));
  const stableHeadStartMs = parseIsoMsOrNull(url.searchParams.get("stable_head_start_utc"));
  return startMs !== null
    && endMs !== null
    && stableHeadStartMs !== null
    && endMs > startMs
    && endMs <= stableHeadStartMs
    && endMs - startMs <= 31 * 24 * 60 * 60 * 1000;
}

export function canonicalizeTimeseriesV2RequestUrl(url, allowCacheBypassParams) {
  const original = new URL(url.toString());
  const strippedCacheBusters = [];
  if (!allowCacheBypassParams) {
    for (const key of TIMESERIES_V2_CACHE_BUSTER_KEYS) {
      if (original.searchParams.has(key)) {
        strippedCacheBusters.push(key);
        original.searchParams.delete(key);
      }
    }
  }
  const timeseriesId = parsePositiveIntegerStringOrNull(original.searchParams.get("timeseries_id"));
  const connectorId = parsePositiveIntegerStringOrNull(original.searchParams.get("connector_id"));
  const rawWindow = String(original.searchParams.get("window") ?? "").trim().toLowerCase();
  const normalizedWindow = rawWindow && TIMESERIES_V2_ALLOWED_WINDOWS.has(rawWindow) ? rawWindow : null;
  const normalizedSince = normalizeIsoOrNull(original.searchParams.get("since"))
    ?? (String(original.searchParams.get("since") ?? "").trim() || null);
  const normalizedStartUtc = normalizeIsoOrNull(getFirstSearchParam(original, ["start_utc", "start"]));
  const normalizedEndUtc = normalizeIsoOrNull(getFirstSearchParam(original, ["end_utc", "end"]));
  const hasValidRange = Boolean(normalizedStartUtc && normalizedEndUtc && Date.parse(normalizedEndUtc) > Date.parse(normalizedStartUtc));
  const normalized = new URL(original.origin + original.pathname);
  if (timeseriesId) normalized.searchParams.set("timeseries_id", timeseriesId);
  if (connectorId) normalized.searchParams.set("connector_id", connectorId);
  const pollutantKey = normalizeTimeseriesPollutantKey(original.searchParams.get("pollutant"));
  if (pollutantKey) normalized.searchParams.set("pollutant", pollutantKey);
  if (normalizedWindow && !hasValidRange) normalized.searchParams.set("window", normalizedWindow);
  if (normalizedSince) normalized.searchParams.set("since", normalizedSince);
  if (hasValidRange && normalizedStartUtc && normalizedEndUtc) {
    normalized.searchParams.set("start_utc", normalizedStartUtc);
    normalized.searchParams.set("end_utc", normalizedEndUtc);
  }
  const stableHeadStartUtc = normalizeIsoOrNull(original.searchParams.get("stable_head_start_utc"));
  if (stableHeadStartUtc) normalized.searchParams.set("stable_head_start_utc", stableHeadStartUtc);
  normalized.searchParams.set("format", "json");
  normalized.searchParams.set("v", TIMESERIES_V2_VERSION);
  if (allowCacheBypassParams) {
    for (const [key, value] of original.searchParams.entries()) {
      if (!TIMESERIES_V2_PRIMARY_QUERY_KEYS.includes(key)) normalized.searchParams.append(key, value);
    }
  }
  return { url: normalized, strippedCacheBusters };
}

export function buildTimeseriesV2RuntimeConfig(env) {
  const maxWindowDays = parseIntInRange(String(env.UK_AQ_TIMESERIES_MAX_WINDOW_DAYS ?? ""), TIMESERIES_V2_DEFAULT_MAX_WINDOW_DAYS, 1, TIMESERIES_V2_MAX_WINDOW_DAYS_LIMIT);
  return {
    maxWindowDays,
    maxR2ObjectsPerRequest: parseIntInRange(String(env.UK_AQ_TIMESERIES_MAX_R2_OBJECTS_PER_REQUEST ?? ""), TIMESERIES_V2_DEFAULT_MAX_R2_OBJECTS_PER_REQUEST, 1, 2000),
    maxSupabaseTailHours: parseIntInRange(String(env.UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS ?? ""), TIMESERIES_V2_DEFAULT_MAX_SUPABASE_TAIL_HOURS, 1, maxWindowDays * 24),
    incrementalOverlapMinutes: parseIntInRange(String(env.UK_AQ_TIMESERIES_INCREMENTAL_OVERLAP_MINUTES ?? ""), TIMESERIES_V2_DEFAULT_INCREMENTAL_OVERLAP_MINUTES, 0, TIMESERIES_V2_MAX_INCREMENTAL_OVERLAP_MINUTES),
    partialOnR2Error: parseBooleanFlag(String(env.UK_AQ_TIMESERIES_PARTIAL_ON_R2_ERROR ?? "true")),
    partialOnIngestError: parseBooleanFlag(String(env.UK_AQ_TIMESERIES_PARTIAL_ON_INGEST_ERROR ?? "false")),
    recentEdgeTtlSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_RECENT_EDGE_TTL_SECONDS ?? ""), 60, 0, 604800),
    recentBrowserTtlSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_RECENT_BROWSER_TTL_SECONDS ?? ""), 60, 0, 604800),
    recentSwrSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_RECENT_SWR_SECONDS ?? ""), 60, 0, 604800),
    historicalEdgeTtlSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_HISTORICAL_EDGE_TTL_SECONDS ?? ""), 86400, 0, 604800),
    historicalBrowserTtlSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_HISTORICAL_BROWSER_TTL_SECONDS ?? ""), 86400, 0, 604800),
    historicalSwrSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_HISTORICAL_SWR_SECONDS ?? ""), 86400, 0, 604800),
    staleIfErrorSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_STALE_IF_ERROR_SECONDS ?? ""), 300, 0, 604800),
  };
}

export function buildTimeseriesV2RequestWindow(requestUrl, runtime) {
  const timeseriesIdText = parsePositiveIntegerStringOrNull(requestUrl.searchParams.get("timeseries_id"));
  if (!timeseriesIdText) throw new RequestValidationError(400, "timeseries_id_required");
  const connectorIdText = parsePositiveIntegerStringOrNull(requestUrl.searchParams.get("connector_id"));
  const pollutantKey = normalizeTimeseriesPollutantKey(requestUrl.searchParams.get("pollutant"));
  const rawWindow = String(requestUrl.searchParams.get("window") ?? "").trim().toLowerCase();
  const startUtc = getFirstSearchParam(requestUrl, ["start_utc", "start"]);
  const endUtc = getFirstSearchParam(requestUrl, ["end_utc", "end"]);
  const since = normalizeIsoOrNull(requestUrl.searchParams.get("since")) ?? (String(requestUrl.searchParams.get("since") ?? "").trim() || null);
  const bounds = resolveTimeseriesWindowBounds({ nowMs: Date.now(), windowLabel: rawWindow, startUtc, endUtc, maxWindowDays: runtime.maxWindowDays });
  if (!Number.isFinite(bounds.startMs) || !Number.isFinite(bounds.endMs) || bounds.endMs <= bounds.startMs) throw new RequestValidationError(400, "invalid_window");
  return { timeseriesId: Number(timeseriesIdText), connectorId: connectorIdText ? Number(connectorIdText) : null, pollutantKey, requestStartMs: bounds.startMs, requestEndMs: bounds.endMs, requestSinceIso: since, normalizedWindowLabel: bounds.normalizedWindowLabel };
}

export { normalizeTimeseriesPollutantKey };
