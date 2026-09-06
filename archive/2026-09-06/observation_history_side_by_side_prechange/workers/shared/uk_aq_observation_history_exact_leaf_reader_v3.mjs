// @ts-nocheck -- shared exact-timeseries physical-leaf reader for index_v3.
import { readColumn } from "hyparquet/src/column.js";
import { DEFAULT_PARSERS } from "hyparquet/src/convert.js";
import { flatten } from "hyparquet/src/utils.js";
import { compressors } from "hyparquet-compressors";

import {
  coalesceObservationHistoryV3ByteRanges,
  createObservationHistoryV3RangeBudget,
  readObservationHistoryV3ByteRanges,
  sha256ObservationHistoryV3Bytes,
} from "./uk_aq_observation_history_random_access_v3.mjs";

const DAY_MS = 86_400_000;
const MAX_LOGICAL_REQUEST_MS = DAY_MS;
const MAX_PHYSICAL_SEGMENT_ROWS = 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_OBJECTS = 4;
const MAX_RANGE_READS = 2;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_MERGED_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_RANGE_CONCURRENCY = 2;
const MAX_CURSOR_LENGTH = 12_288;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const COLUMN_NAMES = Object.freeze(["observed_at_utc", "value"]);
const CURSOR_KIND = "uk_aq_observation_history_exact_leaf_physical_cursor";
const CURSOR_SCHEMA_VERSION = 2;
const PAGINATION_PARTIAL_REASON = "physical_pagination_incomplete";
const SUPPORTED_DECODE_PROFILE_ID = "hyparquet-direct-column-v1";
const SUPPORTED_DECODE_PROFILE = Object.freeze({
  version: SUPPORTED_DECODE_PROFILE_ID,
  hyparquet_version: "1.25.1",
  page_headers: "included_in_column_chunk_ranges",
  root_schema_element: Object.freeze({
    repetition_type: "REQUIRED",
    name: "schema",
    num_children: 7,
  }),
  columns: Object.freeze({
    observed_at_utc: Object.freeze({
      physical_type: "INT64",
      codec: "ZSTD",
      schema_element: Object.freeze({
        type: "INT64",
        repetition_type: "OPTIONAL",
        name: "observed_at_utc",
        converted_type: "TIMESTAMP_MILLIS",
        logical_type: Object.freeze({
          type: "TIMESTAMP",
          isAdjustedToUTC: false,
          unit: "MILLIS",
        }),
      }),
    }),
    value: Object.freeze({
      physical_type: "DOUBLE",
      codec: "ZSTD",
      schema_element: Object.freeze({
        type: "DOUBLE",
        repetition_type: "OPTIONAL",
        name: "value",
      }),
    }),
  }),
});

export class ObservationHistoryExactLeafReadError extends Error {
  constructor(message, diagnostics, { code = "observation_history_exact_leaf_read_failed", cause } = {}) {
    super(message, { cause });
    this.name = "ObservationHistoryExactLeafReadError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function required(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value, label, { zero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (zero ? number < 0 : number <= 0)) {
    throw new Error(`${label} must be a ${zero ? "non-negative" : "positive"} safe integer`);
  }
  return number;
}

function iso(value, label) {
  const milliseconds = Date.parse(required(value, label));
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(milliseconds).toISOString();
}

