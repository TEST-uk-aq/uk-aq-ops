import { getFirstSearchParam, parseIsoMsOrNull } from "./request_window.mjs";

const HOUR_MS = 60 * 60 * 1000;
const AQI_HISTORY_CANONICALIZE_MIN_WINDOW_MS = 3 * 24 * HOUR_MS;
const AQI_HISTORY_START_KEYS = ["from_utc", "start_utc", "from", "start"];
const AQI_HISTORY_END_KEYS = ["to_utc", "end_utc", "to", "end"];
const AQI_HISTORY_PROXY_GENERATION_PARAM = "__uk_aq_aqi_proxy_generation_hour";
const AQI_HISTORY_PROXY_GENERATION_VERSION = "1";
const STATION_SERIES_PROXY_CONTRACT_PARAM = "__uk_aq_station_series_contract";
const STATION_SERIES_PROXY_CONTRACT_VERSION = "2";

function parseBooleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function canonicalizeStationSeriesRequestUrl(url, upstreamFunction, stationSeriesUpstream) {
  const original = new URL(url.toString());
  if (upstreamFunction !== stationSeriesUpstream) return original;
  // The response schema and upstream work differ materially when AQI is
  // disabled.  Always materialise the default so the two variants can never
  // share a public gateway cache entry.
  const includeAqi = !["0", "false", "no", "off"].includes(String(original.searchParams.get("include_aqi") ?? "").trim().toLowerCase());
  const normalized = new URL(original.origin + original.pathname);
  const timeseriesId = String(original.searchParams.get("timeseries_id") ?? "").trim();
  if (/^\d+$/.test(timeseriesId) && Number(timeseriesId) > 0) normalized.searchParams.set("timeseries_id", String(Number(timeseriesId)));
  const pollutant = String(original.searchParams.get("pollutant") ?? "").trim().toLowerCase().replace(/[\s._-]+/g, "");
  if (["pm25", "pm10", "no2"].includes(pollutant)) normalized.searchParams.set("pollutant", pollutant);
  for (const key of ["start_utc", "end_utc"]) {
    const parsed = parseIsoMsOrNull(original.searchParams.get(key));
    if (parsed !== null) normalized.searchParams.set(key, new Date(parsed).toISOString());
  }
  const window = String(original.searchParams.get("window") ?? "").trim().toLowerCase();
  if (window) normalized.searchParams.set("window", window);
  normalized.searchParams.set("format", "objects");
  normalized.searchParams.set("include_aqi", includeAqi ? "true" : "false");
  normalized.searchParams.set(STATION_SERIES_PROXY_CONTRACT_PARAM, STATION_SERIES_PROXY_CONTRACT_VERSION);
  // connector_id is a validation hint supplied by the browser. The private
  // Worker resolves connector authority from timeseries_id, so this hint must
  // never partition or define the successful public cache identity.
  return normalized;
}

export function stripStationSeriesCacheContractComponent(url) {
  const normalized = new URL(url.toString());
  normalized.searchParams.delete(STATION_SERIES_PROXY_CONTRACT_PARAM);
  return normalized;
}

export async function cachedStationSeriesIdentityMatchesRequest(response, requestUrl, upstreamFunction, stationSeriesUpstream) {
  if (upstreamFunction !== stationSeriesUpstream) return true;
  const suppliedText = String(requestUrl.searchParams.get("connector_id") ?? "").trim();
  if (!suppliedText) return true;
  if (!/^\d+$/.test(suppliedText) || Number(suppliedText) <= 0) return false;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return false;
  }
  const authoritativeConnectorId = Number(payload?.identity?.connector_id ?? payload?.request?.connector_id);
  return Number.isInteger(authoritativeConnectorId) && authoritativeConnectorId > 0
    && authoritativeConnectorId === Number(suppliedText);
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
