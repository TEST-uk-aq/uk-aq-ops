import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function invalidTimestamp(rawDate, rawTime, reason) {
  throw new Error(
    `invalid_uk_air_timestamp date=${
      JSON.stringify(String(rawDate ?? "").trim())
    } ` +
      `time=${JSON.stringify(String(rawTime ?? "").trim())} reason=${reason}`,
  );
}

function parseUkAirDateParts(rawDate) {
  const value = String(rawDate ?? "").trim();
  let year;
  let month;
  let day;
  const dayFirst = value.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/,
  );
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayFirst) {
    day = Number(dayFirst[1]);
    month = Number(dayFirst[2]);
    year = dayFirst[3].length === 2
      ? 2000 + Number(dayFirst[3])
      : Number(dayFirst[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    invalidTimestamp(rawDate, "", "malformed_date");
  }
  if (
    !Number.isInteger(year) || year < 1000 || year > 9999 ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(day) || day < 1 || day > 31
  ) {
    invalidTimestamp(rawDate, "", "invalid_calendar_date");
  }
  const validation = new Date(Date.UTC(year, month - 1, day));
  if (
    validation.getUTCFullYear() !== year ||
    validation.getUTCMonth() !== month - 1 ||
    validation.getUTCDate() !== day
  ) {
    invalidTimestamp(rawDate, "", "invalid_calendar_date");
  }
  return { year, month, day };
}

/**
 * Parse UK-AIR annual CSV date and time cells as UTC wall-clock values.
 *
 * Ordinary 00:00 through 23:59 remain on the stated date. The sole hour-24
 * spelling is exactly 24:00, which rolls to 00:00 on the following UTC day.
 */
export function parseUkAirObservedAtUtc(rawDate, rawTime) {
  const { year, month, day } = parseUkAirDateParts(rawDate);
  const time = String(rawTime ?? "").trim();
  if (time === "24:00") {
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString();
  }
  const match = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    invalidTimestamp(rawDate, rawTime, "malformed_time");
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (
    !Number.isInteger(hour) || hour < 0 || hour > 23 ||
    !Number.isInteger(minute) || minute < 0 || minute > 59 ||
    !Number.isInteger(second) || second < 0 || second > 59
  ) {
    invalidTimestamp(rawDate, rawTime, "invalid_time");
  }
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second),
  ).toISOString();
}

export function ukAirPartitionDayUtc(rawDate, rawTime) {
  return parseUkAirObservedAtUtc(rawDate, rawTime).slice(0, 10);
}

function parseRequestedIsoDay(rawDay) {
  const value = String(rawDay ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `invalid_requested_uk_air_day day=${JSON.stringify(value)}`,
    );
  }
  const observedAt = parseUkAirObservedAtUtc(value, "00:00");
  if (observedAt.slice(0, 10) !== value) {
    throw new Error(
      `invalid_requested_uk_air_day day=${JSON.stringify(value)}`,
    );
  }
  return value;
}

function shiftIsoDay(dayUtc, offsetDays) {
  const epoch = Date.parse(`${dayUtc}T00:00:00.000Z`);
  return new Date(epoch + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolve the annual source files needed to construct explicitly selected UTC
 * partition days. Each selected day needs raw source dates D-1 and D.
 */
export function requiredUkAirAnnualSourceYears(requestedDays) {
  const days = Array.from(
    new Set(Array.from(requestedDays || [], parseRequestedIsoDay)),
  ).sort();
  const sourceDates = new Set();
  const reasonsByYear = new Map();
  const previousYearBoundaryDays = [];
  const addReason = (year, reason) => {
    const reasons = reasonsByYear.get(year) || new Set();
    reasons.add(reason);
    reasonsByYear.set(year, reasons);
  };
  for (const dayUtc of days) {
    const previousSourceDate = shiftIsoDay(dayUtc, -1);
    sourceDates.add(previousSourceDate);
    sourceDates.add(dayUtc);
    const currentYear = Number(dayUtc.slice(0, 4));
    const previousSourceYear = Number(previousSourceDate.slice(0, 4));
    addReason(
      previousSourceYear,
      `source_date=${previousSourceDate} supplies the 24:00 boundary for partition_day=${dayUtc}`,
    );
    addReason(
      currentYear,
      `source_date=${dayUtc} supplies ordinary rows for partition_day=${dayUtc}`,
    );
    if (previousSourceYear !== currentYear) {
      previousYearBoundaryDays.push(dayUtc);
    }
  }
  const years = Array.from(reasonsByYear.keys()).sort((left, right) =>
    left - right
  );
  return {
    requested_days: days,
    source_dates: Array.from(sourceDates).sort(),
    years,
    reasons_by_year: Object.fromEntries(
      years.map((
        year,
      ) => [String(year), Array.from(reasonsByYear.get(year)).sort()]),
    ),
    previous_year_boundary_days: previousYearBoundaryDays.sort(),
  };
}

function isDirectExecution() {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const request = JSON.parse(fs.readFileSync(0, "utf8"));
    let result;
    if (request?.operation === "parse_timestamps") {
      if (!Array.isArray(request.values)) {
        throw new Error("parse_timestamps requires a values array");
      }
      result = request.values.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          throw new Error(`parse_timestamps value ${index} must be an object`);
        }
        const observedAtUtc = parseUkAirObservedAtUtc(entry.date, entry.time);
        return {
          observed_at_utc: observedAtUtc,
          partition_day_utc: observedAtUtc.slice(0, 10),
        };
      });
    } else if (request?.operation === "required_source_years") {
      result = requiredUkAirAnnualSourceYears(request.days);
    } else {
      throw new Error("unsupported UK-AIR timestamp helper operation");
    }
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  }
}
