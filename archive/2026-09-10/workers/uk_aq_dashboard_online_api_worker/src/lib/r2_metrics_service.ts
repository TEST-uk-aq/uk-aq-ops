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

const INTERNAL_ORIGIN = "https://r2-metrics.internal";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function serviceBinding(env: WorkerEnv): ServiceFetcher | null {
  const binding = (env as MetricsEnv).R2_METRICS_API;
  return binding && typeof binding.fetch === "function" ? binding : null;
}

function normaliseDay(value: unknown): string | null {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match && DAY_RE.test(match[1]) ? match[1] : null;
}

function resolveToken(env: WorkerEnv, pathname: string): string {
  if (pathname === "/v1/r2-history-days") {
    return String(env.UK_AQ_R2_HISTORY_DAYS_API_TOKEN || env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
  }
  if (pathname === "/v1/r2-history-counts") {
    return String(
      env.UK_AQ_R2_HISTORY_COUNTS_API_TOKEN
      || env.UK_AQ_R2_HISTORY_DAYS_API_TOKEN
      || env.UK_AQ_DB_SIZE_API_TOKEN
      || "",
    ).trim();
  }
  return String(env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
}

async function fetchMetricsBinding(
  env: WorkerEnv,
  pathname: string,
  params: URLSearchParams,
): Promise<Response> {
  const binding = serviceBinding(env);
  if (!binding) {
    throw new Error(`R2_METRICS_API service binding is not configured for ${pathname}`);
  }

  const headers = new Headers({ Accept: "application/json" });
  const token = resolveToken(env, pathname);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const url = new URL(pathname, INTERNAL_ORIGIN);
  url.search = params.toString();
  return binding.fetch(new Request(url.toString(), { method: "GET", headers }));
}

async function fetchMetricsBindingJson(
  env: WorkerEnv,
  pathname: string,
  params: URLSearchParams,
): Promise<JsonObject> {
  const response = await fetchMetricsBinding(env, pathname, params);
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
    throw new Error("R2 metrics service response is not a JSON object");
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

export async function proxyR2ConnectorCounts(
  request: Request,
  env: WorkerEnv,
): Promise<Response | null> {
  if (!serviceBinding(env)) return null;

  try {
    const incoming = new URL(request.url);
    const params = new URLSearchParams(incoming.search);
    if (!params.get("read_version")) {
      const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
      if (version === "v1" || version === "v2") params.set("read_version", version);
    }

    const response = await fetchMetricsBinding(env, "/v1/r2-history-counts", params);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("x-ukaq-r2-metrics-transport", "service-binding");
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
  env: WorkerEnv,
): Promise<Response> {
  if (!serviceBinding(env) || !response.ok) return response;

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch (_error) {
    return response;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response;

  const object = payload as JsonObject;
  if (!Array.isArray(object.storage_coverage_days)) return response;

  const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  const historyParams = new URLSearchParams();
  historyParams.set("read_version", version);
  historyParams.set("max_days", "3660");

  const dbParams = new URLSearchParams();
  const lookback = Math.max(1, Math.trunc(Number(env.UK_AQ_DB_SIZE_LOOKBACK_DAYS || 28) || 28));
  dbParams.set("lookback_days", String(lookback));

  const [historyResult, dbResult] = await Promise.allSettled([
    version === "v1" || version === "v2"
      ? fetchMetricsBindingJson(env, "/v1/r2-history-days", historyParams)
      : Promise.reject(new Error("UK_AQ_R2_HISTORY_VERSION must be v1 or v2")),
    fetchMetricsBindingJson(env, "/v1/db-size-metrics", dbParams),
  ]);

  let r2Days: DaySets | null = null;
  let r2Bucket: string | null = null;
  let r2Error: string | null = null;
  let ingestOldestDay: string | null = null;
  let ingestError: string | null = null;
  let dbPayload: JsonObject | null = null;

  if (historyResult.status === "fulfilled") {
    r2Bucket = String(historyResult.value.bucket || "").trim() || null;
    r2Days = parseDomainDays(historyResult.value.domains);
  } else {
    r2Error = historyResult.reason instanceof Error
      ? historyResult.reason.message
      : String(historyResult.reason);
  }

  if (dbResult.status === "fulfilled") {
    dbPayload = dbResult.value;
    const rows = Array.isArray(dbPayload.db_size_metrics) ? dbPayload.db_size_metrics : [];
    ingestOldestDay = latestIngestOldestDay(rows);
    if (!ingestOldestDay) {
      ingestError = "DB size metrics contain no usable IngestDB retention boundary";
    }
  } else {
    ingestError = dbResult.reason instanceof Error
      ? dbResult.reason.message
      : String(dbResult.reason);
  }

  const rows = object.storage_coverage_days.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = { ...(value as JsonObject) };
    const day = normaliseDay(row.date);
    if (!day) return row;

    if (ingestOldestDay) row.ingest = day >= ingestOldestDay;
    if (r2Days) {
      const observationsPresent = r2Days.observations.has(day);
      row.r2_observs = observationsPresent;
      row.r2 = observationsPresent;
      row.r2_aqilevels = r2Days.aqilevels.has(day);
    }
    return row;
  });

  const existingSources = object.storage_coverage_independent_sources;
  const sourceDetails: JsonObject = existingSources
    && typeof existingSources === "object"
    && !Array.isArray(existingSources)
    ? { ...(existingSources as JsonObject) }
    : {};
  sourceDetails.transport = "service_binding";
  sourceDetails.r2_bucket = r2Bucket || sourceDetails.r2_bucket || null;
  sourceDetails.r2_observations_day_count = r2Days?.observations.size ?? null;
  sourceDetails.r2_aqilevels_day_count = r2Days?.aqilevels.size ?? null;
  sourceDetails.ingest_oldest_day = ingestOldestDay;
  sourceDetails.r2_error = r2Days ? null : mergeMessages(sourceDetails.r2_error, r2Error);
  sourceDetails.ingest_error = dbPayload ? ingestError : mergeMessages(sourceDetails.ingest_error, ingestError);

  const enriched: JsonObject = {
    ...object,
    storage_coverage_days: rows,
    storage_coverage_source: `${String(object.storage_coverage_source || "dashboard")}+metrics_service_binding`,
    r2_history_days_bucket: r2Bucket || object.r2_history_days_bucket || null,
    r2_history_days_error: r2Days ? null : mergeMessages(object.r2_history_days_error, r2Error),
    storage_coverage_independent_sources: sourceDetails,
  };

  if (dbPayload) {
    enriched.db_size_metrics = Array.isArray(dbPayload.db_size_metrics)
      ? dbPayload.db_size_metrics
      : object.db_size_metrics || [];
    enriched.schema_size_metrics = Array.isArray(dbPayload.schema_size_metrics)
      ? dbPayload.schema_size_metrics
      : object.schema_size_metrics || [];
    enriched.r2_domain_size_metrics = Array.isArray(dbPayload.r2_domain_size_metrics)
      ? dbPayload.r2_domain_size_metrics
      : object.r2_domain_size_metrics || [];
    enriched.db_size_metrics_error = dbPayload.db_size_metrics_error || null;
    enriched.schema_size_metrics_error = dbPayload.schema_size_metrics_error || null;
    enriched.r2_domain_size_metrics_error = dbPayload.r2_domain_size_metrics_error || null;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-ukaq-r2-metrics-transport", "service-binding");
  return new Response(JSON.stringify(enriched), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
