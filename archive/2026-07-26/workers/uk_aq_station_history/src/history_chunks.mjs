import { normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";
import { AQI_HOUR_INTERVAL_RESPONSE_CONTRACT, canonicalAqiHourStarts } from "./stable_head.mjs";

const HOUR_MS = 60 * 60 * 1000;
export const AQI_CHUNK_MAX_HOURS = 31 * 24;
export const OBSERVATION_CHUNK_MAX_HOURS = 7 * 24;
export const OBSERVATION_CHUNK_MAX_ROWS = 5000;
export const OBSERVATION_CHUNK_MAX_R2_OBJECT_READS = 80;
export const AQI_MUTABLE_HOURS = 120;

function positiveInt(value) {
  const number = Number(String(value ?? "").trim());
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isoMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["objects", "compact", "json", "tsv"].includes(normalized) ? normalized : null;
}

export function parseHistoryChunkRequest(url, kind, limits = {}) {
  const timeseriesId = positiveInt(url.searchParams.get("timeseries_id"));
  const connectorId = positiveInt(url.searchParams.get("connector_id"));
  const pollutant = normalizePollutantCode(url.searchParams.get("pollutant"));
  const startMs = isoMs(url.searchParams.get("start_utc") || url.searchParams.get("from_utc"));
  const endMs = isoMs(url.searchParams.get("end_utc") || url.searchParams.get("to_utc"));
  const stableHeadStartMs = isoMs(url.searchParams.get("stable_head_start_utc"));
  const maxHours = kind === "aqi"
    ? (limits.aqiChunkMaxHours || AQI_CHUNK_MAX_HOURS)
    : (limits.observationChunkMaxHours || OBSERVATION_CHUNK_MAX_HOURS);
  const format = kind === "aqi" ? formatName(url.searchParams.get("format") || "compact") : "objects";
  const requestedLimit = positiveInt(url.searchParams.get("limit") || url.searchParams.get("row_limit"));
  if (!timeseriesId || !connectorId || !pollutant || startMs === null || endMs === null || stableHeadStartMs === null || !format) return { ok: false, code: "history_chunk_request_invalid" };
  if (endMs <= startMs || endMs - startMs > maxHours * HOUR_MS) return { ok: false, code: "history_chunk_bounds_invalid" };
  if (endMs > stableHeadStartMs) return { ok: false, code: "history_chunk_overlaps_stable_head" };
  if (requestedLimit && kind === "observations" && requestedLimit > OBSERVATION_CHUNK_MAX_ROWS) return { ok: false, code: "observation_chunk_row_limit_exceeded" };
  const limit = kind === "aqi" ? Math.min(requestedLimit || maxHours, maxHours) : Math.min(requestedLimit || OBSERVATION_CHUNK_MAX_ROWS, OBSERVATION_CHUNK_MAX_ROWS);
  const startUtc = new Date(startMs).toISOString();
  const endUtc = new Date(endMs).toISOString();
  const stableHeadStartUtc = new Date(stableHeadStartMs).toISOString();
  return {
    ok: true, kind, timeseriesId, connectorId, pollutant, startMs, endMs, startUtc, endUtc,
    stableHeadStartMs, stableHeadStartUtc, format, limit, maxHours,
    retryKey: `v1|${kind}|${timeseriesId}|${connectorId}|${pollutant}|${startUtc}|${endUtc}|${format}|${limit}`,
  };
}

export function classifyChunk(endMs, nowMs = Date.now()) {
  return endMs <= nowMs - AQI_MUTABLE_HOURS * HOUR_MS ? "immutable" : "mutable";
}

function aqiHour(row) {
  const parsed = isoMs(row?.period_end_utc || row?.timestamp_hour_utc || row?.period_start_utc);
  return parsed === null ? null : new Date(Math.floor(parsed / HOUR_MS) * HOUR_MS).toISOString();
}

function aqiKey(row) {
  const hour = aqiHour(row);
  const timeseriesId = positiveInt(row?.timeseries_id);
  const connectorId = positiveInt(row?.connector_id);
  const pollutant = normalizePollutantCode(row?.pollutant_code);
  return hour && timeseriesId && connectorId && pollutant ? `${timeseriesId}|${connectorId}|${pollutant}|${hour}` : null;
}

export function buildAqiHistoryChunk(chunk, payload, nowMs = Date.now()) {
  const sourceRows = Array.isArray(payload?.points) ? payload.points : [];
  const rowsByKey = new Map();
  let conflictingDuplicateCount = 0;
  for (const sourceRow of [...sourceRows].sort((left, right) => String(aqiHour(left) || "").localeCompare(String(aqiHour(right) || "")) || JSON.stringify(left).localeCompare(JSON.stringify(right)))) {
    if (sourceRow?.source !== "r2") continue;
    const key = aqiKey(sourceRow);
    const hour = aqiHour(sourceRow);
    if (!key || Number(sourceRow.timeseries_id) !== chunk.timeseriesId || Number(sourceRow.connector_id) !== chunk.connectorId || normalizePollutantCode(sourceRow.pollutant_code) !== chunk.pollutant) continue;
    const hourMs = Date.parse(hour);
    if (hourMs < chunk.startMs || hourMs >= chunk.endMs) continue;
    const row = {
      ...sourceRow,
      // period_start_utc remains the legacy endpoint alias until Phase 3.
      timestamp_hour_utc: hour,
      period_end_utc: hour,
      period_start_utc: sourceRow?.period_start_utc || hour,
      source: "r2",
    };
    const previous = rowsByKey.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) conflictingDuplicateCount += 1;
    if (!previous) rowsByKey.set(key, row);
  }
  const rows = Array.from(rowsByKey.values()).sort((left, right) => left.period_start_utc.localeCompare(right.period_start_utc));
  const expectedHours = canonicalAqiHourStarts(chunk.startMs, chunk.endMs).length;
  const upstreamComplete = payload?.response_complete !== false && payload?.meta?.response_complete !== false;
  const complete = upstreamComplete && conflictingDuplicateCount === 0 && rows.length === expectedHours;
  const cacheClass = classifyChunk(chunk.endMs, nowMs);
  return {
    ...payload,
    response_contract: AQI_HOUR_INTERVAL_RESPONSE_CONTRACT,
    points: rows,
    row_count: rows.length,
    response_complete: complete,
    has_gap: !complete,
    coverage_state: complete ? "complete" : "partial",
    source: "r2_only",
    live_calculation_used: false,
    chunk: chunkFields(chunk, cacheClass),
    partial_reasons: complete ? [] : Array.from(new Set([...(Array.isArray(payload?.partial_reasons) ? payload.partial_reasons : []), ...(upstreamComplete ? [] : ["upstream_incomplete"]), ...(rows.length === expectedHours ? [] : ["missing_expected_aqi_hours"]), ...(conflictingDuplicateCount ? ["conflicting_duplicate_rows"] : [])])),
  };
}