function parseJson(body, label) {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function exactBody(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new Error("index body must be ArrayBuffer bytes");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("physical_cursor_invalid", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw codedError("physical_cursor_invalid", `${label} fields are invalid`);
  }
}

function scopePath({ dayUtc, connectorId, pollutantCode }) {
  return `day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
}

function dayList(startMs, endMs) {
  const days = [];
  let cursor = Math.floor(startMs / DAY_MS) * DAY_MS;
  const last = Math.floor((endMs - 1) / DAY_MS) * DAY_MS;
  for (; cursor <= last; cursor += DAY_MS) days.push(new Date(cursor).toISOString().slice(0, 10));
  return days;
}

function normalizeIndex(index) {
  const additionalCommonFields = index?.additionalCommonFields;
  if (
    !additionalCommonFields ||
    typeof additionalCommonFields !== "object" ||
    Array.isArray(additionalCommonFields)
  ) throw new Error("index.additionalCommonFields must be an object");
  const normalized = Object.freeze({
    root: required(index.root, "index.root").replace(/^\/+|\/+$/g, ""),
    alignedIndexRoot: required(index.alignedIndexRoot, "index.alignedIndexRoot").replace(/^\/+|\/+$/g, ""),
    alignedDataRoot: required(index.alignedDataRoot, "index.alignedDataRoot").replace(/^\/+|\/+$/g, ""),
    indexGeneration: required(index.indexGeneration, "index.indexGeneration"),
    historyVersion: required(index.historyVersion, "index.historyVersion"),
    historySchemaVersion: positiveInteger(index.historySchemaVersion, "index.historySchemaVersion"),
    writerVersion: required(index.writerVersion, "index.writerVersion"),
    physicalLayoutVersion: required(index.physicalLayoutVersion, "index.physicalLayoutVersion"),
    alignedRowCap: positiveInteger(index.alignedRowCap, "index.alignedRowCap"),
    decodeProfileId: required(index.decodeProfileId, "index.decodeProfileId"),
    manifestKind: required(index.manifestKind, "index.manifestKind"),
    leafKind: required(index.leafKind, "index.leafKind"),
    additionalCommonFields: Object.freeze({ ...additionalCommonFields }),
  });
  if (
    normalized.historyVersion !== "v2" ||
    normalized.physicalLayoutVersion !== "timeseries-aligned-v2" ||
    normalized.alignedRowCap !== MAX_PHYSICAL_SEGMENT_ROWS ||
    normalized.decodeProfileId !== SUPPORTED_DECODE_PROFILE_ID
  ) throw new Error("unsupported exact-leaf logical/layout identity");
  return normalized;
}

async function assertBodyIdentity(object, descriptor, label) {
  const body = exactBody(object.body);
  if (body.byteLength !== positiveInteger(descriptor.byte_size, `${label}.byte_size`)) {
    throw new Error(`${label} byte-size identity mismatch`);
  }
  if (!SHA256.test(String(descriptor.sha256 || ""))) throw new Error(`${label} SHA-256 is invalid`);
  if (await sha256ObservationHistoryV3Bytes(body) !== descriptor.sha256) {
    throw new Error(`${label} SHA-256 identity mismatch`);
  }
  return body;
}

function assertCommonIndex(payload, expected, kind, index) {
  if (
    payload?.schema_version !== 1 ||
    payload?.kind !== kind ||
    payload?.index_generation !== index.indexGeneration ||
    payload?.history_version !== index.historyVersion ||
    payload?.domain !== "observations" ||
    payload?.history_schema_version !== index.historySchemaVersion ||
    payload?.writer_version !== index.writerVersion ||
    payload?.physical_layout_version !== index.physicalLayoutVersion ||
    payload?.aligned_row_cap !== index.alignedRowCap ||
    payload?.day_utc !== expected.dayUtc ||
    payload?.connector_id !== expected.connectorId ||
    payload?.pollutant_code !== expected.pollutantCode ||
    Object.entries(index.additionalCommonFields).some(([field, value]) => payload?.[field] !== value)
  ) throw new Error(`unsupported or contradictory ${kind}`);
}

function expectedLeafKey(root, scope, timeseriesId) {
  return `${root}/${scope}/timeseries_id=${String(timeseriesId).padStart(9, "0")}.json`;
}

function validateIdentity(raw, label) {
  const key = required(raw?.key, `${label}.key`);
  const byteSize = positiveInteger(raw?.byte_size, `${label}.byte_size`);
  const sha256 = String(raw?.sha256 || "");
  if (!SHA256.test(sha256)) throw new Error(`${label}.sha256 is invalid`);
  return Object.freeze({ key, byte_size: byteSize, sha256 });
}

function validateProfile(profile) {
  if (
    profile?.version !== SUPPORTED_DECODE_PROFILE.version ||
    profile?.hyparquet_version !== SUPPORTED_DECODE_PROFILE.hyparquet_version ||
    profile?.page_headers !== SUPPORTED_DECODE_PROFILE.page_headers ||
    profile?.root_schema_element?.name !== SUPPORTED_DECODE_PROFILE.root_schema_element.name ||
    profile.root_schema_element.repetition_type !== SUPPORTED_DECODE_PROFILE.root_schema_element.repetition_type ||
    profile.root_schema_element.num_children !== SUPPORTED_DECODE_PROFILE.root_schema_element.num_children
  ) throw new Error("unsupported physical decode profile");
  const expected = {
    observed_at_utc: { physical: "INT64", converted: "TIMESTAMP_MILLIS" },
    value: { physical: "DOUBLE", converted: undefined },
  };
  for (const name of COLUMN_NAMES) {
    const column = profile.columns?.[name];
    if (
      column?.physical_type !== expected[name].physical ||
      column?.codec !== "ZSTD" ||
      column?.schema_element?.name !== name ||
      column.schema_element.type !== expected[name].physical ||
      column.schema_element.repetition_type !== "OPTIONAL" ||
      column.schema_element.converted_type !== expected[name].converted ||
      (name === "observed_at_utc" && (
        column.schema_element.logical_type?.type !== "TIMESTAMP" ||
        column.schema_element.logical_type?.isAdjustedToUTC !== false ||
        column.schema_element.logical_type?.unit !== "MILLIS"
      )) ||
      (name === "value" && column.schema_element.logical_type !== undefined)
    ) throw new Error(`unsupported physical decode profile for ${name}`);
  }
  return SUPPORTED_DECODE_PROFILE;
}

function validateFile(raw, expectedScope, index) {
  const key = required(raw?.key, "file.key");
  if (
    !key.startsWith(`${index.alignedDataRoot}/`) ||
    !key.includes(`/${scopePath(expectedScope)}/`) ||
    !key.endsWith(".parquet")
  ) throw new Error(`exact leaf points outside its pinned aligned scope: ${key}`);
  const sha256 = String(raw.sha256 || "");
  if (!SHA256.test(sha256)) throw new Error(`file SHA-256 is invalid: ${key}`);
  return Object.freeze({
    key,
    byte_size: positiveInteger(raw.byte_size, "file.byte_size"),
    sha256,
    row_count: positiveInteger(raw.row_count, "file.row_count"),
    row_group_count: positiveInteger(raw.row_group_count, "file.row_group_count"),
  });
}

function validateRange(raw, file, rowCount, label) {
  const start = positiveInteger(raw?.start, `${label}.start`, { zero: true });
  const end = positiveInteger(raw?.end, `${label}.end`);
  const dataPageOffset = positiveInteger(raw?.data_page_offset, `${label}.data_page_offset`, { zero: true });
  const dictionaryPageOffset = raw?.dictionary_page_offset === null
    ? null
    : positiveInteger(raw?.dictionary_page_offset, `${label}.dictionary_page_offset`, { zero: true });
  if (
    start >= end ||
    end > file.byte_size ||
    dataPageOffset < start ||
    dataPageOffset >= end ||
    (dictionaryPageOffset !== null && (dictionaryPageOffset !== start || dictionaryPageOffset >= dataPageOffset)) ||
    (dictionaryPageOffset === null && start !== dataPageOffset) ||
    positiveInteger(raw?.num_values, `${label}.num_values`) !== rowCount
  ) throw new Error(`${label} is outside or contradicts its pinned file`);
  return Object.freeze({
    start,
    end,
    data_page_offset: dataPageOffset,
    dictionary_page_offset: dictionaryPageOffset,
  });
}

function validateManifest(payload, expected, key, scope, index) {
  assertCommonIndex(payload, expected, index.manifestKind, index);
  if (
    payload.key !== key ||
    JSON.stringify(payload.leaf_descriptor_fields) !== JSON.stringify(["key", "byte_size", "sha256"]) ||
    !payload.leaves_by_timeseries_id ||
    typeof payload.leaves_by_timeseries_id !== "object" ||
    Array.isArray(payload.leaves_by_timeseries_id)
  ) throw new Error("exact-leaf scoped manifest key or lookup is contradictory");
  const profile = validateProfile(payload.decode_profile);
  const lookupKeys = Object.keys(payload.leaves_by_timeseries_id);
  if (
    positiveInteger(payload.coverage?.timeseries_count, "coverage.timeseries_count") !== lookupKeys.length ||
    positiveInteger(payload.coverage?.row_count, "coverage.row_count") < lookupKeys.length ||
    lookupKeys.some((value) => {
      const number = Number(value);
      return !Number.isSafeInteger(number) || number <= 0 || String(number) !== value;
    })
  ) throw new Error("exact-leaf scoped manifest coverage is contradictory");
  const coverageMin = iso(payload.coverage?.min_observed_at_utc, "coverage.min_observed_at_utc");
  const coverageMax = iso(payload.coverage?.max_observed_at_utc, "coverage.max_observed_at_utc");
  if (coverageMin > coverageMax) throw new Error("exact-leaf scoped manifest coverage bounds are contradictory");
  const sourceManifest = validateIdentity(payload.source_aligned_scoped_manifest, "source_aligned_scoped_manifest");
  if (sourceManifest.key !== `${index.alignedIndexRoot}/${scope}/manifest.json`) {
    throw new Error("exact-leaf source aligned scoped-manifest key is contradictory");
  }
  const raw = payload.leaves_by_timeseries_id[String(expected.timeseriesId)];
  if (raw === undefined) return { profile, descriptor: null };
  if (!Array.isArray(raw) || raw.length !== 3) throw new Error("exact-leaf descriptor tuple is contradictory");
  const descriptor = validateIdentity(
    { key: raw[0], byte_size: raw[1], sha256: raw[2] },
    "selected exact-leaf descriptor",
  );
  if (descriptor.key !== expectedLeafKey(index.root, scope, expected.timeseriesId)) {
    throw new Error("exact-leaf descriptor key is contradictory");
  }
  return { profile, descriptor };
}

function validateLeaf(payload, expected, descriptor, profile, index) {
  assertCommonIndex(payload, expected, index.leafKind, index);
  if (
    payload.key !== descriptor.key ||
    payload.timeseries_id !== expected.timeseriesId ||
    payload.timeseries !== undefined ||
    payload.decode_profile !== undefined ||
    !Array.isArray(payload.files) ||
    !Array.isArray(payload.segments)
  ) throw new Error("exact physical leaf identity or shape is contradictory");
  if (!Number.isSafeInteger(payload.row_count) || payload.row_count <= 0) {
    throw new Error("exact physical leaf row count is invalid");
  }
  const leafMin = iso(payload.min_observed_at_utc, "leaf.min_observed_at_utc");
  const leafMax = iso(payload.max_observed_at_utc, "leaf.max_observed_at_utc");
  const dayStart = `${expected.dayUtc}T00:00:00.000Z`;
  const dayEnd = new Date(Date.parse(dayStart) + DAY_MS).toISOString();
  if (leafMin > leafMax || leafMin < dayStart || leafMax >= dayEnd) {
    throw new Error("exact physical leaf bounds are contradictory to its UTC-day scope");
  }
  const sourceChild = validateIdentity(payload.source_aligned_child, "source_aligned_child");
  const alignedScopeRoot = `${index.alignedIndexRoot}/${scopePath(expected)}`;
  if (
    !sourceChild.key.startsWith(`${alignedScopeRoot}/range=`) ||
    !/\/range=\d+-\d+\.json$/.test(sourceChild.key)
  ) throw new Error("exact physical leaf source aligned child is contradictory");

  const files = new Map(payload.files.map((raw) => {
    const file = validateFile(raw, expected, index);
    return [file.key, file];
  }));
  if (files.size !== payload.files.length) throw new Error("duplicate exact-leaf file descriptor");

  let totalRows = 0;
  let previousMax = null;
  const coordinates = new Set();
  const usedFileKeys = new Set();
  const segments = payload.segments.map((raw, segmentIndex) => {
    const file = files.get(raw.file_key);
    if (!file) throw new Error("exact-leaf segment references an undeclared file");
    usedFileKeys.add(file.key);
    const rowCount = positiveInteger(raw.row_count, `segments[${segmentIndex}].row_count`);
    const rowGroupOrdinal = positiveInteger(
      raw.row_group_ordinal,
      `segments[${segmentIndex}].row_group_ordinal`,
      { zero: true },
    );
    if (
      rowCount > MAX_PHYSICAL_SEGMENT_ROWS ||
      rowGroupOrdinal >= file.row_group_count ||
      raw.row_group_row_start !== 0
    ) throw new Error("exact-leaf segment is not a complete cap-1024 row group");
    const coordinate = `${file.key}#${rowGroupOrdinal}#${raw.row_start}`;
    if (coordinates.has(coordinate)) throw new Error(`duplicate exact-leaf segment coordinate: ${coordinate}`);
    coordinates.add(coordinate);
    const min = iso(raw.min_observed_at_utc, `segments[${segmentIndex}].min_observed_at_utc`);
    const max = iso(raw.max_observed_at_utc, `segments[${segmentIndex}].max_observed_at_utc`);
    if (
      min > max ||
      min < dayStart ||
      max >= dayEnd ||
      (previousMax !== null && min < previousMax)
    ) {
      throw new Error("exact-leaf segments are not chronological");
    }
    previousMax = max;
    totalRows += rowCount;
    return Object.freeze({
      day_utc: expected.dayUtc,
      leaf_key: descriptor.key,
      leaf_byte_size: descriptor.byte_size,
      leaf_sha256: descriptor.sha256,
      file,
      file_key: file.key,
      row_group_ordinal: rowGroupOrdinal,
      row_start: positiveInteger(raw.row_start, `segments[${segmentIndex}].row_start`, { zero: true }),
      row_count: rowCount,
      min_observed_at_utc: min,
      max_observed_at_utc: max,
      profile,
      column_ranges: Object.fromEntries(COLUMN_NAMES.map((name) => [
        name,
        validateRange(raw.column_ranges?.[name], file, rowCount, `segments[${segmentIndex}].${name}`),
      ])),
    });
  });
  if (
    totalRows !== payload.row_count ||
    usedFileKeys.size !== files.size ||
    segments[0]?.min_observed_at_utc !== leafMin ||
    segments.at(-1)?.max_observed_at_utc !== leafMax
  ) throw new Error("exact physical leaf coverage is contradictory");
  return segments;
}

