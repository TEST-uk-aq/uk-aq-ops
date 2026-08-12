import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2ListAllCommonPrefixes,
} from "../shared/r2_sigv4.mjs";

const BACKUP_INVENTORY_KEYS = {
  v1: "history/_index/backup_inventory_v1.json",
  v2: "history/_index_v2/backup_inventory_v2/root.json",
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const INVENTORY_CACHE_TTL_MS = 5 * 60 * 1000;

let inventoryCache = null;

function normaliseDay(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match && DAY_RE.test(match[1]) ? match[1] : null;
}

function buildCutoff(maxDays) {
  const days = Number(maxDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtc - Math.trunc(days) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function resolveR2Config(env, bucket) {
  return {
    endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
    bucket: String(bucket || "").trim(),
    region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim(),
  };
}

async function listDomainDays({ r2, prefix, maxKeys, maxDays }) {
  const normalisedPrefix = normalizePrefix(prefix);
  if (!normalisedPrefix) return [];

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = buildCutoff(maxDays);
  const pattern = new RegExp(
    `^${normalisedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/day_utc=(\\d{4}-\\d{2}-\\d{2})/$`,
  );
  const commonPrefixes = await r2ListAllCommonPrefixes({
    r2,
    prefix: `${normalisedPrefix}/`,
    delimiter: "/",
    max_keys: Math.max(100, Math.min(1000, Number(maxKeys) || 1000)),
  });

  const days = new Set();
  for (const candidate of commonPrefixes) {
    const match = String(candidate || "").match(pattern);
    const day = match ? normaliseDay(match[1]) : null;
    if (!day || day > today || (cutoff && day < cutoff)) continue;
    days.add(day);
  }
  return Array.from(days).sort();
}

function domainSummary(existing, directDays, directScanSucceeded) {
  const selectedDays = directScanSucceeded
    ? directDays
    : (Array.isArray(existing?.days) ? existing.days : []);
  const normalised = new Set();
  for (const value of selectedDays || []) {
    const day = normaliseDay(value);
    if (day) normalised.add(day);
  }
  const days = Array.from(normalised).sort();
  return {
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    days,
    min_day_utc: days.length ? days[0] : null,
    max_day_utc: days.length ? days[days.length - 1] : null,
    day_count: days.length,
  };
}

function collectInventoryDays(payload, version) {
  const domains = {
    observations: new Set(),
    aqilevels: new Set(),
  };
  const patterns = {
    observations: new RegExp(
      `(?:^|/)(?:history/)?${version}/observations/day_utc=(\\d{4}-\\d{2}-\\d{2})(?:/|$)`,
      "g",
    ),
    aqilevels: new RegExp(
      `(?:^|/)(?:history/)?${version}/aqilevels(?:/hourly(?:/data)?)?/day_utc=(\\d{4}-\\d{2}-\\d{2})(?:/|$)`,
      "g",
    ),
  };
  const stack = [payload];

  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        stack.push(key, child);
      }
      continue;
    }
    if (typeof value !== "string") continue;

    for (const domain of ["observations", "aqilevels"]) {
      const pattern = patterns[domain];
      pattern.lastIndex = 0;
      for (const match of value.matchAll(pattern)) {
        const day = normaliseDay(match[1]);
        if (day) domains[domain].add(day);
      }
    }
  }

  return {
    observations: Array.from(domains.observations).sort(),
    aqilevels: Array.from(domains.aqilevels).sort(),
  };
}

async function readBackupInventory(r2, version) {
  const key = BACKUP_INVENTORY_KEYS[version];
  const cacheKey = `${r2.bucket}:${key}`;
  if (inventoryCache && inventoryCache.key === cacheKey && Date.now() < inventoryCache.expiresAt) {
    return inventoryCache.value;
  }

  const object = await r2GetObject({ r2, key });
  let payload;
  try {
    payload = JSON.parse(object.body.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Backup inventory JSON is invalid: ${detail}`);
  }

  let days;
  if (version === "v2") {
    if (
      payload.kind !== "uk_aq_r2_history_backup_inventory_v2_root"
      || payload.backup_version !== "v2"
      || !Array.isArray(payload.observations?.years)
    ) {
      throw new Error("Hierarchical v2 backup inventory root identity is invalid");
    }
    const monthReferences = payload.observations.years.flatMap((yearEntry) => {
      const year = String(yearEntry?.year || "").trim();
      if (!/^\d{4}$/.test(year) || !Array.isArray(yearEntry?.months)) {
        throw new Error("Hierarchical v2 backup inventory year entry is invalid");
      }
      return yearEntry.months.map((monthEntry) => {
        const month = String(monthEntry?.month || "").trim().padStart(2, "0");
        const key = String(monthEntry?.inventory_shard_key || "").trim();
        if (!/^(0[1-9]|1[0-2])$/.test(month) || !key) {
          throw new Error("Hierarchical v2 backup inventory month entry is invalid");
        }
        return { year, month, key };
      });
    });
    const observations = new Set();
    const monthPayloads = await Promise.all(monthReferences.map(async (reference) => {
      const monthObject = await r2GetObject({ r2, key: reference.key });
      let monthPayload;
      try {
        monthPayload = JSON.parse(monthObject.body.toString("utf8"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Backup inventory month JSON is invalid (${reference.key}): ${detail}`);
      }
      if (
        monthPayload?.kind !== "uk_aq_r2_history_backup_inventory_observations_month"
        || monthPayload?.backup_version !== "v2"
        || String(monthPayload?.year || "") !== reference.year
        || String(monthPayload?.month || "").padStart(2, "0") !== reference.month
        || !Array.isArray(monthPayload?.days)
      ) {
        throw new Error(`Backup inventory month identity is invalid: ${reference.key}`);
      }
      return monthPayload;
    }));
    for (const monthPayload of monthPayloads) {
      for (const entry of monthPayload.days) {
        const day = normaliseDay(entry?.day_utc);
        if (!day) throw new Error("Backup inventory month contains invalid day_utc");
        observations.add(day);
      }
    }
    days = {
      observations: Array.from(observations).sort(),
      aqilevels: [],
    };
  } else {
    days = collectInventoryDays(payload, version);
  }
  const value = {
    key,
    source: version === "v2"
      ? "r2_hierarchical_backup_inventory"
      : "r2_backup_inventory",
    error: null,
    domains: {
      observations: {
        days: days.observations,
        min_day_utc: days.observations[0] || null,
        max_day_utc: days.observations[days.observations.length - 1] || null,
        day_count: days.observations.length,
      },
      aqilevels: {
        days: days.aqilevels,
        min_day_utc: days.aqilevels[0] || null,
        max_day_utc: days.aqilevels[days.aqilevels.length - 1] || null,
        day_count: days.aqilevels.length,
      },
    },
  };
  inventoryCache = {
    key: cacheKey,
    expiresAt: Date.now() + INVENTORY_CACHE_TTL_MS,
    value,
  };
  return value;
}

