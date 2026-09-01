// @ts-nocheck -- isolated TEST-only exact-timeseries-leaf candidate.
import {
  decodeColumn,
  validateFile,
  validateProfile,
  validateRange,
} from "../uk_aq_observs_history_r2_api_v3_physical_candidate/reader.mjs";
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
const CANDIDATE_VERSION = "physical-leaf-index-v1";
const INDEX_GENERATION = "v3-physical-leaf-candidate";
const ALIGNED_ROW_CAP = 1024;
const EXACT_INDEX_ROOT =
  "history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-leaf-index-v1/cap_rows=1024/observations_timeseries";
const ALIGNED_INDEX_ROOT =
  "history/_prototype/observation-history/timeseries-aligned-v2/cap_rows=1024/observations_timeseries";

export class ObservationHistoryPhysicalLeafCandidateReadError extends Error {
  constructor(message, diagnostics, options) {
    super(message, options);
    this.name = "ObservationHistoryPhysicalLeafCandidateReadError";
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
    payload?.schema_version !== 1 ||
    payload?.kind !== kind ||
    payload?.physical_leaf_candidate_version !== CANDIDATE_VERSION ||
    payload?.index_generation !== INDEX_GENERATION ||
    payload?.history_version !== "v2" ||
    payload?.domain !== "observations" ||
    payload?.history_schema_version !== 3 ||
    payload?.writer_version !== "pyarrow-zstd-timeseries-aligned-candidate-v1" ||
    payload?.physical_layout_version !== "timeseries-aligned-v2" ||
    payload?.aligned_row_cap !== ALIGNED_ROW_CAP ||
    payload?.day_utc !== expected.dayUtc ||
    payload?.connector_id !== expected.connectorId ||
    payload?.pollutant_code !== expected.pollutantCode
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
  return { key, byte_size: byteSize, sha256 };
}

function validateManifest(payload, expected, key, root, scope) {
  assertCommonIndex(payload, expected, "observation_timeseries_physical_leaf_scoped_manifest");
  if (
    payload.key !== key ||
    JSON.stringify(payload.leaf_descriptor_fields) !== JSON.stringify(["key", "byte_size", "sha256"]) ||
    !payload.leaves_by_timeseries_id ||
    typeof payload.leaves_by_timeseries_id !== "object" ||
    Array.isArray(payload.leaves_by_timeseries_id)
  ) {
    throw new Error("physical-leaf scoped manifest key or lookup is contradictory");
  }
  const profile = validateProfile(payload.decode_profile);
  const lookupKeys = Object.keys(payload.leaves_by_timeseries_id);
  if (
    positiveInteger(payload.coverage?.timeseries_count, "coverage.timeseries_count") !== lookupKeys.length ||
    positiveInteger(payload.coverage?.row_count, "coverage.row_count") < lookupKeys.length ||
    lookupKeys.some((value) => {
      const number = Number(value);
      return !Number.isSafeInteger(number) || number <= 0 || String(number) !== value;
    })
  ) throw new Error("physical-leaf scoped manifest coverage is contradictory");
  const coverageMin = iso(payload.coverage?.min_observed_at_utc, "coverage.min_observed_at_utc");
  const coverageMax = iso(payload.coverage?.max_observed_at_utc, "coverage.max_observed_at_utc");
  if (coverageMin > coverageMax) {
    throw new Error("physical-leaf scoped manifest coverage bounds are contradictory");
  }
  const sourceManifest = validateIdentity(
    payload.source_aligned_scoped_manifest,
    "source_aligned_scoped_manifest",
  );
  if (sourceManifest.key !== `${ALIGNED_INDEX_ROOT}/${scope}/manifest.json`) {
    throw new Error("physical-leaf source aligned scoped-manifest key is contradictory");
  }
  const raw = payload.leaves_by_timeseries_id[String(expected.timeseriesId)];
  if (raw === undefined) return { profile, descriptor: null };
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error("physical-leaf descriptor tuple is contradictory");
  }
  const descriptor = validateIdentity(
    { key: raw[0], byte_size: raw[1], sha256: raw[2] },
    "selected physical-leaf descriptor",
  );
  if (descriptor.key !== expectedLeafKey(root, scope, expected.timeseriesId)) {
    throw new Error("physical-leaf descriptor key is contradictory");
  }
  return { profile, descriptor };
}

