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
type BackupMonthRef = {
  year: string;
  month: string;
  stateKey: string;
};

type ExtendedWorkerEnv = WorkerEnv & {
  UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX?: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const DEFAULT_HIERARCHICAL_STATE_PREFIX = "_ops/checkpoints/r2_history_backup_state_v2";
const HIERARCHICAL_ROOT_KIND = "uk_aq_r2_history_backup_state_v2_root";
const HIERARCHICAL_MONTH_KIND = "uk_aq_r2_history_backup_state_observations_month";
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

function normaliseRelativeKey(value: unknown): string {
  const key = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!key || key === "." || key === ".." || key.startsWith("../") || key.includes("/../")) {
    throw new Error(`Invalid hierarchical Dropbox state key: ${String(value || "")}`);
  }
  return key;
}

function hierarchicalStateRootRelativePath(env: WorkerEnv): string {
  const extendedEnv = env as ExtendedWorkerEnv;
  const prefix = String(
    extendedEnv.UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX
      || DEFAULT_HIERARCHICAL_STATE_PREFIX,
  ).trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("Hierarchical Dropbox state prefix is empty");
  return `${prefix}/root.json`;
}

function joinDropboxPath(env: WorkerEnv, relativePath: string): string {
  const root = String(env.UK_AQ_DROPBOX_ROOT || "CIC-Test").trim().replace(/^\/+|\/+$/g, "");
  const historyDir = String(env.UK_AQ_R2_HISTORY_DROPBOX_DIR || "R2_history_backup").trim().replace(/^\/+|\/+$/g, "");
  const relative = normaliseRelativeKey(relativePath);
  return `/${[root, historyDir, relative].filter(Boolean).join("/")}`;
}

async function fetchDropboxAccessToken(env: WorkerEnv): Promise<string> {
  const appKey = String(env.DROPBOX_APP_KEY || "").trim();
  const appSecret = String(env.DROPBOX_APP_SECRET || "").trim();
  const refreshToken = String(env.DROPBOX_REFRESH_TOKEN || "").trim();
  if (!appKey || !appSecret || !refreshToken) {
    throw new Error("Dropbox credentials are incomplete for hierarchical backup coverage");
  }

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", appKey);
  form.set("client_secret", appSecret);
  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Dropbox token request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Dropbox token response is not a JSON object");
  }
  const token = String((payload as JsonObject).access_token || "").trim();
  if (!token) throw new Error("Dropbox token response missing access_token");
  return token;
}

