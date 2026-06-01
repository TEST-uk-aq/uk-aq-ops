#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import {
  bboxesOverlap,
  detectPropertyKeyFromFeatures,
  formatGridToken,
  normalizeFeatureRecord,
  normalizePrefix,
  parseGridSize,
  tilesForGeometry,
  tilesForBbox,
} from "./lib/geo_boundary_shard_utils.mjs";

const DEFAULTS = {
  pcon_geojson: String(
    process.env.UK_AQ_GEO_PCON_GEOJSON_PATH
      || process.env.UK_AQ_GEO_PCON_GEOJSON
      || "",
  ).trim(),
  la_geojson: String(
    process.env.UK_AQ_GEO_LA_GEOJSON_PATH
      || process.env.UK_AQ_GEO_LA_GEOJSON
      || "",
  ).trim(),
  output_dir: String(
    process.env.UK_AQ_GEO_SHARD_OUTPUT_DIR
      || path.join(os.homedir(), "tmp", "geo_lookup_v1"),
  ).trim(),
  prefix: normalizePrefix(process.env.UK_AQ_GEO_R2_PREFIX || "v1"),
  grid_size_degrees: parseGridSize(process.env.UK_AQ_GEO_GRID_SIZE_DEGREES || "0.05", 0.05),
  boundary_detail: String(process.env.UK_AQ_GEO_BOUNDARY_DETAIL || "detailed").trim() || "detailed",
  pcon_version: String(process.env.UK_AQ_GEO_PCON_VERSION || "2024").trim() || "2024",
  la_version: String(process.env.UK_AQ_GEO_LA_VERSION || "latest-configured").trim() || "latest-configured",
  pcon_source: String(process.env.UK_AQ_GEO_PCON_SOURCE || "").trim(),
  la_source: String(process.env.UK_AQ_GEO_LA_SOURCE || "").trim(),
};

const PCON_CODE_CANDIDATES = [
  "PCON24CD",
  "PCON25CD",
  "PCON23CD",
  "pcon24cd",
  "pcon25cd",
  "pcon23cd",
  "pcon_code",
  "code",
];

const PCON_NAME_CANDIDATES = [
  "PCON24NM",
  "PCON25NM",
  "PCON23NM",
  "pcon24nm",
  "pcon25nm",
  "pcon23nm",
  "pcon_name",
  "name",
];

const LA_CODE_CANDIDATES = [
  "LAD25CD",
  "LAD24CD",
  "LAD23CD",
  "lad25cd",
  "lad24cd",
  "lad23cd",
  "la_code",
  "code",
];

