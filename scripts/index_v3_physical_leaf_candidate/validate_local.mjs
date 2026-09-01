#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createPinnedObservationHistoryV3RandomAccessFile,
} from "../../workers/shared/uk_aq_observation_history_random_access_v3.mjs";
import {
  createObservationHistoryV3FooterCache,
  readObservationHistoryExactV3,
} from "../../workers/shared/uk_aq_observation_history_reader_v3.mjs";
import {
  readObservationHistoryPhysicalCandidate,
} from "../../workers/uk_aq_observs_history_r2_api_v3_physical_candidate/reader.mjs";
import {
  readObservationHistoryPhysicalLeafCandidate,
} from "../../workers/uk_aq_observs_history_r2_api_v3_leaf_candidate/reader.mjs";

const BASE_PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2";
const ALIGNED_INDEX_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations_timeseries`;
const ALIGNED_DATA_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations`;
const PHYSICAL_PREFIX = `${BASE_PREFIX}/candidate=physical-index-v1/cap_rows=1024`;
const PHYSICAL_INDEX_ROOT = `${PHYSICAL_PREFIX}/observations_timeseries`;
const LEAF_PREFIX = `${BASE_PREFIX}/candidate=physical-leaf-index-v1/cap_rows=1024`;
const LEAF_INDEX_ROOT = `${LEAF_PREFIX}/observations_timeseries`;
const ALIGNED_IDENTITY = Object.freeze({
  history_schema_version: 3,
  writer_version: "pyarrow-zstd-timeseries-aligned-candidate-v1",
  physical_layout_version: "timeseries-aligned-v2",
  parquet_footer_identity: "created_by_and_uk_aq_schema_metadata",
  parquet_created_by: "parquet-cpp-arrow version 25.0.1",
});

function parse(argv) {
  const options = {
    alignedRoot: "",
    alignedExtensionRoot: "",
    physicalRoot: "",
    leafRoot: "",
    leafExtensionRoot: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--aligned-root") options.alignedRoot = argv[++index] || "";
    else if (argument === "--aligned-extension-root") options.alignedExtensionRoot = argv[++index] || "";
    else if (argument === "--physical-root") options.physicalRoot = argv[++index] || "";
    else if (argument === "--leaf-root") options.leafRoot = argv[++index] || "";
    else if (argument === "--leaf-extension-root") options.leafExtensionRoot = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.alignedRoot || !options.physicalRoot || !options.leafRoot) {
    throw new Error("--aligned-root, --physical-root and --leaf-root are required");
  }
  if (Boolean(options.alignedExtensionRoot) !== Boolean(options.leafExtensionRoot)) {
    throw new Error("--aligned-extension-root and --leaf-extension-root must be supplied together");
  }
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, value ? path.resolve(value) : ""]),
  );
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function plan(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "publication-plan.json")));
}

function objectBytes(root, entry) {
  const bytes = fs.readFileSync(path.join(root, entry.local_path));
  assert.equal(bytes.byteLength, entry.byte_size, `byte size differs: ${entry.key}`);
  assert.equal(sha256(bytes), entry.sha256, `SHA-256 differs: ${entry.key}`);
  return bytes;
}

function allFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const selected = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(selected);
      else files.push(selected);
    }
  };
  visit(root);
  return files;
}

