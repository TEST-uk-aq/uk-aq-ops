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
  if (adapter === "sensorcommunity") {
    return (
      message.startsWith("sensorcommunity_archive_index_fetch_failed:") ||
      message.startsWith("sensorcommunity_archive_csv_fetch_failed:")
    );
  }
  return false;
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
