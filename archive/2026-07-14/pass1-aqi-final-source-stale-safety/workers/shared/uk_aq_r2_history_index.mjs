// INVARIANT: index payloads written by this module must be byte-identical
// run-to-run when the underlying source data hasn't changed. Every field
// (including `generated_at`, key ordering, number formatting, optional
// fields, etc.) needs to be derived from the source data — never from
// wall-clock time, run IDs, or other run-scoped state.
//
// Why this matters: any byte change rotates the R2 etag, which invalidates
// the etag-skip baseline used by scripts/backup_r2/build_backup_inventory.mjs.
// A blanket churn forces the next inventory build to re-read every changed
// manifest (hours of `rclone cat` round-trips) AND the Dropbox sync to
// re-upload every one of them (hours more, plus Dropbox write-rate
// throttling). The 2026-05-17 transition to a data-driven `generated_at`
// produced exactly this cascade — see commit 2aa79d5.
//
// When editing this file, treat byte-stability as a load-bearing property.
// If you add a new field, source it from the manifests; if you need a
// timestamp, derive it from `max(source.backed_up_at_utc)` or similar.

import { createHash } from "node:crypto";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2HeadObject,
  r2ListAllCommonPrefixes,
  r2PutObject,
  sha256Hex,
} from "./r2_sigv4.mjs";
import { normalizeObservationPropertyCode } from "./uk_aq_observation_property_code.mjs";

export { normalizeObservationPropertyCode };

// MD5 hex of the body bytes — matches the etag R2 returns for single-part
// PUTs (all our manifests are small enough that R2 never splits them).
function md5HexOfBody(body) {
  const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  return createHash("md5").update(buf).digest("hex");
}

function stripEtagQuotes(etag) {
  if (!etag) return null;
  const cleaned = String(etag).trim().replace(/^["W\/]+|"+$/g, "").toLowerCase();
  return cleaned || null;
}

// Idempotent PUT: HEAD the existing object, compare its etag with the MD5 of
// the new body, skip the PUT if they match. Avoids re-writing R2 objects
// every rebuild when the payload content is byte-identical (a common case
// once `generated_at` is data-driven). Saves R2 PUT operations *and* keeps
// downstream consumers — like the Dropbox backup builder — fast by not
// churning their etag-skip baseline.
async function r2PutObjectIfChanged({
  r2,
  key,
  body,
  content_type,
  writeR2 = true,
}) {
  const newMd5 = md5HexOfBody(body);
  const bodyBytes = typeof body === "string"
    ? Buffer.byteLength(body, "utf-8")
    : body.length;
  const bodyText = typeof body === "string"
    ? body
    : Buffer.from(body).toString("utf8");

  let existingEtag = null;
  try {
    const head = await r2HeadObject({ r2, key });
    if (head?.exists) {
      existingEtag = stripEtagQuotes(head.etag);
    }
  } catch (_err) {
    // HEAD failure is non-fatal — treat as "unknown" and proceed to PUT.
  }

  if (existingEtag && existingEtag === newMd5) {
    await r2?.proposal_sink?.({
      key,
      body: bodyText,
      content_type,
      status: "skipped_unchanged",
    });
    return {
      key,
      etag: existingEtag,
      bytes: bodyBytes,
      skipped: true,
      status: "skipped_unchanged",
      write_r2: false,
      verified: true,
      verification_status: "skipped_unchanged",
    };
  }

  if (!writeR2) {
    await r2?.proposal_sink?.({
      key,
      body: bodyText,
      content_type,
      status: "planned",
    });
    return {
      key,
      etag: existingEtag,
      bytes: bodyBytes,
      skipped: false,
      status: "planned",
      write_r2: false,
      verified: false,
      verification_status: "not_run",
    };
  }

  await r2?.proposal_sink?.({
    key,
    body: bodyText,
    content_type,
    status: "planned",
  });
  const result = await r2PutObject({ r2, key, body, content_type });
  const liveObject = await r2GetObject({ r2, key });
  const liveBodyText = liveObject.body.toString("utf8");
  if (liveBodyText !== bodyText || liveObject.bytes !== bodyBytes) {
    throw new Error(
      `R2 verification failed for key=${key}: wrote bytes=${bodyBytes} but live read returned bytes=${liveObject.bytes}`,
    );
  }

  return {
    ...result,
    skipped: false,
    status: "succeeded",
    write_r2: true,
    verified: true,
    verification_status: "succeeded",
  };
}

// Phase 6.5 Pass A backfill (Path 2): parquet-wasm + arrow read paths.
// Imported lazily on first use so the module's cold-start cost stays low
// when the backfill flag is not set.
let _parquetWasm = null;
let _arrow = null;
let _parquetWasmInit = false;
async function ensureParquetTooling() {
  if (_parquetWasm && _arrow && _parquetWasmInit) return;
  if (!_parquetWasm) {
    _parquetWasm = await import("parquet-wasm/esm");
  }
  if (!_arrow) {
    _arrow = await import("apache-arrow");
  }
  if (!_parquetWasmInit) {
    // The wasm module needs to be initialised once before use. parquet-wasm
    // exposes a default initialiser; some builds also accept a wasm path.
    if (typeof _parquetWasm.default === "function") {
      let initError = null;
      try {
        const path = await import("node:path");
        const url = await import("node:url");
        const moduleDir = path.dirname(url.fileURLToPath(import.meta.url));
        const wasmPath = path.resolve(
          moduleDir,
          "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm",
        );
        const fs = await import("node:fs/promises");
        const bytes = await fs.readFile(wasmPath);
        await _parquetWasm.default({ module_or_path: bytes });
      } catch (error) {
        initError = error;
        // Fall back to default init (built-in resolution).
        try {
          await _parquetWasm.default();
        } catch (fallbackError) {
          const primaryMessage = initError instanceof Error ? initError.message : String(initError);
          const fallbackMessage = fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
          throw new Error(
            `Failed to initialize parquet-wasm (bytes init: ${primaryMessage}; default init: ${fallbackMessage})`,
          );
        }
      }
    }
    _parquetWasmInit = true;
  }
}

export const DEFAULT_R2_HISTORY_INDEX_PREFIX = "history/_index";
export const DEFAULT_R2_HISTORY_OBSERVATIONS_PREFIX = "history/v1/observations";
export const DEFAULT_R2_HISTORY_AQILEVELS_PREFIX = "history/v1/aqilevels/hourly";
export const DEFAULT_R2_HISTORY_V2_INDEX_PREFIX = "history/_index_v2";
export const DEFAULT_R2_HISTORY_V2_OBSERVATIONS_PREFIX = "history/v2/observations";
export const DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX = "history/v2/aqilevels/hourly/data";
export const DEFAULT_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX =
  "history/_index/observations_timeseries";
export const DEFAULT_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX =
  "history/_index/aqilevels_timeseries";
export const DEFAULT_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX =
  "history/_index_v2/observations_timeseries";
export const DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX =
  "history/_index_v2/aqilevels_hourly_data_timeseries";
export const DEFAULT_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX =
  "history/_index_v2/timeseries";

const DEFAULT_FETCH_CONCURRENCY = 16;
const DEFAULT_MAX_KEYS = 1000;
const INDEX_SCHEMA_VERSION = 1;
const OBSERVATIONS_TIMESERIES_INDEX_SCHEMA_VERSION = 1;
const AQILEVELS_TIMESERIES_INDEX_SCHEMA_VERSION = 1;
const HISTORY_V2_TIMESERIES_INDEX_SCHEMA_VERSION = 3;
const HISTORY_V2_TIMESERIES_METADATA_SCHEMA_VERSION = 1;
const SUPPORTED_DOMAINS = new Set(["observations", "aqilevels"]);
const MISSING_TIMESERIES_COUNTS_PREFIX =
  "Missing usable timeseries_row_counts in v2 AQI pollutant manifest";

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

function parseBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return fallback;
}

function parsePositiveId(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

export function normalizeAqiPollutantCode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value === "pm25" || value === "pm10" || value === "no2" ? value : null;
}

function parsePollutantCode(raw, domain = "aqilevels") {
  return String(domain || "").trim().toLowerCase() === "observations"
    ? normalizeObservationPropertyCode(raw)
    : normalizeAqiPollutantCode(raw);
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

function minIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left <= right ? left : right;
}

function maxIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left >= right ? left : right;
}

