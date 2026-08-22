// @ts-nocheck -- shared Node writer is consumed by JavaScript and Deno TypeScript callers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import {
  parquetMetadata,
  parquetSchema,
  readColumnIndex,
  readOffsetIndex,
} from "hyparquet";
import * as parquetWasm from "parquet-wasm/esm";

import {
  computeObservationContentHash,
  encodeCanonicalObservationRow,
} from "./uk_aq_observation_content_hash.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
  OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "./uk_aq_observation_history_schema.mjs";
import { sha256Hex } from "./r2_sigv4.mjs";

export const OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION =
  "timeseries-bounded-v1";

const REQUIRED_RANGED_READER_COLUMNS = Object.freeze([
  "timeseries_id",
  "observed_at_utc",
  "value",
]);
const PARQUET_CREATED_BY = [
  `writer_version=${OBSERVATION_HISTORY_WRITER_VERSION_V3}`,
  `history_schema_version=${OBSERVATION_HISTORY_SCHEMA_VERSION_V3}`,
  `physical_layout_version=${OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION}`,
].join(";");

let parquetWasmInitialized = false;

function ensureParquetWasmInitialized() {
  if (parquetWasmInitialized) return;
  const wasmPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm",
  );
  parquetWasm.initSync({ module: fs.readFileSync(wasmPath) });
  parquetWasmInitialized = true;
}

function positiveSafeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return number;
}

function validateLimits(limits) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new TypeError("timeseries-bounded writer limits must be an object");
  }
  const normalized = {
    target_row_group_rows: positiveSafeInteger(
      limits.target_row_group_rows,
      "target_row_group_rows",
    ),
    max_row_group_rows: positiveSafeInteger(
      limits.max_row_group_rows,
      "max_row_group_rows",
    ),
    target_file_rows: positiveSafeInteger(
      limits.target_file_rows,
      "target_file_rows",
    ),
    max_file_rows: positiveSafeInteger(
      limits.max_file_rows,
      "max_file_rows",
    ),
    target_file_bytes: positiveSafeInteger(
      limits.target_file_bytes,
      "target_file_bytes",
    ),
    max_file_bytes: positiveSafeInteger(
      limits.max_file_bytes,
      "max_file_bytes",
    ),
    max_row_groups_per_file: positiveSafeInteger(
      limits.max_row_groups_per_file,
      "max_row_groups_per_file",
    ),
  };
  if (normalized.target_row_group_rows > normalized.max_row_group_rows) {
    throw new TypeError(
      "target_row_group_rows must not exceed max_row_group_rows",
    );
  }
  if (normalized.target_file_rows > normalized.max_file_rows) {
    throw new TypeError("target_file_rows must not exceed max_file_rows");
  }
  if (normalized.target_file_bytes > normalized.max_file_bytes) {
    throw new TypeError("target_file_bytes must not exceed max_file_bytes");
  }
  return Object.freeze(normalized);
}

function compareCanonicalPhysicalRows(left, right) {
  if (left.row.timeseries_id !== right.row.timeseries_id) {
    return left.row.timeseries_id - right.row.timeseries_id;
  }
  if (left.row.observed_at_utc !== right.row.observed_at_utc) {
    return left.row.observed_at_utc < right.row.observed_at_utc ? -1 : 1;
  }
  if (left.tie_break !== right.tie_break) {
    return left.tie_break < right.tie_break ? -1 : 1;
  }
  return 0;
}

function canonicalPhysicalRows(rows) {
  const hashResult = computeObservationContentHash(rows);
  const orderedRows = hashResult.canonical_rows
    .map((row) => ({ row, tie_break: encodeCanonicalObservationRow(row) }))
    .sort(compareCanonicalPhysicalRows)
    .map(({ row }) => row);
  const first = orderedRows[0];
  const dayUtc = first.observed_at_utc.slice(0, 10);
  for (const row of orderedRows) {
    if (row.connector_id !== first.connector_id) {
      throw new TypeError("target writer input must contain one connector_id");
    }
    if (row.pollutant_code !== first.pollutant_code) {
      throw new TypeError("target writer input must contain one pollutant_code");
    }
    if (row.observed_at_utc.slice(0, 10) !== dayUtc) {
      throw new TypeError("target writer input must contain one UTC day");
    }
  }
  const { canonical_rows: _canonicalRows, ...contentHash } = hashResult;
  return {
    orderedRows,
    contentHash,
    partition: Object.freeze({
      day_utc: dayUtc,
      connector_id: first.connector_id,
      pollutant_code: first.pollutant_code,
    }),
  };
}

