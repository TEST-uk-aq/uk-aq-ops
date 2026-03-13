import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2ListAllCommonPrefixes,
  r2PutObject,
} from "./r2_sigv4.mjs";

export const DEFAULT_R2_HISTORY_INDEX_PREFIX = "history/_index";
export const DEFAULT_R2_HISTORY_OBSERVATIONS_PREFIX = "history/v1/observations";
export const DEFAULT_R2_HISTORY_AQILEVELS_PREFIX = "history/v1/aqilevels";

const DEFAULT_FETCH_CONCURRENCY = 16;
const DEFAULT_MAX_KEYS = 1000;
const INDEX_SCHEMA_VERSION = 1;
const SUPPORTED_DOMAINS = new Set(["observations", "aqilevels"]);

function defaultEnv() {
  if (typeof process !== "undefined" && process && process.env) {
    return process.env;
  }
  return {};
}

function parsePositiveInt(raw, fallback, min = 1, max = 1_000_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  if (intValue < min) {
    return min;
  }
  if (intValue > max) {
    return max;
  }
  return intValue;
}

function parseNonNegativeInt(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

function parseIsoDay(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  const ms = Date.parse(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    return null;
  }
  return trimmed;
}

function toIsoOrNull(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function buildDayCutoff(maxLookbackDays, todayDay = new Date().toISOString().slice(0, 10)) {
  if (!Number.isFinite(maxLookbackDays) || maxLookbackDays <= 0) {
    return null;
  }
  const todayMs = Date.parse(`${todayDay}T00:00:00.000Z`);
  if (Number.isNaN(todayMs)) {
    return null;
  }
  return new Date(todayMs - maxLookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export function filterIsoDaysByLookback(
  days,
  maxLookbackDays,
  todayDay = new Date().toISOString().slice(0, 10),
) {
  const out = [];
  const seen = new Set();
  const cutoffDay = buildDayCutoff(maxLookbackDays, todayDay);
  for (const rawDay of Array.isArray(days) ? days : []) {
    const day = parseIsoDay(rawDay);
    if (!day || day > todayDay) {
      continue;
    }
    if (cutoffDay && day < cutoffDay) {
      continue;
    }
    if (!seen.has(day)) {
      seen.add(day);
      out.push(day);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function resolveDeployEnv(env) {
  return String(env.UK_AQ_DEPLOY_ENV || env.DEPLOY_ENV || "dev").trim().toLowerCase() || "dev";
}

export function resolveR2Bucket(env = defaultEnv(), deployEnv = resolveDeployEnv(env)) {
  const explicitBucket = String(env.R2_BUCKET || env.CFLARE_R2_BUCKET || "").trim();
  if (explicitBucket) {
    return explicitBucket;
  }
  if (deployEnv === "prod" || deployEnv === "production") {
    return String(env.R2_BUCKET_PROD || "").trim();
  }
  if (deployEnv === "stage" || deployEnv === "staging") {
    return String(env.R2_BUCKET_STAGE || "").trim();
  }
  return String(env.R2_BUCKET_DEV || "").trim();
}

export function resolveR2HistoryIndexConfig(env = defaultEnv()) {
  const deployEnv = resolveDeployEnv(env);
  return {
    deploy_env: deployEnv,
    r2: {
      endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
      bucket: resolveR2Bucket(env, deployEnv),
      region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
      access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
      secret_access_key: String(
        env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "",
      ).trim(),
    },
    observations_prefix: normalizePrefix(
      env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || DEFAULT_R2_HISTORY_OBSERVATIONS_PREFIX,
    ),
    aqilevels_prefix: normalizePrefix(
      env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || DEFAULT_R2_HISTORY_AQILEVELS_PREFIX,
    ),
    index_prefix: normalizePrefix(
      env.UK_AQ_R2_HISTORY_INDEX_PREFIX || DEFAULT_R2_HISTORY_INDEX_PREFIX,
    ),
    fetch_concurrency: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_INDEX_FETCH_CONCURRENCY,
      DEFAULT_FETCH_CONCURRENCY,
      1,
      128,
    ),
    max_keys: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_INDEX_MAX_KEYS,
      DEFAULT_MAX_KEYS,
      100,
      1000,
    ),
  };
}

export function buildR2HistoryIndexKey(indexPrefix, domain) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (!SUPPORTED_DOMAINS.has(normalizedDomain)) {
    throw new Error(`Unsupported R2 history index domain: ${String(domain || "")}`);
  }
  const prefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_INDEX_PREFIX);
  return `${prefix}/${normalizedDomain}_latest.json`;
}

function parseDayFromPrefix(prefixValue, domainPrefix) {
  const prefix = String(prefixValue || "");
  const escapedPrefix = String(domainPrefix || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = prefix.match(new RegExp(`^${escapedPrefix}/day_utc=(\\d{4}-\\d{2}-\\d{2})/$`));
  if (!match) {
    return null;
  }
  return parseIsoDay(match[1]);
}

function aggregateConnectorsFromFiles(files) {
  const connectorMap = new Map();
  for (const entry of Array.isArray(files) ? files : []) {
    const connectorId = parseNonNegativeInt(entry?.connector_id);
    const rowCount = parseNonNegativeInt(entry?.row_count);
    if (!connectorId || rowCount === null) {
      continue;
    }
    const key = String(connectorId);
    const current = connectorMap.get(key) || {
      connector_id: connectorId,
      row_count: 0,
      file_count: 0,
      total_bytes: 0,
      manifest_key: null,
    };
    current.row_count += rowCount;
    current.file_count += 1;
    current.total_bytes += parseNonNegativeInt(entry?.bytes) || 0;
    connectorMap.set(key, current);
  }
  return Array.from(connectorMap.values()).sort((a, b) => a.connector_id - b.connector_id);
}

function extractConnectorSummaries(manifest) {
  const connectorManifestEntries = Array.isArray(manifest?.connector_manifests)
    ? manifest.connector_manifests
    : [];
  if (connectorManifestEntries.length) {
    const connectors = [];
    for (const entry of connectorManifestEntries) {
      const connectorId = parseNonNegativeInt(entry?.connector_id);
      const rowCount = parseNonNegativeInt(entry?.source_row_count);
      if (!connectorId || rowCount === null) {
        continue;
      }
      connectors.push({
        connector_id: connectorId,
        row_count: rowCount,
        file_count: parseNonNegativeInt(entry?.file_count) || 0,
        total_bytes: parseNonNegativeInt(entry?.total_bytes) || 0,
        manifest_key: typeof entry?.manifest_key === "string" && entry.manifest_key.trim()
          ? entry.manifest_key.trim()
          : null,
      });
    }
    connectors.sort((a, b) => a.connector_id - b.connector_id);
    return connectors;
  }
  return aggregateConnectorsFromFiles(manifest?.files);
}

export function buildDaySummaryFromManifest({ domain, dayUtc, manifest }) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (!SUPPORTED_DOMAINS.has(normalizedDomain)) {
    throw new Error(`Unsupported R2 history index domain: ${String(domain || "")}`);
  }

  const manifestDay = parseIsoDay(manifest?.day_utc) || parseIsoDay(dayUtc);
  if (!manifestDay) {
    return null;
  }

  const connectors = extractConnectorSummaries(manifest);
  const connectorRowTotal = connectors.reduce((sum, entry) => sum + entry.row_count, 0);
  const totalRows = parseNonNegativeInt(manifest?.source_row_count) ?? connectorRowTotal;
  const totalBytes = parseNonNegativeInt(manifest?.total_bytes)
    ?? connectors.reduce((sum, entry) => sum + entry.total_bytes, 0);
  const fileCount = parseNonNegativeInt(manifest?.file_count)
    ?? connectors.reduce((sum, entry) => sum + entry.file_count, 0);

  const base = {
    day_utc: manifestDay,
    total_rows: totalRows,
    connector_count: connectors.length,
    file_count: fileCount,
    total_bytes: totalBytes,
    connectors,
    run_id: typeof manifest?.run_id === "string" && manifest.run_id.trim()
      ? manifest.run_id.trim()
      : null,
    backed_up_at_utc: toIsoOrNull(manifest?.backed_up_at_utc),
    manifest_hash: typeof manifest?.manifest_hash === "string" && manifest.manifest_hash.trim()
      ? manifest.manifest_hash.trim()
      : null,
  };

  if (normalizedDomain === "observations") {
    return {
      ...base,
      min_observed_at: toIsoOrNull(manifest?.min_observed_at),
      max_observed_at: toIsoOrNull(manifest?.max_observed_at),
    };
  }

  return {
    ...base,
    min_timestamp_hour_utc: toIsoOrNull(manifest?.min_timestamp_hour_utc),
    max_timestamp_hour_utc: toIsoOrNull(manifest?.max_timestamp_hour_utc),
  };
}

export function buildDomainIndexPayload({
  domain,
  prefix,
  bucket,
  generatedAt,
  daySummaries,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (!SUPPORTED_DOMAINS.has(normalizedDomain)) {
    throw new Error(`Unsupported R2 history index domain: ${String(domain || "")}`);
  }
  const sortedSummaries = Array.from(Array.isArray(daySummaries) ? daySummaries : [])
    .filter((entry) => entry && typeof entry === "object")
    .sort((a, b) => String(a.day_utc || "").localeCompare(String(b.day_utc || "")));
  const days = sortedSummaries
    .map((entry) => parseIsoDay(entry.day_utc))
    .filter(Boolean);
  const totalRows = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.total_rows) || 0),
    0,
  );
  return {
    schema_version: INDEX_SCHEMA_VERSION,
    generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
    source: "r2_day_manifests",
    domain: normalizedDomain,
    bucket: String(bucket || "").trim() || null,
    prefix: normalizePrefix(prefix || ""),
    min_day_utc: days.length ? days[0] : null,
    max_day_utc: days.length ? days[days.length - 1] : null,
    day_count: days.length,
    total_rows: totalRows,
    days,
    day_summaries: sortedSummaries,
  };
}

export function normalizeR2HistoryIndexDomain(
  payload,
  { expectedDomain, maxLookbackDays = 0, todayDay } = {},
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("R2 history index payload must be an object");
  }
  const domain = String(payload.domain || "").trim().toLowerCase();
  if (!SUPPORTED_DOMAINS.has(domain)) {
    throw new Error(`R2 history index payload has unsupported domain: ${String(payload.domain || "")}`);
  }
  if (expectedDomain && domain !== String(expectedDomain).trim().toLowerCase()) {
    throw new Error(
      `R2 history index payload domain mismatch: expected ${expectedDomain}, got ${domain}`,
    );
  }

  const rawDaySummaries = Array.isArray(payload.day_summaries) ? payload.day_summaries : [];
  const summaryMap = new Map();
  for (const entry of rawDaySummaries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const day = parseIsoDay(entry.day_utc);
    if (!day) {
      continue;
    }
    summaryMap.set(day, {
      ...entry,
      day_utc: day,
      total_rows: parseNonNegativeInt(entry.total_rows) || 0,
      connector_count: parseNonNegativeInt(entry.connector_count) || 0,
      file_count: parseNonNegativeInt(entry.file_count) || 0,
      total_bytes: parseNonNegativeInt(entry.total_bytes) || 0,
    });
  }

  const rawDays = Array.isArray(payload.days) && payload.days.length
    ? payload.days
    : Array.from(summaryMap.keys());
  const days = filterIsoDaysByLookback(rawDays, maxLookbackDays, todayDay);
  const filteredSummaries = days
    .map((day) => summaryMap.get(day))
    .filter(Boolean);

  return {
    schema_version: parseNonNegativeInt(payload.schema_version) || INDEX_SCHEMA_VERSION,
    generated_at: toIsoOrNull(payload.generated_at),
    source: typeof payload.source === "string" && payload.source.trim()
      ? payload.source.trim()
      : "r2_day_manifests",
    domain,
    bucket: typeof payload.bucket === "string" && payload.bucket.trim()
      ? payload.bucket.trim()
      : null,
    prefix: typeof payload.prefix === "string" && payload.prefix.trim()
      ? normalizePrefix(payload.prefix)
      : null,
    min_day_utc: days.length ? days[0] : null,
    max_day_utc: days.length ? days[days.length - 1] : null,
    day_count: days.length,
    total_rows: filteredSummaries.reduce((sum, entry) => sum + (entry.total_rows || 0), 0),
    days,
    day_summaries: filteredSummaries,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(items.length, parsePositiveInt(concurrency, 1, 1, 512)));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export async function rebuildR2HistoryIndexForDomain({
  r2,
  bucketName,
  domain,
  domainPrefix,
  indexPrefix = DEFAULT_R2_HISTORY_INDEX_PREFIX,
  generatedAt = new Date().toISOString(),
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  maxKeys = DEFAULT_MAX_KEYS,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (!SUPPORTED_DOMAINS.has(normalizedDomain)) {
    throw new Error(`Unsupported R2 history index domain: ${String(domain || "")}`);
  }
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for R2 history index rebuild");
  }

  const normalizedPrefix = normalizePrefix(domainPrefix);
  const dayPrefixes = await r2ListAllCommonPrefixes({
    r2,
    prefix: `${normalizedPrefix}/`,
    delimiter: "/",
    max_keys: maxKeys,
  });
  const dayList = dayPrefixes
    .map((prefix) => parseDayFromPrefix(prefix, normalizedPrefix))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const warnings = [];
  const summaries = (await mapWithConcurrency(dayList, fetchConcurrency, async (dayUtc) => {
    const manifestKey = `${normalizedPrefix}/day_utc=${dayUtc}/manifest.json`;
    try {
      const object = await r2GetObject({ r2, key: manifestKey });
      const manifest = JSON.parse(object.body.toString("utf8"));
      const summary = buildDaySummaryFromManifest({
        domain: normalizedDomain,
        dayUtc,
        manifest,
      });
      if (!summary) {
        warnings.push(`Skipped invalid ${normalizedDomain} day manifest for ${dayUtc}`);
      }
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(404)")) {
        warnings.push(`Skipped missing ${normalizedDomain} day manifest for ${dayUtc}`);
        return null;
      }
      throw new Error(`Failed to read ${normalizedDomain} day manifest ${manifestKey}: ${message}`);
    }
  })).filter(Boolean);

  const payload = buildDomainIndexPayload({
    domain: normalizedDomain,
    prefix: normalizedPrefix,
    bucket: bucketName || r2.bucket,
    generatedAt,
    daySummaries: summaries,
  });
  const indexKey = buildR2HistoryIndexKey(indexPrefix, normalizedDomain);
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const putResult = await r2PutObject({
    r2,
    key: indexKey,
    body,
    content_type: "application/json; charset=utf-8",
  });

  return {
    domain: normalizedDomain,
    index_key: indexKey,
    index_bytes: putResult.bytes,
    day_prefix_count: dayList.length,
    indexed_day_count: payload.day_count,
    total_rows: payload.total_rows,
    warning_count: warnings.length,
    warnings,
  };
}

