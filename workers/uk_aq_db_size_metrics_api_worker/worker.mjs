const DEFAULT_LOOKBACK_DAYS = 28;
const MAX_LOOKBACK_DAYS = 120;

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
    const allowedPaths = new Set(["/", "/db-size-metrics", "/v1/db-size-metrics"]);
    if (!allowedPaths.has(url.pathname)) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
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