function packTimeseriesAwareRowGroups(rows, limits) {
  const hardCapacity = Math.min(
    limits.max_row_group_rows,
    limits.max_file_rows,
  );
  const groups = [];
  let current = [];
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };

  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (
      end < rows.length &&
      rows[end].timeseries_id === rows[start].timeseries_id
    ) {
      end += 1;
    }
    let runStart = start;
    while (end - runStart > hardCapacity) {
      flush();
      groups.push(rows.slice(runStart, runStart + hardCapacity));
      runStart += hardCapacity;
    }
    const remainder = rows.slice(runStart, end);
    if (remainder.length) {
      if (
        current.length &&
        current.length + remainder.length > limits.target_row_group_rows
      ) {
        flush();
      }
      current.push(...remainder);
    }
    start = end;
  }
  flush();
  return groups;
}

function packCompatibleRowGroupsIntoFiles(rowGroups, limits) {
  const files = [];
  let currentGroups = [];
  let currentRows = 0;
  const flush = () => {
    if (currentGroups.length) {
      files.push({
        rows: currentGroups.flat(),
        rowGroups: currentGroups,
        rowGroupRows: currentGroups[0].length,
      });
    }
    currentGroups = [];
    currentRows = 0;
  };

  for (const group of rowGroups) {
    if (group.length > limits.max_file_rows) {
      throw new Error("One intended row group exceeds max_file_rows");
    }
    if (!currentGroups.length) {
      currentGroups.push(group);
      currentRows = group.length;
      continue;
    }
    const fixedWriterGroupRows = currentGroups[0].length;
    const previousWasShort =
      currentGroups[currentGroups.length - 1].length < fixedWriterGroupRows;
    const nextRows = currentRows + group.length;
    const compatible =
      !previousWasShort &&
      group.length <= fixedWriterGroupRows &&
      currentGroups.length < limits.max_row_groups_per_file &&
      nextRows <= limits.target_file_rows &&
      nextRows <= limits.max_file_rows;
    if (!compatible) flush();
    currentGroups.push(group);
    currentRows += group.length;
  }
  flush();
  return files;
}

function writerProperties(rowGroupRows) {
  ensureParquetWasmInitialized();
  return new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.ZSTD)
    .setMaxRowGroupSize(rowGroupRows)
    .setCreatedBy(PARQUET_CREATED_BY)
    .build();
}

function serializeRows(rows, rowGroupRows) {
  ensureParquetWasmInitialized();
  const table = arrow.tableFromArrays({
    connector_id: arrow.vectorFromArray(
      rows.map((row) => row.connector_id),
      new arrow.Int32(),
    ),
    station_id: arrow.vectorFromArray(
      rows.map((row) => row.station_id),
      new arrow.Int32(),
    ),
    timeseries_id: arrow.vectorFromArray(
      rows.map((row) => row.timeseries_id),
      new arrow.Int32(),
    ),
    pollutant_code: arrow.vectorFromArray(
      rows.map((row) => row.pollutant_code),
      new arrow.Utf8(),
    ),
    observed_at_utc: arrow.vectorFromArray(
      rows.map((row) => new Date(row.observed_at_utc)),
      new arrow.TimestampMillisecond(),
    ),
    value: arrow.vectorFromArray(
      rows.map((row) => row.value),
      new arrow.Float64(),
    ),
    verification_status: arrow.vectorFromArray(
      rows.map((row) => row.verification_status),
      new arrow.Utf8(),
    ),
  });
  const ipc = arrow.tableToIPC(table, "stream");
  const writeOnce = () => {
    const properties = writerProperties(rowGroupRows);
    const wasmTable = parquetWasm.Table.fromIPCStream(ipc);
    return Buffer.from(parquetWasm.writeParquet(wasmTable, properties));
  };
  return writeOnce();
}

function nearestBoundary(boundaries, midpoint) {
  return boundaries.reduce((nearest, boundary) => {
    const distance = Math.abs(boundary - midpoint);
    const nearestDistance = Math.abs(nearest - midpoint);
    return distance < nearestDistance ||
        (distance === nearestDistance && boundary < nearest)
      ? boundary
      : nearest;
  });
}

