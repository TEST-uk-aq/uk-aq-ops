// @ts-nocheck -- canonical runtime module is consumed by both Node and Deno TypeScript.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";

import { sha256Hex } from "./r2_sigv4.mjs";
import {
  combineObservationHistoryPhysicalSchemas,
  OBSERVATION_HISTORY_COLUMNS_V3,
  observationHistoryPhysicalSchemaForColumns,
  observationHistoryPhysicalSchemasFromManifest,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "./uk_aq_observation_history_schema.mjs";
export { validateCanonicalHistoryV2Manifest } from "./uk_aq_r2_history_manifest_validation.mjs";

const AQI_DATA_COLUMNS = Object.freeze([
  "connector_id", "station_id", "timeseries_id", "pollutant_code", "timestamp_hour_utc",
  "daqi_index_level", "eaqi_index_level", "daqi_calculation_status", "daqi_missing_reason",
  "eaqi_calculation_status", "eaqi_missing_reason",
]);
const AQI_DEBUG_COLUMNS = Object.freeze([
  "connector_id", "station_id", "timeseries_id", "pollutant_code", "timestamp_hour_utc",
  "daqi_input_value_ugm3", "daqi_input_averaging_code", "daqi_index_level",
  "daqi_source_observation_count", "daqi_required_observation_count", "daqi_calculation_status",
  "daqi_missing_reason", "eaqi_input_value_ugm3", "eaqi_input_averaging_code", "eaqi_index_level",
  "eaqi_source_observation_count", "eaqi_required_observation_count", "eaqi_calculation_status",
  "eaqi_missing_reason", "hourly_sample_count", "algorithm_version", "computed_at_utc",
]);
const AQI_SCHEMA_VERSION = 2;
const OBSERVATION_MANIFEST_SCHEMA_VERSION = 3;
const AQI_WRITER_VERSION = "parquet-wasm-zstd-v2";
const DEFAULT_OBSERVATION_ROW_GROUP_SIZE = 50_000;
const DEFAULT_AQI_ROW_GROUP_SIZE = 100_000;
let parquetWasmInitialized = false;
const writerPropertiesCache = new Map();

function normalizePrefix(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function normalizePollutant(value) {
  const pollutant = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(pollutant)) throw new Error(`Invalid pollutant_code for R2 path: ${String(value || "")}`);
  return pollutant;
}

function normalizeDay(value) {
  const day = String(value || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid canonical history UTC day: ${String(value || "")}`);
  }
  return day;
}

export function buildHistoryV2ConnectorManifestKey(basePrefix, dayUtc, connectorId) {
  return `${normalizePrefix(basePrefix)}/day_utc=${normalizeDay(dayUtc)}/connector_id=${Number(connectorId)}/manifest.json`;
}

export function buildHistoryV2PollutantManifestKey(basePrefix, dayUtc, connectorId, pollutantCode) {
  return buildHistoryV2ConnectorManifestKey(basePrefix, dayUtc, connectorId)
    .replace(/\/manifest\.json$/, `/pollutant_code=${normalizePollutant(pollutantCode)}/manifest.json`);
}

export function buildHistoryV2PartKey(basePrefix, dayUtc, connectorId, pollutantCode, partIndex) {
  return buildHistoryV2PollutantManifestKey(basePrefix, dayUtc, connectorId, pollutantCode)
    .replace(/\/manifest\.json$/, `/part-${String(Number(partIndex)).padStart(5, "0")}.parquet`);
}

export function buildHistoryV2DayManifestKey(basePrefix, dayUtc) {
  return `${normalizePrefix(basePrefix)}/day_utc=${normalizeDay(dayUtc)}/manifest.json`;
}

function ensureParquetWasmInitialized() {
  if (parquetWasmInitialized) return;
  const wasmPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm");
  parquetWasm.initSync({ module: fs.readFileSync(wasmPath) });
  parquetWasmInitialized = true;
}

function writerProperties(rowGroupSize, createdBy) {
  const size = Number(rowGroupSize);
  const key = `${size}:${createdBy}`;
  if (writerPropertiesCache.has(key)) return writerPropertiesCache.get(key);
  ensureParquetWasmInitialized();
  const properties = new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.ZSTD)
    .setMaxRowGroupSize(size)
    .setCreatedBy(createdBy)
    .build();
  writerPropertiesCache.set(key, properties);
  return properties;
}

function writeParquet(table, properties, alreadyInitialized = false) {
  if (!alreadyInitialized) ensureParquetWasmInitialized();
  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  return Buffer.from(parquetWasm.writeParquet(wasmTable, properties));
}

const int32Vector = (values) => arrow.vectorFromArray(values, new arrow.Int32());
const float64Vector = (values) => arrow.vectorFromArray(values, new arrow.Float64());
const textVector = (values) => arrow.vectorFromArray(values, new arrow.Utf8());
const timestampVector = (values) => arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
const nullableNumber = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
const nullableInteger = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.trunc(Number(value));
const nullableText = (value) => value === null || value === undefined || String(value).trim() === "" ? null : String(value);

export function serializeCanonicalObservationV2Parquet(rows, {
  rowGroupSize = DEFAULT_OBSERVATION_ROW_GROUP_SIZE,
  includeVerificationStatus = true,
  writerProperties: providedProperties = null,
} = {}) {
  const columns = {
    connector_id: int32Vector(rows.map((row) => Number(row.connector_id))),
    station_id: int32Vector(rows.map((row) => row.station_id == null ? null : Number(row.station_id))),
    timeseries_id: int32Vector(rows.map((row) => Number(row.timeseries_id))),
    pollutant_code: textVector(rows.map((row) => String(row.pollutant_code || ""))),
    observed_at_utc: timestampVector(rows.map((row) => new Date(row.observed_at_utc || row.observed_at))),
    value: rows.map((row) => nullableNumber(row.value)),
    ...(includeVerificationStatus ? { verification_status: textVector(rows.map((row) => row.verification_status ?? null)) } : {}),
  };
  return writeParquet(
    arrow.tableFromArrays(columns),
    providedProperties || writerProperties(rowGroupSize, includeVerificationStatus ? OBSERVATION_HISTORY_WRITER_VERSION_V3 : AQI_WRITER_VERSION),
    Boolean(providedProperties),
  );
}

export function serializeCanonicalAqilevelDataV2Parquet(rows, { rowGroupSize = DEFAULT_AQI_ROW_GROUP_SIZE, writerProperties: providedProperties = null } = {}) {
  return writeParquet(arrow.tableFromArrays({
    connector_id: int32Vector(rows.map((row) => Number(row.connector_id))),
    station_id: int32Vector(rows.map((row) => row.station_id == null ? null : Number(row.station_id))),
    timeseries_id: int32Vector(rows.map((row) => Number(row.timeseries_id))),
    pollutant_code: textVector(rows.map((row) => String(row.pollutant_code || ""))),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_index_level: int32Vector(rows.map((row) => nullableInteger(row.daqi_index_level))),
    eaqi_index_level: int32Vector(rows.map((row) => nullableInteger(row.eaqi_index_level))),
    daqi_calculation_status: textVector(rows.map((row) => nullableText(row.daqi_calculation_status))),
    daqi_missing_reason: textVector(rows.map((row) => nullableText(row.daqi_missing_reason))),
    eaqi_calculation_status: textVector(rows.map((row) => nullableText(row.eaqi_calculation_status))),
    eaqi_missing_reason: textVector(rows.map((row) => nullableText(row.eaqi_missing_reason))),
  }), providedProperties || writerProperties(rowGroupSize, AQI_WRITER_VERSION), Boolean(providedProperties));
}

export function serializeCanonicalAqilevelDebugV2Parquet(rows, { rowGroupSize = DEFAULT_AQI_ROW_GROUP_SIZE, writerProperties: providedProperties = null } = {}) {
  return writeParquet(arrow.tableFromArrays({
    connector_id: int32Vector(rows.map((row) => Number(row.connector_id))),
    station_id: int32Vector(rows.map((row) => row.station_id == null ? null : Number(row.station_id))),
    timeseries_id: int32Vector(rows.map((row) => Number(row.timeseries_id))),
    pollutant_code: textVector(rows.map((row) => String(row.pollutant_code || ""))),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_input_value_ugm3: float64Vector(rows.map((row) => nullableNumber(row.daqi_input_value_ugm3))),
    daqi_input_averaging_code: textVector(rows.map((row) => nullableText(row.daqi_input_averaging_code))),
    daqi_index_level: int32Vector(rows.map((row) => nullableInteger(row.daqi_index_level))),
    daqi_source_observation_count: int32Vector(rows.map((row) => nullableInteger(row.daqi_source_observation_count))),
    daqi_required_observation_count: int32Vector(rows.map((row) => nullableInteger(row.daqi_required_observation_count))),
    daqi_calculation_status: textVector(rows.map((row) => nullableText(row.daqi_calculation_status))),
    daqi_missing_reason: textVector(rows.map((row) => nullableText(row.daqi_missing_reason))),
    eaqi_input_value_ugm3: float64Vector(rows.map((row) => nullableNumber(row.eaqi_input_value_ugm3))),
    eaqi_input_averaging_code: textVector(rows.map((row) => nullableText(row.eaqi_input_averaging_code))),
    eaqi_index_level: int32Vector(rows.map((row) => nullableInteger(row.eaqi_index_level))),
    eaqi_source_observation_count: int32Vector(rows.map((row) => nullableInteger(row.eaqi_source_observation_count))),
    eaqi_required_observation_count: int32Vector(rows.map((row) => nullableInteger(row.eaqi_required_observation_count))),
    eaqi_calculation_status: textVector(rows.map((row) => nullableText(row.eaqi_calculation_status))),
    eaqi_missing_reason: textVector(rows.map((row) => nullableText(row.eaqi_missing_reason))),
    hourly_sample_count: int32Vector(rows.map((row) => nullableInteger(row.hourly_sample_count))),
    algorithm_version: textVector(rows.map((row) => nullableText(row.algorithm_version))),
    computed_at_utc: timestampVector(rows.map((row) => row.computed_at_utc ? new Date(row.computed_at_utc) : null)),
  }), providedProperties || writerProperties(rowGroupSize, AQI_WRITER_VERSION), Boolean(providedProperties));
}

function minIso(left, right) { return !left ? right || null : !right ? left : left <= right ? left : right; }
function maxIso(left, right) { return !left ? right || null : !right ? left : left >= right ? left : right; }
function minValue(entries, field) { return entries.reduce((value, entry) => minIso(value, entry?.[field] || null), null); }
function maxValue(entries, field) { return entries.reduce((value, entry) => maxIso(value, entry?.[field] || null), null); }
function numericValue(entries, field, operation) {
  return entries.reduce((value, entry) => {
    const number = Number(entry?.[field]);
    if (!Number.isFinite(number) || number <= 0) return value;
    const normalized = Math.trunc(number);
    return value === null ? normalized : operation(value, normalized);
  }, null);
}
function uniqueSorted(values) { return Array.from(new Set(values)).sort(); }
function aggregateTimeseriesRowCounts(entries) {
  const result = {};
  let present = false;
  for (const entry of entries) {
    if (!entry?.timeseries_row_counts || typeof entry.timeseries_row_counts !== "object") continue;
    present = true;
    for (const [key, raw] of Object.entries(entry.timeseries_row_counts)) {
      const count = Number(raw);
      if (Number.isFinite(count) && count > 0) result[key] = (result[key] || 0) + Math.trunc(count);
    }
  }
  return present ? result : null;
}
function stats(files, rows) {
  if (!files.length) return { bytes_per_row_estimate: rows > 0 ? null : 0, avg_file_bytes: 0, min_file_bytes: 0, max_file_bytes: 0 };
  const sizes = files.map((file) => Number(file.bytes || 0));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return { bytes_per_row_estimate: rows > 0 ? total / rows : null, avg_file_bytes: total / sizes.length, min_file_bytes: Math.min(...sizes), max_file_bytes: Math.max(...sizes) };
}
function withHash(payload) { return { ...payload, manifest_hash: sha256Hex(JSON.stringify(payload)) }; }
function columnsFor(domain, profile) {
  if (domain === "observations") return OBSERVATION_HISTORY_COLUMNS_V3;
  if (domain === "aqilevels" && profile === "data") return AQI_DATA_COLUMNS;
  if (domain === "aqilevels" && profile === "debug") return AQI_DEBUG_COLUMNS;
  throw new Error(`Unsupported R2 history v2 schema: domain=${String(domain)} profile=${String(profile)}`);
}
function defaultPhysicalSchema(domain, profile) {
  return domain === "observations"
    ? observationHistoryPhysicalSchemaForColumns(OBSERVATION_HISTORY_COLUMNS_V3)
    : { history_schema_version: AQI_SCHEMA_VERSION, columns: [...columnsFor(domain, profile)], writer_version: AQI_WRITER_VERSION };
}
function physicalFields(schema) {
  return { history_schema_version: schema.history_schema_version, columns: schema.columns === null ? null : [...schema.columns], writer_version: schema.writer_version,
    ...(Array.isArray(schema.physical_schemas) ? { physical_schemas: schema.physical_schemas.map((entry) => ({ ...entry, columns: [...entry.columns] })) } : {}) };
}
function childPhysicalSchema(manifests, domain, profile) {
  return domain === "observations" ? combineObservationHistoryPhysicalSchemas(manifests.flatMap(observationHistoryPhysicalSchemasFromManifest)) : defaultPhysicalSchema(domain, profile);
}

/** @param {any} args */
export function buildHistoryV2PollutantManifest(args) {
  const { domain, grain = null, profile = null, dayUtc, connectorId, pollutantCode, runId = null, manifestKey, sourceRowCount, fileEntries, writerGitSha, backedUpAtUtc, observationContentHash = null, physicalSchema = null } = args;
  const pollutant = normalizePollutant(pollutantCode);
  const files = [...(fileEntries || [])].sort((a, b) => String(a?.key || "").localeCompare(String(b?.key || ""))).map((entry) => ({ ...entry, pollutant_code: pollutant }));
  if (domain === "observations" && (!observationContentHash || Number(observationContentHash.observation_content_hash_row_count) !== Number(sourceRowCount))) {
    throw new Error(`Observation content hash row count mismatch for day=${dayUtc} connector=${connectorId} pollutant=${pollutant}`);
  }
  const schemas = domain === "observations" ? observationHistoryPhysicalSchemasFromManifest(physicalSchema || defaultPhysicalSchema(domain, profile)) : [defaultPhysicalSchema(domain, profile)];
  if (schemas.length !== 1) throw new Error("A pollutant manifest must describe one physical Parquet schema");
  const schema = physicalFields(schemas[0]);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const rows = Number(sourceRowCount);
  return withHash({ manifest_schema_version: domain === "observations" ? OBSERVATION_MANIFEST_SCHEMA_VERSION : AQI_SCHEMA_VERSION,
    history_schema_version: schema.history_schema_version, history_version: "v2", manifest_kind: "pollutant", domain, grain, profile,
    day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutant, pollutant_codes: [pollutant], run_id: runId, manifest_key: manifestKey,
    source_row_count: rows, row_count: rows, min_timeseries_id: numericValue(files, "min_timeseries_id", Math.min), max_timeseries_id: numericValue(files, "max_timeseries_id", Math.max),
    min_observed_at_utc: minValue(files, "min_observed_at_utc") || minValue(files, "min_observed_at"), max_observed_at_utc: maxValue(files, "max_observed_at_utc") || maxValue(files, "max_observed_at"),
    min_timestamp_hour_utc: minValue(files, "min_timestamp_hour_utc"), max_timestamp_hour_utc: maxValue(files, "max_timestamp_hour_utc"),
    parquet_object_keys: uniqueSorted(files.map((file) => file.key)), file_count: files.length, total_bytes: totalBytes, files, child_manifests: [],
    columns: schema.columns, writer_version: schema.writer_version, ...(schema.physical_schemas ? { physical_schemas: schema.physical_schemas } : {}), writer_git_sha: writerGitSha,
    timeseries_row_counts: aggregateTimeseriesRowCounts(files), ...stats(files, rows), ...(domain === "observations" ? observationContentHash : {}), backed_up_at_utc: backedUpAtUtc });
}

function buildParentManifest({ kind, domain, grain, profile, dayUtc, connectorId, runId, manifestKey, manifests, writerGitSha, backedUpAtUtc }) {
  const sorted = [...(manifests || [])].sort((a, b) => {
    if (kind === "connector") {
      const byPollutant = String(a?.pollutant_code || "").localeCompare(String(b?.pollutant_code || ""));
      return byPollutant || String(a?.manifest_key || "").localeCompare(String(b?.manifest_key || ""));
    }
    const byConnector = Number(a?.connector_id) - Number(b?.connector_id);
    return byConnector || String(a?.manifest_key || "").localeCompare(String(b?.manifest_key || ""));
  });
  const files = sorted.flatMap((manifest) => Array.isArray(manifest.files) ? manifest.files : []);
  const rows = sorted.reduce((sum, manifest) => sum + Number(manifest.source_row_count || 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const schema = physicalFields(childPhysicalSchema(sorted, domain, profile));
  const children = sorted.map((manifest) => kind === "connector"
    ? { pollutant_code: manifest.pollutant_code, manifest_key: manifest.manifest_key, manifest_hash: manifest.manifest_hash, source_row_count: manifest.source_row_count, row_count: manifest.row_count, file_count: manifest.file_count, total_bytes: manifest.total_bytes, min_timeseries_id: manifest.min_timeseries_id ?? null, max_timeseries_id: manifest.max_timeseries_id ?? null, min_observed_at_utc: manifest.min_observed_at_utc ?? null, max_observed_at_utc: manifest.max_observed_at_utc ?? null, min_timestamp_hour_utc: manifest.min_timestamp_hour_utc ?? null, max_timestamp_hour_utc: manifest.max_timestamp_hour_utc ?? null }
    : { connector_id: manifest.connector_id, manifest_key: manifest.manifest_key, manifest_hash: manifest.manifest_hash, source_row_count: manifest.source_row_count, row_count: manifest.row_count, file_count: manifest.file_count, total_bytes: manifest.total_bytes, pollutant_codes: Array.isArray(manifest.pollutant_codes) ? manifest.pollutant_codes : [], min_timeseries_id: manifest.min_timeseries_id ?? null, max_timeseries_id: manifest.max_timeseries_id ?? null, min_observed_at_utc: manifest.min_observed_at_utc ?? null, max_observed_at_utc: manifest.max_observed_at_utc ?? null, min_timestamp_hour_utc: manifest.min_timestamp_hour_utc ?? null, max_timestamp_hour_utc: manifest.max_timestamp_hour_utc ?? null });
  const pollutantCodes = uniqueSorted(sorted.flatMap((manifest) => kind === "connector" ? [manifest.pollutant_code] : (manifest.pollutant_codes || [])).filter(Boolean));
  return withHash({ manifest_schema_version: domain === "observations" ? OBSERVATION_MANIFEST_SCHEMA_VERSION : AQI_SCHEMA_VERSION,
    history_schema_version: schema.history_schema_version, history_version: "v2", manifest_kind: kind, domain, grain, profile, day_utc: dayUtc,
    connector_id: kind === "connector" ? connectorId : null, ...(kind === "day" ? { connector_ids: sorted.map((manifest) => Number(manifest.connector_id)).filter(Number.isInteger) } : {}),
    pollutant_code: null, pollutant_codes: pollutantCodes, run_id: runId, manifest_key: manifestKey, source_row_count: rows, row_count: rows,
    min_timeseries_id: numericValue(sorted, "min_timeseries_id", Math.min), max_timeseries_id: numericValue(sorted, "max_timeseries_id", Math.max),
    min_observed_at_utc: minValue(sorted, "min_observed_at_utc"), max_observed_at_utc: maxValue(sorted, "max_observed_at_utc"), min_timestamp_hour_utc: minValue(sorted, "min_timestamp_hour_utc"), max_timestamp_hour_utc: maxValue(sorted, "max_timestamp_hour_utc"),
    parquet_object_keys: uniqueSorted(files.map((file) => file.key)), file_count: files.length, total_bytes: totalBytes, files, child_manifests: children,
    ...(kind === "connector" ? { pollutant_manifests: children } : { connector_manifests: children }), columns: schema.columns, writer_version: schema.writer_version,
    ...(schema.physical_schemas ? { physical_schemas: schema.physical_schemas } : {}), writer_git_sha: writerGitSha,
    ...(kind === "connector" ? { timeseries_row_counts: aggregateTimeseriesRowCounts(sorted) } : {}), ...stats(files, rows), backed_up_at_utc: backedUpAtUtc });
}

/** @param {any} args */
export function buildHistoryV2ConnectorManifest(args) {
  const { domain, grain = null, profile = null, dayUtc, connectorId, runId = null, manifestKey, pollutantManifests, writerGitSha, backedUpAtUtc } = args;
  return buildParentManifest({ kind: "connector", domain, grain, profile, dayUtc, connectorId, runId, manifestKey, manifests: pollutantManifests, writerGitSha, backedUpAtUtc });
}

/** @param {any} args */
export function buildHistoryV2DayManifest(args) {
  const { domain, grain = null, profile = null, dayUtc, runId = null, manifestKey, connectorManifests, writerGitSha, backedUpAtUtc } = args;
  return buildParentManifest({ kind: "day", domain, grain, profile, dayUtc, connectorId: null, runId, manifestKey, manifests: connectorManifests, writerGitSha, backedUpAtUtc });
}
