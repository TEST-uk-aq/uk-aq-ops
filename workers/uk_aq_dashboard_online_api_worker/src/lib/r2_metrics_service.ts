import { errorEnvelope } from "./http";
import type { WorkerEnv } from "./upstream";

type JsonObject = Record<string, unknown>;
type DaySets = {
  observations: Set<string>;
  aqilevels: Set<string>;
};
type ServiceFetcher = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};
type MetricsEnv = WorkerEnv & {
  R2_METRICS_API?: ServiceFetcher;
};
type SourceSnapshot = {
  generatedAt: string;
  r2Days: DaySets | null;
  r2Bucket: string | null;
  r2Error: string | null;
  backupDays: DaySets | null;
  backupKey: string | null;
  backupError: string | null;
  ingestOldestDay: string | null;
  ingestError: string | null;
  dbPayload: JsonObject | null;
};
type CacheEntry = {
  key: string;
  expiresAt: number;
  value: SourceSnapshot;
};

const INTERNAL_ORIGIN = "https://r2-metrics.internal";
const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let sourceCache: CacheEntry | null = null;

function normaliseDay(value: unknown): string | null {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match && DAY_RE.test(match[1]) ? match[1] : null;
}

function shouldForceRefresh(request: Request): boolean {
  const params = new URL(request.url).searchParams;
  for (const key of ["force", "refresh", "nocache", "cache_bust", "cacheBust", "t", "ts"]) {
    const value = String(params.get(key) || "").trim().toLowerCase();
    if (!value) continue;
    if (["1", "true", "yes"].includes(value) || key === "t" || key === "ts") return true;
  }
  return false;
}

function resolveOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch (_error) {
    return "";
  }
}

function resolveExternalUrl(env: WorkerEnv, pathname: string): string {
  if (pathname === "/v1/db-size-metrics") {
    return String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  }
  if (pathname === "/v1/r2-history-days") {
    const explicit = String(env.UK_AQ_R2_HISTORY_DAYS_API_URL || "").trim();
    if (explicit) return explicit;
  }
  if (pathname === "/v1/r2-history-counts") {
    const explicit = String(env.UK_AQ_R2_HISTORY_COUNTS_API_URL || "").trim();
    if (explicit) return explicit;
  }
  const dbSizeUrl = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  const origin = dbSizeUrl ? resolveOrigin(dbSizeUrl) : "";
  return origin ? `${origin}${pathname}` : "";
}

function resolveToken(env: WorkerEnv, pathname: string): string {
  if (pathname === "/v1/r2-history-days") {
    return String(env.UK_AQ_R2_HISTORY_DAYS_API_TOKEN || env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
  }
  if (pathname === "/v1/r2-history-counts") {
    return String(
      env.UK_AQ_R2_HISTORY_COUNTS_API_TOKEN ||
      env.UK_AQ_R2_HISTORY_DAYS_API_TOKEN ||
      env.UK_AQ_DB_SIZE_API_TOKEN ||
      "",
    ).trim();
  }
  return String(env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
}

async function fetchMetrics(
  env: MetricsEnv,
  pathname: string,
  params: URLSearchParams,
): Promise<Response> {
  const headers = new Headers({ Accept: "application/json" });
  const token = resolveToken(env, pathname);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  if (env.R2_METRICS_API) {
    const url = new URL(pathname, INTERNAL_ORIGIN);
    url.search = params.toString();
    return env.R2_METRICS_API.fetch(new Request(url.toString(), { method: "GET", headers }));
  }

  const externalUrl = resolveExternalUrl(env, pathname);
  if (!externalUrl) {
    throw new Error(`No service binding or external URL configured for ${pathname}`);
  }
  const url = new URL(externalUrl);
  params.forEach((value, key) => {
    url.searchParams.set(key, value);
  });
  return fetch(url.toString(), { method: "GET", headers });
}

async function fetchMetricsJson(
  env: MetricsEnv,
  pathname: string,
  params: URLSearchParams,
): Promise<JsonObject> {
  const response = await fetchMetrics(env, pathname, params);
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && !Array.isArray(payload)
      ? JSON.stringify(payload)
      : text.slice(0, 500);
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Response is not a JSON object");
  }
  return payload as JsonObject;
}

function parseDomainDays(payload: unknown): DaySets {
  const sets: DaySets = {
    observations: new Set<string>(),
    aqilevels: new Set<string>(),
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return sets;
  for (const domain of ["observations", "aqilevels"] as const) {
    const domainPayload = (payload as JsonObject)[domain];
    if (!domainPayload || typeof domainPayload !== "object" || Array.isArray(domainPayload)) continue;
    const values = (domainPayload as JsonObject).days;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const day = normaliseDay(value);
      if (day) sets[domain].add(day);
    }
  }
  return sets;
}

function latestIngestOldestDay(rows: unknown[]): string | null {
  let latestSampleMs = Number.NEGATIVE_INFINITY;
  let oldestDay: string | null = null;
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as JsonObject;
    const label = String(row.database_label || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (label !== "ingestdb") continue;
    const sampleText = String(row.recorded_at || row.bucket_hour || "").trim();
    const sampleMs = Date.parse(sampleText);
    const candidate = normaliseDay(row.oldest_observed_at);
    if (!Number.isFinite(sampleMs) || !candidate || sampleMs < latestSampleMs) continue;
    latestSampleMs = sampleMs;
    oldestDay = candidate;
  }
  return oldestDay;
}

function mergeMessages(...values: unknown[]): string | null {
  const messages: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const message = String(value || "").trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    messages.push(message);
  }
  return messages.length ? messages.join("; ") : null;
}

