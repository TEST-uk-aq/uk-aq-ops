import { assertHistoryPayload, historyResolution } from "./history_generation";
import type { WorkerEnv } from "./upstream";
import { CoverageEvidenceError, coverageFailureReason } from "./storage_day_presence";

type JsonObject = Record<string, unknown>;
type DaySets = {
  observations: Set<string>;
};
type SourceSnapshot = {
  generatedAt: string;
  r2Days: DaySets | null;
  r2Bucket: string | null;
  r2Error: string | null;
  backupDays: DaySets | null;
  backupKey: string | null;
  backupError: string | null;
};
type CacheEntry = {
  key: string;
  expiresAt: number;
  value: SourceSnapshot;
};
const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let sourceCache: CacheEntry | null = null;
let refreshSequence = 0;

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
  for (const key of ["force", "refresh", "nocache", "cache_bust", "cacheBust"]) {
    const value = String(params.get(key) || "").trim().toLowerCase();
    if (!value) continue;
    if (["1", "true", "yes"].includes(value)) return true;
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

async function fetchJsonObject(url: string, token: string, env: WorkerEnv): Promise<JsonObject> {
  const headers = new Headers({ Accept: "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const init: RequestInit = { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(15000) };
  const response = env.coverageRequestBudget ? await env.coverageRequestBudget.fetch(url, init) : await fetch(url, init);
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!response.ok) {
    throw new CoverageEvidenceError(`R2 history-days HTTP ${response.status}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoverageEvidenceError("R2 history-days response is not a JSON object");
  }
  return payload as JsonObject;
}

function parseDomainDays(payload: unknown): DaySets {
  const domains = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as JsonObject : {};
  const observations = domains.observations;
  if (!observations || typeof observations !== "object" || Array.isArray(observations)
    || !Array.isArray((observations as JsonObject).days)) {
    throw new CoverageEvidenceError("R2 history-days response has no observation-day array");
  }
  const days = new Set<string>();
  for (const value of (observations as JsonObject).days as unknown[]) {
    if (typeof value !== "string" || !DAY_RE.test(value)
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
      || days.has(value)) throw new CoverageEvidenceError("R2 history-days response contains an invalid or duplicate observation day");
    days.add(value);
  }
  return { observations: days };
}

async function loadSources(request: Request, env: WorkerEnv): Promise<SourceSnapshot> {
  const historyUrl = resolveHistoryDaysUrl(env);
  const version = historyResolution(env).version;
  const cacheKey = `${historyUrl}|${version}`;
  const forceRefresh = shouldForceRefresh(request);

  if (!forceRefresh && sourceCache && sourceCache.key === cacheKey && Date.now() < sourceCache.expiresAt) {
    return sourceCache.value;
  }

  const sequence = ++refreshSequence;
  const generatedAt = new Date().toISOString();
  let r2Days: DaySets | null = null;
  let r2Bucket: string | null = null;
  let r2Error: string | null = null;
  let backupDays: DaySets | null = null;
  let backupKey: string | null = null;
  let backupError: string | null = null;

  const historyPromise = (async () => {
    if (!historyUrl) throw new Error("R2 history-days API is not configured");
    if (!["v2", "v3"].includes(version)) {
      throw new Error("Serving history descriptor must select v2 or v3");
    }
    const url = new URL(historyUrl);
    url.searchParams.set("read_version", version);
    url.searchParams.set("max_days", "3660");
    const payload = await fetchJsonObject(url.toString(), resolveHistoryToken(env), env);
    assertHistoryPayload(payload, env);
    return { payload, days: parseDomainDays(payload.domains) };
  })();

  const [historyResult] = await Promise.allSettled([historyPromise]);

  if (historyResult.status === "fulfilled") {
    r2Bucket = String(historyResult.value.payload.bucket || "").trim() || null;
    r2Days = historyResult.value.days;
  } else {
    r2Error = `R2 history-days unavailable: ${coverageFailureReason(historyResult.reason)}`;
  }

  const value: SourceSnapshot = {
    generatedAt,
    r2Days,
    r2Bucket,
    r2Error,
    backupDays,
    backupKey,
    backupError,
  };
  // An earlier overlapping load must not replace a later Refresh's snapshot.
  if (sequence === refreshSequence) {
    sourceCache = {
      key: cacheKey,
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
    };
  }
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
  const previous = payload.storage_coverage_independent_sources;
  const details: JsonObject = previous && typeof previous === "object" && !Array.isArray(previous)
    ? { ...previous as JsonObject } : {};
  const priorCheckedAt = (source: "r2" | "backup"): string | null => {
    const value = details[`${source}_checked_at_utc`];
    return details[`${source}_status`] === "ok" && typeof value === "string"
      && Number.isFinite(Date.parse(value)) ? value : null;
  };
  const priorR2CheckedAt = priorCheckedAt("r2");
  const priorBackupCheckedAt = priorCheckedAt("backup");
  const rawRows = Array.isArray(payload.storage_coverage_days)
    ? payload.storage_coverage_days
    : [];
  const rows = rawRows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = { ...(value as JsonObject) };
    delete row.obs_aqi_aqilevels;
    delete row.r2_aqilevels;
    delete row.dropbox_aqilevels;
    delete row.aqilevels;
    delete row.r2;
    const day = normaliseDay(row.date);
    if (!day) return row;

    if (sources.r2Days) {
      row.r2_observs = sources.r2Days.observations.has(day);
    } else if (!priorR2CheckedAt || typeof row.r2_observs !== "boolean") {
      row.r2_observs = null;
    }

    if (sources.backupDays) {
      row.dropbox_observs = sources.backupDays.observations.has(day);
    } else if (!priorBackupCheckedAt || typeof row.dropbox_observs !== "boolean") {
      row.dropbox_observs = null;
    }
    return row;
  });

  const backupObservations = dayBounds(sources.backupDays?.observations || null);
  delete details.r2_aqilevels_day_count;
  delete details.backup_aqilevels_day_count;
  delete details.ingest_oldest_day;
  delete details.ingest_error;
  const cleaned = { ...payload };
  delete cleaned.dropbox_backup_aqilevels_earliest_day;
  delete cleaned.dropbox_backup_aqilevels_latest_day;

  return {
    ...cleaned,
    storage_coverage_days: rows,
    dropbox_coverage: { protocol: "checkpoint_batches_v1", status: "pending", complete: false },
    storage_coverage_source: `${String(payload.storage_coverage_source || "dashboard")}+independent_http_sources`,
    r2_history_days_bucket: sources.r2Bucket || payload.r2_history_days_bucket || null,
    r2_history_days_error: sources.r2Days ? null : mergeMessages(payload.r2_history_days_error, sources.r2Error),
    dropbox_backup_state_path: sources.backupKey ? `dropbox:${sources.backupKey}` : null,
    dropbox_backup_state_source: "bounded_checkpoint_collection",
    dropbox_backup_state_error: sources.backupError,
    dropbox_backup_observations_earliest_day: backupObservations.earliest,
    dropbox_backup_observations_latest_day: backupObservations.latest,
    storage_coverage_independent_sources: {
      ...details,
      generated_at: sources.generatedAt,
      r2_bucket: sources.r2Bucket,
      r2_observations_day_count: sources.r2Days?.observations.size ?? null,
      r2_checked_at_utc: sources.r2Days ? sources.generatedAt : priorR2CheckedAt,
      r2_status: sources.r2Days || priorR2CheckedAt ? "ok" : "unavailable",
      r2_stale: !sources.r2Days && Boolean(priorR2CheckedAt),
      backup_state_root_key: sources.backupKey,
      backup_observations_day_count: sources.backupDays?.observations.size ?? null,
      backup_checked_at_utc: sources.backupDays ? sources.generatedAt : priorBackupCheckedAt,
      backup_status: sources.backupDays || priorBackupCheckedAt ? "ok" : "unavailable",
      backup_stale: !sources.backupDays && Boolean(priorBackupCheckedAt),
      r2_error: sources.r2Error,
      backup_error: sources.backupError,
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
  const coverageDays = (payload as JsonObject).storage_coverage_days;
  if (!Array.isArray(coverageDays)) return response;
  // Range authority failed before day checks; enrichment cannot invent a range
  // or clear the unavailable diagnostic merely because a later lookup succeeds.
  if (!coverageDays.length) return response;
  // A successfully published local snapshot already includes its configured
  // physical intersection and checkpoint checks. Do not undo those constraints
  // using an unconstrained HTTP listing; IngestDB is still rechecked by the
  // common final adapter in the compatibility route.
  if ((payload as JsonObject).storage_coverage_complete === true) return response;

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
