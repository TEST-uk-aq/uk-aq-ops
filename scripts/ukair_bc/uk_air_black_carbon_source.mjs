import { createHash } from "node:crypto";

import {
  parseUkAirObservedAtUtc,
  requiredUkAirAnnualSourceYears,
} from "../../workers/uk_aq_backfill_local/uk_air_timestamp.mjs";

export const UKAIR_BC_HISTORY_START_DAY = "2020-01-01";
export const UKAIR_BC_PROPERTIES = Object.freeze(["bc", "uv370"]);

const PROPERTY_CONFIG = Object.freeze({
  bc: Object.freeze({
    filename_token: "BC",
    source_series: "Black Carbon (880 nm)",
  }),
  uv370: Object.freeze({
    filename_token: "U_Violet",
    source_series: "UV Particulate Matter (370 nm)",
  }),
});

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

function canonicalProperty(raw, label = "source property") {
  const property = String(raw || "").trim().toLowerCase();
  if (!UKAIR_BC_PROPERTIES.includes(property)) {
    throw new Error(`${label} must be exactly bc or uv370`);
  }
  return property;
}

export function normalizeUkaRef(raw, label = "UK-AIR station ref") {
  const value = String(raw || "").trim().toUpperCase();
  if (!/^UKA\d{5}$/.test(value)) {
    throw new Error(`${label} must be a canonical UKA identifier`);
  }
  return value;
}

export function normalizeSiteRef(raw, label = "UK-AIR site_ref") {
  const value = String(raw || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

export function buildUkAirBlackCarbonAnnualUrl({ siteRef, sourceProperty, sourceYear }) {
  const site = normalizeSiteRef(siteRef);
  const property = canonicalProperty(sourceProperty);
  const year = Number(sourceYear);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new Error("source year must be a four-digit year");
  }
  return `https://uk-air.defra.gov.uk/datastore/data_files/site_pol_data/${site}_${PROPERTY_CONFIG[property].filename_token}_${year}.csv`;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCsvRecords(text) {
  const records = [];
  let cells = [];
  let cell = "";
  let raw = "";
  let inQuotes = false;
  let recordStartLine = 1;
  let line = 1;
  const finishRecord = () => {
    cells.push(cell);
    if (cells.some((value) => String(value).trim() !== "")) {
      records.push(Object.freeze({
        cells: Object.freeze(cells),
        raw,
        line_number: recordStartLine,
      }));
    }
    cells = [];
    cell = "";
    raw = "";
    recordStartLine = line;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      raw += char;
      if (inQuotes && text[index + 1] === '"') {
        cell += '"';
        raw += text[index + 1];
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      raw += char;
      cells.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      line += 1;
      finishRecord();
      continue;
    }
    if (char === "\n") line += 1;
    raw += char;
    cell += char;
  }
  if (inQuotes) throw new Error("UK-AIR CSV contains an unterminated quoted field");
  if (raw || cell || cells.length) finishRecord();
  return records;
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function compactSeriesLabel(value) {
  return normalizeHeader(value)
    .replace(/[µμ]/g, "u")
    .replace(/³/g, "3")
    .replace(/[−–]/g, "-")
    .replace(/\s+/g, " ");
}

function classifySeriesLabel(value) {
  const label = compactSeriesLabel(value);
  const unit = "(?:ug\\s*(?:\\/\\s*m3|m-3))";
  if (new RegExp(`^black carbon \\(\\s*880\\s*nm\\s*\\)(?:\\s+${unit})?$`).test(label)) {
    return "bc";
  }
  if (new RegExp(`^uv particulate matter \\(\\s*370\\s*nm\\s*\\)(?:\\s+${unit})?$`).test(label)) {
    return "uv370";
  }
  if (/^uv particulate matter\s*\(\s*uv\s*-\s*bc\s*\)/.test(label)) {
    return "uvpm";
  }
  if (/^(?:black carbon|uv particulate matter)\s*\(/.test(label)) {
    return "other_black_carbon_series";
  }
  return null;
}

function normalizeConcentrationUnit(value) {
  const compact = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/³/g, "3")
    .replace(/[−–]/g, "-")
    .replace(/\s+/g, "");
  if (["ug/m3", "ugm-3", "ug/m-3"].includes(compact)) return "ug/m3";
  return compact;
}

function parseFiniteObservation(raw, lineNumber) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`UK-AIR observation is not finite at line ${lineNumber}`);
  }
  return parsed;
}

function rawDateYear(rawDate) {
  const value = String(rawDate || "").trim();
  const dayFirst = value.match(/^\d{1,2}[-/]\d{1,2}[-/](\d{2}|\d{4})$/);
  const iso = value.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (iso) return Number(iso[1]);
  if (!dayFirst) return null;
  return dayFirst[1].length === 2 ? 2000 + Number(dayFirst[1]) : Number(dayFirst[1]);
}