function deterministicByteSplit(rows, rowGroups) {
  const midpoint = rows.length / 2;
  const timeseriesBoundaries = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1].timeseries_id !== rows[index].timeseries_id) {
      timeseriesBoundaries.push(index);
    }
  }
  if (timeseriesBoundaries.length) {
    return nearestBoundary(timeseriesBoundaries, midpoint);
  }
  const rowGroupBoundaries = [];
  let rowCount = 0;
  for (const group of rowGroups.slice(0, -1)) {
    rowCount += group.length;
    rowGroupBoundaries.push(rowCount);
  }
  if (rowGroupBoundaries.length) {
    return nearestBoundary(rowGroupBoundaries, midpoint);
  }
  return Math.max(1, Math.floor(midpoint));
}

function buildSerializedCandidates(rows, limits) {
  return packCompatibleRowGroupsIntoFiles(
    packTimeseriesAwareRowGroups(rows, limits),
    limits,
  ).flatMap((candidate) => serializeWithinByteBounds(candidate, limits));
}

function serializeWithinByteBounds(candidate, limits) {
  const body = serializeRows(candidate.rows, candidate.rowGroupRows);
  if (body.byteLength <= limits.target_file_bytes) {
    return [{ ...candidate, body }];
  }
  if (candidate.rows.length === 1) {
    if (body.byteLength > limits.max_file_bytes) {
      throw new Error(
        `One canonical observation row serialised to ${body.byteLength} bytes, exceeding max_file_bytes=${limits.max_file_bytes}`,
      );
    }
    return [{ ...candidate, body }];
  }
  const splitAt = deterministicByteSplit(candidate.rows, candidate.rowGroups);
  return [
    ...buildSerializedCandidates(candidate.rows.slice(0, splitAt), limits),
    ...buildSerializedCandidates(candidate.rows.slice(splitAt), limits),
  ];
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

function columnChunk(rowGroup, columnName) {
  return (rowGroup?.columns || []).find((column) =>
    column?.meta_data?.path_in_schema?.length === 1 &&
    column.meta_data.path_in_schema[0] === columnName
  );
}

function pageIndexReader(arrayBuffer, offset, length, label) {
  const start = Number(offset);
  const size = Number(length);
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    start + size > arrayBuffer.byteLength
  ) {
    throw new Error(`Parquet ${label} page-index range is invalid`);
  }
  return {
    view: new DataView(arrayBuffer.slice(start, start + size)),
    offset: 0,
  };
}

function validateOptionalPageIndexes(
  column,
  label,
  { arrayBuffer, schemaElement, rowCount },
) {
  const values = [
    column.column_index_offset,
    column.column_index_length,
    column.offset_index_offset,
    column.offset_index_length,
  ];
  const present = values.map((value) => value !== undefined && value !== null);
  if (!present.some(Boolean)) return false;
  if (!present.every(Boolean)) {
    throw new Error(`Parquet ${label} has incomplete page-index metadata`);
  }
  const columnIndex = readColumnIndex(
    pageIndexReader(
      arrayBuffer,
      column.column_index_offset,
      column.column_index_length,
      label,
    ),
    schemaElement,
  );
  const offsetIndex = readOffsetIndex(pageIndexReader(
    arrayBuffer,
    column.offset_index_offset,
    column.offset_index_length,
    label,
  ));
  const pageLocations = offsetIndex.page_locations || [];
  if (
    pageLocations.length === 0 ||
    columnIndex.min_values?.length !== pageLocations.length ||
    columnIndex.max_values?.length !== pageLocations.length ||
    columnIndex.null_pages?.length !== pageLocations.length
  ) {
    throw new Error(`Parquet ${label} page-index entry count mismatch`);
  }
  let previousFirstRow = -1;
  for (const location of pageLocations) {
    const firstRow = Number(location.first_row_index);
    const pageOffset = Number(location.offset);
    const compressedSize = Number(location.compressed_page_size);
    if (
      !Number.isSafeInteger(firstRow) ||
      firstRow <= previousFirstRow ||
      firstRow < 0 ||
      firstRow >= rowCount ||
      !Number.isSafeInteger(pageOffset) ||
      pageOffset < 0 ||
      !Number.isSafeInteger(compressedSize) ||
      compressedSize <= 0 ||
      pageOffset + compressedSize > arrayBuffer.byteLength
    ) {
      throw new Error(`Parquet ${label} page location is invalid`);
    }
    previousFirstRow = firstRow;
  }
  if (Number(pageLocations[0].first_row_index) !== 0) {
    throw new Error(`Parquet ${label} first page does not start at row zero`);
  }
  return true;
}

