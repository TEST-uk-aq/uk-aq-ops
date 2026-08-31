// @ts-nocheck -- isolated v3-only exact reader for Worker and local fixtures.
import {
  parquetMetadata,
  parquetReadObjects,
  parquetSchema,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";

import {
  OBSERVATION_HISTORY_COLUMNS_V3,
  OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "./uk_aq_observation_history_schema.mjs";
import { normalizeObservationPropertyCode } from "./uk_aq_observation_property_code.mjs";
import {
  coalesceObservationHistoryV3ByteRanges,
  createObservationHistoryV3RangeBudget,
  createPrefetchedObservationHistoryV3AsyncBuffer,
  readObservationHistoryV3ByteRanges,
  sha256ObservationHistoryV3Bytes,
} from "./uk_aq_observation_history_random_access_v3.mjs";
import {
  validateObservationHistoryIndexV3ScopedManifestBody,
} from "./uk_aq_observation_history_scoped_manifest_v3.mjs";

export const OBSERVATION_HISTORY_V3_INDEX_GENERATION = "v3";
export const OBSERVATION_HISTORY_V3_LOGICAL_HISTORY_VERSION = "v2";
export const OBSERVATION_HISTORY_V3_PHYSICAL_LAYOUT_VERSION =
  "timeseries-bounded-v1";
export const OBSERVATION_HISTORY_V3_SHARD_WIDTH = 1000;
export const OBSERVATION_HISTORY_V3_INDEX_ROOT =
  "history/_index_v3/observations_timeseries";
export const OBSERVATION_HISTORY_V3_RESPONSE_CACHE_GENERATION = "3";
export const OBSERVATION_HISTORY_V3_FOOTER_CACHE_GENERATION =
  "observation-parquet-footer-v3-1";
export const OBSERVATION_HISTORY_V3_STATION_STALE_CACHE_GENERATION =
  "station-history-stale-v2";

export const OBSERVATION_HISTORY_V3_PROJECTED_COLUMNS = Object.freeze([
  "timeseries_id",
  "observed_at_utc",
  "value",
]);

// Conservative structural defaults. Real TEST operation owns later tuning.
export const DEFAULT_OBSERVATION_HISTORY_V3_READ_LIMITS = Object.freeze({
  max_index_objects: 256,
  max_index_object_bytes: 2 * 1024 * 1024,
  max_total_index_bytes: 8 * 1024 * 1024,
  max_distinct_files: 32,
  max_selected_segments: 256,
  max_selected_row_groups: 256,
  max_footer_reads: 64,
  max_footer_bytes: 2 * 1024 * 1024,
  max_total_range_reads: 512,
  max_total_bytes_requested: 32 * 1024 * 1024,
  max_decoded_rows: 100000,
  max_response_rows: 20000,
  max_concurrency: 4,
  coalesce_max_gap_bytes: 4096,
  coalesce_max_merged_bytes: 2 * 1024 * 1024,
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXPECTED_CREATED_BY = [
  `writer_version=${OBSERVATION_HISTORY_WRITER_VERSION_V3}`,
  `history_schema_version=${OBSERVATION_HISTORY_SCHEMA_VERSION_V3}`,
  `physical_layout_version=${OBSERVATION_HISTORY_V3_PHYSICAL_LAYOUT_VERSION}`,
].join(";");
const PAGE_SELECTION_UNAVAILABLE_REASON =
  "hyparquet-1.25.1-offset-index-dictionary-decode-unsafe";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function bytewiseCompare(left, right) {
  const leftBytes = textEncoder.encode(String(left));
  const rightBytes = textEncoder.encode(String(right));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort(bytewiseCompare)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function positiveSafeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return number;
}

function nonNegativeSafeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return number;
}

function safeMetadataInteger(value, fieldName, { allowZero = false } = {}) {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    (allowZero ? number < 0 : number <= 0)
  ) {
    throw new Error(`${fieldName} is not a supported safe integer`);
  }
  return number;
}

function normalizeSha256(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new TypeError(`${fieldName} must be lower-case SHA-256`);
  }
  return normalized;
}

function normalizeIso(value, fieldName) {
  const normalized = String(value || "").trim();
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new TypeError(`${fieldName} must be a canonical ISO timestamp`);
  }
  return normalized;
}

function normalizeDay(value, fieldName = "day_utc") {
  const normalized = String(value || "").trim();
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    !ISO_DAY_PATTERN.test(normalized) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new TypeError(`${fieldName} must be a valid UTC day`);
  }
  return normalized;
}

function normalizeKey(value, fieldName) {
  const normalized = String(value || "").trim().replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/")) {
    throw new TypeError(`${fieldName} must be a non-empty object key`);
  }
  return normalized;
}

function minValue(values) {
  return values.reduce(
    (current, value) => current === null || value < current ? value : current,
    null,
  );
}

function maxValue(values) {
  return values.reduce(
    (current, value) => current === null || value > current ? value : current,
    null,
  );
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  if (typeof value === "string") return textEncoder.encode(value).buffer;
  throw new TypeError("V3 index body must be text or bytes");
}

function exactScope({ dayUtc, connectorId, pollutantCode }) {
  const pollutant = normalizeObservationPropertyCode(pollutantCode);
  if (!pollutant) throw new TypeError("pollutantCode is invalid");
  return Object.freeze({
    day_utc: normalizeDay(dayUtc),
    connector_id: positiveSafeInteger(connectorId, "connectorId"),
    pollutant_code: pollutant,
  });
}

export function observationHistoryV3RangeForTimeseriesId(timeseriesId) {
  const normalized = positiveSafeInteger(timeseriesId, "timeseriesId");
  const rangeStart = Math.floor(normalized / OBSERVATION_HISTORY_V3_SHARD_WIDTH) *
    OBSERVATION_HISTORY_V3_SHARD_WIDTH;
  return Object.freeze({
    range_start: rangeStart,
    range_end: rangeStart + OBSERVATION_HISTORY_V3_SHARD_WIDTH - 1,
  });
}