function dayBounds(days: Set<string> | null): { earliest: string | null; latest: string | null } {
  const values = days ? Array.from(days).sort() : [];
  return {
    earliest: values[0] || null,
    latest: values[values.length - 1] || null,
  };
}

async function loadSources(request: Request, env: MetricsEnv): Promise<SourceSnapshot> {
  const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  const bindingKey = env.R2_METRICS_API ? "service" : resolveOrigin(String(env.UK_AQ_DB_SIZE_API_URL || ""));
  const cacheKey = `${bindingKey}|${version}`;
  if (!shouldForceRefresh(request) && sourceCache && sourceCache.key === cacheKey && Date.now() < sourceCache.expiresAt) {
    return sourceCache.value;
  }

  const generatedAt = new Date().toISOString();
  const historyParams = new URLSearchParams();
  historyParams.set("read_version", version);
  historyParams.set("max_days", "3660");
  const dbParams = new URLSearchParams();
  const lookback = Math.max(1, Math.trunc(Number(env.UK_AQ_DB_SIZE_LOOKBACK_DAYS || 28) || 28));
  dbParams.set("lookback_days", String(lookback));

  const [historyResult, dbResult] = await Promise.allSettled([
    version === "v1" || version === "v2"
      ? fetchMetricsJson(env, "/v1/r2-history-days", historyParams)
      : Promise.reject(new Error("UK_AQ_R2_HISTORY_VERSION must be v1 or v2")),
    fetchMetricsJson(env, "/v1/db-size-metrics", dbParams),
  ]);

  let r2Days: DaySets | null = null;
  let r2Bucket: string | null = null;
  let r2Error: string | null = null;
  let backupDays: DaySets | null = null;
  let backupKey: string | null = null;
  let backupError: string | null = null;
  let ingestOldestDay: string | null = null;
  let ingestError: string | null = null;
  let dbPayload: JsonObject | null = null;

  if (historyResult.status === "fulfilled") {
    const payload = historyResult.value;
    r2Bucket = String(payload.bucket || "").trim() || null;
    r2Days = parseDomainDays(payload.domains);
    const inventory = payload.backup_inventory;
    if (inventory && typeof inventory === "object" && !Array.isArray(inventory)) {
      const inventoryObject = inventory as JsonObject;
      backupKey = String(inventoryObject.key || "").trim() || null;
      backupError = String(inventoryObject.error || "").trim() || null;
      if (!backupError) backupDays = parseDomainDays(inventoryObject.domains);
    } else {
      backupError = "R2 history-days response does not include active backup inventory data";
    }
  } else {
    r2Error = historyResult.reason instanceof Error ? historyResult.reason.message : String(historyResult.reason);
    backupError = r2Error;
  }

  if (dbResult.status === "fulfilled") {
    dbPayload = dbResult.value;
    const rows = Array.isArray(dbPayload.db_size_metrics) ? dbPayload.db_size_metrics : [];
    ingestOldestDay = latestIngestOldestDay(rows);
    if (!ingestOldestDay) ingestError = "DB size metrics contain no usable IngestDB retention boundary";
  } else {
    ingestError = dbResult.reason instanceof Error ? dbResult.reason.message : String(dbResult.reason);
  }

  const value: SourceSnapshot = {
    generatedAt,
    r2Days,
    r2Bucket,
    r2Error,
    backupDays,
    backupKey,
    backupError,
    ingestOldestDay,
    ingestError,
    dbPayload,
  };
  sourceCache = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, value };
  return value;
}

export async function proxyR2ConnectorCounts(
  request: Request,
  env: MetricsEnv,
): Promise<Response | null> {
  if (!env.R2_METRICS_API) return null;
  try {
    const incoming = new URL(request.url);
    const params = new URLSearchParams(incoming.search);
    if (!params.get("read_version")) {
      const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
      if (version === "v1" || version === "v2") params.set("read_version", version);
    }
    const response = await fetchMetrics(env, "/v1/r2-history-counts", params);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return errorEnvelope("R2_METRICS_SERVICE_ERROR", detail, 502);
  }
}

