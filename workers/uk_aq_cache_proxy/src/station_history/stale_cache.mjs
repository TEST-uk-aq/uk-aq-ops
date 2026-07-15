const CACHE_KEY_VERSION = "station-history-stale-v1";
const CACHE_KEY_PARAM = "__uk_aq_station_history_cache";
const AQI_GENERATION_PARAM = "__uk_aq_aqi_proxy_generation_hour";

const HEADER_VERSION = "X-UK-AQ-Station-History-Cache-Key-Version";
const HEADER_ENTRY = "X-UK-AQ-Station-History-Cache-Entry";
const HEADER_STATE = "X-UK-AQ-Station-History-Cache-State";
const HEADER_CACHED_AT = "X-UK-AQ-Station-History-Cached-At";
const HEADER_FRESH_UNTIL = "X-UK-AQ-Station-History-Fresh-Until";
const HEADER_STALE_UNTIL = "X-UK-AQ-Station-History-Stale-Until";
const HEADER_STALE_REASON = "X-UK-AQ-Station-History-Stale-Reason";
const HEADER_PUBLIC_CACHE_CONTROL = "X-UK-AQ-Station-History-Public-Cache-Control";

const DEFAULTS = Object.freeze({
  enabled: false,
  recentBundleFreshSeconds: 60,
  recentBundleMaxStaleSeconds: 300,
  mutableAqiMaxStaleSeconds: 300,
  mutableObservationMaxStaleSeconds: 300,
  immutableHistoryMaxStaleSeconds: 604800,
});

function parseBooleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function parseIntInRange(value, fallback, min, max) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.floor(number);
  return rounded >= min && rounded <= max ? rounded : fallback;
}

export function resolveStaleCacheConfig(env = {}) {
  return {
    enabled: parseBooleanFlag(env.UK_AQ_STATION_HISTORY_STALE_FALLBACK_ENABLED),
    recentBundleFreshSeconds: parseIntInRange(
      env.UK_AQ_STATION_HISTORY_RECENT_BUNDLE_FRESH_TTL_SECONDS,
      DEFAULTS.recentBundleFreshSeconds,
      1,
      3600,
    ),
    recentBundleMaxStaleSeconds: parseIntInRange(
      env.UK_AQ_STATION_HISTORY_RECENT_BUNDLE_MAX_STALE_SECONDS,
      DEFAULTS.recentBundleMaxStaleSeconds,
      0,
      86400,
    ),
    mutableAqiMaxStaleSeconds: parseIntInRange(
      env.UK_AQ_STATION_HISTORY_MUTABLE_AQI_MAX_STALE_SECONDS,
      DEFAULTS.mutableAqiMaxStaleSeconds,
      0,
      86400,
    ),
    mutableObservationMaxStaleSeconds: parseIntInRange(
      env.UK_AQ_STATION_HISTORY_MUTABLE_OBSERVATION_MAX_STALE_SECONDS,
      DEFAULTS.mutableObservationMaxStaleSeconds,
      0,
      86400,
    ),
    immutableHistoryMaxStaleSeconds: parseIntInRange(
      env.UK_AQ_STATION_HISTORY_IMMUTABLE_HISTORY_MAX_STALE_SECONDS,
      DEFAULTS.immutableHistoryMaxStaleSeconds,
      0,
      2592000,
    ),
  };
}

export function buildFreshAndStaleCacheKeys(normalizedUrl) {
  const freshUrl = new URL(normalizedUrl.toString());
  freshUrl.searchParams.delete(CACHE_KEY_PARAM);
  freshUrl.searchParams.set(CACHE_KEY_PARAM, `${CACHE_KEY_VERSION}:fresh`);

  const staleUrl = new URL(normalizedUrl.toString());
  staleUrl.searchParams.delete(CACHE_KEY_PARAM);
  staleUrl.searchParams.delete(AQI_GENERATION_PARAM);
  staleUrl.searchParams.set(CACHE_KEY_PARAM, `${CACHE_KEY_VERSION}:stale`);
  return {
    fresh: new Request(freshUrl.toString(), { method: "GET" }),
    stale: new Request(staleUrl.toString(), { method: "GET" }),
  };
}

