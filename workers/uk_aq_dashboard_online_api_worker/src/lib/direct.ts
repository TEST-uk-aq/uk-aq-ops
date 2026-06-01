import { buildJsonResponse, errorEnvelope } from "./http";
import type { WorkerEnv } from "./upstream";

type JsonObject = Record<string, unknown>;

type DashboardPayload = {
  project_ref: string | null;
  obs_aqidb_project_ref: string | null;
  generated_at: string;
  dispatch_cursor: string | null;
  buckets: string[];
  db_size_metrics: unknown[];
  schema_size_metrics: unknown[];
  r2_domain_size_metrics: unknown[];
  db_size_metrics_error: string | null;
  schema_size_metrics_error: string | null;
  r2_domain_size_metrics_error: string | null;
  r2_usage: JsonObject | null;
  r2_usage_error: string | null;
  service_egress_metrics: unknown[];
  service_egress_metrics_error: string | null;
  r2_backup_window: JsonObject | null;
  r2_backup_window_error: string | null;
  r2_history_days_bucket: string | null;
  r2_history_days_error: string | null;
  dropbox_backup_state_path: string | null;
  dropbox_backup_state_error: string | null;
  storage_coverage_source: string;
  storage_coverage_days: unknown[];
  pollutants: unknown[];
  dispatch_runs: unknown[];
  dispatcher_settings: JsonObject;
  connectors_settings: unknown[];
};

type PostgrestSchema = "uk_aq_core" | "uk_aq_public" | "uk_aq_ops";

type R2DaySets = {
  observations: Set<string>;
  aqilevels: Set<string>;
};

const BUCKETS = ["0-3 Hours", "3-6 Hours", "6-24 Hours", "1 - 7 Days", "Older than 7 Days"] as const;
const POLLUTANTS: Record<string, { label: string; tokens: string[] }> = {
  pm25: { label: "PM2.5", tokens: ["pm25", "pm2.5", "pm2-5", "pm2_5"] },
  pm10: { label: "PM10", tokens: ["pm10"] },
  no2: { label: "NO2", tokens: ["no2"] },
};
const EXCLUDED_CONNECTORS_BY_POLLUTANT: Record<string, Set<string>> = {
  pm10: new Set(["breathelondon"]),
  no2: new Set(["sensorcommunity"]),
};

const DASHBOARD_TTL_MS = 20_000;
const STORAGE_COVERAGE_TTL_MS = 5 * 60_000;
const R2_USAGE_TTL_MS = 60 * 60_000;
const R2_HISTORY_DAYS_TTL_MS = 5 * 60_000;
const DROPBOX_MTIME_TTL_MS = 20_000;
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const DROPBOX_GET_METADATA_URL = "https://api.dropboxapi.com/2/files/get_metadata";

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const dashboardCache = new Map<string, CacheEntry<DashboardPayload>>();
let storageCoverageCache: CacheEntry<{ generated_at: string; storage_coverage_source: string; storage_coverage_days: unknown[] }> | null = null;
let r2UsageCache: CacheEntry<{ usage: JsonObject | null; error: string | null }> | null = null;
let r2HistoryDaysCache: CacheEntry<{ daySets: R2DaySets | null; window: JsonObject | null; bucket: string | null; error: string | null }> | null = null;
let dropboxMtimeCache: CacheEntry<{ payload: JsonObject; error: string | null }> | null = null;

function readNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asBoolFlag(value: string | null | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return !["0", "false", "no", "n", "off"].includes(normalized);
}

function asTruthy(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function parseTimestamp(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toPostgrestTimestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractProjectRef(urlValue: string): string | null {
  try {
    const hostname = new URL(urlValue).hostname.toLowerCase();
    const match = hostname.match(/^([a-z0-9-]+)\.supabase\.co$/);
    return match ? match[1] : null;
  } catch (_err) {
    return null;
  }
}

function normalizeIsoDay(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const maybeDay = raw.includes("T") ? raw.slice(0, 10) : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(maybeDay)) {
    return null;
  }
  return maybeDay;
}

function parseIsoDay(value: unknown): Date | null {
  const normalized = normalizeIsoDay(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function defaultCoreSchema(env: WorkerEnv): PostgrestSchema {
  return String(env.UK_AQ_CORE_SCHEMA || "uk_aq_core").trim() as PostgrestSchema;
}

function defaultPublicSchema(env: WorkerEnv): PostgrestSchema {
  return String(env.UK_AQ_PUBLIC_SCHEMA || "uk_aq_public").trim() as PostgrestSchema;
}

function defaultOpsSchema(env: WorkerEnv): PostgrestSchema {
  return String(env.UK_AQ_OPS_SCHEMA || "uk_aq_ops").trim() as PostgrestSchema;
}

function ingestRestBase(env: WorkerEnv): string {
  const supabase = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (!supabase) {
    throw new Error("SUPABASE_URL is required for direct dashboard mode.");
  }
  return `${supabase}/rest/v1`;
}

function obsRestBase(env: WorkerEnv): string {
  const supabase = String(env.OBS_AQIDB_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (!supabase) {
    throw new Error("OBS_AQIDB_SUPABASE_URL is required for this endpoint.");
  }
  return `${supabase}/rest/v1`;
}

function requireServiceKey(env: WorkerEnv): string {
  const key = String(env.SB_SECRET_KEY || "").trim();
  if (!key) {
    throw new Error("SB_SECRET_KEY is required for direct dashboard mode.");
  }
  return key;
}

function requireObsServiceKey(env: WorkerEnv): string {
  const key = String(env.OBS_AQIDB_SECRET_KEY || "").trim();
  if (!key) {
    throw new Error("OBS_AQIDB_SECRET_KEY is required for this endpoint.");
  }
  return key;
}

function postgrestHeaders(serviceRoleKey: string, schema: PostgrestSchema, write = false): Headers {
  const headers = new Headers();
  headers.set("apikey", serviceRoleKey);
  headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  headers.set("Accept-Profile", schema);
  if (write) {
    headers.set("Content-Profile", schema);
  }
  return headers;
}

async function fetchJsonObject(
  url: string,
  init?: RequestInit,
  errLabel?: string,
): Promise<JsonObject> {
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_err) {
    parsed = null;
  }
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && parsed !== null
        ? String((parsed as { message?: string; error?: string }).message || (parsed as { error?: string }).error || text || "")
        : text || "";
    throw new Error(`${errLabel || "Request failed"} (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${errLabel || "Request failed"} returned non-object JSON payload.`);
  }
  return parsed as JsonObject;
}

async function fetchJsonArray(
  url: string,
  init?: RequestInit,
  errLabel?: string,
): Promise<unknown[]> {
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_err) {
    parsed = null;
  }
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && parsed !== null
        ? String((parsed as { message?: string; error?: string }).message || (parsed as { error?: string }).error || text || "")
        : text || "";
    throw new Error(`${errLabel || "Request failed"} (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${errLabel || "Request failed"} returned non-array JSON payload.`);
  }
  return parsed;
}

