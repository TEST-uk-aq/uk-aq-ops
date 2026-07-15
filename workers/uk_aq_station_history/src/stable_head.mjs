import { canonicalAqiKey, normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";

const HOUR_MS = 60 * 60 * 1000;
export const STABLE_HEAD_MAX_HOURS = 168;

function hourIso(row) {
  const raw = row?.timestamp_hour_utc || row?.period_start_utc;
  const ms = Date.parse(String(raw ?? ""));
  return Number.isFinite(ms) ? new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString() : null;
}

function comparable(row) {
  return JSON.stringify([
    row?.daqi_index_level ?? null,
    row?.eaqi_index_level ?? null,
    row?.daqi_calculation_status ?? null,
    row?.eaqi_calculation_status ?? null,
    row?.daqi_missing_reason ?? null,
    row?.eaqi_missing_reason ?? null,
  ]);
}

function normalizeIdentityRow(row, source) {
  const timestamp = hourIso(row);
  const pollutant = normalizePollutantCode(row?.pollutant_code);
  if (!timestamp || !pollutant) return null;
  return { ...row, timestamp_hour_utc: timestamp, pollutant_code: pollutant, source };
}

export function resolveStableHeadBounds(request) {
  const headStartMs = Math.max(request.startMs, request.endMs - STABLE_HEAD_MAX_HOURS * HOUR_MS);
  return { headStartMs, headEndMs: request.endMs };
}

export function normalizeExactR2AqiRows(payload, request, bounds) {
  const sourceRows = Array.isArray(payload?.points) ? payload.points : Array.isArray(payload?.rows) ? payload.rows : [];
  const rows = [];
  const byKey = new Map();
  for (const sourceRow of sourceRows) {
    if (sourceRow?.source && sourceRow.source !== "r2") continue;
    const row = normalizeIdentityRow(sourceRow, "r2");
    if (!row) continue;
    const timestampMs = Date.parse(row.timestamp_hour_utc);
    if (timestampMs < bounds.headStartMs || timestampMs >= bounds.headEndMs) continue;
    if (Number(row.timeseries_id) !== request.timeseriesId || Number(row.connector_id) !== request.connectorId || row.pollutant_code !== request.pollutant) {
      throw new Error("station_series_r2_identity_mismatch");
    }
    const key = canonicalAqiKey(row);
    if (!key) throw new Error("station_series_r2_identity_unresolved");
    const previous = byKey.get(key);
    if (previous && comparable(previous) !== comparable(row)) throw new Error("station_series_r2_duplicate_conflict");
    if (!previous) { byKey.set(key, row); rows.push(row); }
  }
  return rows.sort((left, right) => left.timestamp_hour_utc.localeCompare(right.timestamp_hour_utc));
}

export function missingHeadHours(r2Rows, bounds) {
  const present = new Set(r2Rows.map((row) => row.timestamp_hour_utc));
  const missing = [];
  for (let cursor = bounds.headStartMs; cursor < bounds.headEndMs; cursor += HOUR_MS) {
    const hour = new Date(cursor).toISOString();
    if (!present.has(hour)) missing.push(hour);
  }
  return missing;
}

export function mergeStableAqiHead({ r2Rows, liveRows, request, bounds }) {
  const merged = new Map();
  let overlapCount = 0;
  let mismatchCount = 0;
  const mismatchHours = [];
  for (const sourceRow of liveRows) {
    const row = normalizeIdentityRow(sourceRow, "live_calculated");
    if (!row || Number(row.timeseries_id) !== request.timeseriesId || Number(row.connector_id) !== request.connectorId || row.pollutant_code !== request.pollutant) throw new Error("station_series_live_identity_mismatch");
    const key = canonicalAqiKey(row);
    if (!key) throw new Error("station_series_live_identity_unresolved");
    const previous = merged.get(key);
    if (previous && comparable(previous) !== comparable(row)) throw new Error("station_series_live_duplicate_conflict");
    if (!previous) merged.set(key, row);
  }
  const r2StationIds = new Set(r2Rows.map((row) => Number(row.station_id)).filter((value) => Number.isInteger(value) && value > 0));
  const liveStationIds = new Set(liveRows.map((row) => Number(row.station_id)).filter((value) => Number.isInteger(value) && value > 0));
  if (r2StationIds.size > 1 || liveStationIds.size > 1 || (r2StationIds.size && liveStationIds.size && [...r2StationIds][0] !== [...liveStationIds][0])) {
    throw new Error("station_series_source_identity_mismatch");
  }
  for (const row of r2Rows) {
    const key = canonicalAqiKey(row);
    if (!key) throw new Error("station_series_r2_identity_unresolved");
    const live = merged.get(key);
    if (live) {
      overlapCount += 1;
      if (comparable(live) !== comparable(row)) {
        mismatchCount += 1;
        mismatchHours.push(row.timestamp_hour_utc);
      }
    }
    merged.set(key, row);
  }
  const rows = Array.from(merged.values()).filter((row) => {
    const ms = Date.parse(row.timestamp_hour_utc);
    return ms >= bounds.headStartMs && ms < bounds.headEndMs;
  }).sort((left, right) => left.timestamp_hour_utc.localeCompare(right.timestamp_hour_utc));
  const keys = rows.map((row) => canonicalAqiKey(row));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error("station_series_final_duplicate_conflict");
  return { rows, overlap_count: overlapCount, mismatch_count: mismatchCount, mismatch_hours: mismatchHours };
}

export function r2CoverageClaimsComplete(payload) {
  return payload?.coverage?.r2_expected_hour_coverage?.complete === true
    || payload?.meta?.r2_expected_hour_coverage?.complete === true;
}

export function r2ResponseComplete(payload) {
  return payload?.response_complete !== false && payload?.meta?.response_complete !== false;
}