function assertLeafPlan({ alignedRoot, leafRoot }) {
  const alignedPlan = plan(alignedRoot);
  const alignedByKey = new Map(alignedPlan.objects.map((entry) => [entry.key, entry]));
  const leafPlan = plan(leafRoot);
  assert.equal(leafPlan.environment, "TEST");
  assert.equal(leafPlan.prototype_prefix, LEAF_PREFIX);
  assert.equal(leafPlan.index_root, LEAF_INDEX_ROOT);
  assert.equal(leafPlan.physical_leaf_candidate_version, "physical-leaf-index-v1");
  assert.equal(leafPlan.aligned_row_cap, 1024);
  assert.equal(leafPlan.reuses_aligned_parquet, true);
  assert.deepEqual(leafPlan.parquet_objects, []);
  assert.ok(leafPlan.objects.length > 0);
  assert.equal(allFiles(leafRoot).some((file) => file.endsWith(".parquet")), false);

  const parsed = new Map();
  for (const entry of leafPlan.objects) {
    assert.equal(entry.content_type, "application/json; charset=utf-8");
    assert.equal(entry.key.startsWith(`${LEAF_INDEX_ROOT}/`), true);
    assert.equal(entry.key.endsWith(".json"), true);
    const bytes = objectBytes(leafRoot, entry);
    parsed.set(entry.key, { entry, payload: JSON.parse(bytes), bytes });
  }

  const referencedLeaves = new Set();
  let manifestCount = 0;
  let leafCount = 0;
  for (const { entry, payload } of parsed.values()) {
    assert.equal(payload.aligned_row_cap, 1024);
    assert.equal(payload.physical_leaf_candidate_version, "physical-leaf-index-v1");
    assert.equal(payload.index_generation, "v3-physical-leaf-candidate");
    assert.equal(payload.physical_layout_version, "timeseries-aligned-v2");
    assert.equal(payload.key, entry.key);
    if (payload.kind === "observation_timeseries_physical_leaf_scoped_manifest") {
      manifestCount += 1;
      assert.ok(payload.decode_profile);
      assert.deepEqual(payload.leaf_descriptor_fields, ["key", "byte_size", "sha256"]);
      assert.equal(typeof payload.leaves_by_timeseries_id, "object");
      assert.equal(Array.isArray(payload.leaves_by_timeseries_id), false);
      assert.equal(payload.files, undefined);
      assert.equal(payload.segments, undefined);
      let previous = 0;
      for (const [timeseriesText, tuple] of Object.entries(payload.leaves_by_timeseries_id)) {
        const timeseriesId = Number(timeseriesText);
        assert.equal(Number.isSafeInteger(timeseriesId) && timeseriesId > previous, true);
        previous = timeseriesId;
        assert.equal(Array.isArray(tuple) && tuple.length === 3, true);
        const [key, byteSize, digest] = tuple;
        const expectedKey = `${entry.key.slice(0, -"/manifest.json".length)}/timeseries_id=${String(timeseriesId).padStart(9, "0")}.json`;
        assert.equal(key, expectedKey);
        const leaf = parsed.get(key);
        assert.ok(leaf, `manifest leaf missing: ${key}`);
        assert.equal(byteSize, leaf.entry.byte_size);
        assert.equal(digest, leaf.entry.sha256);
        assert.equal(referencedLeaves.has(key), false);
        referencedLeaves.add(key);
      }
      continue;
    }

    assert.equal(payload.kind, "observation_timeseries_physical_leaf");
    leafCount += 1;
    assert.equal(Number.isSafeInteger(payload.timeseries_id) && payload.timeseries_id > 0, true);
    assert.equal(payload.timeseries, undefined);
    assert.equal(payload.decode_profile, undefined);
    assert.equal(Array.isArray(payload.files), true);
    assert.equal(Array.isArray(payload.segments), true);
    assert.equal(
      entry.key.endsWith(`/timeseries_id=${String(payload.timeseries_id).padStart(9, "0")}.json`),
      true,
    );
    const usedFiles = new Set();
    for (const segment of payload.segments) {
      assert.equal(segment.row_count <= 1024, true);
      assert.equal(segment.row_group_row_start, 0);
      usedFiles.add(segment.file_key);
      const file = payload.files.find((candidate) => candidate.key === segment.file_key);
      assert.ok(file);
      const alignedEntry = alignedByKey.get(file.key);
      assert.ok(alignedEntry, `aligned fixture omits leaf Parquet: ${file.key}`);
      assert.equal(file.key.startsWith(`${ALIGNED_DATA_ROOT}/`), true);
      assert.equal(file.byte_size, alignedEntry.byte_size);
      assert.equal(file.sha256, alignedEntry.sha256);
      for (const name of ["observed_at_utc", "value"]) {
        const range = segment.column_ranges[name];
        assert.equal(Number.isSafeInteger(range.start) && range.start >= 0, true);
        assert.equal(range.start < range.end && range.end <= file.byte_size, true);
        assert.equal(range.data_page_offset >= range.start && range.data_page_offset < range.end, true);
        assert.equal(range.num_values, segment.row_count);
      }
    }
    assert.equal(usedFiles.size, payload.files.length);
  }
  assert.equal(referencedLeaves.size, leafCount);
  return {
    plan: leafPlan,
    manifestCount,
    leafCount,
    totalIndexBytes: leafPlan.objects.reduce((sum, entry) => sum + entry.byte_size, 0),
  };
}