function observedAt(row) {
  const parsed = isoMs(row?.observed_at || row?.observed_at_utc);
  return parsed === null ? null : new Date(parsed).toISOString();
}

export function buildObservationHistoryChunk(chunk, payload, nowMs = Date.now()) {
  const rowsByObservedAt = new Map();
  const sourceRows = Array.isArray(payload?.rows) ? [...payload.rows] : [];
  sourceRows.sort((left, right) => String(observedAt(left) || "").localeCompare(String(observedAt(right) || "")) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (const sourceRow of sourceRows) {
    const timestamp = observedAt(sourceRow);
    if (!timestamp) continue;
    const timestampMs = Date.parse(timestamp);
    if (timestampMs < chunk.startMs || timestampMs >= chunk.endMs) continue;
    if (!rowsByObservedAt.has(timestamp)) rowsByObservedAt.set(timestamp, { ...sourceRow, observed_at: timestamp, source: "r2" });
  }
  const rows = Array.from(rowsByObservedAt.values()).sort((left, right) => left.observed_at.localeCompare(right.observed_at));
  const objectReads = Number(payload?.coverage?.r2_object_reads);
  const withinObjectLimit = !Number.isFinite(objectReads) || objectReads <= OBSERVATION_CHUNK_MAX_R2_OBJECT_READS;
  const upstreamComplete = payload?.response_complete !== false && payload?.coverage?.response_complete !== false;
  const complete = upstreamComplete && withinObjectLimit && rows.length <= chunk.limit;
  const cacheClass = classifyChunk(chunk.endMs, nowMs);
  return {
    ...payload,
    rows,
    row_count: rows.length,
    response_complete: complete,
    has_gap: !complete || payload?.has_gap === true,
    coverage_state: complete ? "complete" : "partial",
    source: "r2_only",
    chunk: chunkFields(chunk, cacheClass),
    limits: { max_chunk_hours: chunk.maxHours, max_rows: OBSERVATION_CHUNK_MAX_ROWS, max_pages: 1, max_r2_object_reads: OBSERVATION_CHUNK_MAX_R2_OBJECT_READS },
    partial_reasons: complete ? (Array.isArray(payload?.partial_reasons) ? payload.partial_reasons : []) : Array.from(new Set([...(Array.isArray(payload?.partial_reasons) ? payload.partial_reasons : []), ...(upstreamComplete ? [] : ["upstream_incomplete"]), ...(withinObjectLimit ? [] : ["r2_object_read_limit_exceeded"]), ...(rows.length <= chunk.limit ? [] : ["row_limit_exceeded"])])),
  };
}

function chunkFields(chunk, cacheClass) {
  return {
    direction: "newest_first",
    row_order: "ascending",
    start_utc: chunk.startUtc,
    end_utc: chunk.endUtc,
    stable_head_start_utc: chunk.stableHeadStartUtc,
    next_older_chunk_end_utc: chunk.startUtc,
    replacement_policy: "extend_backwards_only",
    cache_class: cacheClass,
    retry_key: chunk.retryKey,
  };
}

export function aqiResponseRows(payload, format) {
  const columns = Array.isArray(payload?.columns) && payload.columns.length
    ? payload.columns
    : ["period_start_utc", "connector_id", "station_id", "timeseries_id", "pollutant_code", "daqi_index_level", "eaqi_index_level", "daqi_input_value_ugm3", "daqi_input_averaging_code", "eaqi_input_value_ugm3", "eaqi_input_averaging_code", "daqi_calculation_status", "eaqi_calculation_status", "source", "source_coverage", "timestamp_hour_utc", "period_end_utc"];
  if (format === "objects") return { columns, points: payload.points };
  return { columns, points: payload.points.map((row) => columns.map((column) => row[column] ?? null)) };
}

export function buildTsv(columns, rows) {
  const clean = (value) => value == null ? "" : String(value).replace(/\t|\r?\n/g, " ");
  return `${[columns.join("\t"), ...rows.map((row) => (Array.isArray(row) ? row : columns.map((column) => row[column])).map(clean).join("\t"))].join("\n")}\n`;
}
