import type { R2BucketBinding, WorkerEnv } from "./upstream";

type JsonObject = Record<string, unknown>;
type DomainName = "observations" | "aqilevels";

type DaySets = {
  observations: Set<string>;
  aqilevels: Set<string>;
};

type CoverageSources = {
  generatedAt: string;
  version: "v1" | "v2" | null;
  r2Observations: Set<string> | null;
  r2Aqilevels: Set<string> | null;
  r2Error: string | null;
  backupDays: DaySets | null;
  backupError: string | null;
  backupInventoryKey: string | null;
  ingestOldestDay: string | null;
  ingestError: string | null;
};

type CacheEntry = {
  cacheKey: string;
  expiresAt: number;
  value: CoverageSources;
};

const SOURCE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKUP_INVENTORY_KEYS = {
  v1: "history/_index/backup_inventory_v1.json",
  v2: "history/_index_v2/backup_inventory_v2.json",
} as const;

let sourceCache: CacheEntry | null = null;

function normaliseDay(value: unknown): string | null {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match && DAY_RE.test(match[1]) ? match[1] : null;
}

function resolveVersion(env: WorkerEnv): "v1" | "v2" | null {
  const value = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  return value === "v1" || value === "v2" ? value : null;
}

function mergeMessages(...values: Array<unknown>): string | null {
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

function shouldForceRefresh(request: Request): boolean {
  const search = new URL(request.url).searchParams;
  for (const key of ["force", "refresh", "nocache", "cache_bust", "cacheBust"]) {
    const value = String(search.get(key) || "").trim().toLowerCase();
    if (["1", "true", "yes"].includes(value)) return true;
  }
  return false;
}

function parseDayFromR2Key(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const remainder = value.slice(prefix.length);
  const match = remainder.match(/^day_utc=(\d{4}-\d{2}-\d{2})(?:\/|$)/);
  return match && DAY_RE.test(match[1]) ? match[1] : null;
}

async function listR2DomainDays(
  bucket: R2BucketBinding,
  version: "v1" | "v2",
  domain: DomainName,
): Promise<Set<string>> {
  const prefix = `history/${version}/${domain}/`;
  const days = new Set<string>();
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix,
      delimiter: "/",
      cursor,
      limit: 1000,
    });

    for (const candidate of result.delimitedPrefixes || []) {
      const day = parseDayFromR2Key(candidate, prefix);
      if (day) days.add(day);
    }
    for (const object of result.objects || []) {
      const day = parseDayFromR2Key(String(object.key || ""), prefix);
      if (day) days.add(day);
    }

    if (!result.truncated) break;
    if (!result.cursor) {
      throw new Error(`R2 ${domain} listing was truncated without a cursor`);
    }
    cursor = result.cursor;
  } while (cursor);

  return days;
}

function inventoryPathPattern(version: "v1" | "v2"): RegExp {
  return new RegExp(
    `(?:^|/)(?:history/)?${version}/(observations|aqilevels)/day_utc=(\\d{4}-\\d{2}-\\d{2})(?:/|$)`,
    "g",
  );
}

function extractInventoryDays(payload: unknown, version: "v1" | "v2"): DaySets {
  const days: DaySets = {
    observations: new Set<string>(),
    aqilevels: new Set<string>(),
  };
  const stack: unknown[] = [payload];
  const pattern = inventoryPathPattern(version);

  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as JsonObject)) {
        stack.push(key, child);
      }
      continue;
    }
    if (typeof value !== "string") continue;

    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const domain = match[1] as DomainName;
      const day = normaliseDay(match[2]);
      if (day) days[domain].add(day);
    }
  }

  return days;
}