function decoder(profile, name) {
  const column = profile.columns[name];
  const leaf = { element: column.schema_element, children: [], path: [name] };
  const root = { element: profile.root_schema_element, children: [leaf], path: [] };
  return {
    pathInSchema: [name],
    type: column.physical_type,
    element: column.schema_element,
    schemaPath: [root, leaf],
    codec: column.codec,
    parsers: DEFAULT_PARSERS,
    compressors,
    utf8: true,
  };
}

function decodeColumn(buffer, profile, name, rowCount) {
  const reader = { view: new DataView(buffer), offset: 0 };
  const result = readColumn(
    reader,
    { groupStart: 0, selectStart: 0, selectEnd: rowCount },
    decoder(profile, name),
  );
  const values = flatten(result.data);
  if (result.skipped !== 0 || values.length !== rowCount) {
    throw new Error(`direct ${name} decode did not produce the indexed row count`);
  }
  return values;
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const text = required(value, "physicalCursor");
  if (text.length > MAX_CURSOR_LENGTH || !BASE64URL.test(text)) {
    throw codedError("physical_cursor_invalid", "physical cursor encoding is invalid");
  }
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw codedError("physical_cursor_invalid", "physical cursor payload is invalid");
  }
}

function cursorRequestIdentity(request, index) {
  return Object.freeze({
    timeseries_id: request.timeseriesId,
    connector_id: request.connectorId,
    pollutant_code: request.pollutantCode,
    start_utc: request.startIso,
    end_utc: request.endIso,
    history_version: index.historyVersion,
    index_generation: index.indexGeneration,
    physical_layout_version: index.physicalLayoutVersion,
    writer_version: index.writerVersion,
    aligned_row_cap: index.alignedRowCap,
    decode_profile_id: index.decodeProfileId,
    index_root: index.root,
  });
}