// Pick the latest ISO timestamp from an array of strings. Used to derive
// data-driven `generated_at` values for aggregate index files so they stay
// byte-stable run-to-run when underlying sources haven't changed.
function pickMaxIsoTimestamp(values) {
  let maxMs = -Infinity;
  for (const value of (Array.isArray(values) ? values : [])) {
    if (typeof value !== "string" || !value.trim()) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (ms > maxMs) maxMs = ms;
  }
  return maxMs === -Infinity ? null : new Date(maxMs).toISOString();
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

export function resolveR2Bucket(env = defaultEnv()) {
  const explicitBucket = String(env.R2_BUCKET || env.CFLARE_R2_BUCKET || "").trim();
  if (explicitBucket) {
    return explicitBucket;
  }
  return "";
}

export function resolveR2HistoryIndexConfig(env = defaultEnv()) {
  const indexPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_INDEX_PREFIX || DEFAULT_R2_HISTORY_INDEX_PREFIX,
  );
  const indexPrefixV2 = normalizePrefix(
    env.UK_AQ_R2_HISTORY_INDEX_V2_PREFIX || DEFAULT_R2_HISTORY_V2_INDEX_PREFIX,
  );
  return {
    r2: {
      endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
      bucket: resolveR2Bucket(env),
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
    observations_prefix_v2: normalizePrefix(
      env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || DEFAULT_R2_HISTORY_V2_OBSERVATIONS_PREFIX,
    ),
    aqilevels_hourly_data_prefix_v2: normalizePrefix(
      env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX
        || DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX,
    ),
    index_prefix: indexPrefix,
    index_prefix_v2: indexPrefixV2,
    observations_timeseries_index_prefix: normalizePrefix(
      env.UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
        || `${indexPrefix}/${"observations_timeseries"}`,
    ),
    aqilevels_timeseries_index_prefix: normalizePrefix(
      env.UK_AQ_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX
        || `${indexPrefix}/${"aqilevels_timeseries"}`,
    ),
    observations_timeseries_index_prefix_v2: normalizePrefix(
      env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
        || `${indexPrefixV2}/${"observations_timeseries"}`,
    ),
    aqilevels_hourly_data_timeseries_index_prefix_v2: normalizePrefix(
      env.UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX
        || `${indexPrefixV2}/${"aqilevels_hourly_data_timeseries"}`,
    ),
    timeseries_metadata_index_prefix_v2: normalizePrefix(
      env.UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX
        || DEFAULT_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX,
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
    strict_missing_timeseries_counts: parseBoolean(
      env.UK_AQ_R2_HISTORY_INDEX_STRICT_MISSING_TIMESERIES_COUNTS,
      false,
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

export function buildR2HistoryV2ObservationsTimeseriesLatestKey(indexPrefix) {
  const prefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_V2_INDEX_PREFIX);
  return `${prefix}/observations_timeseries_latest.json`;
}

export function buildR2HistoryV2AqilevelsHourlyDataTimeseriesLatestKey(indexPrefix) {
  const prefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_V2_INDEX_PREFIX);
  return `${prefix}/aqilevels_hourly_data_timeseries_latest.json`;
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

export function buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
  observationsTimeseriesIndexPrefix,
  dayUtc,
  connectorId,
  pollutantCode,
) {
  const normalizedPrefix = normalizePrefix(
    observationsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
  );
  const normalizedDay = parseIsoDay(dayUtc);
  const normalizedConnectorId = parsePositiveId(connectorId);
  const normalizedPollutantCode = parsePollutantCode(pollutantCode, "observations");
  if (!normalizedDay) {
    throw new Error(`Invalid day_utc for observations v2 timeseries index key: ${String(dayUtc || "")}`);
  }
  if (!normalizedConnectorId) {
    throw new Error(
      `Invalid connector_id for observations v2 timeseries index key: ${String(connectorId || "")}`,
    );
  }
  if (!normalizedPollutantCode) {
    throw new Error(
      `Invalid pollutant_code for observations v2 timeseries index key: ${String(pollutantCode || "")}`,
    );
  }
  return `${normalizedPrefix}/day_utc=${normalizedDay}/connector_id=${normalizedConnectorId}/pollutant_code=${normalizedPollutantCode}/manifest.json`;
}

export function buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey(
  aqilevelsTimeseriesIndexPrefix,
  dayUtc,
  connectorId,
  pollutantCode,
) {
  const normalizedPrefix = normalizePrefix(
    aqilevelsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX,
  );
  const normalizedDay = parseIsoDay(dayUtc);
  const normalizedConnectorId = parsePositiveId(connectorId);
  const normalizedPollutantCode = parsePollutantCode(pollutantCode);
  if (!normalizedDay) {
    throw new Error(`Invalid day_utc for aqilevels v2 timeseries index key: ${String(dayUtc || "")}`);
  }
  if (!normalizedConnectorId) {
    throw new Error(
      `Invalid connector_id for aqilevels v2 timeseries index key: ${String(connectorId || "")}`,
    );
  }
  if (!normalizedPollutantCode) {
    throw new Error(
      `Invalid pollutant_code for aqilevels v2 timeseries index key: ${String(pollutantCode || "")}`,
    );
  }
  return `${normalizedPrefix}/day_utc=${normalizedDay}/connector_id=${normalizedConnectorId}/pollutant_code=${normalizedPollutantCode}/manifest.json`;
}

export function buildR2HistoryV2TimeseriesMetadataIndexKey(
  timeseriesMetadataIndexPrefix,
  timeseriesId,
) {
  const normalizedPrefix = normalizePrefix(
    timeseriesMetadataIndexPrefix || DEFAULT_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX,
  );
  const normalizedTimeseriesId = parsePositiveId(timeseriesId);
  if (!normalizedTimeseriesId) {
    throw new Error(`Invalid timeseries_id for v2 timeseries metadata index key: ${String(timeseriesId || "")}`);
  }
  return `${normalizedPrefix}/timeseries_id=${normalizedTimeseriesId}.json`;
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

function normalizeObservationTargets(observationTargets) {
  if (!Array.isArray(observationTargets) || observationTargets.length === 0) {
    return null;
  }
  const byDay = new Map();
  for (const entry of observationTargets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const dayUtc = parseIsoDay(entry.day_utc);
    const connectorId = parsePositiveId(entry.connector_id);
    if (!dayUtc || !connectorId) continue;
    let connectorSet = byDay.get(dayUtc);
    if (!connectorSet) {
      connectorSet = new Set();
      byDay.set(dayUtc, connectorSet);
    }
    connectorSet.add(connectorId);
  }
  return byDay.size ? byDay : null;
}

function flattenObservationTargetPairs(targetMap) {
  if (!targetMap || targetMap.size === 0) {
    return [];
  }
  const out = [];
  for (const [dayUtc, connectorIds] of targetMap.entries()) {
    for (const connectorId of connectorIds) {
      out.push({ day_utc: dayUtc, connector_id: connectorId });
    }
  }
  out.sort((a, b) => {
    const dayCompare = a.day_utc.localeCompare(b.day_utc);
    if (dayCompare !== 0) return dayCompare;
    return a.connector_id - b.connector_id;
  });
  return out;
}

function buildObservationConnectorManifestKey(observationsPrefix, dayUtc, connectorId) {
  return `${normalizePrefix(observationsPrefix)}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
}

function buildAqilevelsConnectorManifestKey(aqilevelsPrefix, dayUtc, connectorId) {
  return `${normalizePrefix(aqilevelsPrefix)}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
}

function buildHistoryV2ConnectorManifestKey(dataPrefix, dayUtc, connectorId) {
  return `${normalizePrefix(dataPrefix)}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
}

function buildHistoryV2PollutantManifestKey(dataPrefix, dayUtc, connectorId, pollutantCode) {
  return `${normalizePrefix(dataPrefix)}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
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

function resolveHistoryV2ConnectorManifestTargets(dayManifest, dayUtc, dataPrefix) {
  const byConnectorId = new Map();
  const connectorEntries = Array.isArray(dayManifest?.connector_manifests)
    ? dayManifest.connector_manifests
    : Array.isArray(dayManifest?.child_manifests)
      ? dayManifest.child_manifests
      : [];

  for (const entry of connectorEntries) {
    const connectorId = parsePositiveId(entry?.connector_id);
    if (!connectorId) {
      continue;
    }
    const manifestKey = typeof entry?.manifest_key === "string" && entry.manifest_key.trim()
      ? entry.manifest_key.trim()
      : buildHistoryV2ConnectorManifestKey(dataPrefix, dayUtc, connectorId);
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
      manifest_key: buildHistoryV2ConnectorManifestKey(dataPrefix, dayUtc, connectorId),
    });
  }
  return Array.from(byConnectorId.values()).sort((a, b) => a.connector_id - b.connector_id);
}

function resolveHistoryV2PollutantManifestTargets(connectorManifest, dayUtc, connectorId, dataPrefix, domain) {
  const byPollutant = new Map();
  const pollutantEntries = Array.isArray(connectorManifest?.pollutant_manifests)
    ? connectorManifest.pollutant_manifests
    : Array.isArray(connectorManifest?.child_manifests)
      ? connectorManifest.child_manifests
      : [];

  for (const entry of pollutantEntries) {
    const pollutantCode = parsePollutantCode(entry?.pollutant_code, domain);
    if (!pollutantCode) {
      continue;
    }
    const manifestKey = typeof entry?.manifest_key === "string" && entry.manifest_key.trim()
      ? entry.manifest_key.trim()
      : buildHistoryV2PollutantManifestKey(dataPrefix, dayUtc, connectorId, pollutantCode);
    byPollutant.set(pollutantCode, {
      pollutant_code: pollutantCode,
      manifest_key: manifestKey,
    });
  }

  if (byPollutant.size > 0) {
    return Array.from(byPollutant.values()).sort((a, b) =>
      a.pollutant_code.localeCompare(b.pollutant_code)
    );
  }

  const pollutantCodes = Array.isArray(connectorManifest?.pollutant_codes)
    ? connectorManifest.pollutant_codes
    : [];
  for (const rawPollutantCode of pollutantCodes) {
    const pollutantCode = parsePollutantCode(rawPollutantCode, domain);
    if (!pollutantCode) {
      continue;
    }
    byPollutant.set(pollutantCode, {
      pollutant_code: pollutantCode,
      manifest_key: buildHistoryV2PollutantManifestKey(dataPrefix, dayUtc, connectorId, pollutantCode),
    });
  }
  return Array.from(byPollutant.values()).sort((a, b) =>
    a.pollutant_code.localeCompare(b.pollutant_code)
  );
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


// Phase 6.5 Pass A: normalise the per-file {ts_id: count} map.
// Returns null if absent / unparseable so downstream code can detect
// "old writer" manifests.
function normalizeTimeseriesRowCounts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const id = parsePositiveId(key);
    const n = parseNonNegativeInt(value);
    if (id && n !== null && n > 0) {
      out[String(id)] = n;
    }
  }
  return Object.keys(out).length ? out : null;
}

function sortTimeseriesRowCounts(raw) {
  const normalized = normalizeTimeseriesRowCounts(raw);
  if (!normalized) return null;
  const out = {};
  for (const key of Object.keys(normalized).sort((a, b) => Number(a) - Number(b))) {
    out[key] = normalized[key];
  }
  return out;
}

function aggregateTimeseriesRowCountsFromFiles(files) {
  const out = {};
  let sawAny = false;
  for (const file of files) {
    const map = file && file.timeseries_row_counts;
    if (!map || typeof map !== "object") continue;
    sawAny = true;
    for (const [key, value] of Object.entries(map)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      out[key] = (out[key] || 0) + Math.trunc(n);
    }
  }
  return sawAny ? sortTimeseriesRowCounts(out) : null;
}

function missingTimeseriesCountsMessage({
  domain,
  manifestKey,
  dayUtc,
  connectorId,
  pollutantCode,
  sourceRowCount,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  const rows = parseNonNegativeInt(sourceRowCount) ?? 0;
  if (normalizedDomain !== "aqilevels" || rows <= 0) return null;
  return [
    MISSING_TIMESERIES_COUNTS_PREFIX,
    `manifest_key=${String(manifestKey || "").trim() || "unknown"}`,
    `day_utc=${String(dayUtc || "").trim() || "unknown"}`,
    `connector_id=${String(connectorId ?? "unknown")}`,
    `pollutant_code=${String(pollutantCode || "").trim() || "unknown"}`,
    `source_row_count=${rows}`,
    "rerun with --compute-missing-timeseries-counts to repair the source manifest before indexing",
  ].join("; ");
}

function handleMissingTimeseriesCounts({
  payload,
  domain,
  manifestKey,
  dayUtc,
  connectorId,
  pollutantCode,
  warnings,
  strictMissingTimeseriesCounts,
}) {
  if (payload?.timeseries_row_counts) return;
  const message = missingTimeseriesCountsMessage({
    domain,
    manifestKey,
    dayUtc,
    connectorId,
    pollutantCode,
    sourceRowCount: payload?.source_row_count,
  });
  if (!message) return;
  if (strictMissingTimeseriesCounts) {
    throw new Error(message);
  }
  warnings.push(message);
}


// Phase 6.5 Pass A backfill (Path 2): read a single parquet from R2 and
// return per-timeseries row counts. The parquet schema is
// `connector_id, timeseries_id, observed_at, value` (see phase_b
// `rowsToParquetBuffer`); we only need the timeseries_id column.
async function readParquetTimeseriesRowCounts({ r2, key }) {
  await ensureParquetTooling();
  const obj = await r2GetObject({ r2, key });
  const bytes = obj.body instanceof Buffer ? obj.body : Buffer.from(obj.body);
  const wasmTable = _parquetWasm.readParquet(bytes);
  const ipcBytes = wasmTable.intoIPCStream();
  const table = _arrow.tableFromIPC(ipcBytes);
  const tsVector = table.getChild("timeseries_id");
  const counts = {};
  if (!tsVector) return counts;
  for (const value of tsVector) {
    if (value === null || value === undefined) continue;
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0) continue;
    const key = String(Math.trunc(id));
    counts[key] = (counts[key] || 0) + 1;
  }
  return sortTimeseriesRowCounts(counts) || {};
}


// Phase 6.5 Pass A backfill: aggregate per-file counts across all parquet
// files referenced by a connector manifest. Returns null on outright
// failure so callers can preserve the existing manifest unchanged.
async function computeConnectorManifestTimeseriesCounts({
  r2,
  connectorManifest,
  warningsSink,
  dayUtc,
  connectorId,
}) {
  const files = Array.isArray(connectorManifest?.files) ? connectorManifest.files : [];
  if (!files.length) return {};
  const out = {};
  for (const entry of files) {
    const key = typeof entry?.key === "string" ? entry.key : null;
    if (!key) continue;
    try {
      const fileCounts = await readParquetTimeseriesRowCounts({ r2, key });
      for (const [tsId, n] of Object.entries(fileCounts)) {
        out[tsId] = (out[tsId] || 0) + n;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warningsSink?.push?.(
        `Skipped parquet row-count read day=${dayUtc} connector=${connectorId} key=${key}: ${message}`,
      );
    }
  }
  return out;
}

async function computePollutantManifestTimeseriesCounts({
  r2,
  pollutantManifest,
  warningsSink,
  dayUtc,
  connectorId,
  pollutantCode,
}) {
  const files = Array.isArray(pollutantManifest?.files) ? pollutantManifest.files : [];
  if (!files.length) return {};
  const out = {};
  for (const entry of files) {
    const key = typeof entry?.key === "string" ? entry.key : null;
    if (!key) continue;
    try {
      const fileCounts = await readParquetTimeseriesRowCounts({ r2, key });
      for (const [tsId, n] of Object.entries(fileCounts)) {
        out[tsId] = (out[tsId] || 0) + n;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warningsSink?.push?.(
        `Skipped parquet row-count read day=${dayUtc} connector=${connectorId} pollutant=${pollutantCode} key=${key}: ${message}`,
      );
    }
  }
  return sortTimeseriesRowCounts(out) || {};
}

async function maybePatchHistoryV2PollutantManifestWithCounts({
  r2,
  manifestKey,
  pollutantManifest,
  warningsSink,
  dayUtc,
  connectorId,
  pollutantCode,
  writeR2 = true,
}) {
  if (normalizeTimeseriesRowCounts(pollutantManifest?.timeseries_row_counts)) {
    return pollutantManifest;
  }
  if (!pollutantManifest || typeof pollutantManifest !== "object") {
    return pollutantManifest;
  }
  const counts = await computePollutantManifestTimeseriesCounts({
    r2,
    pollutantManifest,
    warningsSink,
    dayUtc,
    connectorId,
    pollutantCode,
  });
  if (!counts || Object.keys(counts).length === 0) {
    return pollutantManifest;
  }
  const { manifest_hash: _oldHash, ...payloadWithoutHash } = pollutantManifest;
  const patchedWithoutHash = {
    ...payloadWithoutHash,
    timeseries_row_counts: counts,
  };
  const newHash = sha256Hex(JSON.stringify(patchedWithoutHash));
  const patched = { ...patchedWithoutHash, manifest_hash: newHash };
  await r2PutObjectIfChanged({
    r2,
    key: manifestKey,
    body: `${JSON.stringify(patched, null, 2)}\n`,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });
  return patched;
}


// Phase 6.5 Pass A backfill: patch an existing connector manifest in
// place to add `timeseries_row_counts`, recompute manifest_hash, and
// re-upload. Idempotent: if the field is already populated, no-op.
async function maybePatchConnectorManifestWithCounts({
  r2,
  manifestKey,
  connectorManifest,
  warningsSink,
  dayUtc,
  connectorId,
  writeR2 = true,
}) {
  if (normalizeTimeseriesRowCounts(connectorManifest?.timeseries_row_counts)) {
    return connectorManifest;
  }
  if (!connectorManifest || typeof connectorManifest !== "object") {
    return connectorManifest;
  }
  const counts = await computeConnectorManifestTimeseriesCounts({
    r2, connectorManifest, warningsSink, dayUtc, connectorId,
  });
  if (!counts || Object.keys(counts).length === 0) {
    return connectorManifest;
  }
  const { manifest_hash: _oldHash, ...payloadWithoutHash } = connectorManifest;
  const patchedWithoutHash = {
    ...payloadWithoutHash,
    timeseries_row_counts: counts,
  };
  const newHash = sha256Hex(JSON.stringify(patchedWithoutHash));
  const patched = { ...patchedWithoutHash, manifest_hash: newHash };
  await r2PutObjectIfChanged({
    r2,
    key: manifestKey,
    body: `${JSON.stringify(patched, null, 2)}\n`,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });
  return patched;
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
  // Prefer the manifest's pre-aggregated map. For backward compatibility
  // with older manifests that only had per-file maps, fall back to
  // summing `connectorManifest.files[*].timeseries_row_counts`.
  const timeseriesRowCounts =
    normalizeTimeseriesRowCounts(connectorManifest?.timeseries_row_counts)
    ?? aggregateTimeseriesRowCountsFromFiles(
      Array.isArray(connectorManifest?.files) ? connectorManifest.files : [],
    );

  return {
    schema_version: OBSERVATIONS_TIMESERIES_INDEX_SCHEMA_VERSION,
    // Data-driven: prefer the source connector manifest's backed_up_at_utc so
    // this index payload is byte-identical run-to-run when source data didn't
    // change. Falls back to caller-supplied generatedAt (which may still be
    // wall-clock from a default-arg) only when the source has no timestamp.
    generated_at:
      toIsoOrNull(connectorManifest?.backed_up_at_utc)
      || toIsoOrNull(generatedAt)
      || null,
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
    timeseries_row_counts: timeseriesRowCounts,
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
    schema_version: AQILEVELS_TIMESERIES_INDEX_SCHEMA_VERSION,
    // Data-driven: see buildObservationTimeseriesConnectorIndexPayload note.
    generated_at:
      toIsoOrNull(connectorManifest?.backed_up_at_utc)
      || toIsoOrNull(generatedAt)
      || null,
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
    available_pollutants: Array.from(availablePollutants).sort((a, b) => a.localeCompare(b)),
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    files,
    backed_up_at_utc: toIsoOrNull(connectorManifest?.backed_up_at_utc),
  };
}

function normalizeHistoryV2TimeseriesIndexFileEntry(entry, pollutantCode, domain) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const key = typeof entry.key === "string" ? entry.key.trim() : "";
  if (!key) {
    return null;
  }
  const normalizedPollutantCode = parsePollutantCode(entry.pollutant_code, domain) || pollutantCode;
  if (!normalizedPollutantCode) {
    return null;
  }
  const minTimeseriesId = parsePositiveId(entry.min_timeseries_id);
  const maxTimeseriesId = parsePositiveId(entry.max_timeseries_id);
  const invalidRange = minTimeseriesId && maxTimeseriesId && minTimeseriesId > maxTimeseriesId;
  const minObservedAtUtc =
    toIsoOrNull(entry.min_observed_at_utc)
    || toIsoOrNull(entry.min_observed_at);
  const maxObservedAtUtc =
    toIsoOrNull(entry.max_observed_at_utc)
    || toIsoOrNull(entry.max_observed_at);
  return {
    key,
    row_count: parseNonNegativeInt(entry.row_count) || 0,
    bytes: parseNonNegativeInt(entry.bytes) || 0,
    etag_or_hash: typeof entry.etag_or_hash === "string" && entry.etag_or_hash.trim()
      ? entry.etag_or_hash.trim()
      : null,
    pollutant_code: normalizedPollutantCode,
    min_timeseries_id: invalidRange ? null : minTimeseriesId,
    max_timeseries_id: invalidRange ? null : maxTimeseriesId,
    min_observed_at_utc: domain === "observations" ? minObservedAtUtc : null,
    max_observed_at_utc: domain === "observations" ? maxObservedAtUtc : null,
    min_timestamp_hour_utc: domain === "aqilevels" ? toIsoOrNull(entry.min_timestamp_hour_utc) : null,
    max_timestamp_hour_utc: domain === "aqilevels" ? toIsoOrNull(entry.max_timestamp_hour_utc) : null,
  };
}

export function buildHistoryV2TimeseriesPollutantIndexPayload({
  domain,
  grain = null,
  profile = null,
  dayUtc,
  connectorId,
  pollutantCode,
  generatedAt,
  bucket,
  dataPrefix,
  pollutantManifestKey,
  pollutantManifest,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (normalizedDomain !== "observations" && normalizedDomain !== "aqilevels") {
    throw new Error(`Unsupported R2 history v2 index domain: ${String(domain || "")}`);
  }
  const normalizedPollutantCode = parsePollutantCode(
    pollutantCode || pollutantManifest?.pollutant_code,
    normalizedDomain,
  );
  if (!normalizedPollutantCode) {
    throw new Error(`Invalid pollutant_code for R2 history v2 index: ${String(pollutantCode || "")}`);
  }
  const files = Array.from(
    (Array.isArray(pollutantManifest?.files) ? pollutantManifest.files : []).map(
      (entry) => normalizeHistoryV2TimeseriesIndexFileEntry(entry, normalizedPollutantCode, normalizedDomain),
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

  const sourceRowCount = parseNonNegativeInt(pollutantManifest?.source_row_count)
    ?? parseNonNegativeInt(pollutantManifest?.row_count)
    ?? files.reduce((sum, file) => sum + file.row_count, 0);
  const timeseriesRowCounts =
    normalizeTimeseriesRowCounts(pollutantManifest?.timeseries_row_counts)
    ?? aggregateTimeseriesRowCountsFromFiles(
      Array.isArray(pollutantManifest?.files) ? pollutantManifest.files : [],
    );
  const minObservedAtUtc =
    toIsoOrNull(pollutantManifest?.min_observed_at_utc)
    || toIsoOrNull(pollutantManifest?.min_observed_at)
    || files.reduce((current, file) => minIso(current, file.min_observed_at_utc), null);
  const maxObservedAtUtc =
    toIsoOrNull(pollutantManifest?.max_observed_at_utc)
    || toIsoOrNull(pollutantManifest?.max_observed_at)
    || files.reduce((current, file) => maxIso(current, file.max_observed_at_utc), null);
  const minTimestampHourUtc =
    toIsoOrNull(pollutantManifest?.min_timestamp_hour_utc)
    || files.reduce((current, file) => minIso(current, file.min_timestamp_hour_utc), null);
  const maxTimestampHourUtc =
    toIsoOrNull(pollutantManifest?.max_timestamp_hour_utc)
    || files.reduce((current, file) => maxIso(current, file.max_timestamp_hour_utc), null);
  const manifestHash =
    typeof pollutantManifest?.manifest_hash === "string" && pollutantManifest.manifest_hash.trim()
      ? pollutantManifest.manifest_hash.trim()
      : null;

  return {
    schema_version: HISTORY_V2_TIMESERIES_INDEX_SCHEMA_VERSION,
    generated_at:
      toIsoOrNull(pollutantManifest?.backed_up_at_utc)
      || toIsoOrNull(generatedAt)
      || null,
    source: "r2_pollutant_manifest",
    history_version: "v2",
    domain: normalizedDomain,
    grain,
    profile,
    index_kind: "timeseries_file_ranges",
    bucket: String(bucket || "").trim() || null,
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: normalizedPollutantCode,
    data_prefix: normalizePrefix(dataPrefix || ""),
    pollutant_manifest_key: pollutantManifestKey,
    connector_pollutant_manifest_key: pollutantManifestKey,
    pollutant_manifest_hash: manifestHash,
    source_row_count: sourceRowCount,
    timeseries_row_counts: timeseriesRowCounts,
    file_count: files.length,
    indexed_file_count: indexedFileCount,
    index_coverage: indexedFileCount === files.length ? "complete" : "partial",
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_observed_at_utc: normalizedDomain === "observations" ? minObservedAtUtc : null,
    max_observed_at_utc: normalizedDomain === "observations" ? maxObservedAtUtc : null,
    min_timestamp_hour_utc: normalizedDomain === "aqilevels" ? minTimestampHourUtc : null,
    max_timestamp_hour_utc: normalizedDomain === "aqilevels" ? maxTimestampHourUtc : null,
    files,
    backed_up_at_utc: toIsoOrNull(pollutantManifest?.backed_up_at_utc),
  };
}

function normalizeTimeseriesMetadataEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const domain = String(entry.domain || "").trim().toLowerCase();
  if (domain !== "observations" && domain !== "aqilevels") {
    return null;
  }
  const dayUtc = parseIsoDay(entry.day_utc);
  const connectorId = parsePositiveId(entry.connector_id);
  const pollutantCode = parsePollutantCode(entry.pollutant_code, domain);
  const rowCount = parseNonNegativeInt(entry.row_count);
  if (!dayUtc || !connectorId || !pollutantCode || rowCount === null || rowCount <= 0) {
    return null;
  }
  return {
    domain,
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: pollutantCode,
    row_count: rowCount,
    min_observed_at_utc: domain === "observations"
      ? toIsoOrNull(entry.min_observed_at_utc)
      : null,
    max_observed_at_utc: domain === "observations"
      ? toIsoOrNull(entry.max_observed_at_utc)
      : null,
    min_timestamp_hour_utc: domain === "aqilevels"
      ? toIsoOrNull(entry.min_timestamp_hour_utc)
      : null,
    max_timestamp_hour_utc: domain === "aqilevels"
      ? toIsoOrNull(entry.max_timestamp_hour_utc)
      : null,
    source_index_key: typeof entry.source_index_key === "string" && entry.source_index_key.trim()
      ? entry.source_index_key.trim()
      : null,
    source_manifest_hash:
      typeof entry.source_manifest_hash === "string" && entry.source_manifest_hash.trim()
        ? entry.source_manifest_hash.trim()
        : null,
    backed_up_at_utc: toIsoOrNull(entry.backed_up_at_utc),
  };
}

export function extractHistoryV2TimeseriesMetadataEntry(indexPayload, timeseriesId) {
  const normalizedTimeseriesId = parsePositiveId(timeseriesId);
  if (!normalizedTimeseriesId || !indexPayload || typeof indexPayload !== "object") {
    return null;
  }
  const counts = normalizeTimeseriesRowCounts(indexPayload.timeseries_row_counts);
  const rowCount = counts ? parseNonNegativeInt(counts[String(normalizedTimeseriesId)]) : null;
  if (rowCount === null || rowCount <= 0) {
    return null;
  }
  const domain = String(indexPayload.domain || "").trim().toLowerCase();
  if (domain !== "observations" && domain !== "aqilevels") {
    return null;
  }
  return normalizeTimeseriesMetadataEntry({
    domain,
    day_utc: indexPayload.day_utc,
    connector_id: indexPayload.connector_id,
    pollutant_code: indexPayload.pollutant_code,
    row_count: rowCount,
    min_observed_at_utc: indexPayload.min_observed_at_utc,
    max_observed_at_utc: indexPayload.max_observed_at_utc,
    min_timestamp_hour_utc: indexPayload.min_timestamp_hour_utc,
    max_timestamp_hour_utc: indexPayload.max_timestamp_hour_utc,
    source_index_key:
      indexPayload.connector_pollutant_manifest_key
      || indexPayload.pollutant_manifest_key
      || null,
    source_manifest_hash: indexPayload.pollutant_manifest_hash,
    backed_up_at_utc: indexPayload.backed_up_at_utc || indexPayload.generated_at,
  });
}

function buildHistoryV2TimeseriesDomainCoverage(entries, domain) {
  const normalizedEntries = Array.from(Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeTimeseriesMetadataEntry(entry))
    .filter((entry) => entry && entry.domain === domain)
    .sort((a, b) => {
      if (a.day_utc !== b.day_utc) return a.day_utc.localeCompare(b.day_utc);
      if (a.connector_id !== b.connector_id) return a.connector_id - b.connector_id;
      return a.pollutant_code.localeCompare(b.pollutant_code);
    });
  if (!normalizedEntries.length) {
    return {
      row_count: 0,
      day_count: 0,
      first_day_utc: null,
      last_day_utc: null,
      connector_ids: [],
      pollutant_codes: [],
      first_observed_at_utc: null,
      last_observed_at_utc: null,
      first_timestamp_hour_utc: null,
      last_timestamp_hour_utc: null,
      backed_up_at_utc: null,
      entries: [],
    };
  }
  const daySet = new Set();
  const connectorSet = new Set();
  const pollutantSet = new Set();
  for (const entry of normalizedEntries) {
    daySet.add(entry.day_utc);
    connectorSet.add(entry.connector_id);
    pollutantSet.add(entry.pollutant_code);
  }
  return {
    row_count: normalizedEntries.reduce((sum, entry) => sum + entry.row_count, 0),
    day_count: daySet.size,
    first_day_utc: normalizedEntries[0].day_utc,
    last_day_utc: normalizedEntries[normalizedEntries.length - 1].day_utc,
    connector_ids: Array.from(connectorSet).sort((a, b) => a - b),
    pollutant_codes: Array.from(pollutantSet).sort((a, b) => a.localeCompare(b)),
    first_observed_at_utc: domain === "observations"
      ? normalizedEntries.reduce((current, entry) => minIso(current, entry.min_observed_at_utc), null)
      : null,
    last_observed_at_utc: domain === "observations"
      ? normalizedEntries.reduce((current, entry) => maxIso(current, entry.max_observed_at_utc), null)
      : null,
    first_timestamp_hour_utc: domain === "aqilevels"
      ? normalizedEntries.reduce((current, entry) => minIso(current, entry.min_timestamp_hour_utc), null)
      : null,
    last_timestamp_hour_utc: domain === "aqilevels"
      ? normalizedEntries.reduce((current, entry) => maxIso(current, entry.max_timestamp_hour_utc), null)
      : null,
    backed_up_at_utc: pickMaxIsoTimestamp(normalizedEntries.map((entry) => entry.backed_up_at_utc)),
    entries: normalizedEntries,
  };
}

export function buildHistoryV2TimeseriesMetadataIndexPayload({
  timeseriesId,
  entries,
  generatedAt = null,
  indexPrefix = DEFAULT_R2_HISTORY_V2_INDEX_PREFIX,
  timeseriesMetadataIndexPrefix = DEFAULT_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX,
} = {}) {
  const normalizedTimeseriesId = parsePositiveId(timeseriesId);
  if (!normalizedTimeseriesId) {
    throw new Error(`Invalid timeseries_id for v2 timeseries metadata payload: ${String(timeseriesId || "")}`);
  }
  const normalizedEntries = Array.from(Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeTimeseriesMetadataEntry(entry))
    .filter(Boolean);
  const observationsCoverage = buildHistoryV2TimeseriesDomainCoverage(
    normalizedEntries,
    "observations",
  );
  const aqiCoverage = buildHistoryV2TimeseriesDomainCoverage(normalizedEntries, "aqilevels");
  const connectorIds = Array.from(new Set([
    ...observationsCoverage.connector_ids,
    ...aqiCoverage.connector_ids,
  ])).sort((a, b) => a - b);
  const pollutantCodes = Array.from(new Set([
    ...observationsCoverage.pollutant_codes,
    ...aqiCoverage.pollutant_codes,
  ])).sort((a, b) => a.localeCompare(b));
  const backedUpAtUtc = pickMaxIsoTimestamp([
    observationsCoverage.backed_up_at_utc,
    aqiCoverage.backed_up_at_utc,
  ]);

  return {
    schema_version: HISTORY_V2_TIMESERIES_METADATA_SCHEMA_VERSION,
    generated_at: backedUpAtUtc || toIsoOrNull(generatedAt) || null,
    source: "r2_history_v2_timeseries_indexes",
    history_version: "v2",
    index_kind: "timeseries_metadata",
    timeseries_id: normalizedTimeseriesId,
    connector_id: connectorIds.length === 1 ? connectorIds[0] : null,
    connector_ids: connectorIds,
    pollutant_codes: pollutantCodes,
    index_prefix: normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_V2_INDEX_PREFIX),
    timeseries_metadata_index_prefix: normalizePrefix(
      timeseriesMetadataIndexPrefix || DEFAULT_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX,
    ),
    observations_coverage: observationsCoverage,
    aqi_coverage: aqiCoverage,
    backed_up_at_utc: backedUpAtUtc,
  };
}

function timeseriesMetadataEntryIdentity(entry) {
  const normalized = normalizeTimeseriesMetadataEntry(entry);
  return normalized
    ? `${normalized.domain}|${normalized.day_utc}|${normalized.connector_id}|${normalized.pollutant_code}`
    : null;
}

function metadataEntriesFromPayload(payload, timeseriesId) {
  if (!payload || payload.history_version !== "v2" || payload.index_kind !== "timeseries_metadata"
    || parsePositiveId(payload.timeseries_id) !== parsePositiveId(timeseriesId)) {
    throw new Error("existing_timeseries_metadata_invalid");
  }
  const rawEntries = [
    ...(Array.isArray(payload?.observations_coverage?.entries) ? payload.observations_coverage.entries : []),
    ...(Array.isArray(payload?.aqi_coverage?.entries) ? payload.aqi_coverage.entries : []),
  ];
  if (!rawEntries.length) throw new Error("existing_timeseries_metadata_entries_missing");
  const entries = rawEntries.map(normalizeTimeseriesMetadataEntry);
  if (entries.some((entry) => !entry)) throw new Error("existing_timeseries_metadata_entries_invalid");
  const identities = new Set();
  for (const entry of entries) {
    const identity = timeseriesMetadataEntryIdentity(entry);
    if (!identity || identities.has(identity)) throw new Error("existing_timeseries_metadata_entries_duplicate");
    identities.add(identity);
  }
  return entries;
}

// Exported for the Integrity local regression check. Replacements are keyed by
// domain + day + connector + pollutant, never by day alone.
export function mergeHistoryV2TimeseriesMetadataEntries({ existingPayload, timeseriesId, replacements, removalIdentities = [] } = {}) {
  const existingEntries = metadataEntriesFromPayload(existingPayload, timeseriesId);
  const replacementMap = new Map();
  for (const entry of Array.isArray(replacements) ? replacements : []) {
    const normalized = normalizeTimeseriesMetadataEntry(entry);
    const identity = timeseriesMetadataEntryIdentity(normalized);
    if (!normalized || !identity || replacementMap.has(identity)) {
      throw new Error("replacement_timeseries_metadata_entries_invalid");
    }
    replacementMap.set(identity, normalized);
  }
  const removalSet = new Set(Array.isArray(removalIdentities) ? removalIdentities : []);
  if (removalSet.size !== (Array.isArray(removalIdentities) ? removalIdentities.length : 0)) throw new Error("removal_timeseries_metadata_entries_duplicate");
  for (const identity of removalSet) if (replacementMap.has(identity)) throw new Error("replacement_and_removal_identity_conflict");
  if (!replacementMap.size && !removalSet.size) throw new Error("timeseries_metadata_operations_missing");
  const preserved = existingEntries.filter((entry) => {
    const identity = timeseriesMetadataEntryIdentity(entry);
    return !replacementMap.has(identity) && !removalSet.has(identity);
  });
  const replacedEntryCount = existingEntries.filter((entry) => replacementMap.has(timeseriesMetadataEntryIdentity(entry))).length;
  const removalEntryCount = existingEntries.filter((entry) => removalSet.has(timeseriesMetadataEntryIdentity(entry))).length;
  const entries = [...preserved, ...replacementMap.values()];
  return {
    entries,
    preserved_entry_count: preserved.length,
    replaced_entry_count: replacedEntryCount,
    replacement_entry_count: replacementMap.size,
    removal_entry_count: removalEntryCount,
  };
}

export async function updateR2HistoryV2TimeseriesMetadataIndexesTargeted({
  r2,
  bucketName,
  indexPrefix = DEFAULT_R2_HISTORY_V2_INDEX_PREFIX,
  timeseriesMetadataIndexPrefix = DEFAULT_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX,
  affectedPollutantIndexes = [],
  generatedAt = null,
  writeR2 = true,
  plannedOnly = false,
} = {}) {
  const normalizedIndexPrefix = normalizePrefix(indexPrefix);
  const normalizedMetadataPrefix = normalizePrefix(timeseriesMetadataIndexPrefix);
  const operationsByTimeseriesId = new Map();
  const blocked_scopes = [];
  for (const source of affectedPollutantIndexes) {
    const payload = source?.payload;
    const counts = normalizeTimeseriesRowCounts(payload?.timeseries_row_counts);
    if (!source?.old_payload) {
      blocked_scopes.push({
        status: "blocked_dependency",
        reason: "previous_pollutant_index_missing",
        path: source?.key || null,
        domain: payload?.domain || null,
        day_utc: payload?.day_utc || null,
        connector_id: payload?.connector_id || null,
        pollutant_code: payload?.pollutant_code || null,
      });
      continue;
    }
    const oldCounts = normalizeTimeseriesRowCounts(source.old_payload.timeseries_row_counts);
    if (!oldCounts) {
      blocked_scopes.push({
        status: "blocked_dependency",
        reason: "previous_pollutant_timeseries_counts_invalid",
        path: source?.key || null,
        domain: payload?.domain || null,
        day_utc: payload?.day_utc || null,
        connector_id: payload?.connector_id || null,
        pollutant_code: payload?.pollutant_code || null,
      });
      continue;
    }
    if (!counts) {
      blocked_scopes.push({ status: "blocked_dependency", reason: "required_pollutant_timeseries_counts_invalid", path: source?.key || null });
      continue;
    }
    const identity = `${payload.domain}|${payload.day_utc}|${payload.connector_id}|${payload.pollutant_code}`;
    for (const timeseriesId of new Set([...Object.keys(oldCounts), ...Object.keys(counts)])) {
      const key = String(parsePositiveId(timeseriesId));
      const operation = operationsByTimeseriesId.get(key) || { replacements: [], removalIdentities: [], affectedIndexKeys: [] };
      operation.affectedIndexKeys.push(source?.key || null);
      if (Object.prototype.hasOwnProperty.call(counts, timeseriesId)) {
        const entry = extractHistoryV2TimeseriesMetadataEntry(payload, timeseriesId);
        if (!entry) {
          blocked_scopes.push({ status: "blocked_dependency", reason: "required_pollutant_timeseries_entry_invalid", path: source?.key || null, timeseries_id: timeseriesId });
          continue;
        }
        operation.replacements.push(entry);
      } else {
        operation.removalIdentities.push(identity);
      }
      operationsByTimeseriesId.set(key, operation);
    }
  }
  const candidates = [];
  for (const [timeseriesId, operation] of operationsByTimeseriesId.entries()) {
    const key = buildR2HistoryV2TimeseriesMetadataIndexKey(normalizedMetadataPrefix, timeseriesId);
    const existing = await fetchJsonObjectFromR2IfExists(r2, key);
    if (!existing.exists) {
      blocked_scopes.push({ status: "blocked_dependency", reason: "existing_timeseries_metadata_missing", path: key, timeseries_id: Number(timeseriesId) });
      continue;
    }
    try {
      const merged = mergeHistoryV2TimeseriesMetadataEntries({
        existingPayload: existing.payload,
        timeseriesId,
        replacements: operation.replacements,
        removalIdentities: operation.removalIdentities,
      });
      if (!merged.entries.length) {
        blocked_scopes.push({ status: "blocked_dependency", reason: "timeseries_metadata_delete_required_not_supported", path: key, timeseries_id: Number(timeseriesId) });
        continue;
      }
      const payload = buildHistoryV2TimeseriesMetadataIndexPayload({
        timeseriesId,
        entries: merged.entries,
        generatedAt,
        indexPrefix: normalizedIndexPrefix,
        timeseriesMetadataIndexPrefix: normalizedMetadataPrefix,
      });
      candidates.push({ key, payload, operation, ...merged });
    } catch (error) {
      blocked_scopes.push({ status: "blocked_dependency", reason: String(error?.message || error), path: key, timeseries_id: Number(timeseriesId) });
    }
  }
  if (blocked_scopes.length) return { status: "blocked_dependency", blocked_scopes, metadata_object_count: 0, affected_timeseries_ids: [...operationsByTimeseriesId.keys()].map(Number).sort((a, b) => a - b) };
  let metadata_put_skipped_count = 0;
  for (const candidate of candidates) {
    const put = await r2PutObjectIfChanged({ r2, key: candidate.key, body: `${JSON.stringify(candidate.payload, null, 2)}\n`, content_type: "application/json; charset=utf-8", writeR2 });
    if (put.skipped) metadata_put_skipped_count += 1;
  }
  return {
    status: plannedOnly || !writeR2 ? "planned" : "succeeded",
    metadata_object_count: candidates.length,
    metadata_put_skipped_count,
    affected_timeseries_ids: [...operationsByTimeseriesId.keys()].map(Number).sort((a, b) => a - b),
    preserved_entry_count: candidates.reduce((sum, candidate) => sum + candidate.preserved_entry_count, 0),
    replaced_entry_count: candidates.reduce((sum, candidate) => sum + candidate.replaced_entry_count, 0),
    replacement_entry_count: candidates.reduce((sum, candidate) => sum + candidate.replacement_entry_count, 0),
    removal_entry_count: candidates.reduce((sum, candidate) => sum + candidate.removal_entry_count, 0),
    metadata_keys: candidates.map((candidate) => candidate.key).sort(),
    metadata_operations: candidates.map((candidate) => ({
      timeseries_id: Number(candidate.payload.timeseries_id),
      metadata_object_key: candidate.key,
      replacement_identities: candidate.operation.replacements.map(timeseriesMetadataEntryIdentity),
      removal_identities: candidate.operation.removalIdentities,
      affected_pollutant_index_keys: [...new Set(candidate.operation.affectedIndexKeys.filter(Boolean))].sort(),
      preserved_entry_count: candidate.preserved_entry_count,
      replacement_entry_count: candidate.replacement_entry_count,
      removal_entry_count: candidate.removal_entry_count,
      expected_final_sha256: sha256Hex(`${JSON.stringify(candidate.payload, null, 2)}\n`),
    })),
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
    // Data-driven: derive from the latest source day-manifest's backed_up_at_utc
    // so this payload is byte-identical run-to-run when underlying day manifests
    // didn't change. Falls back to caller-supplied generatedAt only when no
    // source has a timestamp.
    generated_at:
      pickMaxIsoTimestamp(sortedSummaries.map((entry) => entry?.backed_up_at_utc))
      || toIsoOrNull(generatedAt)
      || new Date().toISOString(),
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

function enumerateIsoDaysInclusive(fromDayUtc, toDayUtc) {
  const startDay = parseIsoDay(fromDayUtc);
  const endDay = parseIsoDay(toDayUtc);
  if (!startDay || !endDay) {
    throw new Error("Targeted R2 history index update requires valid from/to day values");
  }
  if (endDay < startDay) {
    throw new Error("Targeted R2 history index update requires to_day_utc >= from_day_utc");
  }

  const out = [];
  const startMs = Date.parse(`${startDay}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDay}T00:00:00.000Z`);
  for (let cursorMs = startMs; cursorMs <= endMs; cursorMs += 24 * 60 * 60 * 1000) {
    out.push(new Date(cursorMs).toISOString().slice(0, 10));
  }
  return out;
}

function normalizeTimeseriesLatestDaySummary(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const dayUtc = parseIsoDay(entry.day_utc);
  if (!dayUtc) {
    return null;
  }
  const connectorIds = Array.from(new Set(
    (Array.isArray(entry.connector_ids) ? entry.connector_ids : [])
      .map((value) => parsePositiveId(value))
      .filter(Boolean),
  )).sort((a, b) => a - b);
  const connectorCount = parseNonNegativeInt(entry.connector_count);
  return {
    day_utc: dayUtc,
    connector_count: connectorIds.length || connectorCount || 0,
    connector_ids: connectorIds,
    file_count: parseNonNegativeInt(entry.file_count) || 0,
    indexed_file_count: parseNonNegativeInt(entry.indexed_file_count) || 0,
    backed_up_at_utc: toIsoOrNull(entry.backed_up_at_utc),
  };
}

function buildTimeseriesLatestDaySummary({
  dayUtc,
  connectorPayloads,
  dayBackedUpAtUtc = null,
}) {
  const sortedConnectorPayloads = Array.from(Array.isArray(connectorPayloads) ? connectorPayloads : [])
    .filter((entry) => entry && typeof entry === "object")
    .sort((a, b) => (parsePositiveId(a.connector_id) || 0) - (parsePositiveId(b.connector_id) || 0));
  const connectorIds = sortedConnectorPayloads
    .map((entry) => parsePositiveId(entry.connector_id))
    .filter(Boolean);
  return {
    day_utc: dayUtc,
    connector_count: connectorIds.length,
    connector_ids: connectorIds,
    file_count: sortedConnectorPayloads.reduce(
      (sum, entry) => sum + (parseNonNegativeInt(entry.file_count) || 0),
      0,
    ),
    indexed_file_count: sortedConnectorPayloads.reduce(
      (sum, entry) => sum + (parseNonNegativeInt(entry.indexed_file_count) || 0),
      0,
    ),
    backed_up_at_utc:
      toIsoOrNull(dayBackedUpAtUtc)
      || pickMaxIsoTimestamp(sortedConnectorPayloads.map((entry) => entry.backed_up_at_utc)),
  };
}

function buildObservationsTimeseriesLatestPayload({
  bucket,
  generatedAt,
  existingGeneratedAt = null,
  indexPrefix = DEFAULT_R2_HISTORY_INDEX_PREFIX,
  observationsPrefix,
  observationsTimeseriesIndexPrefix = DEFAULT_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
  daySummaries,
}) {
  const sortedSummaries = Array.from(Array.isArray(daySummaries) ? daySummaries : [])
    .map((entry) => normalizeTimeseriesLatestDaySummary(entry))
    .filter(Boolean)
    .sort((a, b) => a.day_utc.localeCompare(b.day_utc));
  const days = sortedSummaries.map((entry) => entry.day_utc);
  const connectorIndexCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.connector_count) || 0),
    0,
  );
  const fileCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.file_count) || 0),
    0,
  );
  const indexedFileCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.indexed_file_count) || 0),
    0,
  );

  return {
    schema_version: OBSERVATIONS_TIMESERIES_INDEX_SCHEMA_VERSION,
    generated_at:
      pickMaxIsoTimestamp([
        ...sortedSummaries.map((entry) => entry.backed_up_at_utc),
        existingGeneratedAt,
      ])
      || toIsoOrNull(generatedAt)
      || new Date().toISOString(),
    source: "r2_connector_manifests",
    domain: "observations",
    index_kind: "timeseries_file_ranges",
    bucket: String(bucket || "").trim() || null,
    observations_prefix: normalizePrefix(observationsPrefix || ""),
    index_prefix: normalizePrefix(
      observationsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
    ),
    min_day_utc: days.length ? days[0] : null,
    max_day_utc: days.length ? days[days.length - 1] : null,
    day_count: days.length,
    connector_index_count: connectorIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
    days,
    key_layout: {
      connector_index_manifest_key_template:
        `${normalizePrefix(
          observationsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
        )}/day_utc={day_utc}/connector_id={connector_id}/manifest.json`,
      latest_key: buildR2HistoryObservationsTimeseriesLatestKey(indexPrefix),
    },
    day_summaries: sortedSummaries,
  };
}