async function readBackupInventory(
  bucket: R2BucketBinding,
  version: "v1" | "v2",
): Promise<{ days: DaySets; key: string }> {
  const key = BACKUP_INVENTORY_KEYS[version];
  const object = await bucket.get(key);
  if (!object) {
    throw new Error(`Backup inventory is missing at ${key}`);
  }

  const text = await object.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Backup inventory JSON is invalid: ${detail}`);
  }

  const days = extractInventoryDays(payload, version);
  if (!days.observations.size && !days.aqilevels.size) {
    throw new Error(`Backup inventory contains no ${version} observation or AQI day paths`);
  }
  return { days, key };
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
    if (!Number.isFinite(sampleMs) || sampleMs < latestSampleMs) continue;

    const candidate = normaliseDay(row.oldest_observed_at);
    if (!candidate) continue;
    latestSampleMs = sampleMs;
    oldestDay = candidate;
  }

  return oldestDay;
}

async function fetchIngestOldestDay(env: WorkerEnv): Promise<string | null> {
  const configured = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  if (!configured) return null;

  const url = new URL(configured);
  const lookback = Math.max(1, Math.trunc(Number(env.UK_AQ_DB_SIZE_LOOKBACK_DAYS || 28) || 28));
  url.searchParams.set("lookback_days", String(lookback));

  const headers = new Headers({ Accept: "application/json" });
  const token = String(env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(url.toString(), { method: "GET", headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`DB size API HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const payload = JSON.parse(text) as JsonObject;
  const rows = Array.isArray(payload.db_size_metrics) ? payload.db_size_metrics : [];
  return latestIngestOldestDay(rows);
}

async function loadCoverageSources(
  request: Request,
  env: WorkerEnv,
): Promise<CoverageSources> {
  const version = resolveVersion(env);
  const bucketName = String(env.UK_AQ_R2_HISTORY_BUCKET || "").trim();
  const cacheKey = `${version || "invalid"}|${bucketName || "unnamed"}`;
  const forceRefresh = shouldForceRefresh(request);

  if (!forceRefresh && sourceCache && sourceCache.cacheKey === cacheKey && Date.now() < sourceCache.expiresAt) {
    return sourceCache.value;
  }

  const generatedAt = new Date().toISOString();
  if (!version) {
    const value: CoverageSources = {
      generatedAt,
      version: null,
      r2Observations: null,
      r2Aqilevels: null,
      r2Error: "UK_AQ_R2_HISTORY_VERSION must be v1 or v2",
      backupDays: null,
      backupError: "Backup inventory disabled because the R2 history version is invalid",
      backupInventoryKey: null,
      ingestOldestDay: null,
      ingestError: null,
    };
    sourceCache = { cacheKey, expiresAt: Date.now() + SOURCE_CACHE_TTL_MS, value };
    return value;
  }

  const bucket = env.R2_HISTORY;
  if (!bucket) {
    const value: CoverageSources = {
      generatedAt,
      version,
      r2Observations: null,
      r2Aqilevels: null,
      r2Error: "R2_HISTORY bucket binding is not configured",
      backupDays: null,
      backupError: "Backup inventory unavailable because R2_HISTORY is not configured",
      backupInventoryKey: BACKUP_INVENTORY_KEYS[version],
      ingestOldestDay: null,
      ingestError: null,
    };
    sourceCache = { cacheKey, expiresAt: Date.now() + SOURCE_CACHE_TTL_MS, value };
    return value;
  }

  const [observationsResult, aqilevelsResult, backupResult, ingestResult] = await Promise.allSettled([
    listR2DomainDays(bucket, version, "observations"),
    listR2DomainDays(bucket, version, "aqilevels"),
    readBackupInventory(bucket, version),
    fetchIngestOldestDay(env),
  ]);

  const observationsError = observationsResult.status === "rejected"
    ? observationsResult.reason instanceof Error
      ? observationsResult.reason.message
      : String(observationsResult.reason)
    : null;
  const aqilevelsError = aqilevelsResult.status === "rejected"
    ? aqilevelsResult.reason instanceof Error
      ? aqilevelsResult.reason.message
      : String(aqilevelsResult.reason)
    : null;
  const backupError = backupResult.status === "rejected"
    ? backupResult.reason instanceof Error
      ? backupResult.reason.message
      : String(backupResult.reason)
    : null;
  const ingestError = ingestResult.status === "rejected"
    ? ingestResult.reason instanceof Error
      ? ingestResult.reason.message
      : String(ingestResult.reason)
    : null;

  const value: CoverageSources = {
    generatedAt,
    version,
    r2Observations: observationsResult.status === "fulfilled" ? observationsResult.value : null,
    r2Aqilevels: aqilevelsResult.status === "fulfilled" ? aqilevelsResult.value : null,
    r2Error: mergeMessages(observationsError, aqilevelsError),
    backupDays: backupResult.status === "fulfilled" ? backupResult.value.days : null,
    backupError,
    backupInventoryKey: backupResult.status === "fulfilled"
      ? backupResult.value.key
      : BACKUP_INVENTORY_KEYS[version],
    ingestOldestDay: ingestResult.status === "fulfilled" ? ingestResult.value : null,
    ingestError,
  };

  sourceCache = { cacheKey, expiresAt: Date.now() + SOURCE_CACHE_TTL_MS, value };
  return value;
}