function segmentCoordinateIdentity(segment) {
  return Object.freeze({
    file_key: segment.file_key,
    file_byte_size: segment.file.byte_size,
    file_sha256: segment.file.sha256,
    row_group_ordinal: segment.row_group_ordinal,
    row_start: segment.row_start,
    row_count: segment.row_count,
    min_observed_at_utc: segment.min_observed_at_utc,
    max_observed_at_utc: segment.max_observed_at_utc,
  });
}

function cursorSegmentIdentity(segment, pageNumber, scopeSegmentNumber) {
  return Object.freeze({
    page_number: pageNumber,
    scope_segment_number: scopeSegmentNumber,
    day_utc: segment.day_utc,
    leaf_key: segment.leaf_key,
    leaf_byte_size: segment.leaf_byte_size,
    leaf_sha256: segment.leaf_sha256,
    ...segmentCoordinateIdentity(segment),
  });
}

function encodeNextCursor(request, index, discovery, segment, pageNumber, scopeSegmentNumber) {
  return base64UrlEncode({
    schema_version: CURSOR_SCHEMA_VERSION,
    kind: CURSOR_KIND,
    request: cursorRequestIdentity(request, index),
    discovery,
    next: cursorSegmentIdentity(segment, pageNumber, scopeSegmentNumber),
  });
}

function validateCursorLeafDescriptor(raw, request, index, dayUtc, label) {
  exactKeys(raw, ["key", "byte_size", "sha256"], label);
  const descriptor = validateIdentity(raw, label);
  const scope = scopePath({
    dayUtc,
    connectorId: request.connectorId,
    pollutantCode: request.pollutantCode,
  });
  if (descriptor.key !== expectedLeafKey(index.root, scope, request.timeseriesId)) {
    throw codedError("physical_cursor_invalid", `${label} is outside its deterministic exact-leaf scope`);
  }
  return descriptor;
}

function validateCursorCoordinate(raw, request, index, dayUtc, label) {
  exactKeys(raw, [
    "file_key",
    "file_byte_size",
    "file_sha256",
    "row_group_ordinal",
    "row_start",
    "row_count",
    "min_observed_at_utc",
    "max_observed_at_utc",
  ], label);
  const fileKey = required(raw.file_key, `${label}.file_key`);
  const expectedScope = scopePath({
    dayUtc,
    connectorId: request.connectorId,
    pollutantCode: request.pollutantCode,
  });
  if (
    !fileKey.startsWith(`${index.alignedDataRoot}/`) ||
    !fileKey.includes(`/${expectedScope}/`) ||
    !fileKey.endsWith(".parquet")
  ) throw codedError("physical_cursor_invalid", `${label}.file_key is outside its deterministic aligned scope`);
  const fileSha256 = String(raw.file_sha256 || "");
  if (!SHA256.test(fileSha256)) {
    throw codedError("physical_cursor_invalid", `${label}.file_sha256 is invalid`);
  }
  const rowCount = positiveInteger(raw.row_count, `${label}.row_count`);
  const min = iso(raw.min_observed_at_utc, `${label}.min_observed_at_utc`);
  const max = iso(raw.max_observed_at_utc, `${label}.max_observed_at_utc`);
  const dayStart = `${dayUtc}T00:00:00.000Z`;
  const dayEnd = new Date(Date.parse(dayStart) + DAY_MS).toISOString();
  if (rowCount > MAX_PHYSICAL_SEGMENT_ROWS || min > max || min < dayStart || max >= dayEnd) {
    throw codedError("physical_cursor_invalid", `${label} contradicts its cap or UTC-day scope`);
  }
  return Object.freeze({
    file_key: fileKey,
    file_byte_size: positiveInteger(raw.file_byte_size, `${label}.file_byte_size`),
    file_sha256: fileSha256,
    row_group_ordinal: positiveInteger(raw.row_group_ordinal, `${label}.row_group_ordinal`, { zero: true }),
    row_start: positiveInteger(raw.row_start, `${label}.row_start`, { zero: true }),
    row_count: rowCount,
    min_observed_at_utc: min,
    max_observed_at_utc: max,
  });
}

function sameFields(left, right) {
  return Object.entries(left).every(([field, value]) => right?.[field] === value);
}