export async function enrichR2HistoryDaysResponse(response, env) {
  if (!response.ok) return response;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch (_error) {
    return response;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response;

  const version = String(payload.read_version || "").trim().toLowerCase();
  if (version !== "v1" && version !== "v2") return response;
  const bucket = String(payload.bucket || "").trim();
  const r2 = resolveR2Config(env, bucket);
  if (!hasRequiredR2Config(r2)) return response;

  const prefixes = payload.prefixes && typeof payload.prefixes === "object"
    ? payload.prefixes
    : {};
  const maxKeys = Number(payload.max_keys) || 1000;
  const maxDays = Number(payload.max_days) || 0;
  const warnings = Array.isArray(payload.warnings) ? [...payload.warnings] : [];

  const [observationsResult, aqilevelsResult, inventoryResult] = await Promise.allSettled([
    listDomainDays({
      r2,
      prefix: prefixes.observations,
      maxKeys,
      maxDays,
    }),
    listDomainDays({
      r2,
      prefix: prefixes.aqilevels,
      maxKeys,
      maxDays,
    }),
    readBackupInventory(r2, version),
  ]);

  const domains = payload.domains && typeof payload.domains === "object"
    ? payload.domains
    : {};
  const directObservations = observationsResult.status === "fulfilled"
    ? observationsResult.value
    : [];
  const directAqilevels = aqilevelsResult.status === "fulfilled"
    ? aqilevelsResult.value
    : [];

  if (observationsResult.status === "rejected") {
    warnings.push(`Direct R2 observations day scan failed: ${observationsResult.reason instanceof Error ? observationsResult.reason.message : String(observationsResult.reason)}`);
  }
  if (aqilevelsResult.status === "rejected") {
    warnings.push(`Direct R2 AQI day scan failed: ${aqilevelsResult.reason instanceof Error ? aqilevelsResult.reason.message : String(aqilevelsResult.reason)}`);
  }

  const enrichedDomains = {
    observations: domainSummary(
      domains.observations,
      directObservations,
      observationsResult.status === "fulfilled",
    ),
    aqilevels: domainSummary(
      domains.aqilevels,
      directAqilevels,
      aqilevelsResult.status === "fulfilled",
    ),
  };
  const sources = {
    ...(payload.sources && typeof payload.sources === "object" ? payload.sources : {}),
    observations: observationsResult.status === "fulfilled"
      ? "cloudflare_r2_history_index+prefix_scan"
      : payload.sources?.observations || payload.source || null,
    aqilevels: aqilevelsResult.status === "fulfilled"
      ? "cloudflare_r2_history_index+prefix_scan"
      : payload.sources?.aqilevels || payload.source || null,
  };

  let backupInventory;
  if (inventoryResult.status === "fulfilled") {
    backupInventory = inventoryResult.value;
  } else {
    const message = inventoryResult.reason instanceof Error
      ? inventoryResult.reason.message
      : String(inventoryResult.reason);
    warnings.push(`Active backup inventory read failed: ${message}`);
    backupInventory = {
      key: BACKUP_INVENTORY_KEYS[version],
      source: "r2_backup_inventory",
      error: message,
      domains: {
        observations: { days: [], min_day_utc: null, max_day_utc: null, day_count: 0 },
        aqilevels: { days: [], min_day_utc: null, max_day_utc: null, day_count: 0 },
      },
    };
  }

  const normalised = {
    ...payload,
    domains: enrichedDomains,
    source: sources.observations === sources.aqilevels ? sources.observations : "mixed",
    sources,
    backup_inventory: backupInventory,
    warnings,
  };

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-ukaq-r2-day-source", "index+prefix-scan");
  return new Response(JSON.stringify(normalised), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
