import { createHash } from "node:crypto";

export const OBSERVATIONS_AGGREGATE_MANIFEST_SCHEMA_VERSION = 1;
export const OBSERVATIONS_AGGREGATE_CONTENT_HASH_ALGORITHM = "sha256";
export const OBSERVATIONS_AGGREGATE_MANIFEST_KINDS = Object.freeze({
  month: "uk_aq_observations_month_manifest",
  year: "uk_aq_observations_year_manifest",
  root: "uk_aq_observations_root_manifest",
});

const OBSERVATIONS_DOMAIN = "observations";
const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";
const CONTENT_HASH_PREFIX = "uk_aq:r2_history:v2:observations_aggregate_manifest:v1";
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function normalizePrefix(value = DEFAULT_OBSERVATIONS_PREFIX) {
  const prefix = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid observations aggregate manifest prefix: ${String(value || "")}`);
  }
  return prefix;
}

function normalizeYear(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}$/.test(text)) {
    throw new Error(`Invalid observations aggregate manifest year: ${String(value ?? "")}`);
  }
  const year = Number(text);
  if (!Number.isSafeInteger(year) || year < 1) {
    throw new Error(`Invalid observations aggregate manifest year: ${String(value ?? "")}`);
  }
  return year;
}

function normalizeMonth(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,2}$/.test(text)) {
    throw new Error(`Invalid observations aggregate manifest month: ${String(value ?? "")}`);
  }
  const month = Number(text);
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid observations aggregate manifest month: ${String(value ?? "")}`);
  }
  return String(month).padStart(2, "0");
}

function normalizeDay(value) {
  const day = String(value || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (!ISO_DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid observations aggregate manifest day: ${String(value || "")}`);
  }
  return day;
}

function normalizeSha256(value, fieldName) {
  const hash = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`Invalid ${fieldName}: ${String(value || "")}`);
  }
  return hash;
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireNonEmptyChildren(children, level) {
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error(`Observations ${level} aggregate manifest requires at least one child`);
  }
  return children;
}

function assertUnique(values, level) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate observations ${level} aggregate manifest child: ${value}`);
    }
    seen.add(value);
  }
}

export function buildR2HistoryV2ObservationsRootManifestKey(basePrefix = DEFAULT_OBSERVATIONS_PREFIX) {
  return `${normalizePrefix(basePrefix)}/_manifests/manifest.json`;
}

export function buildR2HistoryV2ObservationsYearManifestKey(basePrefix, year) {
  return `${normalizePrefix(basePrefix)}/_manifests/year=${normalizeYear(year)}/manifest.json`;
}

export function buildR2HistoryV2ObservationsMonthManifestKey(basePrefix, year, month) {
  return `${normalizePrefix(basePrefix)}/_manifests/year=${normalizeYear(year)}/month=${normalizeMonth(month)}/manifest.json`;
}

function buildDayManifestKey(basePrefix, dayUtc) {
  return `${normalizePrefix(basePrefix)}/day_utc=${normalizeDay(dayUtc)}/manifest.json`;
}

function canonicalMonthChildren(basePrefix, year, month, dayManifests) {
  const normalizedYear = normalizeYear(year);
  const normalizedMonth = normalizeMonth(month);
  const children = requireNonEmptyChildren(dayManifests, "month").map((manifest) => {
    const dayUtc = normalizeDay(manifest?.day_utc);
    if (Number(dayUtc.slice(0, 4)) !== normalizedYear || dayUtc.slice(5, 7) !== normalizedMonth) {
      throw new Error(`Observation day ${dayUtc} does not belong to ${normalizedYear}-${normalizedMonth}`);
    }
    const manifestKey = String(manifest?.manifest_key || "").trim();
    const expectedKey = buildDayManifestKey(basePrefix, dayUtc);
    if (manifestKey !== expectedKey) {
      throw new Error(`Unexpected day manifest key for ${dayUtc}: ${manifestKey || "(empty)"}`);
    }
    return {
      day_utc: dayUtc,
      manifest_key: manifestKey,
      manifest_hash: normalizeSha256(manifest?.manifest_hash, `day manifest_hash for ${dayUtc}`),
    };
  }).sort((left, right) => left.day_utc.localeCompare(right.day_utc));
  assertUnique(children.map((child) => child.day_utc), "month");
  return children;
}

