import {
  buildMissingDaySlices,
  computeCoverageFromRows,
  computeNextSince,
  detectGapRanges,
  mergeAndDedupeRows,
  mergeSlices,
  normalizeObservedRow,
  resolveTimeseriesWindowBounds,
  subtractCoveredTailInterval,
} from "./timeseries_v2_stitch.mjs";

export interface Env {
  SUPABASE_URL: unknown;
  SB_PUBLISHABLE_DEFAULT_KEY: unknown;
  SB_SECRET_KEY: unknown;
  OBS_AQIDB_SUPABASE_URL: unknown;
  OBS_AQIDB_SECRET_KEY: unknown;
  UK_AQ_AQI_HISTORY_R2_API_URL: unknown;
  UK_AQ_LATEST_SNAPSHOT_R2_API_URL: unknown;
  UK_AQ_POSTCODE_LOOKUP_R2_API_URL: unknown;
  UK_AQ_POSTCODE_SUGGEST_R2_API_URL: unknown;
  UK_AQ_CACHE_ALLOWED_ORIGINS: unknown;
  UK_AQ_EDGE_ACCESS_TOKEN_SECRET: unknown;
  UK_AQ_EDGE_UPSTREAM_SECRET: unknown;
  UK_AQ_CACHE_BYPASS_SECRET: unknown;
  UK_AQ_LOCAL_DEV_BYPASS_ENABLED: unknown;
  UK_AQ_TURNSTILE_SECRET_KEY: unknown;
  UK_AQ_EDGE_SESSION_MAX_AGE_SECONDS: unknown;
  UK_AQ_CHART_METRICS_RPC: unknown;
  UK_AQ_CHART_METRICS_RPC_SCHEMA: unknown;
  UK_AQ_CHART_METRICS_RATE_LIMIT_PER_MINUTE: unknown;
  UK_AQ_CHART_METRICS_MAX_BODY_BYTES: unknown;
  UK_AQ_TIMESERIES_V2_ENABLED: unknown;
  UK_AQ_TIMESERIES_PROXY_FIRST: unknown;
  UK_AQ_TIMESERIES_R2_FIRST: unknown;
  UK_AQ_TIMESERIES_ALLOW_INGEST_OVERWRITE: unknown;
  UK_AQ_OBSERVS_HISTORY_R2_API_URL: unknown;
  UK_AQ_TIMESERIES_MAX_WINDOW_DAYS: unknown;
  UK_AQ_TIMESERIES_MAX_R2_OBJECTS_PER_REQUEST: unknown;
  UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS: unknown;
  UK_AQ_TIMESERIES_INCREMENTAL_OVERLAP_MINUTES: unknown;
  UK_AQ_TIMESERIES_PARTIAL_ON_R2_ERROR: unknown;
  UK_AQ_TIMESERIES_PARTIAL_ON_INGEST_ERROR: unknown;
  UK_AQ_TIMESERIES_RECENT_EDGE_TTL_SECONDS: unknown;
  UK_AQ_TIMESERIES_RECENT_BROWSER_TTL_SECONDS: unknown;
  UK_AQ_TIMESERIES_RECENT_SWR_SECONDS: unknown;
  UK_AQ_TIMESERIES_HISTORICAL_EDGE_TTL_SECONDS: unknown;
  UK_AQ_TIMESERIES_HISTORICAL_BROWSER_TTL_SECONDS: unknown;
  UK_AQ_TIMESERIES_HISTORICAL_SWR_SECONDS: unknown;
  UK_AQ_TIMESERIES_STALE_IF_ERROR_SECONDS: unknown;
  DROPBOX_APP_KEY: unknown;
  DROPBOX_APP_SECRET: unknown;
  DROPBOX_REFRESH_TOKEN: unknown;
  UK_AQ_DROPBOX_ROOT: unknown;
  UK_AIR_ERROR_DROPBOX_FOLDER: unknown;
  UK_AQ_WEBSITE_DEBUG_LOG_MAX_BODY_BYTES: unknown;
}


type CacheProfileName = "realtime" | "metadata" | "stations_metadata" | "aqi_history_immutable" | "postcode_lookup";

type CacheProfile = {
  edgeTtlSeconds: number;
  browserTtlSeconds: number;
  staleWhileRevalidateSeconds: number;
  staleIfErrorSeconds: number;
};

type AccessTokenHeader = {
  alg?: string;
  typ?: string;
};

type AccessTokenPayload = {
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  origin?: string;
  jti?: string;
};

type TurnstileVerifyResponse = {
  success?: boolean;
  "error-codes"?: string[];
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type ChartLoadReason = "initial" | "station_change" | "timescale_change" | "pollutant_change" | "refresh";

type ChartObsCacheMode = "local_only" | "local_plus_refresh" | "network_full" | "network_chunked" | "unknown";

type ChartOverallCacheClass = "cold" | "warm_local" | "warm_http_304" | "mixed" | "bypass" | "unknown";

type ChartMetricsPayload = {
  page_name: "uk_aq_stations_chart";
  page_view_id: string;
  request_group_id: string;
  session_id: string | null;
  load_reason: ChartLoadReason;
  station_id: number | null;
  timeseries_id: number | null;
  station_label: string | null;
  pollutant: string | null;
  window_label: string | null;
  success: boolean;
  error_stage: string | null;
  error_message: string | null;
  total_load_ms: number | null;
  time_to_first_obs_response_ms: number | null;
  time_to_first_obs_render_ms: number | null;
  time_to_obs_complete_ms: number | null;
  time_to_aqi_complete_ms: number | null;
  time_to_chart_ready_ms: number | null;
  cache_session_init_ms: number | null;
  turnstile_ms: number | null;
  obs_chunk_count: number | null;
  obs_network_request_count: number | null;
  obs_total_points: number | null;
  obs_used_local_cache: boolean | null;
  obs_used_etag: boolean | null;
  obs_received_304: boolean | null;
  obs_cache_mode: ChartObsCacheMode | null;
  aqi_supported: boolean | null;
  aqi_network_request_count: number | null;
  aqi_total_points: number | null;
  aqi_used_local_cache: boolean | null;
  aqi_received_304: boolean | null;
  cache_session_was_warm: boolean | null;
  overall_cache_class: ChartOverallCacheClass | null;
  network_effective_type: string | null;
  device_memory_gb: number | null;
  hardware_concurrency: number | null;
  app_version: string | null;
};

const CACHE_PROFILES: Record<CacheProfileName, CacheProfile> = {
  realtime: {
    edgeTtlSeconds: 60,
    browserTtlSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 300,
  },
  metadata: {
    edgeTtlSeconds: 60,
    browserTtlSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 1800,
  },
  stations_metadata: {
    edgeTtlSeconds: 86400,
    browserTtlSeconds: 86400,
    staleWhileRevalidateSeconds: 86400,
    staleIfErrorSeconds: 604800,
  },
  aqi_history_immutable: {
    edgeTtlSeconds: 86400,
    browserTtlSeconds: 86400,
    staleWhileRevalidateSeconds: 86400,
    staleIfErrorSeconds: 604800,
  },
  postcode_lookup: {
    edgeTtlSeconds: 86400,
    browserTtlSeconds: 86400,
    staleWhileRevalidateSeconds: 86400,
    staleIfErrorSeconds: 604800,
  },
};

const EXTERNAL_AQI_HISTORY_UPSTREAM = "__uk_aq_aqi_history_r2_api__";
const EXTERNAL_LATEST_SNAPSHOT_UPSTREAM = "__uk_aq_latest_snapshot_r2_api__";
const EXTERNAL_POSTCODE_LOOKUP_UPSTREAM = "__uk_aq_postcode_lookup_r2_api__";
const EXTERNAL_POSTCODE_SUGGEST_UPSTREAM = "__uk_aq_postcode_suggest_r2_api__";
const EXTERNAL_POSTCODE_PREFIX_HINTS_UPSTREAM = "__uk_aq_postcode_prefix_hints_r2_api__";

const FUNCTION_PROFILE_MAP: Record<string, CacheProfileName> = {
  uk_aq_latest: "realtime",
  uk_aq_timeseries: "realtime",
  uk_aq_stations_chart: "realtime",
  uk_aq_stations: "stations_metadata",
  uk_aq_la_hex: "metadata",
  uk_aq_pcon_hex: "metadata",
  [EXTERNAL_AQI_HISTORY_UPSTREAM]: "realtime",
  [EXTERNAL_LATEST_SNAPSHOT_UPSTREAM]: "realtime",
  [EXTERNAL_POSTCODE_LOOKUP_UPSTREAM]: "postcode_lookup",
  [EXTERNAL_POSTCODE_SUGGEST_UPSTREAM]: "postcode_lookup",
  [EXTERNAL_POSTCODE_PREFIX_HINTS_UPSTREAM]: "postcode_lookup",
};

const ROUTE_TO_FUNCTION_MAP: Record<string, keyof typeof FUNCTION_PROFILE_MAP> = {
  latest: "uk_aq_latest",
  timeseries: "uk_aq_timeseries",
  "stations-chart": "uk_aq_stations_chart",
  stations: "uk_aq_stations",
  "la-hex": "uk_aq_la_hex",
  "pcon-hex": "uk_aq_pcon_hex",
  "aqi-history": EXTERNAL_AQI_HISTORY_UPSTREAM,
  "latest-snapshot": EXTERNAL_LATEST_SNAPSHOT_UPSTREAM,
  postcode_lookup: EXTERNAL_POSTCODE_LOOKUP_UPSTREAM,
  "postcode-lookup": EXTERNAL_POSTCODE_LOOKUP_UPSTREAM,
  postcode_suggest: EXTERNAL_POSTCODE_SUGGEST_UPSTREAM,
  "postcode-suggest": EXTERNAL_POSTCODE_SUGGEST_UPSTREAM,
  postcode_prefix_hints: EXTERNAL_POSTCODE_PREFIX_HINTS_UPSTREAM,
  "postcode-prefix-hints": EXTERNAL_POSTCODE_PREFIX_HINTS_UPSTREAM,
};

const API_PREFIX = "/api/aq/";
const SESSION_START_PATH = "/api/aq/session/start";
const SESSION_END_PATH = "/api/aq/session/end";
const CHART_METRICS_PATH = "/api/aq/chart-metrics";
const WEBSITE_DEBUG_LOG_PATH = "/api/aq/debug-log";
const SESSION_COOKIE_NAME = "uk_aq_edge_session";
const SESSION_INIT_HEADER = "X-UK-AQ-Session-Init";
const CACHE_BYPASS_QUERY = "cache";
const CACHE_BYPASS_VALUE = "bypass";
const CACHE_BYPASS_HEADER = "X-UK-AQ-Bypass-Token";
const LOCAL_DEV_BYPASS_HEADER = "X-CIC-Local-Dev-Token";
const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const TURNSTILE_TOKEN_HEADER = "CF-Turnstile-Token";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_ISSUER = "uk_aq_edge_access_token";
const TOKEN_AUDIENCE = "uk_aq_cache_proxy";
const TOKEN_IAT_MAX_SKEW_SECONDS = 30;
const TOKEN_MAX_LIFETIME_SECONDS = 86400;
const DEFAULT_SESSION_MAX_AGE_SECONDS = 900;
const MIN_SESSION_MAX_AGE_SECONDS = 60;
const MAX_SESSION_MAX_AGE_SECONDS = 86400;
const DEFAULT_UPSTREAM_MAX_ATTEMPTS = 2;
const UPSTREAM_RETRY_DELAY_MS = 300;
const AQI_HISTORY_UPSTREAM_MAX_ATTEMPTS = 2;
const AQI_HISTORY_UPSTREAM_RETRY_DELAY_MS = 700;
const UPSTREAM_RETRY_STATUSES = new Set([502, 503, 504]);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const AQI_HISTORY_CANONICALIZE_MIN_WINDOW_MS = 3 * 24 * HOUR_MS;
const AQI_HISTORY_START_KEYS = ["from_utc", "start_utc", "from", "start"] as const;
const AQI_HISTORY_END_KEYS = ["to_utc", "end_utc", "to", "end"] as const;
const AQI_HISTORY_MUTABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHART_METRICS_MIN_BODY_BYTES = 4 * 1024;
const CHART_METRICS_DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const CHART_METRICS_MAX_BODY_BYTES = 256 * 1024;
const CHART_METRICS_DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const CHART_METRICS_MAX_TRACKED_KEYS = 5_000;
const CHART_METRICS_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_CHART_METRICS_RPC = "uk_aq_rpc_chart_load_metrics_insert";
const DEFAULT_CHART_METRICS_RPC_SCHEMA = "uk_aq_public";
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";
const WEBSITE_DEBUG_LOG_MIN_BODY_BYTES = 4 * 1024;
const WEBSITE_DEBUG_LOG_DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const WEBSITE_DEBUG_LOG_MAX_BODY_BYTES = 1024 * 1024;
const WEBSITE_DEBUG_LOG_DEFAULT_FOLDER = "/error_log";
const WEBSITE_DEBUG_LOG_FILENAME_PREFIX = "uk_aq_error_hex_map_html_";
const TIMESERIES_UPSTREAM_FUNCTION = "uk_aq_timeseries";
const TIMESERIES_V2_VERSION = "2";
const TIMESERIES_V2_CACHE_KEY_VERSION = "ts-v2";
const TIMESERIES_V2_ALLOWED_WINDOWS = new Set(["12h", "24h", "7d", "31d", "90d"]);
const TIMESERIES_V2_CACHE_BUSTER_KEYS = new Set(["_t", "timestamp", "cache_bust", "random"]);
const TIMESERIES_V2_PRIMARY_QUERY_KEYS = [
  "timeseries_id",
  "connector_id",
  "pollutant",
  "window",
  "since",
  "start_utc",
  "end_utc",
  "format",
  "v",
] as const;
const TIMESERIES_V2_DEFAULT_MAX_WINDOW_DAYS = 90;
const TIMESERIES_V2_MAX_WINDOW_DAYS_LIMIT = 365;
const TIMESERIES_V2_DEFAULT_MAX_R2_OBJECTS_PER_REQUEST = 1000;
const TIMESERIES_V2_MAX_R2_PAGES_PER_REQUEST = 200;
const TIMESERIES_V2_DEFAULT_MAX_SUPABASE_TAIL_HOURS = 168;
const TIMESERIES_V2_DEFAULT_INCREMENTAL_OVERLAP_MINUTES = 180;
const TIMESERIES_V2_MAX_INCREMENTAL_OVERLAP_MINUTES = 720;

type TimeseriesV2Flags = {
  enabled: boolean;
  proxyFirst: boolean;
  r2First: boolean;
  allowIngestOverwrite: boolean;
};

type TimeseriesV2CanonicalizeResult = {
  url: URL;
  strippedCacheBusters: string[];
};

type TimeseriesV2EnvelopeMeta = {
  source_mode: string;
  r2_coverage_start?: string | null;
  r2_coverage_end: string | null;
  ingest_tail_start: string | null;
  ingest_tail_end?: string | null;
  response_complete?: boolean | null;
  has_gap: boolean | null;
  gap_ranges?: Array<{ start_utc: string; end_utc: string }>;
  row_count: number | null;
  r2_row_count: number | null;
  ingest_row_count: number | null;
  deduped_row_count: number | null;
  next_since?: string | null;
  r2_errors?: Array<string | Record<string, unknown>>;
  ingest_errors?: Array<string | Record<string, unknown>>;
  cache_status: "MISS" | "HIT" | "BYPASS";
};

export class R2HistoryFetchError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "R2HistoryFetchError";
    this.details = details;
  }
}

