import { selectContinuitySegments } from "./continuity.mjs";

const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const HOUR_MS = 60 * 60 * 1000;
const MUTABLE_HOURS = 120;
const TOLERANCE = 0.000001;
const EXACT_FIELDS = [
  "daqi_index_level", "eaqi_index_level", "daqi_calculation_status", "eaqi_calculation_status",
  "daqi_missing_reason", "eaqi_missing_reason", "daqi_input_averaging_code", "eaqi_input_averaging_code",
  "daqi_source_observation_count", "daqi_required_observation_count", "eaqi_source_observation_count",
  "eaqi_required_observation_count", "hourly_sample_count",
];
const NUMERIC_FIELDS = ["daqi_input_value_ugm3", "eaqi_input_value_ugm3"];

function shouldSample(request, percent) {
  const text = `${request.connectorId}:${request.timeseriesId}:${request.pollutant}:${request.startMs}:${request.endMs}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
  return (hash % 100) < percent;
}

export function shouldValidateAqi(policy, request) {
  if (policy.aqiValidationMode === "all") return true;
  return policy.aqiValidationMode === "sample" && policy.aqiValidationSamplePercent > 0 && shouldSample(request, policy.aqiValidationSamplePercent);
}

function rowHour(row) {
  const ms = Date.parse(String(row?.timestamp_hour_utc || row?.period_end_utc || row?.period_start_utc || ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function fetchStoredRows(env, segment) {
  const baseUrl = String(env.UK_AQ_AQI_HISTORY_R2_API_URL || "").trim();
  const secret = String(env.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!baseUrl || !secret) throw new Error("station_history_aqi_validation_config_missing");
  const target = new URL(baseUrl);
  target.search = "";
  for (const [key, value] of [
    ["scope", "timeseries"], ["grain", "hourly"], ["format", "objects"],
    ["timeseries_id", segment.timeseriesId], ["connector_id", segment.connectorId], ["pollutant", segment.pollutant],
    ["start_utc", new Date(segment.startMs).toISOString()], ["end_utc", new Date(segment.endMs).toISOString()], ["row_limit", 744],
  ]) target.searchParams.set(key, String(value));
  const response = await fetch(target, { headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(`station_history_aqi_validation_read_failed_${response.status}`);
  return Array.isArray(payload.points) ? payload.points : Array.isArray(payload.rows) ? payload.rows : [];
}

function numericEqual(left, right) {
  if (left == null && right == null) return true;
  const a = Number(left); const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TOLERANCE;
}

export async function validateCalculatedAqiAgainstR2({ response, request, continuity, env, nowMs = Date.now() } = {}) {
  const immutableEndMs = Math.min(request.endMs, nowMs - MUTABLE_HOURS * HOUR_MS);
  const allCalculated = Array.isArray(response?.aqi?.rows) ? response.aqi.rows : [];
  const calculated = allCalculated.filter((row) => Date.parse(row.timestamp_hour_utc) <= immutableEndMs);
  const mutableExclusionCount = allCalculated.length - calculated.length;
  if (!calculated.length || response?.observations?.response_complete !== true || response?.aqi?.response_complete !== true) {
    console.log(JSON.stringify({ event: "station_history_aqi_validation_summary", status: "not_comparable", mutable_exclusion_count: mutableExclusionCount, incomplete_exclusion_count: calculated.length, mutable_or_incomplete_exclusion_count: allCalculated.length }));
    return;
  }
  const startMs = Math.min(...calculated.map((row) => Date.parse(row.timestamp_hour_utc)));
  const selection = selectContinuitySegments(continuity, startMs, immutableEndMs + 1);
  const storedRows = (await Promise.all(selection.segments.map((segment) => fetchStoredRows(env, segment)))).flat();
  const calculatedByKey = new Map(calculated.map((row) => [`${row.timeseries_id}|${row.timestamp_hour_utc}`, row]));
  const storedByKey = new Map(storedRows.map((row) => [`${row.timeseries_id}|${rowHour(row)}`, row]).filter(([key]) => !key.endsWith("|null")));
  let mismatchCount = 0; let missingInR2Count = 0; let missingInCalculatedCount = 0; let notComparableCount = 0;
  const samples = [];
  for (const [key, calculatedRow] of calculatedByKey) {
    const storedRow = storedByKey.get(key);
    if (!storedRow) { missingInR2Count += 1; if (samples.length < 10) samples.push({ key, issue: "missing_in_r2" }); continue; }
    if (storedRow.algorithm_version !== calculatedRow.algorithm_version) { notComparableCount += 1; continue; }
    const different = EXACT_FIELDS.some((field) => (storedRow[field] ?? null) !== (calculatedRow[field] ?? null))
      || NUMERIC_FIELDS.some((field) => !numericEqual(storedRow[field], calculatedRow[field]));
    if (different) { mismatchCount += 1; if (samples.length < 10) samples.push({ key, issue: "value_or_status_mismatch" }); }
  }
  for (const key of storedByKey.keys()) if (!calculatedByKey.has(key)) missingInCalculatedCount += 1;
  const status = mismatchCount || missingInR2Count || missingInCalculatedCount
    ? "mismatch"
    : notComparableCount ? "not_comparable_algorithm_version" : "match";
  console.log(JSON.stringify({ event: "station_history_aqi_validation_summary", status, compared_count: calculated.length - notComparableCount - missingInR2Count, mismatch_count: mismatchCount, missing_in_r2_count: missingInR2Count, missing_in_calculated_count: missingInCalculatedCount, mutable_exclusion_count: mutableExclusionCount, incomplete_exclusion_count: 0, mutable_or_incomplete_exclusion_count: mutableExclusionCount, not_comparable_count: notComparableCount, not_comparable_algorithm_version_count: notComparableCount, numeric_tolerance_ugm3: TOLERANCE }));
  if (samples.length) console.warn(JSON.stringify({ event: "station_history_aqi_validation_mismatch", status, sample_count: samples.length, samples }));
}