function canonicalYearChildren(basePrefix, year, monthManifests) {
  const normalizedYear = normalizeYear(year);
  const children = requireNonEmptyChildren(monthManifests, "year").map((manifest) => {
    const childYear = normalizeYear(manifest?.year);
    const month = normalizeMonth(manifest?.month);
    if (childYear !== normalizedYear) {
      throw new Error(`Observation month ${childYear}-${month} does not belong to ${normalizedYear}`);
    }
    const expectedKey = buildR2HistoryV2ObservationsMonthManifestKey(basePrefix, normalizedYear, month);
    const manifestKey = String(manifest?.manifest_key || expectedKey).trim();
    if (manifestKey !== expectedKey) {
      throw new Error(`Unexpected month manifest key for ${normalizedYear}-${month}: ${manifestKey || "(empty)"}`);
    }
    return {
      month,
      manifest_key: manifestKey,
      content_hash: normalizeSha256(manifest?.content_hash, `month content_hash for ${normalizedYear}-${month}`),
    };
  }).sort((left, right) => left.month.localeCompare(right.month));
  assertUnique(children.map((child) => child.month), "year");
  return children;
}

function canonicalRootChildren(basePrefix, yearManifests) {
  const children = requireNonEmptyChildren(yearManifests, "root").map((manifest) => {
    const year = normalizeYear(manifest?.year);
    const expectedKey = buildR2HistoryV2ObservationsYearManifestKey(basePrefix, year);
    const manifestKey = String(manifest?.manifest_key || expectedKey).trim();
    if (manifestKey !== expectedKey) {
      throw new Error(`Unexpected year manifest key for ${year}: ${manifestKey || "(empty)"}`);
    }
    return {
      year,
      manifest_key: manifestKey,
      content_hash: normalizeSha256(manifest?.content_hash, `year content_hash for ${year}`),
    };
  }).sort((left, right) => left.year - right.year);
  assertUnique(children.map((child) => child.year), "root");
  return children;
}

export function computeR2HistoryV2ObservationsAggregateContentHash(level, children) {
  if (!Object.hasOwn(OBSERVATIONS_AGGREGATE_MANIFEST_KINDS, level)) {
    throw new Error(`Unsupported observations aggregate manifest level: ${String(level || "")}`);
  }
  return sha256Hex(`${CONTENT_HASH_PREFIX}:${level}\n${JSON.stringify(children)}`);
}

export function buildR2HistoryV2ObservationsMonthManifest({
  basePrefix = DEFAULT_OBSERVATIONS_PREFIX,
  year,
  month,
  dayManifests,
}) {
  const normalizedPrefix = normalizePrefix(basePrefix);
  const normalizedYear = normalizeYear(year);
  const normalizedMonth = normalizeMonth(month);
  const children = canonicalMonthChildren(normalizedPrefix, normalizedYear, normalizedMonth, dayManifests);
  return {
    kind: OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.month,
    schema_version: OBSERVATIONS_AGGREGATE_MANIFEST_SCHEMA_VERSION,
    domain: OBSERVATIONS_DOMAIN,
    year: normalizedYear,
    month: normalizedMonth,
    children,
    content_hash: computeR2HistoryV2ObservationsAggregateContentHash("month", children),
    content_hash_algorithm: OBSERVATIONS_AGGREGATE_CONTENT_HASH_ALGORITHM,
  };
}