export function buildObservationHistoryV3ChildReadKey({
  dayUtc,
  connectorId,
  pollutantCode,
  timeseriesId,
  indexRoot = OBSERVATION_HISTORY_V3_INDEX_ROOT,
}) {
  const scope = exactScope({ dayUtc, connectorId, pollutantCode });
  const range = observationHistoryV3RangeForTimeseriesId(timeseriesId);
  const token = `${String(range.range_start).padStart(6, "0")}-` +
    String(range.range_end).padStart(6, "0");
  const root = String(indexRoot || "").trim().replace(/^\/+|\/+$/g, "");
  if (!root) throw new TypeError("indexRoot is required");
  return `${root}/day_utc=${scope.day_utc}` +
    `/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}/range=${token}.json`;
}

export function buildObservationHistoryV3ScopedManifestReadKey({
  dayUtc,
  connectorId,
  pollutantCode,
  indexRoot = OBSERVATION_HISTORY_V3_INDEX_ROOT,
}) {
  const scope = exactScope({ dayUtc, connectorId, pollutantCode });
  const root = String(indexRoot || "").trim().replace(/^\/+|\/+$/g, "");
  if (!root) throw new TypeError("indexRoot is required");
  return `${root}/day_utc=${scope.day_utc}` +
    `/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}/manifest.json`;
}

function normalizeChildFile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("V3 child file descriptor must be an object");
  }
  const file = {
    key: normalizeKey(raw.key, "child.file.key"),
    byte_size: positiveSafeInteger(raw.byte_size, "child.file.byte_size"),
    sha256: normalizeSha256(raw.sha256, "child.file.sha256"),
    row_count: positiveSafeInteger(raw.row_count, "child.file.row_count"),
    row_group_count: positiveSafeInteger(
      raw.row_group_count,
      "child.file.row_group_count",
    ),
    history_schema_version: Number(raw.history_schema_version),
    writer_version: String(raw.writer_version || ""),
    physical_layout_version: String(raw.physical_layout_version || ""),
    ...(raw.etag === undefined ? {} : { etag: String(raw.etag || "").trim() }),
  };
  if (
    file.history_schema_version !== OBSERVATION_HISTORY_SCHEMA_VERSION_V3 ||
    file.writer_version !== OBSERVATION_HISTORY_WRITER_VERSION_V3 ||
    file.physical_layout_version !==
      OBSERVATION_HISTORY_V3_PHYSICAL_LAYOUT_VERSION ||
    (Object.hasOwn(file, "etag") && !file.etag)
  ) {
    throw new Error("V3 child has unsupported physical file identity");
  }
  if (!sameJson(raw, file)) {
    throw new Error("V3 child file descriptor has unsupported fields");
  }
  return file;
}

function normalizeChildSegment(raw, timeseriesId, filesByKey, rowGroupStarts) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("V3 child segment must be an object");
  }
  const segment = {
    file_key: normalizeKey(raw.file_key, "child.segment.file_key"),
    row_group_ordinal: nonNegativeSafeInteger(
      raw.row_group_ordinal,
      "child.segment.row_group_ordinal",
    ),
    row_start: nonNegativeSafeInteger(raw.row_start, "child.segment.row_start"),
    row_group_row_start: nonNegativeSafeInteger(
      raw.row_group_row_start,
      "child.segment.row_group_row_start",
    ),
    row_count: positiveSafeInteger(raw.row_count, "child.segment.row_count"),
    min_observed_at_utc: normalizeIso(
      raw.min_observed_at_utc,
      "child.segment.min_observed_at_utc",
    ),
    max_observed_at_utc: normalizeIso(
      raw.max_observed_at_utc,
      "child.segment.max_observed_at_utc",
    ),
  };
  if (!sameJson(raw, segment)) {
    throw new Error("V3 child segment has unsupported fields");
  }
  const file = filesByKey.get(segment.file_key);
  if (!file) throw new Error("V3 child segment names an unlisted file");
  if (
    segment.row_group_ordinal >= file.row_group_count ||
    segment.row_start + segment.row_count > file.row_count ||
    segment.row_group_row_start > segment.row_start ||
    segment.min_observed_at_utc > segment.max_observed_at_utc
  ) {
    throw new Error("V3 child segment has impossible coordinates or bounds");
  }
  const groupKey = `${segment.file_key}\u0000${segment.row_group_ordinal}`;
  const inferredStart = segment.row_start - segment.row_group_row_start;
  const priorStart = rowGroupStarts.get(groupKey);
  if (inferredStart < 0 || (priorStart !== undefined && priorStart !== inferredStart)) {
    throw new Error("V3 child segment has contradictory row-group coordinates");
  }
  rowGroupStarts.set(groupKey, inferredStart);
  return Object.freeze({ ...segment, timeseries_id: timeseriesId });
}

function validateNonOverlappingChildSegments(segments, filesByKey) {
  const byFile = new Map([...filesByKey.keys()].map((key) => [key, []]));
  for (const segment of segments) byFile.get(segment.file_key).push(segment);
  for (const [fileKey, fileSegments] of byFile) {
    if (fileSegments.length === 0) {
      throw new Error(`V3 child lists an unreferenced file: ${fileKey}`);
    }
    fileSegments.sort((left, right) =>
      left.row_start - right.row_start ||
      left.row_count - right.row_count ||
      left.timeseries_id - right.timeseries_id
    );
    let previousEnd = -1;
    for (const segment of fileSegments) {
      if (segment.row_start < previousEnd) {
        throw new Error("V3 child contains overlapping physical segments");
      }
      previousEnd = segment.row_start + segment.row_count;
    }
  }
}

