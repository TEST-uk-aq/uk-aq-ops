const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const ALLOWED_TRIGGER_MODES = Object.freeze(["scheduler", "manual"]);
export const ALLOWED_RUN_MODES = Object.freeze([
  "local_to_aqilevels",
  "obs_aqi_to_r2",
  "source_to_r2",
]);

const RUN_MODE_SET = new Set(ALLOWED_RUN_MODES);
const TRIGGER_MODE_SET = new Set(ALLOWED_TRIGGER_MODES);
const SOURCE_FETCH_ADAPTERS = new Set([
  "breathelondon",
  "sensorcommunity",
  "openaq",
  "uk_air_sos",
]);
const RETRYABLE_SOURCE_FETCH_STATUS_CODES = [
  "http 408",
  "http 425",
  "http 429",
  "http 500",
  "http 502",
  "http 503",
  "http 504",
];
const RETRYABLE_SOURCE_FETCH_ERROR_SNIPPETS = [
  "operation timed out",
  "timed out",
  "dns error",
  "failed to lookup address information",
  "temporary failure in name resolution",
  "nodename nor servname provided",
  "connection reset by peer",
  "connection reset",
  "connection refused",
  "network is unreachable",
  "socket hang up",
  "sendrequest",
  "client error (connect)",
  "client error (sendrequest)",
  "the signal has been aborted",
  "tls",
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
];
const RETRYABLE_AQILEVELS_WRITE_ERROR_SNIPPETS = [
  "statement timeout",
  "canceling statement due to statement timeout",
  "http 504",
  "gateway timeout",
];

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

export function lookupAqiIndexLevel(value, breakpoints) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (!Array.isArray(breakpoints) || breakpoints.length === 0) {
    return null;
  }
  const firstLow = Number(breakpoints[0]?.low);
  if (!Number.isFinite(firstLow) || value < firstLow) {
    return null;
  }
  // Breakpoints are matched by ordered inclusive upper bound so decimal values
  // between published integer legend thresholds still resolve without gaps.
  for (const breakpoint of breakpoints) {
    if (breakpoint.high === null || value <= breakpoint.high) {
      return breakpoint.level;
    }
  }
  return null;
}

export function parseRunMode(raw, fallback = "local_to_aqilevels") {
  const value = String(raw || "").trim().toLowerCase();
  if (RUN_MODE_SET.has(value)) {
    return value;
  }
  return RUN_MODE_SET.has(fallback) ? fallback : "local_to_aqilevels";
}

export function parseTriggerMode(raw, fallback = "manual") {
  const value = String(raw || "").trim().toLowerCase();
  if (TRIGGER_MODE_SET.has(value)) {
    return value;
  }
  return TRIGGER_MODE_SET.has(fallback) ? fallback : "manual";
}

export function parseBooleanish(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

export function parsePositiveInt(raw, fallback, min = 1, max = 1_000_000) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const intValue = Math.trunc(parsed);
  if (intValue < min) {
    return min;
  }
  if (intValue > max) {
    return max;
  }
  return intValue;
}

export function isRetryableAqilevelsWriteError(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) {
    return false;
  }
  return RETRYABLE_AQILEVELS_WRITE_ERROR_SNIPPETS.some((snippet) =>
    value.includes(snippet)
  );
}

export function splitChunkLengthForRetry(chunkLength, minChunkLength = 1) {
  const normalizedLength = Math.trunc(Number(chunkLength));
  const normalizedMin = Math.max(1, Math.trunc(Number(minChunkLength) || 1));
  if (!Number.isFinite(normalizedLength) || normalizedLength <= normalizedMin) {
    return null;
  }
  const leftLength = Math.ceil(normalizedLength / 2);
  const rightLength = normalizedLength - leftLength;
  if (leftLength < 1 || rightLength < 1) {
    return null;
  }
  return [leftLength, rightLength];
}