export async function rebuildR2HistoryIndexes({
  env = defaultEnv(),
  domains = ["observations", "aqilevels"],
  generatedAt = new Date().toISOString(),
  fetchConcurrency,
  maxKeys,
} = {}) {
  const config = resolveR2HistoryIndexConfig(env);
  if (!hasRequiredR2Config(config.r2)) {
    throw new Error("Missing R2 config for R2 history index rebuild");
  }

  const normalizedDomains = Array.from(new Set(
    (Array.isArray(domains) ? domains : []).map((domain) =>
      String(domain || "").trim().toLowerCase()
    ),
  )).filter((domain) => SUPPORTED_DOMAINS.has(domain));

  if (!normalizedDomains.length) {
    throw new Error("No supported domains requested for R2 history index rebuild");
  }

  const results = [];
  for (const domain of normalizedDomains) {
    const domainPrefix = domain === "observations"
      ? config.observations_prefix
      : config.aqilevels_prefix;
    results.push(await rebuildR2HistoryIndexForDomain({
      r2: config.r2,
      bucketName: config.r2.bucket,
      domain,
      domainPrefix,
      indexPrefix: config.index_prefix,
      generatedAt,
      fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
      maxKeys: maxKeys || config.max_keys,
    }));
  }

  return {
    generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
    bucket: config.r2.bucket,
    index_prefix: config.index_prefix,
    observations_prefix: config.observations_prefix,
    aqilevels_prefix: config.aqilevels_prefix,
    results,
  };
}

export async function readR2HistoryIndex({
  r2,
  indexKey,
  domain,
  maxLookbackDays = 0,
  todayDay,
}) {
  const object = await r2GetObject({ r2, key: indexKey });
  let payload;
  try {
    payload = JSON.parse(object.body.toString("utf8"));
  } catch (_error) {
    throw new Error(`R2 history index ${indexKey} returned invalid JSON`);
  }
  return normalizeR2HistoryIndexDomain(payload, {
    expectedDomain: domain,
    maxLookbackDays,
    todayDay,
  });
}