export function validateObservationHistoryV3ChildForRead({
  key,
  body,
  dayUtc,
  connectorId,
  pollutantCode,
  timeseriesId,
  indexRoot = OBSERVATION_HISTORY_V3_INDEX_ROOT,
}) {
  const scope = exactScope({ dayUtc, connectorId, pollutantCode });
  const expectedKey = buildObservationHistoryV3ChildReadKey({
    dayUtc,
    connectorId,
    pollutantCode,
    timeseriesId,
    indexRoot,
  });
  if (normalizeKey(key, "child key") !== expectedKey) {
    throw new Error("V3 child object key is non-canonical");
  }
  const bodyBuffer = exactArrayBuffer(body);
  let bodyText;
  let payload;
  try {
    bodyText = textDecoder.decode(bodyBuffer);
    payload = JSON.parse(bodyText);
  } catch (_error) {
    throw new Error("V3 child body is not valid UTF-8 canonical JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("V3 child payload must be an object");
  }
  const requestedRange = observationHistoryV3RangeForTimeseriesId(timeseriesId);
  if (
    Number(payload.schema_version) !== 3 ||
    payload.kind !== "observation_timeseries_exact_shard" ||
    payload.index_generation !== OBSERVATION_HISTORY_V3_INDEX_GENERATION ||
    payload.history_version !== OBSERVATION_HISTORY_V3_LOGICAL_HISTORY_VERSION ||
    payload.domain !== "observations" ||
    Number(payload.history_schema_version) !==
      OBSERVATION_HISTORY_SCHEMA_VERSION_V3 ||
    payload.writer_version !== OBSERVATION_HISTORY_WRITER_VERSION_V3 ||
    payload.physical_layout_version !==
      OBSERVATION_HISTORY_V3_PHYSICAL_LAYOUT_VERSION ||
    Number(payload.shard_width) !== OBSERVATION_HISTORY_V3_SHARD_WIDTH ||
    Number(payload.range_start) !== requestedRange.range_start ||
    Number(payload.range_end) !== requestedRange.range_end ||
    payload.day_utc !== scope.day_utc ||
    Number(payload.connector_id) !== scope.connector_id ||
    payload.pollutant_code !== scope.pollutant_code ||
    payload.row_start_scope !== "file"
  ) {
    throw new Error("V3 child identity or supported generation is contradictory");
  }

  const files = (Array.isArray(payload.files) ? payload.files : [])
    .map(normalizeChildFile);
  if (files.length === 0) throw new Error("V3 child requires physical files");
  const filesByKey = new Map();
  for (const [index, file] of files.entries()) {
    if (
      filesByKey.has(file.key) ||
      (index > 0 && bytewiseCompare(files[index - 1].key, file.key) >= 0)
    ) {
      throw new Error("V3 child files are duplicate or non-canonical");
    }
    filesByKey.set(file.key, file);
  }
  const fileOrder = new Map(files.map((file, index) => [file.key, index]));
  const rawTimeseries = Array.isArray(payload.timeseries) ? payload.timeseries : [];
  if (rawTimeseries.length === 0) throw new Error("V3 child cannot be empty");
  const rowGroupStarts = new Map();
  const allSegments = [];
  const timeseries = rawTimeseries.map((raw, index) => {
    const id = positiveSafeInteger(raw?.timeseries_id, "child.timeseries_id");
    if (
      id < requestedRange.range_start ||
      id > requestedRange.range_end ||
      (index > 0 && rawTimeseries[index - 1].timeseries_id >= id)
    ) {
      throw new Error("V3 child timeseries identity is out of range or unordered");
    }
    const segments = (Array.isArray(raw?.segments) ? raw.segments : []).map(
      (segment) => normalizeChildSegment(segment, id, filesByKey, rowGroupStarts),
    );
    if (segments.length === 0) {
      throw new Error("V3 child timeseries requires exact segments");
    }
    for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
      const previous = segments[segmentIndex - 1];
      const current = segments[segmentIndex];
      if (
        fileOrder.get(current.file_key) < fileOrder.get(previous.file_key) ||
        (
          current.file_key === previous.file_key &&
          current.row_start < previous.row_start + previous.row_count
        ) ||
        current.min_observed_at_utc < previous.max_observed_at_utc
      ) {
        throw new Error("V3 child timeseries segments overlap or regress");
      }
    }
    const normalized = {
      timeseries_id: id,
      row_count: sum(segments.map((segment) => segment.row_count)),
      min_observed_at_utc: minValue(
        segments.map((segment) => segment.min_observed_at_utc),
      ),
      max_observed_at_utc: maxValue(
        segments.map((segment) => segment.max_observed_at_utc),
      ),
      segments: segments.map(({ timeseries_id: _id, ...segment }) => segment),
    };
    if (!sameJson(raw, normalized)) {
      throw new Error("V3 child timeseries totals or bounds are contradictory");
    }
    allSegments.push(...segments);
    return normalized;
  });
  validateNonOverlappingChildSegments(allSegments, filesByKey);
  const coverage = {
    timeseries_count: timeseries.length,
    timeseries_ids: timeseries.map((entry) => entry.timeseries_id),
    row_count: sum(timeseries.map((entry) => entry.row_count)),
    min_observed_at_utc: minValue(
      timeseries.map((entry) => entry.min_observed_at_utc),
    ),
    max_observed_at_utc: maxValue(
      timeseries.map((entry) => entry.max_observed_at_utc),
    ),
    file_count: files.length,
  };
  const expectedPayload = {
    schema_version: 3,
    kind: "observation_timeseries_exact_shard",
    index_generation: OBSERVATION_HISTORY_V3_INDEX_GENERATION,
    history_version: OBSERVATION_HISTORY_V3_LOGICAL_HISTORY_VERSION,
    domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_V3_PHYSICAL_LAYOUT_VERSION,
    shard_width: OBSERVATION_HISTORY_V3_SHARD_WIDTH,
    range_start: requestedRange.range_start,
    range_end: requestedRange.range_end,
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
    row_start_scope: "file",
    coverage,
    files,
    timeseries,
  };
  if (!sameJson(payload, expectedPayload) || bodyText !== canonicalJson(payload)) {
    throw new Error("V3 child payload is non-canonical or semantically contradictory");
  }
  return Object.freeze({
    key: expectedKey,
    scope,
    payload,
    files: Object.freeze(files),
    files_by_key: filesByKey,
    timeseries: Object.freeze(timeseries),
    requested_timeseries: timeseries.find((entry) =>
      entry.timeseries_id === Number(timeseriesId)
    ) || null,
  });
}

function scopedDescriptorForValidatedChild(child, byteSize, sha256) {
  return {
    key: child.key,
    byte_size: byteSize,
    sha256,
    range_start: child.payload.range_start,
    range_end: child.payload.range_end,
    timeseries_count: child.payload.coverage.timeseries_count,
    timeseries_ids: [...child.payload.coverage.timeseries_ids],
    row_count: child.payload.coverage.row_count,
    min_observed_at_utc: child.payload.coverage.min_observed_at_utc,
    max_observed_at_utc: child.payload.coverage.max_observed_at_utc,
    file_count: child.payload.coverage.file_count,
    files: child.files.map(({ key, byte_size, sha256: fileSha256 }) => ({
      key,
      byte_size,
      sha256: fileSha256,
    })),
  };
}

