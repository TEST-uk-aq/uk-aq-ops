#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { getSchemaPath } from "hyparquet/src/schema.js";
import { toJson } from "hyparquet/src/utils.js";

const BASE_PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2";
const SOURCE_INDEX_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations_timeseries`;
const SOURCE_DATA_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations`;
const CANDIDATE_PREFIX = `${BASE_PREFIX}/candidate=physical-index-v1/cap_rows=1024`;
const CANDIDATE_INDEX_ROOT = `${CANDIDATE_PREFIX}/observations_timeseries`;
const ALIGNED_CAP = 1024;
const SHARD_WIDTH = 1000;
const EXPECTED_CREATED_BY = "parquet-cpp-arrow version 25.0.1";
const EXPECTED_LAYOUT = "timeseries-aligned-v2";
const EXPECTED_WRITER = "pyarrow-zstd-timeseries-aligned-candidate-v1";
const COLUMNS = ["observed_at_utc", "value"];

function parse(argv) {
  const options = { alignedRoot: "", outputRoot: "", environment: "", replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index] || (() => { throw new Error(`${argument} requires a value`); })();
    if (argument === "--aligned-root") options.alignedRoot = next();
    else if (argument === "--output-root") options.outputRoot = next();
    else if (argument === "--environment") options.environment = next();
    else if (argument === "--replace") options.replace = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.environment !== "TEST") throw new Error("--environment TEST is required");
  if (!options.alignedRoot || !options.outputRoot) {
    throw new Error("--aligned-root and --output-root are required");
  }
  const resolved = {
    ...options,
    alignedRoot: path.resolve(options.alignedRoot),
    outputRoot: path.resolve(options.outputRoot),
  };
  const outputName = path.basename(resolved.outputRoot);
  if (
    !/^index_v3_physical_candidate(?:[-_][a-z0-9][a-z0-9_-]*)?$/.test(outputName) ||
    resolved.outputRoot === resolved.alignedRoot ||
    resolved.outputRoot === path.parse(resolved.outputRoot).root
  ) throw new Error("--output-root must be a dedicated index_v3_physical_candidate directory");
  return resolved;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function safeInteger(value, label, { zero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (zero ? number < 0 : number <= 0)) {
    throw new Error(`${label} must be a ${zero ? "non-negative" : "positive"} safe integer`);
  }
  return number;
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function metadataValues(metadata) {
  return Object.fromEntries((metadata.key_value_metadata || []).map((entry) => [entry.key, entry.value]));
}

function columnChunk(rowGroup, name) {
  return rowGroup.columns.find((column) =>
    column?.meta_data?.path_in_schema?.length === 1 &&
    column.meta_data.path_in_schema[0] === name
  );
}

function columnRange(column, fileSize, label) {
  const metadata = column?.meta_data;
  if (!metadata) throw new Error(`missing ${label} column metadata`);
  const dataPageOffset = safeInteger(metadata.data_page_offset, `${label}.data_page_offset`, { zero: true });
  const dictionaryPageOffset = metadata.dictionary_page_offset === undefined || metadata.dictionary_page_offset === null
    ? null
    : safeInteger(metadata.dictionary_page_offset, `${label}.dictionary_page_offset`, { zero: true });
  const start = dictionaryPageOffset ?? dataPageOffset;
  const end = start + safeInteger(metadata.total_compressed_size, `${label}.total_compressed_size`);
  if (start >= end || end > fileSize || dataPageOffset < start || dataPageOffset >= end) {
    throw new Error(`${label} column chunk range is outside its pinned file`);
  }
  if (metadata.codec !== "ZSTD") throw new Error(`${label} must use ZSTD`);
  return {
    start,
    end,
    data_page_offset: dataPageOffset,
    dictionary_page_offset: dictionaryPageOffset,
    num_values: safeInteger(metadata.num_values, `${label}.num_values`),
  };
}

function decoderProfile(metadata) {
  const root = toJson(metadata.schema[0]);
  const columns = {};
  for (const name of COLUMNS) {
    const schemaPath = getSchemaPath(metadata.schema, [name]);
    const element = toJson(schemaPath.at(-1).element);
    columns[name] = {
      physical_type: element.type,
      codec: "ZSTD",
      schema_element: element,
    };
  }
  return {
    version: "hyparquet-direct-column-v1",
    hyparquet_version: "1.25.1",
    page_headers: "included_in_column_chunk_ranges",
    root_schema_element: root,
    columns,
  };
}

function fileBuffer(bytes) {
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return Object.freeze({
    byteLength: exact.byteLength,
    slice(start, end) { return exact.slice(start, end); },
  });
}

async function inspectFile({ alignedRoot, alignedPlanByKey, descriptor, requiredSegments }) {
  if (!descriptor.key.startsWith(`${SOURCE_DATA_ROOT}/`) || !descriptor.key.endsWith(".parquet")) {
    throw new Error(`aligned 1024 child references a file outside its fixed data root: ${descriptor.key}`);
  }
  const planEntry = alignedPlanByKey.get(descriptor.key);
  if (!planEntry) throw new Error(`aligned publication plan omits ${descriptor.key}`);
  const bytes = fs.readFileSync(path.join(alignedRoot, planEntry.local_path));
  if (bytes.byteLength !== descriptor.byte_size || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`aligned Parquet identity mismatch: ${descriptor.key}`);
  }
  const metadata = parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
    geoparquet: false,
  });
  const kv = metadataValues(metadata);
  if (metadata.created_by !== EXPECTED_CREATED_BY) throw new Error(`unexpected Parquet created_by: ${descriptor.key}`);
  if (
    kv.uk_aq_history_schema_version !== "3" ||
    kv.uk_aq_writer_version !== EXPECTED_WRITER ||
    kv.uk_aq_physical_layout_version !== EXPECTED_LAYOUT
  ) throw new Error(`unexpected Parquet schema identity: ${descriptor.key}`);
  if (safeInteger(metadata.num_rows, "metadata.num_rows", { zero: true }) !== descriptor.row_count) {
    throw new Error(`Parquet row count mismatch: ${descriptor.key}`);
  }
  if (metadata.row_groups.length !== descriptor.row_group_count) {
    throw new Error(`Parquet row-group count mismatch: ${descriptor.key}`);
  }
  const profile = decoderProfile(metadata);
  const ranges = new Map();
  for (const segment of requiredSegments) {
    const ordinal = safeInteger(segment.row_group_ordinal, "segment.row_group_ordinal", { zero: true });
    const rowGroup = metadata.row_groups[ordinal];
    if (!rowGroup) throw new Error(`missing indexed row group ${ordinal}: ${descriptor.key}`);
    const rowCount = safeInteger(rowGroup.num_rows, "row_group.num_rows");
    if (rowCount > ALIGNED_CAP || rowCount !== segment.row_count || segment.row_group_row_start !== 0) {
      throw new Error(`segment is not an entire aligned row group: ${descriptor.key}#${ordinal}`);
    }
    const timeseriesRows = await parquetReadObjects({
      file: fileBuffer(bytes), metadata, compressors, columns: ["timeseries_id"],
      rowStart: segment.row_start, rowEnd: segment.row_start + segment.row_count,
      useOffsetIndex: false,
    });
    if (
      timeseriesRows.length !== segment.row_count ||
      timeseriesRows.some((row) => row.timeseries_id !== segment.timeseries_id)
    ) throw new Error(`row group is not single-timeseries: ${descriptor.key}#${ordinal}`);
    const perColumn = {};
    for (const name of COLUMNS) {
      const range = columnRange(columnChunk(rowGroup, name), bytes.byteLength, `${descriptor.key}#${ordinal}.${name}`);
      if (range.num_values !== segment.row_count) {
        throw new Error(`column value count differs from segment rows: ${descriptor.key}#${ordinal}.${name}`);
      }
      perColumn[name] = range;
    }
    ranges.set(ordinal, perColumn);
  }
  return { profile, ranges };
}