export async function enrichStorageCoverageFromMetrics(
  response: Response,
  request: Request,
  env: MetricsEnv,
): Promise<Response> {
  if (!response.ok) return response;
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch (_error) {
    return response;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response;
  const object = payload as JsonObject;
  if (!Array.isArray(object.storage_coverage_days)) return response;

  const sources = await loadSources(request, env);
  const rows = object.storage_coverage_days.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = { ...(value as JsonObject) };
    const day = normaliseDay(row.date);
    if (!day) return row;
    if (sources.ingestOldestDay) row.ingest = day >= sources.ingestOldestDay;
    if (sources.r2Days) {
      const observationsPresent = sources.r2Days.observations.has(day);
      row.r2_observs = observationsPresent;
      row.r2 = observationsPresent;
      row.r2_aqilevels = sources.r2Days.aqilevels.has(day);
    }
    if (sources.backupDays) {
      row.dropbox_observs = sources.backupDays.observations.has(day);
      row.dropbox_aqilevels = sources.backupDays.aqilevels.has(day);
    }
    return row;
  });

  const backupObservations = dayBounds(sources.backupDays?.observations || null);
  const backupAqilevels = dayBounds(sources.backupDays?.aqilevels || null);
  const enriched: JsonObject = {
    ...object,
    storage_coverage_days: rows,
    storage_coverage_source: `${String(object.storage_coverage_source || "dashboard")}+metrics_service_binding`,
    r2_history_days_bucket: sources.r2Bucket || object.r2_history_days_bucket || null,
    r2_history_days_error: mergeMessages(object.r2_history_days_error, sources.r2Error),
    dropbox_backup_state_path: sources.backupKey ? `r2:${sources.backupKey}` : object.dropbox_backup_state_path || null,
    dropbox_backup_state_source: sources.backupDays ? "r2-backup-inventory" : object.dropbox_backup_state_source || null,
    dropbox_backup_state_error: sources.backupDays
      ? null
      : mergeMessages(object.dropbox_backup_state_error, sources.backupError),
    dropbox_backup_observations_earliest_day: sources.backupDays
      ? backupObservations.earliest
      : object.dropbox_backup_observations_earliest_day || null,
    dropbox_backup_observations_latest_day: sources.backupDays
      ? backupObservations.latest
      : object.dropbox_backup_observations_latest_day || null,
    dropbox_backup_aqilevels_earliest_day: sources.backupDays
      ? backupAqilevels.earliest
      : object.dropbox_backup_aqilevels_earliest_day || null,
    dropbox_backup_aqilevels_latest_day: sources.backupDays
      ? backupAqilevels.latest
      : object.dropbox_backup_aqilevels_latest_day || null,
    storage_coverage_independent_sources: {
      generated_at: sources.generatedAt,
      transport: env.R2_METRICS_API ? "service_binding" : "https",
      r2_bucket: sources.r2Bucket,
      r2_observations_day_count: sources.r2Days?.observations.size ?? null,
      r2_aqilevels_day_count: sources.r2Days?.aqilevels.size ?? null,
      backup_inventory_key: sources.backupKey,
      backup_observations_day_count: sources.backupDays?.observations.size ?? null,
      backup_aqilevels_day_count: sources.backupDays?.aqilevels.size ?? null,
      ingest_oldest_day: sources.ingestOldestDay,
      r2_error: sources.r2Error,
      backup_error: sources.backupError,
      ingest_error: sources.ingestError,
    },
  };

  if (sources.dbPayload) {
    enriched.db_size_metrics = Array.isArray(sources.dbPayload.db_size_metrics)
      ? sources.dbPayload.db_size_metrics
      : object.db_size_metrics || [];
    enriched.schema_size_metrics = Array.isArray(sources.dbPayload.schema_size_metrics)
      ? sources.dbPayload.schema_size_metrics
      : object.schema_size_metrics || [];
    enriched.r2_domain_size_metrics = Array.isArray(sources.dbPayload.r2_domain_size_metrics)
      ? sources.dbPayload.r2_domain_size_metrics
      : object.r2_domain_size_metrics || [];
    enriched.db_size_metrics_error = sources.dbPayload.db_size_metrics_error || null;
    enriched.schema_size_metrics_error = sources.dbPayload.schema_size_metrics_error || null;
    enriched.r2_domain_size_metrics_error = sources.dbPayload.r2_domain_size_metrics_error || null;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-ukaq-r2-metrics-transport", env.R2_METRICS_API ? "service-binding" : "https");
  return new Response(JSON.stringify(enriched), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