function resolveLimits(raw = {}) {
  const limits = {};
  for (const [key, fallback] of Object.entries(
    DEFAULT_OBSERVATION_HISTORY_V3_READ_LIMITS,
  )) {
    limits[key] = positiveSafeInteger(raw[key] ?? fallback, key);
  }
  return Object.freeze(limits);
}

function elapsedNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createWorkloadDiagnostics() {
  return {
    schema_version: 1,
    timing_basis:
      "performance_now_deployed_workers_advances_only_after_io_not_cpu_time",
    synchronous_phase_timings_may_be_zero_in_deployed_workers: true,
    cpu_time_ms: null,
    cpu_time_source: "cloudflare_invocation_logs_or_analytics",
    start_utc: null,
    end_utc: null,
    duration_ms: 0,
    connector_id: null,
    pollutant_code: null,
    timeseries_id: null,
    intersecting_utc_days: [],
    scoped_manifest_fetch_elapsed_ms: 0,
    scoped_manifest_validation_elapsed_ms: 0,
    child_index_fetch_elapsed_ms: 0,
    child_sha_elapsed_ms: 0,
    child_parse_validation_elapsed_ms: 0,
    requested_timeseries_segment_rows: 0,
    parquet_file_identity_elapsed_ms: 0,
    footer_elapsed_ms: 0,
    parquet_planning_elapsed_ms: 0,
    projected_compressed_bytes_by_column: Object.fromEntries(
      OBSERVATION_HISTORY_V3_PROJECTED_COLUMNS.map((column) => [column, 0]),
    ),
    projected_compressed_bytes_total: 0,
    planned_ranges: 0,
    data_read_elapsed_ms: 0,
    parquet_decode_elapsed_ms: 0,
    final_filter_validation_elapsed_ms: 0,
    rows_surviving_filter: 0,
    total_elapsed_ms: 0,
  };
}

function createDiagnostics({ collectWorkloadDiagnostics = false } = {}) {
  return {
    index_generation: OBSERVATION_HISTORY_V3_INDEX_GENERATION,
    index_objects_read: 0,
    index_bytes_read: 0,
    scoped_manifests_read: 0,
    scoped_manifest_bytes_read: 0,
    child_shards_read: 0,
    child_shard_bytes_read: 0,
    child_identity_checks: 0,
    child_identity_mismatch: 0,
    parquet_files_selected: 0,
    selected_segments: 0,
    footer_reads: 0,
    footer_cache_hits: 0,
    footer_cache_misses: 0,
    identity_head_reads: 0,
    r2_range_reads: 0,
    r2_bytes_requested: 0,
    row_groups_selected: 0,
    page_indexes_available: 0,
    pages_selected: 0,
    column_chunks_selected: 0,
    range_coalesces: 0,
    rows_decoded: 0,
    rows_returned: 0,
    projected_columns: [...OBSERVATION_HISTORY_V3_PROJECTED_COLUMNS],
    page_selection_supported: false,
    page_selection_unavailable_reason: PAGE_SELECTION_UNAVAILABLE_REASON,
    authoritative_absent_days: [],
    missing_index_keys: [],
    missing_scoped_manifest_keys: [],
    missing_child_keys: [],
    partial_or_fail_closed_reason: null,
    ...(collectWorkloadDiagnostics
      ? { workload: createWorkloadDiagnostics() }
      : {}),
  };
}

function addElapsed(workload, field, startedAt) {
  if (!workload) return;
  workload[field] += elapsedNow() - startedAt;
}

async function measureAsync(workload, field, operation) {
  if (!workload) return operation();
  const startedAt = elapsedNow();
  try {
    return await operation();
  } finally {
    addElapsed(workload, field, startedAt);
  }
}

function measureSync(workload, field, operation) {
  if (!workload) return operation();
  const startedAt = elapsedNow();
  try {
    return operation();
  } finally {
    addElapsed(workload, field, startedAt);
  }
}

function finalizeWorkloadDiagnostics(workload, startedAt) {
  if (!workload) return;
  workload.total_elapsed_ms = elapsedNow() - startedAt;
  for (const [key, value] of Object.entries(workload)) {
    if (key.endsWith("_elapsed_ms") && Number.isFinite(value)) {
      workload[key] = Number(value.toFixed(3));
    }
  }
}

export class ObservationHistoryV3ReadError extends Error {
  constructor(code, message, diagnostics, options = {}) {
    super(message, options);
    this.name = "ObservationHistoryV3ReadError";
    this.code = code;
    this.diagnostics = Object.freeze({ ...diagnostics });
  }
}

export function observationHistoryV3FooterCacheKey(file) {
  return [
    OBSERVATION_HISTORY_V3_FOOTER_CACHE_GENERATION,
    normalizeSha256(file?.sha256, "file.sha256"),
    positiveSafeInteger(file?.byte_size, "file.byte_size"),
    Number(file?.history_schema_version),
    String(file?.writer_version || ""),
    String(file?.physical_layout_version || ""),
  ].join(":");
}

export function createObservationHistoryV3FooterCache({ maxEntries = 128 } = {}) {
  const maximum = positiveSafeInteger(maxEntries, "maxEntries");
  const entries = new Map();
  return Object.freeze({
    has(key) {
      return entries.has(key);
    },
    get(key) {
      const value = entries.get(key);
      if (!value) return null;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
    },
    get size() {
      return entries.size;
    },
  });
}

function combineFooterBytes(metadataBytes, trailerBytes) {
  const combined = new Uint8Array(metadataBytes.byteLength + trailerBytes.byteLength);
  combined.set(new Uint8Array(metadataBytes), 0);
  combined.set(new Uint8Array(trailerBytes), metadataBytes.byteLength);
  return combined.buffer;
}

