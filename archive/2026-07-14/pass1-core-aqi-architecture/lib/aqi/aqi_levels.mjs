const HOUR_MS = 60 * 60 * 1000;

export const AQI_ALGORITHM_VERSION = "aqilevels_hourly_v1";

export const AQI_CALCULATION_STATUSES = Object.freeze([
  "ok",
  "insufficient_samples",
  "missing_input",
  "unsupported_pollutant",
]);

export const AQI_AVERAGING_CODES = Object.freeze([
  "hourly_mean",
  "rolling_24h_mean",
]);

export const AQI_SUPPORTED_POLLUTANTS = Object.freeze(["no2", "pm25", "pm10"]);

export const DAQI_NO2_BREAKPOINTS = Object.freeze([
  { low: 0, high: 67, level: 1 },
  { low: 67, high: 134, level: 2 },
  { low: 134, high: 200, level: 3 },
  { low: 200, high: 267, level: 4 },
  { low: 267, high: 334, level: 5 },
  { low: 334, high: 400, level: 6 },
  { low: 400, high: 467, level: 7 },
  { low: 467, high: 534, level: 8 },
  { low: 534, high: 600, level: 9 },
  { low: 600, high: null, level: 10 },
]);

export const DAQI_PM25_ROLLING24H_BREAKPOINTS = Object.freeze([
  { low: 0, high: 11, level: 1 },
  { low: 11, high: 23, level: 2 },
  { low: 23, high: 35, level: 3 },
  { low: 35, high: 41, level: 4 },
  { low: 41, high: 47, level: 5 },
  { low: 47, high: 53, level: 6 },
  { low: 53, high: 58, level: 7 },
  { low: 58, high: 64, level: 8 },
  { low: 64, high: 70, level: 9 },
  { low: 70, high: null, level: 10 },
]);

export const DAQI_PM10_ROLLING24H_BREAKPOINTS = Object.freeze([
  { low: 0, high: 16, level: 1 },
  { low: 16, high: 33, level: 2 },
  { low: 33, high: 50, level: 3 },
  { low: 50, high: 58, level: 4 },
  { low: 58, high: 66, level: 5 },
  { low: 66, high: 75, level: 6 },
  { low: 75, high: 83, level: 7 },
  { low: 83, high: 91, level: 8 },
  { low: 91, high: 100, level: 9 },
  { low: 100, high: null, level: 10 },
]);

export const EAQI_NO2_BREAKPOINTS = Object.freeze([
  { low: 0, high: 10, level: 1 },
  { low: 10, high: 25, level: 2 },
  { low: 25, high: 60, level: 3 },
  { low: 60, high: 100, level: 4 },
  { low: 100, high: 150, level: 5 },
  { low: 150, high: null, level: 6 },
]);

export const EAQI_PM25_BREAKPOINTS = Object.freeze([
  { low: 0, high: 5, level: 1 },
  { low: 5, high: 15, level: 2 },
  { low: 15, high: 50, level: 3 },
  { low: 50, high: 90, level: 4 },
  { low: 90, high: 140, level: 5 },
  { low: 140, high: null, level: 6 },
]);

export const EAQI_PM10_BREAKPOINTS = Object.freeze([
  { low: 0, high: 15, level: 1 },
  { low: 15, high: 45, level: 2 },
  { low: 45, high: 120, level: 3 },
  { low: 120, high: 195, level: 4 },
  { low: 195, high: 270, level: 5 },
  { low: 270, high: null, level: 6 },
]);

export const AQI_V1_NORMALIZED_COLUMNS = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "timestamp_hour_utc",
  "daqi_input_value_ugm3",
  "daqi_input_averaging_code",
  "daqi_index_level",
  "daqi_source_observation_count",
  "daqi_required_observation_count",
  "daqi_calculation_status",
  "daqi_missing_reason",
  "eaqi_input_value_ugm3",
  "eaqi_input_averaging_code",
  "eaqi_index_level",
  "eaqi_source_observation_count",
  "eaqi_required_observation_count",
  "eaqi_calculation_status",
  "eaqi_missing_reason",
  "hourly_sample_count",
  "algorithm_version",
  "computed_at_utc",
]);

