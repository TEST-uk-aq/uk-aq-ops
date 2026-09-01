#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPhysicalCandidateChild,
} from "../index_v3_physical_candidate_1024/generate.mjs";

const BASE_PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2";
const SOURCE_INDEX_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations_timeseries`;
const SOURCE_DATA_ROOT = `${BASE_PREFIX}/cap_rows=1024/observations`;
const CANDIDATE_PREFIX = `${BASE_PREFIX}/candidate=physical-leaf-index-v1/cap_rows=1024`;
const CANDIDATE_INDEX_ROOT = `${CANDIDATE_PREFIX}/observations_timeseries`;
const CANDIDATE_VERSION = "physical-leaf-index-v1";
const INDEX_GENERATION = "v3-physical-leaf-candidate";
const ALIGNED_CAP = 1024;
const EXPECTED_LAYOUT = "timeseries-aligned-v2";
const EXPECTED_WRITER = "pyarrow-zstd-timeseries-aligned-candidate-v1";

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
  if (
    !/^index_v3_physical_leaf_candidate(?:[-_][a-z0-9][a-z0-9_-]*)?$/.test(path.basename(resolved.outputRoot)) ||
    resolved.outputRoot === resolved.alignedRoot ||
    resolved.outputRoot === path.parse(resolved.outputRoot).root
  ) throw new Error("--output-root must be a dedicated index_v3_physical_leaf_candidate directory");
  return resolved;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sourceIdentity(entry) {
  return { key: entry.key, byte_size: entry.byte_size, sha256: entry.sha256 };
}

function readPlanObject(root, entry, label) {
  const bytes = fs.readFileSync(path.join(root, entry.local_path));
  if (bytes.byteLength !== entry.byte_size || sha256(bytes) !== entry.sha256) {
    throw new Error(`${label} identity mismatch: ${entry.key}`);
  }
  return { bytes, payload: JSON.parse(bytes) };
}

function scopeSuffix(sourceKey) {
  if (!sourceKey.startsWith(`${SOURCE_INDEX_ROOT}/`)) {
    throw new Error(`unexpected aligned index key: ${sourceKey}`);
  }
  return sourceKey.slice(SOURCE_INDEX_ROOT.length + 1);
}

function leafKey(sourceManifestKey, timeseriesId) {
  const suffix = scopeSuffix(sourceManifestKey);
  if (!suffix.endsWith("/manifest.json")) throw new Error(`unexpected scoped manifest key: ${sourceManifestKey}`);
  return `${CANDIDATE_INDEX_ROOT}/${suffix.slice(0, -"/manifest.json".length)}/timeseries_id=${String(timeseriesId).padStart(9, "0")}.json`;
}

function candidateManifestKey(sourceManifestKey) {
  return `${CANDIDATE_INDEX_ROOT}/${scopeSuffix(sourceManifestKey)}`;
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

function commonIdentity(payload, source, key) {
  return {
    schema_version: 1,
    physical_leaf_candidate_version: CANDIDATE_VERSION,
    index_generation: INDEX_GENERATION,
    history_version: "v2",
    domain: "observations",
    history_schema_version: 3,
    writer_version: EXPECTED_WRITER,
    physical_layout_version: EXPECTED_LAYOUT,
    aligned_row_cap: ALIGNED_CAP,
    key,
    day_utc: source.day_utc,
    connector_id: source.connector_id,
    pollutant_code: source.pollutant_code,
  };
}

function buildLeaf({ sourceManifestEntry, source, sourceChildEntry, physicalChild, timeseries }) {
  const key = leafKey(sourceManifestEntry.key, timeseries.timeseries_id);
  const usedFileKeys = new Set(timeseries.segments.map((segment) => segment.file_key));
  const files = physicalChild.files.filter((file) => usedFileKeys.has(file.key));
  if (files.length !== usedFileKeys.size || files.some((file) => !file.key.startsWith(`${SOURCE_DATA_ROOT}/`))) {
    throw new Error(`timeseries ${timeseries.timeseries_id} does not resolve to exact cap=1024 files`);
  }
  return {
    ...commonIdentity(physicalChild, source, key),
    kind: "observation_timeseries_physical_leaf",
    timeseries_id: timeseries.timeseries_id,
    row_count: timeseries.row_count,
    min_observed_at_utc: timeseries.min_observed_at_utc,
    max_observed_at_utc: timeseries.max_observed_at_utc,
    source_aligned_child: sourceIdentity(sourceChildEntry),
    files,
    segments: timeseries.segments,
  };
}

function leafDescriptor(leaf, object) {
  return [leaf.timeseries_id, object.key, object.byte_size, object.sha256];
}

async function main() {
  const options = parse(process.argv.slice(2));
  const alignedPlan = JSON.parse(fs.readFileSync(path.join(options.alignedRoot, "publication-plan.json")));
  if (
    alignedPlan.environment !== "TEST" ||
    alignedPlan.prototype_prefix !== BASE_PREFIX
  ) throw new Error("aligned source is not the expected TEST cap=1024 prototype fixture");
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

  const physicalChildren = new Map();
  for (const entry of sourceChildren) {
    physicalChildren.set(entry.key, await buildPhysicalCandidateChild({
      alignedRoot: options.alignedRoot,
      alignedPlanByKey,
      sourceEntry: entry,
    }));
  }

  const objects = [];
  let leafCount = 0;
  for (const sourceManifestEntry of sourceManifests) {
    const { payload: source } = readPlanObject(options.alignedRoot, sourceManifestEntry, "aligned scoped manifest");
    const seenTimeseries = new Set();
    const leaves = [];
    let profile = null;
    for (const childDescriptor of source.children) {
      const sourceChildEntry = alignedPlanByKey.get(childDescriptor.key);
      const physicalChild = physicalChildren.get(childDescriptor.key);
      if (!sourceChildEntry || !physicalChild) throw new Error(`missing inspected aligned child: ${childDescriptor.key}`);
      if (profile && JSON.stringify(profile) !== JSON.stringify(physicalChild.decode_profile)) {
        throw new Error(`decoder profile differs within scope: ${sourceManifestEntry.key}`);
      }
      profile = physicalChild.decode_profile;
      for (const timeseries of physicalChild.timeseries) {
        if (seenTimeseries.has(timeseries.timeseries_id)) {
          throw new Error(`duplicate timeseries in scope: ${timeseries.timeseries_id}`);
        }
        seenTimeseries.add(timeseries.timeseries_id);
        const leaf = buildLeaf({
          sourceManifestEntry,
          source,
          sourceChildEntry,
          physicalChild,
          timeseries,
        });
        const object = writeObject(options.outputRoot, leaf.key, leaf);
        objects.push(object);
        leaves.push(leafDescriptor(leaf, object));
        leafCount += 1;
      }
    }
    leaves.sort((left, right) => left[0] - right[0]);
    const key = candidateManifestKey(sourceManifestEntry.key);
    const manifest = {
      ...commonIdentity(source, source, key),
      kind: "observation_timeseries_physical_leaf_scoped_manifest",
      source_aligned_scoped_manifest: sourceIdentity(sourceManifestEntry),
      decode_profile: profile,
      coverage: {
        row_count: source.coverage.row_count,
        timeseries_count: leaves.length,
        min_observed_at_utc: source.coverage.min_observed_at_utc,
        max_observed_at_utc: source.coverage.max_observed_at_utc,
      },
      leaf_descriptor_fields: ["key", "byte_size", "sha256"],
      leaves_by_timeseries_id: Object.fromEntries(
        leaves.map(([timeseriesId, ...descriptor]) => [String(timeseriesId), descriptor]),
      ),
    };
    objects.push(writeObject(options.outputRoot, key, manifest));
  }

  objects.sort((left, right) => left.key.localeCompare(right.key));
  const plan = {
    schema_version: 1,
    environment: "TEST",
    prototype_prefix: CANDIDATE_PREFIX,
    index_root: CANDIDATE_INDEX_ROOT,
    physical_leaf_candidate_version: CANDIDATE_VERSION,
    aligned_row_cap: ALIGNED_CAP,
    reuses_aligned_parquet: true,
    parquet_objects: [],
    objects,
  };
  fs.writeFileSync(path.join(options.outputRoot, "publication-plan.json"), canonicalBytes(plan), { flag: "wx" });
  const report = {
    ok: true,
    environment: "TEST",
    prototype_prefix: CANDIDATE_PREFIX,
    source_index_root: SOURCE_INDEX_ROOT,
    candidate_index_root: CANDIDATE_INDEX_ROOT,
    aligned_row_cap: ALIGNED_CAP,
    scoped_manifest_count: sourceManifests.length,
    leaf_count: leafCount,
    json_object_count: objects.length,
    total_index_bytes: objects.reduce((sum, object) => sum + object.byte_size, 0),
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
