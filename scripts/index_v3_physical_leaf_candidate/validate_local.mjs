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
  default as physicalLeafCandidateWorker,
  parseObservationRequest,
  physicalLeafCandidateReaderIndex,
} from "../../workers/uk_aq_observs_history_r2_api_v3_leaf_candidate/worker.mjs";

const BASE_PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2";
const ALIGNED_DATA_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations`;
const PHYSICAL_PREFIX = `${BASE_PREFIX}/candidate=physical-index-v1/cap_rows=1024`;
const PHYSICAL_INDEX_ROOT = `${PHYSICAL_PREFIX}/observations_timeseries`;
const LEAF_PREFIX = `${BASE_PREFIX}/candidate=physical-leaf-index-v1/cap_rows=1024`;
const LEAF_INDEX_ROOT = `${LEAF_PREFIX}/observations_timeseries`;
const EXPECTED_RESPONSE_ROWS_SHA256 = Object.freeze({
  sensorcommunity_normal_ts7421_24h: "7d1a65015c0a0b694c10297f3ec2d8f6e2823db71060eed114a055551c854743",
  sensorcommunity_dense_ts7421_1h: "d644c2f5ffb0dd3b5ba69ea1130785d38ee253a277feace7cb0c7c2758054691",
  sensorcommunity_dense_ts7421_24h: "d8d229992f96ed44fb6204959541732f2c126faa7d9c8132e514951b612fcabe",
});
const DIAGNOSTIC_MODES = Object.freeze([null, "workload_v1", "cpu_v1"]);

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
    readObjectBytes(key) {
      return read(key);
    },
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

function localR2Bucket(source) {
  const objectMetadata = (key, bytes) => {
    const digest = sha256(bytes);
    return {
      key,
      size: bytes.byteLength,
      etag: digest,
      httpEtag: `"${digest}"`,
      checksums: { sha256: Uint8Array.from(Buffer.from(digest, "hex")) },
    };
  };
  return Object.freeze({
    async head(key) {
      try {
        const bytes = source.readObjectBytes(key);
        return objectMetadata(key, bytes);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async get(key, options = {}) {
      try {
        const bytes = source.readObjectBytes(key);
        const metadata = objectMetadata(key, bytes);
        if (
          options.onlyIf?.etagMatches &&
          String(options.onlyIf.etagMatches).replaceAll('"', "") !== metadata.etag
        ) return null;
        const offset = options.range?.offset ?? 0;
        const length = options.range?.length ?? bytes.byteLength;
        const selected = bytes.subarray(offset, offset + length);
        return {
          ...metadata,
          body: true,
          ...(options.range ? { range: { offset, length } } : {}),
          async arrayBuffer() {
            return selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength);
          },
          async json() {
            return JSON.parse(selected.toString("utf8"));
          },
        };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
  });
}

function installLocalCache() {
  const entries = new Map();
  const counters = { match: 0, put: 0 };
  const cache = Object.freeze({
    async match(request) {
      counters.match += 1;
      return entries.get(request.url)?.clone() ?? null;
    },
    async put(request, response) {
      counters.put += 1;
      entries.set(request.url, response.clone());
    },
  });
  Object.defineProperty(globalThis, "caches", {
    value: Object.freeze({ default: cache }),
    configurable: true,
    writable: true,
  });
  return Object.freeze({ counters, entries });
}

function responseRowsSha256(rows) {
  return sha256(Buffer.from(JSON.stringify(rows)));
}

function assertCompactDiagnosticObject(payload, label) {
  const forbiddenKeys = new Set([
    "exact_reader_diagnostics",
    "selected_coordinates",
    "requested_physical_byte_ranges_by_column",
    "selected_segment_physical_identity",
    "selected_files",
    "selected_scopes",
    "sha256",
    "file_key",
    "leaf_key",
  ]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `${label} exposes verbose diagnostic key ${key}`);
      visit(child);
    }
  };
  visit(payload);
}

async function walkWorkerMode({ worker, env, item, mode, cacheState }) {
  const rows = [];
  const pages = [];
  const cursors = new Set();
  const logs = [];
  let cursor = null;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = (...values) => logs.push(values.map(String).join(" "));
  console.warn = (...values) => logs.push(values.map(String).join(" "));
  try {
    for (let pageNumber = 1; pageNumber <= 256; pageNumber += 1) {
      const url = new URL("https://physical-leaf-candidate.test/v1/observations");
      for (const [key, value] of Object.entries({
        timeseries_id: item.timeseries_id,
        connector_id: item.connector_id,
        pollutant: "pm25",
        start_utc: item.start_utc,
        end_utc: item.end_utc,
        ...(mode ? { diagnostics: mode } : {}),
        ...(cursor ? { physical_cursor: cursor } : {}),
      })) url.searchParams.set(key, String(value));
      const pending = [];
      const beforeCache = { ...cacheState.counters };
      const response = await worker.fetch(new Request(url, {
        headers: {
          "x-uk-aq-upstream-auth": "local-test-secret",
          "cf-ray": `local-${item.name}-${mode || "normal"}-${pageNumber}`,
        },
      }), env, { waitUntil: (promise) => pending.push(promise) });
      const text = await response.text();
      const payload = JSON.parse(text);
      await Promise.all(pending);
      assert.equal(response.ok, true);
      assert.equal(payload.ok, true);
      assert.equal(payload.row_count, payload.rows.length);
      assert.equal(payload.physical_page.schema_version, 2);
      assert.equal(payload.physical_page.page_number, pageNumber);
      assert.ok(payload.physical_page.segments_decoded <= 1);
      assert.ok(payload.physical_page.physical_rows_decoded <= 1024);
      assert.equal(response.headers.get("x-ukaq-cache-generation"), "physical-leaf-index-v1-1024-page-4-production-shaped");
      if (mode) {
        assert.equal(response.headers.get("x-ukaq-cache"), "BYPASS");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(cacheState.counters.match, beforeCache.match);
        assert.equal(cacheState.counters.put, beforeCache.put);
        assert.equal(payload.diagnostic_request.mode, mode);
        assert.equal(payload.diagnostic_request.cache_bypassed, true);
        assert.equal(payload.diagnostic_request.cpu_time_ms, null);
        assert.equal(response.headers.get("x-ukaq-diagnostic-request-id"), payload.diagnostic_request.request_id);
      } else {
        assert.equal(response.headers.get("x-ukaq-cache"), "MISS");
        assert.equal(payload.diagnostic_request, undefined);
        assert.equal(payload.coverage, undefined);
        assert.equal(payload.cpu_measurement, undefined);
        assert.equal(payload.diagnostics, undefined);
        assert.equal(cacheState.counters.match, beforeCache.match + 1);
        assert.equal(
          cacheState.counters.put,
          beforeCache.put + (payload.response_complete === true && payload.has_gap !== true ? 1 : 0),
        );
      }
      if (mode === "workload_v1") {
        assert.ok(payload.coverage?.exact_reader_diagnostics);
        assert.equal(payload.cpu_measurement, undefined);
      }
      if (mode === "cpu_v1") {
        assert.ok(payload.cpu_measurement);
        assert.equal(payload.coverage, undefined);
        assert.equal(payload.diagnostics, undefined);
        assertCompactDiagnosticObject(payload.cpu_measurement, "cpu_v1 response");
      }
      rows.push(...payload.rows);
      pages.push({
        response_bytes: Buffer.byteLength(text),
        physical_page: payload.physical_page,
        compact: payload.cpu_measurement ?? null,
        verbose: payload.coverage?.exact_reader_diagnostics ?? null,
      });
      if (payload.physical_page.pagination_complete) break;
      cursor = payload.physical_page.next_cursor;
      assert.equal(typeof cursor, "string");
      assert.equal(cursors.has(cursor), false);
      cursors.add(cursor);
    }
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  assert.equal(pages.at(-1)?.physical_page.pagination_complete, true);
  const parsedLogs = logs.map((entry) => JSON.parse(entry));
  if (mode === null) assert.equal(parsedLogs.length, 0);
  if (mode === "workload_v1") {
    assert.equal(parsedLogs.length, pages.length * 2);
    for (const entry of parsedLogs) assertCompactDiagnosticObject(entry, "workload_v1 log");
  }
  if (mode === "cpu_v1") {
    assert.equal(parsedLogs.length, pages.length);
    for (const entry of parsedLogs) {
      assert.equal(entry.event, "observation_history_v3_physical_leaf_candidate_cpu_measurement");
      assertCompactDiagnosticObject(entry, "cpu_v1 log");
    }
  }
  return {
    mode: mode || "normal",
    rows,
    rows_sha256: responseRowsSha256(rows),
    pages,
    page_count: pages.length,
    response_bytes_per_page: pages.map((page) => page.response_bytes),
    logs,
  };
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
    const expectedPath = item.expected_page_paths?.[pageNumber - 1] ||
      (pageNumber === 1 ? "initial_discovery" : "direct_leaf_continuation");
    const expectedManifestObjects = pageNumber === 1
      ? (item.expected_initial_manifest_objects ?? 1)
      : 0;
    const expectedLeafObjects = pageNumber === 1
      ? (item.expected_initial_leaf_objects ?? 1)
      : 1;
    assert.equal(physical.schema_version, 2);
    assert.equal(physical.page_number, pageNumber);
    assert.equal(physical.physical_page_path, expectedPath);
    assert.equal(page.diagnostics.physical_page_path, expectedPath);
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
    assert.equal(page.diagnostics.scoped_manifests_read, expectedManifestObjects);
    assert.equal(page.diagnostics.index_objects_read, expectedManifestObjects + expectedLeafObjects);
    assert.equal(page.diagnostics.timeseries_leaf_objects_read, expectedLeafObjects);
    assert.equal(page.diagnostics.whole_logical_range_segment_discovery, pageNumber === 1);
    assert.equal(page.diagnostics.global_segment_sorting, pageNumber === 1);
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
    assert.equal(encodeCursor(decodeCursor(physical.next_cursor)), physical.next_cursor);
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
  const cacheState = installLocalCache();
  const workerEnvironment = Object.freeze({
    UKAQ_ENV_NAME: "TEST",
    UK_AQ_R2_HISTORY_VERSION: "v2",
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v3-physical-leaf-candidate",
    UK_AQ_PHYSICAL_INDEX_PROTOTYPE_PREFIX: LEAF_PREFIX,
    UK_AQ_EDGE_UPSTREAM_SECRET: "local-test-secret",
    UK_AQ_HISTORY_BUCKET: localR2Bucket(source),
  });
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
    assert.equal(leaf.pages.every((page) => page.diagnostics.timeseries_leaf_objects_read === 1), true);

    const physicalRows = comparable(physical.rows);
    const leafRows = comparable(leaf.rows);
    assert.deepEqual(leafRows, physicalRows);
    const physicalRowsSha256 = sha256(Buffer.from(JSON.stringify(physicalRows)));
    const leafRowsSha256 = leaf.rows_sha256;
    assert.equal(leafRowsSha256, physicalRowsSha256);
    const workerModes = [];
    for (const mode of DIAGNOSTIC_MODES) {
      workerModes.push(await walkWorkerMode({
        worker: physicalLeafCandidateWorker,
        env: workerEnvironment,
        item,
        mode,
        cacheState,
      }));
    }
    const workerRows = workerModes.map((result) => result.rows);
    assert.deepEqual(workerRows[1], workerRows[0]);
    assert.deepEqual(workerRows[2], workerRows[0]);
    for (const result of workerModes) {
      assert.equal(result.page_count, item.expected_pages);
      assert.equal(result.rows.length, item.expected_rows);
      assert.equal(result.rows_sha256, EXPECTED_RESPONSE_ROWS_SHA256[item.name]);
      assert.equal(
        result.pages.every((page) => page.physical_page.segments_decoded <= 1),
        true,
      );
      assert.equal(
        result.pages.every((page) => page.physical_page.physical_rows_decoded <= 1024),
        true,
      );
    }
    for (const modeResult of workerModes.filter((result) => result.mode !== "normal")) {
      for (const [index, page] of modeResult.pages.entries()) {
        const diagnostics = page.compact ?? page.verbose;
        assert.equal(diagnostics.parquet_footer_fetched, false);
        assert.equal(diagnostics.parquet_footer_parsed, false);
        assert.equal(diagnostics.timeseries_id_decoded, false);
        assert.equal(diagnostics.physical_page_path, index === 0 ? "initial_discovery" : "direct_leaf_continuation");
        assert.equal(diagnostics.scoped_manifests_read, index === 0 ? 1 : 0);
      }
    }
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
      physical_page_path_per_page: leaf.pages.map((page) => page.diagnostics.physical_page_path),
      scoped_manifests_read_per_page: leaf.pages.map((page) => page.diagnostics.scoped_manifests_read),
      whole_logical_range_segment_discovery_per_page: leaf.pages.map((page) => page.diagnostics.whole_logical_range_segment_discovery),
      global_segment_sorting_per_page: leaf.pages.map((page) => page.diagnostics.global_segment_sorting),
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
      response_rows_sha256: EXPECTED_RESPONSE_ROWS_SHA256[item.name],
      worker_modes: workerModes.map((result) => ({
        mode: result.mode,
        returned_rows: result.rows.length,
        page_count: result.page_count,
        rows_sha256: result.rows_sha256,
        response_bytes_per_page: result.response_bytes_per_page,
      })),
      representative_response_bytes: {
        normal_production_shaped: workerModes[0].response_bytes_per_page[0],
        workload_verbose_proxy_for_previous_diagnostics: workerModes[1].response_bytes_per_page[0],
        cpu_compact: workerModes[2].response_bytes_per_page[0],
      },
      equal_to_physical_1024_reader: true,
    });
  }

  assert.equal(typeof denseFirstCursor, "string");
  const denseCursorV2 = decodeCursor(denseFirstCursor);
  assert.equal(denseCursorV2.schema_version, 2);
  assert.equal(denseCursorV2.kind, "uk_aq_observation_history_exact_leaf_physical_cursor");
  assert.equal(denseCursorV2.discovery.scopes.length, 1);
  assert.equal(denseCursorV2.discovery.total_intersecting_segments, 13);
  assert.equal(encodeCursor(denseCursorV2), denseFirstCursor);
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

  let outsideRootIndexReads = 0;
  const outsideRootSource = Object.freeze({
    getIndexObject(request) {
      outsideRootIndexReads += 1;
      return source.getIndexObject(request);
    },
    openParquetFile: (request) => source.openParquetFile(request),
  });
  const contradictoryCoveragePayload = decodeCursor(denseFirstCursor);
  contradictoryCoveragePayload.discovery.coverage_complete = false;
  await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
    ...denseRequest,
    source: outsideRootSource,
    physicalCursor: encodeCursor(contradictoryCoveragePayload),
  }));
  const outsideLeafPayload = decodeCursor(denseFirstCursor);
  const outsideLeafKey = "history/v2/observations/not-authoritative.json";
  outsideLeafPayload.next.leaf_key = outsideLeafKey;
  outsideLeafPayload.discovery.scopes[0].leaf_descriptor.key = outsideLeafKey;
  await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
    ...denseRequest,
    source: outsideRootSource,
    physicalCursor: encodeCursor(outsideLeafPayload),
  }));
  const outsideDataPayload = decodeCursor(denseFirstCursor);
  outsideDataPayload.next.file_key = "history/v2/observations/not-authoritative.parquet";
  await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
    ...denseRequest,
    source: outsideRootSource,
    physicalCursor: encodeCursor(outsideDataPayload),
  }));
  assert.equal(outsideRootIndexReads, 0);

  let staleCursorParquetOpens = 0;
  const staleCursorSource = Object.freeze({
    getIndexObject: (request) => source.getIndexObject(request),
    openParquetFile(request) {
      staleCursorParquetOpens += 1;
      return source.openParquetFile(request);
    },
  });
  const staleLeafPayload = decodeCursor(denseFirstCursor);
  staleLeafPayload.next.leaf_sha256 = "0".repeat(64);
  staleLeafPayload.discovery.scopes[0].leaf_descriptor.sha256 = "0".repeat(64);
  await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
    ...denseRequest,
    source: staleCursorSource,
    physicalCursor: encodeCursor(staleLeafPayload),
  }));
  const staleCursorPayload = decodeCursor(denseFirstCursor);
  staleCursorPayload.next.file_sha256 = "0".repeat(64);
  await assertCursorRejected(() => readObservationHistoryExactLeafPageV3({
    ...denseRequest,
    source: staleCursorSource,
    physicalCursor: encodeCursor(staleCursorPayload),
  }));
  assert.equal(staleCursorParquetOpens, 0);

  let crossUtcResult = null;
  if (roots.alignedExtensionRoot) {
    const crossUtc = await walkLeafPages({
      source,
      item: {
        connector_id: 7,
        timeseries_id: 7421,
        start_utc: "2026-08-20T12:00:00.000Z",
        end_utc: "2026-08-21T12:00:00.000Z",
        expected_page_paths: ["initial_discovery", "cross_scope_continuation"],
        expected_initial_manifest_objects: 2,
        expected_initial_leaf_objects: 2,
      },
    });
    assert.equal(crossUtc.pages.length, 2);
    assert.equal(crossUtc.pages[1].diagnostics.scoped_manifests_read, 0);
    assert.equal(crossUtc.pages[1].diagnostics.timeseries_leaf_objects_read, 1);
    assert.equal(crossUtc.rows.every(
      (row, index) => index === 0 || row.observed_at_utc >= crossUtc.rows[index - 1].observed_at_utc,
    ), true);
    crossUtcResult = {
      page_count: crossUtc.pages.length,
      returned_rows: crossUtc.rows.length,
      rows_sha256: crossUtc.rows_sha256,
      cursor_v2_base64url_characters: crossUtc.pages[0].physical_page.next_cursor.length,
      physical_page_paths: crossUtc.pages.map((page) => page.diagnostics.physical_page_path),
      scoped_manifests_read_per_page: crossUtc.pages.map((page) => page.diagnostics.scoped_manifests_read),
    };
  }

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
      stale_leaf_identity_rejected_before_parquet_open: true,
      stale_physical_coordinate_rejected_before_parquet_open: true,
      cursor_v2_round_trip: true,
      dense_cursor_v2_base64url_characters: denseFirstCursor.length,
      contradictory_carried_coverage_rejected_before_index_read: true,
      deterministic_leaf_and_data_roots_enforced_before_index_read: true,
    },
    request_validation: {
      exact_24h_cross_utc_midnight_accepted: true,
      greater_than_24h_rejected: true,
      since_utc_rejected: true,
      limit_rejected: true,
    },
    results,
    cross_utc_result: crossUtcResult,
  }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