export function normalizePollutantCode(value) {
  const compact = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact === "ino2" || compact === "no2") return "no2";
  if (compact === "ipm25" || compact === "pm25" || compact === "pm2" || compact === "pm2.5".replace(/[^a-z0-9]+/g, "")) return "pm25";
  if (compact === "ipm10" || compact === "pm10") return "pm10";
  return null;
}

export function normalizeAqiCalculationStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return AQI_CALCULATION_STATUSES.includes(normalized) ? normalized : null;
}

export function normalizeAqiAveragingCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return AQI_AVERAGING_CODES.includes(normalized) ? normalized : null;
}

export function lookupAqiIndexLevel(value, breakpoints) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (!Array.isArray(breakpoints) || breakpoints.length === 0) return null;
  const firstLow = Number(breakpoints[0]?.low);
  if (!Number.isFinite(firstLow) || value < firstLow) return null;
  for (const breakpoint of breakpoints) {
    if (breakpoint.high === null || value <= breakpoint.high) return breakpoint.level;
  }
  return null;
}

function normalizeIsoTimestamp(raw) {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === "number") return Number.isFinite(raw) ? new Date(raw).toISOString() : null;
  const text = String(raw || "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseIsoHour(raw) {
  const normalized = normalizeIsoTimestamp(raw);
  if (!normalized) return null;
  const date = new Date(normalized);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveIntOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function utcDayStartIso(dayUtc) {
  return `${dayUtc}T00:00:00.000Z`;
}

function utcDayEndIso(dayUtc) {
  const date = new Date(`${dayUtc}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function sortHelperRows(rows) {
  rows.sort((left, right) => {
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return Number(left.timeseries_id) - Number(right.timeseries_id);
  });
  return rows;
}

export function daqiAveragingCodeForPollutant(pollutantCode) {
  return pollutantCode === "no2" ? "hourly_mean" : "rolling_24h_mean";
}

export function dedupeSourceObservationRows(rows) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const timeseriesId = toPositiveIntOrNull(row?.timeseries_id);
    const stationId = toPositiveIntOrNull(row?.station_id);
    const pollutantCode = normalizePollutantCode(row?.pollutant_code);
    const observedAt = normalizeIsoTimestamp(row?.observed_at);
    const value = toNumberOrNull(row?.value);
    if (!timeseriesId || !stationId || !pollutantCode || !observedAt || value === null || value < 0) {
      continue;
    }
    byKey.set(`${timeseriesId}|${observedAt}`, {
      timeseries_id: timeseriesId,
      station_id: stationId,
      connector_id: toPositiveIntOrNull(row?.connector_id),
      pollutant_code: pollutantCode,
      observed_at: observedAt,
      value,
      status: row?.status == null ? null : String(row.status),
    });
  }
  return Array.from(byKey.values()).sort((left, right) => {
    if (left.timeseries_id !== right.timeseries_id) return left.timeseries_id - right.timeseries_id;
    return left.observed_at.localeCompare(right.observed_at);
  });
}

export function sourceObservationsToNarrowRows(rows) {
  const grouped = new Map();
  for (const row of dedupeSourceObservationRows(rows)) {
    const hourIso = parseIsoHour(row.observed_at);
    if (!hourIso) continue;
    const key = `${row.timeseries_id}|${hourIso}`;
    const current = grouped.get(key) || {
      timeseries_id: row.timeseries_id,
      station_id: row.station_id,
      connector_id: row.connector_id,
      pollutant_code: row.pollutant_code,
      timestamp_hour_utc: hourIso,
      sum: 0,
      count: 0,
    };
    current.sum += row.value;
    current.count += 1;
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).map((row) => ({
    timeseries_id: row.timeseries_id,
    station_id: row.station_id,
    connector_id: row.connector_id,
    timestamp_hour_utc: row.timestamp_hour_utc,
    pollutant_code: row.pollutant_code,
    hourly_mean_ugm3: row.count ? row.sum / row.count : null,
    sample_count: row.count || null,
  })).sort((left, right) => {
    if (left.timestamp_hour_utc !== right.timestamp_hour_utc) {
      return left.timestamp_hour_utc.localeCompare(right.timestamp_hour_utc);
    }
    return left.timeseries_id - right.timeseries_id;
  });
}

export function pivotNarrowRowsToHelperRows(narrowRows) {
  const byKey = new Map();
  for (const row of Array.isArray(narrowRows) ? narrowRows : []) {
    const timeseriesId = toPositiveIntOrNull(row?.timeseries_id);
    const stationId = toPositiveIntOrNull(row?.station_id);
    const pollutantCode = normalizePollutantCode(row?.pollutant_code);
    const timestampHourUtc = parseIsoHour(row?.timestamp_hour_utc);
    const hourlyMean = toNumberOrNull(row?.hourly_mean_ugm3);
    if (!timeseriesId || !stationId || !pollutantCode || !timestampHourUtc) continue;
    const key = `${timeseriesId}|${timestampHourUtc}`;
    const current = byKey.get(key) || {
      timeseries_id: timeseriesId,
      station_id: stationId,
      connector_id: toPositiveIntOrNull(row?.connector_id),
      pollutant_code: pollutantCode,
      timestamp_hour_utc: timestampHourUtc,
      no2_hourly_mean_ugm3: null,
      pm25_hourly_mean_ugm3: null,
      pm10_hourly_mean_ugm3: null,
      pm25_rolling24h_mean_ugm3: null,
      pm10_rolling24h_mean_ugm3: null,
      pm25_rolling24h_sample_count: null,
      pm10_rolling24h_sample_count: null,
      hourly_sample_count: null,
    };
    const sampleCount = toNumberOrNull(row?.sample_count);
    if (pollutantCode === "no2") current.no2_hourly_mean_ugm3 = hourlyMean;
    if (pollutantCode === "pm25") current.pm25_hourly_mean_ugm3 = hourlyMean;
    if (pollutantCode === "pm10") current.pm10_hourly_mean_ugm3 = hourlyMean;
    current.hourly_sample_count = sampleCount === null ? null : Math.trunc(sampleCount);
    byKey.set(key, current);
  }
  const helperRows = sortHelperRows(Array.from(byKey.values()));
  computeRolling24h(helperRows);
  return helperRows;
}

export function computeRolling24h(helperRows) {
  const byTimeseries = new Map();
  for (const row of helperRows) {
    const list = byTimeseries.get(row.timeseries_id) || [];
    list.push(row);
    byTimeseries.set(row.timeseries_id, list);
  }
  for (const rows of byTimeseries.values()) {
    sortHelperRows(rows);
    for (let currentIndex = 0; currentIndex < rows.length; currentIndex += 1) {
      const currentTs = Date.parse(rows[currentIndex].timestamp_hour_utc);
      const pm25Values = [];
      const pm10Values = [];
      for (let previousIndex = currentIndex; previousIndex >= 0; previousIndex -= 1) {
        const previousTs = Date.parse(rows[previousIndex].timestamp_hour_utc);
        const diffHours = Math.trunc((currentTs - previousTs) / HOUR_MS);
        if (diffHours > 23) break;
        if (typeof rows[previousIndex].pm25_hourly_mean_ugm3 === "number") {
          pm25Values.push(rows[previousIndex].pm25_hourly_mean_ugm3);
        }
        if (typeof rows[previousIndex].pm10_hourly_mean_ugm3 === "number") {
          pm10Values.push(rows[previousIndex].pm10_hourly_mean_ugm3);
        }
      }
      rows[currentIndex].pm25_rolling24h_mean_ugm3 = average(pm25Values);
      rows[currentIndex].pm10_rolling24h_mean_ugm3 = average(pm10Values);
      rows[currentIndex].pm25_rolling24h_sample_count = pm25Values.length || null;
      rows[currentIndex].pm10_rolling24h_sample_count = pm10Values.length || null;
    }
  }
}

export function narrowRowsToDayRange(helperRows, dayUtc) {
  const start = utcDayStartIso(dayUtc);
  const end = utcDayEndIso(dayUtc);
  return sortHelperRows((Array.isArray(helperRows) ? helperRows : []).filter((row) =>
    row.timestamp_hour_utc >= start && row.timestamp_hour_utc < end
  ));
}

function calculationStatus({ inputValue, sourceCount, requiredCount }) {
  if (inputValue === null || inputValue === undefined || !Number.isFinite(inputValue)) {
    return { status: "missing_input", missing_reason: "no_input_value" };
  }
  if (Number.isInteger(requiredCount) && requiredCount > 1 && Number(sourceCount || 0) < requiredCount) {
    return { status: "insufficient_samples", missing_reason: "insufficient_rolling_24h_hours" };
  }
  return { status: "ok", missing_reason: null };
}

export function helperRowToNormalizedAqiV1Row(row, options = {}) {
  const pollutantCode = normalizePollutantCode(row?.pollutant_code);
  const computedAtUtc = options.computedAtUtc === undefined ? null : normalizeIsoTimestamp(options.computedAtUtc);
  if (!pollutantCode) {
    return null;
  }
  const hourlyMean = pollutantCode === "no2"
    ? toNumberOrNull(row.no2_hourly_mean_ugm3)
    : pollutantCode === "pm25"
    ? toNumberOrNull(row.pm25_hourly_mean_ugm3)
    : toNumberOrNull(row.pm10_hourly_mean_ugm3);
  const rolling24hMean = pollutantCode === "pm25"
    ? toNumberOrNull(row.pm25_rolling24h_mean_ugm3)
    : pollutantCode === "pm10"
    ? toNumberOrNull(row.pm10_rolling24h_mean_ugm3)
    : null;
  const rolling24hCount = pollutantCode === "pm25"
    ? toNumberOrNull(row.pm25_rolling24h_sample_count)
    : pollutantCode === "pm10"
    ? toNumberOrNull(row.pm10_rolling24h_sample_count)
    : null;
  const hourlySampleCount = toNumberOrNull(row.hourly_sample_count);
  const daqiInputAveragingCode = daqiAveragingCodeForPollutant(pollutantCode);
  const daqiInputValue = pollutantCode === "no2" ? hourlyMean : rolling24hMean;
  const daqiSourceCount = pollutantCode === "no2" ? hourlySampleCount : rolling24hCount;
  const daqiRequiredCount = daqiInputAveragingCode === "rolling_24h_mean" ? 24 : 1;
  const daqiStatus = calculationStatus({
    inputValue: daqiInputValue,
    sourceCount: daqiSourceCount,
    requiredCount: daqiRequiredCount,
  });
  const eaqiInputValue = hourlyMean;
  const eaqiStatus = calculationStatus({
    inputValue: eaqiInputValue,
    sourceCount: hourlySampleCount,
    requiredCount: 1,
  });
  const daqiIndexLevel = daqiStatus.status === "ok"
    ? lookupAqiIndexLevel(
      daqiInputValue,
      pollutantCode === "no2"
        ? DAQI_NO2_BREAKPOINTS
        : pollutantCode === "pm25"
        ? DAQI_PM25_ROLLING24H_BREAKPOINTS
        : DAQI_PM10_ROLLING24H_BREAKPOINTS,
    )
    : null;
  const eaqiIndexLevel = eaqiStatus.status === "ok"
    ? lookupAqiIndexLevel(
      eaqiInputValue,
      pollutantCode === "no2"
        ? EAQI_NO2_BREAKPOINTS
        : pollutantCode === "pm25"
        ? EAQI_PM25_BREAKPOINTS
        : EAQI_PM10_BREAKPOINTS,
    )
    : null;

  return {
    connector_id: toPositiveIntOrNull(row.connector_id),
    station_id: toPositiveIntOrNull(row.station_id),
    timeseries_id: toPositiveIntOrNull(row.timeseries_id),
    pollutant_code: pollutantCode,
    timestamp_hour_utc: parseIsoHour(row.timestamp_hour_utc),
    daqi_input_value_ugm3: daqiInputValue,
    daqi_input_averaging_code: daqiInputAveragingCode,
    daqi_index_level: daqiIndexLevel,
    daqi_source_observation_count: daqiSourceCount === null ? null : Math.trunc(daqiSourceCount),
    daqi_required_observation_count: daqiRequiredCount,
    daqi_calculation_status: daqiIndexLevel === null && daqiStatus.status === "ok" ? "missing_input" : daqiStatus.status,
    daqi_missing_reason: daqiIndexLevel === null && daqiStatus.status === "ok" ? "breakpoint_not_found" : daqiStatus.missing_reason,
    eaqi_input_value_ugm3: eaqiInputValue,
    eaqi_input_averaging_code: "hourly_mean",
    eaqi_index_level: eaqiIndexLevel,
    eaqi_source_observation_count: hourlySampleCount === null ? null : Math.trunc(hourlySampleCount),
    eaqi_required_observation_count: 1,
    eaqi_calculation_status: eaqiIndexLevel === null && eaqiStatus.status === "ok" ? "missing_input" : eaqiStatus.status,
    eaqi_missing_reason: eaqiIndexLevel === null && eaqiStatus.status === "ok" ? "breakpoint_not_found" : eaqiStatus.missing_reason,
    hourly_sample_count: hourlySampleCount === null ? null : Math.trunc(hourlySampleCount),
    algorithm_version: AQI_ALGORITHM_VERSION,
    computed_at_utc: computedAtUtc,
    hourly_mean_ugm3: hourlyMean,
    rolling24h_mean_ugm3: rolling24hMean,
    no2_hourly_mean_ugm3: pollutantCode === "no2" ? hourlyMean : null,
    pm25_hourly_mean_ugm3: pollutantCode === "pm25" ? hourlyMean : null,
    pm10_hourly_mean_ugm3: pollutantCode === "pm10" ? hourlyMean : null,
    pm25_rolling24h_mean_ugm3: pollutantCode === "pm25" ? rolling24hMean : null,
    pm10_rolling24h_mean_ugm3: pollutantCode === "pm10" ? rolling24hMean : null,
    daqi_no2_index_level: pollutantCode === "no2" ? daqiIndexLevel : null,
    daqi_pm25_rolling24h_index_level: pollutantCode === "pm25" ? daqiIndexLevel : null,
    daqi_pm10_rolling24h_index_level: pollutantCode === "pm10" ? daqiIndexLevel : null,
    eaqi_no2_index_level: pollutantCode === "no2" ? eaqiIndexLevel : null,
    eaqi_pm25_index_level: pollutantCode === "pm25" ? eaqiIndexLevel : null,
    eaqi_pm10_index_level: pollutantCode === "pm10" ? eaqiIndexLevel : null,
    updated_at: null,
  };
}

export function helperRowsToNormalizedAqiV1Rows(helperRows, options = {}) {
  return (Array.isArray(helperRows) ? helperRows : [])
    .map((row) => helperRowToNormalizedAqiV1Row(row, options))
    .filter((row) =>
      row &&
      row.connector_id &&
      row.station_id &&
      row.timeseries_id &&
      row.timestamp_hour_utc
    )
    .sort((left, right) => {
      if (left.timeseries_id !== right.timeseries_id) return left.timeseries_id - right.timeseries_id;
      return left.timestamp_hour_utc.localeCompare(right.timestamp_hour_utc);
    });
}

export function buildAqilevelHistoryRowsForDayFromSourceObservations(rows, dayUtc, options = {}) {
  const helperRows = pivotNarrowRowsToHelperRows(sourceObservationsToNarrowRows(rows));
  return helperRowsToNormalizedAqiV1Rows(narrowRowsToDayRange(helperRows, dayUtc), options);
}

export function buildAqilevelHistoryRowsByDayFromSourceObservations({ rows, fromDayUtc, toDayUtc, computedAtUtc = null }) {
  const helperRows = pivotNarrowRowsToHelperRows(sourceObservationsToNarrowRows(rows));
  const output = [];
  let cursor = fromDayUtc;
  while (cursor <= toDayUtc) {
    output.push({
      day_utc: cursor,
      rows: helperRowsToNormalizedAqiV1Rows(narrowRowsToDayRange(helperRows, cursor), { computedAtUtc }),
    });
    const date = new Date(`${cursor}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    cursor = date.toISOString().slice(0, 10);
  }
  return output;
}