function validateProjectedColumnChunkRange(column, label, fileByteLength) {
  const metadata = column?.meta_data;
  const dataPageOffset = Number(metadata?.data_page_offset);
  const compressedSize = Number(metadata?.total_compressed_size);
  if (
    !column ||
    !metadata ||
    !Number.isSafeInteger(dataPageOffset) ||
    dataPageOffset < 0 ||
    !Number.isSafeInteger(compressedSize) ||
    compressedSize <= 0
  ) {
    throw new Error(`Parquet ${label} column-chunk metadata is incomplete`);
  }

  const hasDictionaryPage =
    metadata.dictionary_page_offset !== undefined &&
    metadata.dictionary_page_offset !== null;
  const dictionaryPageOffset = hasDictionaryPage
    ? Number(metadata.dictionary_page_offset)
    : null;
  if (
    hasDictionaryPage &&
    (
      !Number.isSafeInteger(dictionaryPageOffset) ||
      dictionaryPageOffset < 0 ||
      dictionaryPageOffset >= dataPageOffset
    )
  ) {
    throw new Error(`Parquet ${label} dictionary-page offset is invalid`);
  }

  const chunkStart = hasDictionaryPage
    ? dictionaryPageOffset
    : dataPageOffset;
  const chunkEnd = chunkStart + compressedSize;
  if (
    !Number.isSafeInteger(chunkEnd) ||
    chunkStart >= fileByteLength ||
    dataPageOffset >= chunkEnd ||
    chunkEnd > fileByteLength
  ) {
    throw new Error(`Parquet ${label} column-chunk range is invalid`);
  }
}

function buildIntendedSegments(rows, groupSizes) {
  const rowGroups = [];
  const segments = [];
  let groupStart = 0;
  for (const [rowGroupOrdinal, groupRowCount] of groupSizes.entries()) {
    const groupEnd = groupStart + groupRowCount;
    const groupSegments = [];
    for (let start = groupStart; start < groupEnd;) {
      let end = start + 1;
      while (
        end < groupEnd &&
        rows[end].timeseries_id === rows[start].timeseries_id
      ) {
        end += 1;
      }
      const segment = {
        timeseries_id: rows[start].timeseries_id,
        row_group_ordinal: rowGroupOrdinal,
        row_start: start,
        row_group_row_start: start - groupStart,
        row_count: end - start,
        min_observed_at_utc: rows[start].observed_at_utc,
        max_observed_at_utc: rows[end - 1].observed_at_utc,
      };
      groupSegments.push(segment);
      segments.push(segment);
      start = end;
    }
    rowGroups.push({
      row_group_ordinal: rowGroupOrdinal,
      row_start: groupStart,
      row_count: groupRowCount,
      min_timeseries_id: rows[groupStart].timeseries_id,
      max_timeseries_id: rows[groupEnd - 1].timeseries_id,
      min_observed_at_utc: rows.slice(groupStart, groupEnd).reduce(
        (value, row) => value < row.observed_at_utc ? value : row.observed_at_utc,
        rows[groupStart].observed_at_utc,
      ),
      max_observed_at_utc: rows.slice(groupStart, groupEnd).reduce(
        (value, row) => value > row.observed_at_utc ? value : row.observed_at_utc,
        rows[groupStart].observed_at_utc,
      ),
      segments: groupSegments,
    });
    groupStart = groupEnd;
  }
  return { rowGroups, segments };
}

function statisticValue(statistics, direction) {
  return statistics?.[`${direction}_value`] ?? statistics?.[direction];
}

function timestampStatisticValue(statistics, direction) {
  const value = statisticValue(statistics, direction);
  return value instanceof Date ? value.toISOString() : value;
}