function buildAqilevelsTimeseriesLatestPayload({
  bucket,
  generatedAt,
  existingGeneratedAt = null,
  indexPrefix = DEFAULT_R2_HISTORY_INDEX_PREFIX,
  aqilevelsPrefix,
  aqilevelsTimeseriesIndexPrefix = DEFAULT_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX,
  daySummaries,
}) {
  const sortedSummaries = Array.from(Array.isArray(daySummaries) ? daySummaries : [])
    .map((entry) => normalizeTimeseriesLatestDaySummary(entry))
    .filter(Boolean)
    .sort((a, b) => a.day_utc.localeCompare(b.day_utc));
  const days = sortedSummaries.map((entry) => entry.day_utc);
  const connectorIndexCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.connector_count) || 0),
    0,
  );
  const fileCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.file_count) || 0),
    0,
  );
  const indexedFileCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.indexed_file_count) || 0),
    0,
  );

  return {
    schema_version: AQILEVELS_TIMESERIES_INDEX_SCHEMA_VERSION,
    generated_at:
      pickMaxIsoTimestamp([
        ...sortedSummaries.map((entry) => entry.backed_up_at_utc),
        existingGeneratedAt,
      ])
      || toIsoOrNull(generatedAt)
      || new Date().toISOString(),
    source: "r2_connector_manifests",
    domain: "aqilevels",
    index_kind: "timeseries_file_ranges",
    bucket: String(bucket || "").trim() || null,
    aqilevels_prefix: normalizePrefix(aqilevelsPrefix || ""),
    index_prefix: normalizePrefix(
      aqilevelsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX,
    ),
    min_day_utc: days.length ? days[0] : null,
    max_day_utc: days.length ? days[days.length - 1] : null,
    day_count: days.length,
    connector_index_count: connectorIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
    days,
    key_layout: {
      connector_index_manifest_key_template:
        `${normalizePrefix(
          aqilevelsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX,
        )}/day_utc={day_utc}/connector_id={connector_id}/manifest.json`,
      latest_key: buildR2HistoryAqilevelsTimeseriesLatestKey(indexPrefix),
    },
    day_summaries: sortedSummaries,
  };
}