export function isSupportedStationHistoryStaleRequest(url, internalRoute) {
  if (!["/v1/station-series", "/v1/aqi-history", "/v1/observations-history"].includes(internalRoute)) {
    return false;
  }
  const format = String(url.searchParams.get("format") || "objects").trim().toLowerCase();
  return format !== "tsv";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasKnownGap(section) {
  if (!isObject(section)) return false;
  if (section.has_gap === true) return true;
  return Array.isArray(section.gap_ranges) && section.gap_ranges.length > 0;
}

export function inspectCompleteGapFreePayload(payload, internalRoute) {
  if (!isObject(payload)) return { cacheable: false, immutable: false, reason: "unsupported_payload" };
  if (internalRoute === "/v1/station-series") {
    const aqi = payload.aqi;
    const observations = payload.observations;
    const cacheable = isObject(aqi)
      && isObject(observations)
      && aqi.response_complete === true
      && observations.response_complete === true
      && !hasKnownGap(aqi)
      && !hasKnownGap(observations);
    return { cacheable, immutable: false, reason: cacheable ? null : "incomplete_or_gap" };
  }
  const complete = payload.response_complete === true && !hasKnownGap(payload);
  const immutable = payload?.chunk?.cache_class === "immutable";
  return { cacheable: complete, immutable, reason: complete ? null : "incomplete_or_gap" };
}

export async function inspectStationHistoryResponse(response, internalRoute) {
  if (response.status !== 200) return { cacheable: false, immutable: false, reason: "status" };
  if ((response.headers.get("X-UK-AQ-Station-History-Contract") || "").trim() !== "v1") {
    return { cacheable: false, immutable: false, reason: "unsupported_contract" };
  }
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return { cacheable: false, immutable: false, reason: "unsupported_content_type" };
  }
  let payload;
  try {
    payload = await response.clone().json();
  } catch (_error) {
    return { cacheable: false, immutable: false, reason: "invalid_json" };
  }
  return { ...inspectCompleteGapFreePayload(payload, internalRoute), payload };
}

export function resolveRouteCachePolicy(internalRoute, inspection, config, existingFreshSeconds) {
  if (internalRoute === "/v1/station-series") {
    return {
      freshSeconds: config.recentBundleFreshSeconds,
      maxStaleSeconds: config.recentBundleMaxStaleSeconds,
      className: "recent_bundle",
    };
  }
  if (inspection.immutable) {
    return {
      freshSeconds: Math.max(1, Math.floor(existingFreshSeconds || 86400)),
      maxStaleSeconds: config.immutableHistoryMaxStaleSeconds,
      className: "immutable_history",
    };
  }
  return {
    freshSeconds: Math.max(1, Math.floor(existingFreshSeconds || (internalRoute === "/v1/aqi-history" ? 3900 : 300))),
    maxStaleSeconds: internalRoute === "/v1/aqi-history"
      ? config.mutableAqiMaxStaleSeconds
      : config.mutableObservationMaxStaleSeconds,
    className: internalRoute === "/v1/aqi-history" ? "mutable_aqi" : "mutable_observations",
  };
}

