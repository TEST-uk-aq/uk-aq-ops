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
export const DEFAULT_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX =
  "history/_index/observations_timeseries";
export const DEFAULT_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX =
  "history/_index/aqilevels_timeseries";

const DEFAULT_FETCH_CONCURRENCY = 16;
const DEFAULT_MAX_KEYS = 1000;
const INDEX_SCHEMA_VERSION = 1;
const OBSERVATIONS_TIMESERIES_INDEX_SCHEMA_VERSION = 1;
const AQILEVELS_TIMESERIES_INDEX_SCHEMA_VERSION = 1;
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

function parsePositiveId(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
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
  const indexPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_INDEX_PREFIX || DEFAULT_R2_HISTORY_INDEX_PREFIX,
  );
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
    index_prefix: indexPrefix,
    observations_timeseries_index_prefix: normalizePrefix(
      env.UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
        || `${indexPrefix}/${"observations_timeseries"}`,
    ),
    aqilevels_timeseries_index_prefix: normalizePrefix(
      env.UK_AQ_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX
        || `${indexPrefix}/${"aqilevels_timeseries"}`,
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

export function buildR2HistoryObservationsTimeseriesLatestKey(indexPrefix) {
  const prefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_INDEX_PREFIX);
  return `${prefix}/observations_timeseries_latest.json`;
}

export function buildR2HistoryAqilevelsTimeseriesLatestKey(indexPrefix) {
  const prefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_INDEX_PREFIX);
  return `${prefix}/aqilevels_timeseries_latest.json`;
}

export function buildR2HistoryObservationsTimeseriesConnectorIndexKey(
  observationsTimeseriesIndexPrefix,
  dayUtc,
  connectorId,
) {
  const normalizedPrefix = normalizePrefix(
    observationsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
  );
  const normalizedDay = parseIsoDay(dayUtc);
  const normalizedConnectorId = parsePositiveId(connectorId);
  if (!normalizedDay) {
    throw new Error(`Invalid day_utc for observations timeseries index key: ${String(dayUtc || "")}`);
  }
  if (!normalizedConnectorId) {
    throw new Error(
      `Invalid connector_id for observations timeseries index key: ${String(connectorId || "")}`,
    );
  }
  return `${normalizedPrefix}/day_utc=${normalizedDay}/connector_id=${normalizedConnectorId}/manifest.json`;
}