function validateFooter({ body, rows, limits, intended }) {
  const arrayBuffer = exactArrayBuffer(body);
  const metadata = parquetMetadata(arrayBuffer, {
    geoparquet: false,
  });
  if (metadata.created_by !== PARQUET_CREATED_BY) {
    throw new Error("Parquet footer writer identity mismatch");
  }
  const schemaChildren = parquetSchema(metadata).children;
  const schemaColumns = schemaChildren.map((column) =>
    String(column.element.name)
  );
  const schemaByName = new Map(
    schemaChildren.map((column) => [String(column.element.name), column.element]),
  );
  if (
    schemaColumns.length !== OBSERVATION_HISTORY_COLUMNS_V3.length ||
    schemaColumns.some(
      (column, index) => column !== OBSERVATION_HISTORY_COLUMNS_V3[index],
    )
  ) {
    throw new Error("Parquet footer canonical observation schema mismatch");
  }
  if (Number(metadata.num_rows) !== rows.length) {
    throw new Error("Parquet footer row count mismatch");
  }
  const actualGroups = metadata.row_groups || [];
  if (actualGroups.length !== intended.rowGroups.length) {
    throw new Error("Parquet footer row-group count mismatch");
  }

  const pageIndexAvailability = {};
  let validatedProjectedColumnChunks = 0;
  for (const [ordinal, actual] of actualGroups.entries()) {
    const expected = intended.rowGroups[ordinal];
    const actualRows = Number(actual.num_rows);
    if (
      actualRows !== expected.row_count ||
      actualRows > limits.max_row_group_rows
    ) {
      throw new Error(`Parquet row group ${ordinal} row bound mismatch`);
    }
    const expectedSegmentRows = expected.segments.reduce(
      (sum, segment) => sum + segment.row_count,
      0,
    );
    if (expectedSegmentRows !== expected.row_count) {
      throw new Error(`Intended row group ${ordinal} segment coverage mismatch`);
    }

    const timeseriesColumn = columnChunk(actual, "timeseries_id");
    const observedAtColumn = columnChunk(actual, "observed_at_utc");
    if (!timeseriesColumn || !observedAtColumn) {
      throw new Error(`Parquet row group ${ordinal} lacks routing columns`);
    }
    const timeseriesStats = timeseriesColumn.meta_data?.statistics;
    const observedAtStats = observedAtColumn.meta_data?.statistics;
    if (
      Number(statisticValue(timeseriesStats, "min")) !==
        expected.min_timeseries_id ||
      Number(statisticValue(timeseriesStats, "max")) !==
        expected.max_timeseries_id ||
      timestampStatisticValue(observedAtStats, "min") !==
        expected.min_observed_at_utc ||
      timestampStatisticValue(observedAtStats, "max") !==
        expected.max_observed_at_utc
    ) {
      throw new Error(`Parquet row group ${ordinal} routing statistics mismatch`);
    }

    for (const columnName of REQUIRED_RANGED_READER_COLUMNS) {
      const column = columnChunk(actual, columnName);
      validateProjectedColumnChunkRange(
        column,
        `row group ${ordinal} ${columnName}`,
        body.byteLength,
      );
      validatedProjectedColumnChunks += 1;
      const available = validateOptionalPageIndexes(
        column,
        `row group ${ordinal} ${columnName}`,
        {
          arrayBuffer,
          schemaElement: schemaByName.get(columnName),
          rowCount: actualRows,
        },
      );
      pageIndexAvailability[columnName] =
        (pageIndexAvailability[columnName] ?? true) && available;
    }
  }
  if (actualGroups.length > limits.max_row_groups_per_file) {
    throw new Error("Parquet footer exceeds max_row_groups_per_file");
  }
  return {
    row_group_count: actualGroups.length,
    metadata_length: Number(metadata.metadata_length),
    projected_column_page_indexes: pageIndexAvailability,
    projected_column_chunk_fallback_supported:
      validatedProjectedColumnChunks ===
        actualGroups.length * REQUIRED_RANGED_READER_COLUMNS.length,
  };
}

function validateCompleteSegments(metadata, orderedRows) {
  const byTimeseries = new Map();
  for (const segment of metadata.segments) {
    if (!byTimeseries.has(segment.timeseries_id)) {
      byTimeseries.set(segment.timeseries_id, []);
    }
    byTimeseries.get(segment.timeseries_id).push(segment);
  }
  const expectedCounts = new Map();
  for (const row of orderedRows) {
    expectedCounts.set(
      row.timeseries_id,
      (expectedCounts.get(row.timeseries_id) || 0) + 1,
    );
  }
  for (const [timeseriesId, expectedCount] of expectedCounts) {
    const segments = byTimeseries.get(timeseriesId) || [];
    const actualCount = segments.reduce(
      (sum, segment) => sum + segment.row_count,
      0,
    );
    if (actualCount !== expectedCount) {
      throw new Error(
        `Exact segment coverage mismatch for timeseries_id=${timeseriesId}`,
      );
    }
    for (let index = 1; index < segments.length; index += 1) {
      const previous = segments[index - 1];
      const current = segments[index];
      const physicalOrderRegressed =
        current.file_ordinal < previous.file_ordinal ||
        (
          current.file_ordinal === previous.file_ordinal &&
          current.row_start < previous.row_start + previous.row_count
        );
      if (
        physicalOrderRegressed ||
        previous.max_observed_at_utc > current.min_observed_at_utc
      ) {
        throw new Error(
          `Exact segments overlap for timeseries_id=${timeseriesId}`,
        );
      }
    }
  }
}

