#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createPinnedObservationHistoryV3RandomAccessFile,
} from "../../workers/shared/uk_aq_observation_history_random_access_v3.mjs";
import {
  OBSERVATION_HISTORY_EXACT_LEAF_PAGINATION_REASON,
  ObservationHistoryExactLeafReadError,
  readObservationHistoryExactLeafPageV3,
} from "../../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs";
import {
  readObservationHistoryPhysicalCandidate,
} from "../../workers/uk_aq_observs_history_r2_api_v3_physical_candidate/reader.mjs";
import {
  parseObservationRequest,
  physicalLeafCandidateReaderIndex,
} from "../../workers/uk_aq_observs_history_r2_api_v3_leaf_candidate/worker.mjs";

const BASE_PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2";
const ALIGNED_DATA_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations`;
const PHYSICAL_PREFIX = `${BASE_PREFIX}/candidate=physical-index-v1/cap_rows=1024`;
const PHYSICAL_INDEX_ROOT = `${PHYSICAL_PREFIX}/observations_timeseries`;
const LEAF_PREFIX = `${BASE_PREFIX}/candidate=physical-leaf-index-v1/cap_rows=1024`;
const LEAF_INDEX_ROOT = `${LEAF_PREFIX}/observations_timeseries`;

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

function rowsSha256(rows) {
  return sha256(Buffer.from(JSON.stringify(comparable(rows))));
}

async function walkLeafPages({ source, item }) {
  const rows = [];
  const pages = [];
  const cursors = new Set();
  let physicalCursor = null;
  for (let pageNumber = 1; pageNumber <= 256; pageNumber += 1) {
    const page = await readObservationHistoryExactLeafPageV3({
      source,
      timeseriesId: item.timeseries_id,
      connectorId: item.connector_id,
      pollutantCode: "pm25",
      startUtc: item.start_utc,
      endUtc: item.end_utc,
      physicalCursor,
      index: physicalLeafCandidateReaderIndex(LEAF_INDEX_ROOT),
    });
    const physical = page.physical_page;
    assert.equal(physical.page_number, pageNumber);
    assert.equal(physical.continuation_cursor_supplied, pageNumber > 1);
    assert.ok(physical.candidate_intersecting_segments >= physical.segments_decoded);
    assert.ok(physical.segments_decoded === 0 || physical.segments_decoded === 1);
    assert.ok(physical.physical_rows_decoded >= 0 && physical.physical_rows_decoded <= 1024);
    assert.equal(page.diagnostics.selected_chronological_segments, physical.segments_decoded);
    assert.equal(page.diagnostics.selected_files, physical.segments_decoded);
    assert.equal(page.diagnostics.physical_segments_decoded, physical.segments_decoded);
    assert.equal(page.diagnostics.physical_rows_decoded, physical.physical_rows_decoded);
    assert.equal(page.diagnostics.identity_head_reads, physical.segments_decoded);
    assert.ok(page.diagnostics.r2_range_reads <= 2);
    assert.equal(page.diagnostics.selected_coordinates.length, physical.segments_decoded);
    for (const name of ["observed_at_utc", "value"]) {
      const ranges = page.diagnostics.requested_physical_byte_ranges_by_column[name];
      assert.equal(ranges.length, physical.segments_decoded);
      if (ranges.length) {
        assert.equal(ranges[0].file_key, page.diagnostics.selected_coordinates[0].file_key);
        assert.equal(ranges[0].row_group_ordinal, page.diagnostics.selected_coordinates[0].row_group_ordinal);
      }
    }
    assert.equal(page.diagnostics.parquet_footer_fetched, false);
    assert.equal(page.diagnostics.parquet_footer_parsed, false);
    assert.equal(page.diagnostics.timeseries_id_decoded, false);
    assert.equal(page.diagnostics.coarse_child_shards_read, 0);
    rows.push(...page.rows);
    pages.push(page);
    if (physical.pagination_complete) {
      assert.equal(physical.next_cursor, null);
      assert.equal(page.response_complete, true);
      assert.equal(page.has_gap, false);
      break;
    }
    assert.equal(page.response_complete, false);
    assert.equal(page.has_gap, false);
    assert.deepEqual(page.coverage_partial_reasons, []);
    assert.deepEqual(page.partial_reasons, [OBSERVATION_HISTORY_EXACT_LEAF_PAGINATION_REASON]);
    assert.equal(typeof physical.next_cursor, "string");
    assert.ok(physical.next_cursor.length > 0);
    assert.equal(cursors.has(physical.next_cursor), false);
    cursors.add(physical.next_cursor);
    physicalCursor = physical.next_cursor;
  }
  assert.equal(pages.at(-1)?.physical_page.pagination_complete, true);
  return { rows, pages, rows_sha256: rowsSha256(rows) };
}

function decodeCursor(cursor) {
  const padded = cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

async function assertCursorRejected(action) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ObservationHistoryExactLeafReadError);
    assert.equal(error.code, "physical_cursor_invalid");
    return true;
  });
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
      expected_pages: 1,
    },
    {
      name: "sensorcommunity_dense_ts7421_1h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-04-03T00:00:00.000Z",
      end_utc: "2026-04-03T01:00:00.000Z",
      expected_rows: 527,
      expected_physical_rows: 1024,
      expected_pages: 1,
    },
    {
      name: "sensorcommunity_dense_ts7421_24h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-04-03T00:00:00.000Z",
      end_utc: "2026-04-04T00:00:00.000Z",
      expected_rows: 12505,
      expected_physical_rows: 12505,
      expected_pages: 13,
    },
  ];

  const results = [];
  let denseFirstCursor = null;
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
      walkLeafPages({ source, item }),
    ]);
    assert.equal(physical.response_complete, true);
    assert.equal(physical.rows.length, item.expected_rows);
    assert.equal(leaf.rows.length, item.expected_rows);
    assert.equal(leaf.pages.length, item.expected_pages);
    assert.equal(
      leaf.pages.reduce((sum, page) => sum + page.physical_page.physical_rows_decoded, 0),
      item.expected_physical_rows,
    );
    assert.equal(leaf.pages.every((page) => page.physical_page.segments_decoded === 1), true);
    assert.equal(leaf.pages.every((page) => page.diagnostics.index_objects_read === 2), true);
    assert.equal(leaf.pages.every((page) => page.diagnostics.timeseries_leaf_objects_read === 1), true);

    const physicalRows = comparable(physical.rows);
    const leafRows = comparable(leaf.rows);
    assert.deepEqual(leafRows, physicalRows);
    const physicalRowsSha256 = sha256(Buffer.from(JSON.stringify(physicalRows)));
    const leafRowsSha256 = leaf.rows_sha256;
    assert.equal(leafRowsSha256, physicalRowsSha256);
    if (item.expected_pages === 1) {
      assert.equal(leaf.pages[0].diagnostics.index_bytes_read < physical.diagnostics.index_bytes_read, true);
    }
    if (item.name === "sensorcommunity_dense_ts7421_24h") {
      denseFirstCursor = leaf.pages[0].physical_page.next_cursor;
    }

    results.push({
      case: item.name,
      returned_rows: leaf.rows.length,
      page_count: leaf.pages.length,
      rows_per_page: leaf.pages.map((page) => page.rows.length),
      physical_segments_decoded_per_page: leaf.pages.map((page) => page.physical_page.segments_decoded),
      physical_rows_decoded_per_page: leaf.pages.map((page) => page.physical_page.physical_rows_decoded),
      maximum_physical_segments_in_one_invocation: Math.max(...leaf.pages.map((page) => page.physical_page.segments_decoded)),
      maximum_physical_rows_in_one_invocation: Math.max(...leaf.pages.map((page) => page.physical_page.physical_rows_decoded)),
      physical_index_objects_read: physical.diagnostics.index_objects_read,
      physical_index_bytes_read: physical.diagnostics.index_bytes_read,
      leaf_index_objects_read_per_page: leaf.pages.map((page) => page.diagnostics.index_objects_read),
      leaf_index_bytes_read_per_page: leaf.pages.map((page) => page.diagnostics.index_bytes_read),
      r2_range_reads_per_page: leaf.pages.map((page) => page.diagnostics.r2_range_reads),
      r2_bytes_requested_per_page: leaf.pages.map((page) => page.diagnostics.r2_bytes_requested),
      physical_rows_sha256: physicalRowsSha256,
      leaf_rows_sha256: leafRowsSha256,
      equal_to_physical_1024_reader: true,
    });
  }

  assert.equal(typeof denseFirstCursor, "string");
  const denseRequest = {
    source,
    timeseriesId: 7421,
    connectorId: 7,
    pollutantCode: "pm25",
    startUtc: "2026-04-03T00:00:00.000Z",
    endUtc: "2026-04-04T00:00:00.000Z",
    index: physicalLeafCandidateReaderIndex(LEAF_INDEX_ROOT),
  };
  await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
    ...denseRequest,
    physicalCursor: "not-a-valid-cursor",
  }));
  for (const changed of [
    { timeseriesId: 7422 },
    { connectorId: 8 },
    { pollutantCode: "pm10" },
    { startUtc: "2026-04-03T00:01:00.000Z" },
    { endUtc: "2026-04-03T23:59:00.000Z" },
  ]) {
    await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
      ...denseRequest,
      ...changed,
      physicalCursor: denseFirstCursor,
    }));
  }
  await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
    ...denseRequest,
    index: { ...denseRequest.index, indexGeneration: "v3-physical-leaf-candidate-stale" },
    physicalCursor: denseFirstCursor,
  }));

  let staleCursorParquetOpens = 0;
  const staleCursorSource = Object.freeze({
    getIndexObject: (request) => source.getIndexObject(request),
    openParquetFile(request) {
      staleCursorParquetOpens += 1;
      return source.openParquetFile(request);
    },
  });
  const staleCursorPayload = decodeCursor(denseFirstCursor);
  staleCursorPayload.next.file_sha256 = "0".repeat(64);
  await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
    ...denseRequest,
    source: staleCursorSource,
    physicalCursor: encodeCursor(staleCursorPayload),
  }));
  assert.equal(staleCursorParquetOpens, 0);

  const exactly24hAcrossMidnight = parseObservationRequest(new URL(
    "https://candidate.invalid/v1/observations?timeseries_id=7421&connector_id=7&pollutant=pm25&start_utc=2026-08-20T12%3A00%3A00.000Z&end_utc=2026-08-21T12%3A00%3A00.000Z",
  ));
  assert.equal(exactly24hAcrossMidnight.ok, true);
  for (const [query, errorCode] of [
    ["start_utc=2026-08-20T00%3A00%3A00.000Z&end_utc=2026-08-21T00%3A00%3A00.001Z", "logical_range_exceeds_24_hours"],
    ["start_utc=2026-08-20T00%3A00%3A00.000Z&end_utc=2026-08-21T00%3A00%3A00.000Z&since_utc=2026-08-20T01%3A00%3A00.000Z", "since_utc_incompatible_with_physical_paging"],
    ["start_utc=2026-08-20T00%3A00%3A00.000Z&end_utc=2026-08-21T00%3A00%3A00.000Z&limit=100", "limit_incompatible_with_physical_paging"],
  ]) {
    const parsed = parseObservationRequest(new URL(
      `https://candidate.invalid/v1/observations?timeseries_id=7421&connector_id=7&pollutant=pm25&${query}`,
    ));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error_code, errorCode);
  }

  const missingLeafKey =
    `${LEAF_INDEX_ROOT}/day_utc=2026-08-20/connector_id=7/pollutant_code=pm25/timeseries_id=000007421.json`;
  const missingLeafSource = Object.freeze({
    getIndexObject: (request) => request.key === missingLeafKey
      ? Promise.resolve(null)
      : source.getIndexObject(request),
    openParquetFile: (request) => source.openParquetFile(request),
  });
  const missingLeaf = await readObservationHistoryExactLeafPageV3({
    source: missingLeafSource,
    timeseriesId: 7421,
    connectorId: 7,
    pollutantCode: "pm25",
    startUtc: "2026-08-20T00:00:00.000Z",
    endUtc: "2026-08-21T00:00:00.000Z",
    index: physicalLeafCandidateReaderIndex(LEAF_INDEX_ROOT),
  });
  assert.equal(missingLeaf.response_complete, false);
  assert.equal(missingLeaf.has_gap, true);
  assert.equal(missingLeaf.physical_page.pagination_complete, true);
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
    cursor_validation: {
      malformed_rejected: true,
      cross_request_replay_rejected: true,
      stale_index_identity_rejected: true,
      stale_physical_coordinate_rejected_before_parquet_open: true,
    },
    request_validation: {
      exact_24h_cross_utc_midnight_accepted: true,
      greater_than_24h_rejected: true,
      since_utc_rejected: true,
      limit_rejected: true,
    },
    results,
  }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