function buildUrl(base: string, path: string, params?: Record<string, string | undefined>): string {
  const url = new URL(path, `${base}/`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

function appendQueryParams(urlValue: string, params?: Record<string, string | undefined>): string {
  const url = new URL(urlValue);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

function resolveUrlOrigin(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    if (!parsed.protocol || !parsed.host) {
      return "";
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_err) {
    return "";
  }
}

function resolveR2HistoryDaysApiUrl(env: WorkerEnv): string {
  const explicit = String(env.UK_AQ_R2_HISTORY_DAYS_API_URL || "").trim();
  if (explicit) {
    return explicit;
  }
  const dbSizeApi = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  if (!dbSizeApi) {
    return "";
  }
  const origin = resolveUrlOrigin(dbSizeApi);
  if (!origin) {
    return "";
  }
  return `${origin}/v1/r2-history-days`;
}

function resolveR2HistoryCountsApiUrl(env: WorkerEnv): string {
  const explicit = String(env.UK_AQ_R2_HISTORY_COUNTS_API_URL || "").trim();
  if (explicit) {
    return explicit;
  }

  const daysApi = String(env.UK_AQ_R2_HISTORY_DAYS_API_URL || "").trim();
  if (daysApi) {
    const origin = resolveUrlOrigin(daysApi);
    if (origin) {
      return `${origin}/v1/r2-history-counts`;
    }
  }

  const dbSizeApi = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  if (!dbSizeApi) {
    return "";
  }
  const origin = resolveUrlOrigin(dbSizeApi);
  if (!origin) {
    return "";
  }
  return `${origin}/v1/r2-history-counts`;
}

function resolveR2HistoryDaysApiToken(env: WorkerEnv): string {
  return String(env.UK_AQ_R2_HISTORY_DAYS_API_TOKEN || env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
}

function resolveR2HistoryCountsApiToken(env: WorkerEnv): string {
  return String(
    env.UK_AQ_R2_HISTORY_COUNTS_API_TOKEN ||
      env.UK_AQ_R2_HISTORY_DAYS_API_TOKEN ||
      env.UK_AQ_DB_SIZE_API_TOKEN ||
      "",
  ).trim();
}

async function fetchAllRows(
  restBase: string,
  tableOrView: string,
  headers: Headers,
  params: Record<string, string>,
  pageSize = 1000,
): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  let offset = 0;
  while (true) {
    const query = {
      ...params,
      limit: String(pageSize),
      offset: String(offset),
    };
    const batch = await fetchJsonArray(
      buildUrl(restBase, tableOrView, query),
      { headers, method: "GET" },
      `Failed to fetch ${tableOrView}`,
    );
    const safeBatch = batch.filter((row): row is JsonObject => !!row && typeof row === "object" && !Array.isArray(row));
    rows.push(...safeBatch);
    if (safeBatch.length < pageSize) {
      break;
    }
    offset += pageSize;
  }
  return rows;
}

function pickPollutantKey(row: JsonObject): string | null {
  const candidates: string[] = [];
  const phenomenon = row.phenomenon;
  if (phenomenon && typeof phenomenon === "object" && !Array.isArray(phenomenon)) {
    for (const key of ["notation", "pollutant_label", "label"]) {
      const value = (phenomenon as JsonObject)[key];
      if (value) {
        candidates.push(String(value));
      }
    }
  }
  if (row.label) {
    candidates.push(String(row.label));
  }
  for (const candidate of candidates) {
    const cleaned = normalizeToken(candidate);
    for (const [pollutantKey, config] of Object.entries(POLLUTANTS)) {
      if (config.tokens.some((token) => cleaned.includes(normalizeToken(token)))) {
        return pollutantKey;
      }
    }
  }
  return null;
}

function bucketFor(latestAt: Date, now: Date): string {
  const hours = (now.getTime() - latestAt.getTime()) / 3_600_000;
  if (hours <= 3) return "0-3 Hours";
  if (hours <= 6) return "3-6 Hours";
  if (hours <= 24) return "6-24 Hours";
  if (hours <= 24 * 7) return "1 - 7 Days";
  return "Older than 7 Days";
}

function cacheGet<T>(entry: CacheEntry<T> | null): T | null {
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    return null;
  }
  return entry.value;
}

function parseHistoryDaySets(payload: JsonObject): R2DaySets {
  const domains = payload.domains;
  const sets: R2DaySets = { observations: new Set<string>(), aqilevels: new Set<string>() };
  if (!domains || typeof domains !== "object" || Array.isArray(domains)) {
    return sets;
  }
  for (const domainName of ["observations", "aqilevels"] as const) {
    const domain = (domains as JsonObject)[domainName];
    if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
      continue;
    }
    const days = (domain as JsonObject).days;
    if (!Array.isArray(days)) {
      continue;
    }
    for (const value of days) {
      const day = normalizeIsoDay(value);
      if (day) {
        sets[domainName].add(day);
      }
    }
  }
  return sets;
}

function buildR2Window(daySets: R2DaySets): JsonObject {
  const overlap: string[] = [];
  for (const day of daySets.observations) {
    if (daySets.aqilevels.has(day)) {
      overlap.push(day);
    }
  }
  overlap.sort();
  const observations = Array.from(daySets.observations).sort();
  const aqilevels = Array.from(daySets.aqilevels).sort();
  return {
    min_day_utc: overlap.length ? overlap[0] : null,
    max_day_utc: overlap.length ? overlap[overlap.length - 1] : null,
    day_count: overlap.length,
    observations_day_count: observations.length,
    aqilevels_day_count: aqilevels.length,
    count_basis: "explicit_overlap_both_domains",
  };
}

async function fetchR2HistoryDays(
  env: WorkerEnv,
  forceRefresh = false,
): Promise<{ daySets: R2DaySets | null; window: JsonObject | null; bucket: string | null; error: string | null }> {
  if (!forceRefresh) {
    const cached = cacheGet(r2HistoryDaysCache);
    if (cached) {
      return cached;
    }
  }

  const apiUrl = resolveR2HistoryDaysApiUrl(env);
  if (!apiUrl) {
    const fallback = {
      daySets: null,
      window: null,
      bucket: null,
      error: "R2 history-days API not configured",
    };
    r2HistoryDaysCache = { value: fallback, expiresAt: Date.now() + R2_HISTORY_DAYS_TTL_MS };
    return fallback;
  }

  const headers = new Headers();
  headers.set("Accept", "application/json");
  const token = resolveR2HistoryDaysApiToken(env);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const maxDays = Math.max(1, Math.min(3660, Math.trunc(readNumber(env.UK_AQ_R2_HISTORY_DAYS_API_MAX_DAYS, 3660))));
  try {
    const payload = await fetchJsonObject(
      appendQueryParams(apiUrl, { max_days: String(maxDays) }),
      { method: "GET", headers },
      "R2 history-days API",
    );
    const daySets = parseHistoryDaySets(payload);
    const value = {
      daySets,
      window: buildR2Window(daySets),
      bucket: String(payload.bucket || "").trim() || null,
      error: null,
    };
    r2HistoryDaysCache = { value, expiresAt: Date.now() + R2_HISTORY_DAYS_TTL_MS };
    return value;
  } catch (err) {
    const value = {
      daySets: null,
      window: null,
      bucket: null,
      error: err instanceof Error ? err.message : String(err),
    };
    r2HistoryDaysCache = { value, expiresAt: Date.now() + R2_HISTORY_DAYS_TTL_MS };
    return value;
  }
}

async function fetchR2BackupWindowFromSupabase(env: WorkerEnv): Promise<{ window: JsonObject | null; error: string | null }> {
  try {
    const restBase = ingestRestBase(env);
    const key = requireServiceKey(env);
    const rows = await fetchJsonArray(
      buildUrl(restBase, `rpc/${String(env.UK_AQ_R2_HISTORY_WINDOW_RPC || "uk_aq_rpc_r2_history_window").trim() || "uk_aq_rpc_r2_history_window"}`),
      {
        method: "POST",
        headers: postgrestHeaders(key, defaultPublicSchema(env), true),
        body: JSON.stringify({}),
      },
      "R2 window RPC",
    );
    const first = rows.find((row): row is JsonObject => !!row && typeof row === "object" && !Array.isArray(row));
    if (!first) {
      return {
        window: {
          min_day_utc: null,
          max_day_utc: null,
          day_count: null,
          count_basis: "range_rpc_fallback",
        },
        error: null,
      };
    }
    return {
      window: {
        min_day_utc: normalizeIsoDay(first.min_day_utc),
        max_day_utc: normalizeIsoDay(first.max_day_utc),
        day_count: null,
        count_basis: "range_rpc_fallback",
      },
      error: null,
    };
  } catch (err) {
    return { window: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractR2UsagePoint(value: unknown): { used_bytes: number; object_count: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as JsonObject;
  const bytes = readNumber(row.used_bytes, Number.NaN);
  const objects = readNumber(row.object_count, Number.NaN);
  if (!Number.isFinite(bytes) || !Number.isFinite(objects)) {
    return null;
  }
  return { used_bytes: bytes, object_count: objects };
}

async function fetchR2Usage(env: WorkerEnv, forceRefresh = false): Promise<{ usage: JsonObject | null; error: string | null }> {
  if (!forceRefresh) {
    const cached = cacheGet(r2UsageCache);
    if (cached) {
      return cached;
    }
  }

  const accountId = String(env.UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const apiToken = String(env.UK_AQ_R2_CLOUDFLARE_API_TOKEN || env.CFLARE_API_READ_TOKEN || "").trim();
  if (!accountId || !apiToken) {
    const value = {
      usage: null,
      error: "Missing UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_ACCOUNT_ID or UK_AQ_R2_CLOUDFLARE_API_TOKEN/CFLARE_API_READ_TOKEN",
    };
    r2UsageCache = { value, expiresAt: Date.now() + R2_USAGE_TTL_MS };
    return value;
  }

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${apiToken}`);
  headers.set("Content-Type", "application/json");
  try {
    const payload = await fetchJsonObject(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/metrics`,
      { method: "GET", headers },
      "Cloudflare R2 metrics",
    );
    const success = Boolean(payload.success);
    if (!success) {
      throw new Error("Cloudflare R2 metrics reported success=false");
    }
    const result = payload.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Cloudflare R2 metrics missing result payload");
    }
    const standard = (result as JsonObject).standard;
    if (!standard || typeof standard !== "object" || Array.isArray(standard)) {
      throw new Error("Cloudflare R2 metrics missing standard usage payload");
    }
    const published = extractR2UsagePoint((standard as JsonObject).published);
    const uploaded = extractR2UsagePoint((standard as JsonObject).uploaded);
    const selected = published || uploaded;
    if (!selected) {
      throw new Error("Cloudflare R2 metrics missing standard usage values");
    }
    const freeTierGb = 10;
    const freeBytes = freeTierGb * 1024 * 1024 * 1024;
    const classAFree = 1_000_000;
    const classBFree = 10_000_000;
    const usage: JsonObject = {
      standard_used_bytes: Math.max(0, Math.round(selected.used_bytes)),
      standard_used_gb: Math.max(0, selected.used_bytes) / (1024 ** 3),
      standard_objects: Math.max(0, Math.round(selected.object_count)),
      free_tier_gb: freeTierGb,
      percent_of_free_tier: Math.min(100, Math.max(0, (selected.used_bytes / freeBytes) * 100)),
      class_a_used_requests: null,
      class_b_used_requests: null,
      class_a_free_tier_requests: classAFree,
      class_b_free_tier_requests: classBFree,
      class_a_percent_of_free_tier: null,
      class_b_percent_of_free_tier: null,
      class_ops_unclassified_requests: null,
      class_ops_unclassified_action_types: [],
      class_ops_window_start_utc: null,
      class_ops_window_end_utc: null,
      class_ops_error: "R2 class A/B operation analytics are not configured in direct mode.",
      storage_source: "cloudflare_r2_account_metrics",
      source: "cloudflare_r2_account_metrics",
      as_of_utc: nowIso(),
    };
    const value = { usage, error: null };
    r2UsageCache = { value, expiresAt: Date.now() + R2_USAGE_TTL_MS };
    return value;
  } catch (err) {
    const value = { usage: null, error: err instanceof Error ? err.message : String(err) };
    r2UsageCache = { value, expiresAt: Date.now() + R2_USAGE_TTL_MS };
    return value;
  }
}

async function fetchDbMetrics(env: WorkerEnv): Promise<{
  dbRows: unknown[];
  schemaRows: unknown[];
  r2DomainRows: unknown[];
  dbError: string | null;
  schemaError: string | null;
  r2DomainError: string | null;
}> {
  const externalUrl = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  const lookbackDays = Math.max(1, Math.trunc(readNumber(env.UK_AQ_DB_SIZE_LOOKBACK_DAYS, 28)));
  if (externalUrl) {
    const headers = new Headers();
    headers.set("Accept", "application/json");
    const token = String(env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    try {
      const payload = await fetchJsonObject(
        buildUrl(externalUrl, "", { lookback_days: String(lookbackDays) }),
        { method: "GET", headers },
        "DB size API",
      );
      const dbRows = Array.isArray(payload.db_size_metrics) ? payload.db_size_metrics : [];
      const schemaRows = Array.isArray(payload.schema_size_metrics) ? payload.schema_size_metrics : [];
      const r2DomainRows = Array.isArray(payload.r2_domain_size_metrics) ? payload.r2_domain_size_metrics : [];
      return {
        dbRows,
        schemaRows,
        r2DomainRows,
        dbError: typeof payload.db_size_metrics_error === "string" ? payload.db_size_metrics_error : null,
        schemaError: typeof payload.schema_size_metrics_error === "string" ? payload.schema_size_metrics_error : null,
        r2DomainError: typeof payload.r2_domain_size_metrics_error === "string" ? payload.r2_domain_size_metrics_error : null,
      };
    } catch (err) {
      return {
        dbRows: [],
        schemaRows: [],
        r2DomainRows: [],
        dbError: err instanceof Error ? err.message : String(err),
        schemaError: null,
        r2DomainError: null,
      };
    }
  }

  try {
    const restBase = ingestRestBase(env);
    const key = requireServiceKey(env);
    const publicSchema = defaultPublicSchema(env);
    const headers = postgrestHeaders(key, publicSchema);
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const ingestDbRows = await fetchAllRows(
      restBase,
      "uk_aq_db_size_metrics_hourly",
      headers,
      {
        select: "bucket_hour,database_label,database_name,size_bytes,oldest_observed_at,recorded_at",
        bucket_hour: `gte.${toPostgrestTimestamp(new Date(since))}`,
        order: "bucket_hour.asc",
      },
      1000,
    );
    const r2DomainRows = await fetchAllRows(
      restBase,
      "uk_aq_r2_domain_size_metrics_hourly",
      headers,
      {
        select: "bucket_hour,domain_name,size_bytes,recorded_at",
        bucket_hour: `gte.${toPostgrestTimestamp(new Date(since))}`,
        order: "bucket_hour.asc",
      },
      1000,
    );
    let obsDbRows: JsonObject[] = [];
    let obsSchemaRows: JsonObject[] = [];
    let obsError: string | null = null;
    if (String(env.OBS_AQIDB_SUPABASE_URL || "").trim() && String(env.OBS_AQIDB_SECRET_KEY || "").trim()) {
      const obsBase = obsRestBase(env);
      const obsHeaders = postgrestHeaders(requireObsServiceKey(env), publicSchema);
      obsDbRows = await fetchAllRows(
        obsBase,
        "uk_aq_db_size_metrics_hourly",
        obsHeaders,
        {
          select: "bucket_hour,database_label,database_name,size_bytes,oldest_observed_at,recorded_at",
          bucket_hour: `gte.${toPostgrestTimestamp(new Date(since))}`,
          order: "bucket_hour.asc",
        },
        1000,
      );
      obsSchemaRows = await fetchAllRows(
        obsBase,
        "uk_aq_schema_size_metrics_hourly",
        obsHeaders,
        {
          select: "bucket_hour,database_label,schema_name,size_bytes,oldest_observed_at,recorded_at",
          bucket_hour: `gte.${toPostgrestTimestamp(new Date(since))}`,
          order: "bucket_hour.asc",
        },
        1000,
      );
    } else {
      obsError = "OBS_AQIDB_SUPABASE_URL/OBS_AQIDB_SECRET_KEY not configured.";
    }
    return {
      dbRows: [...ingestDbRows, ...obsDbRows],
      schemaRows: obsSchemaRows,
      r2DomainRows,
      dbError: null,
      schemaError: obsError,
      r2DomainError: null,
    };
  } catch (err) {
    return {
      dbRows: [],
      schemaRows: [],
      r2DomainRows: [],
      dbError: err instanceof Error ? err.message : String(err),
      schemaError: null,
      r2DomainError: null,
    };
  }
}

function latestOldestDay(rows: unknown[], selector: (row: JsonObject) => boolean): string | null {
  let latestSample: Date | null = null;
  let latestDay: string | null = null;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const row = raw as JsonObject;
    if (!selector(row)) {
      continue;
    }
    const sample = parseTimestamp(row.recorded_at) || parseTimestamp(row.bucket_hour);
    if (!sample) {
      continue;
    }
    if (!latestSample || sample.getTime() >= latestSample.getTime()) {
      latestSample = sample;
      latestDay = normalizeIsoDay(row.oldest_observed_at);
    }
  }
  return latestDay;
}

function resolveDropboxStatePath(env: WorkerEnv): string {
  const root = String(env.UK_AQ_DROPBOX_ROOT || "CIC-Test").trim().replace(/^\/+|\/+$/g, "");
  const historyDir = String(env.UK_AQ_R2_HISTORY_DROPBOX_DIR || "R2_history_backup").trim().replace(/^\/+|\/+$/g, "");
  const stateRel = String(env.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH || "_ops/checkpoints/r2_history_backup_state_v1.json")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const parts = [root, historyDir, stateRel].filter((part) => part.length > 0);
  if (!parts.length) {
    return "";
  }
  return `/${parts.join("/")}`;
}

async function fetchDropboxAccessToken(env: WorkerEnv): Promise<{ token: string | null; error: string | null }> {
  const appKey = String(env.DROPBOX_APP_KEY || "").trim();
  const appSecret = String(env.DROPBOX_APP_SECRET || "").trim();
  const refreshToken = String(env.DROPBOX_REFRESH_TOKEN || "").trim();
  if (!appKey && !appSecret && !refreshToken) {
    return { token: null, error: null };
  }
  if (!appKey || !appSecret || !refreshToken) {
    return { token: null, error: "Dropbox credentials incomplete (DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN required)." };
  }
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", appKey);
  form.set("client_secret", appSecret);
  try {
    const payload = await fetchJsonObject(
      DROPBOX_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
      "Dropbox token request",
    );
    const token = String(payload.access_token || "").trim();
    if (!token) {
      return { token: null, error: "Dropbox token response missing access_token." };
    }
    return { token, error: null };
  } catch (err) {
    return { token: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchDropboxStateJson(env: WorkerEnv): Promise<{ state: JsonObject | null; path: string | null; error: string | null }> {
  const remotePath = resolveDropboxStatePath(env);
  if (!remotePath) {
    return { state: null, path: null, error: null };
  }
  const { token, error: tokenError } = await fetchDropboxAccessToken(env);
  if (tokenError) {
    return { state: null, path: `dropbox:${remotePath}`, error: tokenError };
  }
  if (!token) {
    return { state: null, path: null, error: null };
  }
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Dropbox-API-Arg", JSON.stringify({ path: remotePath }));
  try {
    const response = await fetch(DROPBOX_DOWNLOAD_URL, {
      method: "POST",
      headers,
    });
    const text = await response.text();
    if (!response.ok) {
      return { state: null, path: `dropbox:${remotePath}`, error: `Dropbox checkpoint download failed (${response.status}): ${text}` };
    }
    const parsed = text ? JSON.parse(text) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: null, path: `dropbox:${remotePath}`, error: "Dropbox checkpoint payload is not a JSON object." };
    }
    return { state: parsed as JsonObject, path: `dropbox:${remotePath}`, error: null };
  } catch (err) {
    return { state: null, path: `dropbox:${remotePath}`, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseDropboxBackupDays(state: JsonObject | null): R2DaySets {
  const sets: R2DaySets = { observations: new Set<string>(), aqilevels: new Set<string>() };
  if (!state) {
    return sets;
  }
  const domains = state.domains;
  if (!domains || typeof domains !== "object" || Array.isArray(domains)) {
    return sets;
  }
  for (const domainName of ["observations", "aqilevels"] as const) {
    const domain = (domains as JsonObject)[domainName];
    if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
      continue;
    }
    const dayMap = (domain as JsonObject).days;
    if (!dayMap || typeof dayMap !== "object" || Array.isArray(dayMap)) {
      continue;
    }
    for (const key of Object.keys(dayMap as JsonObject)) {
      const normalized = normalizeIsoDay(key);
      if (normalized) {
        sets[domainName].add(normalized);
      }
    }
  }
  return sets;
}

function buildStorageCoverageRows(
  dbRows: unknown[],
  schemaRows: unknown[],
  r2Days: R2DaySets | null,
  dropboxDays: R2DaySets,
): unknown[] {
  const ingestOldest = latestOldestDay(
    dbRows,
    (row) => String(row.database_label || "").trim().toLowerCase() === "ingestdb",
  );
  const obsOldest = latestOldestDay(
    dbRows,
    (row) => String(row.database_label || "").trim().toLowerCase() === "obs_aqidb",
  );
  const aqiOldest = latestOldestDay(
    schemaRows,
    (row) => String(row.schema_name || "").trim().toLowerCase() === "uk_aq_aqilevels",
  );
  const dateCandidates: Date[] = [];
  for (const value of [ingestOldest, obsOldest, aqiOldest]) {
    const parsed = parseIsoDay(value);
    if (parsed) {
      dateCandidates.push(parsed);
    }
  }
  for (const day of r2Days?.observations || []) {
    const parsed = parseIsoDay(day);
    if (parsed) {
      dateCandidates.push(parsed);
    }
  }
  for (const day of r2Days?.aqilevels || []) {
    const parsed = parseIsoDay(day);
    if (parsed) {
      dateCandidates.push(parsed);
    }
  }
  for (const day of dropboxDays.observations) {
    const parsed = parseIsoDay(day);
    if (parsed) {
      dateCandidates.push(parsed);
    }
  }
  for (const day of dropboxDays.aqilevels) {
    const parsed = parseIsoDay(day);
    if (parsed) {
      dateCandidates.push(parsed);
    }
  }

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const yesterdayUtc = addUtcDays(todayUtc, -1);
  const defaultStart = addUtcDays(todayUtc, -90);
  const minStart = dateCandidates.length
    ? new Date(Math.min(...dateCandidates.map((item) => item.getTime())))
    : defaultStart;
  const start = minStart.getTime() < defaultStart.getTime() ? minStart : defaultStart;

  const ingestStart = parseIsoDay(ingestOldest);
  const obsStart = parseIsoDay(obsOldest);
  const aqiStart = parseIsoDay(aqiOldest);
  const rows: unknown[] = [];
  for (let cursor = new Date(start.getTime()); cursor.getTime() <= yesterdayUtc.getTime(); cursor = addUtcDays(cursor, 1)) {
    const day = toIsoDay(cursor);
    const r2Observs = Boolean(r2Days?.observations.has(day));
    rows.push({
      date: day,
      ingest: Boolean(ingestStart && cursor.getTime() >= ingestStart.getTime()) && !r2Observs,
      obs_aqi_observs: Boolean(obsStart && cursor.getTime() >= obsStart.getTime()),
      obs_aqi_aqilevels: Boolean(aqiStart && cursor.getTime() >= aqiStart.getTime()),
      r2_observs: r2Observs,
      r2_aqilevels: Boolean(r2Days?.aqilevels.has(day)),
      dropbox_observs: dropboxDays.observations.has(day),
      dropbox_aqilevels: dropboxDays.aqilevels.has(day),
      isToday: false,
    });
  }
  return rows;
}

async function fetchServiceEgressMetrics(env: WorkerEnv): Promise<{ rows: unknown[]; error: string | null }> {
  try {
    const restBase = ingestRestBase(env);
    const key = requireServiceKey(env);
    const rows = await fetchAllRows(
      restBase,
      "uk_aq_endpoint_egress_metrics_24h_dashboard",
      postgrestHeaders(key, defaultPublicSchema(env)),
      {
        select: "bucket_minute,endpoint,method,status_class,observed_requests,estimated_requests,response_bytes_sum,duration_ms_sum",
        order: "bucket_minute.asc",
      },
      1000,
    );
    return { rows, error: null };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchDashboardBaseData(
  env: WorkerEnv,
  options: {
    includeIngestContext: boolean;
    includeMetricContext: boolean;
    includeStorageCoverage: boolean;
    dispatchCursor: Date | null;
    forceRefresh: boolean;
  },
): Promise<DashboardPayload> {
  const now = new Date();
  const ingestBase = ingestRestBase(env);
  const serviceKey = requireServiceKey(env);
  const coreSchema = defaultCoreSchema(env);
  const headersCore = postgrestHeaders(serviceKey, coreSchema);
  const connectorsSettings: unknown[] = [];
  const dispatchRuns: unknown[] = [];
  const connectorMap = new Map<number, { connector_code: string; label: string }>();
  const activeStationMap = new Map<string, boolean>();
  let dispatcherSettings: JsonObject = {
    id: 1,
    dispatcher_parallel_ingest: false,
    max_runs_per_dispatch_call: 1,
    updated_at: null,
  };

  if (options.includeIngestContext) {
    const connectors = await fetchAllRows(
      ingestBase,
      "connectors",
      headersCore,
      {
        select: "id,connector_code,label,display_name,last_run_start,last_run_end,poll_enabled,poll_interval_minutes,poll_window_hours,poll_timeseries_batch_size,scheduler_backend",
        order: "connector_code.asc",
      },
      1000,
    );
    for (const row of connectors) {
      const idValue = Number(row.id);
      if (Number.isFinite(idValue)) {
        connectorMap.set(idValue, {
          connector_code: String(row.connector_code || ""),
          label: String(row.label || ""),
        });
      }
      connectorsSettings.push({
        id: row.id ?? null,
        connector_code: row.connector_code ?? "",
        label: row.label ?? "",
        display_name: row.display_name ?? "",
        poll_enabled: row.poll_enabled ?? null,
        poll_interval_minutes: row.poll_interval_minutes ?? null,
        poll_window_hours: row.poll_window_hours ?? null,
        poll_timeseries_batch_size: row.poll_timeseries_batch_size ?? null,
        scheduler_backend: row.scheduler_backend || "supabase_function",
      });
    }

    const [stations, stationMetadata] = await Promise.all([
      fetchAllRows(
        ingestBase,
        "stations",
        headersCore,
        {
          select: "id,connector_id,service_ref,removed_at",
        },
        1000,
      ),
      fetchAllRows(
        ingestBase,
        "station_metadata",
        headersCore,
        {
          select: "station_id,attributes",
        },
        1000,
      ),
    ]);
    const metadataByStation = new Map<number, JsonObject>();
    for (const row of stationMetadata) {
      const stationId = Number(row.station_id);
      if (!Number.isFinite(stationId)) {
        continue;
      }
      if (row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes)) {
        metadataByStation.set(stationId, row.attributes as JsonObject);
      }
    }
    for (const row of stations) {
      const stationId = Number(row.id);
      const connectorId = Number(row.connector_id);
      if (!Number.isFinite(stationId) || !Number.isFinite(connectorId)) {
        continue;
      }
      const stationKey = `${connectorId}:${stationId}`;
      if (row.removed_at) {
        activeStationMap.set(stationKey, false);
        continue;
      }
      const connectorMeta = connectorMap.get(connectorId);
      const connectorCode = connectorMeta ? connectorMeta.connector_code : "";
      const serviceRef = String(row.service_ref || "");
      if (connectorCode === "breathelondon" && serviceRef === "breathelondon") {
        const attrs = metadataByStation.get(stationId) || {};
        activeStationMap.set(stationKey, asTruthy(attrs.enabled) || asTruthy(attrs.site_active));
      } else {
        activeStationMap.set(stationKey, true);
      }
    }

    const dispatchWindowMinutes = 240;
    const overlapSeconds = 120;
    const fetchLimit = 1000;
    const createdSince = options.dispatchCursor
      ? new Date(options.dispatchCursor.getTime() - overlapSeconds * 1000)
      : new Date(now.getTime() - dispatchWindowMinutes * 60_000);
    const ingestRunsRows = await fetchJsonArray(
      buildUrl(ingestBase, "uk_aq_ingest_runs", {
        select: "id,connector_id,connector_code,run_started_at,run_ended_at,run_status,run_message,last_observed_at,stations_updated,observations_upserted,timeseries_updated,series_polled,response_status,response_payload,created_at",
        order: "created_at.desc.nullslast",
        created_at: `gte.${toPostgrestTimestamp(createdSince)}`,
        limit: String(fetchLimit),
      }),
      { method: "GET", headers: headersCore },
      "ingest runs",
    );
    const latestByConnector = new Map<number, JsonObject>();
    const normalizedRuns: JsonObject[] = [];
    for (const raw of ingestRunsRows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const row = raw as JsonObject;
      const connectorId = Number(row.connector_id);
      const runTs = parseTimestamp(row.run_ended_at) || parseTimestamp(row.run_started_at);
      if (Number.isFinite(connectorId) && runTs) {
        const current = latestByConnector.get(connectorId);
        const currentTs = current ? parseTimestamp(current.run_ended_at) || parseTimestamp(current.run_started_at) : null;
        if (!current || !currentTs || runTs.getTime() > currentTs.getTime()) {
          latestByConnector.set(connectorId, row);
        }
      }
      const connectorMeta = connectorMap.get(connectorId);
      normalizedRuns.push({
        ...row,
        connector_label: connectorMeta?.label || row.connector_code || "",
        run_timestamp: row.run_ended_at || row.run_started_at || null,
        in_flight_minutes: null,
        in_flight_over_threshold: false,
      });
    }

    const inFlightWarnMinutes = 5;
    const inFlightMaxAgeMinutes = 180;
    const inFlightRows: JsonObject[] = [];
    for (const raw of connectorsSettings) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const connector = raw as JsonObject;
      const connectorId = Number(connector.id);
      if (!Number.isFinite(connectorId)) {
        continue;
      }
      const latestRun = latestByConnector.get(connectorId);
      if (latestRun) {
        const startedAt = parseTimestamp(latestRun.run_started_at);
        const endedAt = parseTimestamp(latestRun.run_ended_at);
        if (startedAt && !endedAt) {
          const minutes = Math.max(0, Math.trunc((now.getTime() - startedAt.getTime()) / 60_000));
          inFlightRows.push({
            connector_id: connectorId,
            connector_code: latestRun.connector_code || connector.connector_code || "",
            connector_label: connector.label || latestRun.connector_code || "",
            run_started_at: startedAt.toISOString(),
            run_ended_at: null,
            run_status: "running",
            run_message: "in_flight",
            last_observed_at: null,
            stations_updated: null,
            observations_upserted: null,
            timeseries_updated: null,
            series_polled: null,
            run_timestamp: startedAt.toISOString(),
            in_flight_minutes: minutes,
            in_flight_over_threshold: minutes >= inFlightWarnMinutes,
          });
        }
        continue;
      }
      const lastRunStart = parseTimestamp(connector.last_run_start);
      const lastRunEnd = parseTimestamp(connector.last_run_end);
      if (lastRunStart && !lastRunEnd) {
        const minutes = Math.max(0, Math.trunc((now.getTime() - lastRunStart.getTime()) / 60_000));
        if (minutes <= inFlightMaxAgeMinutes) {
          inFlightRows.push({
            connector_id: connectorId,
            connector_code: connector.connector_code || "",
            connector_label: connector.label || connector.connector_code || "",
            run_started_at: lastRunStart.toISOString(),
            run_ended_at: null,
            run_status: "running",
            run_message: "in_flight",
            last_observed_at: null,
            stations_updated: null,
            observations_upserted: null,
            timeseries_updated: null,
            series_polled: null,
            run_timestamp: lastRunStart.toISOString(),
            in_flight_minutes: minutes,
            in_flight_over_threshold: minutes >= inFlightWarnMinutes,
          });
        }
      }
    }
    const mergedRuns = [...inFlightRows, ...normalizedRuns];
    mergedRuns.sort((a, b) => {
      const aTs = parseTimestamp(a.run_timestamp) || new Date(0);
      const bTs = parseTimestamp(b.run_timestamp) || new Date(0);
      return bTs.getTime() - aTs.getTime();
    });
    dispatchRuns.push(...mergedRuns);

    const dispatcherRows = await fetchJsonArray(
      buildUrl(ingestBase, "dispatcher_settings", {
        select: "id,dispatcher_parallel_ingest,max_runs_per_dispatch_call,updated_at",
        id: "eq.1",
        limit: "1",
      }),
      { method: "GET", headers: headersCore },
      "dispatcher settings",
    );
    const row = dispatcherRows.find((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item));
    if (row) {
      dispatcherSettings = {
        id: row.id ?? 1,
        dispatcher_parallel_ingest: Boolean(row.dispatcher_parallel_ingest),
        max_runs_per_dispatch_call: row.max_runs_per_dispatch_call || 1,
        updated_at: row.updated_at || null,
      };
    }
  }

  const pollutantsPayload: unknown[] = [];
  if (options.includeIngestContext) {
    const timeseriesRows = await fetchAllRows(
      ingestBase,
      "timeseries",
      headersCore,
      {
        select: "station_id,connector_id,last_value,last_value_at,label,phenomenon:phenomena(label,notation,pollutant_label)",
        last_value_at: "not.is.null",
        last_value: "not.is.null",
      },
      1000,
    );
    const latestByPollutant: Record<string, Map<string, Date>> = {};
    const activeByPollutant: Record<string, Set<string>> = {};
    for (const key of Object.keys(POLLUTANTS)) {
      latestByPollutant[key] = new Map<string, Date>();
      activeByPollutant[key] = new Set<string>();
    }
    for (const row of timeseriesRows) {
      const stationId = Number(row.station_id);
      const connectorId = Number(row.connector_id);
      if (!Number.isFinite(stationId) || !Number.isFinite(connectorId)) {
        continue;
      }
      const lastValueAt = parseTimestamp(row.last_value_at);
      if (!lastValueAt) {
        continue;
      }
      const pollutantKey = pickPollutantKey(row);
      if (!pollutantKey || !latestByPollutant[pollutantKey]) {
        continue;
      }
      const stationKey = `${connectorId}:${stationId}`;
      const current = latestByPollutant[pollutantKey].get(stationKey);
      if (!current || lastValueAt.getTime() > current.getTime()) {
        latestByPollutant[pollutantKey].set(stationKey, lastValueAt);
      }
      if (activeStationMap.get(stationKey)) {
        activeByPollutant[pollutantKey].add(stationKey);
      }
    }

    for (const [pollutantKey, config] of Object.entries(POLLUTANTS)) {
      const connectorCounts = new Map<number, JsonObject>();
      const excluded = EXCLUDED_CONNECTORS_BY_POLLUTANT[pollutantKey] || new Set<string>();
      for (const [connectorId, meta] of connectorMap.entries()) {
        if (excluded.has(meta.connector_code)) {
          continue;
        }
        connectorCounts.set(connectorId, {
          connector_code: meta.connector_code,
          label: meta.label,
          stations_with_pollutant: 0,
          active_stations_with_pollutant: 0,
          buckets: Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])),
        });
      }
      for (const [stationKey, latestAt] of latestByPollutant[pollutantKey].entries()) {
        const [connectorPart] = stationKey.split(":");
        const connectorId = Number(connectorPart);
        if (!Number.isFinite(connectorId)) {
          continue;
        }
        const meta = connectorMap.get(connectorId);
        if (meta && excluded.has(meta.connector_code)) {
          continue;
        }
        if (!connectorCounts.has(connectorId)) {
          connectorCounts.set(connectorId, {
            connector_code: meta?.connector_code || "",
            label: meta?.label || "",
            stations_with_pollutant: 0,
            active_stations_with_pollutant: 0,
            buckets: Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])),
          });
        }
        const row = connectorCounts.get(connectorId);
        if (!row) {
          continue;
        }
        row.stations_with_pollutant = Number(row.stations_with_pollutant || 0) + 1;
        const bucket = bucketFor(latestAt, now);
        const buckets = row.buckets as JsonObject;
        buckets[bucket] = Number(buckets[bucket] || 0) + 1;
        if (activeByPollutant[pollutantKey].has(stationKey)) {
          row.active_stations_with_pollutant = Number(row.active_stations_with_pollutant || 0) + 1;
        }
      }
      const connectors = Array.from(connectorCounts.values()).sort((a, b) =>
        String(a.connector_code || "").localeCompare(String(b.connector_code || "")),
      );
      pollutantsPayload.push({
        key: pollutantKey,
        label: config.label,
        connectors,
      });
    }
  }

  let db_size_metrics: unknown[] = [];
  let schema_size_metrics: unknown[] = [];
  let r2_domain_size_metrics: unknown[] = [];
  let db_size_metrics_error: string | null = null;
  let schema_size_metrics_error: string | null = null;
  let r2_domain_size_metrics_error: string | null = null;
  let r2_usage: JsonObject | null = null;
  let r2_usage_error: string | null = null;
  let service_egress_metrics: unknown[] = [];
  let service_egress_metrics_error: string | null = null;
  let r2_backup_window: JsonObject | null = null;
  let r2_backup_window_error: string | null = null;
  let r2_history_days_bucket: string | null = null;
  let r2_history_days_error: string | null = null;
  let dropbox_backup_state_path: string | null = null;
  let dropbox_backup_state_error: string | null = null;
  let storage_coverage_days: unknown[] = [];

  if (options.includeMetricContext || options.includeStorageCoverage) {
    const [dbMetrics, r2Usage, r2History, egress, dropboxState] = await Promise.all([
      fetchDbMetrics(env),
      fetchR2Usage(env, options.forceRefresh),
      fetchR2HistoryDays(env, options.forceRefresh),
      fetchServiceEgressMetrics(env),
      fetchDropboxStateJson(env),
    ]);
    db_size_metrics = dbMetrics.dbRows;
    schema_size_metrics = dbMetrics.schemaRows;
    r2_domain_size_metrics = dbMetrics.r2DomainRows;
    db_size_metrics_error = dbMetrics.dbError;
    schema_size_metrics_error = dbMetrics.schemaError;
    r2_domain_size_metrics_error = dbMetrics.r2DomainError;
    r2_usage = r2Usage.usage;
    r2_usage_error = r2Usage.error;
    service_egress_metrics = egress.rows;
    service_egress_metrics_error = egress.error;
    r2_history_days_bucket = r2History.bucket;
    r2_history_days_error = r2History.error;
    r2_backup_window = r2History.window;
    dropbox_backup_state_path = dropboxState.path;
    dropbox_backup_state_error = dropboxState.error;
    if (!r2_backup_window) {
      const fallbackWindow = await fetchR2BackupWindowFromSupabase(env);
      r2_backup_window = fallbackWindow.window;
      r2_backup_window_error = fallbackWindow.error;
      if (r2_history_days_error) {
        r2_backup_window_error = r2_backup_window_error
          ? `${r2_history_days_error}; ${r2_backup_window_error}`
          : r2_history_days_error;
      }
    }
    if (options.includeStorageCoverage) {
      const dropboxDays = parseDropboxBackupDays(dropboxState.state);
      storage_coverage_days = buildStorageCoverageRows(
        dbMetrics.dbRows,
        dbMetrics.schemaRows,
        r2History.daySets,
        dropboxDays,
      );
    }
  }

  let dispatchCursorValue: string | null = null;
  for (const row of dispatchRuns) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const createdAt = parseTimestamp((row as JsonObject).created_at);
    if (!createdAt) {
      continue;
    }
    const iso = createdAt.toISOString().replace(/\.\d{3}Z$/, "Z");
    if (!dispatchCursorValue || iso > dispatchCursorValue) {
      dispatchCursorValue = iso;
    }
  }

  return {
    project_ref: extractProjectRef(String(env.SUPABASE_URL || "")),
    obs_aqidb_project_ref: extractProjectRef(String(env.OBS_AQIDB_SUPABASE_URL || "")),
    generated_at: now.toISOString(),
    dispatch_cursor: dispatchCursorValue,
    buckets: [...BUCKETS],
    db_size_metrics,
    schema_size_metrics,
    r2_domain_size_metrics,
    db_size_metrics_error,
    schema_size_metrics_error,
    r2_domain_size_metrics_error,
    r2_usage,
    r2_usage_error,
    service_egress_metrics,
    service_egress_metrics_error,
    r2_backup_window,
    r2_backup_window_error,
    r2_history_days_bucket,
    r2_history_days_error,
    dropbox_backup_state_path,
    dropbox_backup_state_error,
    storage_coverage_source: "live_per_day_presence",
    storage_coverage_days,
    pollutants: pollutantsPayload,
    dispatch_runs: dispatchRuns,
    dispatcher_settings: dispatcherSettings,
    connectors_settings: connectorsSettings,
  };
}

