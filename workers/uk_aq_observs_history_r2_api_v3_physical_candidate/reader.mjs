// @ts-nocheck -- isolated TEST-only physical-index candidate.
import { readColumn } from "hyparquet/src/column.js";
import { DEFAULT_PARSERS } from "hyparquet/src/convert.js";
import { flatten } from "hyparquet/src/utils.js";
import { compressors } from "hyparquet-compressors";

import {
  coalesceObservationHistoryV3ByteRanges,
  createObservationHistoryV3RangeBudget,
  readObservationHistoryV3ByteRanges,
  sha256ObservationHistoryV3Bytes,
} from "../shared/uk_aq_observation_history_random_access_v3.mjs";

const DAY_MS = 86_400_000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_OBJECTS = 64;
const MAX_DECODED_ROWS = 20_000;
const MAX_RANGE_READS = 128;
const MAX_RANGE_BYTES = 32 * 1024 * 1024;
const MAX_MERGED_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENCY = 4;
const SHA256 = /^[0-9a-f]{64}$/;
const COLUMN_NAMES = ["observed_at_utc", "value"];
const CANDIDATE_VERSION = "physical-index-v1";
const ALLOWED_ALIGNED_ROW_CAPS = new Set([1024, 2048]);

export class ObservationHistoryPhysicalCandidateReadError extends Error {
  constructor(message, diagnostics, options) {
    super(message, options);
    this.name = "ObservationHistoryPhysicalCandidateReadError";
    this.diagnostics = diagnostics;
  }
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

function shardBounds(timeseriesId) {
  const start = Math.floor(timeseriesId / 1000) * 1000;
  return { start, end: start + 999 };
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

function exactBody(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new Error("index body must be ArrayBuffer bytes");
}

async function assertBodyIdentity(object, descriptor, label) {
  if (!object) return null;
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

function assertCommonIndex(payload, expected, kind) {
  if (
    payload?.schema_version !== 1 || payload?.kind !== kind ||
    payload?.physical_index_candidate_version !== CANDIDATE_VERSION ||
    payload?.index_generation !== "v3-physical-index-candidate" ||
    payload?.history_version !== "v2" || payload?.domain !== "observations" ||
    payload?.history_schema_version !== 3 || payload?.aligned_row_cap !== expected.alignedRowCap ||
    payload?.physical_layout_version !== "timeseries-aligned-v2" ||
    payload?.writer_version !== "pyarrow-zstd-timeseries-aligned-candidate-v1" ||
    payload?.day_utc !== expected.dayUtc || payload?.connector_id !== expected.connectorId ||
    payload?.pollutant_code !== expected.pollutantCode
  ) throw new Error(`unsupported or contradictory ${kind}`);
}

function validateFile(raw, expectedScope) {
  const key = required(raw?.key, "file.key");
  if (
    !key.startsWith(`history/_prototype/observation-history/timeseries-aligned-v2/cap_rows=${expectedScope.alignedRowCap}/observations/`) ||
    !key.includes(`/${scopePath(expectedScope)}/`) || !key.endsWith(".parquet")
  ) throw new Error(`physical index points outside the pinned aligned ${expectedScope.alignedRowCap} scope: ${key}`);
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

function validateProfile(profile) {
  if (
    profile?.version !== "hyparquet-direct-column-v1" ||
    profile?.hyparquet_version !== "1.25.1" ||
    profile?.page_headers !== "included_in_column_chunk_ranges" ||
    profile?.root_schema_element?.name !== "schema"
  ) throw new Error("unsupported physical decode profile");
  const expected = {
    observed_at_utc: { physical: "INT64", converted: "TIMESTAMP_MILLIS" },
    value: { physical: "DOUBLE", converted: undefined },
  };
  for (const name of COLUMN_NAMES) {
    const column = profile.columns?.[name];
    if (
      column?.physical_type !== expected[name].physical || column?.codec !== "ZSTD" ||
      column?.schema_element?.name !== name || column.schema_element.type !== expected[name].physical ||
      column.schema_element.repetition_type !== "OPTIONAL" ||
      column.schema_element.converted_type !== expected[name].converted
    ) throw new Error(`unsupported physical decode profile for ${name}`);
  }
  return profile;
}

function validateRange(raw, file, rowCount, label) {
  const start = positiveInteger(raw?.start, `${label}.start`, { zero: true });
  const end = positiveInteger(raw?.end, `${label}.end`);
  const dataPageOffset = positiveInteger(raw?.data_page_offset, `${label}.data_page_offset`, { zero: true });
  const dictionaryPageOffset = raw?.dictionary_page_offset === null
    ? null
    : positiveInteger(raw?.dictionary_page_offset, `${label}.dictionary_page_offset`, { zero: true });
  if (
    start >= end || end > file.byte_size || dataPageOffset < start || dataPageOffset >= end ||
    (dictionaryPageOffset !== null && (dictionaryPageOffset !== start || dictionaryPageOffset >= dataPageOffset)) ||
    (dictionaryPageOffset === null && start !== dataPageOffset) ||
    positiveInteger(raw?.num_values, `${label}.num_values`) !== rowCount
  ) throw new Error(`${label} is outside or contradicts its pinned file`);
  return Object.freeze({ start, end, data_page_offset: dataPageOffset, dictionary_page_offset: dictionaryPageOffset });
}

function validateChild(payload, expected, key) {
  assertCommonIndex(payload, expected, "observation_timeseries_physical_index_shard");
  if (payload.key !== key || payload.range_start !== expected.rangeStart || payload.range_end !== expected.rangeEnd) {
    throw new Error("physical child key or shard bounds are contradictory");
  }
  const profile = validateProfile(payload.decode_profile);
  const files = new Map(payload.files.map((raw) => {
    const file = validateFile(raw, expected);
    return [file.key, file];
  }));
  if (files.size !== payload.files.length) throw new Error("duplicate physical file descriptor");
  const selected = payload.timeseries.find((entry) => entry.timeseries_id === expected.timeseriesId);
  if (!selected) return { profile, files, timeseries: null };
  let totalRows = 0;
  let previousMax = null;
  const coordinates = new Set();
  const segments = selected.segments.map((raw, index) => {
    const file = files.get(raw.file_key);
    if (!file) throw new Error("physical segment references an undeclared file");
    const rowCount = positiveInteger(raw.row_count, `segments[${index}].row_count`);
    const rowGroupOrdinal = positiveInteger(raw.row_group_ordinal, `segments[${index}].row_group_ordinal`, { zero: true });
    if (rowGroupOrdinal >= file.row_group_count || raw.row_group_row_start !== 0) {
      throw new Error("physical segment is not a complete declared row group");
    }
    const coordinate = `${file.key}#${rowGroupOrdinal}`;
    if (coordinates.has(coordinate)) throw new Error(`duplicate physical segment coordinate: ${coordinate}`);
    coordinates.add(coordinate);
    const min = iso(raw.min_observed_at_utc, "segment.min_observed_at_utc");
    const max = iso(raw.max_observed_at_utc, "segment.max_observed_at_utc");
    if (min > max || (previousMax !== null && min < previousMax)) {
      throw new Error("physical segments are not chronological");
    }
    previousMax = max;
    totalRows += rowCount;
    return Object.freeze({
      file, file_key: file.key, row_group_ordinal: rowGroupOrdinal,
      row_start: positiveInteger(raw.row_start, "segment.row_start", { zero: true }),
      row_count: rowCount, min_observed_at_utc: min, max_observed_at_utc: max,
      column_ranges: Object.fromEntries(COLUMN_NAMES.map((name) => [
        name, validateRange(raw.column_ranges?.[name], file, rowCount, `segment.${name}`),
      ])),
    });
  });
  if (totalRows !== selected.row_count) throw new Error("physical timeseries row count is contradictory");
  return { profile, files, timeseries: { ...selected, segments } };
}

function decoder(profile, name) {
  const column = profile.columns[name];
  const leaf = { element: column.schema_element, children: [], path: [name] };
  const root = { element: profile.root_schema_element, children: [leaf], path: [] };
  return {
    pathInSchema: [name], type: column.physical_type, element: column.schema_element,
    schemaPath: [root, leaf], codec: column.codec, parsers: DEFAULT_PARSERS,
    compressors, utf8: true,
  };
}

function decodeColumn(buffer, profile, name, rowCount) {
  const reader = { view: new DataView(buffer), offset: 0 };
  const result = readColumn(reader, { groupStart: 0, selectStart: 0, selectEnd: rowCount }, decoder(profile, name));
  const values = flatten(result.data);
  if (result.skipped !== 0 || values.length !== rowCount) {
    throw new Error(`direct ${name} decode did not produce the indexed row count`);
  }
  return values;
}

export { decodeColumn, validateFile, validateProfile, validateRange };

function diagnosticsTemplate(alignedRowCap) {
  return {
    schema_version: 1,
    physical_index_candidate_version: CANDIDATE_VERSION,
    aligned_row_cap: alignedRowCap,
    selected_chronological_segments: 0,
    selected_files: 0,
    selected_row_groups: 0,
    physical_rows_decoded: 0,
    returned_rows: 0,
    parquet_footer_fetched: false,
    parquet_footer_parsed: false,
    timeseries_id_decoded: false,
    requested_physical_byte_ranges_by_column: { observed_at_utc: [], value: [] },
    r2_range_reads: 0,
    r2_bytes_requested: 0,
    identity_head_reads: 0,
    index_objects_read: 0,
    index_bytes_read: 0,
    selected_coordinates: [],
  };
}

async function readIndex(source, key, diagnostics) {
  if (diagnostics.index_objects_read >= MAX_INDEX_OBJECTS) throw new Error("physical index object-count budget exceeded");
  const object = await source.getIndexObject({ key, maxBytes: MAX_INDEX_BYTES, diagnostics });
  if (!object) return null;
  diagnostics.index_objects_read += 1;
  diagnostics.index_bytes_read += object.byte_size;
  return object;
}

export async function readObservationHistoryPhysicalCandidate({
  source, timeseriesId, connectorId, pollutantCode, startUtc, endUtc, indexRoot,
  alignedRowCap,
}) {
  const normalizedAlignedRowCap = positiveInteger(alignedRowCap, "alignedRowCap");
  if (!ALLOWED_ALIGNED_ROW_CAPS.has(normalizedAlignedRowCap)) {
    throw new TypeError("alignedRowCap must be exactly 1024 or 2048");
  }
  const diagnostics = diagnosticsTemplate(normalizedAlignedRowCap);
  const budget = createObservationHistoryV3RangeBudget({
    maxRangeReads: MAX_RANGE_READS,
    maxBytesRequested: MAX_RANGE_BYTES,
  });
  try {
    const normalized = {
      timeseriesId: positiveInteger(timeseriesId, "timeseriesId"),
      connectorId: positiveInteger(connectorId, "connectorId"),
      pollutantCode: required(pollutantCode, "pollutantCode"),
    };
    const startIso = iso(startUtc, "startUtc");
    const endIso = iso(endUtc, "endUtc");
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    if (endMs <= startMs) throw new Error("endUtc must be after startUtc");
    const root = required(indexRoot, "indexRoot").replace(/^\/+|\/+$/g, "");
    const expectedRoot = normalizedAlignedRowCap === 2048
      ? "history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1/observations_timeseries"
      : "history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1/cap_rows=1024/observations_timeseries";
    if (root !== expectedRoot) {
      throw new Error(`physical ${normalizedAlignedRowCap} candidate requires its exact isolated index root`);
    }
    const shard = shardBounds(normalized.timeseriesId);
    const selectedSegments = [];
    const partialReasons = [];
    for (const dayUtc of dayList(startMs, endMs)) {
      const expected = {
        ...normalized,
        alignedRowCap: normalizedAlignedRowCap,
        dayUtc,
        rangeStart: shard.start,
        rangeEnd: shard.end,
      };
      const scope = scopePath(expected);
      const manifestKey = `${root}/${scope}/manifest.json`;
      const manifestObject = await readIndex(source, manifestKey, diagnostics);
      if (!manifestObject) {
        partialReasons.push("required_physical_index_scope_missing");
        continue;
      }
      const manifest = parseJson(manifestObject.body, manifestKey);
      assertCommonIndex(manifest, expected, "observation_timeseries_physical_index_scoped_manifest");
      if (manifest.key !== manifestKey) throw new Error("physical scoped-manifest key is contradictory");
      const descriptor = manifest.children.find((child) => child.range_start === shard.start && child.range_end === shard.end);
      if (!descriptor || !descriptor.timeseries_ids.includes(normalized.timeseriesId)) continue;
      const childKey = required(descriptor.key, "child.key");
      const expectedKey = `${root}/${scope}/range=${String(shard.start).padStart(6, "0")}-${String(shard.end).padStart(6, "0")}.json`;
      if (childKey !== expectedKey) throw new Error("physical scoped manifest points to an unexpected child key");
      const childObject = await readIndex(source, childKey, diagnostics);
      if (!childObject) {
        partialReasons.push("required_physical_index_child_missing");
        continue;
      }
      const childBody = await assertBodyIdentity(childObject, descriptor, "physical child");
      const child = validateChild(parseJson(childBody, childKey), expected, childKey);
      if (!child.timeseries) throw new Error("scoped manifest claims a timeseries absent from its child");
      for (const segment of child.timeseries.segments) {
        if (Date.parse(segment.max_observed_at_utc) >= startMs && Date.parse(segment.min_observed_at_utc) < endMs) {
          selectedSegments.push({ ...segment, profile: child.profile });
        }
      }
    }
    selectedSegments.sort((left, right) =>
      left.min_observed_at_utc.localeCompare(right.min_observed_at_utc) ||
      left.file_key.localeCompare(right.file_key) || left.row_group_ordinal - right.row_group_ordinal
    );
    diagnostics.selected_chronological_segments = selectedSegments.length;
    diagnostics.selected_row_groups = selectedSegments.length;
    diagnostics.physical_rows_decoded = selectedSegments.reduce((sum, segment) => sum + segment.row_count, 0);
    if (diagnostics.physical_rows_decoded > MAX_DECODED_ROWS) throw new Error("physical decoded-row budget exceeded");
    const grouped = new Map();
    for (const segment of selectedSegments) {
      const context = grouped.get(segment.file_key) || { file: segment.file, segments: [] };
      context.segments.push(segment);
      grouped.set(segment.file_key, context);
      diagnostics.selected_coordinates.push({
        file_key: segment.file_key, row_group_ordinal: segment.row_group_ordinal,
        row_count: segment.row_count, min_observed_at_utc: segment.min_observed_at_utc,
        max_observed_at_utc: segment.max_observed_at_utc,
      });
      for (const name of COLUMN_NAMES) {
        const range = segment.column_ranges[name];
        diagnostics.requested_physical_byte_ranges_by_column[name].push({
          file_key: segment.file_key, row_group_ordinal: segment.row_group_ordinal,
          start: range.start, end: range.end,
        });
      }
    }
    diagnostics.selected_files = grouped.size;
    const decoded = [];
    for (const context of grouped.values()) {
      const file = await source.openParquetFile({ identity: context.file, budget, diagnostics });
      const requested = context.segments.flatMap((segment) => COLUMN_NAMES.map((name) => ({
        id: `${segment.row_group_ordinal}:${name}`,
        ...segment.column_ranges[name],
      })));
      const coalesced = coalesceObservationHistoryV3ByteRanges(requested, {
        maxGapBytes: 0,
        maxMergedBytes: MAX_MERGED_RANGE_BYTES,
      });
      const blocks = await readObservationHistoryV3ByteRanges({
        file, ranges: coalesced, concurrency: MAX_CONCURRENCY, budget,
      });
      const bytesFor = (range) => {
        const block = blocks.find((candidate) => candidate.start <= range.start && range.end <= candidate.end);
        if (!block) throw new Error("physical column range was not prefetched");
        return block.buffer.slice(range.start - block.start, range.end - block.start);
      };
      for (const segment of context.segments) {
        const timestamps = decodeColumn(bytesFor(segment.column_ranges.observed_at_utc), segment.profile, "observed_at_utc", segment.row_count);
        const values = decodeColumn(bytesFor(segment.column_ranges.value), segment.profile, "value", segment.row_count);
        let previous = null;
        for (let index = 0; index < segment.row_count; index += 1) {
          const observedAt = timestamps[index] instanceof Date ? timestamps[index].toISOString() : iso(timestamps[index], "decoded timestamp");
          const value = Number(values[index]);
          if (
            !Number.isFinite(value) || observedAt < segment.min_observed_at_utc ||
            observedAt > segment.max_observed_at_utc || (previous !== null && observedAt < previous)
          ) throw new Error("directly decoded row contradicts physical segment metadata");
          previous = observedAt;
          decoded.push({ timeseries_id: normalized.timeseriesId, observed_at_utc: observedAt, value });
        }
      }
    }
    decoded.sort((left, right) => left.observed_at_utc.localeCompare(right.observed_at_utc));
    const rows = decoded.filter((row) => {
      const timestamp = Date.parse(row.observed_at_utc);
      return timestamp >= startMs && timestamp < endMs;
    });
    const snapshot = budget.snapshot();
    diagnostics.r2_range_reads = snapshot.range_reads;
    diagnostics.r2_bytes_requested = snapshot.bytes_requested;
    diagnostics.returned_rows = rows.length;
    const reasons = [...new Set(partialReasons)];
    return Object.freeze({
      rows,
      response_complete: reasons.length === 0,
      partial_reasons: reasons,
      diagnostics: Object.freeze(diagnostics),
    });
  } catch (error) {
    const snapshot = budget.snapshot();
    diagnostics.r2_range_reads = snapshot.range_reads;
    diagnostics.r2_bytes_requested = snapshot.bytes_requested;
    throw new ObservationHistoryPhysicalCandidateReadError(
      error instanceof Error ? error.message : String(error),
      Object.freeze(diagnostics),
      { cause: error },
    );
  }
}