function validateCursorDiscovery(raw, request, index, startMs, endMs) {
  exactKeys(raw, [
    "coverage_complete",
    "coverage_partial_reasons",
    "total_intersecting_segments",
    "scopes",
  ], "physical cursor discovery");
  if (!Array.isArray(raw.scopes) || !Array.isArray(raw.coverage_partial_reasons)) {
    throw codedError("physical_cursor_invalid", "physical cursor discovery arrays are invalid");
  }
  const days = dayList(startMs, endMs);
  if (raw.scopes.length !== days.length || raw.scopes.length < 1 || raw.scopes.length > 2) {
    throw codedError("physical_cursor_invalid", "physical cursor discovery scope count is invalid");
  }
  const scopes = raw.scopes.map((scope, scopeIndex) => {
    const label = `physical cursor discovery.scopes[${scopeIndex}]`;
    exactKeys(scope, [
      "day_utc",
      "state",
      "leaf_descriptor",
      "intersecting_segment_count",
      "first_intersecting_segment",
    ], label);
    const dayUtc = required(scope.day_utc, `${label}.day_utc`);
    if (dayUtc !== days[scopeIndex]) {
      throw codedError("physical_cursor_invalid", `${label}.day_utc is contradictory`);
    }
    const state = required(scope.state, `${label}.state`);
    if (!["validated_leaf", "authoritative_absence", "missing_scope", "missing_leaf"].includes(state)) {
      throw codedError("physical_cursor_invalid", `${label}.state is invalid`);
    }
    const count = positiveInteger(
      scope.intersecting_segment_count,
      `${label}.intersecting_segment_count`,
      { zero: true },
    );
    const descriptor = scope.leaf_descriptor === null
      ? null
      : validateCursorLeafDescriptor(scope.leaf_descriptor, request, index, dayUtc, `${label}.leaf_descriptor`);
    const first = scope.first_intersecting_segment === null
      ? null
      : validateCursorCoordinate(scope.first_intersecting_segment, request, index, dayUtc, `${label}.first_intersecting_segment`);
    if (
      (state === "validated_leaf" && !descriptor) ||
      (state === "authoritative_absence" && (descriptor || count !== 0 || first)) ||
      (state === "missing_scope" && (descriptor || count !== 0 || first)) ||
      (state === "missing_leaf" && (!descriptor || count !== 0 || first)) ||
      (state === "validated_leaf" && ((count === 0) !== (first === null)))
    ) throw codedError("physical_cursor_invalid", `${label} state and pinned discovery fields contradict`);
    return Object.freeze({
      day_utc: dayUtc,
      state,
      leaf_descriptor: descriptor,
      intersecting_segment_count: count,
      first_intersecting_segment: first,
    });
  });
  const derivedReasons = [...new Set(scopes.flatMap((scope) => {
    if (scope.state === "missing_scope") return ["required_physical_leaf_scope_missing"];
    if (scope.state === "missing_leaf") return ["required_physical_timeseries_leaf_missing"];
    return [];
  }))];
  if (
    raw.coverage_complete !== (derivedReasons.length === 0) ||
    JSON.stringify(raw.coverage_partial_reasons) !== JSON.stringify(derivedReasons)
  ) throw codedError("physical_cursor_invalid", "physical cursor coverage summary is contradictory");
  const total = scopes.reduce((sum, scope) => sum + scope.intersecting_segment_count, 0);
  if (positiveInteger(raw.total_intersecting_segments, "physical cursor total_intersecting_segments", { zero: true }) !== total) {
    throw codedError("physical_cursor_invalid", "physical cursor intersecting-segment total is contradictory");
  }
  return Object.freeze({
    coverage_complete: raw.coverage_complete,
    coverage_partial_reasons: Object.freeze(derivedReasons),
    total_intersecting_segments: total,
    scopes: Object.freeze(scopes),
  });
}

function decodeAndValidateCursorRequest(physicalCursor, request, index, startMs, endMs) {
  if (physicalCursor === null || physicalCursor === undefined || physicalCursor === "") return null;
  const payload = base64UrlDecode(physicalCursor);
  exactKeys(payload, ["schema_version", "kind", "request", "discovery", "next"], "physical cursor");
  if (payload.schema_version !== CURSOR_SCHEMA_VERSION || payload.kind !== CURSOR_KIND) {
    throw codedError("physical_cursor_invalid", "physical cursor version or kind is invalid");
  }
  const expectedRequest = cursorRequestIdentity(request, index);
  exactKeys(payload.request, Object.keys(expectedRequest), "physical cursor request identity");
  for (const [field, expected] of Object.entries(expectedRequest)) {
    if (payload.request[field] !== expected) {
      throw codedError("physical_cursor_invalid", `physical cursor request field ${field} is contradictory`);
    }
  }
  const discovery = validateCursorDiscovery(payload.discovery, request, index, startMs, endMs);
  exactKeys(payload.next, [
    "page_number",
    "scope_segment_number",
    "day_utc",
    "leaf_key",
    "leaf_byte_size",
    "leaf_sha256",
    "file_key",
    "file_byte_size",
    "file_sha256",
    "row_group_ordinal",
    "row_start",
    "row_count",
    "min_observed_at_utc",
    "max_observed_at_utc",
  ], "physical cursor next segment");
  const pageNumber = Number(payload.next.page_number);
  if (!Number.isSafeInteger(pageNumber) || pageNumber <= 1) {
    throw codedError("physical_cursor_invalid", "physical cursor next page number is invalid");
  }
  const scopeSegmentNumber = Number(payload.next.scope_segment_number);
  if (!Number.isSafeInteger(scopeSegmentNumber) || scopeSegmentNumber <= 0) {
    throw codedError("physical_cursor_invalid", "physical cursor scope segment number is invalid");
  }
  const dayUtc = required(payload.next.day_utc, "physical cursor next.day_utc");
  const scopeIndex = discovery.scopes.findIndex((scope) => scope.day_utc === dayUtc);
  if (scopeIndex < 0) throw codedError("physical_cursor_invalid", "physical cursor next day is outside request discovery");
  const scope = discovery.scopes[scopeIndex];
  if (scope.state !== "validated_leaf" || scopeSegmentNumber > scope.intersecting_segment_count) {
    throw codedError("physical_cursor_invalid", "physical cursor next segment is outside its validated leaf scope");
  }
  const nextDescriptor = validateCursorLeafDescriptor({
    key: payload.next.leaf_key,
    byte_size: payload.next.leaf_byte_size,
    sha256: payload.next.leaf_sha256,
  }, request, index, dayUtc, "physical cursor next leaf descriptor");
  if (!sameFields(nextDescriptor, scope.leaf_descriptor)) {
    throw codedError("physical_cursor_invalid", "physical cursor next leaf descriptor contradicts discovery");
  }
  const nextCoordinate = validateCursorCoordinate({
    file_key: payload.next.file_key,
    file_byte_size: payload.next.file_byte_size,
    file_sha256: payload.next.file_sha256,
    row_group_ordinal: payload.next.row_group_ordinal,
    row_start: payload.next.row_start,
    row_count: payload.next.row_count,
    min_observed_at_utc: payload.next.min_observed_at_utc,
    max_observed_at_utc: payload.next.max_observed_at_utc,
  }, request, index, dayUtc, "physical cursor next coordinate");
  if (scopeSegmentNumber === 1 && !sameFields(nextCoordinate, scope.first_intersecting_segment)) {
    throw codedError("physical_cursor_invalid", "physical cursor first scope segment contradicts discovery");
  }
  const expectedPageNumber = discovery.scopes
    .slice(0, scopeIndex)
    .reduce((sum, item) => sum + item.intersecting_segment_count, 0) + scopeSegmentNumber;
  if (pageNumber !== expectedPageNumber || pageNumber > discovery.total_intersecting_segments) {
    throw codedError("physical_cursor_invalid", "physical cursor page number contradicts bounded discovery");
  }
  return Object.freeze({
    schema_version: CURSOR_SCHEMA_VERSION,
    kind: CURSOR_KIND,
    request: payload.request,
    discovery,
    next: Object.freeze({
      page_number: pageNumber,
      scope_segment_number: scopeSegmentNumber,
      day_utc: dayUtc,
      leaf_key: nextDescriptor.key,
      leaf_byte_size: nextDescriptor.byte_size,
      leaf_sha256: nextDescriptor.sha256,
      ...nextCoordinate,
    }),
    scope_index: scopeIndex,
  });
}