export function buildR2HistoryAqilevelsTimeseriesConnectorIndexKey(
  aqilevelsTimeseriesIndexPrefix,
  dayUtc,
  connectorId,
) {
  const normalizedPrefix = normalizePrefix(
    aqilevelsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX,
  );
  const normalizedDay = parseIsoDay(dayUtc);
  const normalizedConnectorId = parsePositiveId(connectorId);
  if (!normalizedDay) {
    throw new Error(`Invalid day_utc for aqilevels timeseries index key: ${String(dayUtc || "")}`);
  }
  if (!normalizedConnectorId) {
    throw new Error(
      `Invalid connector_id for aqilevels timeseries index key: ${String(connectorId || "")}`,
    );
  }
  return `${normalizedPrefix}/day_utc=${normalizedDay}/connector_id=${normalizedConnectorId}/manifest.json`;
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

function buildObservationConnectorManifestKey(observationsPrefix, dayUtc, connectorId) {
  return `${normalizePrefix(observationsPrefix)}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
}

function buildAqilevelsConnectorManifestKey(aqilevelsPrefix, dayUtc, connectorId) {
  return `${normalizePrefix(aqilevelsPrefix)}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
}

function resolveObservationConnectorManifestTargets(dayManifest, dayUtc, observationsPrefix) {
  const byConnectorId = new Map();
  const connectorEntries = Array.isArray(dayManifest?.connector_manifests)
    ? dayManifest.connector_manifests
    : [];

  for (const entry of connectorEntries) {
    const connectorId = parsePositiveId(entry?.connector_id);
    if (!connectorId) {
      continue;
    }
    const manifestKey = typeof entry?.manifest_key === "string" && entry.manifest_key.trim()
      ? entry.manifest_key.trim()
      : buildObservationConnectorManifestKey(observationsPrefix, dayUtc, connectorId);
    byConnectorId.set(String(connectorId), {
      connector_id: connectorId,
      manifest_key: manifestKey,
    });
  }

  if (byConnectorId.size > 0) {
    return Array.from(byConnectorId.values()).sort((a, b) => a.connector_id - b.connector_id);
  }

  const connectorIds = Array.isArray(dayManifest?.connector_ids)
    ? dayManifest.connector_ids
    : [];
  for (const rawConnectorId of connectorIds) {
    const connectorId = parsePositiveId(rawConnectorId);
    if (!connectorId) {
      continue;
    }
    byConnectorId.set(String(connectorId), {
      connector_id: connectorId,
      manifest_key: buildObservationConnectorManifestKey(observationsPrefix, dayUtc, connectorId),
    });
  }
  return Array.from(byConnectorId.values()).sort((a, b) => a.connector_id - b.connector_id);
}

function resolveAqilevelsConnectorManifestTargets(dayManifest, dayUtc, aqilevelsPrefix) {
  const byConnectorId = new Map();
  const connectorEntries = Array.isArray(dayManifest?.connector_manifests)
    ? dayManifest.connector_manifests
    : [];

  for (const entry of connectorEntries) {
    const connectorId = parsePositiveId(entry?.connector_id);
    if (!connectorId) {
      continue;
    }
    const manifestKey = typeof entry?.manifest_key === "string" && entry.manifest_key.trim()
      ? entry.manifest_key.trim()
      : buildAqilevelsConnectorManifestKey(aqilevelsPrefix, dayUtc, connectorId);
    byConnectorId.set(String(connectorId), {
      connector_id: connectorId,
      manifest_key: manifestKey,
    });
  }

  if (byConnectorId.size > 0) {
    return Array.from(byConnectorId.values()).sort((a, b) => a.connector_id - b.connector_id);
  }

  const connectorIds = Array.isArray(dayManifest?.connector_ids)
    ? dayManifest.connector_ids
    : [];
  for (const rawConnectorId of connectorIds) {
    const connectorId = parsePositiveId(rawConnectorId);
    if (!connectorId) {
      continue;
    }
    byConnectorId.set(String(connectorId), {
      connector_id: connectorId,
      manifest_key: buildAqilevelsConnectorManifestKey(aqilevelsPrefix, dayUtc, connectorId),
    });
  }
  return Array.from(byConnectorId.values()).sort((a, b) => a.connector_id - b.connector_id);
}

function normalizeObservationTimeseriesIndexFileEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const key = typeof entry.key === "string" ? entry.key.trim() : "";
  if (!key) {
    return null;
  }
  const minTimeseriesId = parsePositiveId(entry.min_timeseries_id);
  const maxTimeseriesId = parsePositiveId(entry.max_timeseries_id);
  const normalizedMinTimeseriesId = (
    minTimeseriesId && maxTimeseriesId && minTimeseriesId > maxTimeseriesId
  )
    ? null
    : minTimeseriesId;
  const normalizedMaxTimeseriesId = (
    minTimeseriesId && maxTimeseriesId && minTimeseriesId > maxTimeseriesId
  )
    ? null
    : maxTimeseriesId;
  return {
    key,
    row_count: parseNonNegativeInt(entry.row_count) || 0,
    bytes: parseNonNegativeInt(entry.bytes) || 0,
    etag_or_hash: typeof entry.etag_or_hash === "string" && entry.etag_or_hash.trim()
      ? entry.etag_or_hash.trim()
      : null,
    min_timeseries_id: normalizedMinTimeseriesId,
    max_timeseries_id: normalizedMaxTimeseriesId,
    min_observed_at: toIsoOrNull(entry.min_observed_at),
    max_observed_at: toIsoOrNull(entry.max_observed_at),
  };
}