type TimeseriesV2RuntimeConfig = {
  maxWindowDays: number;
  maxR2ObjectsPerRequest: number;
  maxSupabaseTailHours: number;
  incrementalOverlapMinutes: number;
  partialOnR2Error: boolean;
  partialOnIngestError: boolean;
  recentEdgeTtlSeconds: number;
  recentBrowserTtlSeconds: number;
  recentSwrSeconds: number;
  historicalEdgeTtlSeconds: number;
  historicalBrowserTtlSeconds: number;
  historicalSwrSeconds: number;
  staleIfErrorSeconds: number;
};

type TimeseriesV2RequestWindow = {
  timeseriesId: number;
  connectorId: number | null;
  pollutantKey: string | null;
  requestStartMs: number;
  requestEndMs: number;
  requestSinceIso: string | null;
  normalizedWindowLabel: string | null;
};

type TimeseriesV2StitchResult = {
  envelope: Record<string, unknown>;
  meta: TimeseriesV2EnvelopeMeta;
  sourceMode: string;
  cacheControl: string;
};

type R2PagedObservationsResult = {
  rows: Array<Record<string, unknown>>;
  coverage: Record<string, unknown> | null;
  pagesFetched: number;
  hitPageLimit: boolean;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const chartMetricsRateState = new Map<string, { windowStartMs: number; count: number }>();

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function nowIso(): string {
  return new Date().toISOString();
}

async function readSecret(value: unknown): Promise<string> {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const withGet = value as { get?: () => Promise<unknown> };
    if (typeof withGet.get === "function") {
      const resolved = await withGet.get();
      return typeof resolved === "string" ? resolved : String(resolved ?? "");
    }
    const thenable = value as PromiseLike<unknown>;
    if (typeof thenable.then === "function") {
      const resolved = await thenable;
      return typeof resolved === "string" ? resolved : String(resolved ?? "");
    }
  }
  return value ? String(value) : "";
}

function parseIntInRange(value: string, fallback: number, min: number, max: number): number {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function parseBooleanFlag(value: string): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

class RequestValidationError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch (_err) {
    return null;
  }
}

function resolveRequestOrigin(request: Request, url: URL): string | null {
  const originHeader = normalizeOrigin(request.headers.get("Origin"));
  if (originHeader) {
    return originHeader;
  }

  // Same-origin browser fetches can omit Origin for safe methods.
  const secFetchSite = (request.headers.get("Sec-Fetch-Site") ?? "").toLowerCase();
  if (secFetchSite === "same-origin") {
    return url.origin;
  }

  const refererOrigin = normalizeOrigin(request.headers.get("Referer"));
  if (refererOrigin && refererOrigin === url.origin) {
    return refererOrigin;
  }

  return null;
}

function parseAllowedOrigins(value: string): Set<string> {
  const origins = new Set<string>();
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      if (entry === "*") {
        origins.add("*");
        return;
      }
      const normalized = normalizeOrigin(entry);
      if (normalized) {
        origins.add(normalized);
      }
    });
  return origins;
}

function isOriginAllowed(origin: string | null, allowedOrigins: Set<string>): boolean {
  if (!origin) {
    return false;
  }
  if (allowedOrigins.has("*")) {
    return true;
  }
  return allowedOrigins.has(origin);
}

function resolveAllowOrigin(origin: string | null, allowedOrigins: Set<string>): string | null {
  if (!origin) {
    return null;
  }
  if (allowedOrigins.has("*")) {
    return origin;
  }
  return allowedOrigins.has(origin) ? origin : null;
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", value);
    return;
  }
  const entries = current
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.includes(value)) {
    entries.push(value);
    headers.set("Vary", entries.join(", "));
  }
}

function addCorsHeaders(headers: Headers, requestOrigin: string | null, allowedOrigins: Set<string>): void {
  const allowedOrigin = resolveAllowOrigin(requestOrigin, allowedOrigins);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
  }
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type,If-None-Match,If-Modified-Since,X-UK-AQ-Bypass-Token,X-UK-AQ-Session-Init,CF-Turnstile-Token",
  );
  headers.set("Access-Control-Max-Age", "86400");
  headers.set(
    "Access-Control-Expose-Headers",
    "CF-Cache-Status,ETag,X-UK-AQ-Cache,X-UK-AQ-Cache-Profile,X-UK-AQ-Timeseries-Source-Mode,X-UK-AQ-Has-Gap,X-UK-AQ-R2-Coverage-End,X-UK-AQ-Ingest-Tail-Start,X-UK-AQ-R2-Rows,X-UK-AQ-Ingest-Rows,X-UK-AQ-Cache-Key-Version",
  );
  appendVary(headers, "Origin");
}

function compactChartMetricPayload(metric: ChartMetricsPayload): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  (Object.entries(metric) as Array<[keyof ChartMetricsPayload, ChartMetricsPayload[keyof ChartMetricsPayload]]>)
    .forEach(([key, value]) => {
      if (value !== undefined) {
        payload[key] = value;
      }
    });
  return payload;
}

function normalizeDropboxPath(rawValue: string): string {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/+$/, "");
}

function joinDropboxPath(...parts: string[]): string {
  const joined = parts
    .map((part, index) => {
      const normalized = normalizeDropboxPath(part);
      if (!normalized) return "";
      return index === 0 ? normalized : normalized.replace(/^\/+/, "");
    })
    .filter(Boolean)
    .join("/");
  return normalizeDropboxPath(joined);
}

function dropboxPathWithRoot(dropboxRoot: string, pathValue: string): string {
  const root = normalizeDropboxPath(dropboxRoot);
  const cleaned = normalizeDropboxPath(pathValue);
  if (!root) {
    return cleaned;
  }
  if (!cleaned) {
    return root;
  }
  if (cleaned === root || cleaned.startsWith(`${root}/`)) {
    return cleaned;
  }
  return joinDropboxPath(root, cleaned);
}

function websiteDebugLogDropboxFolder(dropboxRoot: string, configuredFolder: string): string {
  const configured = normalizeDropboxPath(configuredFolder || WEBSITE_DEBUG_LOG_DEFAULT_FOLDER);
  const folder = dropboxPathWithRoot(dropboxRoot, configured || WEBSITE_DEBUG_LOG_DEFAULT_FOLDER);
  if (!folder) {
    return WEBSITE_DEBUG_LOG_DEFAULT_FOLDER;
  }
  if (folder.endsWith("/error_log")) {
    return folder;
  }
  if (folder.endsWith("/error_logs")) {
    return folder.slice(0, -1);
  }
  return joinDropboxPath(folder, "error_log");
}

function compactUtcTimestampForFilename(timestamp: string): string {
  return timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function randomHex(bytes = 4): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readResponseTextWithLimit(response: Response, limit = 1000): Promise<string> {
  const text = await response.text();
  return text.length <= limit ? text : text.slice(0, limit);
}

async function readDropboxAccessToken(env: Env): Promise<string | null> {
  const appKey = (await readSecret(env.DROPBOX_APP_KEY)).trim();
  const appSecret = (await readSecret(env.DROPBOX_APP_SECRET)).trim();
  const refreshToken = (await readSecret(env.DROPBOX_REFRESH_TOKEN)).trim();
  if (!(appKey && appSecret && refreshToken)) {
    return null;
  }

  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  });
  const tokenResponse = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (!tokenResponse.ok) {
    const text = await readResponseTextWithLimit(tokenResponse);
    throw new Error(`dropbox_token_failed_${tokenResponse.status}:${text}`);
  }
  const tokenJson = await tokenResponse.json() as { access_token?: unknown };
  const accessToken = String(tokenJson?.access_token || "").trim();
  if (!accessToken) {
    throw new Error("dropbox_token_missing_access_token");
  }
  return accessToken;
}

async function uploadWebsiteDebugLogToDropbox(env: Env, payload: Record<string, unknown>): Promise<{
  uploaded: boolean;
  dropbox_path?: string;
  reason?: string;
}> {
  const accessToken = await readDropboxAccessToken(env);
  if (!accessToken) {
    return { uploaded: false, reason: "missing_dropbox_credentials" };
  }

  const createdAt = typeof payload.created_at_utc === "string" && payload.created_at_utc
    ? payload.created_at_utc
    : nowIso();
  const dateFolder = createdAt.slice(0, 10);
  const folder = websiteDebugLogDropboxFolder(
    await readSecret(env.UK_AQ_DROPBOX_ROOT),
    await readSecret(env.UK_AIR_ERROR_DROPBOX_FOLDER),
  );
  const fileName = `${WEBSITE_DEBUG_LOG_FILENAME_PREFIX}${compactUtcTimestampForFilename(createdAt)}_${randomHex(4)}.json`;
  const dropboxPath = joinDropboxPath(folder, dateFolder, fileName);
  const bodyText = `${JSON.stringify(payload, null, 2)}\n`;
  const uploadResponse = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
        mode: "add",
        autorename: true,
        mute: false,
      }),
      "Content-Type": "application/octet-stream",
    },
    body: bodyText,
  });
  if (!uploadResponse.ok) {
    const text = await readResponseTextWithLimit(uploadResponse);
    throw new Error(`dropbox_upload_failed_${uploadResponse.status}:${text}`);
  }
  return { uploaded: true, dropbox_path: dropboxPath };
}

function normalizeWebsiteDebugLogPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestValidationError(400, "invalid_payload");
  }
  const source = String((payload as Record<string, unknown>).source || "").trim();
  if (source !== "hex_map.html") {
    throw new RequestValidationError(400, "source_invalid");
  }
  const createdAt = String((payload as Record<string, unknown>).created_at_utc || nowIso()).trim();
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) {
    throw new RequestValidationError(400, "created_at_utc_invalid");
  }
  return {
    ...(payload as Record<string, unknown>),
    schema_version: 1,
    source,
    debug_enabled: true,
    created_at_utc: new Date(createdMs).toISOString(),
    received_at_utc: nowIso(),
  };
}

async function handleWebsiteDebugLogIngest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  requestOrigin: string | null,
  allowedOrigins: Set<string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return makeErrorResponse(405, "method_not_allowed", requestOrigin, allowedOrigins);
  }

  const maxBodyBytes = parseIntInRange(
    await readSecret(env.UK_AQ_WEBSITE_DEBUG_LOG_MAX_BODY_BYTES),
    WEBSITE_DEBUG_LOG_DEFAULT_MAX_BODY_BYTES,
    WEBSITE_DEBUG_LOG_MIN_BODY_BYTES,
    WEBSITE_DEBUG_LOG_MAX_BODY_BYTES,
  );

  let payload: Record<string, unknown>;
  try {
    payload = normalizeWebsiteDebugLogPayload(await readJsonBodyWithLimit(request, maxBodyBytes));
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return makeErrorResponse(error.status, error.code, requestOrigin, allowedOrigins);
    }
    return makeErrorResponse(400, "invalid_payload", requestOrigin, allowedOrigins);
  }

  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  addCorsHeaders(headers, requestOrigin, allowedOrigins);

  try {
    const result = await uploadWebsiteDebugLogToDropbox(env, payload);
    if (!result.uploaded) {
      console.warn("website_debug_log_dropbox_skipped", { reason: result.reason || "unknown" });
      return new Response(JSON.stringify({
        ok: false,
        uploaded: false,
        reason: result.reason || "unknown",
      }), { status: 503, headers });
    }
    return new Response(JSON.stringify({
      ok: true,
      uploaded: true,
      dropbox_path: result.dropbox_path || null,
    }), { status: 201, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("website_debug_log_dropbox_upload_failed", { error: message });
    return new Response(JSON.stringify({
      ok: false,
      uploaded: false,
      error: "dropbox_upload_failed",
      message,
    }), { status: 502, headers });
  }
}

function trimTextOrNull(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  if (!cleaned) {
    return null;
  }
  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength);
}

function parseUuidOrThrow(value: unknown, fieldName: string): string {
  const parsed = trimTextOrNull(value, 64);
  if (!parsed) {
    throw new RequestValidationError(400, `${fieldName}_required`);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)
  ) {
    throw new RequestValidationError(400, `${fieldName}_invalid`);
  }
  return parsed.toLowerCase();
}

function parseBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function parseBooleanRequired(value: unknown, fieldName: string): boolean {
  const parsed = parseBooleanOrNull(value);
  if (parsed === null) {
    throw new RequestValidationError(400, `${fieldName}_required`);
  }
  return parsed;
}

function parseIntegerOrNull(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new RequestValidationError(400, `${fieldName}_invalid`);
  }
  if (parsed < min || parsed > max) {
    throw new RequestValidationError(400, `${fieldName}_out_of_range`);
  }
  return parsed;
}