const LA_NAME_CANDIDATES = [
  "LAD25NM",
  "LAD24NM",
  "LAD23NM",
  "lad25nm",
  "lad24nm",
  "lad23nm",
  "la_name",
  "name",
];

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/geography/build_pcon_la_lookup_shards.mjs --pcon-geojson <path> --la-geojson <path> [options]",
      "",
      "Required:",
      "  --pcon-geojson <path>",
      "  --la-geojson <path>",
      "",
      "Options:",
      "  --output-dir <path>           Output directory (default: ~/tmp/geo_lookup_v1)",
      "  --prefix <value>              R2 object key prefix in manifest (default: v1)",
      "  --grid-size <number>          Grid size in degrees (default: 0.05)",
      "  --boundary-detail <value>     Boundary detail label (default: detailed)",
      "  --pcon-version <value>        PCON boundary version (default: 2024)",
      "  --la-version <value>          LA boundary version (default: latest-configured)",
      "  --pcon-source <value>         Optional source label",
      "  --la-source <value>           Optional source label",
      "  --skip-adjacency              Skip adjacency generation",
      "  -h, --help",
      "",
      "Env alternatives:",
      "  UK_AQ_GEO_PCON_GEOJSON_PATH / UK_AQ_GEO_PCON_GEOJSON",
      "  UK_AQ_GEO_LA_GEOJSON_PATH / UK_AQ_GEO_LA_GEOJSON",
      "  UK_AQ_GEO_SHARD_OUTPUT_DIR",
      "  UK_AQ_GEO_R2_PREFIX",
      "  UK_AQ_GEO_GRID_SIZE_DEGREES",
      "  UK_AQ_GEO_BOUNDARY_DETAIL",
      "  UK_AQ_GEO_PCON_VERSION",
      "  UK_AQ_GEO_LA_VERSION",
      "  UK_AQ_GEO_PCON_SOURCE",
      "  UK_AQ_GEO_LA_SOURCE",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    ...DEFAULTS,
    skip_adjacency: false,
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--pcon-geojson") {
      args.pcon_geojson = String(argv[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg === "--la-geojson") {
      args.la_geojson = String(argv[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg === "--output-dir") {
      args.output_dir = String(argv[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg === "--prefix") {
      args.prefix = normalizePrefix(argv[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === "--grid-size") {
      args.grid_size_degrees = parseGridSize(argv[idx + 1], args.grid_size_degrees);
      idx += 1;
      continue;
    }
    if (arg === "--boundary-detail") {
      args.boundary_detail = String(argv[idx + 1] || "").trim() || args.boundary_detail;
      idx += 1;
      continue;
    }
    if (arg === "--pcon-version") {
      args.pcon_version = String(argv[idx + 1] || "").trim() || args.pcon_version;
      idx += 1;
      continue;
    }
    if (arg === "--la-version") {
      args.la_version = String(argv[idx + 1] || "").trim() || args.la_version;
      idx += 1;
      continue;
    }
    if (arg === "--pcon-source") {
      args.pcon_source = String(argv[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg === "--la-source") {
      args.la_source = String(argv[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg === "--skip-adjacency") {
      args.skip_adjacency = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.pcon_geojson) {
    throw new Error("Missing PCON GeoJSON path (--pcon-geojson or UK_AQ_GEO_PCON_GEOJSON_PATH).");
  }
  if (!args.la_geojson) {
    throw new Error("Missing LA GeoJSON path (--la-geojson or UK_AQ_GEO_LA_GEOJSON_PATH).");
  }
  if (!args.output_dir) {
    throw new Error("Missing output directory (--output-dir or UK_AQ_GEO_SHARD_OUTPUT_DIR).");
  }
  if (!args.prefix) {
    throw new Error("R2 prefix cannot be empty (--prefix or UK_AQ_GEO_R2_PREFIX).");
  }

  return args;
}

function toObjectPath(prefix, relativePath) {
  return `${normalizePrefix(prefix)}/${relativePath.replace(/\\/g, "/")}`;
}

function computeBboxFromGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return null;
  }
  const type = String(geometry.type || "");
  if (type !== "Polygon" && type !== "MultiPolygon") {
    return null;
  }

  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  const walkCoordinates = (value) => {
    if (!Array.isArray(value)) {
      return;
    }
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      const lon = Number(value[0]);
      const lat = Number(value[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return;
      }
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
      return;
    }
    for (const child of value) {
      walkCoordinates(child);
    }
  };

  walkCoordinates(geometry.coordinates);

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return null;
  }

  return [
    Number(minLon.toFixed(6)),
    Number(minLat.toFixed(6)),
    Number(maxLon.toFixed(6)),
    Number(maxLat.toFixed(6)),
  ];
}

function normalizeBbox(rawBbox, geometry) {
  if (Array.isArray(rawBbox) && rawBbox.length === 4) {
    const values = rawBbox.map((value) => Number(value));
    if (
      values.every((value) => Number.isFinite(value))
      && values[2] >= values[0]
      && values[3] >= values[1]
    ) {
      return values.map((value) => Number(value.toFixed(6)));
    }
  }
  return computeBboxFromGeometry(geometry);
}

function valueOrFallback(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

async function sha256FileHex(filePath) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function loadGeoJsonFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const rawBuffer = await fs.promises.readFile(absolutePath);
  const rawText = rawBuffer.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Expected JSON object in ${absolutePath}.`);
  }
  if (parsed.type !== "FeatureCollection") {
    throw new Error(`Expected FeatureCollection in ${absolutePath}.`);
  }
  if (!Array.isArray(parsed.features)) {
    throw new Error(`FeatureCollection in ${absolutePath} is missing features array.`);
  }

  return {
    absolutePath,
    fileName: path.basename(absolutePath),
    fileBytes: rawBuffer.byteLength,
    featureCollection: parsed,
  };
}

function bboxCoverageFromFeatures(features) {
  if (!Array.isArray(features) || features.length === 0) {
    return null;
  }
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const feature of features) {
    const bbox = feature?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      continue;
    }
    const [leftMinLon, leftMinLat, leftMaxLon, leftMaxLat] = bbox.map((value) => Number(value));
    if (!Number.isFinite(leftMinLon) || !Number.isFinite(leftMinLat) || !Number.isFinite(leftMaxLon) || !Number.isFinite(leftMaxLat)) {
      continue;
    }
    minLon = Math.min(minLon, leftMinLon);
    minLat = Math.min(minLat, leftMinLat);
    maxLon = Math.max(maxLon, leftMaxLon);
    maxLat = Math.max(maxLat, leftMaxLat);
  }

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return null;
  }

  return {
    min_lon: Number(minLon.toFixed(6)),
    min_lat: Number(minLat.toFixed(6)),
    max_lon: Number(maxLon.toFixed(6)),
    max_lat: Number(maxLat.toFixed(6)),
  };
}

function mergeCoverageBboxes(values) {
  const normalized = values.filter((value) => value && typeof value === "object");
  if (normalized.length === 0) {
    return null;
  }
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const value of normalized) {
    minLon = Math.min(minLon, Number(value.min_lon));
    minLat = Math.min(minLat, Number(value.min_lat));
    maxLon = Math.max(maxLon, Number(value.max_lon));
    maxLat = Math.max(maxLat, Number(value.max_lat));
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return null;
  }
  return {
    min_lon: Number(minLon.toFixed(6)),
    min_lat: Number(minLat.toFixed(6)),
    max_lon: Number(maxLon.toFixed(6)),
    max_lat: Number(maxLat.toFixed(6)),
  };
}

function buildLayerConfig(args) {
  return [
    {
      layer: "pcon",
      input_path: args.pcon_geojson,
      boundary_version: args.pcon_version,
      source: valueOrFallback(args.pcon_source, path.basename(args.pcon_geojson)),
      code_candidates: PCON_CODE_CANDIDATES,
      name_candidates: PCON_NAME_CANDIDATES,
    },
    {
      layer: "la",
      input_path: args.la_geojson,
      boundary_version: args.la_version,
      source: valueOrFallback(args.la_source, path.basename(args.la_geojson)),
      code_candidates: LA_CODE_CANDIDATES,
      name_candidates: LA_NAME_CANDIDATES,
    },
  ];
}

function buildAdjacency(features) {
  const neighbours = new Map();
  for (const feature of features) {
    neighbours.set(feature.code, new Set());
  }

  for (let idx = 0; idx < features.length; idx += 1) {
    const left = features[idx];
    for (let inner = idx + 1; inner < features.length; inner += 1) {
      const right = features[inner];
      if (!bboxesOverlap(left.bbox, right.bbox)) {
        continue;
      }
      neighbours.get(left.code).add(right.code);
      neighbours.get(right.code).add(left.code);
    }
  }

  const outputFeatures = {};
  for (const feature of features) {
    outputFeatures[feature.code] = {
      name: feature.name,
      neighbours: Array.from(neighbours.get(feature.code) || []).sort((a, b) => a.localeCompare(b)),
    };
  }
  return outputFeatures;
}

async function writeJsonFile(filePath, payload, { minified = false } = {}) {
  const jsonText = minified
    ? `${JSON.stringify(payload)}\n`
    : `${JSON.stringify(payload, null, 2)}\n`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, jsonText, "utf8");
  return Buffer.byteLength(jsonText, "utf8");
}

function sortedObjectByKey(input) {
  return Object.fromEntries(
    Object.entries(input).sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function ensureFeatureShape(feature, codeKey, nameKey, layer) {
  const properties = feature && typeof feature === "object" && feature.properties && typeof feature.properties === "object"
    ? feature.properties
    : null;
  const geometry = feature && typeof feature === "object" ? feature.geometry : null;
  if (!properties || !geometry) {
    return null;
  }

  const geometryType = String(geometry.type || "");
  if (geometryType !== "Polygon" && geometryType !== "MultiPolygon") {
    return null;
  }

  const code = String(properties[codeKey] ?? "").trim();
  if (!code) {
    return null;
  }

  const name = String(properties[nameKey] ?? "").trim() || code;
  const bbox = normalizeBbox(feature.bbox, geometry);
  if (!bbox) {
    return null;
  }

  return normalizeFeatureRecord({
    code,
    name,
    bbox,
    geometry,
    layer,
  });
}

async function buildLayerArtifacts({
  layer,
  loaded,
  boundaryVersion,
  boundaryDetail,
  gridSize,
  gridToken,
  outputDir,
  prefix,
  source,
  sourceFileSha256,
  sourceFileBytes,
  codeCandidates,
  nameCandidates,
  skipAdjacency,
}) {
  const features = loaded.featureCollection.features;
  const codeKey = detectPropertyKeyFromFeatures(features, codeCandidates, `${layer} code`);
  const nameKey = detectPropertyKeyFromFeatures(features, nameCandidates, `${layer} name`);

  const validFeatures = [];
  let skippedInvalid = 0;
  let skippedUnsupportedGeometry = 0;

  const tileMap = new Map();

  for (const feature of features) {
    const prepared = ensureFeatureShape(feature, codeKey, nameKey, layer);
    if (!prepared) {
      const geometryType = String(feature?.geometry?.type || "");
      if (geometryType && geometryType !== "Polygon" && geometryType !== "MultiPolygon") {
        skippedUnsupportedGeometry += 1;
      } else {
        skippedInvalid += 1;
      }
      continue;
    }

    validFeatures.push(prepared);
    const tiles = tilesForGeometry(prepared.geometry, gridSize);
    const effectiveTiles = tiles.length > 0 ? tiles : tilesForBbox(prepared.bbox, gridSize);
    for (const tile of effectiveTiles) {
      if (!tileMap.has(tile.key)) {
        tileMap.set(tile.key, {
          tile,
          features: [],
        });
      }
      tileMap.get(tile.key).features.push(prepared);
    }
  }

  const objectEntries = [];
  const sortedTiles = Array.from(tileMap.values()).sort((left, right) => {
    if (left.tile.iy !== right.tile.iy) {
      return left.tile.iy - right.tile.iy;
    }
    return left.tile.ix - right.tile.ix;
  });

  for (const bucket of sortedTiles) {
    const tileKey = bucket.tile.key;
    const layerPath = path.join(layer, boundaryDetail, `grid_${gridToken}`);
    const relativePath = path.join(layerPath, `${tileKey}.json`).replace(/\\/g, "/");
    const outputPath = path.join(outputDir, relativePath);

    const shardPayload = {
      schema_version: 1,
      layer,
      boundary_version: boundaryVersion,
      boundary_detail: boundaryDetail,
      grid_size_degrees: gridSize,
      tile: {
        ix: bucket.tile.ix,
        iy: bucket.tile.iy,
        key: bucket.tile.key,
        lat_min: bucket.tile.lat_min,
        lat_max: bucket.tile.lat_max,
        lon_min: bucket.tile.lon_min,
        lon_max: bucket.tile.lon_max,
      },
      features: bucket.features
        .slice()
        .sort((left, right) => left.code.localeCompare(right.code))
        .map((feature) => ({
          code: feature.code,
          name: feature.name,
          bbox: feature.bbox,
          geometry: feature.geometry,
        })),
    };

    const bytes = await writeJsonFile(outputPath, shardPayload, { minified: true });
    objectEntries.push({
      layer,
      kind: "grid_shard",
      tile_key: tileKey,
      relative_path: relativePath,
      object_key: toObjectPath(prefix, relativePath),
      bytes,
      feature_count: shardPayload.features.length,
    });
  }

  if (!skipAdjacency) {
    const adjacency = {
      schema_version: 1,
      layer,
      boundary_version: boundaryVersion,
      method: "bbox_overlap_approx",
      features: sortedObjectByKey(buildAdjacency(validFeatures)),
    };
    const relativePath = path.join("adjacency", `${layer}_${boundaryVersion}.json`).replace(/\\/g, "/");
    const outputPath = path.join(outputDir, relativePath);
    const bytes = await writeJsonFile(outputPath, adjacency, { minified: true });

    objectEntries.push({
      layer,
      kind: "adjacency",
      relative_path: relativePath,
      object_key: toObjectPath(prefix, relativePath),
      bytes,
      feature_count: Object.keys(adjacency.features).length,
      method: adjacency.method,
    });
  }

  return {
    layer,
    source,
    input_path: loaded.absolutePath,
    source_file_name: loaded.fileName,
    source_file_bytes: sourceFileBytes,
    source_file_sha256: sourceFileSha256,
    code_property: codeKey,
    name_property: nameKey,
    boundary_version: boundaryVersion,
    feature_count: validFeatures.length,
    raw_feature_count: features.length,
    shard_count: sortedTiles.length,
    skipped_invalid_count: skippedInvalid,
    skipped_unsupported_geometry_count: skippedUnsupportedGeometry,
    bbox_coverage: bboxCoverageFromFeatures(validFeatures),
    object_entries: objectEntries,
    adjacency_enabled: !skipAdjacency,
    adjacency_method: skipAdjacency ? null : "bbox_overlap_approx",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args.output_dir);
  const gridToken = formatGridToken(args.grid_size_degrees);
  const generatedAt = new Date().toISOString();

  const layerConfigs = buildLayerConfig(args);
  const loadedFiles = await Promise.all(
    layerConfigs.map(async (layerConfig) => ({
      ...layerConfig,
      source_file_sha256: await sha256FileHex(path.resolve(layerConfig.input_path)),
      loaded: await loadGeoJsonFile(layerConfig.input_path),
    })),
  );

  const layerResults = [];
  for (const layerConfig of loadedFiles) {
    const result = await buildLayerArtifacts({
      layer: layerConfig.layer,
      loaded: layerConfig.loaded,
      boundaryVersion: layerConfig.boundary_version,
      boundaryDetail: args.boundary_detail,
      gridSize: args.grid_size_degrees,
      gridToken,
      outputDir,
      prefix: args.prefix,
      source: layerConfig.source,
      sourceFileSha256: layerConfig.source_file_sha256,
      sourceFileBytes: layerConfig.loaded.fileBytes,
      codeCandidates: layerConfig.code_candidates,
      nameCandidates: layerConfig.name_candidates,
      skipAdjacency: args.skip_adjacency,
    });
    layerResults.push(result);
  }

  const objectEntries = [];
  const layersManifest = {};
  let totalBytes = 0;
  let totalFeatureCount = 0;
  let totalShardCount = 0;

  for (const result of layerResults) {
    layersManifest[result.layer] = {
      boundary_version: result.boundary_version,
      source: result.source,
      input_path: result.input_path,
      source_file_name: result.source_file_name,
      source_file_bytes: result.source_file_bytes,
      source_file_sha256: result.source_file_sha256,
      code_property: result.code_property,
      name_property: result.name_property,
      raw_feature_count: result.raw_feature_count,
      feature_count: result.feature_count,
      shard_count: result.shard_count,
      skipped_invalid_count: result.skipped_invalid_count,
      skipped_unsupported_geometry_count: result.skipped_unsupported_geometry_count,
      bbox_coverage: result.bbox_coverage,
      adjacency_enabled: result.adjacency_enabled,
      adjacency_method: result.adjacency_method,
    };

    totalFeatureCount += result.feature_count;
    totalShardCount += result.shard_count;

    for (const entry of result.object_entries) {
      totalBytes += Number(entry.bytes || 0);
      objectEntries.push(entry);
    }
  }

  objectEntries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));

  const manifest = {
    schema_version: 1,
    generated_at_utc: generatedAt,
    source: "DROPBOX_GEOJSON",
    prefix: args.prefix,
    boundary_detail: args.boundary_detail,
    grid_size_degrees: args.grid_size_degrees,
    grid_token: gridToken,
    bbox_coverage: mergeCoverageBboxes(layerResults.map((result) => result.bbox_coverage)),
    layers: layersManifest,
    shard_count: totalShardCount,
    feature_count: totalFeatureCount,
    object_count: objectEntries.length + 1,
    objects: objectEntries,
  };

  const manifestRelativePath = "manifest.json";
  const manifestPath = path.join(outputDir, manifestRelativePath);
  const manifestBytes = await writeJsonFile(manifestPath, manifest);

  console.log(
    JSON.stringify(
      {
        ok: true,
        output_dir: outputDir,
        prefix: args.prefix,
        boundary_detail: args.boundary_detail,
        grid_size_degrees: args.grid_size_degrees,
        shard_count: totalShardCount,
        feature_count: totalFeatureCount,
        object_count: objectEntries.length + 1,
        generated_at_utc: generatedAt,
        bytes_written: totalBytes + manifestBytes,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`build_pcon_la_lookup_shards failed: ${message}`);
  process.exit(1);
});