function normalizeHistoryV2TimeseriesLatestDaySummary(entry, domain) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const dayUtc = parseIsoDay(entry.day_utc);
  if (!dayUtc) {
    return null;
  }
  const connectorRowCounts = new Map();
  for (const connector of Array.isArray(entry.connectors) ? entry.connectors : []) {
    const connectorId = parsePositiveId(connector?.connector_id);
    const rowCount = parseNonNegativeInt(connector?.row_count);
    if (!connectorId || rowCount === null) {
      continue;
    }
    connectorRowCounts.set(connectorId, (connectorRowCounts.get(connectorId) || 0) + rowCount);
  }
  const connectorIds = Array.from(new Set([
    ...(Array.isArray(entry.connector_ids) ? entry.connector_ids : [])
      .map((value) => parsePositiveId(value))
      .filter(Boolean),
    ...connectorRowCounts.keys(),
  ])).sort((a, b) => a - b);
  const connectors = Array.from(connectorRowCounts.entries())
    .map(([connectorId, rowCount]) => ({
      connector_id: connectorId,
      row_count: rowCount,
    }))
    .sort((a, b) => a.connector_id - b.connector_id);
  const pollutantCodes = Array.from(new Set(
    (Array.isArray(entry.pollutant_codes) ? entry.pollutant_codes : [])
      .map((value) => parsePollutantCode(value, domain))
      .filter(Boolean),
  )).sort((a, b) => a.localeCompare(b));
  const connectorCount = parseNonNegativeInt(entry.connector_count);
  const pollutantIndexCount = parseNonNegativeInt(entry.pollutant_index_count);
  const connectorRowTotal = connectors.reduce((sum, connector) => sum + connector.row_count, 0);
  return {
    day_utc: dayUtc,
    connector_count: connectorIds.length || connectorCount || 0,
    connector_ids: connectorIds,
    connectors,
    total_rows: parseNonNegativeInt(entry.total_rows) ?? connectorRowTotal,
    pollutant_codes: pollutantCodes,
    pollutant_index_count: pollutantIndexCount || 0,
    file_count: parseNonNegativeInt(entry.file_count) || 0,
    indexed_file_count: parseNonNegativeInt(entry.indexed_file_count) || 0,
    backed_up_at_utc: toIsoOrNull(entry.backed_up_at_utc),
  };
}

export function buildHistoryV2TimeseriesLatestPayload({
  domain,
  grain = null,
  profile = null,
  bucket,
  generatedAt,
  existingGeneratedAt = null,
  indexPrefix = DEFAULT_R2_HISTORY_V2_INDEX_PREFIX,
  dataPrefix,
  timeseriesIndexPrefix,
  daySummaries,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (normalizedDomain !== "observations" && normalizedDomain !== "aqilevels") {
    throw new Error(`Unsupported R2 history v2 latest index domain: ${String(domain || "")}`);
  }
  const normalizedIndexPrefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_V2_INDEX_PREFIX);
  const normalizedTimeseriesPrefix = normalizePrefix(timeseriesIndexPrefix || (
    normalizedDomain === "observations"
      ? DEFAULT_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
      : DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX
  ));
  const latestKey = normalizedDomain === "observations"
    ? buildR2HistoryV2ObservationsTimeseriesLatestKey(normalizedIndexPrefix)
    : buildR2HistoryV2AqilevelsHourlyDataTimeseriesLatestKey(normalizedIndexPrefix);
  const sortedSummaries = Array.from(Array.isArray(daySummaries) ? daySummaries : [])
    .map((entry) => normalizeHistoryV2TimeseriesLatestDaySummary(entry, normalizedDomain))
    .filter(Boolean)
    .sort((a, b) => a.day_utc.localeCompare(b.day_utc));
  const days = sortedSummaries.map((entry) => entry.day_utc);
  const connectorIndexCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.connector_count) || 0),
    0,
  );
  const pollutantIndexCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.pollutant_index_count) || 0),
    0,
  );
  const totalRows = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.total_rows) || 0),
    0,
  );
  const fileCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.file_count) || 0),
    0,
  );
  const indexedFileCount = sortedSummaries.reduce(
    (sum, entry) => sum + (parseNonNegativeInt(entry.indexed_file_count) || 0),
    0,
  );

  return {
    schema_version: HISTORY_V2_TIMESERIES_INDEX_SCHEMA_VERSION,
    generated_at:
      pickMaxIsoTimestamp([
        ...sortedSummaries.map((entry) => entry.backed_up_at_utc),
        existingGeneratedAt,
      ])
      || toIsoOrNull(generatedAt)
      || new Date().toISOString(),
    source: "r2_pollutant_manifests",
    history_version: "v2",
    domain: normalizedDomain,
    grain,
    profile,
    index_kind: "timeseries_file_ranges",
    bucket: String(bucket || "").trim() || null,
    data_prefix: normalizePrefix(dataPrefix || ""),
    index_prefix: normalizedTimeseriesPrefix,
    min_day_utc: days.length ? days[0] : null,
    max_day_utc: days.length ? days[days.length - 1] : null,
    day_count: days.length,
    total_rows: totalRows,
    connector_index_count: connectorIndexCount,
    pollutant_index_count: pollutantIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
    days,
    key_layout: {
      pollutant_index_manifest_key_template:
        `${normalizedTimeseriesPrefix}/day_utc={day_utc}/connector_id={connector_id}/pollutant_code={pollutant_code}/manifest.json`,
      latest_key: latestKey,
    },
    day_summaries: sortedSummaries,
  };
}

function resolveHistoryV2LatestPollutantIndexTargets({
  latestPayload,
  domain,
  timeseriesIndexPrefix,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  const targets = [];
  for (const summary of Array.isArray(latestPayload?.day_summaries)
    ? latestPayload.day_summaries
    : []) {
    const dayUtc = parseIsoDay(summary?.day_utc);
    if (!dayUtc) continue;
    const connectorIds = Array.from(new Set(
      (Array.isArray(summary?.connector_ids) ? summary.connector_ids : [])
        .map((value) => parsePositiveId(value))
        .filter(Boolean),
    )).sort((a, b) => a - b);
    const pollutantCodes = Array.from(new Set(
      (Array.isArray(summary?.pollutant_codes) ? summary.pollutant_codes : [])
        .map((value) => parsePollutantCode(value, normalizedDomain))
        .filter(Boolean),
    )).sort((a, b) => a.localeCompare(b));
    for (const connectorId of connectorIds) {
      for (const pollutantCode of pollutantCodes) {
        const key = normalizedDomain === "observations"
          ? buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
            timeseriesIndexPrefix,
            dayUtc,
            connectorId,
            pollutantCode,
          )
          : buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey(
            timeseriesIndexPrefix,
            dayUtc,
            connectorId,
            pollutantCode,
          );
        targets.push({ day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode, key });
      }
    }
  }
  targets.sort((a, b) => {
    if (a.day_utc !== b.day_utc) return a.day_utc.localeCompare(b.day_utc);
    if (a.connector_id !== b.connector_id) return a.connector_id - b.connector_id;
    return a.pollutant_code.localeCompare(b.pollutant_code);
  });
  return targets;
}