function diagnosticsTemplate() {
  return {
    schema_version: 1,
    logical_requested_start_utc: null,
    logical_requested_end_utc: null,
    physical_page_path: "initial_discovery",
    physical_page_number: 1,
    continuation_cursor_supplied: false,
    scoped_manifests_read: 0,
    whole_logical_range_segment_discovery: false,
    global_segment_sorting: false,
    candidate_intersecting_segments: 0,
    selected_chronological_segments: 0,
    selected_files: 0,
    selected_row_groups: 0,
    selected_segment_physical_identity: null,
    selected_segment_row_count: 0,
    physical_segments_decoded: 0,
    physical_rows_decoded: 0,
    returned_rows: 0,
    pagination_complete: true,
    continuation_returned: false,
    coverage_partial_reasons: [],
    parquet_footer_fetched: false,
    parquet_footer_parsed: false,
    timeseries_id_decoded: false,
    requested_physical_byte_ranges_by_column: { observed_at_utc: [], value: [] },
    r2_range_reads: 0,
    r2_bytes_requested: 0,
    identity_head_reads: 0,
    index_objects_read: 0,
    index_bytes_read: 0,
    timeseries_leaf_objects_read: 0,
    timeseries_leaf_bytes_read: 0,
    coarse_child_shards_read: 0,
    selected_coordinates: [],
  };
}

async function readIndex(source, key, diagnostics, { leaf = false, manifest = false } = {}) {
  if (diagnostics.index_objects_read >= MAX_INDEX_OBJECTS) {
    throw new Error("exact-leaf index object-count budget exceeded");
  }
  const object = await source.getIndexObject({ key, maxBytes: MAX_INDEX_BYTES, diagnostics });
  if (!object) return null;
  diagnostics.index_objects_read += 1;
  diagnostics.index_bytes_read += object.byte_size;
  if (manifest) diagnostics.scoped_manifests_read += 1;
  if (leaf) {
    diagnostics.timeseries_leaf_objects_read += 1;
    diagnostics.timeseries_leaf_bytes_read += object.byte_size;
  }
  return object;
}

function segmentIntersects(segment, startMs, endMs) {
  return Date.parse(segment.max_observed_at_utc) >= startMs &&
    Date.parse(segment.min_observed_at_utc) < endMs;
}

function compareSegments(left, right) {
  return left.min_observed_at_utc.localeCompare(right.min_observed_at_utc) ||
    left.day_utc.localeCompare(right.day_utc) ||
    left.file_key.localeCompare(right.file_key) ||
    left.row_group_ordinal - right.row_group_ordinal ||
    left.row_start - right.row_start;
}

function leafDescriptorSnapshot(descriptor) {
  return descriptor ? Object.freeze({
    key: descriptor.key,
    byte_size: descriptor.byte_size,
    sha256: descriptor.sha256,
  }) : null;
}

function createDiscoverySnapshot(scopes) {
  const coveragePartialReasons = [...new Set(scopes.flatMap((scope) => {
    if (scope.state === "missing_scope") return ["required_physical_leaf_scope_missing"];
    if (scope.state === "missing_leaf") return ["required_physical_timeseries_leaf_missing"];
    return [];
  }))];
  const snapshots = scopes.map((scope) => Object.freeze({
    day_utc: scope.day_utc,
    state: scope.state,
    leaf_descriptor: leafDescriptorSnapshot(scope.leaf_descriptor),
    intersecting_segment_count: scope.intersecting_segments.length,
    first_intersecting_segment: scope.intersecting_segments.length
      ? segmentCoordinateIdentity(scope.intersecting_segments[0])
      : null,
  }));
  return Object.freeze({
    coverage_complete: coveragePartialReasons.length === 0,
    coverage_partial_reasons: Object.freeze(coveragePartialReasons),
    total_intersecting_segments: snapshots.reduce(
      (sum, scope) => sum + scope.intersecting_segment_count,
      0,
    ),
    scopes: Object.freeze(snapshots),
  });
}

function segmentFromDiscoveryScope(scope) {
  const coordinate = scope.first_intersecting_segment;
  const descriptor = scope.leaf_descriptor;
  if (!coordinate || !descriptor) throw new Error("validated discovery scope omits its first physical segment");
  return Object.freeze({
    day_utc: scope.day_utc,
    leaf_key: descriptor.key,
    leaf_byte_size: descriptor.byte_size,
    leaf_sha256: descriptor.sha256,
    file_key: coordinate.file_key,
    file: Object.freeze({
      key: coordinate.file_key,
      byte_size: coordinate.file_byte_size,
      sha256: coordinate.file_sha256,
    }),
    row_group_ordinal: coordinate.row_group_ordinal,
    row_start: coordinate.row_start,
    row_count: coordinate.row_count,
    min_observed_at_utc: coordinate.min_observed_at_utc,
    max_observed_at_utc: coordinate.max_observed_at_utc,
  });
}

function compareCursorSelectedSegment(cursor, segment) {
  const expected = cursorSegmentIdentity(
    segment,
    cursor.next.page_number,
    cursor.next.scope_segment_number,
  );
  if (!sameFields(expected, cursor.next)) {
    throw codedError("physical_cursor_invalid", "physical cursor is stale or contradicts the pinned selected segment");
  }
}

