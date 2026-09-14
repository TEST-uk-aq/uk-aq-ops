import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const OBSERVATION_CONTENT_HASH_ALGORITHM = "sha256";
export const OBSERVATION_CONTENT_HASH_CONTRACT_VERSION = 1;
export const OBSERVATION_CONTENT_HASH_COLUMNS = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "observed_at_utc",
  "value",
  "verification_status",
]);
export const OBSERVATION_CONTENT_HASH_PREFIX =
  "uk-aq-observation-content-hash:v1\n";

const EXACT_UTC_MILLISECOND_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_POLLUTANT_CODE = /^[a-z0-9_]+$/;

function positiveInteger(value, fieldName) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function canonicalStationId(value) {
  if (value === null || value === undefined) return null;
  return positiveInteger(value, "station_id");
}

export function normalizeUkAirVerificationStatus(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "p" || normalized === "provisional") return "P";
  if (normalized === "r" || normalized === "ratified") return "R";
  throw new TypeError(
    `Unsupported UK-AIR verification status: ${JSON.stringify(String(value))}`,
  );
}

export function requireCanonicalVerificationStatus(value) {
  if (value === null || value === undefined) return null;
  if (value === "P" || value === "R") return value;
  throw new TypeError("verification_status must be P, R or null");
}

export function resolveLegacyVerificationStatus(row, { isSos = false } = {}) {
  const source = row && typeof row === "object" ? row : {};
  if (Object.hasOwn(source, "verification_status")) {
    const value = source.verification_status;
    return isSos
      ? normalizeUkAirVerificationStatus(value)
      : requireCanonicalVerificationStatus(value);
  }
  if (Object.hasOwn(source, "status")) {
    return isSos ? normalizeUkAirVerificationStatus(source.status) : null;
  }
  return null;
}

export function float64BigEndianHex(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError("value must be a finite IEEE-754 binary64 number");
  }
  const normalized = Object.is(numeric, -0) ? 0 : numeric;
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, normalized, false);
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function normalizeCanonicalObservationRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("canonical observation row must be an object");
  }
  const pollutantCode = row.pollutant_code;
  if (
    typeof pollutantCode !== "string" ||
    !CANONICAL_POLLUTANT_CODE.test(pollutantCode) ||
    pollutantCode !== pollutantCode.toLowerCase()
  ) {
    throw new TypeError(
      "pollutant_code must be a validated canonical lower-case code",
    );
  }
  const observedAtUtc = row.observed_at_utc;
  if (
    typeof observedAtUtc !== "string" ||
    !EXACT_UTC_MILLISECOND_TIMESTAMP.test(observedAtUtc) ||
    Number.isNaN(Date.parse(observedAtUtc)) ||
    new Date(observedAtUtc).toISOString() !== observedAtUtc
  ) {
    throw new TypeError(
      "observed_at_utc must be an exact UTC ISO timestamp with millisecond precision",
    );
  }
  const numericValue = row.value;
  if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
    throw new TypeError("value must be a finite IEEE-754 binary64 number");
  }
  return Object.freeze({
    connector_id: positiveInteger(row.connector_id, "connector_id"),
    station_id: canonicalStationId(row.station_id),
    timeseries_id: positiveInteger(row.timeseries_id, "timeseries_id"),
    pollutant_code: pollutantCode,
    observed_at_utc: observedAtUtc,
    value: Object.is(numericValue, -0) ? 0 : numericValue,
    verification_status: requireCanonicalVerificationStatus(
      row.verification_status,
    ),
  });
}

export function encodeCanonicalObservationRow(row) {
  const canonical = normalizeCanonicalObservationRow(row);
  return JSON.stringify([
    canonical.connector_id,
    canonical.station_id,
    canonical.timeseries_id,
    canonical.pollutant_code,
    canonical.observed_at_utc,
    float64BigEndianHex(canonical.value),
    canonical.verification_status,
  ]);
}

