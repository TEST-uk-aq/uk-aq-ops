export interface Env {
  SUPABASE_URL: unknown;
  SB_PUBLISHABLE_DEFAULT_KEY: unknown;
  OBS_AQIDB_SUPABASE_URL: unknown;
  OBS_AQIDB_SECRET_KEY: unknown;
  UK_AQ_AQI_HISTORY_R2_API_URL: unknown;
  UK_AQ_CACHE_ALLOWED_ORIGINS: unknown;
  UK_AQ_EDGE_ACCESS_TOKEN_SECRET: unknown;
  UK_AQ_EDGE_UPSTREAM_SECRET: unknown;
  UK_AQ_CACHE_BYPASS_SECRET: unknown;
  UK_AQ_TURNSTILE_SECRET_KEY: unknown;
  UK_AQ_EDGE_SESSION_MAX_AGE_SECONDS: unknown;
  UK_AQ_CHART_METRICS_RPC: unknown;
  UK_AQ_CHART_METRICS_RPC_SCHEMA: unknown;
  UK_AQ_CHART_METRICS_RATE_LIMIT_PER_MINUTE: unknown;
  UK_AQ_CHART_METRICS_MAX_BODY_BYTES: unknown;
}

type CacheProfileName = "realtime" | "metadata" | "stations_metadata" | "aqi_history_immutable";

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
};

const EXTERNAL_AQI_HISTORY_UPSTREAM = "__uk_aq_aqi_history_r2_api__";

const FUNCTION_PROFILE_MAP: Record<string, CacheProfileName> = {
  uk_aq_latest: "realtime",
  uk_aq_timeseries: "realtime",
  uk_aq_stations_chart: "realtime",
  uk_aq_stations: "stations_metadata",
  uk_aq_la_hex: "metadata",
  uk_aq_pcon_hex: "metadata",
  [EXTERNAL_AQI_HISTORY_UPSTREAM]: "realtime",
};

const ROUTE_TO_FUNCTION_MAP: Record<string, keyof typeof FUNCTION_PROFILE_MAP> = {
  latest: "uk_aq_latest",
  timeseries: "uk_aq_timeseries",
  "stations-chart": "uk_aq_stations_chart",
  stations: "uk_aq_stations",
  "la-hex": "uk_aq_la_hex",
  "pcon-hex": "uk_aq_pcon_hex",
  "aqi-history": EXTERNAL_AQI_HISTORY_UPSTREAM,
};

const API_PREFIX = "/api/aq/";
const SESSION_START_PATH = "/api/aq/session/start";
const SESSION_END_PATH = "/api/aq/session/end";
const CHART_METRICS_PATH = "/api/aq/chart-metrics";
const SESSION_COOKIE_NAME = "uk_aq_edge_session";
const SESSION_INIT_HEADER = "X-UK-AQ-Session-Init";
const CACHE_BYPASS_QUERY = "cache";
const CACHE_BYPASS_VALUE = "bypass";
const CACHE_BYPASS_HEADER = "X-UK-AQ-Bypass-Token";
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
const UPSTREAM_RETRY_DELAY_MS = 300;
const UPSTREAM_RETRY_STATUSES = new Set([502, 503, 504]);
const AQI_HISTORY_MUTABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHART_METRICS_MIN_BODY_BYTES = 4 * 1024;
const CHART_METRICS_DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const CHART_METRICS_MAX_BODY_BYTES = 256 * 1024;
const CHART_METRICS_DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const CHART_METRICS_MAX_TRACKED_KEYS = 5_000;
const CHART_METRICS_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_CHART_METRICS_RPC = "uk_aq_rpc_chart_load_metrics_insert";
const DEFAULT_CHART_METRICS_RPC_SCHEMA = "uk_aq_public";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const chartMetricsRateState = new Map<string, { windowStartMs: number; count: number }>();

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
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
  headers.set("Access-Control-Expose-Headers", "CF-Cache-Status,ETag,X-UK-AQ-Cache,X-UK-AQ-Cache-Profile");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type UpstreamFetchResult =
  | {
    response: Response;
    retried: false;
  }
  | {
    response: Response;
    retried: true;
    retryReason: "status" | "network";
  };

