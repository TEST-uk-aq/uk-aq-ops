import type { WorkerEnv } from "./upstream";

type JsonObject = Record<string, unknown>;
type DaySets = {
  observations: Set<string>;
  aqilevels: Set<string>;
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
};
type CacheEntry = {
  key: string;
  expiresAt: number;
  value: SourceSnapshot;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let sourceCache: CacheEntry | null = null;

function normaliseDay(value: unknown): string | null {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match && DAY_RE.test(match[1]) ? match[1] : null;
}

function resolveOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch (_error) {
    return "";
  }
}

function resolveHistoryDaysUrl(env: WorkerEnv): string {
  const explicit = String(env.UK_AQ_R2_HISTORY_DAYS_API_URL || "").trim();
  if (explicit) return explicit;
  const dbSizeUrl = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  const origin = dbSizeUrl ? resolveOrigin(dbSizeUrl) : "";
  return origin ? `${origin}/v1/r2-history-days` : "";
}

function resolveHistoryToken(env: WorkerEnv): string {
  return String(env.UK_AQ_R2_HISTORY_DAYS_API_TOKEN || env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
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

async function fetchJsonObject(url: string, token: string): Promise<JsonObject> {
  const headers = new Headers({ Accept: "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { method: "GET", headers });
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

async function loadSources(request: Request, env: WorkerEnv): Promise<SourceSnapshot> {
  const historyUrl = resolveHistoryDaysUrl(env);
  const dbSizeUrl = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  const cacheKey = `${historyUrl}|${dbSizeUrl}|${version}`;
  const forceRefresh = shouldForceRefresh(request);

  if (!forceRefresh && sourceCache && sourceCache.key === cacheKey && Date.now() < sourceCache.expiresAt) {
    return sourceCache.value;
  }

  const generatedAt = new Date().toISOString();
  let r2Days: DaySets | null = null;
  let r2Bucket: string | null = null;
  let r2Error: string | null = null;
  let backupDays: DaySets | null = null;
  let backupKey: string | null = null;
  let backupError: string | null = null;
  let ingestOldestDay: string | null = null;
  let ingestError: string | null = null;

  const historyPromise = (async () => {
    if (!historyUrl) throw new Error("R2 history-days API is not configured");
    if (version !== "v1" && version !== "v2") {
      throw new Error("UK_AQ_R2_HISTORY_VERSION must be v1 or v2");
    }
    const url = new URL(historyUrl);
    url.searchParams.set("read_version", version);
    url.searchParams.set("max_days", "3660");
    return fetchJsonObject(url.toString(), resolveHistoryToken(env));
  })();

  const dbPromise = (async () => {
    if (!dbSizeUrl) throw new Error("UK_AQ_DB_SIZE_API_URL is not configured");
    const url = new URL(dbSizeUrl);
    const lookback = Math.max(1, Math.trunc(Number(env.UK_AQ_DB_SIZE_LOOKBACK_DAYS || 28) || 28));
    url.searchParams.set("lookback_days", String(lookback));
    return fetchJsonObject(url.toString(), String(env.UK_AQ_DB_SIZE_API_TOKEN || "").trim());
  })();

  const [historyResult, dbResult] = await Promise.allSettled([historyPromise, dbPromise]);

  if (historyResult.status === "fulfilled") {
    const payload = historyResult.value;
    r2Bucket = String(payload.bucket || "").trim() || null;
    r2Days = parseDomainDays(payload.domains);

    const inventory = payload.backup_inventory;
    if (inventory && typeof inventory === "object" && !Array.isArray(inventory)) {
      const inventoryObject = inventory as JsonObject;
      backupKey = String(inventoryObject.key || "").trim() || null;
      backupError = String(inventoryObject.error || "").trim() || null;
      if (!backupError) {
        backupDays = parseDomainDays(inventoryObject.domains);
      }
    } else {
      backupError = "R2 history-days response does not include active backup inventory data";
    }
  } else {
    r2Error = historyResult.reason instanceof Error
      ? historyResult.reason.message
      : String(historyResult.reason);
    backupError = r2Error;
  }

  if (dbResult.status === "fulfilled") {
    const rows = Array.isArray(dbResult.value.db_size_metrics)
      ? dbResult.value.db_size_metrics
      : [];
    ingestOldestDay = latestIngestOldestDay(rows);
    if (!ingestOldestDay) ingestError = "DB size metrics contain no usable IngestDB retention boundary";
  } else {
    ingestError = dbResult.reason instanceof Error
      ? dbResult.reason.message
      : String(dbResult.reason);
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
  };
  sourceCache = {
    key: cacheKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  };
  return value;
}

function dayBounds(days: Set<string> | null): { earliest: string | null; latest: string | null } {
  const values = days ? Array.from(days).sort() : [];
  return {
    earliest: values[0] || null,
    latest: values[values.length - 1] || null,
  };
}

function enrichPayload(payload: JsonObject, sources: SourceSnapshot): JsonObject {
  const rawRows = Array.isArray(payload.storage_coverage_days)
    ? payload.storage_coverage_days
    : [];
  const rows = rawRows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = { ...(value as JsonObject) };
    const day = normaliseDay(row.date);
    if (!day) return row;

    if (sources.ingestOldestDay) {
      row.ingest = day >= sources.ingestOldestDay;
    }
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

  return {
    ...payload,
    storage_coverage_days: rows,
    storage_coverage_source: `${String(payload.storage_coverage_source || "dashboard")}+independent_http_sources`,
    r2_history_days_bucket: sources.r2Bucket || payload.r2_history_days_bucket || null,
    r2_history_days_error: mergeMessages(payload.r2_history_days_error, sources.r2Error),
    dropbox_backup_state_path: sources.backupKey
      ? `r2:${sources.backupKey}`
      : payload.dropbox_backup_state_path || null,
    dropbox_backup_state_source: sources.backupDays
      ? "r2-backup-inventory"
      : payload.dropbox_backup_state_source || null,
    dropbox_backup_state_error: sources.backupDays
      ? null
      : mergeMessages(payload.dropbox_backup_state_error, sources.backupError),
    dropbox_backup_observations_earliest_day: sources.backupDays
      ? backupObservations.earliest
      : payload.dropbox_backup_observations_earliest_day || null,
    dropbox_backup_observations_latest_day: sources.backupDays
      ? backupObservations.latest
      : payload.dropbox_backup_observations_latest_day || null,
    dropbox_backup_aqilevels_earliest_day: sources.backupDays
      ? backupAqilevels.earliest
      : payload.dropbox_backup_aqilevels_earliest_day || null,
    dropbox_backup_aqilevels_latest_day: sources.backupDays
      ? backupAqilevels.latest
      : payload.dropbox_backup_aqilevels_latest_day || null,
    storage_coverage_independent_sources: {
      generated_at: sources.generatedAt,
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
}

export async function enrichStorageCoverageResponse(
  response: Response,
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  if (!response.ok) return response;

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch (_error) {
    return response;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response;
  if (!Array.isArray((payload as JsonObject).storage_coverage_days)) return response;

  const sources = await loadSources(request, env);
  const enriched = enrichPayload(payload as JsonObject, sources);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-ukaq-storage-coverage", "independent-http-sources");
  return new Response(JSON.stringify(enriched), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