function parseFiniteNumberOrNull(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RequestValidationError(400, `${fieldName}_invalid`);
  }
  if (parsed < min || parsed > max) {
    throw new RequestValidationError(400, `${fieldName}_out_of_range`);
  }
  return parsed;
}

function parseChartLoadReason(value: unknown): ChartLoadReason {
  const parsed = trimTextOrNull(value, 64);
  if (!parsed) {
    throw new RequestValidationError(400, "load_reason_required");
  }
  const allowed: ChartLoadReason[] = [
    "initial",
    "station_change",
    "timescale_change",
    "pollutant_change",
    "refresh",
  ];
  if (!allowed.includes(parsed as ChartLoadReason)) {
    throw new RequestValidationError(400, "load_reason_invalid");
  }
  return parsed as ChartLoadReason;
}

function parseChartObsCacheMode(value: unknown): ChartObsCacheMode | null {
  const parsed = trimTextOrNull(value, 64);
  if (!parsed) {
    return null;
  }
  const allowed: ChartObsCacheMode[] = [
    "local_only",
    "local_plus_refresh",
    "network_full",
    "network_chunked",
    "unknown",
  ];
  if (!allowed.includes(parsed as ChartObsCacheMode)) {
    throw new RequestValidationError(400, "obs_cache_mode_invalid");
  }
  return parsed as ChartObsCacheMode;
}

function parseChartOverallCacheClass(value: unknown): ChartOverallCacheClass | null {
  const parsed = trimTextOrNull(value, 64);
  if (!parsed) {
    return null;
  }
  const allowed: ChartOverallCacheClass[] = [
    "cold",
    "warm_local",
    "warm_http_304",
    "mixed",
    "bypass",
    "unknown",
  ];
  if (!allowed.includes(parsed as ChartOverallCacheClass)) {
    throw new RequestValidationError(400, "overall_cache_class_invalid");
  }
  return parsed as ChartOverallCacheClass;
}

function parseChartMetricsPayload(payload: unknown): ChartMetricsPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestValidationError(400, "invalid_payload");
  }
  const metric = payload as Record<string, unknown>;
  const pageName = trimTextOrNull(metric.page_name, 64);
  if (pageName !== "uk_aq_stations_chart") {
    throw new RequestValidationError(400, "page_name_invalid");
  }
  return {
    page_name: "uk_aq_stations_chart",
    page_view_id: parseUuidOrThrow(metric.page_view_id, "page_view_id"),
    request_group_id: parseUuidOrThrow(metric.request_group_id, "request_group_id"),
    session_id: metric.session_id === null || metric.session_id === undefined
      ? null
      : parseUuidOrThrow(metric.session_id, "session_id"),
    load_reason: parseChartLoadReason(metric.load_reason),
    station_id: parseIntegerOrNull(metric.station_id, "station_id", 1, 2_147_483_647),
    timeseries_id: parseIntegerOrNull(metric.timeseries_id, "timeseries_id", 1, 2_147_483_647),
    station_label: trimTextOrNull(metric.station_label, 180),
    pollutant: trimTextOrNull(metric.pollutant, 64),
    window_label: trimTextOrNull(metric.window_label, 32),
    success: parseBooleanRequired(metric.success, "success"),
    error_stage: trimTextOrNull(metric.error_stage, 64),
    error_message: trimTextOrNull(metric.error_message, 240),
    total_load_ms: parseIntegerOrNull(metric.total_load_ms, "total_load_ms", 0, 600_000),
    time_to_first_obs_response_ms: parseIntegerOrNull(
      metric.time_to_first_obs_response_ms,
      "time_to_first_obs_response_ms",
      0,
      600_000,
    ),
    time_to_first_obs_render_ms: parseIntegerOrNull(
      metric.time_to_first_obs_render_ms,
      "time_to_first_obs_render_ms",
      0,
      600_000,
    ),
    time_to_obs_complete_ms: parseIntegerOrNull(metric.time_to_obs_complete_ms, "time_to_obs_complete_ms", 0, 600_000),
    time_to_aqi_complete_ms: parseIntegerOrNull(metric.time_to_aqi_complete_ms, "time_to_aqi_complete_ms", 0, 600_000),
    time_to_chart_ready_ms: parseIntegerOrNull(metric.time_to_chart_ready_ms, "time_to_chart_ready_ms", 0, 600_000),
    cache_session_init_ms: parseIntegerOrNull(metric.cache_session_init_ms, "cache_session_init_ms", 0, 120_000),
    turnstile_ms: parseIntegerOrNull(metric.turnstile_ms, "turnstile_ms", 0, 120_000),
    obs_chunk_count: parseIntegerOrNull(metric.obs_chunk_count, "obs_chunk_count", 0, 5000),
    obs_network_request_count: parseIntegerOrNull(
      metric.obs_network_request_count,
      "obs_network_request_count",
      0,
      5000,
    ),
    obs_total_points: parseIntegerOrNull(metric.obs_total_points, "obs_total_points", 0, 5_000_000),
    obs_used_local_cache: parseBooleanOrNull(metric.obs_used_local_cache),
    obs_used_etag: parseBooleanOrNull(metric.obs_used_etag),
    obs_received_304: parseBooleanOrNull(metric.obs_received_304),
    obs_cache_mode: parseChartObsCacheMode(metric.obs_cache_mode),
    aqi_supported: parseBooleanOrNull(metric.aqi_supported),
    aqi_network_request_count: parseIntegerOrNull(
      metric.aqi_network_request_count,
      "aqi_network_request_count",
      0,
      5000,
    ),
    aqi_total_points: parseIntegerOrNull(metric.aqi_total_points, "aqi_total_points", 0, 100_000),
    aqi_used_local_cache: parseBooleanOrNull(metric.aqi_used_local_cache),
    aqi_received_304: parseBooleanOrNull(metric.aqi_received_304),
    cache_session_was_warm: parseBooleanOrNull(metric.cache_session_was_warm),
    overall_cache_class: parseChartOverallCacheClass(metric.overall_cache_class),
    network_effective_type: trimTextOrNull(metric.network_effective_type, 32),
    device_memory_gb: parseFiniteNumberOrNull(metric.device_memory_gb, "device_memory_gb", 0, 2048),
    hardware_concurrency: parseIntegerOrNull(metric.hardware_concurrency, "hardware_concurrency", 0, 512),
    app_version: trimTextOrNull(metric.app_version, 64),
  };
}

function parseClientIp(request: Request): string {
  const candidate = (request.headers.get("CF-Connecting-IP") ?? "").trim();
  if (!candidate) {
    return "unknown";
  }
  return candidate.toLowerCase();
}

function applyChartMetricsRateLimit(rateKey: string, maxPerMinute: number): boolean {
  const nowMs = Date.now();
  for (const [key, state] of chartMetricsRateState.entries()) {
    if (nowMs - state.windowStartMs >= CHART_METRICS_RATE_WINDOW_MS) {
      chartMetricsRateState.delete(key);
    }
  }
  if (chartMetricsRateState.size > CHART_METRICS_MAX_TRACKED_KEYS) {
    const overflow = chartMetricsRateState.size - CHART_METRICS_MAX_TRACKED_KEYS;
    let removed = 0;
    for (const key of chartMetricsRateState.keys()) {
      chartMetricsRateState.delete(key);
      removed += 1;
      if (removed >= overflow) {
        break;
      }
    }
  }
  const current = chartMetricsRateState.get(rateKey);
  if (!current || nowMs - current.windowStartMs >= CHART_METRICS_RATE_WINDOW_MS) {
    chartMetricsRateState.set(rateKey, { windowStartMs: nowMs, count: 1 });
    return true;
  }
  if (current.count >= maxPerMinute) {
    return false;
  }
  current.count += 1;
  chartMetricsRateState.set(rateKey, current);
  return true;
}

async function readJsonBodyWithLimit(request: Request, maxBytes: number): Promise<unknown> {
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new RequestValidationError(413, "payload_too_large");
    }
  }
  const raw = await request.text();
  const bodyBytes = textEncoder.encode(raw).byteLength;
  if (bodyBytes > maxBytes) {
    throw new RequestValidationError(413, "payload_too_large");
  }
  if (!raw.trim()) {
    throw new RequestValidationError(400, "payload_required");
  }
  try {
    return JSON.parse(raw);
  } catch (_err) {
    throw new RequestValidationError(400, "invalid_json");
  }
}

async function insertChartMetric(
  env: Env,
  payload: ChartMetricsPayload,
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const obsAqIdbSupabaseUrl = (await readSecret(env.OBS_AQIDB_SUPABASE_URL)).trim();
  const obsAqIdbSecretKey = (await readSecret(env.OBS_AQIDB_SECRET_KEY)).trim();
  if (!obsAqIdbSupabaseUrl || !obsAqIdbSecretKey) {
    return { ok: false, status: 500, reason: "missing_chart_metrics_db_config" };
  }
  const rpcName = (
    await readSecret(env.UK_AQ_CHART_METRICS_RPC)
  ).trim() || DEFAULT_CHART_METRICS_RPC;
  const rpcSchema = (
    await readSecret(env.UK_AQ_CHART_METRICS_RPC_SCHEMA)
  ).trim() || DEFAULT_CHART_METRICS_RPC_SCHEMA;
  const rpcUrl = `${normalizeBaseUrl(obsAqIdbSupabaseUrl)}/rest/v1/rpc/${rpcName}`;
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Profile": rpcSchema,
        "Content-Profile": rpcSchema,
        "apikey": obsAqIdbSecretKey,
        "Authorization": `Bearer ${obsAqIdbSecretKey}`,
      },
      body: JSON.stringify({
        p_metric: compactChartMetricPayload(payload),
      }),
    });
  } catch (_err) {
    return { ok: false, status: 502, reason: "chart_metrics_db_unreachable" };
  }
  if (!response.ok) {
    let detail = "";
    try {
      const text = await response.text();
      detail = text.slice(0, 200);
    } catch (_err) {
      detail = "";
    }
    console.error("chart_metrics_insert_failed", {
      status: response.status,
      detail,
    });
    return { ok: false, status: 502, reason: "chart_metrics_db_insert_failed" };
  }
  return { ok: true };
}

async function handleChartMetricsIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestOrigin: string | null,
  allowedOrigins: Set<string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return makeErrorResponse(405, "method_not_allowed", requestOrigin, allowedOrigins);
  }

  const rateLimitPerMinute = parseIntInRange(
    await readSecret(env.UK_AQ_CHART_METRICS_RATE_LIMIT_PER_MINUTE),
    CHART_METRICS_DEFAULT_RATE_LIMIT_PER_MINUTE,
    10,
    500,
  );
  const maxBodyBytes = parseIntInRange(
    await readSecret(env.UK_AQ_CHART_METRICS_MAX_BODY_BYTES),
    CHART_METRICS_DEFAULT_MAX_BODY_BYTES,
    CHART_METRICS_MIN_BODY_BYTES,
    CHART_METRICS_MAX_BODY_BYTES,
  );
  const rateKey = `${requestOrigin ?? "unknown"}|${parseClientIp(request)}`;
  if (!applyChartMetricsRateLimit(rateKey, rateLimitPerMinute)) {
    return makeErrorResponse(429, "rate_limited", requestOrigin, allowedOrigins);
  }

  let parsedPayload: ChartMetricsPayload;
  try {
    const body = await readJsonBodyWithLimit(request, maxBodyBytes);
    parsedPayload = parseChartMetricsPayload(body);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return makeErrorResponse(error.status, error.code, requestOrigin, allowedOrigins);
    }
    return makeErrorResponse(400, "invalid_payload", requestOrigin, allowedOrigins);
  }

  ctx.waitUntil((async () => {
    const insertResult = await insertChartMetric(env, parsedPayload);
    if (!insertResult.ok) {
      console.error("chart_metrics_insert_failed_async", {
        status: insertResult.status,
        reason: insertResult.reason,
      });
    }
  })());

  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  addCorsHeaders(headers, requestOrigin, allowedOrigins);
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers });
}

function buildCacheControl(profile: CacheProfile): string {
  return [
    "public",
    `max-age=${profile.browserTtlSeconds}`,
    `s-maxage=${profile.edgeTtlSeconds}`,
    `stale-while-revalidate=${profile.staleWhileRevalidateSeconds}`,
    `stale-if-error=${profile.staleIfErrorSeconds}`,
  ].join(", ");
}

function parseIsoMsOrNull(value: string | null): number | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFirstSearchParam(url: URL, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (String(value ?? "").trim()) {
      return value;
    }
  }
  return null;
}

function parsePositiveIntegerStringOrNull(
  value: string | null,
  min = 1,
  max = 2_147_483_647,
): string | null {
  const text = String(value ?? "").trim();
  if (!text || !/^\d+$/.test(text)) {
    return null;
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    return null;
  }
  return String(Math.floor(numeric));
}

function normalizeIsoOrNull(value: string | null): string | null {
  const ms = parseIsoMsOrNull(value);
  if (ms === null || !Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function normalizeTimeseriesPollutantKey(value: string | null): string | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s._-]+/g, "");
  if (normalized === "pm25" || normalized === "pm10" || normalized === "no2") {
    return normalized;
  }
  return null;
}

function resolveTimeseriesV2FlagsFromEnv(envValues: {
  v2EnabledRaw: string;
  proxyFirstRaw: string;
  r2FirstRaw: string;
  allowIngestOverwriteRaw: string;
}): TimeseriesV2Flags {
  return {
    enabled: parseBooleanFlag(envValues.v2EnabledRaw),
    proxyFirst: parseBooleanFlag(envValues.proxyFirstRaw),
    r2First: parseBooleanFlag(envValues.r2FirstRaw),
    allowIngestOverwrite: parseBooleanFlag(envValues.allowIngestOverwriteRaw),
  };
}

function isTimeseriesV2Request(url: URL, upstreamFunction: string, flags: TimeseriesV2Flags): boolean {
  if (upstreamFunction !== TIMESERIES_UPSTREAM_FUNCTION) {
    return false;
  }
  if (!flags.enabled || !flags.proxyFirst) {
    return false;
  }
  return String(url.searchParams.get("v") ?? "").trim() === TIMESERIES_V2_VERSION;
}

