import type { WorkerEnv } from "./upstream";

type JsonObject = Record<string, unknown>;
type ServiceFetcher = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};
type MetricsEnv = WorkerEnv & {
  R2_METRICS_API?: ServiceFetcher;
};
type BoundarySnapshot = {
  oldestDay: string | null;
  error: string | null;
  generatedAt: string;
};
type CacheEntry = {
  expiresAt: number;
  value: BoundarySnapshot;
};

const INTERNAL_URL = "https://r2-metrics.internal/v1/db-size-metrics";
const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let boundaryCache: CacheEntry | null = null;

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

function latestObsAqiOldestDay(rows: unknown[]): string | null {
  let latestSampleMs = Number.NEGATIVE_INFINITY;
  let oldestDay: string | null = null;

  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as JsonObject;
    const label = String(row.database_label || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    if (label !== "obsaqidb") continue;

    const sampleText = String(row.recorded_at || row.bucket_hour || "").trim();
    const sampleMs = Date.parse(sampleText);
    const candidate = normaliseDay(row.oldest_observed_at);
    if (!Number.isFinite(sampleMs) || !candidate || sampleMs < latestSampleMs) continue;

    latestSampleMs = sampleMs;
    oldestDay = candidate;
  }

  return oldestDay;
}

function clearSupersededHttpErrors(object: JsonObject): JsonObject {
  const source = object.storage_coverage_independent_sources;
  if (!source || typeof source !== "object" || Array.isArray(source)) return object;

  const independent = source as JsonObject;
  if (String(independent.transport || "") !== "service_binding") return object;

  const r2Healthy = !String(independent.r2_error || "").trim();
  const backupHealthy = !String(independent.backup_error || "").trim();

  return {
    ...object,
    r2_history_days_error: r2Healthy ? null : object.r2_history_days_error,
    r2_backup_window_error: backupHealthy ? null : object.r2_backup_window_error,
  };
}

async function loadBoundary(request: Request, env: MetricsEnv): Promise<BoundarySnapshot> {
  if (!shouldForceRefresh(request) && boundaryCache && Date.now() < boundaryCache.expiresAt) {
    return boundaryCache.value;
  }

  const generatedAt = new Date().toISOString();
  if (!env.R2_METRICS_API) {
    return {
      oldestDay: null,
      error: "R2_METRICS_API service binding is not configured",
      generatedAt,
    };
  }

  try {
    const url = new URL(INTERNAL_URL);
    const lookback = Math.max(
      1,
      Math.trunc(Number(env.UK_AQ_DB_SIZE_LOOKBACK_DAYS || 28) || 28),
    );
    url.searchParams.set("lookback_days", String(lookback));

    const headers = new Headers({ Accept: "application/json" });
    const token = String(env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const response = await env.R2_METRICS_API.fetch(
      new Request(url.toString(), { method: "GET", headers }),
    );
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_error) {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(`DB size metrics HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("DB size metrics response is not a JSON object");
    }

    const rows = Array.isArray((payload as JsonObject).db_size_metrics)
      ? ((payload as JsonObject).db_size_metrics as unknown[])
      : [];
    const oldestDay = latestObsAqiOldestDay(rows);
    const value: BoundarySnapshot = {
      oldestDay,
      error: oldestDay
        ? null
        : "DB size metrics contain no usable ObsAQIDB retention boundary",
      generatedAt,
    };
    boundaryCache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
    return value;
  } catch (error) {
    const value: BoundarySnapshot = {
      oldestDay: null,
      error: error instanceof Error ? error.message : String(error),
      generatedAt,
    };
    boundaryCache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
    return value;
  }
}

export async function restoreObsAqiCoverage(
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

  const object = clearSupersededHttpErrors(payload as JsonObject);
  if (!Array.isArray(object.storage_coverage_days)) return response;

  const boundary = await loadBoundary(request, env);
  if (!boundary.oldestDay) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(
      JSON.stringify({
        ...object,
        obs_aqidb_coverage_source: "metrics_service_binding",
        obs_aqidb_coverage_error: boundary.error,
        obs_aqidb_coverage_generated_at: boundary.generatedAt,
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  }

  const rows = object.storage_coverage_days.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = { ...(value as JsonObject) };
    const day = normaliseDay(row.date);
    if (day) row.obs_aqi_observs = day >= boundary.oldestDay!;
    return row;
  });

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-ukaq-obsaqidb-coverage", "service-binding");

  return new Response(
    JSON.stringify({
      ...object,
      storage_coverage_days: rows,
      obs_aqidb_coverage_source: "metrics_service_binding",
      obs_aqidb_coverage_oldest_day: boundary.oldestDay,
      obs_aqidb_coverage_error: null,
      obs_aqidb_coverage_generated_at: boundary.generatedAt,
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}
