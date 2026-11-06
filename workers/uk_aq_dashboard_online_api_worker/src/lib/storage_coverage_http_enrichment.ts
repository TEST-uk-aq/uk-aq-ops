import { assertHistoryPayload, historyResolution } from "./history_generation";
import type { WorkerEnv } from "./upstream";

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
type BackupMonthRef = {
  year: string;
  month: string;
  stateKey: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const HIERARCHICAL_ROOT_KIND = "uk_aq_r2_history_backup_state_v2_root";
const HIERARCHICAL_MONTH_KIND = "uk_aq_r2_history_backup_state_observations_month";
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
  const domains = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as JsonObject : {};
  const observations = domains.observations;
  if (!observations || typeof observations !== "object" || Array.isArray(observations)
    || !Array.isArray((observations as JsonObject).days)) {
    throw new Error("R2 history-days response has no observation-day array");
  }
  const days = new Set<string>();
  for (const value of (observations as JsonObject).days as unknown[]) {
    if (typeof value !== "string" || !DAY_RE.test(value)
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
      || days.has(value)) throw new Error("R2 history-days response contains an invalid or duplicate observation day");
    days.add(value);
  }
  return { observations: days };
}

function normaliseRelativeKey(value: unknown): string {
  const key = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!key || key === "." || key === ".." || key.startsWith("../") || key.includes("/../")) {
    throw new Error(`Invalid hierarchical Dropbox state key: ${String(value || "")}`);
  }
  return key;
}

function hierarchicalStateRootRelativePath(env: WorkerEnv): string {
  const prefix = historyResolution(env).generation.backup_state_prefix;
  if (!prefix) throw new Error("Hierarchical Dropbox state prefix is empty");
  return `${prefix}/root.json`;
}

function joinDropboxPath(env: WorkerEnv, relativePath: string): string {
  const root = String(env.UK_AQ_DROPBOX_ROOT || "TEST").trim().replace(/^\/+|\/+$/g, "");
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
  if (payload.schema_version !== 1 || payload.kind !== HIERARCHICAL_ROOT_KIND || payload.backup_version !== "v2") {
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
  const seen = new Set<string>();
  for (const rawYear of years) {
    if (!rawYear || typeof rawYear !== "object" || Array.isArray(rawYear)) {
      throw new Error("Hierarchical Dropbox state root contains an invalid year entry");
    }
    const year = String((rawYear as JsonObject).year || "").trim();
    if (!/^\d{4}$/.test(year)) throw new Error(`Invalid hierarchical Dropbox state year: ${year}`);
    const months = (rawYear as JsonObject).months;
    if (!Array.isArray(months)) throw new Error("Hierarchical Dropbox state root months is not an array");
    for (const rawMonth of months) {
      if (!rawMonth || typeof rawMonth !== "object" || Array.isArray(rawMonth)) {
        throw new Error("Hierarchical Dropbox state root contains an invalid month entry");
      }
      const month = String((rawMonth as JsonObject).month || "").trim().padStart(2, "0");
      if (!/^(0[1-9]|1[0-2])$/.test(month)) {
        throw new Error(`Invalid hierarchical Dropbox state month: ${month}`);
      }
      if (seen.has(`${year}-${month}`)) throw new Error("Duplicate hierarchical Dropbox state month");
      seen.add(`${year}-${month}`);
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
    payload.schema_version !== 1
    || payload.kind !== HIERARCHICAL_MONTH_KIND
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
    const entry = rawDay as JsonObject;
    const day = entry.day_utc;
    if (typeof day !== "string" || !DAY_RE.test(day)
      || !day.startsWith(`${expectedYear}-${expectedMonth}-`)
      || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || days.has(day)) {
      throw new Error("Hierarchical Dropbox month state contains an invalid day_utc");
    }
    if (typeof entry.manifest_hash !== "string" || !/^[a-f0-9]{64}$/i.test(entry.manifest_hash)
      || typeof entry.copied_at !== "string" || !Number.isFinite(Date.parse(entry.copied_at))) {
      throw new Error("Hierarchical Dropbox month state day has no valid copied-source evidence");
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
  const version = historyResolution(env).version;
  const rootRelativePath = hierarchicalStateRootRelativePath(env);
  const rootRemotePath = joinDropboxPath(env, rootRelativePath);
  if (!["v2", "v3"].includes(version)) {
    return {
      days: null,
      key: rootRemotePath,
      error: `Hierarchical Dropbox backup coverage requires a v2/v3 serving descriptor; got ${version || "missing"}`,
    };
  }

  try {
    const token = await fetchDropboxAccessToken(env);
    const rootPayload = await fetchDropboxJson(token, rootRemotePath);
    if (rootPayload.observation_generation !== version) throw new Error("Dropbox checkpoint generation mismatch");
    const refs = parseHierarchicalStateRoot(rootPayload);
    if (refs.some(ref => !ref.stateKey.startsWith(historyResolution(env).generation.backup_state_prefix + "/"))) throw new Error("Dropbox shard outside selected generation");
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
      // Missing/malformed shards make absence unknowable. Never publish a
      // partial set as though every other day had been checked successfully.
      days: errors.length ? null : { observations },
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
  const version = historyResolution(env).version;
  const rootPath = (() => {
    try {
      return joinDropboxPath(env, hierarchicalStateRootRelativePath(env));
    } catch (_error) {
      return "";
    }
  })();
  const cacheKey = `${historyUrl}|${version}|${rootPath}`;
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
  let backupKey: string | null = rootPath || null;
  let backupError: string | null = null;

  const historyPromise = (async () => {
    if (!historyUrl) throw new Error("R2 history-days API is not configured");
    if (!["v2", "v3"].includes(version)) {
      throw new Error("Serving history descriptor must select v2 or v3");
    }
    const url = new URL(historyUrl);
    url.searchParams.set("read_version", version);
    url.searchParams.set("max_days", "3660");
    const payload = await fetchJsonObject(url.toString(), resolveHistoryToken(env));
    assertHistoryPayload(payload, env);
    return { payload, days: parseDomainDays(payload.domains) };
  })();

  const [historyResult, backupResult] = await Promise.allSettled([
    historyPromise,
    loadHierarchicalBackupDays(env),
  ]);

  if (historyResult.status === "fulfilled") {
    r2Bucket = String(historyResult.value.payload.bucket || "").trim() || null;
    r2Days = historyResult.value.days;
  } else {
    r2Error = historyResult.reason instanceof Error
      ? historyResult.reason.message
      : String(historyResult.reason);
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
    storage_coverage_source: `${String(payload.storage_coverage_source || "dashboard")}+independent_http_sources`,
    r2_history_days_bucket: sources.r2Bucket || payload.r2_history_days_bucket || null,
    r2_history_days_error: sources.r2Days ? null : mergeMessages(payload.r2_history_days_error, sources.r2Error),
    dropbox_backup_state_path: sources.backupKey ? `dropbox:${sources.backupKey}` : null,
    dropbox_backup_state_source: "dropbox-hierarchical-v2",
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