function localSource({
  alignedRoot,
  alignedExtensionRoot,
  physicalRoot,
  leafRoot,
  leafExtensionRoot,
}) {
  const readFrom = (roots, key) => {
    let selected = null;
    for (const root of roots.filter(Boolean)) {
      const candidate = path.join(root, "objects", key);
      if (!fs.existsSync(candidate)) continue;
      const bytes = fs.readFileSync(candidate);
      if (selected && !bytes.equals(selected)) {
        throw new Error(`fixture overlay changes an existing object: ${key}`);
      }
      selected = bytes;
    }
    if (!selected) {
      const error = new Error(`fixture object not found: ${key}`);
      error.code = "ENOENT";
      throw error;
    }
    return selected;
  };
  const read = (key) => {
    if (key.startsWith(`${LEAF_PREFIX}/`)) {
      return readFrom([leafRoot, leafExtensionRoot], key);
    }
    if (key.startsWith(`${PHYSICAL_PREFIX}/`)) {
      return readFrom([physicalRoot], key);
    }
    return readFrom([alignedRoot, alignedExtensionRoot], key);
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
      if (Number.isFinite(diagnostics?.identity_head_reads)) {
        diagnostics.identity_head_reads += 1;
      }
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

function requestedUtcDays(item) {
  return (Date.parse(item.end_utc) - Date.parse(item.start_utc)) / 86_400_000;
}

function assertExtensionDoesNotRewrite({ baseRoot, extensionRoot, prefix, kind }) {
  if (!extensionRoot) return { objectCount: 0, parquetCount: 0 };
  const basePlan = plan(baseRoot);
  const extensionPlan = plan(extensionRoot);
  const baseKeys = new Set(basePlan.objects.map((entry) => entry.key));
  const allowedDays = new Set([
    "2026-08-21",
    "2026-08-22",
    "2026-08-23",
    "2026-08-24",
    "2026-08-25",
    "2026-08-26",
  ]);
  let parquetCount = 0;
  for (const entry of extensionPlan.objects) {
    assert.equal(baseKeys.has(entry.key), false, `${kind} extension rewrites ${entry.key}`);
    assert.equal(entry.key.startsWith(prefix), true);
    assert.equal(/(?:history\/v2|history\/_index_v3|_latest|backup|checkpoint|live)/i.test(entry.key), false);
    const day = /\/day_utc=(\d{4}-\d{2}-\d{2})\//.exec(entry.key)?.[1];
    assert.equal(allowedDays.has(day), true, `${kind} extension has unexpected day: ${entry.key}`);
    if (entry.key.endsWith(".parquet")) parquetCount += 1;
    objectBytes(extensionRoot, entry);
  }
  return { objectCount: extensionPlan.objects.length, parquetCount };
}

async function main() {
  const roots = parse(process.argv.slice(2));
  const structural = assertLeafPlan(roots);
  const extensionStructural = roots.leafExtensionRoot
    ? assertLeafPlan({
        alignedRoot: roots.alignedExtensionRoot,
        leafRoot: roots.leafExtensionRoot,
      })
    : null;
  const alignedExtension = assertExtensionDoesNotRewrite({
    baseRoot: roots.alignedRoot,
    extensionRoot: roots.alignedExtensionRoot,
    prefix: `${BASE_PREFIX}/cap_rows=1024/`,
    kind: "aligned",
  });
  const leafExtension = assertExtensionDoesNotRewrite({
    baseRoot: roots.leafRoot,
    extensionRoot: roots.leafExtensionRoot,
    prefix: `${LEAF_INDEX_ROOT}/`,
    kind: "leaf",
  });
  assert.equal(leafExtension.parquetCount, 0);
  const physicalPlan = plan(roots.physicalRoot);
  assert.equal(physicalPlan.prototype_prefix, PHYSICAL_PREFIX);
  const physicalTotalIndexBytes = physicalPlan.objects.reduce((sum, entry) => sum + entry.byte_size, 0);
  const source = localSource(roots);
  const cases = [
    {
      name: "sensorcommunity_normal_ts7421_24h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-08-20T00:00:00.000Z",
      end_utc: "2026-08-21T00:00:00.000Z",
      expected_rows: 288,
      expected_physical_rows: 288,
      expected_segments: 1,
    },
    {
      name: "sensorcommunity_dense_ts7421_1h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-04-03T00:00:00.000Z",
      end_utc: "2026-04-03T01:00:00.000Z",
      expected_rows: 527,
      expected_physical_rows: 1024,
      expected_segments: 1,
    },
  ];
  const normalDurationCases = [
    {
      name: "sensorcommunity_normal_ts7421_24h",
      start_utc: "2026-08-20T00:00:00.000Z",
      end_utc: "2026-08-21T00:00:00.000Z",
      expected_rows: 288,
    },
    {
      name: "sensorcommunity_normal_ts7421_48h",
      start_utc: "2026-08-20T00:00:00.000Z",
      end_utc: "2026-08-22T00:00:00.000Z",
      expected_rows: 576,
    },
    {
      name: "sensorcommunity_normal_ts7421_72h",
      start_utc: "2026-08-20T00:00:00.000Z",
      end_utc: "2026-08-23T00:00:00.000Z",
      expected_rows: 863,
    },
    {
      name: "sensorcommunity_normal_ts7421_7d",
      start_utc: "2026-08-20T00:00:00.000Z",
      end_utc: "2026-08-27T00:00:00.000Z",
      expected_rows: 1995,
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
    const [physical, leaf] = await Promise.all([
      readObservationHistoryPhysicalCandidate({
        ...common,
        indexRoot: PHYSICAL_INDEX_ROOT,
        alignedRowCap: 1024,
      }),
      readObservationHistoryPhysicalLeafCandidate({
        ...common,
        indexRoot: LEAF_INDEX_ROOT,
      }),
    ]);
    assert.equal(physical.response_complete, true);
    assert.equal(leaf.response_complete, true);
    assert.equal(physical.rows.length, item.expected_rows);
    assert.equal(leaf.rows.length, item.expected_rows);
    assert.equal(leaf.diagnostics.physical_rows_decoded, item.expected_physical_rows);
    assert.equal(leaf.diagnostics.selected_chronological_segments, item.expected_segments);
    assert.equal(leaf.diagnostics.index_objects_read, 2);
    assert.equal(leaf.diagnostics.timeseries_leaf_objects_read, 1);
    assert.equal(leaf.diagnostics.coarse_child_shards_read, 0);
    assert.equal(leaf.diagnostics.parquet_footer_fetched, false);
    assert.equal(leaf.diagnostics.parquet_footer_parsed, false);
    assert.equal(leaf.diagnostics.timeseries_id_decoded, false);
    assert.equal(leaf.diagnostics.identity_head_reads, leaf.diagnostics.selected_files);
    assert.equal(leaf.diagnostics.r2_range_reads, physical.diagnostics.r2_range_reads);
    assert.equal(leaf.diagnostics.r2_bytes_requested, physical.diagnostics.r2_bytes_requested);

    const physicalRows = comparable(physical.rows);
    const leafRows = comparable(leaf.rows);
    assert.deepEqual(leafRows, physicalRows);
    const physicalRowsSha256 = sha256(Buffer.from(JSON.stringify(physicalRows)));
    const leafRowsSha256 = sha256(Buffer.from(JSON.stringify(leafRows)));
    assert.equal(leafRowsSha256, physicalRowsSha256);
    assert.equal(leaf.diagnostics.index_bytes_read < physical.diagnostics.index_bytes_read, true);

    results.push({
      case: item.name,
      returned_rows: leaf.rows.length,
      selected_segments: leaf.diagnostics.selected_chronological_segments,
      physical_rows_decoded: leaf.diagnostics.physical_rows_decoded,
      physical_index_objects_read: physical.diagnostics.index_objects_read,
      physical_index_bytes_read: physical.diagnostics.index_bytes_read,
      leaf_index_objects_read: leaf.diagnostics.index_objects_read,
      leaf_index_bytes_read: leaf.diagnostics.index_bytes_read,
      timeseries_leaf_objects_read: leaf.diagnostics.timeseries_leaf_objects_read,
      timeseries_leaf_bytes_read: leaf.diagnostics.timeseries_leaf_bytes_read,
      coarse_child_shards_read: leaf.diagnostics.coarse_child_shards_read,
      r2_range_reads: leaf.diagnostics.r2_range_reads,
      r2_bytes_requested: leaf.diagnostics.r2_bytes_requested,
      physical_rows_sha256: physicalRowsSha256,
      leaf_rows_sha256: leafRowsSha256,
      equal_to_physical_1024_reader: true,
    });
  }

  const normalDurationResults = [];
  if (roots.alignedExtensionRoot) {
    for (const item of normalDurationCases) {
      const common = {
        source,
        timeseriesId: 7421,
        connectorId: 7,
        pollutantCode: "pm25",
        startUtc: item.start_utc,
        endUtc: item.end_utc,
      };
      const [reference, leaf] = await Promise.all([
        readObservationHistoryExactV3({
          ...common,
          indexGeneration: "v3",
          historyVersion: "v2",
          indexRoot: ALIGNED_INDEX_ROOT,
          physicalIdentity: ALIGNED_IDENTITY,
          footerCache: createObservationHistoryV3FooterCache(),
          collectWorkloadDiagnostics: true,
        }),
        readObservationHistoryPhysicalLeafCandidate({
          ...common,
          indexRoot: LEAF_INDEX_ROOT,
        }),
      ]);
      const requestedDays = requestedUtcDays(item);
      assert.equal(Number.isSafeInteger(requestedDays), true);
      assert.equal(reference.response_complete, true);
      assert.equal(leaf.response_complete, true);
      assert.equal(reference.rows.length, item.expected_rows);
      assert.equal(leaf.rows.length, item.expected_rows);
      assert.equal(leaf.diagnostics.index_objects_read, requestedDays * 2);
      assert.equal(leaf.diagnostics.timeseries_leaf_objects_read, requestedDays);
      assert.equal(leaf.diagnostics.selected_files, requestedDays);
      assert.equal(leaf.diagnostics.selected_chronological_segments, requestedDays);
      assert.equal(leaf.diagnostics.physical_rows_decoded, item.expected_rows);
      assert.equal(leaf.diagnostics.identity_head_reads, requestedDays);
      assert.equal(leaf.diagnostics.coarse_child_shards_read, 0);
      assert.equal(leaf.diagnostics.parquet_footer_fetched, false);
      assert.equal(leaf.diagnostics.parquet_footer_parsed, false);
      assert.equal(leaf.diagnostics.timeseries_id_decoded, false);
      const referenceRows = comparable(reference.rows);
      const leafRows = comparable(leaf.rows);
      assert.deepEqual(leafRows, referenceRows);
      const referenceHash = sha256(Buffer.from(JSON.stringify(referenceRows)));
      const leafHash = sha256(Buffer.from(JSON.stringify(leafRows)));
      assert.equal(leafHash, referenceHash);
      normalDurationResults.push({
        case: item.name,
        requested_utc_days: requestedDays,
        returned_rows: leaf.rows.length,
        response_complete: leaf.response_complete,
        rows_sha256: leafHash,
        reference_rows_sha256: referenceHash,
        index_objects_read: leaf.diagnostics.index_objects_read,
        index_bytes_read: leaf.diagnostics.index_bytes_read,
        timeseries_leaf_objects_read: leaf.diagnostics.timeseries_leaf_objects_read,
        timeseries_leaf_bytes_read: leaf.diagnostics.timeseries_leaf_bytes_read,
        selected_files: leaf.diagnostics.selected_files,
        selected_chronological_segments: leaf.diagnostics.selected_chronological_segments,
        physical_rows_decoded: leaf.diagnostics.physical_rows_decoded,
        identity_head_reads: leaf.diagnostics.identity_head_reads,
        r2_range_reads: leaf.diagnostics.r2_range_reads,
        r2_bytes_requested: leaf.diagnostics.r2_bytes_requested,
        equal_to_aligned_1024_reference_reader: true,
      });
    }
  }

  const missingLeafKey =
    `${LEAF_INDEX_ROOT}/day_utc=2026-08-20/connector_id=7/pollutant_code=pm25/timeseries_id=000007421.json`;
  const missingLeafSource = Object.freeze({
    getIndexObject: (request) => request.key === missingLeafKey
      ? Promise.resolve(null)
      : source.getIndexObject(request),
    openParquetFile: (request) => source.openParquetFile(request),
  });
  const missingLeaf = await readObservationHistoryPhysicalLeafCandidate({
    source: missingLeafSource,
    timeseriesId: 7421,
    connectorId: 7,
    pollutantCode: "pm25",
    startUtc: "2026-08-20T00:00:00.000Z",
    endUtc: "2026-08-21T00:00:00.000Z",
    indexRoot: LEAF_INDEX_ROOT,
  });
  assert.equal(missingLeaf.response_complete, false);
  assert.deepEqual(missingLeaf.partial_reasons, ["required_physical_timeseries_leaf_missing"]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    node: process.version,
    scoped_manifest_count: structural.manifestCount + (extensionStructural?.manifestCount || 0),
    leaf_count: structural.leafCount + (extensionStructural?.leafCount || 0),
    leaf_plan_objects: structural.plan.objects.length + (extensionStructural?.plan.objects.length || 0),
    parquet_objects_created: structural.plan.parquet_objects.length,
    additional_aligned_objects: alignedExtension.objectCount,
    additional_aligned_parquet_objects: alignedExtension.parquetCount,
    additional_leaf_objects: leafExtension.objectCount,
    physical_index_total_bytes: physicalTotalIndexBytes,
    leaf_index_total_bytes: structural.totalIndexBytes + (extensionStructural?.totalIndexBytes || 0),
    aligned_cap_1024_parquet_reused_by_identity: true,
    missing_required_leaf_incomplete: true,
    results,
    normal_duration_results: normalDurationResults,
  }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