function validateFooterMetadata(metadata, file) {
  if (metadata.created_by !== EXPECTED_CREATED_BY) {
    throw new Error(`V3 Parquet footer writer identity mismatch: ${file.key}`);
  }
  const columns = parquetSchema(metadata).children.map((column) =>
    String(column.element.name)
  );
  if (
    columns.length !== OBSERVATION_HISTORY_COLUMNS_V3.length ||
    columns.some((column, index) => column !== OBSERVATION_HISTORY_COLUMNS_V3[index])
  ) {
    throw new Error(`V3 Parquet footer schema mismatch: ${file.key}`);
  }
  const rowCount = safeMetadataInteger(metadata.num_rows, "footer.num_rows");
  const rowGroups = Array.isArray(metadata.row_groups) ? metadata.row_groups : [];
  if (rowCount !== file.row_count || rowGroups.length !== file.row_group_count) {
    throw new Error(`V3 Parquet footer file identity mismatch: ${file.key}`);
  }
  let rowStart = 0;
  const rowGroupStarts = [];
  const rowGroupRows = [];
  for (const [ordinal, rowGroup] of rowGroups.entries()) {
    const rows = safeMetadataInteger(
      rowGroup?.num_rows,
      `footer.row_groups[${ordinal}].num_rows`,
    );
    rowGroupStarts.push(rowStart);
    rowGroupRows.push(rows);
    rowStart += rows;
  }
  if (rowStart !== rowCount) {
    throw new Error(`V3 Parquet footer row groups do not reconcile: ${file.key}`);
  }
  return Object.freeze({ metadata, columns, rowGroupStarts, rowGroupRows });
}

async function acquireFooter({
  randomAccessFile,
  file,
  footerCache,
  limits,
  diagnostics,
}) {
  const cacheKey = observationHistoryV3FooterCacheKey(file);
  const cached = footerCache.get(cacheKey);
  if (cached) {
    diagnostics.footer_cache_hits += 1;
    return cached;
  }
  diagnostics.footer_cache_misses += 1;
  if (diagnostics.footer_reads + 2 > limits.max_footer_reads) {
    throw new Error("V3 footer-read budget exceeded before footer acquisition");
  }
  if (randomAccessFile.byteLength < 12) {
    throw new Error(`V3 Parquet object is too small: ${file.key}`);
  }
  const trailer = await randomAccessFile.slice(
    randomAccessFile.byteLength - 8,
    randomAccessFile.byteLength,
  );
  diagnostics.footer_reads += 1;
  const trailerView = new DataView(trailer);
  if (trailerView.getUint32(4, true) !== 0x31524150) {
    throw new Error(`V3 Parquet footer magic mismatch: ${file.key}`);
  }
  const metadataLength = trailerView.getUint32(0, true);
  if (
    metadataLength <= 0 ||
    metadataLength > limits.max_footer_bytes ||
    metadataLength > randomAccessFile.byteLength - 8
  ) {
    throw new Error(`V3 Parquet footer length is invalid or over budget: ${file.key}`);
  }
  const metadataStart = randomAccessFile.byteLength - metadataLength - 8;
  const metadataBytes = await randomAccessFile.slice(
    metadataStart,
    randomAccessFile.byteLength - 8,
  );
  diagnostics.footer_reads += 1;
  const metadata = parquetMetadata(
    combineFooterBytes(metadataBytes, trailer),
    { geoparquet: false },
  );
  const validated = validateFooterMetadata(metadata, file);
  const entry = Object.freeze({
    ...validated,
    metadata_length: metadataLength,
    cache_key: cacheKey,
  });
  footerCache.set(cacheKey, entry);
  return entry;
}

function columnChunk(rowGroup, columnName) {
  return (rowGroup?.columns || []).find((column) =>
    column?.meta_data?.path_in_schema?.length === 1 &&
    column.meta_data.path_in_schema[0] === columnName
  );
}

function columnChunkRange(column, file, label) {
  const metadata = column?.meta_data;
  const dataOffset = safeMetadataInteger(
    metadata?.data_page_offset,
    `${label}.data_page_offset`,
    { allowZero: true },
  );
  const compressedSize = safeMetadataInteger(
    metadata?.total_compressed_size,
    `${label}.total_compressed_size`,
  );
  const hasDictionary = metadata?.dictionary_page_offset !== undefined &&
    metadata?.dictionary_page_offset !== null;
  const dictionaryOffset = hasDictionary
    ? safeMetadataInteger(
      metadata.dictionary_page_offset,
      `${label}.dictionary_page_offset`,
      { allowZero: true },
    )
    : null;
  if (hasDictionary && dictionaryOffset >= dataOffset) {
    throw new Error(`V3 dictionary-page offset is invalid: ${label}`);
  }
  const start = hasDictionary ? dictionaryOffset : dataOffset;
  const end = start + compressedSize;
  if (
    !Number.isSafeInteger(end) ||
    start >= file.byte_size ||
    dataOffset >= end ||
    end > file.byte_size
  ) {
    throw new Error(`V3 projected column-chunk range is invalid: ${label}`);
  }
  return { start, end };
}

function hasValidPageIndexes(column, file) {
  const values = [
    column?.column_index_offset,
    column?.column_index_length,
    column?.offset_index_offset,
    column?.offset_index_length,
  ];
  if (!values.every((value) => value !== undefined && value !== null)) {
    return false;
  }
  for (const [index, value] of values.entries()) {
    const number = safeMetadataInteger(
      value,
      `page_index[${index}]`,
      { allowZero: index % 2 === 0 },
    );
    if (index % 2 === 0) {
      const length = safeMetadataInteger(values[index + 1], "page_index.length");
      if (number + length > file.byte_size) {
        throw new Error(`V3 page-index range is outside file: ${file.key}`);
      }
    }
  }
  return true;
}

function validateSegmentsAgainstFooter(segments, file, footer) {
  for (const segment of segments) {
    const rowGroupStart = footer.rowGroupStarts[segment.row_group_ordinal];
    const rowGroupRows = footer.rowGroupRows[segment.row_group_ordinal];
    if (
      rowGroupStart === undefined ||
      segment.row_start !== rowGroupStart + segment.row_group_row_start ||
      segment.row_group_row_start + segment.row_count > rowGroupRows ||
      segment.row_start + segment.row_count > file.row_count
    ) {
      throw new Error(
        `V3 segment disagrees with Parquet footer coordinates: ${file.key}`,
      );
    }
  }
}