async function fetchUpstreamWithRetry(
  url: string,
  init: RequestInit,
  method: string,
): Promise<UpstreamFetchResult> {
  const canRetry = isSafeRequestMethod(method);
  try {
    const firstResponse = await fetch(url, init);
    if (!canRetry || !shouldRetryUpstreamStatus(firstResponse.status)) {
      return { response: firstResponse, retried: false };
    }
    await sleep(UPSTREAM_RETRY_DELAY_MS);
    const secondResponse = await fetch(url, init);
    return { response: secondResponse, retried: true, retryReason: "status" };
  } catch (firstError) {
    if (!canRetry) {
      throw firstError;
    }
    await sleep(UPSTREAM_RETRY_DELAY_MS);
    const secondResponse = await fetch(url, init);
    return { response: secondResponse, retried: true, retryReason: "network" };
  }
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

    if (requestOrigin === null) {
      return makeErrorResponse(400, "origin_required", requestOrigin, allowedOrigins);
    }
    if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
      return makeErrorResponse(403, "origin_not_allowed", requestOrigin, allowedOrigins);
    }
    const origin = requestOrigin;

    const sessionToken = getCookieValue(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
    if (!sessionToken) {
      return makeErrorResponse(401, "missing_session_cookie", requestOrigin, allowedOrigins);
    }

    const authCheck = await verifyAccessToken(sessionToken, tokenSecret, origin);
    if (!authCheck.ok) {
      return makeErrorResponse(401, authCheck.error, requestOrigin, allowedOrigins);
    }

    const bypassRequested = isBypassRequested(url);
    if (bypassRequested) {
      const bypassSecret = await readSecret(env.UK_AQ_CACHE_BYPASS_SECRET);
      if (!hasValidBypassHeader(request, bypassSecret)) {
        return makeErrorResponse(403, "cache_bypass_forbidden", requestOrigin, allowedOrigins);
      }
    }

    const profileName = resolveCacheProfileName(upstreamFunction, url);
    const profile = CACHE_PROFILES[profileName];
    const usingExternalAqiHistoryUpstream = upstreamFunction === EXTERNAL_AQI_HISTORY_UPSTREAM;

    const supabaseUrl = await readSecret(env.SUPABASE_URL);
    const supabasePublishableKey = await readSecret(env.SB_PUBLISHABLE_DEFAULT_KEY);
    const aqiHistoryUpstreamUrl = await readSecret(env.UK_AQ_AQI_HISTORY_R2_API_URL);
    const upstreamAuthSecret = await readSecret(env.UK_AQ_EDGE_UPSTREAM_SECRET);
    if (!usingExternalAqiHistoryUpstream && (!supabaseUrl || !supabasePublishableKey)) {
      return makeErrorResponse(500, "missing_worker_secrets", requestOrigin, allowedOrigins);
    }
    if (usingExternalAqiHistoryUpstream && !aqiHistoryUpstreamUrl) {
      return makeErrorResponse(500, "missing_aqi_history_upstream_url", requestOrigin, allowedOrigins);
    }
    if (!upstreamAuthSecret) {
      return makeErrorResponse(500, "missing_upstream_auth_secret", requestOrigin, allowedOrigins);
    }

    const shouldUseCache = shouldCacheRequest(request, bypassRequested);
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(url.toString(), { method: "GET" });

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
          addCorsHeaders(notModifiedHeaders, requestOrigin, allowedOrigins);
          return new Response(null, { status: 304, headers: notModifiedHeaders });
        }

        const hitHeaders = new Headers(cachedResponse.headers);
        hitHeaders.set("X-UK-AQ-Cache", "HIT");
        hitHeaders.set("X-UK-AQ-Cache-Profile", profileName);
        addCorsHeaders(hitHeaders, requestOrigin, allowedOrigins);
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
          headers: hitHeaders,
        });
      }
    }

    let upstreamUrl: URL;
    try {
      upstreamUrl = usingExternalAqiHistoryUpstream
        ? new URL(normalizeBaseUrl(aqiHistoryUpstreamUrl))
        : new URL(`${normalizeBaseUrl(supabaseUrl)}/functions/v1/${upstreamFunction}`);
    } catch (_err) {
      return makeErrorResponse(
        500,
        usingExternalAqiHistoryUpstream ? "invalid_aqi_history_upstream_url" : "invalid_upstream_url",
        requestOrigin,
        allowedOrigins,
      );
    }
    upstreamUrl.search = url.search;

    const upstreamHeaders = new Headers();
    if (!usingExternalAqiHistoryUpstream) {
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
    try {
      const fetchResult = await fetchUpstreamWithRetry(
        upstreamUrl.toString(),
        {
          method: request.method,
          headers: upstreamHeaders,
        },
        request.method,
      );
      upstreamResponse = fetchResult.response;
      upstreamRetried = fetchResult.retried;
      if (fetchResult.retried) {
        upstreamRetryReason = fetchResult.retryReason;
      }
    } catch (_err) {
      return makeErrorResponse(502, "upstream_fetch_failed", requestOrigin, allowedOrigins);
    }

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete("Set-Cookie");
    responseHeaders.set("X-UK-AQ-Cache", shouldUseCache ? "MISS" : "BYPASS");
    responseHeaders.set("X-UK-AQ-Cache-Profile", profileName);
    if (upstreamRetried && upstreamRetryReason) {
      responseHeaders.set("X-UK-AQ-Upstream-Retry", upstreamRetryReason);
    }
    if (upstreamResponse.status === 200) {
      responseHeaders.set("Cache-Control", buildCacheControl(profile));
    }
    addCorsHeaders(responseHeaders, requestOrigin, allowedOrigins);

    const response = new Response(upstreamResponse.body, {
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