/**
 * Build the isolated target physical layout for one canonical observation
 * day/connector/pollutant partition. This function has no R2 side effects.
 */
export function buildCanonicalObservationTimeseriesBoundedFiles(rows, {
  limits: rawLimits,
  fileKeyForOrdinal,
} = {}) {
  if (typeof fileKeyForOrdinal !== "function") {
    throw new TypeError("fileKeyForOrdinal must be a deterministic function");
  }
  const limits = validateLimits(rawLimits);
  const { orderedRows, contentHash, partition } = canonicalPhysicalRows(rows);
  const candidates = buildSerializedCandidates(orderedRows, limits);
  const keys = new Set();
  const fileBodies = [];
  const fileMetadata = [];
  const segments = [];

  for (const [fileOrdinal, candidate] of candidates.entries()) {
    const key = String(fileKeyForOrdinal(fileOrdinal) || "").trim();
    if (!key || keys.has(key)) {
      throw new TypeError("fileKeyForOrdinal must return unique non-empty keys");
    }
    keys.add(key);
    if (
      candidate.rows.length > limits.max_file_rows ||
      candidate.body.byteLength > limits.max_file_bytes
    ) {
      throw new Error(`Target observation file ${key} exceeds a hard bound`);
    }
    const groupSizes = candidate.rowGroups.map((group) => group.length);
    const intended = buildIntendedSegments(candidate.rows, groupSizes);
    const footer = validateFooter({
      body: candidate.body,
      rows: candidate.rows,
      limits,
      intended,
    });
    const sha256 = sha256Hex(candidate.body);
    const identity = {
      file_ordinal: fileOrdinal,
      key,
      row_count: candidate.rows.length,
      byte_size: candidate.body.byteLength,
      sha256,
      etag: null,
      history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
      writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
      physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    };
    const exactSegments = intended.segments.map((segment) => ({
      ...segment,
      file_ordinal: fileOrdinal,
      file_key: key,
      file_row_count: identity.row_count,
      file_byte_size: identity.byte_size,
      file_sha256: identity.sha256,
      file_etag: identity.etag,
      history_schema_version: identity.history_schema_version,
      writer_version: identity.writer_version,
      physical_layout_version: identity.physical_layout_version,
    }));
    const rowGroups = intended.rowGroups.map((rowGroup) => ({
      ...rowGroup,
      segments: exactSegments.filter(
        (segment) => segment.row_group_ordinal === rowGroup.row_group_ordinal,
      ),
    }));
    fileBodies.push({ key, body: candidate.body });
    fileMetadata.push({
      ...identity,
      row_group_count: footer.row_group_count,
      row_groups: rowGroups,
      footer_validation: footer,
      timeseries_row_counts: Object.fromEntries(
        Array.from(
          candidate.rows.reduce((counts, row) => {
            counts.set(
              String(row.timeseries_id),
              (counts.get(String(row.timeseries_id)) || 0) + 1,
            );
            return counts;
          }, new Map()),
        ).sort(([left], [right]) => Number(left) - Number(right)),
      ),
    });
    segments.push(...exactSegments);
  }

  const metadata = {
    history_version: "v2",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    columns: [...OBSERVATION_HISTORY_COLUMNS_V3],
    physical_order: [
      "timeseries_id ASC",
      "observed_at_utc ASC",
      "canonical_observation_row_v1 ASC",
    ],
    partition,
    limits: { ...limits },
    row_count: orderedRows.length,
    file_count: fileMetadata.length,
    files: fileMetadata,
    segments,
    ...contentHash,
  };
  validateCompleteSegments(metadata, orderedRows);
  return { metadata, file_bodies: fileBodies };
}