function sourceIdentity(entry) {
  return { key: entry.key, byte_size: entry.byte_size, sha256: entry.sha256 };
}

function childKey(sourceKey) {
  if (!sourceKey.startsWith(`${SOURCE_INDEX_ROOT}/`)) throw new Error(`unexpected source index key: ${sourceKey}`);
  return `${CANDIDATE_INDEX_ROOT}/${sourceKey.slice(SOURCE_INDEX_ROOT.length + 1)}`;
}

function descriptorForCandidate(payload, body) {
  return {
    key: payload.key,
    byte_size: body.byteLength,
    sha256: sha256(body),
    range_start: payload.range_start,
    range_end: payload.range_end,
    row_count: payload.coverage.row_count,
    timeseries_count: payload.coverage.timeseries_count,
    timeseries_ids: payload.coverage.timeseries_ids,
    min_observed_at_utc: payload.coverage.min_observed_at_utc,
    max_observed_at_utc: payload.coverage.max_observed_at_utc,
    file_count: payload.files.length,
    files: payload.files.map(({ key, byte_size, sha256 }) => ({ key, byte_size, sha256 })),
  };
}

async function buildChild({ alignedRoot, alignedPlanByKey, sourceEntry }) {
  const sourceBytes = fs.readFileSync(path.join(alignedRoot, sourceEntry.local_path));
  if (sourceBytes.byteLength !== sourceEntry.byte_size || sha256(sourceBytes) !== sourceEntry.sha256) {
    throw new Error(`aligned child identity mismatch: ${sourceEntry.key}`);
  }
  const source = JSON.parse(sourceBytes);
  if (
    source.schema_version !== 3 || source.kind !== "observation_timeseries_exact_shard" ||
    source.physical_layout_version !== EXPECTED_LAYOUT || source.history_schema_version !== 3
  ) throw new Error(`unsupported aligned child: ${sourceEntry.key}`);
  const segmentsByFile = new Map();
  for (const timeseries of source.timeseries) {
    for (const segment of timeseries.segments) {
      const annotated = { ...segment, timeseries_id: timeseries.timeseries_id };
      const list = segmentsByFile.get(segment.file_key) || [];
      list.push(annotated);
      segmentsByFile.set(segment.file_key, list);
    }
  }
  let profile = null;
  const rangesByFile = new Map();
  for (const descriptor of source.files) {
    const inspected = await inspectFile({
      alignedRoot, alignedPlanByKey, descriptor,
      requiredSegments: segmentsByFile.get(descriptor.key) || [],
    });
    if (profile && JSON.stringify(profile) !== JSON.stringify(inspected.profile)) {
      throw new Error(`decoder profile differs across files in ${sourceEntry.key}`);
    }
    profile = inspected.profile;
    rangesByFile.set(descriptor.key, inspected.ranges);
  }
  const key = childKey(sourceEntry.key);
  return {
    schema_version: 1,
    kind: "observation_timeseries_physical_index_shard",
    physical_index_candidate_version: "physical-index-v1",
    index_generation: "v3-physical-index-candidate",
    history_version: "v2",
    domain: "observations",
    history_schema_version: 3,
    writer_version: EXPECTED_WRITER,
    physical_layout_version: EXPECTED_LAYOUT,
    aligned_row_cap: ALIGNED_CAP,
    shard_width: SHARD_WIDTH,
    key,
    day_utc: source.day_utc,
    connector_id: source.connector_id,
    pollutant_code: source.pollutant_code,
    range_start: source.range_start,
    range_end: source.range_end,
    coverage: source.coverage,
    source_aligned_child: sourceIdentity(sourceEntry),
    decode_profile: profile,
    files: source.files,
    timeseries: source.timeseries.map((timeseries) => ({
      timeseries_id: timeseries.timeseries_id,
      row_count: timeseries.row_count,
      min_observed_at_utc: timeseries.min_observed_at_utc,
      max_observed_at_utc: timeseries.max_observed_at_utc,
      segments: timeseries.segments.map((segment) => ({
        ...segment,
        column_ranges: rangesByFile.get(segment.file_key).get(segment.row_group_ordinal),
      })),
    })),
  };
}