function canonicalizeTimeseriesV2RequestUrl(url: URL, allowCacheBypassParams: boolean): TimeseriesV2CanonicalizeResult {
  const original = new URL(url.toString());
  const strippedCacheBusters: string[] = [];
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
  const normalizedStartUtc = normalizeIsoOrNull(
    getFirstSearchParam(original, ["start_utc", "start"]),
  );
  const normalizedEndUtc = normalizeIsoOrNull(
    getFirstSearchParam(original, ["end_utc", "end"]),
  );
  const hasValidRange = Boolean(
    normalizedStartUtc &&
      normalizedEndUtc &&
      Date.parse(normalizedEndUtc) > Date.parse(normalizedStartUtc),
  );

  const normalized = new URL(original.origin + original.pathname);
  if (timeseriesId) {
    normalized.searchParams.set("timeseries_id", timeseriesId);
  }
  if (connectorId) {
    normalized.searchParams.set("connector_id", connectorId);
  }
  const pollutantKey = normalizeTimeseriesPollutantKey(original.searchParams.get("pollutant"));
  if (pollutantKey) {
    normalized.searchParams.set("pollutant", pollutantKey);
  }
  if (normalizedWindow && !hasValidRange) {
    normalized.searchParams.set("window", normalizedWindow);
  }
  if (normalizedSince) {
    normalized.searchParams.set("since", normalizedSince);
  }
  if (hasValidRange && normalizedStartUtc && normalizedEndUtc) {
    normalized.searchParams.set("start_utc", normalizedStartUtc);
    normalized.searchParams.set("end_utc", normalizedEndUtc);
  }
  normalized.searchParams.set("format", "json");
  normalized.searchParams.set("v", TIMESERIES_V2_VERSION);

  if (allowCacheBypassParams) {
    for (const [key, value] of original.searchParams.entries()) {
      if ((TIMESERIES_V2_PRIMARY_QUERY_KEYS as readonly string[]).includes(key)) {
        continue;
      }
      normalized.searchParams.append(key, value);
    }
  }

  return { url: normalized, strippedCacheBusters };
}

function parseTimeseriesRowsFromPayload(payload: unknown, sourceLabel: "r2" | "ingest"): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const payloadRecord = payload as Record<string, unknown>;
  const rows: Array<Record<string, unknown>> = [];
  if (Array.isArray(payloadRecord.data)) {
    for (const item of payloadRecord.data) {
      const normalized = normalizeObservedRow(item, sourceLabel) as Record<string, unknown> | null;
      if (normalized) {
        rows.push(normalized);
      }
    }
    return rows;
  }
  if (Array.isArray(payloadRecord.rows)) {
    for (const item of payloadRecord.rows) {
      const normalized = normalizeObservedRow(item, sourceLabel) as Record<string, unknown> | null;
      if (normalized) {
        rows.push(normalized);
      }
    }
  }
  return rows;
}

function buildTimeseriesV2RuntimeConfig(env: Env): TimeseriesV2RuntimeConfig {
  const maxWindowDays = parseIntInRange(
    String(env.UK_AQ_TIMESERIES_MAX_WINDOW_DAYS ?? ""),
    TIMESERIES_V2_DEFAULT_MAX_WINDOW_DAYS,
    1,
    TIMESERIES_V2_MAX_WINDOW_DAYS_LIMIT,
  );
  return {
    maxWindowDays,
    maxR2ObjectsPerRequest: parseIntInRange(
      String(env.UK_AQ_TIMESERIES_MAX_R2_OBJECTS_PER_REQUEST ?? ""),
      TIMESERIES_V2_DEFAULT_MAX_R2_OBJECTS_PER_REQUEST,
      1,
      2000,
    ),
    maxSupabaseTailHours: parseIntInRange(
      String(env.UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS ?? ""),
      TIMESERIES_V2_DEFAULT_MAX_SUPABASE_TAIL_HOURS,
      1,
      maxWindowDays * 24,
    ),
    incrementalOverlapMinutes: parseIntInRange(
      String(env.UK_AQ_TIMESERIES_INCREMENTAL_OVERLAP_MINUTES ?? ""),
      TIMESERIES_V2_DEFAULT_INCREMENTAL_OVERLAP_MINUTES,
      0,
      TIMESERIES_V2_MAX_INCREMENTAL_OVERLAP_MINUTES,
    ),
    partialOnR2Error: parseBooleanFlag(String(env.UK_AQ_TIMESERIES_PARTIAL_ON_R2_ERROR ?? "true")),
    partialOnIngestError: parseBooleanFlag(String(env.UK_AQ_TIMESERIES_PARTIAL_ON_INGEST_ERROR ?? "false")),
    recentEdgeTtlSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_RECENT_EDGE_TTL_SECONDS ?? ""), 60, 0, 604800),
    recentBrowserTtlSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_RECENT_BROWSER_TTL_SECONDS ?? ""), 60, 0, 604800),
    recentSwrSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_RECENT_SWR_SECONDS ?? ""), 60, 0, 604800),
    historicalEdgeTtlSeconds: parseIntInRange(
      String(env.UK_AQ_TIMESERIES_HISTORICAL_EDGE_TTL_SECONDS ?? ""),
      86400,
      0,
      604800,
    ),
    historicalBrowserTtlSeconds: parseIntInRange(
      String(env.UK_AQ_TIMESERIES_HISTORICAL_BROWSER_TTL_SECONDS ?? ""),
      86400,
      0,
      604800,
    ),
    historicalSwrSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_HISTORICAL_SWR_SECONDS ?? ""), 86400, 0, 604800),
    staleIfErrorSeconds: parseIntInRange(String(env.UK_AQ_TIMESERIES_STALE_IF_ERROR_SECONDS ?? ""), 300, 0, 604800),
  };
}

function buildTimeseriesV2RequestWindow(requestUrl: URL, runtime: TimeseriesV2RuntimeConfig): TimeseriesV2RequestWindow {
  const timeseriesIdText = parsePositiveIntegerStringOrNull(requestUrl.searchParams.get("timeseries_id"));
  if (!timeseriesIdText) {
    throw new RequestValidationError(400, "timeseries_id_required");
  }
  const connectorIdText = parsePositiveIntegerStringOrNull(requestUrl.searchParams.get("connector_id"));
  const pollutantKey = normalizeTimeseriesPollutantKey(requestUrl.searchParams.get("pollutant"));
  const rawWindow = String(requestUrl.searchParams.get("window") ?? "").trim().toLowerCase();
  const startUtc = getFirstSearchParam(requestUrl, ["start_utc", "start"]);
  const endUtc = getFirstSearchParam(requestUrl, ["end_utc", "end"]);
  const since = normalizeIsoOrNull(requestUrl.searchParams.get("since"))
    ?? (String(requestUrl.searchParams.get("since") ?? "").trim() || null);

  const bounds = resolveTimeseriesWindowBounds({
    nowMs: Date.now(),
    windowLabel: rawWindow,
    startUtc,
    endUtc,
    maxWindowDays: runtime.maxWindowDays,
  }) as { startMs: number; endMs: number; normalizedWindowLabel: string | null };

  if (!Number.isFinite(bounds.startMs) || !Number.isFinite(bounds.endMs) || bounds.endMs <= bounds.startMs) {
    throw new RequestValidationError(400, "invalid_window");
  }

  return {
    timeseriesId: Number(timeseriesIdText),
    connectorId: connectorIdText ? Number(connectorIdText) : null,
    pollutantKey,
    requestStartMs: bounds.startMs,
    requestEndMs: bounds.endMs,
    requestSinceIso: since,
    normalizedWindowLabel: bounds.normalizedWindowLabel,
  };
}

async function loadTimeseriesConnectorId(
  supabaseUrl: string,
  sbSecretKey: string,
  timeseriesId: number,
): Promise<number | null> {
  if (!supabaseUrl || !sbSecretKey) {
    return null;
  }
  const endpoint = new URL(`${normalizeBaseUrl(supabaseUrl)}/rest/v1/timeseries`);
  endpoint.searchParams.set("select", "connector_id");
  endpoint.searchParams.set("id", `eq.${timeseriesId}`);
  endpoint.searchParams.set("limit", "1");
  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Accept-Profile": "uk_aq_core",
        "apikey": sbSecretKey,
        "Authorization": `Bearer ${sbSecretKey}`,
      },
    });
  } catch (_err) {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (_err) {
    return null;
  }
  const row = Array.isArray(payload) && payload.length > 0 ? payload[0] : null;
  const connectorId = Number((row as Record<string, unknown> | null)?.connector_id);
  if (!Number.isFinite(connectorId) || connectorId <= 0) {
    return null;
  }
  return Math.trunc(connectorId);
}

async function fetchTimeseriesOriginPayload(
  supabaseUrl: string,
  supabasePublishableKey: string,
  upstreamAuthSecret: string,
  params: {
    timeseriesId: number;
    startUtc: string;
    endUtc: string;
    sinceUtc: string | null;
  },
): Promise<Record<string, unknown>> {
  const endpoint = new URL(`${normalizeBaseUrl(supabaseUrl)}/functions/v1/${TIMESERIES_UPSTREAM_FUNCTION}`);
  endpoint.searchParams.set("timeseries_id", String(params.timeseriesId));
  endpoint.searchParams.set("start_utc", params.startUtc);
  endpoint.searchParams.set("end_utc", params.endUtc);
  endpoint.searchParams.set("format", "objects");
  if (params.sinceUtc) {
    endpoint.searchParams.set("since", params.sinceUtc);
  }
  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "apikey": supabasePublishableKey,
      "Authorization": `Bearer ${supabasePublishableKey}`,
      [UPSTREAM_AUTH_HEADER]: upstreamAuthSecret,
    },
  });
  const text = await response.text();
  let payload: unknown = null;
  let parsedJson = false;
  try {
    if (text) {
      payload = JSON.parse(text);
      parsedJson = true;
    }
  } catch (_err) {
    payload = null;
  }
  if (!response.ok || !parsedJson || typeof payload !== "object") {
    const errorDetails = {
      kind: "timeseries_origin_failed",
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      bodyPreview: text ? text.substring(0, 1000) : "",
      upstreamUrlPath: endpoint.pathname + endpoint.search,
      worker: "observations"
    };
    throw new R2HistoryFetchError(`timeseries_origin_failed_${response.status}`, errorDetails);
  }
  return payload as Record<string, unknown>;
}

async function fetchR2ObservationsPayload(
  r2ApiUrl: string,
  upstreamAuthSecret: string,
  params: {
    timeseriesId: number;
    connectorId: number;
    pollutantKey: string | null;
    startUtc: string;
    endUtc: string;
    sinceUtc: string | null;
    limitRows: number;
  },
): Promise<Record<string, unknown>> {
  const endpoint = new URL(r2ApiUrl);
  if (!endpoint.pathname || endpoint.pathname === "/") {
    endpoint.pathname = "/v1/observations";
  }
  endpoint.searchParams.set("timeseries_id", String(params.timeseriesId));
  endpoint.searchParams.set("connector_id", String(params.connectorId));
  if (params.pollutantKey) {
    endpoint.searchParams.set("pollutant", params.pollutantKey);
  }
  endpoint.searchParams.set("start_utc", params.startUtc);
  endpoint.searchParams.set("end_utc", params.endUtc);
  if (params.sinceUtc) {
    endpoint.searchParams.set("since_utc", params.sinceUtc);
  }
  endpoint.searchParams.set("limit", String(Math.max(1, params.limitRows)));
  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json",
      [UPSTREAM_AUTH_HEADER]: upstreamAuthSecret,
    },
  });
  const text = await response.text();
  let payload: unknown = null;
  let parsedJson = false;
  try {
    if (text) {
      payload = JSON.parse(text);
      parsedJson = true;
    }
  } catch (_err) {
    payload = null;
  }
  if (!response.ok || !parsedJson || typeof payload !== "object") {
    const errorDetails = {
      kind: "r2_history_failed",
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      bodyPreview: text ? text.substring(0, 1000) : "",
      upstreamUrlPath: endpoint.pathname + endpoint.search,
      worker: "observations"
    };
    throw new R2HistoryFetchError(`r2_history_failed_${response.status}`, errorDetails);
  }
  return payload as Record<string, unknown>;
}

function asArrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function mergeCoverageDiagnostics(
  target: Record<string, unknown>,
  sourceCoverage: Record<string, unknown>,
): void {
  const fieldsToUnion = [
    "missing_day_manifest_keys",
    "missing_connector_manifest_keys",
    "missing_parquet_keys",
  ];
  for (const field of fieldsToUnion) {
    const merged = new Set<string>([
      ...asArrayOfStrings(target[field]),
      ...asArrayOfStrings(sourceCoverage[field]),
    ]);
    target[field] = Array.from(merged);
  }
}

