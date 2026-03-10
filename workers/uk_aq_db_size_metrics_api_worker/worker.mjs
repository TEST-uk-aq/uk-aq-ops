import {
  hasRequiredR2Config,
  normalizePrefix,
  r2ListObjectsV2,
  r2ListAllCommonPrefixes,
} from "../shared/r2_sigv4.mjs";

const DEFAULT_LOOKBACK_DAYS = 28;
const MAX_LOOKBACK_DAYS = 120;
const R2_HISTORY_DAYS_MAX_LOOKBACK_DAYS = 3660;
const R2_HISTORY_DAYS_DEFAULT_MAX_LOOKBACK_DAYS = 120;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
    },
  });
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseNonNegativeInt(raw, fallback) {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
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

function normalizeBucketName(value) {
  const bucket = String(value || "").trim();
  if (!bucket) {
    return "";
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    return "";
  }
  return bucket;
}

function normalizeDbSizeRows(rows, expectedLabel) {
  const normalized = [];

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }

    const rowLabel = String(row.database_label || "").trim().toLowerCase();
    const label = rowLabel || expectedLabel;
    if (label !== "ingestdb" && label !== "obs_aqidb") {
      continue;
    }
    if (expectedLabel && label !== expectedLabel) {
      continue;
    }

    const bucketHour = toIsoOrNull(row.bucket_hour);
    if (!bucketHour) {
      continue;
    }

    const rawSize = Number(row.size_bytes);
    if (!Number.isFinite(rawSize) || rawSize < 0) {
      continue;
    }

    normalized.push({
      bucket_hour: bucketHour,
      database_label: label,
      database_name: typeof row.database_name === "string" ? row.database_name : null,
      size_bytes: Math.trunc(rawSize),
      oldest_observed_at: toIsoOrNull(row.oldest_observed_at),
      recorded_at: toIsoOrNull(row.recorded_at),
    });
  }

  normalized.sort((a, b) => {
    const aMs = Date.parse(a.bucket_hour) || 0;
    const bMs = Date.parse(b.bucket_hour) || 0;
    if (aMs !== bMs) {
      return aMs - bMs;
    }
    return a.database_label.localeCompare(b.database_label);
  });

  return normalized;
}

function mergeAndSortRows(allRows) {
  const merged = allRows.flat();
  merged.sort((a, b) => {
    const aMs = Date.parse(a.bucket_hour) || 0;
    const bMs = Date.parse(b.bucket_hour) || 0;
    if (aMs !== bMs) {
      return aMs - bMs;
    }
    return a.database_label.localeCompare(b.database_label);
  });
  return merged;
}

function extractApiToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const url = new URL(request.url);
  return (url.searchParams.get("token") || "").trim();
}

function isAuthorized(request, env) {
  const requiredToken = String(env.UK_AQ_DB_SIZE_API_TOKEN || "").trim();
  if (!requiredToken) {
    return true;
  }
  const provided = extractApiToken(request);
  return provided && provided === requiredToken;
}

function sourceConfigs(env) {
  const ingestUrl = String(env.SUPABASE_URL || "").trim();
  const ingestKey = String(env.SB_SECRET_KEY || "").trim();
  const obsAqiUrl = String(env.OBS_AQIDB_SUPABASE_URL || "").trim();
  const obsAqiKey = String(env.OBS_AQIDB_SECRET_KEY || "").trim();

  const configs = [];

  if (ingestUrl && ingestKey) {
    configs.push({ label: "ingestdb", baseUrl: ingestUrl.replace(/\/$/, ""), key: ingestKey });
  }
  if (obsAqiUrl && obsAqiKey) {
    configs.push({ label: "obs_aqidb", baseUrl: obsAqiUrl.replace(/\/$/, ""), key: obsAqiKey });
  }

  return configs;
}

function resolveR2Config(env, bucketName) {
  return {
    endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
    bucket: String(bucketName || "").trim(),
    region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim(),
  };
}