function selectedColumnRanges({ file, footer, rowGroupOrdinals, diagnostics }) {
  const ranges = [];
  let allPageIndexesAvailable = true;
  for (const ordinal of rowGroupOrdinals) {
    const rowGroup = footer.metadata.row_groups[ordinal];
    if (!rowGroup) throw new Error(`V3 selected row group is missing: ${file.key}`);
    for (const columnName of OBSERVATION_HISTORY_V3_PROJECTED_COLUMNS) {
      const column = columnChunk(rowGroup, columnName);
      if (!column) {
        throw new Error(`V3 projected column is missing: ${file.key}:${columnName}`);
      }
      const range = columnChunkRange(
        column,
        file,
        `${file.key}:row_group=${ordinal}:${columnName}`,
      );
      ranges.push({
        id: `${ordinal}:${columnName}`,
        ...range,
      });
      if (diagnostics.workload) {
        const compressedBytes = range.end - range.start;
        diagnostics.workload.projected_compressed_bytes_by_column[columnName] +=
          compressedBytes;
        diagnostics.workload.projected_compressed_bytes_total += compressedBytes;
      }
      allPageIndexesAvailable = hasValidPageIndexes(column, file) &&
        allPageIndexesAvailable;
    }
  }
  diagnostics.column_chunks_selected += ranges.length;
  if (allPageIndexesAvailable) diagnostics.page_indexes_available += 1;
  return ranges;
}

function decodedTimestamp(value) {
  const iso = value instanceof Date ? value.toISOString() : String(value || "");
  return normalizeIso(iso, "decoded observed_at_utc");
}

function validateDecodedSegment(rows, segment, timeseriesId) {
  if (rows.length !== segment.row_count) {
    throw new Error("V3 decoded physical row count disagrees with exact segment");
  }
  let previous = null;
  const normalized = rows.map((row) => {
    if (Number(row?.timeseries_id) !== timeseriesId) {
      throw new Error("V3 decoded segment contains a neighbouring timeseries");
    }
    const observedAtUtc = decodedTimestamp(row?.observed_at_utc);
    if (
      observedAtUtc < segment.min_observed_at_utc ||
      observedAtUtc > segment.max_observed_at_utc ||
      (previous !== null && observedAtUtc < previous)
    ) {
      throw new Error("V3 decoded segment timestamps contradict indexed bounds");
    }
    previous = observedAtUtc;
    const value = Number(row?.value);
    if (!Number.isFinite(value)) {
      throw new Error("V3 decoded observation value is not finite");
    }
    return Object.freeze({
      timeseries_id: timeseriesId,
      observed_at_utc: observedAtUtc,
      value: Object.is(value, -0) ? 0 : value,
    });
  });
  if (
    normalized[0].observed_at_utc !== segment.min_observed_at_utc ||
    normalized.at(-1).observed_at_utc !== segment.max_observed_at_utc
  ) {
    throw new Error("V3 decoded segment endpoints contradict indexed bounds");
  }
  return normalized;
}

function listIntersectingUtcDays(startIso, endIso) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const days = [];
  let cursor = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  );
  const finalDay = Date.UTC(
    new Date(endMs - 1).getUTCFullYear(),
    new Date(endMs - 1).getUTCMonth(),
    new Date(endMs - 1).getUTCDate(),
  );
  while (cursor <= finalDay) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 24 * 60 * 60 * 1000;
  }
  return days;
}

function assertPlanLimit(actual, maximum, label) {
  if (actual > maximum) {
    throw new Error(`V3 ${label} budget exceeded before Parquet data reads`);
  }
}

async function fetchBoundedIndexObject({
  source,
  key,
  limits,
  diagnostics,
}) {
  if (diagnostics.index_objects_read >= limits.max_index_objects) {
    throw new Error("V3 index-object count budget exceeded before index GET");
  }
  const remainingBytes = limits.max_total_index_bytes -
    diagnostics.index_bytes_read;
  if (remainingBytes <= 0) {
    throw new Error("V3 total-index-byte budget exhausted before index GET");
  }
  diagnostics.index_objects_read += 1;
  const object = await source.getIndexObject({
    key,
    maxBytes: Math.min(limits.max_index_object_bytes, remainingBytes),
    diagnostics,
  });
  if (!object) return null;
  const byteSize = positiveSafeInteger(
    object.byte_size,
    "index object byte_size",
  );
  if (byteSize > limits.max_index_object_bytes) {
    throw new Error("V3 index object exceeds per-object byte budget");
  }
  const body = exactArrayBuffer(object.body);
  if (body.byteLength !== byteSize) {
    throw new Error("V3 index object body disagrees with reported byte size");
  }
  diagnostics.index_bytes_read += byteSize;
  assertPlanLimit(
    diagnostics.index_bytes_read,
    limits.max_total_index_bytes,
    "total-index-byte",
  );
  return Object.freeze({ key, body, byte_size: byteSize });
}

