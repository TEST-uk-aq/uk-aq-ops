#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createObservationHistoryV3FooterCache,
  readObservationHistoryExactV3,
} from "../../workers/shared/uk_aq_observation_history_reader_v3.mjs";
import {
  createPinnedObservationHistoryV3RandomAccessFile,
} from "../../workers/shared/uk_aq_observation_history_random_access_v3.mjs";
import {
  readObservationHistoryPhysicalCandidate,
} from "../../workers/uk_aq_observs_history_r2_api_v3_physical_candidate/reader.mjs";

const BASE_PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2";
const CANDIDATE_PREFIX = `${BASE_PREFIX}/candidate=physical-index-v1/cap_rows=1024`;
const BASE_INDEX_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations_timeseries`;
const CANDIDATE_INDEX_ROOT = `${CANDIDATE_PREFIX}/observations_timeseries`;
const IDENTITY = Object.freeze({
  history_schema_version: 3,
  writer_version: "pyarrow-zstd-timeseries-aligned-candidate-v1",
  physical_layout_version: "timeseries-aligned-v2",
  parquet_footer_identity: "created_by_and_uk_aq_schema_metadata",
  parquet_created_by: "parquet-cpp-arrow version 25.0.1",
});

function parse(argv) {
  const options = { alignedRoot: "", candidateRoot: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--aligned-root") options.alignedRoot = argv[++index] || "";
    else if (argument === "--candidate-root") options.candidateRoot = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.alignedRoot || !options.candidateRoot) {
    throw new Error("--aligned-root and --candidate-root are required");
  }
  return { alignedRoot: path.resolve(options.alignedRoot), candidateRoot: path.resolve(options.candidateRoot) };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function localSource({ alignedRoot, candidateRoot }) {
  const read = (key) => {
    const root = key.startsWith(`${CANDIDATE_PREFIX}/`) ? candidateRoot : alignedRoot;
    return fs.readFileSync(path.join(root, "objects", key));
  };
  return Object.freeze({
    async getIndexObject({ key, maxBytes }) {
      try {
        const bytes = read(key);
        assert.ok(bytes.byteLength <= maxBytes, `index exceeds read limit: ${key}`);
        return {
          key,
          body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          byte_size: bytes.byteLength,
        };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    openParquetFile({ identity, budget, diagnostics }) {
      const bytes = read(identity.key);
      diagnostics.identity_head_reads += 1;
      const digest = sha256(bytes);
      return createPinnedObservationHistoryV3RandomAccessFile({
        identity,
        objectMetadata: { byte_size: bytes.byteLength, sha256: digest, etag: digest },
        budget,
        readRange: async ({ offset, length }) => {
          const selected = bytes.subarray(offset, offset + length);
          return selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength);
        },
      });
    },
  });
}

function comparable(rows) {
  return rows.map((row) => ({
    observed_at_utc: row.observed_at_utc,
    value: row.value,
  }));
}

function assertPlan(candidateRoot) {
  const plan = JSON.parse(fs.readFileSync(path.join(candidateRoot, "publication-plan.json")));
  assert.equal(plan.environment, "TEST");
  assert.equal(plan.prototype_prefix, CANDIDATE_PREFIX);
  assert.equal(plan.index_root, CANDIDATE_INDEX_ROOT);
  assert.equal(plan.aligned_row_cap, 1024);
  assert.equal(plan.reuses_aligned_parquet, true);
  assert.deepEqual(plan.parquet_objects, []);
  assert.ok(plan.objects.length > 0);
  assert.ok(plan.objects.every((entry) =>
    entry.content_type.startsWith("application/json") &&
    entry.key.startsWith(`${CANDIDATE_INDEX_ROOT}/`) && entry.key.endsWith(".json")
  ));
  for (const entry of plan.objects) {
    const body = fs.readFileSync(path.join(candidateRoot, entry.local_path));
    assert.equal(body.byteLength, entry.byte_size);
    assert.equal(sha256(body), entry.sha256);
    const payload = JSON.parse(body);
    if (payload.kind !== "observation_timeseries_physical_index_shard") continue;
    assert.equal(payload.source_aligned_child.key.startsWith(BASE_INDEX_ROOT), true);
    for (const file of payload.files) {
      assert.equal(file.key.startsWith(`${BASE_PREFIX}/cap_rows=1024/observations/`), true);
      assert.equal(file.key.includes("/cap_rows=2048/"), false);
      assert.equal(file.key.startsWith(CANDIDATE_PREFIX), false);
    }
    for (const timeseries of payload.timeseries) {
      let previous = null;
      for (const segment of timeseries.segments) {
        assert.equal(segment.row_count <= 1024, true);
        assert.equal(segment.row_group_row_start, 0);
        assert.equal(previous === null || previous <= segment.min_observed_at_utc, true);
        previous = segment.max_observed_at_utc;
        const file = payload.files.find((candidate) => candidate.key === segment.file_key);
        assert.ok(file);
        for (const name of ["observed_at_utc", "value"]) {
          const range = segment.column_ranges[name];
          assert.equal(Number.isSafeInteger(range.start) && range.start >= 0, true);
          assert.equal(range.start < range.end && range.end <= file.byte_size, true);
          assert.equal(range.data_page_offset >= range.start && range.data_page_offset < range.end, true);
          assert.equal(range.num_values, segment.row_count);
        }
      }
    }
  }
  return plan;
}

async function main() {
  const roots = parse(process.argv.slice(2));
  const plan = assertPlan(roots.candidateRoot);
  const source = localSource(roots);
  const cases = [
    {
      name: "sensorcommunity_normal_ts7421_24h", connector_id: 7, timeseries_id: 7421,
      start_utc: "2026-08-20T00:00:00.000Z", end_utc: "2026-08-21T00:00:00.000Z",
      expected_rows: 288, expected_physical_rows: 288, expected_segments: 1,
    },
    {
      name: "sensorcommunity_dense_ts7421_1h", connector_id: 7, timeseries_id: 7421,
      start_utc: "2026-04-03T00:00:00.000Z", end_utc: "2026-04-03T01:00:00.000Z",
      expected_rows: 527, expected_physical_rows: 1024, expected_segments: 1,
    },
    {
      name: "sensorcommunity_dense_ts7421_24h", connector_id: 7, timeseries_id: 7421,
      start_utc: "2026-04-03T00:00:00.000Z", end_utc: "2026-04-04T00:00:00.000Z",
      expected_rows: 12505, expected_physical_rows: 12505, expected_segments: 13,
    },
  ];
  const results = [];
  for (const item of cases) {
    const common = {
      source,
      timeseriesId: item.timeseries_id,
      connectorId: item.connector_id,
      pollutantCode: "pm25",
      startUtc: item.start_utc,
      endUtc: item.end_utc,
    };
    const [baseline, candidate] = await Promise.all([
      readObservationHistoryExactV3({
        ...common,
        indexGeneration: "v3",
        historyVersion: "v2",
        indexRoot: BASE_INDEX_ROOT,
        physicalIdentity: IDENTITY,
        footerCache: createObservationHistoryV3FooterCache(),
        collectWorkloadDiagnostics: true,
      }),
      readObservationHistoryPhysicalCandidate({
        ...common,
        indexRoot: CANDIDATE_INDEX_ROOT,
        alignedRowCap: 1024,
      }),
    ]);
    assert.equal(baseline.response_complete, true);
    assert.equal(candidate.response_complete, true);
    assert.equal(candidate.rows.length, item.expected_rows);
    assert.equal(candidate.diagnostics.physical_rows_decoded, item.expected_physical_rows);
    assert.equal(candidate.diagnostics.selected_chronological_segments, item.expected_segments);
    assert.equal(candidate.diagnostics.aligned_row_cap, 1024);
    const baselineRows = comparable(baseline.rows);
    const candidateRows = comparable(candidate.rows);
    assert.deepEqual(candidateRows, baselineRows);
    const baselineRowsSha256 = sha256(Buffer.from(JSON.stringify(baselineRows)));
    const candidateRowsSha256 = sha256(Buffer.from(JSON.stringify(candidateRows)));
    assert.equal(candidateRowsSha256, baselineRowsSha256);
    assert.equal(candidate.diagnostics.parquet_footer_fetched, false);
    assert.equal(candidate.diagnostics.parquet_footer_parsed, false);
    assert.equal(candidate.diagnostics.timeseries_id_decoded, false);
    assert.equal(candidate.diagnostics.identity_head_reads, candidate.diagnostics.selected_files);
    assert.ok(candidate.diagnostics.r2_range_reads > 0);
    assert.ok(candidate.diagnostics.r2_bytes_requested > 0);
    results.push({
      case: item.name,
      returned_rows: candidate.rows.length,
      selected_segments: candidate.diagnostics.selected_chronological_segments,
      selected_files: candidate.diagnostics.selected_files,
      physical_rows_decoded: candidate.diagnostics.physical_rows_decoded,
      r2_range_reads: candidate.diagnostics.r2_range_reads,
      r2_bytes_requested: candidate.diagnostics.r2_bytes_requested,
      aligned_rows_sha256: baselineRowsSha256,
      physical_rows_sha256: candidateRowsSha256,
      equal_to_aligned_1024_reader: true,
    });
  }
  await assert.rejects(
    readObservationHistoryPhysicalCandidate({
      source,
      timeseriesId: 7421,
      connectorId: 7,
      pollutantCode: "pm25",
      startUtc: "2026-04-03T00:00:00.000Z",
      endUtc: "2026-04-03T01:00:00.000Z",
      indexRoot: CANDIDATE_INDEX_ROOT,
      alignedRowCap: 2048,
    }),
    /physical 2048 candidate requires its exact isolated index root/,
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    node: process.version,
    plan_objects: plan.objects.length,
    parquet_objects_created: plan.parquet_objects.length,
    cross_cap_namespace_rejected: true,
    results,
  }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
