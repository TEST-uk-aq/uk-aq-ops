import assert from "node:assert/strict";
import test from "node:test";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

import {
  computeObservationContentHash,
} from "../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  buildCanonicalObservationTimeseriesBoundedFiles,
  OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
} from "../workers/shared/uk_aq_observation_history_target_writer.mjs";

const limits = Object.freeze({
  target_row_group_rows: 2,
  max_row_group_rows: 2,
  target_file_rows: 4,
  max_file_rows: 4,
  target_file_bytes: 1_000_000,
  max_file_bytes: 2_000_000,
  max_row_groups_per_file: 2,
});
const projectedReaderColumns = Object.freeze([
  "timeseries_id",
  "observed_at_utc",
  "value",
]);

const rows = [
  [200, "2026-01-02T01:00:00.000Z", 20, "R"],
  [100, "2026-01-02T04:00:00.000Z", 14, null],
  [300, "2026-01-02T02:00:00.000Z", 31, "P"],
  [100, "2026-01-02T00:00:00.000Z", 10, "P"],
  [100, "2026-01-02T03:00:00.000Z", 13, "R"],
  [300, "2026-01-02T02:00:00.000Z", 30, "P"],
  [200, "2026-01-02T00:00:00.000Z", 19, null],
  [100, "2026-01-02T02:00:00.000Z", 12, null],
  [100, "2026-01-02T01:00:00.000Z", 11, "P"],
  [300, "2026-01-02T02:00:00.000Z", 30, "P"],
].map(([timeseriesId, observedAtUtc, value, verificationStatus]) => ({
  connector_id: 1,
  station_id: timeseriesId + 1,
  timeseries_id: timeseriesId,
  pollutant_code: "pm25",
  observed_at_utc: observedAtUtc,
  value,
  verification_status: verificationStatus,
}));

function build(inputRows, customLimits = limits, keyPrefix = "part") {
  return buildCanonicalObservationTimeseriesBoundedFiles(inputRows, {
    limits: customLimits,
    fileKeyForOrdinal: (ordinal) =>
      `history/v2/observations/day_utc=2026-01-02/connector_id=1/pollutant_code=pm25/${keyPrefix}-${String(ordinal).padStart(5, "0")}.parquet`,
  });
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

function makeRows(timeseriesId, count, minuteOffset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    connector_id: 1,
    station_id: timeseriesId + 1,
    timeseries_id: timeseriesId,
    pollutant_code: "pm25",
    observed_at_utc: new Date(
      Date.UTC(2026, 0, 2, 0, minuteOffset + index),
    ).toISOString(),
    value: timeseriesId + index / 10,
    verification_status: index % 2 ? "P" : null,
  }));
}

function assertProjectedColumnChunkRanges(metadata, fileByteLength) {
  let sawDictionaryPage = false;
  for (const [rowGroupOrdinal, rowGroup] of metadata.row_groups.entries()) {
    for (const columnName of projectedReaderColumns) {
      const column = rowGroup.columns.find((candidate) =>
        candidate.meta_data?.path_in_schema?.length === 1 &&
        candidate.meta_data.path_in_schema[0] === columnName
      );
      assert.ok(column, `row group ${rowGroupOrdinal} has ${columnName}`);
      const columnMetadata = column.meta_data;
      const dataPageOffset = Number(columnMetadata.data_page_offset);
      const compressedSize = Number(columnMetadata.total_compressed_size);
      const hasDictionaryPage =
        columnMetadata.dictionary_page_offset !== undefined &&
        columnMetadata.dictionary_page_offset !== null;
      const dictionaryPageOffset = hasDictionaryPage
        ? Number(columnMetadata.dictionary_page_offset)
        : null;
      const chunkStart = hasDictionaryPage
        ? dictionaryPageOffset
        : dataPageOffset;
      const chunkEnd = chunkStart + compressedSize;

      assert.ok(Number.isSafeInteger(dataPageOffset));
      assert.ok(Number.isSafeInteger(compressedSize));
      assert.ok(compressedSize > 0);
      assert.ok(Number.isSafeInteger(chunkStart));
      assert.ok(Number.isSafeInteger(chunkEnd));
      assert.ok(chunkStart >= 0);
      assert.ok(dataPageOffset >= chunkStart);
      assert.ok(dataPageOffset < chunkEnd);
      assert.ok(chunkEnd <= fileByteLength);
      if (hasDictionaryPage) {
        sawDictionaryPage = true;
        assert.ok(dictionaryPageOffset < dataPageOffset);
      }
    }
  }
  return sawDictionaryPage;
}