export async function readObservationHistoryExactV3({
  source,
  indexGeneration,
  historyVersion,
  timeseriesId,
  connectorId,
  pollutantCode,
  startUtc,
  endUtc,
  indexRoot = OBSERVATION_HISTORY_V3_INDEX_ROOT,
  limits: rawLimits = {},
  footerCache = createObservationHistoryV3FooterCache(),
  collectWorkloadDiagnostics = false,
}) {
  const totalStartedAt = collectWorkloadDiagnostics ? elapsedNow() : 0;
  const diagnostics = createDiagnostics({ collectWorkloadDiagnostics });
  const workload = diagnostics.workload || null;
  let budget = null;
  try {
    if (String(indexGeneration || "").trim().toLowerCase() !== "v3") {
      throw new Error("V3 exact reader requires index generation v3");
    }
    if (String(historyVersion || "").trim().toLowerCase() !== "v2") {
      throw new Error("V3 exact reader requires logical history version v2");
    }
    if (
      !source ||
      typeof source.getIndexObject !== "function" ||
      typeof source.openParquetFile !== "function"
    ) {
      throw new TypeError("V3 exact reader requires index and Parquet source adapters");
    }
    const normalizedTimeseriesId = positiveSafeInteger(
      timeseriesId,
      "timeseriesId",
    );
    const scopeBase = exactScope({
      dayUtc: new Date(startUtc).toISOString().slice(0, 10),
      connectorId,
      pollutantCode,
    });
    const startIso = normalizeIso(new Date(startUtc).toISOString(), "startUtc");
    const endIso = normalizeIso(new Date(endUtc).toISOString(), "endUtc");
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    if (endMs <= startMs) throw new TypeError("endUtc must be after startUtc");
    const limits = resolveLimits(rawLimits);
    const days = listIntersectingUtcDays(startIso, endIso);
    if (workload) {
      Object.assign(workload, {
        start_utc: startIso,
        end_utc: endIso,
        duration_ms: endMs - startMs,
        connector_id: scopeBase.connector_id,
        pollutant_code: scopeBase.pollutant_code,
        timeseries_id: normalizedTimeseriesId,
        intersecting_utc_days: [...days],
      });
    }
    assertPlanLimit(
      days.length * 2,
      limits.max_index_objects,
      "index-object count",
    );

    const selectedSegments = [];
    const filesByKey = new Map();
    const incompleteReasons = new Set();
    const scopedManifestCache = new Map();
    for (const dayUtc of days) {
      const scopedKey = buildObservationHistoryV3ScopedManifestReadKey({
        dayUtc,
        connectorId: scopeBase.connector_id,
        pollutantCode: scopeBase.pollutant_code,
        indexRoot,
      });
      let scoped = scopedManifestCache.get(scopedKey);
      if (!scoped) {
        const scopedObject = await measureAsync(
          workload,
          "scoped_manifest_fetch_elapsed_ms",
          () => fetchBoundedIndexObject({
            source,
            key: scopedKey,
            limits,
            diagnostics,
          }),
        );
        if (!scopedObject) {
          diagnostics.missing_index_keys.push(scopedKey);
          diagnostics.missing_scoped_manifest_keys.push(scopedKey);
          incompleteReasons.add("missing_v3_scoped_manifest");
          continue;
        }
        diagnostics.scoped_manifests_read += 1;
        diagnostics.scoped_manifest_bytes_read += scopedObject.byte_size;
        scoped = measureSync(
          workload,
          "scoped_manifest_validation_elapsed_ms",
          () => validateObservationHistoryIndexV3ScopedManifestBody({
            key: scopedKey,
            body: scopedObject.body,
            indexRoot,
          }),
        );
        scopedManifestCache.set(scopedKey, scoped);
      }

      const requestedRange = observationHistoryV3RangeForTimeseriesId(
        normalizedTimeseriesId,
      );
      const descriptor = scoped.descriptors.find((entry) =>
        entry.range_start === requestedRange.range_start
      );
      if (
        !descriptor ||
        !descriptor.timeseries_ids.includes(normalizedTimeseriesId)
      ) {
        diagnostics.authoritative_absent_days.push(dayUtc);
        continue;
      }

      const expectedChildKey = buildObservationHistoryV3ChildReadKey({
        dayUtc,
        connectorId: scopeBase.connector_id,
        pollutantCode: scopeBase.pollutant_code,
        timeseriesId: normalizedTimeseriesId,
        indexRoot,
      });
      if (descriptor.key !== expectedChildKey) {
        throw new Error("Scoped v3 manifest selected a non-canonical child key");
      }
      const childObject = await measureAsync(
        workload,
        "child_index_fetch_elapsed_ms",
        () => fetchBoundedIndexObject({
          source,
          key: descriptor.key,
          limits,
          diagnostics,
        }),
      );
      if (!childObject) {
        diagnostics.missing_index_keys.push(descriptor.key);
        diagnostics.missing_child_keys.push(descriptor.key);
        incompleteReasons.add("missing_v3_pinned_child_shard");
        continue;
      }
      diagnostics.child_shards_read += 1;
      diagnostics.child_shard_bytes_read += childObject.byte_size;
      diagnostics.child_identity_checks += 1;
      if (childObject.byte_size !== descriptor.byte_size) {
        diagnostics.child_identity_mismatch += 1;
        throw new Error(`V3 pinned child byte-size mismatch: ${descriptor.key}`);
      }
      const childSha256 = await measureAsync(
        workload,
        "child_sha_elapsed_ms",
        () => sha256ObservationHistoryV3Bytes(childObject.body),
      );
      if (childSha256 !== descriptor.sha256) {
        diagnostics.child_identity_mismatch += 1;
        throw new Error(`V3 pinned child SHA-256 mismatch: ${descriptor.key}`);
      }
      const child = measureSync(
        workload,
        "child_parse_validation_elapsed_ms",
        () => {
          const validated = validateObservationHistoryV3ChildForRead({
            key: descriptor.key,
            body: childObject.body,
            dayUtc,
            connectorId: scopeBase.connector_id,
            pollutantCode: scopeBase.pollutant_code,
            timeseriesId: normalizedTimeseriesId,
            indexRoot,
          });
          if (
            !sameJson(
              scopedDescriptorForValidatedChild(
                validated,
                childObject.byte_size,
                childSha256,
              ),
              descriptor,
            )
          ) {
            throw new Error(
              `V3 pinned child semantics disagree with scoped manifest: ${descriptor.key}`,
            );
          }
          if (!validated.requested_timeseries) {
            throw new Error(
              `V3 pinned child omits scoped timeseries_id=${normalizedTimeseriesId}`,
            );
          }
          return validated;
        },
      );
      for (const segment of child.requested_timeseries.segments) {
        if (
          Date.parse(segment.max_observed_at_utc) < startMs ||
          Date.parse(segment.min_observed_at_utc) >= endMs
        ) {
          continue;
        }
        const file = child.files_by_key.get(segment.file_key);
        const previous = filesByKey.get(file.key);
        if (previous && !sameJson(previous, file)) {
          throw new Error(`V3 child files contradict one physical identity: ${file.key}`);
        }
        filesByKey.set(file.key, file);
        selectedSegments.push(Object.freeze({ day_utc: dayUtc, ...segment }));
      }
    }

    diagnostics.parquet_files_selected = filesByKey.size;
    diagnostics.selected_segments = selectedSegments.length;
    if (workload) {
      workload.requested_timeseries_segment_rows = sum(
        selectedSegments.map((segment) => segment.row_count),
      );
    }
    const selectedRowGroupKeys = new Set(selectedSegments.map((segment) =>
      `${segment.file_key}\u0000${segment.row_group_ordinal}`
    ));
    diagnostics.row_groups_selected = selectedRowGroupKeys.size;
    assertPlanLimit(
      filesByKey.size,
      limits.max_distinct_files,
      "distinct-Parquet-file count",
    );
    assertPlanLimit(
      selectedSegments.length,
      limits.max_selected_segments,
      "selected-segment count",
    );
    assertPlanLimit(
      selectedRowGroupKeys.size,
      limits.max_selected_row_groups,
      "selected-row-group count",
    );
    assertPlanLimit(
      sum(selectedSegments.map((segment) => segment.row_count)),
      limits.max_response_rows,
      "potential-response-row count",
    );

    budget = createObservationHistoryV3RangeBudget({
      maxRangeReads: limits.max_total_range_reads,
      maxBytesRequested: limits.max_total_bytes_requested,
    });
    const contexts = new Map();
    let plannedDecodedRows = 0;
    for (const file of filesByKey.values()) {
      const randomAccessFile = await measureAsync(
        workload,
        "parquet_file_identity_elapsed_ms",
        () => source.openParquetFile({
          identity: file,
          budget,
          diagnostics,
        }),
      );
      if (
        randomAccessFile?.identity_verified !== true ||
        randomAccessFile.byteLength !== file.byte_size ||
        randomAccessFile.sha256 !== file.sha256
      ) {
        throw new Error(`V3 source did not establish pinned file identity: ${file.key}`);
      }
      const footer = await measureAsync(
        workload,
        "footer_elapsed_ms",
        () => acquireFooter({
          randomAccessFile,
          file,
          footerCache,
          limits,
          diagnostics,
        }),
      );
      const plan = measureSync(
        workload,
        "parquet_planning_elapsed_ms",
        () => {
          const fileSegments = selectedSegments.filter((segment) =>
            segment.file_key === file.key
          );
          validateSegmentsAgainstFooter(fileSegments, file, footer);
          const rowGroupOrdinals = [...new Set(fileSegments.map((segment) =>
            segment.row_group_ordinal
          ))].sort((left, right) => left - right);
          const ranges = selectedColumnRanges({
            file,
            footer,
            rowGroupOrdinals,
            diagnostics,
          });
          const coalesced = coalesceObservationHistoryV3ByteRanges(ranges, {
            maxGapBytes: limits.coalesce_max_gap_bytes,
            maxMergedBytes: limits.coalesce_max_merged_bytes,
          });
          return { fileSegments, rowGroupOrdinals, ranges, coalesced };
        },
      );
      plannedDecodedRows += sum(plan.rowGroupOrdinals.map((ordinal) =>
        footer.rowGroupRows[ordinal]
      ));
      if (workload) workload.planned_ranges += plan.coalesced.length;
      diagnostics.range_coalesces += plan.ranges.length - plan.coalesced.length;
      contexts.set(file.key, {
        file,
        randomAccessFile,
        footer,
        fileSegments: plan.fileSegments,
        ranges: plan.ranges,
        coalesced: plan.coalesced,
      });
    }
    assertPlanLimit(plannedDecodedRows, limits.max_decoded_rows, "decoded-row count");
    diagnostics.rows_decoded = plannedDecodedRows;

    const decodedRows = [];
    for (const context of contexts.values()) {
      const blocks = await measureAsync(
        workload,
        "data_read_elapsed_ms",
        () => readObservationHistoryV3ByteRanges({
          file: context.randomAccessFile,
          ranges: context.coalesced,
          concurrency: limits.max_concurrency,
          budget,
        }),
      );
      const prefetchedFile = createPrefetchedObservationHistoryV3AsyncBuffer({
        file: context.randomAccessFile,
        blocks,
      });
      for (const segment of context.fileSegments) {
        const rows = await measureAsync(
          workload,
          "parquet_decode_elapsed_ms",
          () => parquetReadObjects({
            file: prefetchedFile,
            metadata: context.footer.metadata,
            compressors,
            columns: [...OBSERVATION_HISTORY_V3_PROJECTED_COLUMNS],
            rowStart: segment.row_start,
            rowEnd: segment.row_start + segment.row_count,
            useOffsetIndex: false,
          }),
        );
        decodedRows.push(...measureSync(
          workload,
          "final_filter_validation_elapsed_ms",
          () => validateDecodedSegment(
            rows,
            segment,
            normalizedTimeseriesId,
          ),
        ));
      }
    }

    const rows = measureSync(
      workload,
      "final_filter_validation_elapsed_ms",
      () => {
        let previousTimestamp = null;
        const filtered = [];
        for (const row of decodedRows) {
          if (previousTimestamp !== null && row.observed_at_utc < previousTimestamp) {
            throw new Error("V3 decoded rows regress across exact segments");
          }
          previousTimestamp = row.observed_at_utc;
          const timestampMs = Date.parse(row.observed_at_utc);
          if (timestampMs >= startMs && timestampMs < endMs) filtered.push(row);
        }
        return filtered;
      },
    );
    if (rows.length > limits.max_response_rows) {
      throw new Error("V3 response-row budget exceeded after exact filtering");
    }
    diagnostics.rows_returned = rows.length;
    if (workload) workload.rows_surviving_filter = rows.length;
    const budgetSnapshot = budget.snapshot();
    diagnostics.r2_range_reads = budgetSnapshot.range_reads;
    diagnostics.r2_bytes_requested = budgetSnapshot.bytes_requested;
    const partialReasons = [...incompleteReasons];
    const complete = partialReasons.length === 0;
    diagnostics.partial_or_fail_closed_reason = complete
      ? null
      : partialReasons.join(",");
    finalizeWorkloadDiagnostics(workload, totalStartedAt);
    return Object.freeze({
      index_generation: OBSERVATION_HISTORY_V3_INDEX_GENERATION,
      history_version: OBSERVATION_HISTORY_V3_LOGICAL_HISTORY_VERSION,
      timeseries_id: normalizedTimeseriesId,
      connector_id: scopeBase.connector_id,
      pollutant_code: scopeBase.pollutant_code,
      start_utc: startIso,
      end_utc: endIso,
      response_complete: complete,
      has_gap: !complete,
      partial_reasons: Object.freeze(partialReasons),
      rows: Object.freeze(rows),
      diagnostics: Object.freeze({ ...diagnostics }),
    });
  } catch (error) {
    if (budget) {
      const budgetSnapshot = budget.snapshot();
      diagnostics.r2_range_reads = budgetSnapshot.range_reads;
      diagnostics.r2_bytes_requested = budgetSnapshot.bytes_requested;
    }
    diagnostics.partial_or_fail_closed_reason = error instanceof Error
      ? error.message
      : String(error);
    finalizeWorkloadDiagnostics(workload, totalStartedAt);
    if (error instanceof ObservationHistoryV3ReadError) throw error;
    throw new ObservationHistoryV3ReadError(
      "v3_exact_read_failed",
      diagnostics.partial_or_fail_closed_reason,
      diagnostics,
      { cause: error },
    );
  }
}