function dashboardCacheKey(search: URLSearchParams): string {
  const includeStorage = asBoolFlag(search.get("include_storage_coverage"), true) ? "1" : "0";
  const includeMetric = asBoolFlag(search.get("include_metric_context"), true) ? "1" : "0";
  const includeIngest = asBoolFlag(search.get("include_ingest_context"), true) ? "1" : "0";
  const cursor = String(search.get("dispatch_cursor") || "").trim();
  return `storage=${includeStorage}|metric=${includeMetric}|ingest=${includeIngest}|cursor=${cursor}`;
}

export async function getDirectDashboardPayload(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<DashboardPayload> {
  const forceRefresh = asTruthy(search.get("force"));
  const cacheKey = dashboardCacheKey(search);
  if (!forceRefresh) {
    const cached = dashboardCache.get(cacheKey);
    if (cached && Date.now() <= cached.expiresAt) {
      return cached.value;
    }
  }

  const dispatchCursorRaw = String(search.get("dispatch_cursor") || "").trim();
  const dispatchCursor = parseTimestamp(dispatchCursorRaw);
  const payload = await fetchDashboardBaseData(env, {
    includeStorageCoverage: asBoolFlag(search.get("include_storage_coverage"), true),
    includeMetricContext: asBoolFlag(search.get("include_metric_context"), true),
    includeIngestContext: asBoolFlag(search.get("include_ingest_context"), true),
    dispatchCursor,
    forceRefresh,
  });
  dashboardCache.set(cacheKey, { value: payload, expiresAt: Date.now() + DASHBOARD_TTL_MS });
  return payload;
}

export async function getDirectStorageCoveragePayload(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<{ generated_at: string; storage_coverage_source: string; storage_coverage_days: unknown[] }> {
  const forceRefresh = asTruthy(search.get("force"));
  if (!forceRefresh) {
    const cached = cacheGet(storageCoverageCache);
    if (cached) {
      return cached;
    }
  }
  const payload = await fetchDashboardBaseData(env, {
    includeStorageCoverage: true,
    includeMetricContext: true,
    includeIngestContext: false,
    dispatchCursor: null,
    forceRefresh,
  });
  const response = {
    generated_at: nowIso(),
    storage_coverage_source: payload.storage_coverage_source,
    storage_coverage_days: Array.isArray(payload.storage_coverage_days) ? payload.storage_coverage_days : [],
  };
  storageCoverageCache = { value: response, expiresAt: Date.now() + STORAGE_COVERAGE_TTL_MS };
  return response;
}

export async function getDirectR2MetricsPayload(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<JsonObject> {
  const forceRefresh = asTruthy(search.get("force"));
  const [r2Usage, r2History, fallbackWindow] = await Promise.all([
    fetchR2Usage(env, forceRefresh),
    fetchR2HistoryDays(env, forceRefresh),
    fetchR2BackupWindowFromSupabase(env),
  ]);
  const window = r2History.window || fallbackWindow.window;
  let windowError: string | null = fallbackWindow.error;
  if (r2History.error) {
    windowError = windowError ? `${r2History.error}; ${windowError}` : r2History.error;
  }
  return {
    r2_usage: r2Usage.usage,
    r2_usage_error: r2Usage.error,
    r2_backup_window: window,
    r2_backup_window_error: windowError,
    r2_history_days_bucket: r2History.bucket,
    r2_history_days_error: r2History.error,
    generated_at: nowIso(),
  };
}

export async function getDirectR2ConnectorCountsPayload(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<JsonObject> {
  const apiUrl = resolveR2HistoryCountsApiUrl(env);
  if (!apiUrl) {
    throw new Error("R2 history-counts API not configured.");
  }
  const headers = new Headers();
  headers.set("Accept", "application/json");
  const token = resolveR2HistoryCountsApiToken(env);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const params: Record<string, string> = {};
  for (const key of ["from_day", "to_day", "grain", "connector_ids"] as const) {
    const value = String(search.get(key) || "").trim();
    if (value) {
      params[key] = value;
    }
  }
  return fetchJsonObject(appendQueryParams(apiUrl, params), { method: "GET", headers }, "R2 history-counts API");
}

export async function getDirectDailyTaskRunsPayload(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<JsonObject> {
  const mode = String(search.get("mode") || "latest").trim().toLowerCase();
  if (!["latest", "all"].includes(mode)) {
    throw new Error("mode must be latest or all");
  }
  const day = normalizeIsoDay(search.get("day")) || toIsoDay(new Date());
  const restBase = obsRestBase(env);
  const key = requireObsServiceKey(env);
  const rows = await fetchJsonArray(
    buildUrl(restBase, "daily_task_runs_dashboard", {
      select: "run_id,task_key,task_name,platform,source,scheduled_for_date,scheduled_time_utc,scheduled_at_utc,attempt,raw_status,started_at,finished_at,failed_at,updated_at,duration_seconds,summary,error_message,log_url,effective_status,scheduled_or_started_at,finished_or_failed_at,is_failed,is_overdue,is_not_started,task_day_rank",
      scheduled_for_date: `eq.${day}`,
      order: "updated_at.desc.nullslast,run_id.desc",
      limit: "500",
      ...(mode === "latest" ? { task_day_rank: "eq.1" } : {}),
    }),
    {
      method: "GET",
      headers: postgrestHeaders(key, defaultOpsSchema(env)),
    },
    "daily_task_runs_dashboard",
  );
  return {
    day,
    mode,
    rows,
    generated_at: nowIso(),
  };
}

export async function getDirectDropboxMtimePayload(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<JsonObject> {
  const forceRefresh = asTruthy(search.get("force"));
  if (!forceRefresh) {
    const cached = cacheGet(dropboxMtimeCache);
    if (cached) {
      return {
        ...cached.payload,
        error: cached.error,
      };
    }
  }
  const remotePath = resolveDropboxStatePath(env);
  const resolvedHistoryPath = remotePath.replace(/\/_ops\/checkpoints\/r2_history_backup_state_v1\.json$/i, "").replace(/\/[^/]+$/, "");
  const { token, error: tokenError } = await fetchDropboxAccessToken(env);
  if (tokenError) {
    const payload = {
      generated_at: nowIso(),
      resolved_history_path: resolvedHistoryPath || null,
      latest_mtime_utc: null,
      latest_entry_path: null,
    };
    dropboxMtimeCache = { value: { payload, error: tokenError }, expiresAt: Date.now() + DROPBOX_MTIME_TTL_MS };
    return { ...payload, error: tokenError };
  }
  if (!token || !remotePath) {
    const payload = {
      generated_at: nowIso(),
      resolved_history_path: resolvedHistoryPath || null,
      latest_mtime_utc: null,
      latest_entry_path: null,
    };
    dropboxMtimeCache = { value: { payload, error: null }, expiresAt: Date.now() + DROPBOX_MTIME_TTL_MS };
    return { ...payload, error: null };
  }
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  try {
    const payload = await fetchJsonObject(
      DROPBOX_GET_METADATA_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ path: remotePath }),
      },
      "Dropbox metadata",
    );
    const latestMtime = payload.server_modified ? String(payload.server_modified) : null;
    const response: JsonObject = {
      generated_at: nowIso(),
      resolved_history_path: resolvedHistoryPath || null,
      latest_mtime_utc: latestMtime,
      latest_entry_path: `dropbox:${remotePath}`,
    };
    dropboxMtimeCache = { value: { payload: response, error: null }, expiresAt: Date.now() + DROPBOX_MTIME_TTL_MS };
    return { ...response, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const payload = {
      generated_at: nowIso(),
      resolved_history_path: resolvedHistoryPath || null,
      latest_mtime_utc: null,
      latest_entry_path: `dropbox:${remotePath}`,
    };
    dropboxMtimeCache = { value: { payload, error }, expiresAt: Date.now() + DROPBOX_MTIME_TTL_MS };
    return { ...payload, error };
  }
}

export async function getDirectConfigPayload(env: WorkerEnv): Promise<JsonObject> {
  const base = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const rpc = "uk_aq_station_snapshot";
  let defaultObsLimit = "all";
  if (!["all", "100", "1000", "5000", "10000"].includes(defaultObsLimit)) {
    defaultObsLimit = "all";
  }
  return {
    edge_url: base ? `${base}/rest/v1/rpc/${rpc}` : null,
    default_station_id: String(env.CLEANAIRSURB_ST_ID || "").trim(),
    snapshot_mode: "service_role_postgrest_rpc",
    has_obs_aqidb: Boolean(String(env.OBS_AQIDB_SUPABASE_URL || "").trim() && String(env.OBS_AQIDB_SECRET_KEY || "").trim()),
    default_obs_limit: defaultObsLimit,
  };
}

function parseSnapshotObsLimit(rawValue: string): number | null {
  const value = rawValue.trim().toLowerCase();
  if (!value || value === "all") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("obs_limit must be a positive integer or 'all'.");
  }
  return Math.trunc(parsed);
}

export async function getDirectSnapshotPayload(env: WorkerEnv, search: URLSearchParams): Promise<JsonObject> {
  const restBase = ingestRestBase(env);
  const key = requireServiceKey(env);
  const stationIdRaw = String(search.get("station_id") || "").trim();
  const stationRefRaw = String(search.get("station_ref") || "").trim();
  const timeseriesIdRaw = String(search.get("timeseries_id") || "").trim();
  const window = String(search.get("window") || "24h").trim() || "24h";
  const obsLimitRaw = String(search.get("obs_limit") || "all").trim();

  const stationId = stationIdRaw ? Number(stationIdRaw) : null;
  const timeseriesId = timeseriesIdRaw ? Number(timeseriesIdRaw) : null;
  if ((!stationId || !Number.isFinite(stationId)) && !stationRefRaw) {
    throw new Error("station_id or station_ref is required.");
  }
  if (stationIdRaw && !Number.isFinite(stationId || Number.NaN)) {
    throw new Error("station_id must be numeric.");
  }
  if (timeseriesIdRaw && !Number.isFinite(timeseriesId || Number.NaN)) {
    throw new Error("timeseries_id must be numeric.");
  }
  const obsLimit = parseSnapshotObsLimit(obsLimitRaw);
  const rpc = "uk_aq_station_snapshot";

  const rows = await fetchJsonArray(
    buildUrl(restBase, `rpc/${rpc}`),
    {
      method: "POST",
      headers: (() => {
        const headers = postgrestHeaders(key, defaultPublicSchema(env), true);
        headers.set("Content-Type", "application/json");
        return headers;
      })(),
      body: JSON.stringify({
        p_station_id: Number.isFinite(stationId || Number.NaN) ? stationId : null,
        p_station_ref: stationRefRaw || null,
        p_timeseries_id: Number.isFinite(timeseriesId || Number.NaN) ? timeseriesId : null,
        p_window: window,
        p_obs_limit: obsLimit,
      }),
    },
    "station snapshot RPC",
  );
  const payload = rows[0];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Station not found.", station: null };
  }
  const response = payload as JsonObject;
  const observations = Array.isArray(response.observations) ? response.observations : [];
  response.observations = observations;
  response.observations_all = Array.isArray(response.observations_all) ? response.observations_all : [...observations];
  response.obs_aqidb_observations = Array.isArray(response.obs_aqidb_observations) ? response.obs_aqidb_observations : [];
  response.obs_aqidb_observations_all = Array.isArray(response.obs_aqidb_observations_all) ? response.obs_aqidb_observations_all : [];
  response.obs_aqidb_timeseries_aqi_hourly = Array.isArray(response.obs_aqidb_timeseries_aqi_hourly) ? response.obs_aqidb_timeseries_aqi_hourly : [];
  response.obs_aqidb_timeseries_aqi_daily = Array.isArray(response.obs_aqidb_timeseries_aqi_daily) ? response.obs_aqidb_timeseries_aqi_daily : [];
  return response;
}

export async function updateDirectConnectors(env: WorkerEnv, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as JsonObject;
  const updatesRaw = body.updates;
  if (!Array.isArray(updatesRaw)) {
    return errorEnvelope("BAD_REQUEST", "Invalid payload: updates[] is required.", 400);
  }
  const restBase = ingestRestBase(env);
  const key = requireServiceKey(env);
  const headers = postgrestHeaders(key, defaultCoreSchema(env), true);
  headers.set("Content-Type", "application/json");
  headers.set("Prefer", "return=minimal");
  for (const item of updatesRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as JsonObject;
    const idValue = Number(row.id);
    if (!Number.isFinite(idValue)) {
      continue;
    }
    const payload: JsonObject = {
      poll_enabled: row.poll_enabled ?? null,
      poll_interval_minutes: row.poll_interval_minutes ?? null,
      poll_window_hours: row.poll_window_hours ?? null,
      poll_timeseries_batch_size: row.poll_timeseries_batch_size ?? null,
      scheduler_backend: row.scheduler_backend || "supabase_function",
    };
    const response = await fetch(
      buildUrl(restBase, "connectors", { id: `eq.${Math.trunc(idValue)}` }),
      {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      return errorEnvelope(
        "UPSTREAM_HTTP_ERROR",
        `Failed to update connector ${Math.trunc(idValue)} (${response.status}): ${detail}`,
        502,
      );
    }
  }
  dashboardCache.clear();
  return buildJsonResponse({ status: "ok" }, 200, "no-store");
}

export async function updateDirectDispatcherSettings(env: WorkerEnv, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as JsonObject;
  const parallel = Boolean(body.dispatcher_parallel_ingest);
  let maxRuns = Number(body.max_runs_per_dispatch_call);
  if (!Number.isFinite(maxRuns) || maxRuns < 1) {
    maxRuns = 1;
  }
  const restBase = ingestRestBase(env);
  const key = requireServiceKey(env);
  const headers = postgrestHeaders(key, defaultCoreSchema(env), true);
  headers.set("Content-Type", "application/json");
  headers.set("Prefer", "return=minimal");
  const response = await fetch(
    buildUrl(restBase, "dispatcher_settings", { id: "eq.1" }),
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        dispatcher_parallel_ingest: parallel,
        max_runs_per_dispatch_call: Math.trunc(maxRuns),
        updated_at: nowIso(),
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    return errorEnvelope("UPSTREAM_HTTP_ERROR", `Failed to update dispatcher settings (${response.status}): ${detail}`, 502);
  }
  dashboardCache.clear();
  return buildJsonResponse({ status: "ok" }, 200, "no-store");
}

export async function handleDirectCompatRoute(
  request: Request,
  env: WorkerEnv,
  pathname: string,
): Promise<Response> {
  const search = new URL(request.url).searchParams;
  try {
    if (pathname === "/api/dashboard") {
      const payload = await getDirectDashboardPayload(env, search);
      return buildJsonResponse(payload, 200, "no-store");
    }
    if (pathname === "/api/storage_coverage") {
      const payload = await getDirectStorageCoveragePayload(env, search);
      return buildJsonResponse(payload, 200, "no-store");
    }
    if (pathname === "/api/r2_metrics") {
      const payload = await getDirectR2MetricsPayload(env, search);
      return buildJsonResponse(payload, 200, "no-store");
    }
    if (pathname === "/api/r2_connector_counts") {
      const payload = await getDirectR2ConnectorCountsPayload(env, search);
      return buildJsonResponse(payload, 200, "no-store");
    }
    if (pathname === "/api/operations_dropbox_mtime") {
      const payload = await getDirectDropboxMtimePayload(env, search);
      return buildJsonResponse(payload, 200, "no-store");
    }
    if (pathname === "/api/daily_task_runs") {
      const payload = await getDirectDailyTaskRunsPayload(env, search);
      return buildJsonResponse(payload, 200, "no-store");
    }
    if (pathname === "/api/config") {
      const payload = await getDirectConfigPayload(env);
      return buildJsonResponse(payload, 200, "no-store");
    }
    if (pathname === "/api/snapshot") {
      const payload = await getDirectSnapshotPayload(env, search);
      const status = payload.station === null ? 404 : 200;
      return buildJsonResponse(payload, status, "no-store");
    }
    if (pathname === "/api/connectors") {
      return updateDirectConnectors(env, request);
    }
    if (pathname === "/api/dispatcher_settings") {
      return updateDirectDispatcherSettings(env, request);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorEnvelope("DIRECT_BACKEND_ERROR", message, 500);
  }
  return errorEnvelope("NOT_FOUND", "Route not found", 404);
}