export function resolveFreshSecondsFromCacheControl(value, fallback) {
  const text = String(value || "").toLowerCase();
  const shared = /(?:^|,)\s*s-maxage=(\d+)/.exec(text);
  const browser = /(?:^|,)\s*max-age=(\d+)/.exec(text);
  const parsed = Number(shared?.[1] || browser?.[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Math.max(1, Math.floor(fallback));
}

export function buildCacheMetadata(nowMs, policy) {
  const cachedAtMs = Math.floor(nowMs);
  const freshUntilMs = cachedAtMs + policy.freshSeconds * 1000;
  const staleUntilMs = freshUntilMs + policy.maxStaleSeconds * 1000;
  return {
    version: CACHE_KEY_VERSION,
    class_name: policy.className,
    cached_at: new Date(cachedAtMs).toISOString(),
    fresh_until: new Date(freshUntilMs).toISOString(),
    stale_until: new Date(staleUntilMs).toISOString(),
    cached_at_ms: cachedAtMs,
    fresh_until_ms: freshUntilMs,
    stale_until_ms: staleUntilMs,
  };
}

function applyMetadataHeaders(headers, metadata) {
  headers.set(HEADER_VERSION, metadata.version);
  headers.set(HEADER_CACHED_AT, metadata.cached_at);
  headers.set(HEADER_FRESH_UNTIL, metadata.fresh_until);
  headers.set(HEADER_STALE_UNTIL, metadata.stale_until);
}

export function applyRefreshMetadataHeaders(headers, metadata) {
  applyMetadataHeaders(headers, metadata);
  headers.set(HEADER_STATE, "REFRESHED");
  headers.delete(HEADER_STALE_REASON);
}

export function buildStoredCacheResponse(response, metadata, entryKind, storageTtlSeconds) {
  const headers = new Headers(response.headers);
  const publicCacheControl = headers.get("Cache-Control") || "no-store";
  headers.set(HEADER_PUBLIC_CACHE_CONTROL, publicCacheControl);
  headers.set(HEADER_ENTRY, entryKind);
  applyMetadataHeaders(headers, metadata);
  headers.set("Cache-Control", `public, max-age=${Math.max(1, Math.floor(storageTtlSeconds))}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function readCacheMetadata(response) {
  const cachedAt = response.headers.get(HEADER_CACHED_AT);
  const freshUntil = response.headers.get(HEADER_FRESH_UNTIL);
  const staleUntil = response.headers.get(HEADER_STALE_UNTIL);
  const cachedAtMs = Date.parse(String(cachedAt || ""));
  const freshUntilMs = Date.parse(String(freshUntil || ""));
  const staleUntilMs = Date.parse(String(staleUntil || ""));
  if (![cachedAtMs, freshUntilMs, staleUntilMs].every(Number.isFinite)) return null;
  return {
    version: response.headers.get(HEADER_VERSION),
    cached_at: cachedAt,
    fresh_until: freshUntil,
    stale_until: staleUntil,
    cached_at_ms: cachedAtMs,
    fresh_until_ms: freshUntilMs,
    stale_until_ms: staleUntilMs,
  };
}

export function isFreshCacheResponse(response, nowMs = Date.now()) {
  const metadata = readCacheMetadata(response);
  return Boolean(metadata && metadata.version === CACHE_KEY_VERSION && nowMs <= metadata.fresh_until_ms);
}

export function isValidStaleCacheResponse(response, nowMs = Date.now()) {
  const metadata = readCacheMetadata(response);
  return Boolean(metadata && metadata.version === CACHE_KEY_VERSION && nowMs <= metadata.stale_until_ms);
}

function publicHeadersFromStored(response) {
  const headers = new Headers(response.headers);
  const publicCacheControl = headers.get(HEADER_PUBLIC_CACHE_CONTROL);
  headers.delete(HEADER_ENTRY);
  headers.delete(HEADER_PUBLIC_CACHE_CONTROL);
  if (publicCacheControl) headers.set("Cache-Control", publicCacheControl);
  return headers;
}

export function buildFreshHitResponse(response) {
  const headers = publicHeadersFromStored(response);
  headers.set(HEADER_STATE, "FRESH");
  headers.delete(HEADER_STALE_REASON);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function buildStaleFallbackResponse(response, reason = "upstream_failure") {
  const metadata = readCacheMetadata(response);
  if (!metadata) return null;
  let payload;
  try {
    payload = await response.clone().json();
  } catch (_error) {
    return null;
  }
  if (!isObject(payload)) return null;
  payload.station_history_cache = {
    state: "stale",
    reason,
    cached_at: metadata.cached_at,
    fresh_until: metadata.fresh_until,
    stale_until: metadata.stale_until,
  };
  const headers = publicHeadersFromStored(response);
  headers.set(HEADER_STATE, "STALE");
  headers.set(HEADER_STALE_REASON, reason);
  headers.set("X-UK-AQ-Cache", "STALE");
  headers.set("Cache-Control", "no-store");
  headers.delete("ETag");
  headers.delete("Content-Length");
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

export function isUpstreamFailureStatus(status) {
  return status >= 500 && status <= 599;
}

export function shouldAttemptStaleFallback({ enabled, shouldUseCache, requestSupported, upstreamFailure }) {
  return enabled === true
    && shouldUseCache === true
    && requestSupported === true
    && upstreamFailure === true;
}

export {
  AQI_GENERATION_PARAM,
  CACHE_KEY_PARAM,
  CACHE_KEY_VERSION,
  DEFAULTS,
  HEADER_CACHED_AT,
  HEADER_FRESH_UNTIL,
  HEADER_STALE_REASON,
  HEADER_STALE_UNTIL,
  HEADER_STATE,
};