async function decodeAndAssertExactSegments(result) {
  const decodedRows = [];
  let sawDictionaryPage = false;
  for (const file of result.file_bodies) {
    const arrayBuffer = exactArrayBuffer(file.body);
    const metadata = parquetMetadata(arrayBuffer, { geoparquet: false });
    const fileMetadata = result.metadata.files.find((entry) =>
      entry.key === file.key
    );
    assert.ok(fileMetadata);
    assert.equal(Number(metadata.num_rows), fileMetadata.row_count);
    assert.deepEqual(
      metadata.row_groups.map((rowGroup) => Number(rowGroup.num_rows)),
      fileMetadata.row_groups.map((rowGroup) => rowGroup.row_count),
    );
    assert.equal(
      fileMetadata.footer_validation.projected_column_chunk_fallback_supported,
      true,
    );
    sawDictionaryPage =
      assertProjectedColumnChunkRanges(metadata, file.body.byteLength) ||
      sawDictionaryPage;

    const decodedFileRows = await parquetReadObjects({
      file: arrayBuffer,
      metadata,
      compressors,
    });
    const coverage = Array(decodedFileRows.length).fill(0);
    let rowGroupStart = 0;
    for (const rowGroup of fileMetadata.row_groups) {
      for (const segment of rowGroup.segments) {
        assert.equal(segment.file_key, file.key);
        assert.equal(
          segment.row_group_ordinal,
          rowGroup.row_group_ordinal,
        );
        assert.equal(
          segment.row_group_row_start,
          segment.row_start - rowGroupStart,
        );
        assert.ok(segment.row_start >= rowGroupStart);
        assert.ok(
          segment.row_start + segment.row_count <=
            rowGroupStart + rowGroup.row_count,
        );
        const segmentRows = decodedFileRows.slice(
          segment.row_start,
          segment.row_start + segment.row_count,
        );
        assert.equal(segmentRows.length, segment.row_count);
        assert.ok(
          segmentRows.every((row) =>
            Number(row.timeseries_id) === segment.timeseries_id
          ),
        );
        const segmentTimes = segmentRows.map((row) =>
          row.observed_at_utc instanceof Date
            ? row.observed_at_utc.toISOString()
            : String(row.observed_at_utc)
        );
        assert.equal(segmentTimes[0], segment.min_observed_at_utc);
        assert.equal(
          segmentTimes[segmentTimes.length - 1],
          segment.max_observed_at_utc,
        );
        for (
          let rowIndex = segment.row_start;
          rowIndex < segment.row_start + segment.row_count;
          rowIndex += 1
        ) {
          coverage[rowIndex] += 1;
        }
      }
      rowGroupStart += rowGroup.row_count;
    }
    assert.ok(coverage.every((count) => count === 1));
    decodedRows.push(...decodedFileRows);
  }
  assert.equal(sawDictionaryPage, true);
  return decodedRows;
}

