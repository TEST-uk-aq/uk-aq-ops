import { getFirstSearchParam, parseIsoMsOrNull } from "./request_window.mjs";

const HOUR_MS = 60 * 60 * 1000;
const AQI_HISTORY_CANONICALIZE_MIN_WINDOW_MS = 3 * 24 * HOUR_MS;
const AQI_HISTORY_START_KEYS = ["from_utc", "start_utc", "from", "start"];
const AQI_HISTORY_END_KEYS = ["to_utc", "end_utc", "to", "end"];
const AQI_HISTORY_PROXY_GENERATION_PARAM = "__uk_aq_aqi_proxy_generation_hour";
const AQI_HISTORY_PROXY_GENERATION_VERSION = "1";

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

export function canonicalizeAqiHistoryRequestUrl(url, upstreamFunction, aqiHistoryUpstream) {
  const normalized = new URL(url.toString());
  if (upstreamFunction !== aqiHistoryUpstream) return normalized;
  const requestedFormat = String(normalized.searchParams.get("format") || "").trim().toLowerCase();
  normalized.searchParams.set("format", requestedFormat === "tsv" ? "tsv" : requestedFormat === "objects" ? "objects" : "compact");
  const startMs = parseIsoMsOrNull(getFirstSearchParam(normalized, AQI_HISTORY_START_KEYS));
  const endMs = parseIsoMsOrNull(getFirstSearchParam(normalized, AQI_HISTORY_END_KEYS));
  if (startMs === null || endMs === null || endMs <= startMs || (endMs - startMs) < AQI_HISTORY_CANONICALIZE_MIN_WINDOW_MS) return normalized;
  const canonicalStartMs = Math.floor(startMs / HOUR_MS) * HOUR_MS;
  const canonicalEndMs = Math.floor(endMs / HOUR_MS) * HOUR_MS;
  if (!Number.isFinite(canonicalStartMs) || !Number.isFinite(canonicalEndMs) || canonicalEndMs <= canonicalStartMs) return normalized;
  const canonicalStartIso = new Date(canonicalStartMs).toISOString();
  const canonicalEndIso = new Date(canonicalEndMs).toISOString();
  for (const key of AQI_HISTORY_START_KEYS) if (normalized.searchParams.has(key)) normalized.searchParams.set(key, canonicalStartIso);
  for (const key of AQI_HISTORY_END_KEYS) if (normalized.searchParams.has(key)) normalized.searchParams.set(key, canonicalEndIso);
  return normalized;
}

export function resolveAqiMutableHours(raw, defaults) {
  return parseIntInRange(raw, defaults.defaultHours, defaults.minHours, defaults.maxHours);
}

export function isAqiProxyHourlyGenerationEnabled(raw) {
  return parseBooleanFlag(raw);
}

export function getAqiProxyGenerationHour(nowMs = Date.now()) {
  return new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS).toISOString();
}

export function isExplicitImmutableAqiHistoryRequest(url, mutableHours, nowMs = Date.now()) {
  const explicitEndMs = parseIsoMsOrNull(url.searchParams.get("to_utc") || url.searchParams.get("end_utc") || url.searchParams.get("to") || url.searchParams.get("end"));
  return explicitEndMs !== null && Number.isFinite(explicitEndMs) && explicitEndMs <= nowMs - mutableHours * HOUR_MS;
}

export function applyAqiProxyHourlyGenerationCacheComponent(url, upstreamFunction, enabled, mutableHours, aqiHistoryUpstream, nowMs = Date.now()) {
  const normalized = new URL(url.toString());
  if (upstreamFunction !== aqiHistoryUpstream) return normalized;
  normalized.searchParams.delete(AQI_HISTORY_PROXY_GENERATION_PARAM);
  if (enabled && !isExplicitImmutableAqiHistoryRequest(normalized, mutableHours, nowMs)) {
    normalized.searchParams.set(AQI_HISTORY_PROXY_GENERATION_PARAM, `${AQI_HISTORY_PROXY_GENERATION_VERSION}:${getAqiProxyGenerationHour(nowMs)}`);
  }
  return normalized;
}

export function stripAqiProxyHourlyGenerationCacheComponent(url) {
  const normalized = new URL(url.toString());
  normalized.searchParams.delete(AQI_HISTORY_PROXY_GENERATION_PARAM);
  return normalized;
}

export function resolveAqiCacheScope(upstreamFunction, url, mutableHours, hourlyGenerationEnabled, aqiHistoryUpstream) {
  if (upstreamFunction !== aqiHistoryUpstream) return null;
  if (isExplicitImmutableAqiHistoryRequest(url, mutableHours)) return "immutable";
  return hourlyGenerationEnabled ? "recent_hourly" : "recent_legacy";
}

export function addAqiCacheDiagnosticHeaders(headers, upstreamFunction, url, mutableHours, hourlyGenerationEnabled, aqiHistoryUpstream) {
  const scope = resolveAqiCacheScope(upstreamFunction, url, mutableHours, hourlyGenerationEnabled, aqiHistoryUpstream);
  if (!scope) return;
  headers.set("X-UK-AQ-AQI-Cache-Scope", scope);
  headers.set("X-UK-AQ-AQI-Mutable-Hours", String(mutableHours));
  const generation = url.searchParams.get(AQI_HISTORY_PROXY_GENERATION_PARAM);
  if (generation) headers.set("X-UK-AQ-AQI-Generation", generation);
}