export function parseIsoDayUtc(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function compareIsoDay(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function shiftIsoDay(dayUtc, deltaDays) {
  const normalized = parseIsoDayUtc(dayUtc);
  if (!normalized) {
    throw new Error(`Invalid ISO day: ${String(dayUtc)}`);
  }
  const shifted = new Date(`${normalized}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + Math.trunc(deltaDays));
  return shifted.toISOString().slice(0, 10);
}

export function buildBackwardDayRange(fromDayUtc, toDayUtc) {
  const fromDay = parseIsoDayUtc(fromDayUtc);
  const toDay = parseIsoDayUtc(toDayUtc);
  if (!fromDay || !toDay) {
    throw new Error("Invalid from/to day for range");
  }
  if (compareIsoDay(toDay, fromDay) < 0) {
    throw new Error("to_day_utc must be >= from_day_utc");
  }

  const days = [];
  let cursor = toDay;
  while (compareIsoDay(cursor, fromDay) >= 0) {
    days.push(cursor);
    cursor = shiftIsoDay(cursor, -1);
  }
  return days;
}

export function normalizeDayRange({ fromDayUtc, toDayUtc, defaultDayUtc }) {
  const fallbackDay = parseIsoDayUtc(defaultDayUtc) || utcDayFromDate(new Date());
  const normalizedFrom = parseIsoDayUtc(fromDayUtc) || fallbackDay;
  const normalizedTo = parseIsoDayUtc(toDayUtc) || normalizedFrom;
  if (compareIsoDay(normalizedTo, normalizedFrom) < 0) {
    throw new Error("to_day_utc must be >= from_day_utc");
  }
  return {
    from_day_utc: normalizedFrom,
    to_day_utc: normalizedTo,
  };
}

function normalizeIsoTimestamp(raw) {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      return null;
    }
    return raw.toISOString();
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return null;
    }
    return new Date(raw).toISOString();
  }
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

export function buildCoveredIsoDaysForUtcRange(
  windowStartIso,
  windowEndExclusiveIso,
) {
  const normalizedStartIso = normalizeIsoTimestamp(windowStartIso);
  const normalizedEndIso = normalizeIsoTimestamp(windowEndExclusiveIso);
  if (!(normalizedStartIso && normalizedEndIso)) {
    throw new Error("Invalid UTC timestamp range");
  }
  if (normalizedEndIso <= normalizedStartIso) {
    return [];
  }

  const startDay = parseIsoDayUtc(normalizedStartIso.slice(0, 10));
  const endExclusiveDay = parseIsoDayUtc(normalizedEndIso.slice(0, 10));
  if (!(startDay && endExclusiveDay)) {
    throw new Error("Invalid UTC day range");
  }

  const lastIncludedDay = shiftIsoDay(endExclusiveDay, -1);
  if (compareIsoDay(lastIncludedDay, startDay) < 0) {
    return [];
  }

  const days = [];
  let cursor = startDay;
  while (compareIsoDay(cursor, lastIncludedDay) <= 0) {
    days.push(cursor);
    cursor = shiftIsoDay(cursor, 1);
  }
  return days;
}

export function mapR2ObservationRowsToSourceObservations({
  rows,
  bindingByTimeseriesId,
  windowStartIso,
  windowEndIso,
  stationIdFilter = null,
}) {
  if (!(bindingByTimeseriesId instanceof Map)) {
    throw new Error("bindingByTimeseriesId must be a Map");
  }

  const normalizedStartIso = normalizeIsoTimestamp(windowStartIso);
  const normalizedEndIso = normalizeIsoTimestamp(windowEndIso);
  if (!(normalizedStartIso && normalizedEndIso)) {
    throw new Error("Invalid UTC timestamp range");
  }

  const stationFilter = Array.isArray(stationIdFilter)
    ? new Set(
      stationIdFilter
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
        .map((value) => Math.trunc(value)),
    )
    : stationIdFilter instanceof Set
    ? new Set(
      Array.from(stationIdFilter)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
        .map((value) => Math.trunc(value)),
    )
    : null;

  const observations = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const timeseriesId = Number(row.timeseries_id);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) {
      continue;
    }
    const binding = bindingByTimeseriesId.get(Math.trunc(timeseriesId));
    if (!binding) {
      continue;
    }
    if (
      !(
        binding.pollutant_code === "no2" || binding.pollutant_code === "pm25" ||
        binding.pollutant_code === "pm10"
      )
    ) {
      continue;
    }
    if (
      stationFilter && !stationFilter.has(Math.trunc(Number(binding.station_id)))
    ) {
      continue;
    }
    const observedAtIso = normalizeIsoTimestamp(row.observed_at);
    if (!observedAtIso) {
      continue;
    }
    if (
      observedAtIso < normalizedStartIso || observedAtIso >= normalizedEndIso
    ) {
      continue;
    }
    const rawValue = row.value;
    if (
      rawValue === null || rawValue === undefined ||
      (typeof rawValue === "string" && !rawValue.trim())
    ) {
      continue;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }

    observations.push({
      timeseries_id: Math.trunc(timeseriesId),
      station_id: Math.trunc(Number(binding.station_id)),
      pollutant_code: binding.pollutant_code,
      observed_at: observedAtIso,
      value,
    });
  }

  observations.sort((left, right) => {
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    if (left.observed_at < right.observed_at) return -1;
    if (left.observed_at > right.observed_at) return 1;
    return 0;
  });
  return observations;
}

export function parseConnectorIds(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  let values = [];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === "number") {
    values = [raw];
  } else if (typeof raw === "string") {
    values = raw.split(",");
  } else {
    return null;
  }

  const parsed = values
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
    .map((value) => Math.trunc(value));

  if (!parsed.length) {
    return null;
  }
  return Array.from(new Set(parsed)).sort((left, right) => left - right);
}

export function shouldSkipCompletedDay(existingStatus, forceReplace) {
  if (forceReplace) {
    return { skip: false, reason: "force_replace" };
  }
  const normalized = String(existingStatus || "").trim().toLowerCase();
  if (normalized === "complete" || normalized === "ok") {
    return { skip: true, reason: "already_complete" };
  }
  return { skip: false, reason: "needs_processing" };
}

export function isSourceAcquisitionPendingError(sourceAdapter, errorMessage) {
  const adapter = String(sourceAdapter || "").trim().toLowerCase();
  const message = String(errorMessage || "").trim().toLowerCase();
  if (!(adapter && message)) {
    return false;
  }
  if (adapter === "breathelondon") {
    return (
      message.startsWith("breathelondon_list_sensors_fetch_failed:") ||
      message.startsWith("breathelondon_clarity_fetch_failed:")
    );
  }
  if (adapter === "sensorcommunity") {
    return (
      message.startsWith("sensorcommunity_archive_index_fetch_failed:") ||
      message.startsWith("sensorcommunity_archive_csv_fetch_failed:")
    );
  }
  return false;
}

export function isRetryableSourceFetchError(sourceAdapter, errorMessage) {
  const adapter = String(sourceAdapter || "").trim().toLowerCase();
  const message = String(errorMessage || "").trim().toLowerCase();
  if (!SOURCE_FETCH_ADAPTERS.has(adapter) || !message) {
    return false;
  }
  if (RETRYABLE_SOURCE_FETCH_STATUS_CODES.some((code) => message.includes(code))) {
    return true;
  }
  return RETRYABLE_SOURCE_FETCH_ERROR_SNIPPETS.some((snippet) =>
    message.includes(snippet)
  );
}

function utcDayFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function utcFromIsoDay(dayUtc) {
  return new Date(`${dayUtc}T00:00:00.000Z`);
}

function dayFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function localIsoDay(date, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!(year && month && day)) {
    throw new Error(`Could not format local day for time zone: ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

function buildRetainedLocalDays(nowUtc, timeZone, localRetentionDays) {
  const currentLocalDay = localIsoDay(nowUtc, timeZone);
  const lastCompleteLocalDay = shiftIsoDay(currentLocalDay, -1);
  const days = [];
  for (let offset = localRetentionDays - 1; offset >= 0; offset -= 1) {
    days.push(shiftIsoDay(lastCompleteLocalDay, -offset));
  }
  return {
    currentLocalDay,
    lastCompleteLocalDay,
    days,
  };
}

export function computeRollingLocalRetentionWindow({
  nowUtc = new Date(),
  timeZone = "Europe/London",
  localRetentionDays = 31,
  scanExtraDays = 4,
} = {}) {
  if (!(nowUtc instanceof Date) || Number.isNaN(nowUtc.getTime())) {
    throw new Error("nowUtc must be a valid Date");
  }

  const retentionDays = parsePositiveInt(localRetentionDays, 31, 1, 3650);
  const extraDays = parsePositiveInt(scanExtraDays, 4, 1, 60);
  const localWindow = buildRetainedLocalDays(nowUtc, timeZone, retentionDays);

  const localDaySet = new Set(localWindow.days);
  const oldestLocalDay = localWindow.days[0];
  const newestLocalDay = localWindow.days[localWindow.days.length - 1];

  const scanStartDay = shiftIsoDay(oldestLocalDay, -extraDays);
  const scanEndDay = shiftIsoDay(newestLocalDay, extraDays + 1);

  const retainedUtcDays = new Set();
  let cursorMs = utcFromIsoDay(scanStartDay).getTime();
  const endMs = utcFromIsoDay(scanEndDay).getTime();
  while (cursorMs < endMs) {
    const cursorDate = new Date(cursorMs);
    const localDay = localIsoDay(cursorDate, timeZone);
    if (localDaySet.has(localDay)) {
      retainedUtcDays.add(utcDayFromDate(cursorDate));
    }
    cursorMs += HOUR_MS;
  }

  const retainedDayUtc = Array.from(retainedUtcDays).sort(compareIsoDay);

  return {
    time_zone: timeZone,
    local_retention_days: retentionDays,
    current_local_day: localWindow.currentLocalDay,
    local_window_start_day: oldestLocalDay,
    local_window_end_day: newestLocalDay,
    retained_day_utc: retainedDayUtc,
    retained_day_utc_count: retainedDayUtc.length,
  };
}

export function isDayInRollingRetentionWindow(dayUtc, retentionWindow) {
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return false;
  }
  if (!retentionWindow || !Array.isArray(retentionWindow.retained_day_utc)) {
    return false;
  }
  return retentionWindow.retained_day_utc.includes(normalizedDay);
}

export function isDayLikelyInIngestWindow({
  dayUtc,
  nowUtc = new Date(),
  ingestRetentionDays = 7,
}) {
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return false;
  }

  const retentionDays = parsePositiveInt(ingestRetentionDays, 7, 1, 365);
  const todayUtc = utcDayFromDate(nowUtc);
  const lastCompleteDayUtc = shiftIsoDay(todayUtc, -1);
  const firstRetainedDayUtc = shiftIsoDay(lastCompleteDayUtc, -(retentionDays - 1));

  return compareIsoDay(normalizedDay, firstRetainedDayUtc) >= 0 &&
    compareIsoDay(normalizedDay, lastCompleteDayUtc) <= 0;
}

export function utcDayStartIso(dayUtc) {
  const normalized = parseIsoDayUtc(dayUtc);
  if (!normalized) {
    throw new Error(`Invalid day_utc: ${String(dayUtc)}`);
  }
  return `${normalized}T00:00:00.000Z`;
}

export function utcDayEndIso(dayUtc) {
  return `${shiftIsoDay(dayUtc, 1)}T00:00:00.000Z`;
}

export function addUtcHours(isoTs, deltaHours) {
  const parsed = Date.parse(String(isoTs || ""));
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ISO timestamp: ${String(isoTs)}`);
  }
  return new Date(parsed + Math.trunc(deltaHours) * HOUR_MS).toISOString();
}

export function dayRangeDaysCount(fromDayUtc, toDayUtc) {
  const from = parseIsoDayUtc(fromDayUtc);
  const to = parseIsoDayUtc(toDayUtc);
  if (!from || !to) {
    return 0;
  }
  const fromMs = utcFromIsoDay(from).getTime();
  const toMs = utcFromIsoDay(to).getTime();
  return Math.max(0, Math.trunc((toMs - fromMs) / DAY_MS) + 1);
}