export function computeObservationContentHash(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError(
      "observation content hash requires a non-empty canonical partition",
    );
  }
  const canonicalRows = rows.map(normalizeCanonicalObservationRow);
  const encodedRows = canonicalRows.map(encodeCanonicalObservationRow).sort();
  const hash = createHash("sha256");
  hash.update(OBSERVATION_CONTENT_HASH_PREFIX, "utf8");
  for (const encoded of encodedRows) {
    hash.update(encoded, "utf8");
    hash.update("\n", "utf8");
  }
  const verificationStatusCounts = {
    P: 0,
    R: 0,
    null: 0,
  };
  for (const row of canonicalRows) {
    const key = row.verification_status === null
      ? "null"
      : row.verification_status;
    verificationStatusCounts[key] += 1;
  }
  return {
    observation_content_hash: hash.digest("hex"),
    observation_content_hash_algorithm: OBSERVATION_CONTENT_HASH_ALGORITHM,
    observation_content_hash_contract_version:
      OBSERVATION_CONTENT_HASH_CONTRACT_VERSION,
    observation_content_hash_row_count: canonicalRows.length,
    observation_content_hash_columns: [...OBSERVATION_CONTENT_HASH_COLUMNS],
    verification_status_counts: verificationStatusCounts,
    canonical_rows: canonicalRows,
  };
}

export function computeEmptyObservationContentHash() {
  const hash = createHash("sha256");
  hash.update(OBSERVATION_CONTENT_HASH_PREFIX, "utf8");
  return {
    observation_content_hash: hash.digest("hex"),
    observation_content_hash_algorithm: OBSERVATION_CONTENT_HASH_ALGORITHM,
    observation_content_hash_contract_version:
      OBSERVATION_CONTENT_HASH_CONTRACT_VERSION,
    observation_content_hash_row_count: 0,
    observation_content_hash_columns: [...OBSERVATION_CONTENT_HASH_COLUMNS],
    verification_status_counts: { P: 0, R: 0, null: 0 },
    canonical_rows: [],
  };
}

export function validateObservationContentHashMetadata(
  metadata,
  { rowCount = null } = {},
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("observation content hash metadata must be an object");
  }
  if (
    typeof metadata.observation_content_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.observation_content_hash)
  ) {
    throw new TypeError("observation_content_hash must be lower-case SHA-256");
  }
  if (
    metadata.observation_content_hash_algorithm !==
      OBSERVATION_CONTENT_HASH_ALGORITHM
  ) {
    throw new TypeError("unsupported observation content hash algorithm");
  }
  if (
    metadata.observation_content_hash_contract_version !==
      OBSERVATION_CONTENT_HASH_CONTRACT_VERSION
  ) {
    throw new TypeError("unsupported observation content hash contract version");
  }
  if (
    !Number.isSafeInteger(metadata.observation_content_hash_row_count) ||
    metadata.observation_content_hash_row_count < 0 ||
    (
      rowCount !== null &&
      metadata.observation_content_hash_row_count !== rowCount
    )
  ) {
    throw new TypeError("observation content hash row count is invalid");
  }
  if (
    !Array.isArray(metadata.observation_content_hash_columns) ||
    metadata.observation_content_hash_columns.length !==
      OBSERVATION_CONTENT_HASH_COLUMNS.length ||
    metadata.observation_content_hash_columns.some(
      (column, index) => column !== OBSERVATION_CONTENT_HASH_COLUMNS[index],
    )
  ) {
    throw new TypeError("observation content hash columns are invalid");
  }
  const counts = metadata.verification_status_counts;
  if (
    !counts ||
    typeof counts !== "object" ||
    Array.isArray(counts) ||
    Object.keys(counts).length !== 3 ||
    ["P", "R", "null"].some((key) => !Object.hasOwn(counts, key))
  ) {
    throw new TypeError("verification_status_counts keys are invalid");
  }
  for (const key of ["P", "R", "null"]) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) {
      throw new TypeError("verification_status_counts values are invalid");
    }
  }
  if (
    counts.P + counts.R + counts.null !==
      metadata.observation_content_hash_row_count
  ) {
    throw new TypeError(
      "verification_status_counts do not sum to the hash row count",
    );
  }
  return metadata;
}

const isMain = typeof process !== "undefined" && process.argv?.[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    const inputRows = Array.isArray(input?.rows) ? input.rows : input?.rows;
    const rows = input?.legacy_status_mode
      ? inputRows.map((row) => ({
        ...row,
        verification_status: resolveLegacyVerificationStatus(row, {
          isSos: input.legacy_status_mode === "sos",
        }),
      }))
      : inputRows;
    const result = Array.isArray(rows) && rows.length === 0 && input?.allow_empty
      ? computeEmptyObservationContentHash()
      : computeObservationContentHash(rows);
    const { canonical_rows: _canonicalRows, ...output } = result;
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