export async function readObservationHistoryExactLeafPageV3({
  source,
  timeseriesId,
  connectorId,
  pollutantCode,
  startUtc,
  endUtc,
  physicalCursor = null,
  index,
}) {
  const diagnostics = diagnosticsTemplate();
  const budget = createObservationHistoryV3RangeBudget({
    maxRangeReads: MAX_RANGE_READS,
    maxBytesRequested: MAX_RANGE_BYTES,
  });
  try {
    if (!source || typeof source.getIndexObject !== "function" || typeof source.openParquetFile !== "function") {
      throw new Error("source must provide exact index and pinned Parquet access");
    }
    const normalizedIndex = normalizeIndex(index);
    const request = Object.freeze({
      timeseriesId: positiveInteger(timeseriesId, "timeseriesId"),
      connectorId: positiveInteger(connectorId, "connectorId"),
      pollutantCode: required(pollutantCode, "pollutantCode"),
      startIso: iso(startUtc, "startUtc"),
      endIso: iso(endUtc, "endUtc"),
    });
    const startMs = Date.parse(request.startIso);
    const endMs = Date.parse(request.endIso);
    diagnostics.logical_requested_start_utc = request.startIso;
    diagnostics.logical_requested_end_utc = request.endIso;
    if (endMs <= startMs) throw codedError("logical_range_invalid", "endUtc must be after startUtc");
    if (endMs - startMs > MAX_LOGICAL_REQUEST_MS) {
      throw codedError("logical_range_exceeds_24_hours", "logical observation-history range must not exceed 24 hours");
    }
    let decodedCursor;
    try {
      decodedCursor = decodeAndValidateCursorRequest(
        physicalCursor,
        request,
        normalizedIndex,
        startMs,
        endMs,
      );
    } catch (error) {
      if (error?.code === "physical_cursor_invalid") throw error;
      throw codedError("physical_cursor_invalid", error instanceof Error ? error.message : String(error));
    }
    diagnostics.continuation_cursor_supplied = Boolean(decodedCursor);
    let discovery;
    let selectedSegment = null;
    let nextSegment = null;
    let pageNumber = 1;
    let scopeSegmentNumber = 1;
    let nextScopeSegmentNumber = null;

    if (!decodedCursor) {
      diagnostics.physical_page_path = "initial_discovery";
      diagnostics.whole_logical_range_segment_discovery = true;
      diagnostics.global_segment_sorting = true;
      const scopeRecords = [];
      const intersectingSegments = [];
      for (const dayUtc of dayList(startMs, endMs)) {
        const expected = { ...request, dayUtc };
        const scope = scopePath(expected);
        const manifestKey = `${normalizedIndex.root}/${scope}/manifest.json`;
        const manifestObject = await readIndex(source, manifestKey, diagnostics, { manifest: true });
        if (!manifestObject) {
          scopeRecords.push({
            day_utc: dayUtc,
            state: "missing_scope",
            leaf_descriptor: null,
            intersecting_segments: [],
          });
          continue;
        }
        const manifest = validateManifest(
          parseJson(manifestObject.body, manifestKey),
          expected,
          manifestKey,
          scope,
          normalizedIndex,
        );
        if (!manifest.descriptor) {
          scopeRecords.push({
            day_utc: dayUtc,
            state: "authoritative_absence",
            leaf_descriptor: null,
            intersecting_segments: [],
          });
          continue;
        }
        const leafObject = await readIndex(source, manifest.descriptor.key, diagnostics, { leaf: true });
        if (!leafObject) {
          scopeRecords.push({
            day_utc: dayUtc,
            state: "missing_leaf",
            leaf_descriptor: manifest.descriptor,
            intersecting_segments: [],
          });
          continue;
        }
        const leafBody = await assertBodyIdentity(leafObject, manifest.descriptor, "exact physical leaf");
        const segments = validateLeaf(
          parseJson(leafBody, manifest.descriptor.key),
          expected,
          manifest.descriptor,
          manifest.profile,
          normalizedIndex,
        );
        const scopedSegments = segments
          .filter((segment) => segmentIntersects(segment, startMs, endMs))
          .sort(compareSegments)
          .map((segment, index) => Object.freeze({ ...segment, scope_segment_number: index + 1 }));
        scopeRecords.push({
          day_utc: dayUtc,
          state: "validated_leaf",
          leaf_descriptor: manifest.descriptor,
          intersecting_segments: scopedSegments,
        });
        intersectingSegments.push(...scopedSegments);
      }
      intersectingSegments.sort(compareSegments);
      discovery = createDiscoverySnapshot(scopeRecords);
      selectedSegment = intersectingSegments[0] || null;
      nextSegment = intersectingSegments[1] || null;
      scopeSegmentNumber = selectedSegment?.scope_segment_number || 1;
      nextScopeSegmentNumber = nextSegment?.scope_segment_number || null;
    } else {
      discovery = decodedCursor.discovery;
      pageNumber = decodedCursor.next.page_number;
      scopeSegmentNumber = decodedCursor.next.scope_segment_number;
      const currentScope = discovery.scopes[decodedCursor.scope_index];
      diagnostics.physical_page_path = scopeSegmentNumber === 1
        ? "cross_scope_continuation"
        : "direct_leaf_continuation";
      const expected = { ...request, dayUtc: currentScope.day_utc };
      const descriptor = currentScope.leaf_descriptor;
      const leafObject = await readIndex(source, descriptor.key, diagnostics, { leaf: true });
      if (!leafObject) {
        throw codedError("physical_cursor_invalid", "physical cursor pinned leaf is now missing");
      }
      let leafBody;
      try {
        leafBody = await assertBodyIdentity(leafObject, descriptor, "physical cursor pinned exact leaf");
      } catch (error) {
        throw codedError(
          "physical_cursor_invalid",
          `physical cursor pinned leaf identity is stale: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const segments = validateLeaf(
        parseJson(leafBody, descriptor.key),
        expected,
        descriptor,
        SUPPORTED_DECODE_PROFILE,
        normalizedIndex,
      );
      const scopedSegments = segments
        .filter((segment) => segmentIntersects(segment, startMs, endMs))
        .sort(compareSegments);
      if (
        scopedSegments.length !== currentScope.intersecting_segment_count ||
        (scopedSegments.length > 0 && !sameFields(
          segmentCoordinateIdentity(scopedSegments[0]),
          currentScope.first_intersecting_segment,
        ))
      ) throw codedError("physical_cursor_invalid", "physical cursor discovery is stale for its pinned exact leaf");
      selectedSegment = scopedSegments[scopeSegmentNumber - 1] || null;
      if (!selectedSegment) {
        throw codedError("physical_cursor_invalid", "physical cursor selected segment no longer exists");
      }
      compareCursorSelectedSegment(decodedCursor, selectedSegment);
      if (scopeSegmentNumber < scopedSegments.length) {
        nextSegment = scopedSegments[scopeSegmentNumber];
        nextScopeSegmentNumber = scopeSegmentNumber + 1;
      } else {
        const nextScope = discovery.scopes
          .slice(decodedCursor.scope_index + 1)
          .find((scope) => scope.intersecting_segment_count > 0);
        if (nextScope) {
          nextSegment = segmentFromDiscoveryScope(nextScope);
          nextScopeSegmentNumber = 1;
        }
      }
    }

    diagnostics.candidate_intersecting_segments = discovery.total_intersecting_segments;
    diagnostics.physical_page_number = pageNumber;

    const decoded = [];
    if (selectedSegment) {
      diagnostics.selected_chronological_segments = 1;
      diagnostics.selected_files = 1;
      diagnostics.selected_row_groups = 1;
      diagnostics.selected_segment_physical_identity = cursorSegmentIdentity(
        selectedSegment,
        pageNumber,
        scopeSegmentNumber,
      );
      diagnostics.selected_segment_row_count = selectedSegment.row_count;
      diagnostics.physical_segments_decoded = 1;
      diagnostics.physical_rows_decoded = selectedSegment.row_count;
      diagnostics.selected_coordinates.push({
        day_utc: selectedSegment.day_utc,
        file_key: selectedSegment.file_key,
        row_group_ordinal: selectedSegment.row_group_ordinal,
        row_start: selectedSegment.row_start,
        row_count: selectedSegment.row_count,
        min_observed_at_utc: selectedSegment.min_observed_at_utc,
        max_observed_at_utc: selectedSegment.max_observed_at_utc,
      });
      for (const name of COLUMN_NAMES) {
        const range = selectedSegment.column_ranges[name];
        diagnostics.requested_physical_byte_ranges_by_column[name].push({
          file_key: selectedSegment.file_key,
          row_group_ordinal: selectedSegment.row_group_ordinal,
          start: range.start,
          end: range.end,
        });
      }

      const file = await source.openParquetFile({
        identity: selectedSegment.file,
        budget,
        diagnostics,
      });
      const requested = COLUMN_NAMES.map((name) => ({
        id: `${selectedSegment.row_group_ordinal}:${name}`,
        ...selectedSegment.column_ranges[name],
      }));
      const coalesced = coalesceObservationHistoryV3ByteRanges(requested, {
        maxGapBytes: 0,
        maxMergedBytes: MAX_MERGED_RANGE_BYTES,
      });
      const blocks = await readObservationHistoryV3ByteRanges({
        file,
        ranges: coalesced,
        concurrency: MAX_RANGE_CONCURRENCY,
        budget,
      });
      const bytesFor = (range) => {
        const block = blocks.find((candidate) => candidate.start <= range.start && range.end <= candidate.end);
        if (!block) throw new Error("exact-leaf column range was not prefetched");
        return block.buffer.slice(range.start - block.start, range.end - block.start);
      };
      const timestamps = decodeColumn(
        bytesFor(selectedSegment.column_ranges.observed_at_utc),
        selectedSegment.profile,
        "observed_at_utc",
        selectedSegment.row_count,
      );
      const values = decodeColumn(
        bytesFor(selectedSegment.column_ranges.value),
        selectedSegment.profile,
        "value",
        selectedSegment.row_count,
      );
      let previous = null;
      for (let rowIndex = 0; rowIndex < selectedSegment.row_count; rowIndex += 1) {
        const observedAt = timestamps[rowIndex] instanceof Date
          ? timestamps[rowIndex].toISOString()
          : iso(timestamps[rowIndex], "decoded timestamp");
        const value = Number(values[rowIndex]);
        if (
          !Number.isFinite(value) ||
          observedAt < selectedSegment.min_observed_at_utc ||
          observedAt > selectedSegment.max_observed_at_utc ||
          (previous !== null && observedAt < previous)
        ) throw new Error("decoded row contradicts exact-leaf segment metadata");
        previous = observedAt;
        const timestamp = Date.parse(observedAt);
        if (timestamp >= startMs && timestamp < endMs) {
          decoded.push({ timeseries_id: request.timeseriesId, observed_at_utc: observedAt, value });
        }
      }
    }

    const paginationComplete = !selectedSegment || pageNumber >= discovery.total_intersecting_segments;
    if (!paginationComplete && (!nextSegment || !nextScopeSegmentNumber)) {
      throw new Error("validated physical discovery omits its required next segment");
    }
    const nextCursor = paginationComplete
      ? null
      : encodeNextCursor(
          request,
          normalizedIndex,
          discovery,
          nextSegment,
          pageNumber + 1,
          nextScopeSegmentNumber,
        );
    const coverageReasons = [...discovery.coverage_partial_reasons];
    const partialReasons = [...coverageReasons, ...(paginationComplete ? [] : [PAGINATION_PARTIAL_REASON])];
    const coverageComplete = coverageReasons.length === 0;
    const responseComplete = coverageComplete && paginationComplete;
    diagnostics.returned_rows = decoded.length;
    diagnostics.pagination_complete = paginationComplete;
    diagnostics.continuation_returned = Boolean(nextCursor);
    diagnostics.coverage_partial_reasons = coverageReasons;
    const snapshot = budget.snapshot();
    diagnostics.r2_range_reads = snapshot.range_reads;
    diagnostics.r2_bytes_requested = snapshot.bytes_requested;
    return Object.freeze({
      rows: Object.freeze(decoded),
      response_complete: responseComplete,
      has_gap: !coverageComplete,
      coverage_complete: coverageComplete,
      coverage_partial_reasons: Object.freeze(coverageReasons),
      partial_reasons: Object.freeze(partialReasons),
      physical_page: Object.freeze({
        schema_version: 2,
        page_number: pageNumber,
        continuation_cursor_supplied: Boolean(decodedCursor),
        physical_page_path: diagnostics.physical_page_path,
        candidate_intersecting_segments: discovery.total_intersecting_segments,
        segments_decoded: selectedSegment ? 1 : 0,
        physical_rows_decoded: selectedSegment?.row_count || 0,
        pagination_complete: paginationComplete,
        next_cursor: nextCursor,
      }),
      diagnostics: Object.freeze(diagnostics),
    });
  } catch (error) {
    const snapshot = budget.snapshot();
    diagnostics.r2_range_reads = snapshot.range_reads;
    diagnostics.r2_bytes_requested = snapshot.bytes_requested;
    throw new ObservationHistoryExactLeafReadError(
      error instanceof Error ? error.message : String(error),
      Object.freeze(diagnostics),
      {
        code: typeof error?.code === "string" ? error.code : "observation_history_exact_leaf_read_failed",
        cause: error,
      },
    );
  }
}

export const OBSERVATION_HISTORY_EXACT_LEAF_LIMITS = Object.freeze({
  max_logical_request_ms: MAX_LOGICAL_REQUEST_MS,
  max_physical_segments_per_invocation: 1,
  max_physical_segment_rows: MAX_PHYSICAL_SEGMENT_ROWS,
  physical_cursor_schema_version: CURSOR_SCHEMA_VERSION,
  max_physical_cursor_characters: MAX_CURSOR_LENGTH,
});

export const OBSERVATION_HISTORY_EXACT_LEAF_PAGINATION_REASON = PAGINATION_PARTIAL_REASON;