function writeObject(outputRoot, key, payload) {
  const localPath = path.join("objects", key);
  const body = canonicalBytes(payload);
  const destination = path.join(outputRoot, localPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, body, { flag: "wx" });
  return {
    key,
    local_path: localPath,
    byte_size: body.byteLength,
    sha256: sha256(body),
    content_type: "application/json; charset=utf-8",
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const alignedPlan = readJson(options.alignedRoot, "publication-plan.json");
  if (alignedPlan.environment !== "TEST" || alignedPlan.prototype_prefix !== BASE_PREFIX) {
    throw new Error("aligned source is not the expected TEST prototype fixture");
  }
  if (fs.existsSync(options.outputRoot)) {
    if (!options.replace) throw new Error("output root exists; pass --replace to recreate it");
    fs.rmSync(options.outputRoot, { recursive: true });
  }
  fs.mkdirSync(options.outputRoot, { recursive: true });
  const alignedPlanByKey = new Map(alignedPlan.objects.map((entry) => [entry.key, entry]));
  const sourceChildren = alignedPlan.objects.filter((entry) =>
    entry.key.startsWith(`${SOURCE_INDEX_ROOT}/`) && /\/range=\d+-\d+\.json$/.test(entry.key)
  ).sort((left, right) => left.key.localeCompare(right.key));
  const sourceManifests = alignedPlan.objects.filter((entry) =>
    entry.key.startsWith(`${SOURCE_INDEX_ROOT}/`) && entry.key.endsWith("/manifest.json")
  ).sort((left, right) => left.key.localeCompare(right.key));
  if (!sourceChildren.length || !sourceManifests.length) throw new Error("no cap_rows=1024 aligned indexes found");

  const objects = [];
  const candidateChildrenBySource = new Map();
  for (const entry of sourceChildren) {
    const payload = await buildChild({ alignedRoot: options.alignedRoot, alignedPlanByKey, sourceEntry: entry });
    const object = writeObject(options.outputRoot, payload.key, payload);
    objects.push(object);
    candidateChildrenBySource.set(entry.key, { payload, object });
  }
  for (const sourceEntry of sourceManifests) {
    const sourceBytes = fs.readFileSync(path.join(options.alignedRoot, sourceEntry.local_path));
    if (sourceBytes.byteLength !== sourceEntry.byte_size || sha256(sourceBytes) !== sourceEntry.sha256) {
      throw new Error(`aligned scoped manifest identity mismatch: ${sourceEntry.key}`);
    }
    const source = JSON.parse(sourceBytes);
    const children = source.children.map((descriptor) => {
      const candidate = candidateChildrenBySource.get(descriptor.key);
      if (!candidate) throw new Error(`candidate child missing for ${descriptor.key}`);
      return descriptorForCandidate({ ...candidate.payload, key: candidate.object.key }, fs.readFileSync(path.join(options.outputRoot, candidate.object.local_path)));
    });
    const key = childKey(sourceEntry.key);
    const manifest = {
      schema_version: 1,
      kind: "observation_timeseries_physical_index_scoped_manifest",
      physical_index_candidate_version: "physical-index-v1",
      index_generation: "v3-physical-index-candidate",
      history_version: "v2",
      domain: "observations",
      history_schema_version: 3,
      writer_version: EXPECTED_WRITER,
      physical_layout_version: EXPECTED_LAYOUT,
      aligned_row_cap: ALIGNED_CAP,
      shard_width: SHARD_WIDTH,
      key,
      day_utc: source.day_utc,
      connector_id: source.connector_id,
      pollutant_code: source.pollutant_code,
      coverage: source.coverage,
      source_aligned_scoped_manifest: sourceIdentity(sourceEntry),
      children,
    };
    objects.push(writeObject(options.outputRoot, key, manifest));
  }
  const plan = {
    schema_version: 1,
    environment: "TEST",
    prototype_prefix: CANDIDATE_PREFIX,
    index_root: CANDIDATE_INDEX_ROOT,
    physical_index_candidate_version: "physical-index-v1",
    aligned_row_cap: ALIGNED_CAP,
    reuses_aligned_parquet: true,
    parquet_objects: [],
    objects: objects.sort((left, right) => left.key.localeCompare(right.key)),
  };
  fs.writeFileSync(path.join(options.outputRoot, "publication-plan.json"), canonicalBytes(plan), { flag: "wx" });
  const report = {
    ok: true,
    environment: "TEST",
    prototype_prefix: CANDIDATE_PREFIX,
    source_index_root: SOURCE_INDEX_ROOT,
    candidate_index_root: CANDIDATE_INDEX_ROOT,
    aligned_row_cap: ALIGNED_CAP,
    child_count: sourceChildren.length,
    scoped_manifest_count: sourceManifests.length,
    json_object_count: objects.length,
    parquet_objects_created: 0,
    parquet_footer_required_at_runtime: false,
    timeseries_id_required_at_runtime: false,
  };
  fs.writeFileSync(path.join(options.outputRoot, "report.json"), canonicalBytes(report), { flag: "wx" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