function resolveR2HistoryBucket(env) {
  const bucket = normalizeBucketName(env.CFLARE_R2_BUCKET || env.R2_BUCKET || "");
  if (!bucket) {
    throw new Error("Missing bucket env CFLARE_R2_BUCKET/R2_BUCKET");
  }
  return bucket;
}

function sortedDayArray(daySet, maxLookbackDays) {
  const sorted = Array.from(daySet).sort((a, b) => a.localeCompare(b));
  if (maxLookbackDays <= 0 || sorted.length === 0) {
    return sorted;
  }
  const cutoff = new Date(Date.now() - maxLookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return sorted.filter((day) => day >= cutoff);
}

function buildDayCutoff(maxLookbackDays) {
  if (!Number.isFinite(maxLookbackDays) || maxLookbackDays <= 0) {
    return null;
  }
  const now = new Date();
  const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfTodayUtc - maxLookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function enumerateMonthKeys(startDay, endDay) {
  const parsedStart = parseIsoDay(startDay);
  const parsedEnd = parseIsoDay(endDay);
  if (!parsedStart || !parsedEnd || parsedStart > parsedEnd) {
    return [];
  }
  const [startYear, startMonth] = parsedStart.split("-").slice(0, 2).map((v) => Number(v));
  const [endYear, endMonth] = parsedEnd.split("-").slice(0, 2).map((v) => Number(v));
  if (!Number.isFinite(startYear) || !Number.isFinite(startMonth) || !Number.isFinite(endYear) || !Number.isFinite(endMonth)) {
    return [];
  }
  const months = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function collectMonthKeysFromDayPrefixes(folderPrefixes) {
  const monthKeys = new Set();
  for (const prefix of folderPrefixes) {
    const match = prefix.match(/day_utc=(\d{4}-\d{2}-\d{2})\/$/);
    if (!match) {
      continue;
    }
    const day = parseIsoDay(match[1]);
    if (!day) {
      continue;
    }
    monthKeys.add(day.slice(0, 7));
  }
  return Array.from(monthKeys).sort((a, b) => a.localeCompare(b));
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listCommittedDaysForDomain({
  r2,
  domainPrefix,
  maxKeys,
  maxLookbackDays,
}) {
  const cutoffDay = buildDayCutoff(maxLookbackDays);
  const todayDay = new Date().toISOString().slice(0, 10);
  const monthKeys = cutoffDay
    ? enumerateMonthKeys(cutoffDay, todayDay)
    : collectMonthKeysFromDayPrefixes(await r2ListAllCommonPrefixes({
      r2,
      prefix: `${domainPrefix}/`,
      delimiter: "/",
      max_keys: maxKeys,
    }));

  const dayManifestPattern = new RegExp(
    `^${escapeRegex(domainPrefix)}/day_utc=(\\d{4}-\\d{2}-\\d{2})/manifest\\.json$`,
  );
  const discoveredDays = new Set();
  for (const monthKey of monthKeys) {
    const monthPrefix = `${domainPrefix}/day_utc=${monthKey}-`;
    let token = null;
    for (;;) {
      const page = await r2ListObjectsV2({
        r2,
        prefix: monthPrefix,
        continuation_token: token,
        max_keys: maxKeys,
      });
      const entries = Array.isArray(page.entries) ? page.entries : [];
      for (const entry of entries) {
        const key = String(entry && entry.key ? entry.key : "");
        const keyMatch = key.match(dayManifestPattern);
        if (!keyMatch) {
          continue;
        }
        const day = parseIsoDay(keyMatch[1]);
        if (!day) {
          continue;
        }
        if (cutoffDay && day < cutoffDay) {
          continue;
        }
        discoveredDays.add(day);
      }
      if (!page.next_token) {
        break;
      }
      token = page.next_token;
    }
  }

  const days = sortedDayArray(discoveredDays, 0);
  const minDay = days.length ? days[0] : null;
  const maxDay = days.length ? days[days.length - 1] : null;
  return {
    days,
    min_day_utc: minDay,
    max_day_utc: maxDay,
    day_count: days.length,
  };
}

async function fetchR2HistoryDays(env, url) {
  const maxKeys = Math.max(
    100,
    Math.min(1000, parsePositiveInt(url.searchParams.get("max_keys"), 1000)),
  );
  const maxLookbackDays = Math.max(
    0,
    Math.min(
      R2_HISTORY_DAYS_MAX_LOOKBACK_DAYS,
      parseNonNegativeInt(
        url.searchParams.get("max_days"),
        R2_HISTORY_DAYS_DEFAULT_MAX_LOOKBACK_DAYS,
      ),
    ),
  );

  const bucket = resolveR2HistoryBucket(env);
  const r2 = resolveR2Config(env, bucket);
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for history days API (endpoint/bucket/region/access credentials)");
  }

  const observationsPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || "history/v1/observations",
  );
  const aqilevelsPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || "history/v1/aqilevels",
  );

  const observations = await listCommittedDaysForDomain({
    r2,
    domainPrefix: observationsPrefix,
    maxKeys,
    maxLookbackDays,
  });
  const aqilevels = await listCommittedDaysForDomain({
    r2,
    domainPrefix: aqilevelsPrefix,
    maxKeys,
    maxLookbackDays,
  });

  return {
    bucket,
    max_keys: maxKeys,
    max_days: maxLookbackDays,
    prefixes: {
      observations: observationsPrefix,
      aqilevels: aqilevelsPrefix,
    },
    domains: {
      observations,
      aqilevels,
    },
    source: "cloudflare_r2_manifest_scan",
  };
}

async function fetchDbSizeRowsForSource(env, source, lookbackDays) {
  const publicSchema = String(env.UK_AQ_PUBLIC_SCHEMA || "uk_aq_public").trim() || "uk_aq_public";
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    select: "bucket_hour,database_label,database_name,size_bytes,oldest_observed_at,recorded_at",
    bucket_hour: `gte.${since}`,
    order: "bucket_hour.asc",
    limit: "5000",
  });

  const response = await fetch(`${source.baseUrl}/rest/v1/uk_aq_db_size_metrics_hourly?${query.toString()}`, {
    method: "GET",
    headers: {
      apikey: source.key,
      Authorization: `Bearer ${source.key}`,
      Accept: "application/json",
      "Accept-Profile": publicSchema,
      "x-ukaq-egress-caller": "uk_aq_db_size_metrics_api_worker",
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && !Array.isArray(payload) && (payload.message || payload.error_description || payload.error)) ||
      (typeof text === "string" ? text.slice(0, 400) : "") ||
      `HTTP ${response.status}`;
    throw new Error(`Supabase db-size fetch failed (${response.status}): ${String(message)}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error("Supabase db-size fetch returned non-array payload");
  }

  return normalizeDbSizeRows(payload, source.label);
}

function normalizeSchemaSizeRows(rows) {
  const normalized = [];

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }

    const label = String(row.database_label || "").trim().toLowerCase();
    const schemaName = String(row.schema_name || "").trim().toLowerCase();
    if (label !== "obs_aqidb") {
      continue;
    }
    if (schemaName !== "uk_aq_observs" && schemaName !== "uk_aq_aqilevels") {
      continue;
    }

    const bucketHour = toIsoOrNull(row.bucket_hour);
    if (!bucketHour) {
      continue;
    }

    const rawSize = Number(row.size_bytes);
    if (!Number.isFinite(rawSize) || rawSize < 0) {
      continue;
    }

    normalized.push({
      bucket_hour: bucketHour,
      database_label: label,
      schema_name: schemaName,
      size_bytes: Math.trunc(rawSize),
      oldest_observed_at: toIsoOrNull(row.oldest_observed_at),
      recorded_at: toIsoOrNull(row.recorded_at),
    });
  }

  normalized.sort((a, b) => {
    const aMs = Date.parse(a.bucket_hour) || 0;
    const bMs = Date.parse(b.bucket_hour) || 0;
    if (aMs !== bMs) {
      return aMs - bMs;
    }
    return a.schema_name.localeCompare(b.schema_name);
  });

  return normalized;
}

function normalizeR2DomainSizeRows(rows) {
  const normalized = [];

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }

    const domainName = String(row.domain_name || "").trim().toLowerCase();
    if (domainName !== "observations" && domainName !== "aqilevels") {
      continue;
    }

    const bucketHour = toIsoOrNull(row.bucket_hour);
    if (!bucketHour) {
      continue;
    }

    const rawSize = Number(row.size_bytes);
    if (!Number.isFinite(rawSize) || rawSize < 0) {
      continue;
    }

    normalized.push({
      bucket_hour: bucketHour,
      domain_name: domainName,
      size_bytes: Math.trunc(rawSize),
      recorded_at: toIsoOrNull(row.recorded_at),
    });
  }

  normalized.sort((a, b) => {
    const aMs = Date.parse(a.bucket_hour) || 0;
    const bMs = Date.parse(b.bucket_hour) || 0;
    if (aMs !== bMs) {
      return aMs - bMs;
    }
    return a.domain_name.localeCompare(b.domain_name);
  });

  return normalized;
}

async function fetchMetricViewRowsFromSource({
  env,
  lookbackDays,
  sourceLabel,
  sourceUrl,
  sourceKey,
  viewName,
  select,
  normalizeFn,
}) {
  const publicSchema = String(env.UK_AQ_PUBLIC_SCHEMA || "uk_aq_public").trim() || "uk_aq_public";

  if (!sourceUrl || !sourceKey) {
    return { rows: [], warning: `${sourceLabel}: missing source URL or source key` };
  }

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    select,
    bucket_hour: `gte.${since}`,
    order: "bucket_hour.asc",
    limit: "5000",
  });

  const response = await fetch(`${sourceUrl.replace(/\/$/, "")}/rest/v1/${viewName}?${query.toString()}`, {
    method: "GET",
    headers: {
      apikey: sourceKey,
      Authorization: `Bearer ${sourceKey}`,
      Accept: "application/json",
      "Accept-Profile": publicSchema,
      "x-ukaq-egress-caller": "uk_aq_db_size_metrics_api_worker",
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && !Array.isArray(payload) && (payload.message || payload.error_description || payload.error)) ||
      (typeof text === "string" ? text.slice(0, 400) : "") ||
      `HTTP ${response.status}`;
    return { rows: [], warning: `${sourceLabel}/${viewName}: ${String(message)}` };
  }

  if (!Array.isArray(payload)) {
    return { rows: [], warning: `${sourceLabel}/${viewName}: non-array payload` };
  }

  return { rows: normalizeFn(payload), warning: null };
}

async function fetchSchemaSizeRows(env, lookbackDays) {
  const obsAqiUrl = String(env.OBS_AQIDB_SUPABASE_URL || "").trim();
  const obsAqiKey = String(env.OBS_AQIDB_SECRET_KEY || "").trim();
  if (!obsAqiUrl || !obsAqiKey) {
    return { rows: [], warning: "obs_aqidb: missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY" };
  }
  return fetchMetricViewRowsFromSource({
    env,
    lookbackDays,
    sourceLabel: "obs_aqidb",
    sourceUrl: obsAqiUrl,
    sourceKey: obsAqiKey,
    viewName: "uk_aq_schema_size_metrics_hourly",
    select: "bucket_hour,database_label,schema_name,size_bytes,oldest_observed_at,recorded_at",
    normalizeFn: normalizeSchemaSizeRows,
  });
}

async function fetchR2DomainSizeRows(env, lookbackDays) {
  const ingestUrl = String(env.SUPABASE_URL || "").trim();
  const ingestKey = String(env.SB_SECRET_KEY || "").trim();
  if (!ingestUrl || !ingestKey) {
    return { rows: [], warning: "ingestdb: missing SUPABASE_URL or SB_SECRET_KEY" };
  }
  return fetchMetricViewRowsFromSource({
    env,
    lookbackDays,
    sourceLabel: "ingestdb",
    sourceUrl: ingestUrl,
    sourceKey: ingestKey,
    viewName: "uk_aq_r2_domain_size_metrics_hourly",
    select: "bucket_hour,domain_name,size_bytes,recorded_at",
    normalizeFn: normalizeR2DomainSizeRows,
  });
}

function latestOldestByLabel(rows) {
  const out = {
    ingestdb: null,
    obs_aqidb: null,
  };
  for (const row of rows) {
    const label = row.database_label;
    if (!(label in out)) {
      continue;
    }
    out[label] = row.oldest_observed_at || null;
  }
  return out;
}

async function fetchAllDbSizeRows(env, lookbackDays) {
  const sources = sourceConfigs(env);
  if (sources.length === 0) {
    throw new Error("No DB source credentials configured (SUPABASE/OBS_AQIDB)");
  }

  const rowsBySource = [];
  const sourceErrors = [];

  for (const source of sources) {
    try {
      const rows = await fetchDbSizeRowsForSource(env, source, lookbackDays);
      rowsBySource.push(rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sourceErrors.push(`${source.label}: ${message}`);
    }
  }

  const merged = mergeAndSortRows(rowsBySource);
  if (merged.length === 0 && sourceErrors.length > 0) {
    throw new Error(sourceErrors.join("; "));
  }

  return {
    rows: merged,
    warning: sourceErrors.length > 0 ? sourceErrors.join("; ") : null,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const dbSizePaths = new Set(["/", "/db-size-metrics", "/v1/db-size-metrics"]);
    const r2HistoryDaysPaths = new Set(["/r2-history-days", "/v1/r2-history-days"]);
    const isDbSizePath = dbSizePaths.has(url.pathname);
    const isR2HistoryDaysPath = r2HistoryDaysPaths.has(url.pathname);

    if (!isDbSizePath && !isR2HistoryDaysPath) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    if (isR2HistoryDaysPath) {
      try {
        const result = await fetchR2HistoryDays(env, url);
        return jsonResponse({
          generated_at: new Date().toISOString(),
          ...result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResponse(
          {
            generated_at: new Date().toISOString(),
            bucket: null,
            max_keys: null,
            max_days: null,
            prefixes: {
              observations: null,
              aqilevels: null,
            },
            domains: {
              observations: {
                days: [],
                min_day_utc: null,
                max_day_utc: null,
                day_count: 0,
              },
              aqilevels: {
                days: [],
                min_day_utc: null,
                max_day_utc: null,
                day_count: 0,
              },
            },
            source: "cloudflare_r2_manifest_scan",
            error: message,
          },
          500,
        );
      }
    }

    const requestedLookback = parsePositiveInt(url.searchParams.get("lookback_days"), DEFAULT_LOOKBACK_DAYS);
    const lookbackDays = Math.max(1, Math.min(MAX_LOOKBACK_DAYS, requestedLookback));

    try {
      const result = await fetchAllDbSizeRows(env, lookbackDays);
      const schemaResult = await fetchSchemaSizeRows(env, lookbackDays);
      const r2DomainResult = await fetchR2DomainSizeRows(env, lookbackDays);
      return jsonResponse({
        generated_at: new Date().toISOString(),
        lookback_days: lookbackDays,
        db_size_metrics: result.rows,
        schema_size_metrics: schemaResult.rows,
        r2_domain_size_metrics: r2DomainResult.rows,
        oldest_by_label: latestOldestByLabel(result.rows),
        db_size_metrics_error: result.warning,
        schema_size_metrics_error: schemaResult.warning,
        r2_domain_size_metrics_error: r2DomainResult.warning,
        source: "multidb_uk_aq_public.uk_aq_db_size_metrics_hourly",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        {
          generated_at: new Date().toISOString(),
          lookback_days: lookbackDays,
          db_size_metrics: [],
          schema_size_metrics: [],
          r2_domain_size_metrics: [],
          oldest_by_label: {
            ingestdb: null,
            obs_aqidb: null,
          },
          db_size_metrics_error: message,
          schema_size_metrics_error: null,
          r2_domain_size_metrics_error: null,
        },
        500,
      );
    }
  },
};