async function fetchR2ObservationsPaged(
  r2ApiUrl: string,
  upstreamAuthSecret: string,
  params: {
    timeseriesId: number;
    connectorId: number;
    pollutantKey: string | null;
    startUtc: string;
    endUtc: string;
    sinceUtc: string | null;
    pageLimitRows: number;
    maxPages: number;
  },
): Promise<R2PagedObservationsResult> {
  const rowsByObservedAt = new Map<string, Record<string, unknown>>();
  const pageLimitRows = Math.max(1, params.pageLimitRows);
  const maxPages = Math.max(1, params.maxPages);
  let pageSinceUtc = params.sinceUtc;
  let pagesFetched = 0;
  let hitPageLimit = false;
  let exhaustedWindow = false;
  let mergedCoverage: Record<string, unknown> | null = null;

  while (pagesFetched < maxPages) {
    const payload = await fetchR2ObservationsPayload(
      r2ApiUrl,
      upstreamAuthSecret,
      {
        timeseriesId: params.timeseriesId,
        connectorId: params.connectorId,
        pollutantKey: params.pollutantKey,
        startUtc: params.startUtc,
        endUtc: params.endUtc,
        sinceUtc: pageSinceUtc,
        limitRows: pageLimitRows,
      },
    );
    pagesFetched += 1;

    const payloadCoverage = payload.coverage && typeof payload.coverage === "object"
      ? payload.coverage as Record<string, unknown>
      : null;
    if (!mergedCoverage && payloadCoverage) {
      mergedCoverage = { ...payloadCoverage };
    } else if (mergedCoverage && payloadCoverage) {
      mergeCoverageDiagnostics(mergedCoverage, payloadCoverage);
    }

    const pageRows = parseTimeseriesRowsFromPayload(payload, "r2");
    if (pageRows.length === 0) {
      exhaustedWindow = true;
      break;
    }

    let lastObservedAt: string | null = null;
    for (const row of pageRows) {
      const observedAt = String(row?.observed_at ?? "").trim();
      if (!observedAt) {
        continue;
      }
      rowsByObservedAt.set(observedAt, row);
      lastObservedAt = observedAt;
    }

    const responseRowCount = Number(payload.row_count);
    const reachedPageLimit = Number.isFinite(responseRowCount)
      ? responseRowCount >= pageLimitRows
      : pageRows.length >= pageLimitRows;
    if (!reachedPageLimit) {
      exhaustedWindow = true;
      break;
    }
    if (!lastObservedAt) {
      exhaustedWindow = true;
      break;
    }

    pageSinceUtc = lastObservedAt;
  }

  if (!exhaustedWindow && pagesFetched >= maxPages) {
    hitPageLimit = true;
  }

  return {
    rows: Array.from(rowsByObservedAt.values()).sort((left, right) => {
      const leftMs = parseIsoMsOrNull(String(left?.observed_at ?? "")) ?? 0;
      const rightMs = parseIsoMsOrNull(String(right?.observed_at ?? "")) ?? 0;
      return leftMs - rightMs;
    }),
    coverage: mergedCoverage,
    pagesFetched,
    hitPageLimit,
  };
}

function toIsoSafe(valueMs: number): string {
  return new Date(valueMs).toISOString();
}

function applySinceOverlap(sinceIso: string | null, overlapMinutes: number, lowerBoundMs: number): string | null {
  const sinceMs = parseIsoMsOrNull(sinceIso);
  if (sinceMs === null || !Number.isFinite(sinceMs)) {
    return null;
  }
  const overlapMs = Math.max(0, overlapMinutes) * 60 * 1000;
  const adjusted = Math.max(lowerBoundMs, sinceMs - overlapMs);
  return new Date(adjusted).toISOString();
}

function buildTimeseriesV2CacheControl(sourceMode: string, runtime: TimeseriesV2RuntimeConfig): string {
  const isHistorical = sourceMode === "r2_only";
  const browserTtl = isHistorical ? runtime.historicalBrowserTtlSeconds : runtime.recentBrowserTtlSeconds;
  const edgeTtl = isHistorical ? runtime.historicalEdgeTtlSeconds : runtime.recentEdgeTtlSeconds;
  const swr = isHistorical ? runtime.historicalSwrSeconds : runtime.recentSwrSeconds;
  return [
    "public",
    `max-age=${browserTtl}`,
    `s-maxage=${edgeTtl}`,
    `stale-while-revalidate=${swr}`,
    `stale-if-error=${runtime.staleIfErrorSeconds}`,
  ].join(", ");
}

function isTimeseriesV2ResponseCacheable(stitched: TimeseriesV2StitchResult): boolean {
  const meta = stitched.meta || {};
  const r2Errors = Array.isArray(meta.r2_errors) ? meta.r2_errors : [];
  const ingestErrors = Array.isArray(meta.ingest_errors) ? meta.ingest_errors : [];
  return meta.response_complete !== false &&
    meta.has_gap !== true &&
    r2Errors.length === 0 &&
    ingestErrors.length === 0;
}

async function buildTimeseriesV2Etag(bodyText: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(bodyText));
  const bytes = new Uint8Array(digest);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `"ts-v2-${encoded}"`;
}

function buildTimeseriesV2FallbackEnvelope(
  requestUrl: URL,
  payloadRecord: Record<string, unknown>,
  cacheStatus: "MISS" | "HIT" | "BYPASS",
  sourceMode = "origin_only_v2_wrapper",
  r2Errors: Array<string | Record<string, unknown>> = [],
  ingestErrors: Array<string | Record<string, unknown>> = [],
): TimeseriesV2StitchResult {
  const data = Array.isArray(payloadRecord.data) ? payloadRecord.data : [];
  const payloadMeta = payloadRecord.meta && typeof payloadRecord.meta === "object"
    ? payloadRecord.meta as Record<string, unknown>
    : {};
  const requestStartUtc = String(requestUrl.searchParams.get("start_utc") ?? "").trim() || null;
  const requestEndUtc = String(requestUrl.searchParams.get("end_utc") ?? "").trim() || null;
  const requestWindow = String(requestUrl.searchParams.get("window") ?? "").trim() || null;
  const requestSince = String(requestUrl.searchParams.get("since") ?? "").trim() || null;
  const responseComplete = typeof payloadRecord.response_complete === "boolean"
    ? payloadRecord.response_complete
    : typeof payloadMeta.response_complete === "boolean"
    ? payloadMeta.response_complete
    : null;
  const hasGap = typeof payloadRecord.has_gap === "boolean"
    ? payloadRecord.has_gap
    : typeof payloadMeta.has_gap === "boolean"
    ? payloadMeta.has_gap
    : responseComplete === false
    ? true
    : null;
  const rowCount = Number(payloadMeta.row_count ?? payloadRecord.count ?? data.length);
  const r2RowCount = Number(payloadMeta.r2_row_count);
  const ingestRowCount = Number(payloadMeta.ingest_row_count);
  const dedupedRowCount = Number(payloadMeta.deduped_row_count);
  const payloadR2Errors: Array<string | Record<string, unknown>> = Array.isArray(payloadMeta.r2_errors)
    ? (payloadMeta.r2_errors as unknown[]).map((e) => (e && typeof e === "object" && !Array.isArray(e) ? e as Record<string, unknown> : String(e)))
    : r2Errors;
  const payloadIngestErrors: Array<string | Record<string, unknown>> = Array.isArray(payloadMeta.ingest_errors)
    ? (payloadMeta.ingest_errors as unknown[]).map((e) => (e && typeof e === "object" && !Array.isArray(e) ? e as Record<string, unknown> : String(e)))
    : ingestErrors;
  const meta: TimeseriesV2EnvelopeMeta = {
    source_mode: String(payloadMeta.source_mode || payloadRecord.source || sourceMode),
    r2_coverage_start: typeof payloadMeta.r2_coverage_start === "string" ? payloadMeta.r2_coverage_start : null,
    r2_coverage_end: typeof payloadMeta.r2_coverage_end === "string" ? payloadMeta.r2_coverage_end : null,
    ingest_tail_start: typeof payloadMeta.ingest_tail_start === "string" ? payloadMeta.ingest_tail_start : null,
    ingest_tail_end: typeof payloadMeta.ingest_tail_end === "string" ? payloadMeta.ingest_tail_end : null,
    response_complete: responseComplete,
    has_gap: hasGap,
    gap_ranges: [],
    row_count: Number.isFinite(rowCount) ? rowCount : data.length,
    r2_row_count: Number.isFinite(r2RowCount) ? r2RowCount : null,
    ingest_row_count: Number.isFinite(ingestRowCount) ? ingestRowCount : null,
    deduped_row_count: Number.isFinite(dedupedRowCount) ? dedupedRowCount : null,
    next_since: payloadRecord.next_since ? String(payloadRecord.next_since) : null,
    cache_status: cacheStatus,
    r2_errors: payloadR2Errors,
    ingest_errors: payloadIngestErrors,
  };
  const envelope = {
    schema_version: 2,
    timeseries_id: Number(requestUrl.searchParams.get("timeseries_id") ?? 0) || null,
    request: {
      window: requestWindow,
      start_utc: requestStartUtc,
      end_utc: requestEndUtc,
      since: requestSince,
    },
    data,
    meta: {
      ...payloadMeta,
      ...meta,
    },
    data_format: payloadRecord.data_format ?? "objects",
    columns: Array.isArray(payloadRecord.columns) ? payloadRecord.columns : ["observed_at", "value"],
    next_since: payloadRecord.next_since ?? null,
    guideline: payloadRecord.guideline ?? null,
  };
  return {
    envelope,
    meta,
    sourceMode: sourceMode,
    cacheControl: [
      "public",
      "max-age=60",
      "s-maxage=60",
      "stale-while-revalidate=60",
      "stale-if-error=300",
    ].join(", "),
  };
}