function validateLeaf(payload, expected, key, descriptor, profile) {
  assertCommonIndex(payload, expected, "observation_timeseries_physical_leaf");
  if (
    payload.key !== key ||
    payload.timeseries_id !== expected.timeseriesId ||
    payload.timeseries !== undefined ||
    payload.decode_profile !== undefined ||
    !Array.isArray(payload.files) ||
    !Array.isArray(payload.segments)
  ) throw new Error("physical timeseries leaf identity or shape is contradictory");
  if (
    !Number.isSafeInteger(payload.row_count) ||
    payload.row_count <= 0
  ) throw new Error("physical timeseries leaf row count is invalid");
  const leafMin = iso(payload.min_observed_at_utc, "leaf.min_observed_at_utc");
  const leafMax = iso(payload.max_observed_at_utc, "leaf.max_observed_at_utc");
  if (leafMin > leafMax) throw new Error("physical timeseries leaf bounds are contradictory");
  const sourceChild = validateIdentity(payload.source_aligned_child, "source_aligned_child");
  const alignedScopeRoot = `${ALIGNED_INDEX_ROOT}/${scopePath(expected)}`;
  if (
    !sourceChild.key.startsWith(`${alignedScopeRoot}/range=`) ||
    !/\/range=\d+-\d+\.json$/.test(sourceChild.key)
  ) throw new Error("physical timeseries leaf source aligned child is contradictory");

  const files = new Map(payload.files.map((raw) => {
    const file = validateFile(raw, expected);
    return [file.key, file];
  }));
  if (files.size !== payload.files.length) throw new Error("duplicate physical-leaf file descriptor");

  let totalRows = 0;
  let previousMax = null;
  const coordinates = new Set();
  const usedFileKeys = new Set();
  const segments = payload.segments.map((raw, index) => {
    const file = files.get(raw.file_key);
    if (!file) throw new Error("physical-leaf segment references an undeclared file");
    usedFileKeys.add(file.key);
    const rowCount = positiveInteger(raw.row_count, `segments[${index}].row_count`);
    const rowGroupOrdinal = positiveInteger(raw.row_group_ordinal, `segments[${index}].row_group_ordinal`, { zero: true });
    if (rowCount > ALIGNED_ROW_CAP || rowGroupOrdinal >= file.row_group_count || raw.row_group_row_start !== 0) {
      throw new Error("physical-leaf segment is not a complete cap=1024 row group");
    }
    const coordinate = `${file.key}#${rowGroupOrdinal}`;
    if (coordinates.has(coordinate)) throw new Error(`duplicate physical-leaf segment coordinate: ${coordinate}`);
    coordinates.add(coordinate);
    const min = iso(raw.min_observed_at_utc, `segments[${index}].min_observed_at_utc`);
    const max = iso(raw.max_observed_at_utc, `segments[${index}].max_observed_at_utc`);
    if (min > max || (previousMax !== null && min < previousMax)) {
      throw new Error("physical-leaf segments are not chronological");
    }
    previousMax = max;
    totalRows += rowCount;
    return Object.freeze({
      file,
      file_key: file.key,
      row_group_ordinal: rowGroupOrdinal,
      row_start: positiveInteger(raw.row_start, `segments[${index}].row_start`, { zero: true }),
      row_count: rowCount,
      min_observed_at_utc: min,
      max_observed_at_utc: max,
      profile,
      column_ranges: Object.fromEntries(COLUMN_NAMES.map((name) => [
        name,
        validateRange(raw.column_ranges?.[name], file, rowCount, `segments[${index}].${name}`),
      ])),
    });
  });
  if (
    totalRows !== payload.row_count ||
    usedFileKeys.size !== files.size ||
    segments[0]?.min_observed_at_utc !== leafMin ||
    segments.at(-1)?.max_observed_at_utc !== leafMax
  ) throw new Error("physical timeseries leaf coverage is contradictory");
  return segments;
}

function diagnosticsTemplate() {
  return {
    schema_version: 1,
    physical_leaf_candidate_version: CANDIDATE_VERSION,
    aligned_row_cap: ALIGNED_ROW_CAP,
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
    timeseries_leaf_objects_read: 0,
    timeseries_leaf_bytes_read: 0,
    coarse_child_shards_read: 0,
    selected_coordinates: [],
  };
}

async function readIndex(source, key, diagnostics, { leaf = false } = {}) {
  if (diagnostics.index_objects_read >= MAX_INDEX_OBJECTS) {
    throw new Error("physical-leaf index object-count budget exceeded");
  }
  const object = await source.getIndexObject({ key, maxBytes: MAX_INDEX_BYTES, diagnostics });
  if (!object) return null;
  diagnostics.index_objects_read += 1;
  diagnostics.index_bytes_read += object.byte_size;
  if (leaf) {
    diagnostics.timeseries_leaf_objects_read += 1;
    diagnostics.timeseries_leaf_bytes_read += object.byte_size;
  }
  return object;
}