function buildObservationTimeseriesConnectorIndexPayload({
  dayUtc,
  connectorId,
  generatedAt,
  bucket,
  observationsPrefix,
  connectorManifestKey,
  connectorManifest,
}) {
  const files = Array.from(
    (Array.isArray(connectorManifest?.files) ? connectorManifest.files : []).map(
      (entry) => normalizeObservationTimeseriesIndexFileEntry(entry),
    ),
  ).filter(Boolean);
  files.sort((a, b) => a.key.localeCompare(b.key));

  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let indexedFileCount = 0;
  const availablePollutants = new Set();
  for (const file of files) {
    const fileMin = parsePositiveId(file.min_timeseries_id);
    const fileMax = parsePositiveId(file.max_timeseries_id);
    for (const pollutantCode of (Array.isArray(file.pollutant_codes) ? file.pollutant_codes : [])) {
      availablePollutants.add(pollutantCode);
    }
    if (fileMin && fileMax) {
      indexedFileCount += 1;
      if (!minTimeseriesId || fileMin < minTimeseriesId) {
        minTimeseriesId = fileMin;
      }
      if (!maxTimeseriesId || fileMax > maxTimeseriesId) {
        maxTimeseriesId = fileMax;
      }
    }
  }

  const sourceRowCount = parseNonNegativeInt(connectorManifest?.source_row_count)
    ?? files.reduce((sum, file) => sum + file.row_count, 0);

  return {
    schema_version: OBSERVATIONS_TIMESERIES_INDEX_SCHEMA_VERSION,
    generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
    source: "r2_connector_manifest",
    domain: "observations",
    index_kind: "timeseries_file_ranges",
    bucket: String(bucket || "").trim() || null,
    observations_prefix: normalizePrefix(observationsPrefix || ""),
    day_utc: dayUtc,
    connector_id: connectorId,
    connector_manifest_key: connectorManifestKey,
    connector_manifest_hash:
      typeof connectorManifest?.manifest_hash === "string" && connectorManifest.manifest_hash.trim()
        ? connectorManifest.manifest_hash.trim()
        : null,
    source_row_count: sourceRowCount,
    file_count: files.length,
    indexed_file_count: indexedFileCount,
    index_coverage: indexedFileCount === files.length ? "complete" : "partial",
    available_pollutants: Array.from(availablePollutants).sort((a, b) => a.localeCompare(b)),
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    files,
    backed_up_at_utc: toIsoOrNull(connectorManifest?.backed_up_at_utc),
  };
}

function normalizeAqilevelTimeseriesIndexFileEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const key = typeof entry.key === "string" ? entry.key.trim() : "";
  if (!key) {
    return null;
  }
  const minTimeseriesId = parsePositiveId(entry.min_timeseries_id);
  const maxTimeseriesId = parsePositiveId(entry.max_timeseries_id);
  const normalizedMinTimeseriesId = (
    minTimeseriesId && maxTimeseriesId && minTimeseriesId > maxTimeseriesId
  )
    ? null
    : minTimeseriesId;
  const normalizedMaxTimeseriesId = (
    minTimeseriesId && maxTimeseriesId && minTimeseriesId > maxTimeseriesId
  )
    ? null
    : maxTimeseriesId;
  const pollutantCodes = Array.from(new Set(
    (Array.isArray(entry.pollutant_codes) ? entry.pollutant_codes : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value === "pm25" || value === "pm10" || value === "no2"),
  )).sort((a, b) => a.localeCompare(b));
  return {
    key,
    row_count: parseNonNegativeInt(entry.row_count) || 0,
    bytes: parseNonNegativeInt(entry.bytes) || 0,
    etag_or_hash: typeof entry.etag_or_hash === "string" && entry.etag_or_hash.trim()
      ? entry.etag_or_hash.trim()
      : null,
    pollutant_codes: pollutantCodes,
    min_timeseries_id: normalizedMinTimeseriesId,
    max_timeseries_id: normalizedMaxTimeseriesId,
    min_timestamp_hour_utc: toIsoOrNull(entry.min_timestamp_hour_utc),
    max_timestamp_hour_utc: toIsoOrNull(entry.max_timestamp_hour_utc),
  };
}

