import { createHash } from "node:crypto";
import {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
} from "npm:hyparquet";
import { compressors } from "npm:hyparquet-compressors";
import { addDays, assertIsoDay } from "./who_2021_daily_core.ts";
import {
  getR2Object,
  R2Config,
  R2ReadResult,
  sha256Hex,
} from "./r2_objects.ts";

export const R2_OBSERVATION_PREFIX = "history/v2/observations";
export const R2_OBSERVATION_COLUMNS = [
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "observed_at_utc",
  "value",
] as const;

const R2_OBSERVATION_SUPPORTED_COLUMN_SETS = [
  [...R2_OBSERVATION_COLUMNS],
  [...R2_OBSERVATION_COLUMNS, "status"],
  [...R2_OBSERVATION_COLUMNS, "verification_status"],
] as const;

function hasSupportedObservationColumns(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  const columns = value.map(String);

  return R2_OBSERVATION_SUPPORTED_COLUMN_SETS.some((expected) =>
    columns.length === expected.length &&
    expected.every((column) => columns.includes(column))
  );
}

export type R2ObjectReader = (key: string) => Promise<R2ReadResult>;

export type PreparedDailyRow = {
  timeseries_id: number;
  valid_hour_count: number;
  daily_mean_ugm3: number | null;
};

export type R2ReadMetrics = {
  manifestKeys: string[];
  manifestHashesValidated: number;
  parquetHashesValidated: number;
  objectCount: number;
  bytesRead: number;
  parquetRowCount: number;
};

export type R2ObservationRow = {
  connectorId: number;
  stationId: number | null;
  timeseriesId: number;
  pollutantCode: string;
  observedAtUtc: string;
  value: number | null;
};

export type R2PreparedDay = {
  dayUtc: string;
  preparedRows: PreparedDailyRow[];
  validPreparedRows: number;
  insufficientPreparedRows: number;
  metrics: R2ReadMetrics;
};

export class R2ObservationReadError extends Error {
  constructor(message: string, readonly metrics: R2ReadMetrics) {
    super(message);
    this.name = "R2ObservationReadError";
  }
}

type JsonRecord = Record<string, unknown>;

type ManifestFile = {
  key: string;
  rowCount: number;
  bytes: number;
  etagOrHash: string;
};

const PART_FILE_RE = /\/part-\d{5}\.parquet$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MD5_RE = /^[a-f0-9]{32}$/;

export function createR2ObjectReader(config: R2Config): R2ObjectReader {
  return (key) => getR2Object(config, key);
}