export async function readObservationHistoryPhysicalLeafCandidate({
  source,
  timeseriesId,
  connectorId,
  pollutantCode,
  startUtc,
  endUtc,
  indexRoot,
}) {
  const diagnostics = diagnosticsTemplate();
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
    if (root !== EXACT_INDEX_ROOT) {
      throw new Error("physical-leaf candidate requires its exact isolated cap=1024 index root");
    }

    const selectedSegments = [];
    const partialReasons = [];
    for (const dayUtc of dayList(startMs, endMs)) {
      const expected = { ...normalized, alignedRowCap: ALIGNED_ROW_CAP, dayUtc };
      const scope = scopePath(expected);
      const manifestKey = `${root}/${scope}/manifest.json`;
      const manifestObject = await readIndex(source, manifestKey, diagnostics);
      if (!manifestObject) {
        partialReasons.push("required_physical_leaf_scope_missing");
        continue;
      }
      const manifest = validateManifest(
        parseJson(manifestObject.body, manifestKey),
        expected,
        manifestKey,
        root,
        scope,
      );
      const descriptor = manifest.descriptor;
      if (!descriptor) continue;
      const leafObject = await readIndex(source, descriptor.key, diagnostics, { leaf: true });
      if (!leafObject) {
        partialReasons.push("required_physical_timeseries_leaf_missing");
        continue;
      }
      const leafBody = await assertBodyIdentity(leafObject, descriptor, "physical timeseries leaf");
      const segments = validateLeaf(
        parseJson(leafBody, descriptor.key),
        expected,
        descriptor.key,
        descriptor,
        manifest.profile,
      );
      for (const segment of segments) {
        if (
          Date.parse(segment.max_observed_at_utc) >= startMs &&
          Date.parse(segment.min_observed_at_utc) < endMs
        ) selectedSegments.push(segment);
      }
    }

    selectedSegments.sort((left, right) =>
      left.min_observed_at_utc.localeCompare(right.min_observed_at_utc) ||
      left.file_key.localeCompare(right.file_key) ||
      left.row_group_ordinal - right.row_group_ordinal
    );
    diagnostics.selected_chronological_segments = selectedSegments.length;
    diagnostics.selected_row_groups = selectedSegments.length;
    diagnostics.physical_rows_decoded = selectedSegments.reduce((sum, segment) => sum + segment.row_count, 0);
    if (diagnostics.physical_rows_decoded > MAX_DECODED_ROWS) {
      throw new Error("physical-leaf decoded-row budget exceeded");
    }

    const grouped = new Map();
    for (const segment of selectedSegments) {
      const context = grouped.get(segment.file_key) || { file: segment.file, segments: [] };
      context.segments.push(segment);
      grouped.set(segment.file_key, context);
      diagnostics.selected_coordinates.push({
        file_key: segment.file_key,
        row_group_ordinal: segment.row_group_ordinal,
        row_count: segment.row_count,
        min_observed_at_utc: segment.min_observed_at_utc,
        max_observed_at_utc: segment.max_observed_at_utc,
      });
      for (const name of COLUMN_NAMES) {
        const range = segment.column_ranges[name];
        diagnostics.requested_physical_byte_ranges_by_column[name].push({
          file_key: segment.file_key,
          row_group_ordinal: segment.row_group_ordinal,
          start: range.start,
          end: range.end,
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
        file,
        ranges: coalesced,
        concurrency: MAX_CONCURRENCY,
        budget,
      });
      const bytesFor = (range) => {
        const block = blocks.find((candidate) => candidate.start <= range.start && range.end <= candidate.end);
        if (!block) throw new Error("physical-leaf column range was not prefetched");
        return block.buffer.slice(range.start - block.start, range.end - block.start);
      };
      for (const segment of context.segments) {
        const timestamps = decodeColumn(
          bytesFor(segment.column_ranges.observed_at_utc),
          segment.profile,
          "observed_at_utc",
          segment.row_count,
        );
        const values = decodeColumn(
          bytesFor(segment.column_ranges.value),
          segment.profile,
          "value",
          segment.row_count,
        );
        let previous = null;
        for (let index = 0; index < segment.row_count; index += 1) {
          const observedAt = timestamps[index] instanceof Date
            ? timestamps[index].toISOString()
            : iso(timestamps[index], "decoded timestamp");
          const value = Number(values[index]);
          if (
            !Number.isFinite(value) ||
            observedAt < segment.min_observed_at_utc ||
            observedAt > segment.max_observed_at_utc ||
            (previous !== null && observedAt < previous)
          ) throw new Error("directly decoded row contradicts physical-leaf segment metadata");
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
    throw new ObservationHistoryPhysicalLeafCandidateReadError(
      error instanceof Error ? error.message : String(error),
      Object.freeze(diagnostics),
      { cause: error },
    );
  }
}