async function stitchTimeseriesV2FromR2AndIngest(
  requestUrl: URL,
  cacheStatus: "MISS" | "HIT" | "BYPASS",
  env: Env,
  flags: TimeseriesV2Flags,
  deps: {
    supabaseUrl: string;
    supabasePublishableKey: string;
    upstreamAuthSecret: string;
    r2HistoryApiUrl: string;
    sbSecretKey: string;
  },
): Promise<TimeseriesV2StitchResult> {
  const runtime = buildTimeseriesV2RuntimeConfig(env);
  const requestWindow = buildTimeseriesV2RequestWindow(requestUrl, runtime);
  const requestStartUtc = toIsoSafe(requestWindow.requestStartMs);
  const requestEndUtc = toIsoSafe(requestWindow.requestEndMs);
  const windowLabelForGapDetection = requestWindow.normalizedWindowLabel
    || String(requestUrl.searchParams.get("window") || "explicit");

  if (!flags.r2First || !deps.r2HistoryApiUrl) {
    const originPayload = await fetchTimeseriesOriginPayload(
      deps.supabaseUrl,
      deps.supabasePublishableKey,
      deps.upstreamAuthSecret,
      {
        timeseriesId: requestWindow.timeseriesId,
        startUtc: requestStartUtc,
        endUtc: requestEndUtc,
        sinceUtc: requestWindow.requestSinceIso,
      },
    );
    return buildTimeseriesV2FallbackEnvelope(requestUrl, originPayload, cacheStatus);
  }

  const r2Errors: Array<string | Record<string, unknown>> = [];
  const ingestErrors: Array<string | Record<string, unknown>> = [];
  const partialReasons = new Set<string>();
  let connectorId: number | null = requestWindow.connectorId;
  let connectorIdSource: "request" | "supabase_lookup" | null = connectorId ? "request" : null;
  let r2Rows: Array<Record<string, unknown>> = [];
  let r2Coverage: Record<string, unknown> | null = null;
  let r2PagesFetched = 0;
  let r2HitPageLimit = false;

  if (!requestWindow.pollutantKey) {
    r2Errors.push("pollutant_required_for_v2_r2");
    partialReasons.add("pollutant_required_for_v2_r2");
  } else {
    if (!connectorId) {
      connectorId = await loadTimeseriesConnectorId(
        deps.supabaseUrl,
        deps.sbSecretKey,
        requestWindow.timeseriesId,
      );
      if (connectorId) {
        connectorIdSource = "supabase_lookup";
      }
    }
    if (!connectorId) {
      r2Errors.push("connector_id_lookup_failed");
      partialReasons.add("connector_id_lookup_failed");
    } else {
      try {
        const r2SinceUtc = applySinceOverlap(
          requestWindow.requestSinceIso,
          runtime.incrementalOverlapMinutes,
          requestWindow.requestStartMs,
        );
        const r2Result = await fetchR2ObservationsPaged(
          deps.r2HistoryApiUrl,
          deps.upstreamAuthSecret,
          {
            timeseriesId: requestWindow.timeseriesId,
            connectorId,
            pollutantKey: requestWindow.pollutantKey,
            startUtc: requestStartUtc,
            endUtc: requestEndUtc,
            sinceUtc: r2SinceUtc,
            pageLimitRows: runtime.maxR2ObjectsPerRequest,
            maxPages: TIMESERIES_V2_MAX_R2_PAGES_PER_REQUEST,
          },
        );
        r2Rows = r2Result.rows;
        r2Coverage = r2Result.coverage;
        r2PagesFetched = r2Result.pagesFetched;
        r2HitPageLimit = r2Result.hitPageLimit;
        if (r2HitPageLimit) {
          partialReasons.add("r2_page_limit_reached");
        }
        const coverageComplete = r2Coverage?.response_complete;
        if (coverageComplete === false) {
          partialReasons.add("r2_coverage_partial");
        }
      } catch (error) {
        if (error instanceof R2HistoryFetchError) {
          r2Errors.push(error.details);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          r2Errors.push(message);
        }
        partialReasons.add("r2_fetch_failed");
        if (!runtime.partialOnR2Error) {
          throw error;
        }
      }
    }
  }

  const r2RowCoverage = computeCoverageFromRows(r2Rows);
  const r2CoverageStart = r2RowCoverage.coverageStart;
  const r2CoverageEnd = r2RowCoverage.coverageEnd;
  const maxIngestSpanMs = runtime.maxSupabaseTailHours * HOUR_MS;
  const ingestSlices: Array<{ startMs: number; endMs: number; reason: string }> = [];
  const skippedIngestSlices: Array<{ start_utc: string; end_utc: string; reason: string }> = [];

  function addIngestSlice(startMs: number, endMs: number, reason: string): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return;
    }
    const cappedStartMs = Math.max(startMs, endMs - maxIngestSpanMs);
    if (cappedStartMs > startMs) {
      skippedIngestSlices.push({
        start_utc: new Date(startMs).toISOString(),
        end_utc: new Date(cappedStartMs).toISOString(),
        reason: `${reason}_outside_supabase_tail_cap`,
      });
      partialReasons.add("supabase_tail_cap");
    }
    if (endMs > cappedStartMs) {
      ingestSlices.push({ startMs: cappedStartMs, endMs, reason });
    }
  }

  if (r2Rows.length > 0) {
    const tail = subtractCoveredTailInterval(
      requestWindow.requestStartMs,
      requestWindow.requestEndMs,
      r2CoverageEnd,
    );
    addIngestSlice(tail.tailStartMs, tail.tailEndMs, "r2_tail_gap");

    const missingKeys = [
      ...asArrayOfStrings(r2Coverage?.missing_day_manifest_keys),
      ...asArrayOfStrings(r2Coverage?.missing_connector_manifest_keys),
      ...asArrayOfStrings(r2Coverage?.missing_parquet_keys),
    ];
    for (const slice of buildMissingDaySlices(
      missingKeys,
      requestWindow.requestStartMs,
      requestWindow.requestEndMs,
    )) {
      addIngestSlice(slice.startMs, slice.endMs, slice.reason || "r2_missing_slice");
    }
  } else {
    addIngestSlice(
      requestWindow.requestStartMs,
      requestWindow.requestEndMs,
      r2Errors.length ? "r2_unavailable" : "r2_empty",
    );
  }

  const mergedIngestSlices = mergeSlices(ingestSlices);
  const ingestRowsByObservedAt = new Map<string, Record<string, unknown>>();
  let guideline: unknown = null;
  for (const slice of mergedIngestSlices) {
    const sliceStartUtc = new Date(slice.startMs).toISOString();
    const sliceEndUtc = new Date(slice.endMs).toISOString();
    try {
      const originPayload = await fetchTimeseriesOriginPayload(
        deps.supabaseUrl,
        deps.supabasePublishableKey,
        deps.upstreamAuthSecret,
        {
          timeseriesId: requestWindow.timeseriesId,
          startUtc: sliceStartUtc,
          endUtc: sliceEndUtc,
          sinceUtc: requestWindow.requestSinceIso,
        },
      );
      if (guideline === null && Object.prototype.hasOwnProperty.call(originPayload, "guideline")) {
        guideline = originPayload.guideline;
      }
      for (const row of parseTimeseriesRowsFromPayload(originPayload, "ingest")) {
        const observedAt = String(row?.observed_at ?? "").trim();
        if (observedAt) {
          ingestRowsByObservedAt.set(observedAt, row);
        }
      }
    } catch (error) {
      if (error instanceof R2HistoryFetchError) {
        ingestErrors.push(error.details);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        ingestErrors.push(message);
      }
      partialReasons.add("ingest_fetch_failed");
      if (!runtime.partialOnIngestError) {
        throw error;
      }
    }
  }

  for (const skipped of skippedIngestSlices) {
    partialReasons.add(skipped.reason);
  }

  const ingestRows = Array.from(ingestRowsByObservedAt.values()).sort((left, right) => {
    const leftMs = parseIsoMsOrNull(String(left?.observed_at ?? "")) ?? 0;
    const rightMs = parseIsoMsOrNull(String(right?.observed_at ?? "")) ?? 0;
    return leftMs - rightMs;
  });
  const merged = mergeAndDedupeRows(r2Rows, ingestRows, flags.allowIngestOverwrite);
  const gapInfo = detectGapRanges(
    merged.merged,
    requestWindow.requestStartMs,
    requestWindow.requestEndMs,
    windowLabelForGapDetection,
  ) as { hasGap: boolean; gapRanges: Array<{ start_utc: string; end_utc: string }> };
  if (gapInfo.hasGap) {
    partialReasons.add("detected_gap");
  }

  let sourceMode = "ingest_only_fallback";
  if (r2Rows.length > 0 && ingestRows.length === 0) {
    sourceMode = "r2_only";
  } else if (r2Rows.length > 0 && ingestRows.length > 0) {
    const hasRepairs = mergedIngestSlices.some((slice) => slice.reason !== "r2_tail_gap");
    sourceMode = hasRepairs ? "r2_plus_ingest_tail_and_repairs" : "r2_plus_ingest_tail";
  } else if (r2Rows.length === 0 && r2Errors.length > 0) {
    sourceMode = "ingest_only_on_r2_error";
  }

  const responseComplete = partialReasons.size === 0 && !r2HitPageLimit && ingestErrors.length === 0;
  const nextSince = computeNextSince(merged.merged, requestWindow.requestSinceIso) as string | null;
  const meta: TimeseriesV2EnvelopeMeta = {
    source_mode: sourceMode,
    r2_coverage_start: r2CoverageStart,
    r2_coverage_end: r2CoverageEnd,
    ingest_tail_start: mergedIngestSlices.length ? new Date(mergedIngestSlices[0].startMs).toISOString() : null,
    ingest_tail_end: mergedIngestSlices.length
      ? new Date(mergedIngestSlices[mergedIngestSlices.length - 1].endMs).toISOString()
      : null,
    response_complete: responseComplete,
    has_gap: gapInfo.hasGap || partialReasons.size > 0,
    gap_ranges: gapInfo.gapRanges,
    row_count: merged.merged.length,
    r2_row_count: r2Rows.length,
    ingest_row_count: ingestRows.length,
    deduped_row_count: merged.deduped,
    next_since: nextSince,
    r2_errors: r2Errors,
    ingest_errors: ingestErrors,
    cache_status: cacheStatus,
  };

  const envelope = {
    schema_version: 2,
    timeseries_id: requestWindow.timeseriesId,
    request: {
      window: requestWindow.normalizedWindowLabel,
      start_utc: requestStartUtc,
      end_utc: requestEndUtc,
      since: requestWindow.requestSinceIso,
      connector_id: connectorId,
      pollutant: requestWindow.pollutantKey,
    },
    data: merged.merged,
    meta: {
      ...meta,
      coverage: r2Coverage,
      connector_id: connectorId,
      connector_id_source: connectorIdSource,
      used_supabase_connector_lookup: connectorIdSource === "supabase_lookup",
      pollutant: requestWindow.pollutantKey,
      partial_reasons: Array.from(partialReasons),
      r2_pages_fetched: r2PagesFetched,
      r2_hit_page_limit: r2HitPageLimit,
      ingest_slices: mergedIngestSlices.map((slice) => ({
        start_utc: new Date(slice.startMs).toISOString(),
        end_utc: new Date(slice.endMs).toISOString(),
        reason: slice.reason,
      })),
      skipped_ingest_slices: skippedIngestSlices,
    },
    data_format: "objects",
    columns: ["observed_at", "value"],
    next_since: nextSince,
    guideline,
  };

  return {
    envelope,
    meta,
    sourceMode,
    cacheControl: buildTimeseriesV2CacheControl(sourceMode, runtime),
  };
}

function canonicalizeAqiHistoryRequestUrl(url: URL, upstreamFunction: string): URL {
  const normalized = new URL(url.toString());
  if (upstreamFunction !== EXTERNAL_AQI_HISTORY_UPSTREAM) {
    return normalized;
  }

  const requestedFormat = String(normalized.searchParams.get("format") || "").trim().toLowerCase();
  if (requestedFormat === "tsv") {
    normalized.searchParams.set("format", "tsv");
  } else if (requestedFormat === "objects") {
    normalized.searchParams.set("format", "objects");
  } else {
    normalized.searchParams.set("format", "compact");
  }

  const startMs = parseIsoMsOrNull(getFirstSearchParam(normalized, AQI_HISTORY_START_KEYS));
  const endMs = parseIsoMsOrNull(getFirstSearchParam(normalized, AQI_HISTORY_END_KEYS));
  if (startMs === null || endMs === null || endMs <= startMs) {
    return normalized;
  }

  if ((endMs - startMs) < AQI_HISTORY_CANONICALIZE_MIN_WINDOW_MS) {
    return normalized;
  }

  const canonicalStartMs = Math.floor(startMs / HOUR_MS) * HOUR_MS;
  const canonicalEndMs = Math.floor(endMs / HOUR_MS) * HOUR_MS;
  if (!Number.isFinite(canonicalStartMs) || !Number.isFinite(canonicalEndMs) || canonicalEndMs <= canonicalStartMs) {
    return normalized;
  }

  const canonicalStartIso = new Date(canonicalStartMs).toISOString();
  const canonicalEndIso = new Date(canonicalEndMs).toISOString();
  for (const key of AQI_HISTORY_START_KEYS) {
    if (normalized.searchParams.has(key)) {
      normalized.searchParams.set(key, canonicalStartIso);
    }
  }
  for (const key of AQI_HISTORY_END_KEYS) {
    if (normalized.searchParams.has(key)) {
      normalized.searchParams.set(key, canonicalEndIso);
    }
  }
  return normalized;
}

function isImmutableAqiHistoryRequest(url: URL, nowMs = Date.now()): boolean {
  const explicitEndMs = parseIsoMsOrNull(
    url.searchParams.get("to_utc")
      || url.searchParams.get("end_utc")
      || url.searchParams.get("to")
      || url.searchParams.get("end"),
  );
  if (explicitEndMs === null || !Number.isFinite(explicitEndMs)) {
    return false;
  }
  return explicitEndMs <= (nowMs - AQI_HISTORY_MUTABLE_WINDOW_MS);
}

function resolveCacheProfileName(upstreamFunction: string, url: URL): CacheProfileName {
  if (
    upstreamFunction === EXTERNAL_AQI_HISTORY_UPSTREAM &&
    isImmutableAqiHistoryRequest(url)
  ) {
    return "aqi_history_immutable";
  }
  return FUNCTION_PROFILE_MAP[upstreamFunction];
}

function normalizeEtag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
}

function matchesIfNoneMatch(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) {
    return false;
  }
  const normalizedEtag = normalizeEtag(etag);
  const matchers = ifNoneMatch.split(",").map((part) => part.trim()).filter(Boolean);
  if (matchers.includes("*")) {
    return true;
  }
  return matchers.some((candidate) => normalizeEtag(candidate) === normalizedEtag);
}

function isBypassRequested(url: URL): boolean {
  return url.searchParams.get(CACHE_BYPASS_QUERY) === CACHE_BYPASS_VALUE;
}

function shouldCacheRequest(request: Request, bypassRequested: boolean): boolean {
  if (request.method !== "GET") {
    return false;
  }
  if (bypassRequested) {
    return false;
  }
  const cacheControl = (request.headers.get("Cache-Control") ?? "").toLowerCase();
  if (cacheControl.includes("no-store") || cacheControl.includes("no-cache")) {
    return false;
  }
  const pragma = (request.headers.get("Pragma") ?? "").toLowerCase();
  if (pragma.includes("no-cache")) {
    return false;
  }
  return true;
}

function isCacheableUpstreamResponse(response: Response): boolean {
  if (response.status !== 200) {
    return false;
  }
  if ((response.headers.get("X-UK-AQ-Response-Complete") ?? "").toLowerCase() === "false") {
    return false;
  }
  const cacheControl = (response.headers.get("Cache-Control") ?? "").toLowerCase();
  return !(cacheControl.includes("no-store") || cacheControl.includes("private"));
}

function isSafeRequestMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

function shouldRetryUpstreamStatus(status: number): boolean {
  return UPSTREAM_RETRY_STATUSES.has(status);
}

async function shouldRetryAqiHistoryUpstreamResponse(response: Response): Promise<boolean> {
  if (!shouldRetryUpstreamStatus(response.status)) {
    return false;
  }
  if (response.status !== 503) {
    return true;
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/html")) {
    return true;
  }
  try {
    const text = await response.clone().text();
    if (/Error\s+1102|Worker exceeded resource limits/i.test(text)) {
      return false;
    }
  } catch (_error) {
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type UpstreamFetchResult =
  | {
    response: Response;
    retried: false;
    attempts: number;
  }
  | {
    response: Response;
    retried: true;
    retryReason: "status" | "network";
    attempts: number;
  };

async function fetchUpstreamWithRetry(
  url: string,
  init: RequestInit,
  method: string,
  maxAttempts = DEFAULT_UPSTREAM_MAX_ATTEMPTS,
  retryDelayMs = UPSTREAM_RETRY_DELAY_MS,
  shouldRetryResponse: (response: Response) => Promise<boolean> | boolean = (response) => shouldRetryUpstreamStatus(response.status),
): Promise<UpstreamFetchResult> {
  const canRetry = isSafeRequestMethod(method);
  const normalizedAttempts = canRetry ? Math.max(1, Math.floor(maxAttempts)) : 1;
  let retriedForStatus = false;
  let retriedForNetwork = false;

  for (let attempt = 1; attempt <= normalizedAttempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const retryableResponse = canRetry ? await shouldRetryResponse(response) : false;
      const shouldRetry = retryableResponse && attempt < normalizedAttempts;
      if (!shouldRetry) {
        if (attempt === 1) {
          return { response, retried: false, attempts: 1 };
        }
        return {
          response,
          retried: true,
          retryReason: retriedForNetwork ? "network" : "status",
          attempts: attempt,
        };
      }
      retriedForStatus = true;
    } catch (error) {
      if (!canRetry || attempt >= normalizedAttempts) {
        throw error;
      }
      retriedForNetwork = true;
    }

    // Linear backoff gives the upstream worker time to warm caches/isolates after transient 5xx.
    await sleep(retryDelayMs * attempt);
  }

  throw new Error("unreachable_upstream_retry_state");
}

function resolveUpstreamFunction(pathname: string): string | null {
  if (!pathname.startsWith(API_PREFIX)) {
    return null;
  }
  const routeKey = pathname
    .slice(API_PREFIX.length)
    .replace(/\/+$/, "")
    .trim();
  if (!routeKey || routeKey.includes("/")) {
    return null;
  }

  const mapped = ROUTE_TO_FUNCTION_MAP[routeKey];
  if (mapped) {
    return mapped;
  }
  return FUNCTION_PROFILE_MAP[routeKey] ? routeKey : null;
}

function makeErrorResponse(
  status: number,
  message: string,
  requestOrigin: string | null,
  allowedOrigins: Set<string>,
): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  addCorsHeaders(headers, requestOrigin, allowedOrigins);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function makeOptionsResponse(requestOrigin: string | null, allowedOrigins: Set<string>): Response {
  const headers = new Headers({ "Cache-Control": "public, max-age=86400" });
  addCorsHeaders(headers, requestOrigin, allowedOrigins);
  return new Response(null, { status: 204, headers });
}

function encodeBase64UrlFromText(value: string): string {
  const bytes = textEncoder.encode(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64UrlToText(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + "=".repeat(padLength);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return textDecoder.decode(bytes);
  } catch (_err) {
    return null;
  }
}

async function signHmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(data));
  const bytes = new Uint8Array(signature);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifyTurnstileToken(
  turnstileSecret: string,
  token: string,
  remoteIp: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!turnstileSecret) {
    return { ok: false, reason: "missing_turnstile_secret" };
  }
  if (!token) {
    return { ok: false, reason: "turnstile_token_required" };
  }

  const body = new URLSearchParams();
  body.set("secret", turnstileSecret);
  body.set("response", token);
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  let verifyResponse: Response;
  try {
    verifyResponse = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (_err) {
    return { ok: false, reason: "turnstile_verify_unreachable" };
  }
  if (!verifyResponse.ok) {
    return { ok: false, reason: "turnstile_verify_http_error" };
  }

  let payload: TurnstileVerifyResponse;
  try {
    payload = await verifyResponse.json() as TurnstileVerifyResponse;
  } catch (_err) {
    return { ok: false, reason: "turnstile_verify_invalid_json" };
  }
  if (payload.success !== true) {
    const codes = Array.isArray(payload["error-codes"]) ? payload["error-codes"].join(",") : "";
    return { ok: false, reason: codes ? `turnstile_failed:${codes}` : "turnstile_failed" };
  }
  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    if (key !== name) {
      continue;
    }
    const value = trimmed.slice(idx + 1);
    try {
      return decodeURIComponent(value);
    } catch (_err) {
      return value;
    }
  }
  return null;
}

function buildSessionSetCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${maxAgeSeconds}`,
    `Path=${API_PREFIX}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

function buildSessionClearCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    `Path=${API_PREFIX}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

async function mintAccessToken(secret: string, requestOrigin: string, maxAgeSeconds: number): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + maxAgeSeconds;
  const header = {
    alg: "HS256",
    typ: "JWT",
  };
  const payload = {
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    iat,
    exp,
    origin: requestOrigin,
    jti: crypto.randomUUID(),
  };
  const encodedHeader = encodeBase64UrlFromText(JSON.stringify(header));
  const encodedPayload = encodeBase64UrlFromText(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHmac(signingInput, secret);
  return `${signingInput}.${signature}`;
}

async function verifyAccessToken(
  token: string,
  secret: string,
  requestOrigin: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) {
    return { ok: false, error: "invalid_session_format" };
  }
  const [encodedHeader, encodedPayload, signature] = tokenParts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = await signHmac(signingInput, secret);
  if (!timingSafeEqual(expectedSignature, signature)) {
    return { ok: false, error: "invalid_session_signature" };
  }

  const headerText = decodeBase64UrlToText(encodedHeader);
  const payloadText = decodeBase64UrlToText(encodedPayload);
  if (!headerText || !payloadText) {
    return { ok: false, error: "invalid_session_encoding" };
  }

  let header: AccessTokenHeader;
  let payload: AccessTokenPayload;
  try {
    header = JSON.parse(headerText) as AccessTokenHeader;
    payload = JSON.parse(payloadText) as AccessTokenPayload;
  } catch (_err) {
    return { ok: false, error: "invalid_session_json" };
  }

  if (header.alg !== "HS256" || header.typ !== "JWT") {
    return { ok: false, error: "invalid_session_header" };
  }

  const iat = Number(payload.iat);
  const exp = Number(payload.exp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) {
    return { ok: false, error: "invalid_session_times" };
  }
  if (exp <= now) {
    return { ok: false, error: "session_expired" };
  }
  if (iat > now + TOKEN_IAT_MAX_SKEW_SECONDS) {
    return { ok: false, error: "invalid_session_iat" };
  }
  if (exp - iat > TOKEN_MAX_LIFETIME_SECONDS) {
    return { ok: false, error: "invalid_session_lifetime" };
  }

  if (payload.iss !== TOKEN_ISSUER || payload.aud !== TOKEN_AUDIENCE) {
    return { ok: false, error: "invalid_session_audience" };
  }

  const tokenOrigin = normalizeOrigin(typeof payload.origin === "string" ? payload.origin : null);
  if (!tokenOrigin || tokenOrigin !== requestOrigin) {
    return { ok: false, error: "invalid_session_origin" };
  }

  return { ok: true };
}

function hasValidBypassHeader(request: Request, bypassSecret: string): boolean {
  if (!bypassSecret) {
    return false;
  }
  const supplied = request.headers.get(CACHE_BYPASS_HEADER);
  if (!supplied) {
    return false;
  }
  return timingSafeEqual(supplied, bypassSecret);
}

function hasValidLocalDevBypassHeader(request: Request, bypassSecret: string): boolean {
  if (!bypassSecret) {
    return false;
  }
  const supplied = request.headers.get(LOCAL_DEV_BYPASS_HEADER);
  if (!supplied) {
    return false;
  }
  return timingSafeEqual(supplied, bypassSecret);
}

function isSessionRoute(pathname: string): boolean {
  return pathname === SESSION_START_PATH || pathname === SESSION_END_PATH;
}

function requiresApiCORS(pathname: string): boolean {
  return pathname.startsWith(API_PREFIX);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestOrigin = resolveRequestOrigin(request, url);
    // Local dev proxy escape hatch: bypass origin + session checks only when explicitly enabled.
    const cacheBypassSecret = await readSecret(env.UK_AQ_CACHE_BYPASS_SECRET);
    const localDevBypassEnabled = parseBooleanFlag(await readSecret(env.UK_AQ_LOCAL_DEV_BYPASS_ENABLED));
    const isLocalDevRequest = localDevBypassEnabled && hasValidLocalDevBypassHeader(request, cacheBypassSecret);

    const allowedOriginsRaw = await readSecret(env.UK_AQ_CACHE_ALLOWED_ORIGINS);
    const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw);
    if (allowedOrigins.size === 0) {
      return makeErrorResponse(500, "missing_allowed_origins", requestOrigin, allowedOrigins);
    }

    if (request.method === "OPTIONS") {
      if (!requiresApiCORS(url.pathname)) {
        return makeErrorResponse(404, "route_not_found", requestOrigin, allowedOrigins);
      }
      if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
        return makeErrorResponse(403, "origin_not_allowed", requestOrigin, allowedOrigins);
      }
      return makeOptionsResponse(requestOrigin, allowedOrigins);
    }

    if (url.pathname === CHART_METRICS_PATH) {
      if (requestOrigin === null) {
        return makeErrorResponse(400, "origin_required", requestOrigin, allowedOrigins);
      }
      if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
        return makeErrorResponse(403, "origin_not_allowed", requestOrigin, allowedOrigins);
      }
      return handleChartMetricsIngest(request, env, ctx, requestOrigin, allowedOrigins);
    }

    const tokenSecret = await readSecret(env.UK_AQ_EDGE_ACCESS_TOKEN_SECRET);
    if (!tokenSecret) {
      return makeErrorResponse(500, "missing_edge_access_secret", requestOrigin, allowedOrigins);
    }

    if (url.pathname === WEBSITE_DEBUG_LOG_PATH) {
      if (requestOrigin === null) {
        return makeErrorResponse(400, "origin_required", requestOrigin, allowedOrigins);
      }
      if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
        return makeErrorResponse(403, "origin_not_allowed", requestOrigin, allowedOrigins);
      }
      if (!isLocalDevRequest) {
        const sessionToken = getCookieValue(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
        if (!sessionToken) {
          return makeErrorResponse(401, "missing_session_cookie", requestOrigin, allowedOrigins);
        }
        const authCheck = await verifyAccessToken(sessionToken, tokenSecret, requestOrigin);
        if (!authCheck.ok) {
          return makeErrorResponse(401, authCheck.error, requestOrigin, allowedOrigins);
        }
      }
      return handleWebsiteDebugLogIngest(request, env, ctx, requestOrigin, allowedOrigins);
    }

    if (isSessionRoute(url.pathname)) {
      if (requestOrigin === null) {
        return makeErrorResponse(400, "origin_required", requestOrigin, allowedOrigins);
      }
      if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
        return makeErrorResponse(403, "origin_not_allowed", requestOrigin, allowedOrigins);
      }
      const origin = requestOrigin;

      if (url.pathname === SESSION_END_PATH) {
        if (request.method !== "POST") {
          return makeErrorResponse(405, "method_not_allowed", requestOrigin, allowedOrigins);
        }
        const headers = new Headers({
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": buildSessionClearCookie(),
        });
        addCorsHeaders(headers, requestOrigin, allowedOrigins);
        return new Response(JSON.stringify({ ok: true, cleared: true }), { status: 200, headers });
      }

      if (request.method !== "POST") {
        return makeErrorResponse(405, "method_not_allowed", requestOrigin, allowedOrigins);
      }

      if ((request.headers.get(SESSION_INIT_HEADER) ?? "") !== "1") {
        return makeErrorResponse(400, "session_init_header_required", requestOrigin, allowedOrigins);
      }

      const turnstileCheck = await verifyTurnstileToken(
        await readSecret(env.UK_AQ_TURNSTILE_SECRET_KEY),
        (request.headers.get(TURNSTILE_TOKEN_HEADER) ?? "").trim(),
        request.headers.get("CF-Connecting-IP"),
      );
      if (!turnstileCheck.ok) {
        const status = turnstileCheck.reason === "missing_turnstile_secret"
          ? 500
          : turnstileCheck.reason === "turnstile_token_required"
          ? 400
          : turnstileCheck.reason.startsWith("turnstile_verify_")
          ? 502
          : 403;
        return makeErrorResponse(status, turnstileCheck.reason, requestOrigin, allowedOrigins);
      }

      const sessionMaxAgeSeconds = parseIntInRange(
        await readSecret(env.UK_AQ_EDGE_SESSION_MAX_AGE_SECONDS),
        DEFAULT_SESSION_MAX_AGE_SECONDS,
        MIN_SESSION_MAX_AGE_SECONDS,
        MAX_SESSION_MAX_AGE_SECONDS,
      );

      const issuedToken = await mintAccessToken(tokenSecret, origin, sessionMaxAgeSeconds);
      const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": buildSessionSetCookie(issuedToken, sessionMaxAgeSeconds),
      });
      addCorsHeaders(headers, requestOrigin, allowedOrigins);
      return new Response(
        JSON.stringify({
          ok: true,
          token_type: "cookie",
          session_expires_in: sessionMaxAgeSeconds,
        }),
        { status: 200, headers },
      );
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return makeErrorResponse(405, "method_not_allowed", requestOrigin, allowedOrigins);
    }

    const upstreamFunction = resolveUpstreamFunction(url.pathname);
    if (!upstreamFunction) {
      return makeErrorResponse(404, "route_not_found", requestOrigin, allowedOrigins);
    }

    if (!isLocalDevRequest) {
      if (requestOrigin === null) {
        return makeErrorResponse(400, "origin_required", requestOrigin, allowedOrigins);
      }
      if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
        return makeErrorResponse(403, "origin_not_allowed", requestOrigin, allowedOrigins);
      }
      const sessionToken = getCookieValue(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
      if (!sessionToken) {
        return makeErrorResponse(401, "missing_session_cookie", requestOrigin, allowedOrigins);
      }

      const authCheck = await verifyAccessToken(sessionToken, tokenSecret, requestOrigin);
      if (!authCheck.ok) {
        return makeErrorResponse(401, authCheck.error, requestOrigin, allowedOrigins);
      }
    }

    const bypassRequested = isBypassRequested(url);
    if (bypassRequested) {
      if (!hasValidBypassHeader(request, cacheBypassSecret)) {
        return makeErrorResponse(403, "cache_bypass_forbidden", requestOrigin, allowedOrigins);
      }
    }

    const timeseriesV2Flags = resolveTimeseriesV2FlagsFromEnv({
      v2EnabledRaw: await readSecret(env.UK_AQ_TIMESERIES_V2_ENABLED),
      proxyFirstRaw: await readSecret(env.UK_AQ_TIMESERIES_PROXY_FIRST),
      r2FirstRaw: await readSecret(env.UK_AQ_TIMESERIES_R2_FIRST),
      allowIngestOverwriteRaw: await readSecret(env.UK_AQ_TIMESERIES_ALLOW_INGEST_OVERWRITE),
    });
    const useTimeseriesV2Skeleton = isTimeseriesV2Request(url, upstreamFunction, timeseriesV2Flags);
    const timeseriesV2Canonicalized = useTimeseriesV2Skeleton
      ? canonicalizeTimeseriesV2RequestUrl(url, bypassRequested)
      : null;
    const normalizedRequestUrl = useTimeseriesV2Skeleton
      ? timeseriesV2Canonicalized!.url
      : canonicalizeAqiHistoryRequestUrl(url, upstreamFunction);
    const profileName = resolveCacheProfileName(upstreamFunction, normalizedRequestUrl);
    const profile = CACHE_PROFILES[profileName];
    const usingExternalAqiHistoryUpstream = upstreamFunction === EXTERNAL_AQI_HISTORY_UPSTREAM;
    const usingExternalLatestSnapshotUpstream = upstreamFunction === EXTERNAL_LATEST_SNAPSHOT_UPSTREAM;
    const usingExternalPostcodeLookupUpstream = upstreamFunction === EXTERNAL_POSTCODE_LOOKUP_UPSTREAM;
    const usingExternalPostcodeSuggestUpstream = upstreamFunction === EXTERNAL_POSTCODE_SUGGEST_UPSTREAM;
    const usingExternalPostcodePrefixHintsUpstream = upstreamFunction === EXTERNAL_POSTCODE_PREFIX_HINTS_UPSTREAM;
    const usingExternalUpstream =
      usingExternalAqiHistoryUpstream ||
      usingExternalLatestSnapshotUpstream ||
      usingExternalPostcodeLookupUpstream ||
      usingExternalPostcodeSuggestUpstream ||
      usingExternalPostcodePrefixHintsUpstream;

    const supabaseUrl = await readSecret(env.SUPABASE_URL);
    const supabasePublishableKey = await readSecret(env.SB_PUBLISHABLE_DEFAULT_KEY);
    const sbSecretKey = await readSecret(env.SB_SECRET_KEY);
    const aqiHistoryUpstreamUrl = await readSecret(env.UK_AQ_AQI_HISTORY_R2_API_URL);
    const observsHistoryR2ApiUrl = await readSecret(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL);
    const latestSnapshotUpstreamUrl = await readSecret(env.UK_AQ_LATEST_SNAPSHOT_R2_API_URL);
    const postcodeLookupUpstreamUrl = await readSecret(env.UK_AQ_POSTCODE_LOOKUP_R2_API_URL);
    const postcodeSuggestUpstreamUrl = await readSecret(env.UK_AQ_POSTCODE_SUGGEST_R2_API_URL);
    // Derive hints URL from suggest URL (same worker, different path)
    let postcodePrefixHintsUpstreamUrl = "";
    if (postcodeSuggestUpstreamUrl) {
      try {
        const hintsBase = new URL(normalizeBaseUrl(postcodeSuggestUpstreamUrl));
        hintsBase.pathname = "/v1/postcode_prefix_hints";
        postcodePrefixHintsUpstreamUrl = hintsBase.toString();
      } catch (_err) {
        // caught below during URL construction
      }
    }
    const upstreamAuthSecret = await readSecret(env.UK_AQ_EDGE_UPSTREAM_SECRET);
    if (!usingExternalUpstream && (!supabaseUrl || !supabasePublishableKey)) {
      return makeErrorResponse(500, "missing_worker_secrets", requestOrigin, allowedOrigins);
    }
    if (usingExternalAqiHistoryUpstream && !aqiHistoryUpstreamUrl) {
      return makeErrorResponse(500, "missing_aqi_history_upstream_url", requestOrigin, allowedOrigins);
    }
    if (usingExternalLatestSnapshotUpstream && !latestSnapshotUpstreamUrl) {
      return makeErrorResponse(500, "missing_latest_snapshot_upstream_url", requestOrigin, allowedOrigins);
    }
    if (usingExternalPostcodeLookupUpstream && !postcodeLookupUpstreamUrl) {
      return makeErrorResponse(500, "missing_postcode_lookup_upstream_url", requestOrigin, allowedOrigins);
    }
    if (usingExternalPostcodeSuggestUpstream && !postcodeSuggestUpstreamUrl) {
      return makeErrorResponse(500, "missing_postcode_suggest_upstream_url", requestOrigin, allowedOrigins);
    }
    if (usingExternalPostcodePrefixHintsUpstream && !postcodeSuggestUpstreamUrl) {
      return makeErrorResponse(500, "missing_postcode_suggest_upstream_url", requestOrigin, allowedOrigins);
    }
    if (!upstreamAuthSecret) {
      return makeErrorResponse(500, "missing_upstream_auth_secret", requestOrigin, allowedOrigins);
    }

    const shouldUseCache = shouldCacheRequest(request, bypassRequested);
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(normalizedRequestUrl.toString(), { method: "GET" });

    if (shouldUseCache && request.method === "GET") {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        if (matchesIfNoneMatch(request.headers.get("If-None-Match"), cachedResponse.headers.get("ETag"))) {
          const notModifiedHeaders = new Headers();
          const etag = cachedResponse.headers.get("ETag");
          const cacheControl = cachedResponse.headers.get("Cache-Control");
          if (etag) {
            notModifiedHeaders.set("ETag", etag);
          }
          if (cacheControl) {
            notModifiedHeaders.set("Cache-Control", cacheControl);
          }
          notModifiedHeaders.set("X-UK-AQ-Cache", "HIT");
          notModifiedHeaders.set("X-UK-AQ-Cache-Profile", profileName);
          if (useTimeseriesV2Skeleton) {
            notModifiedHeaders.set("X-UK-AQ-Cache-Key-Version", TIMESERIES_V2_CACHE_KEY_VERSION);
            const sourceMode = cachedResponse.headers.get("X-UK-AQ-Timeseries-Source-Mode");
            const hasGap = cachedResponse.headers.get("X-UK-AQ-Has-Gap");
            if (sourceMode) {
              notModifiedHeaders.set("X-UK-AQ-Timeseries-Source-Mode", sourceMode);
            }
            if (hasGap) {
              notModifiedHeaders.set("X-UK-AQ-Has-Gap", hasGap);
            }
          }
          addCorsHeaders(notModifiedHeaders, requestOrigin, allowedOrigins);
          return new Response(null, { status: 304, headers: notModifiedHeaders });
        }

        const hitHeaders = new Headers(cachedResponse.headers);
        hitHeaders.set("X-UK-AQ-Cache", "HIT");
        hitHeaders.set("X-UK-AQ-Cache-Profile", profileName);
        if (useTimeseriesV2Skeleton) {
          hitHeaders.set("X-UK-AQ-Cache-Key-Version", TIMESERIES_V2_CACHE_KEY_VERSION);
        }
        addCorsHeaders(hitHeaders, requestOrigin, allowedOrigins);
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
          headers: hitHeaders,
        });
      }
    }

    if (useTimeseriesV2Skeleton) {
      const cacheStatusLabel: "MISS" | "HIT" | "BYPASS" = shouldUseCache ? "MISS" : "BYPASS";
      let stitched: TimeseriesV2StitchResult;
      try {
        stitched = await stitchTimeseriesV2FromR2AndIngest(
          normalizedRequestUrl,
          cacheStatusLabel,
          env,
          timeseriesV2Flags,
          {
            supabaseUrl,
            supabasePublishableKey,
            upstreamAuthSecret,
            r2HistoryApiUrl: observsHistoryR2ApiUrl,
            sbSecretKey,
          },
        );
      } catch (error) {
        if (error instanceof RequestValidationError) {
          return makeErrorResponse(error.status, error.code, requestOrigin, allowedOrigins);
        }
        return makeErrorResponse(502, "timeseries_v2_stitch_failed", requestOrigin, allowedOrigins);
      }

      const bodyText = JSON.stringify(stitched.envelope);
      const etag = await buildTimeseriesV2Etag(bodyText);
      const timeseriesResponseCacheable = isTimeseriesV2ResponseCacheable(stitched);
      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", "application/json; charset=utf-8");
      responseHeaders.set("Cache-Control", timeseriesResponseCacheable ? stitched.cacheControl : "no-store");
      responseHeaders.set("ETag", etag);
      responseHeaders.set("X-UK-AQ-Cache", cacheStatusLabel);
      responseHeaders.set("X-UK-AQ-Cache-Profile", profileName);
      responseHeaders.set("X-UK-AQ-Cache-Key-Version", TIMESERIES_V2_CACHE_KEY_VERSION);
      responseHeaders.set("X-UK-AQ-Timeseries-Cacheable", String(timeseriesResponseCacheable));
      responseHeaders.set("X-UK-AQ-Timeseries-Source-Mode", stitched.meta.source_mode);
      if (stitched.meta.response_complete !== undefined && stitched.meta.response_complete !== null) {
        responseHeaders.set("X-UK-AQ-Response-Complete", String(stitched.meta.response_complete));
      }
      responseHeaders.set("X-UK-AQ-Has-Gap", String(stitched.meta.has_gap));
      if (stitched.meta.r2_coverage_end) {
        responseHeaders.set("X-UK-AQ-R2-Coverage-End", stitched.meta.r2_coverage_end);
      }
      if (stitched.meta.ingest_tail_start) {
        responseHeaders.set("X-UK-AQ-Ingest-Tail-Start", stitched.meta.ingest_tail_start);
      }
      if (stitched.meta.r2_row_count !== null) {
        responseHeaders.set("X-UK-AQ-R2-Rows", String(stitched.meta.r2_row_count));
      }
      if (stitched.meta.ingest_row_count !== null) {
        responseHeaders.set("X-UK-AQ-Ingest-Rows", String(stitched.meta.ingest_row_count));
      }
      if (timeseriesV2Canonicalized && timeseriesV2Canonicalized.strippedCacheBusters.length) {
        responseHeaders.set(
          "X-UK-AQ-Timeseries-Stripped-Params",
          timeseriesV2Canonicalized.strippedCacheBusters.join(","),
        );
      }
      addCorsHeaders(responseHeaders, requestOrigin, allowedOrigins);

      if (matchesIfNoneMatch(request.headers.get("If-None-Match"), etag)) {
        const notModifiedHeaders = new Headers(responseHeaders);
        return new Response(null, { status: 304, headers: notModifiedHeaders });
      }

      const stitchedResponse = new Response(bodyText, {
        status: 200,
        headers: responseHeaders,
      });
      if (timeseriesResponseCacheable && shouldUseCache && request.method === "GET") {
        ctx.waitUntil(cache.put(cacheKey, stitchedResponse.clone()));
      }
      return stitchedResponse;
    }

    let upstreamUrl: URL;
    try {
      upstreamUrl = usingExternalAqiHistoryUpstream
        ? new URL(normalizeBaseUrl(aqiHistoryUpstreamUrl))
        : usingExternalLatestSnapshotUpstream
        ? new URL(normalizeBaseUrl(latestSnapshotUpstreamUrl))
        : usingExternalPostcodeLookupUpstream
        ? new URL(normalizeBaseUrl(postcodeLookupUpstreamUrl))
        : usingExternalPostcodeSuggestUpstream
        ? new URL(normalizeBaseUrl(postcodeSuggestUpstreamUrl))
        : usingExternalPostcodePrefixHintsUpstream
        ? new URL(normalizeBaseUrl(postcodePrefixHintsUpstreamUrl))
        : new URL(`${normalizeBaseUrl(supabaseUrl)}/functions/v1/${upstreamFunction}`);
    } catch (_err) {
      return makeErrorResponse(
        500,
        usingExternalAqiHistoryUpstream
          ? "invalid_aqi_history_upstream_url"
          : usingExternalLatestSnapshotUpstream
          ? "invalid_latest_snapshot_upstream_url"
          : usingExternalPostcodeLookupUpstream
          ? "invalid_postcode_lookup_upstream_url"
          : usingExternalPostcodeSuggestUpstream
          ? "invalid_postcode_suggest_upstream_url"
          : usingExternalPostcodePrefixHintsUpstream
          ? "invalid_postcode_suggest_upstream_url"
          : "invalid_upstream_url",
        requestOrigin,
        allowedOrigins,
      );
    }
    const normalizedUpstreamRequestUrl = new URL(normalizedRequestUrl.toString());
    if (
      useTimeseriesV2Skeleton &&
      normalizedUpstreamRequestUrl.searchParams.get("format") === "json"
    ) {
      // Current uk_aq_timeseries origin supports objects/compact only.
      normalizedUpstreamRequestUrl.searchParams.set("format", "objects");
    }
    upstreamUrl.search = normalizedUpstreamRequestUrl.search;

    const upstreamHeaders = new Headers();
    if (!usingExternalUpstream) {
      upstreamHeaders.set("apikey", supabasePublishableKey);
      upstreamHeaders.set("Authorization", `Bearer ${supabasePublishableKey}`);
    }
    upstreamHeaders.set(UPSTREAM_AUTH_HEADER, upstreamAuthSecret);
    const accept = request.headers.get("Accept");
    if (accept) {
      upstreamHeaders.set("Accept", accept);
    }
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch) {
      upstreamHeaders.set("If-None-Match", ifNoneMatch);
    }
    const ifModifiedSince = request.headers.get("If-Modified-Since");
    if (ifModifiedSince) {
      upstreamHeaders.set("If-Modified-Since", ifModifiedSince);
    }

    let upstreamResponse: Response;
    let upstreamRetried = false;
    let upstreamRetryReason: "status" | "network" | null = null;
    let upstreamAttemptCount = 1;
    try {
      const upstreamMaxAttempts = usingExternalAqiHistoryUpstream
        ? AQI_HISTORY_UPSTREAM_MAX_ATTEMPTS
        : DEFAULT_UPSTREAM_MAX_ATTEMPTS;
      const upstreamRetryDelayMs = usingExternalAqiHistoryUpstream
        ? AQI_HISTORY_UPSTREAM_RETRY_DELAY_MS
        : UPSTREAM_RETRY_DELAY_MS;
      const fetchResult = await fetchUpstreamWithRetry(
        upstreamUrl.toString(),
        {
          method: request.method,
          headers: upstreamHeaders,
        },
        request.method,
        upstreamMaxAttempts,
        upstreamRetryDelayMs,
        usingExternalAqiHistoryUpstream
          ? shouldRetryAqiHistoryUpstreamResponse
          : undefined,
      );
      upstreamResponse = fetchResult.response;
      upstreamRetried = fetchResult.retried;
      upstreamAttemptCount = fetchResult.attempts;
      if (fetchResult.retried) {
        upstreamRetryReason = fetchResult.retryReason;
      }
    } catch (_err) {
      return makeErrorResponse(502, "upstream_fetch_failed", requestOrigin, allowedOrigins);
    }

    const cacheStatusLabel: "MISS" | "HIT" | "BYPASS" = shouldUseCache ? "MISS" : "BYPASS";
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete("Set-Cookie");
    responseHeaders.set("X-UK-AQ-Cache", cacheStatusLabel);
    responseHeaders.set("X-UK-AQ-Cache-Profile", profileName);
    if (upstreamRetried && upstreamRetryReason) {
      responseHeaders.set("X-UK-AQ-Upstream-Retry", upstreamRetryReason);
    }
    responseHeaders.set("X-UK-AQ-Upstream-Attempts", String(upstreamAttemptCount));
    const upstreamResponseComplete = (upstreamResponse.headers.get("X-UK-AQ-Response-Complete") ?? "").toLowerCase();
    if (upstreamResponse.status === 200 && upstreamResponseComplete !== "false") {
      responseHeaders.set("Cache-Control", buildCacheControl(profile));
    } else if (upstreamResponseComplete === "false") {
      responseHeaders.set("Cache-Control", "no-store");
    }
    const responseBody: BodyInit | null = upstreamResponse.body;
    addCorsHeaders(responseHeaders, requestOrigin, allowedOrigins);

    const response = new Response(responseBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });

    if (shouldUseCache && request.method === "GET" && isCacheableUpstreamResponse(upstreamResponse)) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};