export function buildR2HistoryV2ObservationsYearManifest({
  basePrefix = DEFAULT_OBSERVATIONS_PREFIX,
  year,
  monthManifests,
}) {
  const normalizedPrefix = normalizePrefix(basePrefix);
  const normalizedYear = normalizeYear(year);
  const children = canonicalYearChildren(normalizedPrefix, normalizedYear, monthManifests);
  return {
    kind: OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.year,
    schema_version: OBSERVATIONS_AGGREGATE_MANIFEST_SCHEMA_VERSION,
    domain: OBSERVATIONS_DOMAIN,
    year: normalizedYear,
    children,
    content_hash: computeR2HistoryV2ObservationsAggregateContentHash("year", children),
    content_hash_algorithm: OBSERVATIONS_AGGREGATE_CONTENT_HASH_ALGORITHM,
  };
}

export function buildR2HistoryV2ObservationsRootManifest({
  basePrefix = DEFAULT_OBSERVATIONS_PREFIX,
  yearManifests,
}) {
  const normalizedPrefix = normalizePrefix(basePrefix);
  const children = canonicalRootChildren(normalizedPrefix, yearManifests);
  return {
    kind: OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.root,
    schema_version: OBSERVATIONS_AGGREGATE_MANIFEST_SCHEMA_VERSION,
    domain: OBSERVATIONS_DOMAIN,
    children,
    content_hash: computeR2HistoryV2ObservationsAggregateContentHash("root", children),
    content_hash_algorithm: OBSERVATIONS_AGGREGATE_CONTENT_HASH_ALGORITHM,
  };
}

function levelForManifest(manifest) {
  for (const [level, kind] of Object.entries(OBSERVATIONS_AGGREGATE_MANIFEST_KINDS)) {
    if (manifest?.kind === kind) return level;
  }
  throw new Error(`Unsupported observations aggregate manifest kind: ${String(manifest?.kind || "")}`);
}

export function validateR2HistoryV2ObservationsAggregateManifest(
  manifest,
  { basePrefix = DEFAULT_OBSERVATIONS_PREFIX } = {},
) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Observations aggregate manifest must be a JSON object");
  }
  if (manifest.schema_version !== OBSERVATIONS_AGGREGATE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported observations aggregate manifest schema_version: ${String(manifest.schema_version)}`);
  }
  if (manifest.domain !== OBSERVATIONS_DOMAIN) {
    throw new Error(`Unexpected observations aggregate manifest domain: ${String(manifest.domain || "")}`);
  }
  if (manifest.content_hash_algorithm !== OBSERVATIONS_AGGREGATE_CONTENT_HASH_ALGORITHM) {
    throw new Error(`Unexpected observations aggregate content hash algorithm: ${String(manifest.content_hash_algorithm || "")}`);
  }

  const level = levelForManifest(manifest);
  let canonical;
  if (level === "month") {
    canonical = buildR2HistoryV2ObservationsMonthManifest({
      basePrefix,
      year: manifest.year,
      month: manifest.month,
      dayManifests: manifest.children,
    });
  } else if (level === "year") {
    canonical = buildR2HistoryV2ObservationsYearManifest({
      basePrefix,
      year: manifest.year,
      monthManifests: manifest.children.map((child) => ({
        year: manifest.year,
        month: child?.month,
        manifest_key: child?.manifest_key,
        content_hash: child?.content_hash,
      })),
    });
  } else {
    canonical = buildR2HistoryV2ObservationsRootManifest({
      basePrefix,
      yearManifests: manifest.children.map((child) => ({
        year: child?.year,
        manifest_key: child?.manifest_key,
        content_hash: child?.content_hash,
      })),
    });
  }

  const suppliedHash = normalizeSha256(manifest.content_hash, `${level} content_hash`);
  if (suppliedHash !== canonical.content_hash) {
    throw new Error(`Observations ${level} aggregate manifest content_hash mismatch`);
  }
  return canonical;
}

export function serializeR2HistoryV2ObservationsAggregateManifest(
  manifest,
  options = {},
) {
  const canonical = validateR2HistoryV2ObservationsAggregateManifest(manifest, options);
  return Buffer.from(JSON.stringify(canonical), "utf8");
}