async function fetchDropboxJson(token: string, remotePath: string): Promise<JsonObject> {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Dropbox-API-Arg", JSON.stringify({ path: remotePath }));
  const response = await fetch(DROPBOX_DOWNLOAD_URL, { method: "POST", headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Dropbox state download failed (${response.status}): ${text.slice(0, 500)}`);
  }

  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Dropbox state response is not a JSON object");
  }
  return payload as JsonObject;
}

function parseHierarchicalStateRoot(payload: JsonObject): BackupMonthRef[] {
  if (payload.kind !== HIERARCHICAL_ROOT_KIND || payload.backup_version !== "v2") {
    throw new Error("Hierarchical Dropbox state root identity mismatch");
  }
  const observations = payload.observations;
  if (!observations || typeof observations !== "object" || Array.isArray(observations)) {
    throw new Error("Hierarchical Dropbox state root has no observations object");
  }
  const years = (observations as JsonObject).years;
  if (!Array.isArray(years)) {
    throw new Error("Hierarchical Dropbox state root observations.years is not an array");
  }

  const refs: BackupMonthRef[] = [];
  for (const rawYear of years) {
    if (!rawYear || typeof rawYear !== "object" || Array.isArray(rawYear)) continue;
    const year = String((rawYear as JsonObject).year || "").trim();
    if (!/^\d{4}$/.test(year)) throw new Error(`Invalid hierarchical Dropbox state year: ${year}`);
    const months = (rawYear as JsonObject).months;
    if (!Array.isArray(months)) continue;
    for (const rawMonth of months) {
      if (!rawMonth || typeof rawMonth !== "object" || Array.isArray(rawMonth)) continue;
      const month = String((rawMonth as JsonObject).month || "").trim().padStart(2, "0");
      if (!/^(0[1-9]|1[0-2])$/.test(month)) {
        throw new Error(`Invalid hierarchical Dropbox state month: ${month}`);
      }
      refs.push({
        year,
        month,
        stateKey: normaliseRelativeKey((rawMonth as JsonObject).state_shard_key),
      });
    }
  }
  refs.sort((left, right) =>
    `${left.year}-${left.month}-${left.stateKey}`.localeCompare(
      `${right.year}-${right.month}-${right.stateKey}`,
    )
  );
  return refs;
}

function parseHierarchicalMonthDays(
  payload: JsonObject,
  expectedYear: string,
  expectedMonth: string,
): Set<string> {
  if (
    payload.kind !== HIERARCHICAL_MONTH_KIND
    || payload.backup_version !== "v2"
    || payload.domain !== "observations"
  ) {
    throw new Error("Hierarchical Dropbox month state identity mismatch");
  }
  if (String(payload.year || "").trim() !== expectedYear) {
    throw new Error("Hierarchical Dropbox month state year mismatch");
  }
  if (String(payload.month || "").trim().padStart(2, "0") !== expectedMonth) {
    throw new Error("Hierarchical Dropbox month state month mismatch");
  }
  if (!Array.isArray(payload.days)) {
    throw new Error("Hierarchical Dropbox month state days is not an array");
  }

  const days = new Set<string>();
  for (const rawDay of payload.days) {
    if (!rawDay || typeof rawDay !== "object" || Array.isArray(rawDay)) {
      throw new Error("Hierarchical Dropbox month state contains an invalid day entry");
    }
    const day = normaliseDay((rawDay as JsonObject).day_utc);
    if (!day || !day.startsWith(`${expectedYear}-${expectedMonth}-`)) {
      throw new Error("Hierarchical Dropbox month state contains an invalid day_utc");
    }
    days.add(day);
  }
  return days;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

async function loadHierarchicalBackupDays(env: WorkerEnv): Promise<{
  days: DaySets | null;
  key: string | null;
  error: string | null;
}> {
  const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  const rootRelativePath = hierarchicalStateRootRelativePath(env);
  const rootRemotePath = joinDropboxPath(env, rootRelativePath);
  if (version !== "v2") {
    return {
      days: null,
      key: rootRemotePath,
      error: `Hierarchical Dropbox backup coverage requires UK_AQ_R2_HISTORY_VERSION=v2; got ${version || "missing"}`,
    };
  }

  try {
    const token = await fetchDropboxAccessToken(env);
    const rootPayload = await fetchDropboxJson(token, rootRemotePath);
    const refs = parseHierarchicalStateRoot(rootPayload);
    const observations = new Set<string>();
    const errors: string[] = [];

    await mapWithConcurrency(refs, 6, async (ref) => {
      try {
        const monthPayload = await fetchDropboxJson(token, joinDropboxPath(env, ref.stateKey));
        const monthDays = parseHierarchicalMonthDays(monthPayload, ref.year, ref.month);
        for (const day of monthDays) observations.add(day);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${ref.stateKey}: ${message}`);
      }
    });

    return {
      days: { observations, aqilevels: new Set<string>() },
      key: rootRemotePath,
      error: errors.length ? errors.join("; ") : null,
    };
  } catch (error) {
    return {
      days: null,
      key: rootRemotePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadSources(request: Request, env: WorkerEnv): Promise<SourceSnapshot> {
  const historyUrl = resolveHistoryDaysUrl(env);
  const dbSizeUrl = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  const rootPath = (() => {
    try {
      return joinDropboxPath(env, hierarchicalStateRootRelativePath(env));
    } catch (_error) {
      return "";
    }
  })();
  const cacheKey = `${historyUrl}|${dbSizeUrl}|${version}|${rootPath}`;
  const forceRefresh = shouldForceRefresh(request);

  if (!forceRefresh && sourceCache && sourceCache.key === cacheKey && Date.now() < sourceCache.expiresAt) {
    return sourceCache.value;
  }

  const generatedAt = new Date().toISOString();
  let r2Days: DaySets | null = null;
  let r2Bucket: string | null = null;
  let r2Error: string | null = null;
  let backupDays: DaySets | null = null;
  let backupKey: string | null = rootPath || null;
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

  const [historyResult, dbResult, backupResult] = await Promise.allSettled([
    historyPromise,
    dbPromise,
    loadHierarchicalBackupDays(env),
  ]);

  if (historyResult.status === "fulfilled") {
    const payload = historyResult.value;
    r2Bucket = String(payload.bucket || "").trim() || null;
    r2Days = parseDomainDays(payload.domains);
  } else {
    r2Error = historyResult.reason instanceof Error
      ? historyResult.reason.message
      : String(historyResult.reason);
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

  if (backupResult.status === "fulfilled") {
    backupDays = backupResult.value.days;
    backupKey = backupResult.value.key;
    backupError = backupResult.value.error;
  } else {
    backupError = backupResult.reason instanceof Error
      ? backupResult.reason.message
      : String(backupResult.reason);
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

    row.dropbox_observs = Boolean(sources.backupDays?.observations.has(day));
    row.dropbox_aqilevels = false;
    return row;
  });

  const backupObservations = dayBounds(sources.backupDays?.observations || null);

  return {
    ...payload,
    storage_coverage_days: rows,
    storage_coverage_source: `${String(payload.storage_coverage_source || "dashboard")}+independent_http_sources`,
    r2_history_days_bucket: sources.r2Bucket || payload.r2_history_days_bucket || null,
    r2_history_days_error: mergeMessages(payload.r2_history_days_error, sources.r2Error),
    dropbox_backup_state_path: sources.backupKey ? `dropbox:${sources.backupKey}` : null,
    dropbox_backup_state_source: "dropbox-hierarchical-v2",
    dropbox_backup_state_error: sources.backupError,
    dropbox_backup_observations_earliest_day: backupObservations.earliest,
    dropbox_backup_observations_latest_day: backupObservations.latest,
    dropbox_backup_aqilevels_earliest_day: null,
    dropbox_backup_aqilevels_latest_day: null,
    storage_coverage_independent_sources: {
      generated_at: sources.generatedAt,
      r2_bucket: sources.r2Bucket,
      r2_observations_day_count: sources.r2Days?.observations.size ?? null,
      r2_aqilevels_day_count: sources.r2Days?.aqilevels.size ?? null,
      backup_state_root_key: sources.backupKey,
      backup_observations_day_count: sources.backupDays?.observations.size ?? null,
      backup_aqilevels_day_count: 0,
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