export function createR2ReadMetrics(): R2ReadMetrics {
  return {
    manifestKeys: [],
    manifestHashesValidated: 0,
    parquetHashesValidated: 0,
    objectCount: 0,
    bytesRead: 0,
    parquetRowCount: 0,
  };
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(
  record: JsonRecord,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requiredInteger(
  record: JsonRecord,
  key: string,
  label: string,
  minimum = 0,
): number {
  const value = Number(record[key]);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label}.${key} must be an integer >= ${minimum}`);
  }
  return value;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function normalizeHash(value: string): string {
  return value.trim().replace(/^W\//i, "").replace(/^"|"$/g, "")
    .toLowerCase();
}

function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

const COVERAGE_STATE_FIELDS = new Set([
  "coverage",
  "index_coverage",
  "manifest_coverage",
  "coverage_state",
  "completeness",
]);
const COVERAGE_LIST_FIELDS = new Set([
  "partial_reasons",
  "missing_day_manifest_keys",
  "missing_connector_manifest_keys",
  "missing_parquet_keys",
  "missing_connector_index_keys",
]);

function normalizeCoverageName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function normalizeCoverageValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isIncompleteCoverageState(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = normalizeCoverageValue(value);
  return normalized === "partial" ||
    normalized === "incomplete" ||
    normalized === "not_complete" ||
    normalized.includes("partial") ||
    normalized.includes("incomplete") ||
    normalized.includes("with_gap") ||
    normalized.includes("missing");
}

function isFalseCoverageValue(value: unknown): boolean {
  if (value === false || value === 0) return true;
  if (typeof value !== "string") return false;
  return ["false", "0", "no", "partial", "incomplete", "not_complete"]
    .includes(normalizeCoverageValue(value));
}

function isTrueCoverageValue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "gap", "gapped", "partial", "incomplete"]
    .includes(normalizeCoverageValue(value));
}

function hasNonEmptyCoverageSignal(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function coverageError(label: string, path: string, reason: string): Error {
  return new Error(
    `Incomplete R2 coverage in ${label} at ${path}: ${reason}`.slice(0, 500),
  );
}

export function assertCompleteManifestCoverage(
  value: unknown,
  label = "manifest",
): void {
  const visit = (
    current: unknown,
    path: string,
    coverageContext: boolean,
  ): void => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) =>
        visit(entry, `${path}[${index}]`, coverageContext)
      );
      return;
    }
    if (!current || typeof current !== "object") return;

    for (const [rawKey, child] of Object.entries(current)) {
      const key = normalizeCoverageName(rawKey);
      const childPath = `${path}.${rawKey}`;
      const childCoverageContext = coverageContext ||
        key.includes("coverage") ||
        key.includes("completeness") ||
        key.includes("gap") ||
        key === "timeseries_index";

      if (key === "response_complete" && isFalseCoverageValue(child)) {
        throw coverageError(label, childPath, "response_complete is false");
      }
      if (key === "has_gap" && isTrueCoverageValue(child)) {
        throw coverageError(label, childPath, "has_gap is true");
      }
      if (
        COVERAGE_STATE_FIELDS.has(key) &&
        (
          isIncompleteCoverageState(child) ||
          isFalseCoverageValue(child)
        )
      ) {
        throw coverageError(
          label,
          childPath,
          `state is ${String(child).slice(0, 80)}`,
        );
      }
      if (
        (
          COVERAGE_LIST_FIELDS.has(key) ||
          key === "gap_ranges" ||
          key === "gaps" ||
          key === "gap" ||
          key === "coverage_gaps" ||
          key === "coverage_gap" ||
          key === "missing_ranges" ||
          key.endsWith("_coverage_gaps") ||
          (key.startsWith("missing_") && key.endsWith("_keys")) ||
          (
            childCoverageContext &&
            (
              key.startsWith("missing") ||
              key === "partial" ||
              key === "incomplete"
            )
          )
        ) &&
        hasNonEmptyCoverageSignal(child)
      ) {
        throw coverageError(label, childPath, "contains coverage gaps");
      }
      if (
        childCoverageContext &&
        (key === "complete" ||
          key === "is_complete" ||
          key === "fully_covered") &&
        isFalseCoverageValue(child)
      ) {
        throw coverageError(label, childPath, "nested completeness is false");
      }
      if (
        childCoverageContext &&
        (key === "status" || key === "state" || key === "result") &&
        isIncompleteCoverageState(child)
      ) {
        throw coverageError(
          label,
          childPath,
          `nested state is ${String(child).slice(0, 80)}`,
        );
      }
      if (
        childCoverageContext &&
        (key === "warnings" || key === "reasons") &&
        hasNonEmptyCoverageSignal(child)
      ) {
        throw coverageError(label, childPath, "contains coverage warnings");
      }
      if (
        key === "limited_by_limit" &&
        isTrueCoverageValue(child)
      ) {
        throw coverageError(label, childPath, "coverage was limit-truncated");
      }

      visit(child, childPath, childCoverageContext);
    }
  };

  visit(value, "$", false);
}

async function validateManifestHash(
  manifest: JsonRecord,
  key: string,
  metrics: R2ReadMetrics,
): Promise<void> {
  const expected = requiredString(manifest, "manifest_hash", key)
    .toLowerCase();
  if (!SHA256_RE.test(expected)) {
    throw new Error(`${key}.manifest_hash must be a SHA-256 hex digest`);
  }
  const logical = { ...manifest };
  delete logical.manifest_hash;
  const actual = await sha256Hex(JSON.stringify(logical));
  if (actual !== expected) {
    throw new Error(
      `Manifest SHA-256 mismatch for ${key}: expected ${expected}, got ${actual}`,
    );
  }
  metrics.manifestHashesValidated += 1;
}

async function readJsonManifest(
  readObject: R2ObjectReader,
  key: string,
  metrics: R2ReadMetrics,
  cache?: Map<string, JsonRecord>,
): Promise<JsonRecord> {
  const cached = cache?.get(key);
  if (cached) return cached;
  const object = await readObject(key);
  metrics.objectCount += 1;
  metrics.bytesRead += object.bytes.byteLength;
  metrics.manifestKeys.push(key);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(object.bytes));
  } catch {
    throw new Error(`Invalid JSON manifest: ${key}`);
  }
  const manifest = asRecord(value, key);
  assertCompleteManifestCoverage(manifest, key);
  await validateManifestHash(manifest, key, metrics);
  cache?.set(key, manifest);
  return manifest;
}

function exactChild(
  parent: JsonRecord,
  collectionNames: string[],
  field: string,
  expected: string | number,
  label: string,
): JsonRecord {
  const values: unknown[] = [];
  for (const name of collectionNames) {
    if (Array.isArray(parent[name])) values.push(...parent[name] as unknown[]);
  }
  const matches = values
    .map((value, index) => asRecord(value, `${label}[${index}]`))
    .filter((entry) => String(entry[field]) === String(expected));
  const unique = new Map(
    matches.map((entry) => [String(entry.manifest_key || ""), entry]),
  );
  if (unique.size !== 1) {
    throw new Error(
      `${label} must contain exactly one ${field}=${expected} manifest reference`,
    );
  }
  return [...unique.values()][0];
}

function compareManifestReference(
  reference: JsonRecord,
  child: JsonRecord,
  childKey: string,
  label: string,
): void {
  if (requiredString(reference, "manifest_key", label) !== childKey) {
    throw new Error(`${label}.manifest_key does not match ${childKey}`);
  }
  const expectedHash = requiredString(reference, "manifest_hash", label)
    .toLowerCase();
  const actualHash = requiredString(child, "manifest_hash", childKey)
    .toLowerCase();
  if (expectedHash !== actualHash) {
    throw new Error(`${label}.manifest_hash does not match child manifest`);
  }
  for (const field of ["source_row_count", "row_count", "file_count"]) {
    if (
      requiredInteger(reference, field, label) !==
        requiredInteger(child, field, childKey)
    ) {
      throw new Error(`${label}.${field} does not match child manifest`);
    }
  }
}

function validateManifestIdentity(
  manifest: JsonRecord,
  key: string,
  dayUtc: string,
  connectorId?: number,
  pollutantCode?: string,
): void {
  if (requiredString(manifest, "history_version", key) !== "v2") {
    throw new Error(`${key}.history_version must be v2`);
  }
  if (requiredString(manifest, "day_utc", key) !== dayUtc) {
    throw new Error(`${key}.day_utc must be ${dayUtc}`);
  }
  if (
    connectorId !== undefined &&
    requiredInteger(manifest, "connector_id", key, 1) !== connectorId
  ) {
    throw new Error(`${key}.connector_id must be ${connectorId}`);
  }
  if (
    pollutantCode !== undefined &&
    requiredString(manifest, "pollutant_code", key).toLowerCase() !==
      pollutantCode
  ) {
    throw new Error(`${key}.pollutant_code must be ${pollutantCode}`);
  }
}

function validateColumns(
  manifest: JsonRecord,
  key: string,
): void {
  if (manifest.columns === null) {
    const physicalSchemas = asArray(
      manifest.physical_schemas,
      `${key}.physical_schemas`,
    );

    if (physicalSchemas.length < 2) {
      throw new Error(
        `${key}.columns is null but physical_schemas does not describe a mixed schema`,
      );
    }

    physicalSchemas.forEach((value, index) => {
      const schema = asRecord(
        value,
        `${key}.physical_schemas[${index}]`,
      );

      if (!hasSupportedObservationColumns(schema.columns)) {
        throw new Error(
          `${key}.physical_schemas[${index}].columns is not a supported canonical observation schema`,
        );
      }
    });

    return;
  }

  if (!hasSupportedObservationColumns(manifest.columns)) {
    throw new Error(
      `${key}.columns is not a supported canonical observation schema`,
    );
  }
}

function parseManifestFiles(
  manifest: JsonRecord,
  manifestKey: string,
  dayUtc: string,
  connectorId: number,
  pollutantCode: string,
): ManifestFile[] {
  const expectedPrefix =
    `${R2_OBSERVATION_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/`;
  const files = asArray(manifest.files, `${manifestKey}.files`).map(
    (value, index) => {
      const label = `${manifestKey}.files[${index}]`;
      const entry = asRecord(value, label);
      const key = requiredString(entry, "key", label);
      if (!key.startsWith(expectedPrefix) || !PART_FILE_RE.test(key)) {
        throw new Error(`${label}.key is outside the required partition`);
      }
      if (
        requiredString(entry, "pollutant_code", label).toLowerCase() !==
          pollutantCode
      ) {
        throw new Error(`${label}.pollutant_code mismatch`);
      }
      return {
        key,
        rowCount: requiredInteger(entry, "row_count", label),
        bytes: requiredInteger(entry, "bytes", label),
        etagOrHash: requiredString(entry, "etag_or_hash", label),
      };
    },
  );
  if (!files.length) throw new Error(`${manifestKey}.files must not be empty`);
  if (new Set(files.map((file) => file.key)).size !== files.length) {
    throw new Error(`${manifestKey}.files contains duplicate keys`);
  }
  if (
    requiredInteger(manifest, "file_count", manifestKey) !== files.length
  ) {
    throw new Error(`${manifestKey}.file_count does not match files`);
  }
  const rows = files.reduce((sum, file) => sum + file.rowCount, 0);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (requiredInteger(manifest, "row_count", manifestKey) !== rows) {
    throw new Error(`${manifestKey}.row_count does not match files`);
  }
  if (
    requiredInteger(manifest, "source_row_count", manifestKey) !== rows
  ) {
    throw new Error(`${manifestKey}.source_row_count does not match files`);
  }
  if (requiredInteger(manifest, "total_bytes", manifestKey) !== bytes) {
    throw new Error(`${manifestKey}.total_bytes does not match files`);
  }
  return files;
}

export function validateParquetHash(
  object: R2ReadResult,
  file: ManifestFile,
): void {
  if (object.bytes.byteLength !== file.bytes) {
    throw new Error(
      `Parquet byte count mismatch for ${file.key}: expected ${file.bytes}, got ${object.bytes.byteLength}`,
    );
  }
  const expected = normalizeHash(file.etagOrHash);
  let actual: string;
  if (MD5_RE.test(expected)) {
    actual = md5Hex(object.bytes);
  } else if (SHA256_RE.test(expected)) {
    actual = createHash("sha256").update(object.bytes).digest("hex");
  } else {
    throw new Error(
      `Unsupported parquet etag_or_hash format for ${file.key}`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      `Parquet hash mismatch for ${file.key}: expected ${expected}, got ${actual}`,
    );
  }
}

function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

async function readParquetRows(
  object: R2ReadResult,
  file: ManifestFile,
  dayUtc: string,
  connectorId: number,
  pollutantCode: string,
  metrics: R2ReadMetrics,
): Promise<R2ObservationRow[]> {
  validateParquetHash(object, file);
  metrics.parquetHashesValidated += 1;
  const arrayBuffer = bytesToArrayBuffer(object.bytes);
  const metadata = await parquetMetadataAsync(arrayBuffer);
  const columns = parquetSchema(metadata).children.map((column) =>
    column.element.name
  );
  if (!hasSupportedObservationColumns(columns)) {
    throw new Error(
      `Parquet schema mismatch for ${file.key}: ${columns.join(",")}`,
    );
  }

  let rawRows: unknown[][] = [];
  await parquetRead({
    file: arrayBuffer,
    metadata,
    columns: [...R2_OBSERVATION_COLUMNS],
    compressors,
    onComplete: (rows) => {
      rawRows = Array.isArray(rows) ? rows as unknown[][] : [];
    },
  });
  if (rawRows.length !== file.rowCount) {
    throw new Error(
      `Parquet row count mismatch for ${file.key}: expected ${file.rowCount}, got ${rawRows.length}`,
    );
  }
  metrics.parquetRowCount += rawRows.length;
  const positions = new Map(columns.map((column, index) => [column, index]));
  return rawRows.map((row, index) => {
    const rowConnector = Number(row[positions.get("connector_id")!]);
    const station = row[positions.get("station_id")!];
    const timeseries = Number(row[positions.get("timeseries_id")!]);
    const rowPollutant = String(row[positions.get("pollutant_code")!] || "")
      .toLowerCase();
    const observedAt = normalizeTimestamp(
      row[positions.get("observed_at_utc")!],
    );
    const partitionStart = Date.parse(`${dayUtc}T00:00:00.000Z`);
    const partitionEnd = partitionStart + 24 * 60 * 60 * 1000;
    const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
    const rawValue = row[positions.get("value")!];
    const stationId = station === null || station === undefined
      ? null
      : Number(station);
    if (
      !Number.isSafeInteger(rowConnector) ||
      rowConnector !== connectorId ||
      (
        stationId !== null &&
        (!Number.isSafeInteger(stationId) || stationId <= 0)
      ) ||
      !Number.isSafeInteger(timeseries) ||
      timeseries <= 0 ||
      rowPollutant !== pollutantCode ||
      !observedAt ||
      observedMs < partitionStart ||
      observedMs >= partitionEnd
    ) {
      throw new Error(`Invalid identity/timestamp in ${file.key} row ${index}`);
    }
    const numericValue = rawValue === null || rawValue === undefined
      ? null
      : Number(rawValue);
    return {
      connectorId: rowConnector,
      stationId,
      timeseriesId: timeseries,
      pollutantCode: rowPollutant,
      observedAtUtc: observedAt,
      value: numericValue !== null && Number.isFinite(numericValue)
        ? numericValue
        : null,
    };
  });
}

export async function readValidatedObservationPollutantPartition(args: {
  readObject: R2ObjectReader;
  dayUtc: string;
  connectorId: number;
  pollutantCode: string;
  metrics?: R2ReadMetrics;
  manifestCache?: Map<string, JsonRecord>;
}): Promise<R2ObservationRow[]> {
  assertIsoDay(args.dayUtc, "dayUtc");
  const pollutantCode = args.pollutantCode.trim().toLowerCase();
  if (!["pm25", "pm10", "no2"].includes(pollutantCode)) {
    throw new Error(`Unsupported WHO pollutant: ${pollutantCode}`);
  }
  const metrics = args.metrics || createR2ReadMetrics();
  const dayKey =
    `${R2_OBSERVATION_PREFIX}/day_utc=${args.dayUtc}/manifest.json`;
  const dayManifest = await readJsonManifest(
    args.readObject,
    dayKey,
    metrics,
    args.manifestCache,
  );
  validateManifestIdentity(dayManifest, dayKey, args.dayUtc);
  validateColumns(dayManifest, dayKey);

  const connectorReference = exactChild(
    dayManifest,
    ["connector_manifests", "child_manifests"],
    "connector_id",
    args.connectorId,
    `${dayKey}.connector_manifests`,
  );
  const connectorKey =
    `${R2_OBSERVATION_PREFIX}/day_utc=${args.dayUtc}/connector_id=${args.connectorId}/manifest.json`;
  const connectorManifest = await readJsonManifest(
    args.readObject,
    connectorKey,
    metrics,
    args.manifestCache,
  );
  validateManifestIdentity(
    connectorManifest,
    connectorKey,
    args.dayUtc,
    args.connectorId,
  );
  validateColumns(connectorManifest, connectorKey);
  compareManifestReference(
    connectorReference,
    connectorManifest,
    connectorKey,
    `${dayKey}.connector_id=${args.connectorId}`,
  );

  const pollutantReference = exactChild(
    connectorManifest,
    ["child_manifests", "pollutant_manifests"],
    "pollutant_code",
    pollutantCode,
    `${connectorKey}.child_manifests`,
  );
  const pollutantKey =
    `${R2_OBSERVATION_PREFIX}/day_utc=${args.dayUtc}/connector_id=${args.connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
  const pollutantManifest = await readJsonManifest(
    args.readObject,
    pollutantKey,
    metrics,
    args.manifestCache,
  );
  validateManifestIdentity(
    pollutantManifest,
    pollutantKey,
    args.dayUtc,
    args.connectorId,
    pollutantCode,
  );
  validateColumns(pollutantManifest, pollutantKey);
  compareManifestReference(
    pollutantReference,
    pollutantManifest,
    pollutantKey,
    `${connectorKey}.pollutant_code=${pollutantCode}`,
  );
  const files = parseManifestFiles(
    pollutantManifest,
    pollutantKey,
    args.dayUtc,
    args.connectorId,
    pollutantCode,
  );
  const rows: R2ObservationRow[] = [];
  for (const file of files) {
    const object = await args.readObject(file.key);
    metrics.objectCount += 1;
    metrics.bytesRead += object.bytes.byteLength;
    rows.push(
      ...await readParquetRows(
        object,
        file,
        args.dayUtc,
        args.connectorId,
        pollutantCode,
        metrics,
      ),
    );
  }
  return rows;
}

function aggregatePollutantRows(args: {
  dayUtc: string;
  pollutantCode: string;
  rows: R2ObservationRow[];
  minValidHoursPerDay: number;
}): PreparedDailyRow[] {
  const startMs = Date.parse(`${args.dayUtc}T00:00:00.000Z`);
  const endMs = startMs + 24 * 60 * 60 * 1000;
  const hourly = new Map<number, Map<number, { sum: number; count: number }>>();
  for (const row of args.rows) {
    const observedMs = Date.parse(row.observedAtUtc);
    if (
      !Number.isFinite(observedMs) ||
      observedMs <= startMs ||
      observedMs > endMs ||
      row.pollutantCode !== args.pollutantCode
    ) {
      continue;
    }
    let timeseriesHours = hourly.get(row.timeseriesId);
    if (!timeseriesHours) {
      timeseriesHours = new Map();
      hourly.set(row.timeseriesId, timeseriesHours);
    }
    if (
      row.value === null ||
      !Number.isFinite(row.value) ||
      row.value < 0
    ) {
      continue;
    }
    const hourMs = Math.floor(observedMs / (60 * 60 * 1000)) *
      (60 * 60 * 1000);
    const bucket = timeseriesHours.get(hourMs) || { sum: 0, count: 0 };
    bucket.sum += row.value;
    bucket.count += 1;
    timeseriesHours.set(hourMs, bucket);
  }
  return [...hourly.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timeseriesId, hours]) => {
      const hourlyMeans = [...hours.values()].map((hour) =>
        hour.sum / hour.count
      );
      const validHourCount = hourlyMeans.length;
      return {
        timeseries_id: timeseriesId,
        valid_hour_count: validHourCount,
        daily_mean_ugm3: validHourCount >= args.minValidHoursPerDay
          ? hourlyMeans.reduce((sum, value) => sum + value, 0) /
            validHourCount
          : null,
      };
    });
}

export async function prepareWhoDailyRowsFromR2(args: {
  readObject: R2ObjectReader;
  dayUtc: string;
  connectorId: number;
  pollutantCodes: string[];
  minValidHoursPerDay: number;
}): Promise<R2PreparedDay> {
  assertIsoDay(args.dayUtc, "dayUtc");
  if (
    !Number.isInteger(args.minValidHoursPerDay) ||
    args.minValidHoursPerDay < 1 ||
    args.minValidHoursPerDay > 24
  ) {
    throw new Error("minValidHoursPerDay must be between 1 and 24");
  }
  const pollutants = [
    ...new Set(
      args.pollutantCodes.map((code) => code.trim().toLowerCase()),
    ),
  ];
  const requiredPollutants = ["pm25", "pm10", "no2"];
  if (
    pollutants.length !== requiredPollutants.length ||
    requiredPollutants.some((code) => !pollutants.includes(code))
  ) {
    throw new Error(
      "R2 WHO processing requires exactly pm25, pm10 and no2",
    );
  }
  const metrics = createR2ReadMetrics();
  const preparedRows: PreparedDailyRow[] = [];
  const seenTimeseries = new Set<number>();
  const boundaryDay = addDays(args.dayUtc, 1);
  const manifestCache = new Map<string, JsonRecord>();

  try {
    for (const pollutantCode of pollutants) {
      let dayRows: R2ObservationRow[];
      try {
        dayRows = await readValidatedObservationPollutantPartition({
          readObject: args.readObject,
          dayUtc: args.dayUtc,
          connectorId: args.connectorId,
          pollutantCode,
          metrics,
          manifestCache,
        });
      } catch (error) {
        throw new Error(
          `WHO source partition ${args.dayUtc} missing or incomplete for ${pollutantCode}: ${
            String(error instanceof Error ? error.message : error).slice(0, 320)
          }`,
        );
      }
      let boundaryRows: R2ObservationRow[];
      try {
        boundaryRows = await readValidatedObservationPollutantPartition({
          readObject: args.readObject,
          dayUtc: boundaryDay,
          connectorId: args.connectorId,
          pollutantCode,
          metrics,
          manifestCache,
        });
      } catch (error) {
        throw new Error(
          `WHO D+1 boundary partition ${boundaryDay} missing or incomplete for ${pollutantCode}: ${
            String(error instanceof Error ? error.message : error).slice(0, 320)
          }`,
        );
      }
      const pollutantPrepared = aggregatePollutantRows({
        dayUtc: args.dayUtc,
        pollutantCode,
        rows: [...dayRows, ...boundaryRows],
        minValidHoursPerDay: args.minValidHoursPerDay,
      });
      for (const row of pollutantPrepared) {
        if (seenTimeseries.has(row.timeseries_id)) {
          throw new Error(
            `Contradictory prepared rows for timeseries_id ${row.timeseries_id}`,
          );
        }
        seenTimeseries.add(row.timeseries_id);
        preparedRows.push(row);
      }
    }
  } catch (error) {
    throw new R2ObservationReadError(
      error instanceof Error ? error.message : String(error),
      {
        ...metrics,
        manifestKeys: [...new Set(metrics.manifestKeys)],
      },
    );
  }

  preparedRows.sort((left, right) => left.timeseries_id - right.timeseries_id);
  if (preparedRows.length > 2000) {
    throw new Error(
      `Prepared row payload has ${preparedRows.length} rows; max 2000`,
    );
  }
  return {
    dayUtc: args.dayUtc,
    preparedRows,
    validPreparedRows:
      preparedRows.filter((row) => row.daily_mean_ugm3 !== null).length,
    insufficientPreparedRows:
      preparedRows.filter((row) => row.daily_mean_ugm3 === null).length,
    metrics: {
      ...metrics,
      manifestKeys: [...new Set(metrics.manifestKeys)],
    },
  };
}