function buildHistoryV2TimeseriesIndexKeyForDomain(domain, timeseriesIndexPrefix, target) {
  return domain === "observations"
    ? buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
      timeseriesIndexPrefix,
      target.day_utc,
      target.connector_id,
      target.pollutant_code,
    )
    : buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey(
      timeseriesIndexPrefix,
      target.day_utc,
      target.connector_id,
      target.pollutant_code,
    );
}

export async function rebuildR2HistoryV2TimeseriesMetadataIndexes({
  r2,
  bucketName,
  indexPrefix = DEFAULT_R2_HISTORY_V2_INDEX_PREFIX,
  observationsDataPrefix = DEFAULT_R2_HISTORY_V2_OBSERVATIONS_PREFIX,
  aqilevelsHourlyDataPrefix = DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX,
  observationsTimeseriesIndexPrefix = DEFAULT_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
  aqilevelsHourlyDataTimeseriesIndexPrefix =
    DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX,
  timeseriesMetadataIndexPrefix = DEFAULT_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX,
  generatedAt = null,
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  writeR2 = true,
} = {}) {
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for R2 history v2 timeseries metadata index rebuild");
  }
  const normalizedIndexPrefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_V2_INDEX_PREFIX);
  const normalizedObservationsDataPrefix = normalizePrefix(
    observationsDataPrefix || DEFAULT_R2_HISTORY_V2_OBSERVATIONS_PREFIX,
  );
  const normalizedAqiDataPrefix = normalizePrefix(
    aqilevelsHourlyDataPrefix || DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX,
  );
  const normalizedObservationsPrefix = normalizePrefix(
    observationsTimeseriesIndexPrefix || DEFAULT_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
  );
  const normalizedAqiPrefix = normalizePrefix(
    aqilevelsHourlyDataTimeseriesIndexPrefix
      || DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX,
  );
  const normalizedMetadataPrefix = normalizePrefix(
    timeseriesMetadataIndexPrefix || DEFAULT_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX,
  );
  const warnings = [];
  const entriesByTimeseriesId = new Map();

  async function collectDomain(domain, latestKey, timeseriesIndexPrefix, dataPrefix) {
    const latestResult = await fetchJsonObjectFromR2IfExists(r2, latestKey);
    if (!latestResult.exists) {
      warnings.push(`Skipped missing ${domain} v2 timeseries latest index: ${latestKey}`);
      return {
        domain,
        latest_key: latestKey,
        potential_grid_target_count: 0,
        actual_data_partition_count: 0,
        actual_index_manifest_count: 0,
        skipped_absent_data_partition_count: 0,
        missing_index_for_existing_data_partition_count: 0,
      };
    }
    const potentialTargets = resolveHistoryV2LatestPollutantIndexTargets({
      latestPayload: latestResult.payload,
      domain,
      timeseriesIndexPrefix,
    });
    const potentialTargetKeys = new Set(potentialTargets.map((target) =>
      `${target.day_utc}|${target.connector_id}|${target.pollutant_code}`
    ));
    const actualTargetsByKey = new Map();
    const daySummaries = Array.isArray(latestResult.payload?.day_summaries)
      ? latestResult.payload.day_summaries
      : [];

    await mapWithConcurrency(daySummaries, fetchConcurrency, async (summary) => {
      const dayUtc = parseIsoDay(summary?.day_utc);
      if (!dayUtc) return null;
      const dayManifestKey = `${dataPrefix}/day_utc=${dayUtc}/manifest.json`;
      const dayManifestResult = await fetchJsonObjectFromR2IfExists(r2, dayManifestKey);
      if (!dayManifestResult.exists) {
        warnings.push(`Skipped missing ${domain} v2 data day manifest: ${dayManifestKey}`);
        return null;
      }
      const connectorTargets = resolveHistoryV2ConnectorManifestTargets(
        dayManifestResult.payload,
        dayUtc,
        dataPrefix,
      );
      await mapWithConcurrency(connectorTargets, fetchConcurrency, async (connectorTarget) => {
        const connectorManifestResult = await fetchJsonObjectFromR2IfExists(
          r2,
          connectorTarget.manifest_key,
        );
        if (!connectorManifestResult.exists) {
          warnings.push(
            `Skipped missing ${domain} v2 data connector manifest: ${connectorTarget.manifest_key}`,
          );
          return null;
        }
        const pollutantTargets = resolveHistoryV2PollutantManifestTargets(
          connectorManifestResult.payload,
          dayUtc,
          connectorTarget.connector_id,
          dataPrefix,
          domain,
        );
        await mapWithConcurrency(pollutantTargets, fetchConcurrency, async (pollutantTarget) => {
          const dataPartitionResult = await fetchJsonObjectFromR2IfExists(
            r2,
            pollutantTarget.manifest_key,
          );
          if (!dataPartitionResult.exists) {
            return null;
          }
          const key = `${dayUtc}|${connectorTarget.connector_id}|${pollutantTarget.pollutant_code}`;
          actualTargetsByKey.set(key, {
            day_utc: dayUtc,
            connector_id: connectorTarget.connector_id,
            pollutant_code: pollutantTarget.pollutant_code,
            data_manifest_key: pollutantTarget.manifest_key,
            index_key: buildHistoryV2TimeseriesIndexKeyForDomain(domain, timeseriesIndexPrefix, {
              day_utc: dayUtc,
              connector_id: connectorTarget.connector_id,
              pollutant_code: pollutantTarget.pollutant_code,
            }),
          });
          return null;
        });
        return null;
      });
      return null;
    });

    const targets = Array.from(actualTargetsByKey.values()).sort((a, b) => {
      if (a.day_utc !== b.day_utc) return a.day_utc.localeCompare(b.day_utc);
      if (a.connector_id !== b.connector_id) return a.connector_id - b.connector_id;
      return a.pollutant_code.localeCompare(b.pollutant_code);
    });
    let actualIndexManifestCount = 0;
    let missingIndexForExistingDataPartitionCount = 0;
    await mapWithConcurrency(targets, fetchConcurrency, async (target) => {
      const result = await fetchJsonObjectFromR2IfExists(r2, target.index_key);
      if (!result.exists) {
        missingIndexForExistingDataPartitionCount += 1;
        warnings.push(
          `Skipped missing ${domain} v2 timeseries index for existing data partition: ${target.index_key}`,
        );
        return null;
      }
      actualIndexManifestCount += 1;
      const counts = normalizeTimeseriesRowCounts(result.payload?.timeseries_row_counts);
      if (!counts) {
        return null;
      }
      for (const timeseriesId of Object.keys(counts)) {
        const entry = extractHistoryV2TimeseriesMetadataEntry(result.payload, timeseriesId);
        if (!entry) continue;
        entry.source_index_key = target.index_key;
        const key = String(parsePositiveId(timeseriesId));
        const current = entriesByTimeseriesId.get(key) || [];
        current.push(entry);
        entriesByTimeseriesId.set(key, current);
      }
      return null;
    });
    const actualTargetKeys = new Set(actualTargetsByKey.keys());
    let skippedAbsentDataPartitionCount = 0;
    for (const key of potentialTargetKeys) {
      if (!actualTargetKeys.has(key)) {
        skippedAbsentDataPartitionCount += 1;
      }
    }
    return {
      domain,
      latest_key: latestKey,
      potential_grid_target_count: potentialTargetKeys.size,
      actual_data_partition_count: targets.length,
      actual_index_manifest_count: actualIndexManifestCount,
      metadata_source_index_manifest_count: actualIndexManifestCount,
      skipped_absent_data_partition_count: skippedAbsentDataPartitionCount,
      missing_index_for_existing_data_partition_count: missingIndexForExistingDataPartitionCount,
    };
  }

  const observationsResult = await collectDomain(
    "observations",
    buildR2HistoryV2ObservationsTimeseriesLatestKey(normalizedIndexPrefix),
    normalizedObservationsPrefix,
    normalizedObservationsDataPrefix,
  );
  const aqiResult = await collectDomain(
    "aqilevels",
    buildR2HistoryV2AqilevelsHourlyDataTimeseriesLatestKey(normalizedIndexPrefix),
    normalizedAqiPrefix,
    normalizedAqiDataPrefix,
  );

  let putSkippedCount = 0;
  let writtenCount = 0;
  const timeseriesIds = Array.from(entriesByTimeseriesId.keys())
    .map((value) => parsePositiveId(value))
    .filter(Boolean)
    .sort((a, b) => a - b);
  await mapWithConcurrency(timeseriesIds, fetchConcurrency, async (timeseriesId) => {
    const payload = buildHistoryV2TimeseriesMetadataIndexPayload({
      timeseriesId,
      entries: entriesByTimeseriesId.get(String(timeseriesId)),
      generatedAt,
      indexPrefix: normalizedIndexPrefix,
      timeseriesMetadataIndexPrefix: normalizedMetadataPrefix,
    });
    const key = buildR2HistoryV2TimeseriesMetadataIndexKey(normalizedMetadataPrefix, timeseriesId);
  const putResult = await r2PutObjectIfChanged({
    r2,
    key,
    body: `${JSON.stringify(payload, null, 2)}\n`,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });
    writtenCount += 1;
    if (putResult.skipped) {
      putSkippedCount += 1;
    }
  });

  return {
    history_version: "v2",
    index_kind: "timeseries_metadata",
    bucket: bucketName || r2.bucket,
    index_prefix: normalizedIndexPrefix,
    timeseries_metadata_index_prefix: normalizedMetadataPrefix,
    timeseries_metadata_key_template: `${normalizedMetadataPrefix}/timeseries_id={timeseries_id}.json`,
    timeseries_count: timeseriesIds.length,
    metadata_object_count: writtenCount,
    metadata_put_skipped_count: putSkippedCount,
    actual_index_manifest_count:
      observationsResult.actual_index_manifest_count + aqiResult.actual_index_manifest_count,
    skipped_absent_data_partition_count:
      observationsResult.skipped_absent_data_partition_count
      + aqiResult.skipped_absent_data_partition_count,
    missing_index_for_existing_data_partition_count:
      observationsResult.missing_index_for_existing_data_partition_count
      + aqiResult.missing_index_for_existing_data_partition_count,
    observations: observationsResult,
    aqilevels: aqiResult,
    warning_count: warnings.length,
    warnings,
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

async function fetchJsonObjectFromR2IfExists(r2, key) {
  try {
    return {
      exists: true,
      payload: await fetchJsonObjectFromR2(r2, key),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.code === "OBJECT_NOT_FOUND" || message.includes("(404)")) {
      return { exists: false, payload: null };
    }
    throw error;
  }
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
  writeR2 = true,
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
  const putResult = await r2PutObjectIfChanged({
    r2,
    key: indexKey,
    body,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });

  return {
    domain: normalizedDomain,
    index_key: indexKey,
    index_bytes: putResult.bytes,
    index_put_skipped: Boolean(putResult.skipped),
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
  computeMissingTimeseriesCounts = false,
  observationTargets = null,
  writeR2 = true,
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
  const targetMap = normalizeObservationTargets(observationTargets);
  const requestedTargets = flattenObservationTargetPairs(targetMap);
  const requestedTargetSet = new Set(
    requestedTargets.map((entry) => `${entry.day_utc}|${entry.connector_id}`),
  );
  const matchedTargetSet = new Set();
  const selectedDayList = targetMap
    ? dayList.filter((dayUtc) => targetMap.has(dayUtc))
    : dayList;

  const warnings = [];
  const daySummaries = (await mapWithConcurrency(
    selectedDayList,
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
      const dayTargetSet = targetMap?.get(dayUtc) || null;
      const filteredTargets = dayTargetSet
        ? targets.filter((target) => dayTargetSet.has(target.connector_id))
        : targets;
      for (const target of filteredTargets) {
        matchedTargetSet.add(`${dayUtc}|${target.connector_id}`);
      }
      const connectorResults = (await mapWithConcurrency(
        filteredTargets,
        fetchConcurrency,
        async (target) => {
          try {
            let connectorManifestObject = await fetchJsonObjectFromR2(r2, target.manifest_key);
            if (computeMissingTimeseriesCounts) {
              connectorManifestObject = await maybePatchConnectorManifestWithCounts({
                r2,
                manifestKey: target.manifest_key,
                connectorManifest: connectorManifestObject,
                warningsSink: warnings,
                dayUtc,
                connectorId: target.connector_id,
                writeR2,
              });
            }
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
            const putResult = await r2PutObjectIfChanged({
              r2,
              key: connectorIndexKey,
              body,
              content_type: "application/json; charset=utf-8",
              writeR2,
            });
            return {
              connector_id: target.connector_id,
              index_key: connectorIndexKey,
              file_count: payload.file_count,
              indexed_file_count: payload.indexed_file_count,
              put_skipped: Boolean(putResult.skipped),
              backed_up_at_utc: payload.backed_up_at_utc,
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
        file_count: connectorResults.reduce((sum, entry) => sum + entry.file_count, 0),
        indexed_file_count: connectorResults.reduce(
          (sum, entry) => sum + entry.indexed_file_count,
          0,
        ),
        backed_up_at_utc:
          toIsoOrNull(dayManifestObject?.backed_up_at_utc)
          || pickMaxIsoTimestamp(connectorResults.map((entry) => entry.backed_up_at_utc)),
        connector_indexes: connectorResults,
      };
    },
  )).filter(Boolean);

  if (targetMap) {
    const unmatched = requestedTargets.filter(
      (entry) => !matchedTargetSet.has(`${entry.day_utc}|${entry.connector_id}`),
    );
    for (const entry of unmatched) {
      warnings.push(
        `Target not found in observations manifests day=${entry.day_utc} connector=${entry.connector_id}`,
      );
    }
  }

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

  const latestPayload = buildObservationsTimeseriesLatestPayload({
    bucket: bucketName || r2.bucket,
    generatedAt,
    indexPrefix,
    observationsPrefix: normalizedObservationsPrefix,
    observationsTimeseriesIndexPrefix: normalizedTimeseriesPrefix,
    daySummaries: daySummaries.map((entry) => ({
      day_utc: entry.day_utc,
      connector_count: entry.connector_count,
      connector_ids: entry.connector_ids,
      file_count: entry.file_count,
      indexed_file_count: entry.indexed_file_count,
      backed_up_at_utc: entry.backed_up_at_utc,
    })),
  });

  const latestKey = buildR2HistoryObservationsTimeseriesLatestKey(indexPrefix);
  const latestBody = `${JSON.stringify(latestPayload, null, 2)}\n`;
  const latestPut = await r2PutObjectIfChanged({
    r2,
    key: latestKey,
    body: latestBody,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });

  return {
    domain: "observations",
    index_kind: "timeseries_file_ranges",
    latest_index_key: latestKey,
    latest_index_bytes: latestPut.bytes,
    latest_index_put_skipped: Boolean(latestPut.skipped),
    observations_timeseries_index_prefix: normalizedTimeseriesPrefix,
    indexed_day_count: latestPayload.day_count,
    connector_index_count: connectorIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
    target_mode: Boolean(targetMap),
    target_requested_count: requestedTargetSet.size,
    target_matched_count: matchedTargetSet.size,
    target_unmatched_count: targetMap ? requestedTargetSet.size - matchedTargetSet.size : 0,
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
  writeR2 = true,
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
            const putResult = await r2PutObjectIfChanged({
              r2,
              key: connectorIndexKey,
              body,
              content_type: "application/json; charset=utf-8",
              writeR2,
            });
            return {
              connector_id: target.connector_id,
              index_key: connectorIndexKey,
              file_count: payload.file_count,
              indexed_file_count: payload.indexed_file_count,
              put_skipped: Boolean(putResult.skipped),
              backed_up_at_utc: payload.backed_up_at_utc,
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
        file_count: connectorResults.reduce((sum, entry) => sum + entry.file_count, 0),
        indexed_file_count: connectorResults.reduce(
          (sum, entry) => sum + entry.indexed_file_count,
          0,
        ),
        backed_up_at_utc:
          toIsoOrNull(dayManifestObject?.backed_up_at_utc)
          || pickMaxIsoTimestamp(connectorResults.map((entry) => entry.backed_up_at_utc)),
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

  const latestPayload = buildAqilevelsTimeseriesLatestPayload({
    bucket: bucketName || r2.bucket,
    generatedAt,
    indexPrefix,
    aqilevelsPrefix: normalizedAqilevelsPrefix,
    aqilevelsTimeseriesIndexPrefix: normalizedTimeseriesPrefix,
    daySummaries: daySummaries.map((entry) => ({
      day_utc: entry.day_utc,
      connector_count: entry.connector_count,
      connector_ids: entry.connector_ids,
      file_count: entry.file_count,
      indexed_file_count: entry.indexed_file_count,
      backed_up_at_utc: entry.backed_up_at_utc,
    })),
  });

  const latestKey = buildR2HistoryAqilevelsTimeseriesLatestKey(indexPrefix);
  const latestBody = `${JSON.stringify(latestPayload, null, 2)}\n`;
  const latestPut = await r2PutObjectIfChanged({
    r2,
    key: latestKey,
    body: latestBody,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });

  return {
    domain: "aqilevels",
    index_kind: "timeseries_file_ranges",
    latest_index_key: latestKey,
    latest_index_bytes: latestPut.bytes,
    latest_index_put_skipped: Boolean(latestPut.skipped),
    aqilevels_timeseries_index_prefix: normalizedTimeseriesPrefix,
    indexed_day_count: latestPayload.day_count,
    connector_index_count: connectorIndexCount,
    file_count: fileCount,
    indexed_file_count: indexedFileCount,
    warning_count: warnings.length,
    warnings,
  };
}

async function rebuildR2HistoryV2TimeseriesIndexes({
  r2,
  bucketName,
  domain,
  dataPrefix,
  indexPrefix = DEFAULT_R2_HISTORY_V2_INDEX_PREFIX,
  timeseriesIndexPrefix,
  generatedAt = new Date().toISOString(),
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  maxKeys = DEFAULT_MAX_KEYS,
  computeMissingTimeseriesCounts = false,
  strictMissingTimeseriesCounts = false,
  writeR2 = true,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (normalizedDomain !== "observations" && normalizedDomain !== "aqilevels") {
    throw new Error(`Unsupported R2 history v2 timeseries index domain: ${String(domain || "")}`);
  }
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for R2 history v2 timeseries index rebuild");
  }

  const normalizedDataPrefix = normalizePrefix(dataPrefix);
  const normalizedIndexPrefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_V2_INDEX_PREFIX);
  const normalizedTimeseriesPrefix = normalizePrefix(timeseriesIndexPrefix || (
    normalizedDomain === "observations"
      ? DEFAULT_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
      : DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX
  ));
  const dayPrefixes = await r2ListAllCommonPrefixes({
    r2,
    prefix: `${normalizedDataPrefix}/`,
    delimiter: "/",
    max_keys: maxKeys,
  });
  const dayList = dayPrefixes
    .map((prefix) => parseDayFromPrefix(prefix, normalizedDataPrefix))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const warnings = [];
  const daySummaries = (await mapWithConcurrency(
    dayList,
    fetchConcurrency,
    async (dayUtc) => {
      const dayManifestKey = `${normalizedDataPrefix}/day_utc=${dayUtc}/manifest.json`;
      let dayManifestObject;
      try {
        dayManifestObject = await fetchJsonObjectFromR2(r2, dayManifestKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("(404)")) {
          warnings.push(`Skipped missing ${normalizedDomain} v2 day manifest for ${dayUtc}`);
          return null;
        }
        throw new Error(`Failed to read ${normalizedDomain} v2 day manifest ${dayManifestKey}: ${message}`);
      }

      const connectorTargets = resolveHistoryV2ConnectorManifestTargets(
        dayManifestObject,
        dayUtc,
        normalizedDataPrefix,
      );
      const connectorResults = (await mapWithConcurrency(
        connectorTargets,
        fetchConcurrency,
        async (connectorTarget) => {
          let connectorManifestObject;
          try {
            connectorManifestObject = await fetchJsonObjectFromR2(r2, connectorTarget.manifest_key);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(
              `Skipped ${normalizedDomain} v2 connector manifest day=${dayUtc} connector=${connectorTarget.connector_id}: ${message}`,
            );
            return null;
          }

          const pollutantTargets = resolveHistoryV2PollutantManifestTargets(
            connectorManifestObject,
            dayUtc,
            connectorTarget.connector_id,
            normalizedDataPrefix,
            normalizedDomain,
          );
          const pollutantResults = (await mapWithConcurrency(
            pollutantTargets,
            fetchConcurrency,
            async (pollutantTarget) => {
              try {
                let pollutantManifestObject = await fetchJsonObjectFromR2(
                  r2,
                  pollutantTarget.manifest_key,
                );
                if (computeMissingTimeseriesCounts) {
                  pollutantManifestObject = await maybePatchHistoryV2PollutantManifestWithCounts({
                    r2,
                    manifestKey: pollutantTarget.manifest_key,
                    pollutantManifest: pollutantManifestObject,
                    warningsSink: warnings,
                    dayUtc,
                    connectorId: connectorTarget.connector_id,
                    pollutantCode: pollutantTarget.pollutant_code,
                    writeR2,
                  });
                }
                const payload = buildHistoryV2TimeseriesPollutantIndexPayload({
                  domain: normalizedDomain,
                  grain: normalizedDomain === "aqilevels" ? "hourly" : null,
                  profile: normalizedDomain === "aqilevels" ? "data" : null,
                  dayUtc,
                  connectorId: connectorTarget.connector_id,
                  pollutantCode: pollutantTarget.pollutant_code,
                  generatedAt,
                  bucket: bucketName || r2.bucket,
                  dataPrefix: normalizedDataPrefix,
                  pollutantManifestKey: pollutantTarget.manifest_key,
                  pollutantManifest: pollutantManifestObject,
                });
                handleMissingTimeseriesCounts({
                  payload,
                  domain: normalizedDomain,
                  manifestKey: pollutantTarget.manifest_key,
                  dayUtc,
                  connectorId: connectorTarget.connector_id,
                  pollutantCode: pollutantTarget.pollutant_code,
                  warnings,
                  strictMissingTimeseriesCounts,
                });
                const pollutantIndexKey = normalizedDomain === "observations"
                  ? buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
                    normalizedTimeseriesPrefix,
                    dayUtc,
                    connectorTarget.connector_id,
                    pollutantTarget.pollutant_code,
                  )
                  : buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey(
                    normalizedTimeseriesPrefix,
                    dayUtc,
                    connectorTarget.connector_id,
                    pollutantTarget.pollutant_code,
                  );
                const body = `${JSON.stringify(payload, null, 2)}\n`;
                const putResult = await r2PutObjectIfChanged({
                  r2,
                  key: pollutantIndexKey,
                  body,
                  content_type: "application/json; charset=utf-8",
                  writeR2,
                });
                return {
                  connector_id: connectorTarget.connector_id,
                  pollutant_code: pollutantTarget.pollutant_code,
                  index_key: pollutantIndexKey,
                  row_count: payload.source_row_count,
                  file_count: payload.file_count,
                  indexed_file_count: payload.indexed_file_count,
                  put_skipped: Boolean(putResult.skipped),
                  backed_up_at_utc: payload.backed_up_at_utc,
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (strictMissingTimeseriesCounts && message.includes(MISSING_TIMESERIES_COUNTS_PREFIX)) {
                  throw error;
                }
                warnings.push(
                  `Skipped ${normalizedDomain} v2 pollutant timeseries index day=${dayUtc} connector=${connectorTarget.connector_id} pollutant=${pollutantTarget.pollutant_code}: ${message}`,
                );
                return null;
              }
            },
          )).filter(Boolean);

          return {
            connector_id: connectorTarget.connector_id,
            pollutant_indexes: pollutantResults.sort((a, b) =>
              a.pollutant_code.localeCompare(b.pollutant_code)
            ),
            row_count: pollutantResults.reduce(
              (sum, entry) => sum + (parseNonNegativeInt(entry.row_count) || 0),
              0,
            ),
            backed_up_at_utc:
              toIsoOrNull(connectorManifestObject?.backed_up_at_utc)
              || pickMaxIsoTimestamp(pollutantResults.map((entry) => entry.backed_up_at_utc)),
          };
        },
      ))
        .filter(Boolean)
        .sort((a, b) => a.connector_id - b.connector_id);

      const pollutantIndexes = connectorResults.flatMap((entry) => entry.pollutant_indexes);
      const pollutantCodes = Array.from(new Set(
        pollutantIndexes.map((entry) => entry.pollutant_code).filter(Boolean),
      )).sort((a, b) => a.localeCompare(b));
      return {
        day_utc: dayUtc,
        connector_count: connectorResults.length,
        connector_ids: connectorResults.map((entry) => entry.connector_id),
        connectors: connectorResults.map((entry) => ({
          connector_id: entry.connector_id,
          row_count: entry.row_count,
        })),
        total_rows: connectorResults.reduce((sum, entry) => sum + entry.row_count, 0),
        pollutant_codes: pollutantCodes,
        pollutant_index_count: pollutantIndexes.length,
        file_count: pollutantIndexes.reduce((sum, entry) => sum + entry.file_count, 0),
        indexed_file_count: pollutantIndexes.reduce(
          (sum, entry) => sum + entry.indexed_file_count,
          0,
        ),
        backed_up_at_utc:
          toIsoOrNull(dayManifestObject?.backed_up_at_utc)
          || pickMaxIsoTimestamp(connectorResults.map((entry) => entry.backed_up_at_utc)),
        connector_indexes: connectorResults,
      };
    },
  )).filter(Boolean);

  const latestPayload = buildHistoryV2TimeseriesLatestPayload({
    domain: normalizedDomain,
    grain: normalizedDomain === "aqilevels" ? "hourly" : null,
    profile: normalizedDomain === "aqilevels" ? "data" : null,
    bucket: bucketName || r2.bucket,
    generatedAt,
    indexPrefix: normalizedIndexPrefix,
    dataPrefix: normalizedDataPrefix,
    timeseriesIndexPrefix: normalizedTimeseriesPrefix,
    daySummaries,
  });
  const latestKey = normalizedDomain === "observations"
    ? buildR2HistoryV2ObservationsTimeseriesLatestKey(normalizedIndexPrefix)
    : buildR2HistoryV2AqilevelsHourlyDataTimeseriesLatestKey(normalizedIndexPrefix);
  const latestBody = `${JSON.stringify(latestPayload, null, 2)}\n`;
  const latestPut = await r2PutObjectIfChanged({
    r2,
    key: latestKey,
    body: latestBody,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });

  return {
    history_version: "v2",
    domain: normalizedDomain,
    grain: normalizedDomain === "aqilevels" ? "hourly" : null,
    profile: normalizedDomain === "aqilevels" ? "data" : null,
    index_kind: "timeseries_file_ranges",
    latest_index_key: latestKey,
    latest_index_bytes: latestPut.bytes,
    latest_index_put_skipped: Boolean(latestPut.skipped),
    data_prefix: normalizedDataPrefix,
    timeseries_index_prefix: normalizedTimeseriesPrefix,
    day_prefix_count: dayList.length,
    indexed_day_count: latestPayload.day_count,
    connector_index_count: latestPayload.connector_index_count,
    pollutant_index_count: latestPayload.pollutant_index_count,
    file_count: latestPayload.file_count,
    indexed_file_count: latestPayload.indexed_file_count,
    warning_count: warnings.length,
    warnings,
  };
}

async function updateR2HistoryV2TimeseriesIndexesTargeted({
  r2,
  bucketName,
  domain,
  dataPrefix,
  indexPrefix = DEFAULT_R2_HISTORY_V2_INDEX_PREFIX,
  timeseriesIndexPrefix,
  generatedAt = new Date().toISOString(),
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  computeMissingTimeseriesCounts = false,
  strictMissingTimeseriesCounts = false,
  fromDayUtc,
  toDayUtc,
  connectorId = null,
  writeR2 = true,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (normalizedDomain !== "observations" && normalizedDomain !== "aqilevels") {
    throw new Error(`Unsupported R2 history v2 timeseries index domain: ${String(domain || "")}`);
  }
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for targeted R2 history v2 timeseries index update");
  }

  const normalizedDataPrefix = normalizePrefix(dataPrefix);
  const normalizedIndexPrefix = normalizePrefix(indexPrefix || DEFAULT_R2_HISTORY_V2_INDEX_PREFIX);
  const normalizedTimeseriesPrefix = normalizePrefix(timeseriesIndexPrefix || (
    normalizedDomain === "observations"
      ? DEFAULT_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
      : DEFAULT_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX
  ));
  const normalizedConnectorId = connectorId == null ? null : parsePositiveId(connectorId);
  if (connectorId != null && !normalizedConnectorId) {
    throw new Error(`Invalid targeted v2 timeseries connector_id: ${String(connectorId || "")}`);
  }

  const dayList = enumerateIsoDaysInclusive(fromDayUtc, toDayUtc);
  const warnings = [];
  const affectedPollutantIndexes = [];

  const latestKey = normalizedDomain === "observations"
    ? buildR2HistoryV2ObservationsTimeseriesLatestKey(normalizedIndexPrefix)
    : buildR2HistoryV2AqilevelsHourlyDataTimeseriesLatestKey(normalizedIndexPrefix);

  const existingLatest = await fetchJsonObjectFromR2IfExists(r2, latestKey);
  const existingLatestPayload = existingLatest.exists ? existingLatest.payload : null;
  const daySummaryMap = new Map();
  for (const entry of Array.isArray(existingLatestPayload?.day_summaries)
    ? existingLatestPayload.day_summaries
    : []) {
    const normalizedEntry = normalizeHistoryV2TimeseriesLatestDaySummary(entry, normalizedDomain);
    if (normalizedEntry) {
      daySummaryMap.set(normalizedEntry.day_utc, normalizedEntry);
    }
  }

  let rewrittenConnectorIndexCount = 0;
  let rewrittenPollutantIndexCount = 0;
  let rewrittenPutSkippedCount = 0;

  for (const dayUtc of dayList) {
    const dayManifestKey = `${normalizedDataPrefix}/day_utc=${dayUtc}/manifest.json`;
    const dayManifestResult = await fetchJsonObjectFromR2IfExists(r2, dayManifestKey);
    if (!dayManifestResult.exists) {
      throw new Error(`blocked_dependency|required_day_manifest_unreadable|${dayManifestKey}`);
    }
    const dayManifestObject = dayManifestResult.payload;

    const connectorTargets = resolveHistoryV2ConnectorManifestTargets(
      dayManifestObject,
      dayUtc,
      normalizedDataPrefix,
    );

    if (normalizedConnectorId && !connectorTargets.some(t => t.connector_id === normalizedConnectorId)) {
      warnings.push(
        `Target connector not found in ${normalizedDomain} v2 manifests day=${dayUtc} connector=${normalizedConnectorId}`,
      );
    }

    const connectorResults = (await mapWithConcurrency(
      connectorTargets,
      fetchConcurrency,
      async (connectorTarget) => {
        let connectorManifestObject;
        try {
          connectorManifestObject = await fetchJsonObjectFromR2(r2, connectorTarget.manifest_key);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`blocked_dependency|required_connector_manifest_unreadable|${connectorTarget.manifest_key}|${message}`);
        }

        const pollutantTargets = resolveHistoryV2PollutantManifestTargets(
          connectorManifestObject,
          dayUtc,
          connectorTarget.connector_id,
          normalizedDataPrefix,
          normalizedDomain,
        );
        const pollutantResults = (await mapWithConcurrency(
          pollutantTargets,
          fetchConcurrency,
          async (pollutantTarget) => {
            try {
              let pollutantManifestObject = await fetchJsonObjectFromR2(
                r2,
                pollutantTarget.manifest_key,
              );
              const shouldWrite = !normalizedConnectorId || connectorTarget.connector_id === normalizedConnectorId;
              if (computeMissingTimeseriesCounts && shouldWrite) {
                pollutantManifestObject = await maybePatchHistoryV2PollutantManifestWithCounts({
                  r2,
                  manifestKey: pollutantTarget.manifest_key,
                  pollutantManifest: pollutantManifestObject,
                  warningsSink: warnings,
                  dayUtc,
                  connectorId: connectorTarget.connector_id,
                  pollutantCode: pollutantTarget.pollutant_code,
                  writeR2,
                });
              }
              const payload = buildHistoryV2TimeseriesPollutantIndexPayload({
                domain: normalizedDomain,
                grain: normalizedDomain === "aqilevels" ? "hourly" : null,
                profile: normalizedDomain === "aqilevels" ? "data" : null,
                dayUtc,
                connectorId: connectorTarget.connector_id,
                pollutantCode: pollutantTarget.pollutant_code,
                generatedAt,
                bucket: bucketName || r2.bucket,
                dataPrefix: normalizedDataPrefix,
                pollutantManifestKey: pollutantTarget.manifest_key,
                pollutantManifest: pollutantManifestObject,
              });
              if (shouldWrite) {
                handleMissingTimeseriesCounts({
                  payload,
                  domain: normalizedDomain,
                  manifestKey: pollutantTarget.manifest_key,
                  dayUtc,
                  connectorId: connectorTarget.connector_id,
                  pollutantCode: pollutantTarget.pollutant_code,
                  warnings,
                  strictMissingTimeseriesCounts,
                });
              }
              let putSkipped = null;
              let pollutantIndexKey = null;
              let previousIndex = { exists: false, payload: null };

              if (shouldWrite) {
                pollutantIndexKey = normalizedDomain === "observations"
                  ? buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
                    normalizedTimeseriesPrefix,
                    dayUtc,
                    connectorTarget.connector_id,
                    pollutantTarget.pollutant_code,
                  )
                  : buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey(
                    normalizedTimeseriesPrefix,
                    dayUtc,
                    connectorTarget.connector_id,
                    pollutantTarget.pollutant_code,
                  );
                previousIndex = await fetchJsonObjectFromR2IfExists(r2, pollutantIndexKey);
                const body = `${JSON.stringify(payload, null, 2)}\n`;
                const putResult = await r2PutObjectIfChanged({
                  r2,
                  key: pollutantIndexKey,
                  body,
                  content_type: "application/json; charset=utf-8",
                  writeR2,
                });
                putSkipped = Boolean(putResult.skipped);
              }

              return {
                connector_id: connectorTarget.connector_id,
                pollutant_code: pollutantTarget.pollutant_code,
                row_count: payload.source_row_count,
                file_count: payload.file_count,
                indexed_file_count: payload.indexed_file_count,
                backed_up_at_utc: payload.backed_up_at_utc,
                wrote_index: shouldWrite,
                put_skipped: putSkipped,
                index_key: pollutantIndexKey,
                payload,
                old_payload: previousIndex.exists ? previousIndex.payload : null,
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(`blocked_dependency|required_pollutant_index_unreadable|${pollutantTarget.manifest_key}|${message}`);
            }
          },
        )).filter(Boolean);

        return {
          connector_id: connectorTarget.connector_id,
          pollutant_indexes: pollutantResults.sort((a, b) =>
            a.pollutant_code.localeCompare(b.pollutant_code)
          ),
          row_count: pollutantResults.reduce(
            (sum, entry) => sum + (parseNonNegativeInt(entry.row_count) || 0),
            0,
          ),
          backed_up_at_utc:
            toIsoOrNull(connectorManifestObject?.backed_up_at_utc)
            || pickMaxIsoTimestamp(pollutantResults.map((entry) => entry.backed_up_at_utc)),
          wrote_index: pollutantResults.some(p => p.wrote_index),
          put_skipped_count: pollutantResults.filter(p => p.put_skipped).length,
        };
      },
    ))
      .filter(Boolean)
      .sort((a, b) => a.connector_id - b.connector_id);

    rewrittenConnectorIndexCount += connectorResults.filter((entry) => entry.wrote_index).length;
    rewrittenPollutantIndexCount += connectorResults.reduce((sum, entry) => sum + entry.pollutant_indexes.filter(p => p.wrote_index).length, 0);
    rewrittenPutSkippedCount += connectorResults.reduce((sum, entry) => sum + entry.put_skipped_count, 0);

    for (const connectorResult of connectorResults) {
      for (const pollutantIndex of connectorResult.pollutant_indexes) {
        if (pollutantIndex.wrote_index && pollutantIndex.payload && pollutantIndex.index_key) {
          affectedPollutantIndexes.push({ key: pollutantIndex.index_key, payload: pollutantIndex.payload, old_payload: pollutantIndex.old_payload });
        }
      }
    }

    const pollutantIndexes = connectorResults.flatMap((entry) => entry.pollutant_indexes);
    const pollutantCodes = Array.from(new Set(
      pollutantIndexes.map((entry) => entry.pollutant_code).filter(Boolean),
    )).sort((a, b) => a.localeCompare(b));

    const daySummary = {
      day_utc: dayUtc,
      connector_count: connectorResults.length,
      connector_ids: connectorResults.map((entry) => entry.connector_id),
      connectors: connectorResults.map((entry) => ({
        connector_id: entry.connector_id,
        row_count: entry.row_count,
      })),
      total_rows: connectorResults.reduce((sum, entry) => sum + entry.row_count, 0),
      pollutant_codes: pollutantCodes,
      pollutant_index_count: pollutantIndexes.length,
      file_count: pollutantIndexes.reduce((sum, entry) => sum + entry.file_count, 0),
      indexed_file_count: pollutantIndexes.reduce(
        (sum, entry) => sum + entry.indexed_file_count,
        0,
      ),
      backed_up_at_utc:
        toIsoOrNull(dayManifestObject?.backed_up_at_utc)
        || pickMaxIsoTimestamp(connectorResults.map((entry) => entry.backed_up_at_utc)),
    };
    daySummaryMap.set(dayUtc, normalizeHistoryV2TimeseriesLatestDaySummary(daySummary, normalizedDomain));
  }

  const latestPayload = buildHistoryV2TimeseriesLatestPayload({
    domain: normalizedDomain,
    grain: normalizedDomain === "aqilevels" ? "hourly" : null,
    profile: normalizedDomain === "aqilevels" ? "data" : null,
    bucket: bucketName || r2.bucket,
    generatedAt,
    existingGeneratedAt: existingLatestPayload?.generated_at,
    indexPrefix: normalizedIndexPrefix,
    dataPrefix: normalizedDataPrefix,
    timeseriesIndexPrefix: normalizedTimeseriesPrefix,
    daySummaries: Array.from(daySummaryMap.values()),
  });

  const latestBody = `${JSON.stringify(latestPayload, null, 2)}\n`;
  const latestPut = await r2PutObjectIfChanged({
    r2,
    key: latestKey,
    body: latestBody,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });

  return {
    history_version: "v2",
    domain: normalizedDomain,
    grain: normalizedDomain === "aqilevels" ? "hourly" : null,
    profile: normalizedDomain === "aqilevels" ? "data" : null,
    index_kind: "timeseries_file_ranges",
    mode: "targeted",
    from_day_utc: dayList.length ? dayList[0] : null,
    to_day_utc: dayList.length ? dayList[dayList.length - 1] : null,
    targeted_day_count: dayList.length,
    targeted_connector_id: normalizedConnectorId,
    rewritten_connector_index_count: rewrittenConnectorIndexCount,
    rewritten_pollutant_index_count: rewrittenPollutantIndexCount,
    rewritten_put_skipped_count: rewrittenPutSkippedCount,
    latest_index_key: latestKey,
    latest_index_bytes: latestPut.bytes,
    latest_index_put_skipped: Boolean(latestPut.skipped),
    data_prefix: normalizedDataPrefix,
    timeseries_index_prefix: normalizedTimeseriesPrefix,
    indexed_day_count: latestPayload.day_count,
    connector_index_count: latestPayload.connector_index_count,
    pollutant_index_count: latestPayload.pollutant_index_count,
    file_count: latestPayload.file_count,
    indexed_file_count: latestPayload.indexed_file_count,
    warning_count: warnings.length,
    warnings,
    affected_pollutant_indexes: affectedPollutantIndexes,
  };
}

async function updateR2HistoryIndexForDomainTargeted({
  r2,
  bucketName,
  domain,
  domainPrefix,
  indexPrefix = DEFAULT_R2_HISTORY_INDEX_PREFIX,
  generatedAt = new Date().toISOString(),
  fromDayUtc,
  toDayUtc,
  writeR2 = true,
}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (!SUPPORTED_DOMAINS.has(normalizedDomain)) {
    throw new Error(`Unsupported R2 history index domain: ${String(domain || "")}`);
  }
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for targeted R2 history index update");
  }

  const normalizedPrefix = normalizePrefix(domainPrefix);
  const dayList = enumerateIsoDaysInclusive(fromDayUtc, toDayUtc);
  const warnings = [];
  const indexKey = buildR2HistoryIndexKey(indexPrefix, normalizedDomain);
  const existingIndex = await fetchJsonObjectFromR2IfExists(r2, indexKey);
  const existingPayload = existingIndex.exists
    ? normalizeR2HistoryIndexDomain(existingIndex.payload, { expectedDomain: normalizedDomain })
    : null;
  const summaryMap = new Map(
    Array.from(existingPayload?.day_summaries || []).map((entry) => [entry.day_utc, entry]),
  );

  for (const dayUtc of dayList) {
    const manifestKey = `${normalizedPrefix}/day_utc=${dayUtc}/manifest.json`;
    const manifestResult = await fetchJsonObjectFromR2IfExists(r2, manifestKey);
    if (!manifestResult.exists) {
      summaryMap.delete(dayUtc);
      warnings.push(`Removed missing ${normalizedDomain} day summary for ${dayUtc}`);
      continue;
    }
    const summary = buildDaySummaryFromManifest({
      domain: normalizedDomain,
      dayUtc,
      manifest: manifestResult.payload,
    });
    if (!summary) {
      summaryMap.delete(dayUtc);
      warnings.push(`Skipped invalid ${normalizedDomain} day manifest for ${dayUtc}`);
      continue;
    }
    summaryMap.set(dayUtc, summary);
  }

  const payload = buildDomainIndexPayload({
    domain: normalizedDomain,
    prefix: normalizedPrefix,
    bucket: bucketName || r2.bucket,
    generatedAt,
    daySummaries: Array.from(summaryMap.values()),
  });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const putResult = await r2PutObjectIfChanged({
    r2,
    key: indexKey,
    body,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });

  return {
    domain: normalizedDomain,
    mode: "targeted",
    from_day_utc: dayList.length ? dayList[0] : null,
    to_day_utc: dayList.length ? dayList[dayList.length - 1] : null,
    targeted_day_count: dayList.length,
    index_key: indexKey,
    index_bytes: putResult.bytes,
    index_put_skipped: Boolean(putResult.skipped),
    indexed_day_count: payload.day_count,
    total_rows: payload.total_rows,
    warning_count: warnings.length,
    warnings,
  };
}

async function updateR2HistoryObservationsTimeseriesIndexesTargeted({
  r2,
  bucketName,
  observationsPrefix,
  indexPrefix = DEFAULT_R2_HISTORY_INDEX_PREFIX,
  observationsTimeseriesIndexPrefix = DEFAULT_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
  generatedAt = new Date().toISOString(),
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  computeMissingTimeseriesCounts = false,
  fromDayUtc,
  toDayUtc,
  connectorId = null,
  writeR2 = true,
}) {
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for targeted observations timeseries index update");
  }

  const normalizedObservationsPrefix = normalizePrefix(observationsPrefix);
  const normalizedTimeseriesPrefix = normalizePrefix(observationsTimeseriesIndexPrefix);
  const normalizedConnectorId = connectorId == null ? null : parsePositiveId(connectorId);
  if (connectorId != null && !normalizedConnectorId) {
    throw new Error(`Invalid targeted observations connector_id: ${String(connectorId || "")}`);
  }

  const dayList = enumerateIsoDaysInclusive(fromDayUtc, toDayUtc);
  const warnings = [];
  const latestKey = buildR2HistoryObservationsTimeseriesLatestKey(indexPrefix);
  const existingLatest = await fetchJsonObjectFromR2IfExists(r2, latestKey);
  const existingLatestPayload = existingLatest.exists ? existingLatest.payload : null;
  const daySummaryMap = new Map();
  for (const entry of Array.isArray(existingLatestPayload?.day_summaries)
    ? existingLatestPayload.day_summaries
    : []) {
    const normalizedEntry = normalizeTimeseriesLatestDaySummary(entry);
    if (normalizedEntry) {
      daySummaryMap.set(normalizedEntry.day_utc, normalizedEntry);
    }
  }

  let rewrittenConnectorIndexCount = 0;
  let rewrittenPutSkippedCount = 0;
  for (const dayUtc of dayList) {
    const dayManifestKey = `${normalizedObservationsPrefix}/day_utc=${dayUtc}/manifest.json`;
    const dayManifestResult = await fetchJsonObjectFromR2IfExists(r2, dayManifestKey);
    if (!dayManifestResult.exists) {
      daySummaryMap.delete(dayUtc);
      warnings.push(`Removed missing observations timeseries day summary for ${dayUtc}`);
      continue;
    }
    const dayManifestObject = dayManifestResult.payload;
    const targets = resolveObservationConnectorManifestTargets(
      dayManifestObject,
      dayUtc,
      normalizedObservationsPrefix,
    );
    const writeTargets = normalizedConnectorId
      ? targets.filter((target) => target.connector_id === normalizedConnectorId)
      : targets;
    if (normalizedConnectorId && writeTargets.length === 0) {
      warnings.push(
        `Target connector not found in observations manifests day=${dayUtc} connector=${normalizedConnectorId}`,
      );
    }

    const connectorResults = (await mapWithConcurrency(
      targets,
      fetchConcurrency,
      async (target) => {
        try {
          let connectorManifestObject = await fetchJsonObjectFromR2(r2, target.manifest_key);
          if (computeMissingTimeseriesCounts) {
            connectorManifestObject = await maybePatchConnectorManifestWithCounts({
              r2,
              manifestKey: target.manifest_key,
              connectorManifest: connectorManifestObject,
              warningsSink: warnings,
              dayUtc,
              connectorId: target.connector_id,
              writeR2,
            });
          }
          const payload = buildObservationTimeseriesConnectorIndexPayload({
            dayUtc,
            connectorId: target.connector_id,
            generatedAt,
            bucket: bucketName || r2.bucket,
            observationsPrefix: normalizedObservationsPrefix,
            connectorManifestKey: target.manifest_key,
            connectorManifest: connectorManifestObject,
          });
          const shouldWrite = !normalizedConnectorId || target.connector_id === normalizedConnectorId;
          let putSkipped = null;
          if (shouldWrite) {
            const connectorIndexKey = buildR2HistoryObservationsTimeseriesConnectorIndexKey(
              normalizedTimeseriesPrefix,
              dayUtc,
              target.connector_id,
            );
            const body = `${JSON.stringify(payload, null, 2)}\n`;
            const putResult = await r2PutObjectIfChanged({
              r2,
              key: connectorIndexKey,
              body,
              content_type: "application/json; charset=utf-8",
              writeR2,
            });
            putSkipped = Boolean(putResult.skipped);
          }
          return {
            connector_id: target.connector_id,
            file_count: payload.file_count,
            indexed_file_count: payload.indexed_file_count,
            backed_up_at_utc: payload.backed_up_at_utc,
            wrote_index: shouldWrite,
            put_skipped: putSkipped,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(
            `Skipped targeted observations timeseries connector index for day=${dayUtc} connector=${target.connector_id}: ${message}`,
          );
          return null;
        }
      },
    ))
      .filter(Boolean)
      .sort((a, b) => a.connector_id - b.connector_id);

    rewrittenConnectorIndexCount += connectorResults.filter((entry) => entry.wrote_index).length;
    rewrittenPutSkippedCount += connectorResults.filter(
      (entry) => entry.wrote_index && entry.put_skipped,
    ).length;
    daySummaryMap.set(dayUtc, buildTimeseriesLatestDaySummary({
      dayUtc,
      connectorPayloads: connectorResults,
      dayBackedUpAtUtc: dayManifestObject?.backed_up_at_utc,
    }));
  }

  const latestPayload = buildObservationsTimeseriesLatestPayload({
    bucket: bucketName || r2.bucket,
    generatedAt,
    existingGeneratedAt: existingLatestPayload?.generated_at,
    indexPrefix,
    observationsPrefix: normalizedObservationsPrefix,
    observationsTimeseriesIndexPrefix: normalizedTimeseriesPrefix,
    daySummaries: Array.from(daySummaryMap.values()),
  });
  const latestBody = `${JSON.stringify(latestPayload, null, 2)}\n`;
  const latestPut = await r2PutObjectIfChanged({
    r2,
    key: latestKey,
    body: latestBody,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });

  return {
    domain: "observations",
    index_kind: "timeseries_file_ranges",
    mode: "targeted",
    from_day_utc: dayList.length ? dayList[0] : null,
    to_day_utc: dayList.length ? dayList[dayList.length - 1] : null,
    targeted_day_count: dayList.length,
    targeted_connector_id: normalizedConnectorId,
    rewritten_connector_index_count: rewrittenConnectorIndexCount,
    rewritten_put_skipped_count: rewrittenPutSkippedCount,
    latest_index_key: latestKey,
    latest_index_bytes: latestPut.bytes,
    latest_index_put_skipped: Boolean(latestPut.skipped),
    observations_timeseries_index_prefix: normalizedTimeseriesPrefix,
    indexed_day_count: latestPayload.day_count,
    connector_index_count: latestPayload.connector_index_count,
    file_count: latestPayload.file_count,
    indexed_file_count: latestPayload.indexed_file_count,
    warning_count: warnings.length,
    warnings,
  };
}

async function updateR2HistoryAqilevelsTimeseriesIndexesTargeted({
  r2,
  bucketName,
  aqilevelsPrefix,
  indexPrefix = DEFAULT_R2_HISTORY_INDEX_PREFIX,
  aqilevelsTimeseriesIndexPrefix = DEFAULT_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX,
  generatedAt = new Date().toISOString(),
  fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
  fromDayUtc,
  toDayUtc,
  connectorId = null,
  writeR2 = true,
}) {
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for targeted aqilevels timeseries index update");
  }

  const normalizedAqilevelsPrefix = normalizePrefix(aqilevelsPrefix);
  const normalizedTimeseriesPrefix = normalizePrefix(aqilevelsTimeseriesIndexPrefix);
  const normalizedConnectorId = connectorId == null ? null : parsePositiveId(connectorId);
  if (connectorId != null && !normalizedConnectorId) {
    throw new Error(`Invalid targeted aqilevels connector_id: ${String(connectorId || "")}`);
  }

  const dayList = enumerateIsoDaysInclusive(fromDayUtc, toDayUtc);
  const warnings = [];
  const latestKey = buildR2HistoryAqilevelsTimeseriesLatestKey(indexPrefix);
  const existingLatest = await fetchJsonObjectFromR2IfExists(r2, latestKey);
  const existingLatestPayload = existingLatest.exists ? existingLatest.payload : null;
  const daySummaryMap = new Map();
  for (const entry of Array.isArray(existingLatestPayload?.day_summaries)
    ? existingLatestPayload.day_summaries
    : []) {
    const normalizedEntry = normalizeTimeseriesLatestDaySummary(entry);
    if (normalizedEntry) {
      daySummaryMap.set(normalizedEntry.day_utc, normalizedEntry);
    }
  }

  let rewrittenConnectorIndexCount = 0;
  let rewrittenPutSkippedCount = 0;
  for (const dayUtc of dayList) {
    const dayManifestKey = `${normalizedAqilevelsPrefix}/day_utc=${dayUtc}/manifest.json`;
    const dayManifestResult = await fetchJsonObjectFromR2IfExists(r2, dayManifestKey);
    if (!dayManifestResult.exists) {
      daySummaryMap.delete(dayUtc);
      warnings.push(`Removed missing aqilevels timeseries day summary for ${dayUtc}`);
      continue;
    }
    const dayManifestObject = dayManifestResult.payload;
    const targets = resolveAqilevelsConnectorManifestTargets(
      dayManifestObject,
      dayUtc,
      normalizedAqilevelsPrefix,
    );
    const writeTargets = normalizedConnectorId
      ? targets.filter((target) => target.connector_id === normalizedConnectorId)
      : targets;
    if (normalizedConnectorId && writeTargets.length === 0) {
      warnings.push(
        `Target connector not found in aqilevels manifests day=${dayUtc} connector=${normalizedConnectorId}`,
      );
    }

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
          const shouldWrite = !normalizedConnectorId || target.connector_id === normalizedConnectorId;
          let putSkipped = null;
          if (shouldWrite) {
            const connectorIndexKey = buildR2HistoryAqilevelsTimeseriesConnectorIndexKey(
              normalizedTimeseriesPrefix,
              dayUtc,
              target.connector_id,
            );
            const body = `${JSON.stringify(payload, null, 2)}\n`;
            const putResult = await r2PutObjectIfChanged({
              r2,
              key: connectorIndexKey,
              body,
              content_type: "application/json; charset=utf-8",
              writeR2,
            });
            putSkipped = Boolean(putResult.skipped);
          }
          return {
            connector_id: target.connector_id,
            file_count: payload.file_count,
            indexed_file_count: payload.indexed_file_count,
            backed_up_at_utc: payload.backed_up_at_utc,
            wrote_index: shouldWrite,
            put_skipped: putSkipped,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(
            `Skipped targeted aqilevels timeseries connector index for day=${dayUtc} connector=${target.connector_id}: ${message}`,
          );
          return null;
        }
      },
    ))
      .filter(Boolean)
      .sort((a, b) => a.connector_id - b.connector_id);

    rewrittenConnectorIndexCount += connectorResults.filter((entry) => entry.wrote_index).length;
    rewrittenPutSkippedCount += connectorResults.filter(
      (entry) => entry.wrote_index && entry.put_skipped,
    ).length;
    daySummaryMap.set(dayUtc, buildTimeseriesLatestDaySummary({
      dayUtc,
      connectorPayloads: connectorResults,
      dayBackedUpAtUtc: dayManifestObject?.backed_up_at_utc,
    }));
  }

  const latestPayload = buildAqilevelsTimeseriesLatestPayload({
    bucket: bucketName || r2.bucket,
    generatedAt,
    existingGeneratedAt: existingLatestPayload?.generated_at,
    indexPrefix,
    aqilevelsPrefix: normalizedAqilevelsPrefix,
    aqilevelsTimeseriesIndexPrefix: normalizedTimeseriesPrefix,
    daySummaries: Array.from(daySummaryMap.values()),
  });
  const latestBody = `${JSON.stringify(latestPayload, null, 2)}\n`;
  const latestPut = await r2PutObjectIfChanged({
    r2,
    key: latestKey,
    body: latestBody,
    content_type: "application/json; charset=utf-8",
    writeR2,
  });

  return {
    domain: "aqilevels",
    index_kind: "timeseries_file_ranges",
    mode: "targeted",
    from_day_utc: dayList.length ? dayList[0] : null,
    to_day_utc: dayList.length ? dayList[dayList.length - 1] : null,
    targeted_day_count: dayList.length,
    targeted_connector_id: normalizedConnectorId,
    rewritten_connector_index_count: rewrittenConnectorIndexCount,
    rewritten_put_skipped_count: rewrittenPutSkippedCount,
    latest_index_key: latestKey,
    latest_index_bytes: latestPut.bytes,
    latest_index_put_skipped: Boolean(latestPut.skipped),
    aqilevels_timeseries_index_prefix: normalizedTimeseriesPrefix,
    indexed_day_count: latestPayload.day_count,
    connector_index_count: latestPayload.connector_index_count,
    file_count: latestPayload.file_count,
    indexed_file_count: latestPayload.indexed_file_count,
    warning_count: warnings.length,
    warnings,
  };
}

