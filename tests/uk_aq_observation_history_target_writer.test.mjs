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

function build(inputRows) {
  return buildCanonicalObservationTimeseriesBoundedFiles(inputRows, {
    limits,
    fileKeyForOrdinal: (ordinal) =>
      `history/v2/observations/day_utc=2026-01-02/connector_id=1/pollutant_code=pm25/part-${String(ordinal).padStart(5, "0")}.parquet`,
  });
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
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

  const decodedRows = [];
  for (const file of first.file_bodies) {
    const arrayBuffer = exactArrayBuffer(file.body);
    const metadata = parquetMetadata(arrayBuffer, { geoparquet: false });
    assert.equal(
      Number(metadata.num_rows),
      first.metadata.files.find((entry) => entry.key === file.key).row_count,
    );
    decodedRows.push(...await parquetReadObjects({
      file: arrayBuffer,
      metadata,
      compressors,
    }));
  }
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
});