function sourceSuppliedDate(records) {
  for (const record of records) {
    const match = record.raw.match(/Data supplied by UK-AIR on\s+(.+?)\s*$/i);
    if (match) return match[1].trim();
  }
  return null;
}

function assertStationAttribution(text, ukAirRef) {
  const refs = [...new Set((text.match(/UKA\d{5}/gi) || []).map((value) => value.toUpperCase()))];
  if (refs.length > 0 && (refs.length !== 1 || refs[0] !== ukAirRef)) {
    throw new Error(
      `UK-AIR file station identity contradicts requested ${ukAirRef}: ${refs.join(",")}`,
    );
  }
}

/**
 * Parse one exact pinned annual UK-AIR Black Carbon source object.
 *
 * The parser deliberately accepts only the two contractual source-series
 * identities and derives P/R solely from the documented row prefix.
 */
export function parseUkAirBlackCarbonAnnualCsv({
  bytes,
  sourceProperty,
  sourceYear,
  ukAirRef,
  siteRef,
}) {
  const property = canonicalProperty(sourceProperty);
  const year = Number(sourceYear);
  const canonicalUkaRef = normalizeUkaRef(ukAirRef);
  normalizeSiteRef(siteRef);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new Error("source year must be a four-digit year");
  }
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (body.length === 0) throw new Error("UK-AIR annual CSV is empty");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    throw new Error("UK-AIR annual CSV is not valid UTF-8", { cause: error });
  }
  if (text.includes("\u0000")) throw new Error("UK-AIR annual CSV contains NUL bytes");
  const records = parseCsvRecords(text);
  if (!records.length) throw new Error("UK-AIR annual CSV contains no records");
  const suppliedDate = sourceSuppliedDate(records);
  if (!suppliedDate) throw new Error("UK-AIR source-supplied date declaration is missing");
  if (!records.some((record) => /All Data GMT hour ending/i.test(record.raw))) {
    throw new Error("UK-AIR GMT hour-ending declaration is missing");
  }
  if (!records.some((record) => /Rows beginn?ing\s+##\s+are Provisional/i.test(record.raw))) {
    throw new Error("UK-AIR provisional-row declaration is missing");
  }
  assertStationAttribution(text, canonicalUkaRef);

  const rows = [];
  const seenTimestamps = new Set();
  const perDayCounts = new Map();
  let sourceRows = 0;
  let missingCells = 0;
  let provisionalCount = 0;
  let ratifiedCount = 0;
  let zeroCount = 0;
  let currentValueIndex = null;
  let currentUnitIndex = null;
  let headerCount = 0;
  let currentSectionRows = [];
  let currentSectionUnits = new Set();

  const finishSection = () => {
    if (!currentSectionRows.length) return;
    if (currentSectionUnits.size === 0) {
      throw new Error("UK-AIR source has values without canonical concentration-unit evidence");
    }
    if ([...currentSectionUnits].some((unit) => unit !== "ug/m3")) {
      throw new Error(
        `UK-AIR source unit contradicts ug/m3: ${[...currentSectionUnits].join(",")}`,
      );
    }
    rows.push(...currentSectionRows);
    currentSectionRows = [];
    currentSectionUnits = new Set();
  };

  for (const record of records) {
    const cells = record.cells.map((cell) => String(cell).trim());
    const first = normalizeHeader(cells[0]);
    const second = normalizeHeader(cells[1]);
    if (first === "date" && second === "time") {
      finishSection();
      headerCount += 1;
      const classified = cells.map(classifySeriesLabel);
      const targetIndexes = classified.flatMap((value, index) => value === property ? [index] : []);
      const contradictory = classified.filter((value) => value && value !== property);
      if (targetIndexes.length !== 1 || contradictory.length > 0) {
        throw new Error(
          `UK-AIR source-property header mismatch for ${property}: ` +
            `${classified.filter(Boolean).join(",") || "no contractual series"}`,
        );
      }
      currentValueIndex = targetIndexes[0];
      if (currentValueIndex < 2) {
        throw new Error("UK-AIR source-series column precedes Date/Time columns");
      }
      const statusHeader = normalizeHeader(cells[currentValueIndex + 1]);
      const unitHeader = normalizeHeader(cells[currentValueIndex + 2]);
      currentUnitIndex = statusHeader === "status" && unitHeader === "unit"
        ? currentValueIndex + 2
        : null;
      continue;
    }
    if (currentValueIndex === null) continue;

    const provisional = record.raw.trimStart().startsWith("##");
    const rawDate = cells[0].replace(/^##\s*/, "").trim();
    const rawTime = cells[1];
    if (!rawDate && !rawTime) continue;
    sourceRows += 1;
    if (rawDateYear(rawDate) !== year) {
      throw new Error(`UK-AIR annual CSV contains a row outside source year ${year}`);
    }
    const observedAtUtc = parseUkAirObservedAtUtc(rawDate, rawTime);
    if (seenTimestamps.has(observedAtUtc)) {
      throw new Error(`UK-AIR annual CSV contains duplicate timestamp ${observedAtUtc}`);
    }
    seenTimestamps.add(observedAtUtc);
    const value = parseFiniteObservation(cells[currentValueIndex], record.line_number);
    if (value === null) {
      missingCells += 1;
      continue;
    }
    const rawUnit = currentUnitIndex === null ? "" : cells[currentUnitIndex];
    const normalizedUnit = normalizeConcentrationUnit(rawUnit);
    if (normalizedUnit) currentSectionUnits.add(normalizedUnit);
    const verificationStatus = provisional ? "P" : "R";
    if (verificationStatus === "P") provisionalCount += 1;
    else ratifiedCount += 1;
    if (Object.is(value, 0) || Object.is(value, -0)) zeroCount += 1;
    const dayUtc = observedAtUtc.slice(0, 10);
    perDayCounts.set(dayUtc, (perDayCounts.get(dayUtc) || 0) + 1);
    currentSectionRows.push(Object.freeze({
      observed_at_utc: observedAtUtc,
      value: Object.is(value, -0) ? 0 : value,
      verification_status: verificationStatus,
    }));
  }
  finishSection();
  if (headerCount === 0) throw new Error("UK-AIR annual CSV data header is missing");
  rows.sort((left, right) => bytewiseCompare(left.observed_at_utc, right.observed_at_utc));
  return Object.freeze({
    source_property: property,
    source_series: PROPERTY_CONFIG[property].source_series,
    source_year: year,
    source_supplied_date: suppliedDate,
    source_rows: sourceRows,
    valid_observation_count: rows.length,
    missing_cell_count: missingCells,
    provisional_count: provisionalCount,
    ratified_count: ratifiedCount,
    zero_count: zeroCount,
    first_observed_at_utc: rows[0]?.observed_at_utc || null,
    last_observed_at_utc: rows.at(-1)?.observed_at_utc || null,
    per_partition_day_row_counts: Object.freeze(Object.fromEntries(
      [...perDayCounts.entries()].sort(([left], [right]) => bytewiseCompare(left, right)),
    )),
    rows: Object.freeze(rows),
  });
}

export function requiredBlackCarbonAnnualSourceYears(days) {
  return requiredUkAirAnnualSourceYears(days);
}

function scopeIdentity(scope) {
  return `${scope.day_utc}\u0000${scope.connector_id}\u0000${scope.pollutant_code}`;
}

export function routeBlackCarbonSelectedScopes(scopes) {
  if (!Array.isArray(scopes)) throw new TypeError("selected scopes must be an array");
  const partitions = [];
  const removedScopes = [];
  const blockedScopes = [];
  const seen = new Set();
  for (const raw of [...scopes].sort((left, right) =>
    bytewiseCompare(left.day_utc, right.day_utc) ||
    Number(left.connector_id) - Number(right.connector_id) ||
    bytewiseCompare(left.pollutant_code, right.pollutant_code)
  )) {
    const scope = Object.freeze({
      day_utc: String(raw.day_utc || ""),
      connector_id: Number(raw.connector_id),
      pollutant_code: canonicalProperty(raw.pollutant_code, "scope pollutant_code"),
    });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scope.day_utc)) {
      throw new Error("selected scope day_utc must be YYYY-MM-DD");
    }
    if (!Number.isSafeInteger(scope.connector_id) || scope.connector_id <= 0) {
      throw new Error("selected scope connector_id must be a positive integer");
    }
    const identity = scopeIdentity(scope);
    if (seen.has(identity)) throw new Error(`duplicate selected scope: ${identity}`);
    seen.add(identity);
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    if (raw.blocked_reason) {
      blockedScopes.push(Object.freeze({ ...scope, blocked_reason: String(raw.blocked_reason) }));
    } else if (rows.length > 0) {
      partitions.push(Object.freeze({ scope, rows: Object.freeze([...rows]) }));
    } else if (raw.conclusive === true) {
      removedScopes.push(scope);
    } else {
      blockedScopes.push(Object.freeze({
        ...scope,
        blocked_reason: "source scope was not conclusively established",
      }));
    }
  }
  return Object.freeze({
    partitions: Object.freeze(partitions),
    removedScopes: Object.freeze(removedScopes),
    blockedScopes: Object.freeze(blockedScopes),
  });
}