export async function updateR2HistoryIndexesTargeted({
  env = defaultEnv(),
  historyVersion = "v1",
  domains = ["observations"],
  fromDayUtc,
  toDayUtc,
  connectorId = null,
  generatedAt = new Date().toISOString(),
  fetchConcurrency,
  computeMissingTimeseriesCounts = false,
  strictMissingTimeseriesCounts,
  timeseriesMetadataMode = "full",
  proposalOnly = false,
  writeR2 = true,
  r2: r2Override = null,
} = {}) {
  const config = resolveR2HistoryIndexConfig(env);
  const r2 = r2Override || config.r2;
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing R2 config for targeted R2 history index update");
  }

  const normalizedDomains = Array.from(new Set(
    (Array.isArray(domains) ? domains : []).map((domain) =>
      String(domain || "").trim().toLowerCase()
    ),
  )).filter((domain) => SUPPORTED_DOMAINS.has(domain));
  if (!normalizedDomains.length) {
    throw new Error("No supported domains requested for targeted R2 history index update");
  }

  const normalizedHistoryVersion = String(historyVersion || "v1").trim().toLowerCase();
  const results = [];
  let observationsTimeseries = null;
  let aqilevelsTimeseries = null;
  let timeseriesMetadata = null;
  for (const domain of normalizedDomains) {
    if (normalizedHistoryVersion === "v2") {
      const dataPrefix = domain === "observations"
        ? config.observations_prefix_v2
        : config.aqilevels_hourly_data_prefix_v2;
      const timeseriesIndexPrefix = domain === "observations"
        ? config.observations_timeseries_index_prefix_v2
        : config.aqilevels_hourly_data_timeseries_index_prefix_v2;
        
      const result = await updateR2HistoryV2TimeseriesIndexesTargeted({
        r2,
        bucketName: r2.bucket,
        domain,
        dataPrefix,
        indexPrefix: config.index_prefix_v2,
        timeseriesIndexPrefix,
        generatedAt,
        fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
        computeMissingTimeseriesCounts,
        strictMissingTimeseriesCounts: strictMissingTimeseriesCounts ?? config.strict_missing_timeseries_counts,
        fromDayUtc,
        toDayUtc,
        connectorId,
        writeR2,
      });
      results.push(result);
      if (domain === "observations") {
        observationsTimeseries = result;
      } else if (domain === "aqilevels") {
        aqilevelsTimeseries = result;
      }
    } else {
      const domainPrefix = domain === "observations"
        ? config.observations_prefix
        : config.aqilevels_prefix;
      results.push(await updateR2HistoryIndexForDomainTargeted({
        r2: config.r2,
        bucketName: config.r2.bucket,
        domain,
        domainPrefix,
        indexPrefix: config.index_prefix,
        generatedAt,
        fromDayUtc,
        toDayUtc,
        writeR2,
      }));

      if (domain === "observations") {
        observationsTimeseries = await updateR2HistoryObservationsTimeseriesIndexesTargeted({
          r2: config.r2,
          bucketName: config.r2.bucket,
          observationsPrefix: config.observations_prefix,
          indexPrefix: config.index_prefix,
          observationsTimeseriesIndexPrefix: config.observations_timeseries_index_prefix,
          generatedAt,
          fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
          computeMissingTimeseriesCounts,
          fromDayUtc,
          toDayUtc,
          connectorId,
          writeR2,
        });
      }
      if (domain === "aqilevels") {
        aqilevelsTimeseries = await updateR2HistoryAqilevelsTimeseriesIndexesTargeted({
          r2: config.r2,
          bucketName: config.r2.bucket,
          aqilevelsPrefix: config.aqilevels_prefix,
          indexPrefix: config.index_prefix,
          aqilevelsTimeseriesIndexPrefix: config.aqilevels_timeseries_index_prefix,
          generatedAt,
          fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
          fromDayUtc,
          toDayUtc,
          connectorId,
          writeR2,
        });
      }
    }
  }

  if (normalizedHistoryVersion === "v2") {
    if (timeseriesMetadataMode === "targeted") {
      const affectedPollutantIndexes = results.flatMap((result) =>
        Array.isArray(result?.affected_pollutant_indexes) ? result.affected_pollutant_indexes : []
      );
      timeseriesMetadata = await updateR2HistoryV2TimeseriesMetadataIndexesTargeted({
        r2,
        bucketName: r2.bucket,
        indexPrefix: config.index_prefix_v2,
        timeseriesMetadataIndexPrefix: config.timeseries_metadata_index_prefix_v2,
        affectedPollutantIndexes,
        generatedAt,
        writeR2,
        plannedOnly: proposalOnly,
      });
    } else {
      timeseriesMetadata = await rebuildR2HistoryV2TimeseriesMetadataIndexes({
      r2,
      bucketName: r2.bucket,
      indexPrefix: config.index_prefix_v2,
      observationsDataPrefix: config.observations_prefix_v2,
      aqilevelsHourlyDataPrefix: config.aqilevels_hourly_data_prefix_v2,
      observationsTimeseriesIndexPrefix: config.observations_timeseries_index_prefix_v2,
      aqilevelsHourlyDataTimeseriesIndexPrefix:
        config.aqilevels_hourly_data_timeseries_index_prefix_v2,
      timeseriesMetadataIndexPrefix: config.timeseries_metadata_index_prefix_v2,
      generatedAt,
      fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
      writeR2,
      });
    }
  }

  const responseIndexPrefix = normalizedHistoryVersion === "v2"
    ? config.index_prefix_v2
    : config.index_prefix;
  const responseObservationsTimeseriesIndexPrefix = normalizedHistoryVersion === "v2"
    ? config.observations_timeseries_index_prefix_v2
    : config.observations_timeseries_index_prefix;
  const responseAqilevelsTimeseriesIndexPrefix = normalizedHistoryVersion === "v2"
    ? config.aqilevels_hourly_data_timeseries_index_prefix_v2
    : config.aqilevels_timeseries_index_prefix;
  const responseObservationsPrefix = normalizedHistoryVersion === "v2"
    ? config.observations_prefix_v2
    : config.observations_prefix;
  const responseAqilevelsPrefix = normalizedHistoryVersion === "v2"
    ? config.aqilevels_hourly_data_prefix_v2
    : config.aqilevels_prefix;

  return {
    mode: "targeted",
    history_version: normalizedHistoryVersion,
    generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
    bucket: config.r2.bucket,
    index_prefix: responseIndexPrefix,
    observations_timeseries_index_prefix: responseObservationsTimeseriesIndexPrefix,
    aqilevels_timeseries_index_prefix: responseAqilevelsTimeseriesIndexPrefix,
    observations_prefix: responseObservationsPrefix,
    aqilevels_prefix: responseAqilevelsPrefix,
    from_day_utc: parseIsoDay(fromDayUtc),
    to_day_utc: parseIsoDay(toDayUtc),
    connector_id: connectorId == null ? null : parsePositiveId(connectorId),
    results,
    observations_timeseries: observationsTimeseries,
    aqilevels_timeseries: aqilevelsTimeseries,
    timeseries_metadata: timeseriesMetadata,
  };
}