function buildAqilevelTimeseriesConnectorIndexPayload({
  dayUtc,
  connectorId,
  generatedAt,
  bucket,
  aqilevelsPrefix,
  connectorManifestKey,
  connectorManifest,
}) {
  const files = Array.from(
    (Array.isArray(connectorManifest?.files) ? connectorManifest.files : []).map(
      (entry) => normalizeAqilevelTimeseriesIndexFileEntry(entry),
    ),
  ).filter(Boolean);
  files.sort((a, b) => a.key.localeCompare(b.key));

  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let indexedFileCount = 0;
  for (const file of files) {
    const fileMin = parsePositiveId(file.min_timeseries_id);
    const fileMax = parsePositiveId(file.max_timeseries_id);
    if (fileMin && fileMax) {
      indexedFileCount += 1;
      if (!minTimeseriesId || fileMin < minTimeseriesId) {
        minTimeseriesId = fileMin;
      }
      if (!maxTimeseriesId || fileMax > maxTimeseriesId) {
        maxTimeseriesId = fileMax;
      }
    }
  }

  const sourceRowCount = parseNonNegativeInt(connectorManifest?.source_row_count)
    ?? files.reduce((sum, file) => sum + file.row_count, 0);

  return {
    schema_version: AQILEVELS_TIMESERIES_INDEX_SCHEMA_VERSION,
    generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
    source: "r2_connector_manifest",
    domain: "aqilevels",
    index_kind: "timeseries_file_ranges",
    bucket: String(bucket || "").trim() || null,
    aqilevels_prefix: normalizePrefix(aqilevelsPrefix || ""),
    day_utc: dayUtc,
    connector_id: connectorId,
    connector_manifest_key: connectorManifestKey,
    connector_manifest_hash:
      typeof connectorManifest?.manifest_hash === "string" && connectorManifest.manifest_hash.trim()
        ? connectorManifest.manifest_hash.trim()
        : null,
    source_row_count: sourceRowCount,
    file_count: files.length,
    indexed_file_count: indexedFileCount,
    index_coverage: indexedFileCount === files.length ? "complete" : "partial",
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    files,
    backed_up_at_utc: toIsoOrNull(connectorManifest?.backed_up_at_utc),
  };
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

async function fetchJsonObjectFromR2(r2, key) {
  const object = await r2GetObject({ r2, key });
  let parsed;
  try {
    parsed = JSON.parse(object.body.toString("utf8"));
  } catch (_error) {
    throw new Error(`R2 object ${key} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`R2 object ${key} must be a JSON object`);
  }
  return parsed;
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

async function rebuildR2HistoryObservationsTimeseriesIndexes({
  r2,
  bucketName,
  observationsPrefix,
  indexPrefix = DEFAULT_R2_HISTORY_INDEX_PREFIX,
  observationsTimeseriesIndexPrefix = DEFAULT_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
  generatedAt = new Date().toISOString(),
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  maxKeys = DEFAULT_MAX_KEYS,
}) {
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for R2 observations timeseries index rebuild");
  }

  const normalizedObservationsPrefix = normalizePrefix(observationsPrefix);
  const normalizedTimeseriesPrefix = normalizePrefix(observationsTimeseriesIndexPrefix);
  const dayPrefixes = await r2ListAllCommonPrefixes({
    r2,
    prefix: `${normalizedObservationsPrefix}/`,
    delimiter: "/",
    max_keys: maxKeys,
  });
  const dayList = dayPrefixes
    .map((prefix) => parseDayFromPrefix(prefix, normalizedObservationsPrefix))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const warnings = [];
  const daySummaries = (await mapWithConcurrency(
    dayList,
    fetchConcurrency,
    async (dayUtc) => {
      const dayManifestKey = `${normalizedObservationsPrefix}/day_utc=${dayUtc}/manifest.json`;
      let dayManifestObject;
      try {
        dayManifestObject = await fetchJsonObjectFromR2(r2, dayManifestKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("(404)")) {
          warnings.push(`Skipped missing observations day manifest for ${dayUtc}`);
          return null;
        }
        throw new Error(`Failed to read observations day manifest ${dayManifestKey}: ${message}`);
      }

      const targets = resolveObservationConnectorManifestTargets(
        dayManifestObject,
        dayUtc,
        normalizedObservationsPrefix,
      );
      const connectorResults = (await mapWithConcurrency(
        targets,
        fetchConcurrency,
        async (target) => {
          try {
            const connectorManifestObject = await fetchJsonObjectFromR2(r2, target.manifest_key);
            const payload = buildObservationTimeseriesConnectorIndexPayload({
              dayUtc,
              connectorId: target.connector_id,
              generatedAt,
              bucket: bucketName || r2.bucket,
              observationsPrefix: normalizedObservationsPrefix,
              connectorManifestKey: target.manifest_key,
              connectorManifest: connectorManifestObject,
            });
            const connectorIndexKey = buildR2HistoryObservationsTimeseriesConnectorIndexKey(
              normalizedTimeseriesPrefix,
              dayUtc,
              target.connector_id,
            );
            const body = `${JSON.stringify(payload, null, 2)}\n`;
            await r2PutObject({
              r2,
              key: connectorIndexKey,
              body,
              content_type: "application/json; charset=utf-8",
            });
            return {
              connector_id: target.connector_id,
              index_key: connectorIndexKey,
              file_count: payload.file_count,
              indexed_file_count: payload.indexed_file_count,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(
              `Skipped observations timeseries connector index for day=${dayUtc} connector=${target.connector_id}: ${message}`,
            );
            return null;
          }
        },
      ))
        .filter(Boolean)
        .sort((a, b) => a.connector_id - b.connector_id);

      return {
        day_utc: dayUtc,
        connector_count: connectorResults.length,
        connector_ids: connectorResults.map((entry) => entry.connector_id),
        connector_indexes: connectorResults,
      };
    },
  )).filter(Boolean);

  const days = daySummaries.map((entry) => entry.day_utc);
  const connectorIndexCount = daySummaries.reduce(
    (sum, entry) => sum + entry.connector_count,
    0,
  );
  const fileCount = daySummaries.reduce(
    (sum, entry) =>
      sum + entry.connector_indexes.reduce((innerSum, connector) => innerSum + connector.file_count, 0),
    0,
  );
  const indexedFileCount = daySummaries.reduce(
    (sum, entry) =>
      sum +
      entry.connector_indexes.reduce(
        (innerSum, connector) => innerSum + connector.indexed_file_count,
        0,
      ),
    0,
  );

  const latestPayload = {
    schema_version: OBSERVATIONS_TIMESERIES_INDEX_SCHEMA_VERSION,
    generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
    source: "r2_connector_manifests",
    domain: "observations",
    index_kind: "timeseries_file_ranges",
    bucket: String(bucketName || r2.bucket || "").trim() || null,
    observations_prefix: normalizedObservationsPrefix,
    index_prefix: normalizedTimeseriesPrefix,
    min_day_utc: days.length ? days[0] : null,
    max_day_utc: days.length ? days[days.length - 1] : null,
    day_count: days.length,
    connector_index_count: connectorIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
    days,
    key_layout: {
      connector_index_manifest_key_template:
        `${normalizedTimeseriesPrefix}/day_utc={day_utc}/connector_id={connector_id}/manifest.json`,
      latest_key: buildR2HistoryObservationsTimeseriesLatestKey(indexPrefix),
    },
    day_summaries: daySummaries.map((entry) => ({
      day_utc: entry.day_utc,
      connector_count: entry.connector_count,
      connector_ids: entry.connector_ids,
    })),
  };

  const latestKey = buildR2HistoryObservationsTimeseriesLatestKey(indexPrefix);
  const latestBody = `${JSON.stringify(latestPayload, null, 2)}\n`;
  const latestPut = await r2PutObject({
    r2,
    key: latestKey,
    body: latestBody,
    content_type: "application/json; charset=utf-8",
  });

  return {
    domain: "observations",
    index_kind: "timeseries_file_ranges",
    latest_index_key: latestKey,
    latest_index_bytes: latestPut.bytes,
    observations_timeseries_index_prefix: normalizedTimeseriesPrefix,
    indexed_day_count: latestPayload.day_count,
    connector_index_count: connectorIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
    warning_count: warnings.length,
    warnings,
  };
}

async function rebuildR2HistoryAqilevelsTimeseriesIndexes({
  r2,
  bucketName,
  aqilevelsPrefix,
  indexPrefix = DEFAULT_R2_HISTORY_INDEX_PREFIX,
  aqilevelsTimeseriesIndexPrefix = DEFAULT_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX,
  generatedAt = new Date().toISOString(),
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  maxKeys = DEFAULT_MAX_KEYS,
}) {
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for R2 aqilevels timeseries index rebuild");
  }

  const normalizedAqilevelsPrefix = normalizePrefix(aqilevelsPrefix);
  const normalizedTimeseriesPrefix = normalizePrefix(aqilevelsTimeseriesIndexPrefix);
  const dayPrefixes = await r2ListAllCommonPrefixes({
    r2,
    prefix: `${normalizedAqilevelsPrefix}/`,
    delimiter: "/",
    max_keys: maxKeys,
  });
  const dayList = dayPrefixes
    .map((prefix) => parseDayFromPrefix(prefix, normalizedAqilevelsPrefix))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const warnings = [];
  const daySummaries = (await mapWithConcurrency(
    dayList,
    fetchConcurrency,
    async (dayUtc) => {
      const dayManifestKey = `${normalizedAqilevelsPrefix}/day_utc=${dayUtc}/manifest.json`;
      let dayManifestObject;
      try {
        dayManifestObject = await fetchJsonObjectFromR2(r2, dayManifestKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("(404)")) {
          warnings.push(`Skipped missing aqilevels day manifest for ${dayUtc}`);
          return null;
        }
        throw new Error(`Failed to read aqilevels day manifest ${dayManifestKey}: ${message}`);
      }

      const targets = resolveAqilevelsConnectorManifestTargets(
        dayManifestObject,
        dayUtc,
        normalizedAqilevelsPrefix,
      );
      const connectorResults = (await mapWithConcurrency(
        targets,
        fetchConcurrency,
        async (target) => {
          try {
            const connectorManifestObject = await fetchJsonObjectFromR2(r2, target.manifest_key);
            const payload = buildAqilevelTimeseriesConnectorIndexPayload({
              dayUtc,
              connectorId: target.connector_id,
              generatedAt,
              bucket: bucketName || r2.bucket,
              aqilevelsPrefix: normalizedAqilevelsPrefix,
              connectorManifestKey: target.manifest_key,
              connectorManifest: connectorManifestObject,
            });
            const connectorIndexKey = buildR2HistoryAqilevelsTimeseriesConnectorIndexKey(
              normalizedTimeseriesPrefix,
              dayUtc,
              target.connector_id,
            );
            const body = `${JSON.stringify(payload, null, 2)}\n`;
            await r2PutObject({
              r2,
              key: connectorIndexKey,
              body,
              content_type: "application/json; charset=utf-8",
            });
            return {
              connector_id: target.connector_id,
              index_key: connectorIndexKey,
              file_count: payload.file_count,
              indexed_file_count: payload.indexed_file_count,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(
              `Skipped aqilevels timeseries connector index for day=${dayUtc} connector=${target.connector_id}: ${message}`,
            );
            return null;
          }
        },
      ))
        .filter(Boolean)
        .sort((a, b) => a.connector_id - b.connector_id);

      return {
        day_utc: dayUtc,
        connector_count: connectorResults.length,
        connector_ids: connectorResults.map((entry) => entry.connector_id),
        connector_indexes: connectorResults,
      };
    },
  )).filter(Boolean);

  const days = daySummaries.map((entry) => entry.day_utc);
  const connectorIndexCount = daySummaries.reduce(
    (sum, entry) => sum + entry.connector_count,
    0,
  );
  const fileCount = daySummaries.reduce(
    (sum, entry) =>
      sum + entry.connector_indexes.reduce((innerSum, connector) => innerSum + connector.file_count, 0),
    0,
  );
  const indexedFileCount = daySummaries.reduce(
    (sum, entry) =>
      sum +
      entry.connector_indexes.reduce(
        (innerSum, connector) => innerSum + connector.indexed_file_count,
        0,
      ),
    0,
  );

  const latestPayload = {
    schema_version: AQILEVELS_TIMESERIES_INDEX_SCHEMA_VERSION,
    generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
    source: "r2_connector_manifests",
    domain: "aqilevels",
    index_kind: "timeseries_file_ranges",
    bucket: String(bucketName || r2.bucket || "").trim() || null,
    aqilevels_prefix: normalizedAqilevelsPrefix,
    index_prefix: normalizedTimeseriesPrefix,
    min_day_utc: days.length ? days[0] : null,
    max_day_utc: days.length ? days[days.length - 1] : null,
    day_count: days.length,
    connector_index_count: connectorIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
    days,
    key_layout: {
      connector_index_manifest_key_template:
        `${normalizedTimeseriesPrefix}/day_utc={day_utc}/connector_id={connector_id}/manifest.json`,
      latest_key: buildR2HistoryAqilevelsTimeseriesLatestKey(indexPrefix),
    },
    day_summaries: daySummaries.map((entry) => ({
      day_utc: entry.day_utc,
      connector_count: entry.connector_count,
      connector_ids: entry.connector_ids,
    })),
  };

  const latestKey = buildR2HistoryAqilevelsTimeseriesLatestKey(indexPrefix);
  const latestBody = `${JSON.stringify(latestPayload, null, 2)}\n`;
  const latestPut = await r2PutObject({
    r2,
    key: latestKey,
    body: latestBody,
    content_type: "application/json; charset=utf-8",
  });

  return {
    domain: "aqilevels",
    index_kind: "timeseries_file_ranges",
    latest_index_key: latestKey,
    latest_index_bytes: latestPut.bytes,
    aqilevels_timeseries_index_prefix: normalizedTimeseriesPrefix,
    indexed_day_count: latestPayload.day_count,
    connector_index_count: connectorIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
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
  let observationsTimeseries = null;
  let aqilevelsTimeseries = null;
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

    if (domain === "observations") {
      observationsTimeseries = await rebuildR2HistoryObservationsTimeseriesIndexes({
        r2: config.r2,
        bucketName: config.r2.bucket,
        observationsPrefix: config.observations_prefix,
        indexPrefix: config.index_prefix,
        observationsTimeseriesIndexPrefix: config.observations_timeseries_index_prefix,
        generatedAt,
        fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
        maxKeys: maxKeys || config.max_keys,
      });
    }
    if (domain === "aqilevels") {
      aqilevelsTimeseries = await rebuildR2HistoryAqilevelsTimeseriesIndexes({
        r2: config.r2,
        bucketName: config.r2.bucket,
        aqilevelsPrefix: config.aqilevels_prefix,
        indexPrefix: config.index_prefix,
        aqilevelsTimeseriesIndexPrefix: config.aqilevels_timeseries_index_prefix,
        generatedAt,
        fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
        maxKeys: maxKeys || config.max_keys,
      });
    }
  }

  return {
    generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
    bucket: config.r2.bucket,
    index_prefix: config.index_prefix,
    observations_timeseries_index_prefix: config.observations_timeseries_index_prefix,
    aqilevels_timeseries_index_prefix: config.aqilevels_timeseries_index_prefix,
    observations_prefix: config.observations_prefix,
    aqilevels_prefix: config.aqilevels_prefix,
    results,
    observations_timeseries: observationsTimeseries,
    aqilevels_timeseries: aqilevelsTimeseries,
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