test("target observation writer deterministically validates bounded files and exact segments", async () => {
  const first = build(rows);
  const second = build([...rows].reverse());

  assert.deepEqual(first.metadata, second.metadata);
  assert.equal(first.file_bodies.length, second.file_bodies.length);
  for (let index = 0; index < first.file_bodies.length; index += 1) {
    assert.equal(
      Buffer.compare(
        first.file_bodies[index].body,
        second.file_bodies[index].body,
      ),
      0,
    );
  }

  assert.equal(
    first.metadata.physical_layout_version,
    OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
  );
  assert.equal(first.metadata.history_schema_version, 3);
  assert.equal(first.metadata.writer_version, "parquet-wasm-zstd-v3");
  assert.ok(first.metadata.files.some((file) => file.row_group_count > 1));
  assert.ok(
    first.metadata.files.every(
      (file) =>
        file.row_count <= limits.max_file_rows &&
        file.byte_size <= limits.max_file_bytes &&
        Object.values(
          file.footer_validation.projected_column_page_indexes,
        ).every(Boolean) &&
        file.row_groups.every(
          (rowGroup) => rowGroup.row_count <= limits.max_row_group_rows,
        ),
    ),
  );

  const continued = first.metadata.segments.filter(
    (segment) => segment.timeseries_id === 100,
  );
  assert.ok(new Set(continued.map((segment) => segment.file_key)).size > 1);
  assert.equal(
    continued.reduce((sum, segment) => sum + segment.row_count, 0),
    5,
  );

  const decodedRows = await decodeAndAssertExactSegments(first);
  const decodedCanonicalRows = decodedRows.map((row) => ({
    ...row,
    observed_at_utc: row.observed_at_utc instanceof Date
      ? row.observed_at_utc.toISOString()
      : String(row.observed_at_utc),
  }));
  const decodedHash = computeObservationContentHash(decodedCanonicalRows);
  const sourceHash = computeObservationContentHash(rows);
  assert.equal(decodedHash.observation_content_hash, sourceHash.observation_content_hash);
  assert.equal(decodedHash.observation_content_hash_row_count, rows.length);
  assert.deepEqual(
    decodedHash.verification_status_counts,
    sourceHash.verification_status_counts,
  );

  const boundaryLimits = Object.freeze({
    target_row_group_rows: 4,
    max_row_group_rows: 4,
    target_file_rows: 8,
    max_file_rows: 8,
    target_file_bytes: 1_000_000,
    max_file_bytes: 2_000_000,
    max_row_groups_per_file: 2,
  });
  const boundaryRows = [
    ...makeRows(400, 3),
    ...makeRows(500, 2, 10),
  ];
  const boundaryResult = build(
    [...boundaryRows].reverse(),
    boundaryLimits,
    "boundary",
  );
  assert.equal(boundaryResult.metadata.file_count, 1);
  assert.deepEqual(
    boundaryResult.metadata.files[0].row_groups.map((rowGroup) =>
      rowGroup.row_count
    ),
    [3, 2],
  );
  assert.deepEqual(
    boundaryResult.metadata.segments.map((segment) => [
      segment.timeseries_id,
      segment.row_count,
    ]),
    [[400, 3], [500, 2]],
  );
  await decodeAndAssertExactSegments(boundaryResult);

  const byteBaseLimits = Object.freeze({
    target_row_group_rows: 4,
    max_row_group_rows: 4,
    target_file_rows: 20,
    max_file_rows: 20,
    target_file_bytes: 1_000_000,
    max_file_bytes: 2_000_000,
    max_row_groups_per_file: 4,
  });
  const largeTimeseriesRows = makeRows(700, 8);
  const followingTimeseriesRows = makeRows(800, 2, 20);
  const byteRows = [...largeTimeseriesRows, ...followingTimeseriesRows];
  const unsplitByteResult = build(byteRows, byteBaseLimits, "byte-unsplit");
  const largeOnlyResult = build(
    largeTimeseriesRows,
    byteBaseLimits,
    "byte-large",
  );
  const followingOnlyResult = build(
    followingTimeseriesRows,
    byteBaseLimits,
    "byte-following",
  );
  const byteTarget = followingOnlyResult.file_bodies[0].body.byteLength;
  assert.ok(largeOnlyResult.file_bodies[0].body.byteLength > byteTarget);
  const byteLimits = Object.freeze({
    ...byteBaseLimits,
    target_file_bytes: byteTarget,
  });
  const byteSplitResult = build(byteRows, byteLimits, "byte-split");
  const reversedByteSplitResult = build(
    [...byteRows].reverse(),
    byteLimits,
    "byte-split",
  );
  assert.ok(byteSplitResult.metadata.file_count > unsplitByteResult.metadata.file_count);
  assert.deepEqual(byteSplitResult.metadata, reversedByteSplitResult.metadata);
  assert.ok(
    byteSplitResult.file_bodies.every((file, index) =>
      file.body.byteLength <= byteLimits.max_file_bytes &&
      Buffer.compare(file.body, reversedByteSplitResult.file_bodies[index].body) ===
        0
    ),
  );
  const largeSegments = byteSplitResult.metadata.segments.filter(
    (segment) => segment.timeseries_id === 700,
  );
  const followingSegments = byteSplitResult.metadata.segments.filter(
    (segment) => segment.timeseries_id === 800,
  );
  assert.ok(new Set(largeSegments.map((segment) => segment.file_key)).size > 1);
  assert.equal(
    largeSegments.reduce((sum, segment) => sum + segment.row_count, 0),
    largeTimeseriesRows.length,
  );
  assert.equal(new Set(followingSegments.map((segment) => segment.file_key)).size, 1);
  assert.equal(
    followingSegments.reduce((sum, segment) => sum + segment.row_count, 0),
    followingTimeseriesRows.length,
  );
  const decodedByteRows = await decodeAndAssertExactSegments(byteSplitResult);
  const decodedByteHash = computeObservationContentHash(
    decodedByteRows.map((row) => ({
      ...row,
      observed_at_utc: row.observed_at_utc instanceof Date
        ? row.observed_at_utc.toISOString()
        : String(row.observed_at_utc),
    })),
  );
  assert.equal(
    decodedByteHash.observation_content_hash,
    computeObservationContentHash(byteRows).observation_content_hash,
  );
});