function dayBounds(days: Set<string> | null): { earliest: string | null; latest: string | null } {
  const values = days ? Array.from(days).sort() : [];
  return {
    earliest: values.length ? values[0] : null,
    latest: values.length ? values[values.length - 1] : null,
  };
}

function enrichPayload(payload: JsonObject, sources: CoverageSources, env: WorkerEnv): JsonObject {
  const rawRows = Array.isArray(payload.storage_coverage_days) ? payload.storage_coverage_days : [];
  const rows = rawRows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = { ...(value as JsonObject) };
    const day = normaliseDay(row.date);
    if (!day) return row;

    if (sources.r2Observations) {
      const present = sources.r2Observations.has(day);
      row.r2_observs = present;
      row.r2 = present;
    }
    if (sources.r2Aqilevels) {
      row.r2_aqilevels = sources.r2Aqilevels.has(day);
    }
    if (sources.backupDays) {
      row.dropbox_observs = sources.backupDays.observations.has(day);
      row.dropbox_aqilevels = sources.backupDays.aqilevels.has(day);
    }
    if (sources.ingestOldestDay) {
      row.ingest = day >= sources.ingestOldestDay;
    }

    return row;
  });

  const observationsBounds = dayBounds(sources.backupDays?.observations || null);
  const aqilevelsBounds = dayBounds(sources.backupDays?.aqilevels || null);
  const bucketName = String(env.UK_AQ_R2_HISTORY_BUCKET || "").trim() || null;

  return {
    ...payload,
    storage_coverage_days: rows,
    storage_coverage_source: `${String(payload.storage_coverage_source || "dashboard")}+r2_binding+backup_inventory`,
    r2_history_days_bucket: bucketName || payload.r2_history_days_bucket || null,
    r2_history_days_error: mergeMessages(payload.r2_history_days_error, sources.r2Error),
    dropbox_backup_state_path: sources.backupInventoryKey
      ? `r2:${sources.backupInventoryKey}`
      : payload.dropbox_backup_state_path || null,
    dropbox_backup_state_source: sources.backupDays
      ? "r2-backup-inventory"
      : payload.dropbox_backup_state_source || null,
    dropbox_backup_state_error: sources.backupDays
      ? null
      : mergeMessages(payload.dropbox_backup_state_error, sources.backupError),
    dropbox_backup_state_warning: mergeMessages(payload.dropbox_backup_state_warning, sources.ingestError),
    dropbox_backup_observations_earliest_day: sources.backupDays
      ? observationsBounds.earliest
      : payload.dropbox_backup_observations_earliest_day || null,
    dropbox_backup_observations_latest_day: sources.backupDays
      ? observationsBounds.latest
      : payload.dropbox_backup_observations_latest_day || null,
    dropbox_backup_aqilevels_earliest_day: sources.backupDays
      ? aqilevelsBounds.earliest
      : payload.dropbox_backup_aqilevels_earliest_day || null,
    dropbox_backup_aqilevels_latest_day: sources.backupDays
      ? aqilevelsBounds.latest
      : payload.dropbox_backup_aqilevels_latest_day || null,
    storage_coverage_enrichment: {
      generated_at: sources.generatedAt,
      read_version: sources.version,
      r2_binding: Boolean(env.R2_HISTORY),
      r2_observations_day_count: sources.r2Observations?.size ?? null,
      r2_aqilevels_day_count: sources.r2Aqilevels?.size ?? null,
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
  } catch (_err) {
    return response;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response;
  if (!Array.isArray((payload as JsonObject).storage_coverage_days)) return response;

  const sources = await loadCoverageSources(request, env);
  const enriched = enrichPayload(payload as JsonObject, sources, env);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-ukaq-storage-coverage", "r2-binding+backup-inventory");

  return new Response(JSON.stringify(enriched), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