export async function rebuildR2HistoryIndexes({
  env = defaultEnv(),
  domains = ["observations", "aqilevels"],
  historyVersion = "v1",
  generatedAt = new Date().toISOString(),
  fetchConcurrency,
  maxKeys,
  computeMissingTimeseriesCounts = false,
  strictMissingTimeseriesCounts,
  observationsTargets = null,
  writeR2 = true,
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

  const normalizedHistoryVersion = String(historyVersion || "v1").trim().toLowerCase();
  if (normalizedHistoryVersion !== "v1" && normalizedHistoryVersion !== "v2") {
    throw new Error(`Unsupported R2 history index version: ${String(historyVersion || "")}`);
  }

  if (normalizedHistoryVersion === "v2") {
    const results = [];
    let observationsTimeseries = null;
    let aqilevelsTimeseries = null;
    for (const domain of normalizedDomains) {
      if (domain === "observations") {
        observationsTimeseries = await rebuildR2HistoryV2TimeseriesIndexes({
          r2: config.r2,
          bucketName: config.r2.bucket,
          domain: "observations",
          dataPrefix: config.observations_prefix_v2,
          indexPrefix: config.index_prefix_v2,
          timeseriesIndexPrefix: config.observations_timeseries_index_prefix_v2,
          generatedAt,
          fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
          maxKeys: maxKeys || config.max_keys,
          computeMissingTimeseriesCounts,
          strictMissingTimeseriesCounts: strictMissingTimeseriesCounts ?? config.strict_missing_timeseries_counts,
          writeR2,
        });
        results.push(observationsTimeseries);
      }
      if (domain === "aqilevels") {
        aqilevelsTimeseries = await rebuildR2HistoryV2TimeseriesIndexes({
          r2: config.r2,
          bucketName: config.r2.bucket,
          domain: "aqilevels",
          dataPrefix: config.aqilevels_hourly_data_prefix_v2,
          indexPrefix: config.index_prefix_v2,
          timeseriesIndexPrefix: config.aqilevels_hourly_data_timeseries_index_prefix_v2,
          generatedAt,
          fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
          maxKeys: maxKeys || config.max_keys,
          computeMissingTimeseriesCounts,
          strictMissingTimeseriesCounts: strictMissingTimeseriesCounts ?? config.strict_missing_timeseries_counts,
          writeR2,
        });
        results.push(aqilevelsTimeseries);
      }
    }
    const timeseriesMetadata = await rebuildR2HistoryV2TimeseriesMetadataIndexes({
      r2: config.r2,
      bucketName: config.r2.bucket,
      indexPrefix: config.index_prefix_v2,
      observationsDataPrefix: config.observations_prefix_v2,
      aqilevelsHourlyDataPrefix: config.aqilevels_hourly_data_prefix_v2,
      observationsTimeseriesIndexPrefix: config.observations_timeseries_index_prefix_v2,
      aqilevelsHourlyDataTimeseriesIndexPrefix:
        config.aqilevels_hourly_data_timeseries_index_prefix_v2,
      timeseriesMetadataIndexPrefix: config.timeseries_metadata_index_prefix_v2,
      generatedAt,
      fetchConcurrency: fetchConcurrency || config.fetch_concurrency,
      writeR2,
    });

    return {
      history_version: "v2",
      generated_at: toIsoOrNull(generatedAt) || new Date().toISOString(),
      bucket: config.r2.bucket,
      index_prefix: config.index_prefix_v2,
      observations_timeseries_index_prefix: config.observations_timeseries_index_prefix_v2,
      aqilevels_hourly_data_timeseries_index_prefix:
        config.aqilevels_hourly_data_timeseries_index_prefix_v2,
      observations_prefix: config.observations_prefix_v2,
      aqilevels_hourly_data_prefix: config.aqilevels_hourly_data_prefix_v2,
      results,
      observations_timeseries: observationsTimeseries,
      aqilevels_timeseries: aqilevelsTimeseries,
      timeseries_metadata: timeseriesMetadata,
    };
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
      writeR2,
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
        computeMissingTimeseriesCounts,
        observationTargets: observationsTargets,
        writeR2,
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
        writeR2,
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
