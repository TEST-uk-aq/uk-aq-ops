#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import proj4 from "proj4";

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

const EPSG_4326 = "EPSG:4326";
const EPSG_27700 = "EPSG:27700";

proj4.defs(
  EPSG_27700,
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 "
    + "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 "
    + "+units=m +no_defs +type=crs",
);

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
      "  --layer <pcon|la|all>         Build a single layer or all layers (default: all)",
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
    layer: "all",
    child_layer_build: false,
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
    if (arg === "--layer") {
      args.layer = String(argv[idx + 1] || "").trim().toLowerCase() || "all";
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
    if (arg === "--child-layer-build") {
      args.child_layer_build = true;
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
  if (!["all", "pcon", "la"].includes(args.layer)) {
    throw new Error(`Invalid --layer value: ${args.layer}. Expected all, pcon, or la.`);
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

function normalizePathComponent(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "_");
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

async function inspectGeoJsonFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const stats = await fs.promises.stat(absolutePath);

  return {
    absolutePath,
    fileName: path.basename(absolutePath),
    fileBytes: stats.size,
    crsHint: await readGeoJsonCrsHint(absolutePath),
  };
}

async function readGeoJsonCrsHint(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  const buffer = Buffer.alloc(128 * 1024);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.toString("utf8", 0, bytesRead);
    const match = head.match(/"crs"\s*:\s*\{[\s\S]{0,4096}?"name"\s*:\s*"([^"]+)"/u);
    if (!match) {
      return "";
    }
    return String(match[1] || "").trim();
  } finally {
    await handle.close();
  }
}

async function* iterateGeoJsonFeaturesFallback(filePath) {
  const absolutePath = path.resolve(filePath);
  const stream = fs.createReadStream(absolutePath, {
    encoding: "utf8",
    highWaterMark: 1024 * 1024,
  });

  let state = "seekFeaturesKey";
  let pending = "";
  let featureText = "";
  let braceDepth = 0;
  let inString = false;
  let escapeNext = false;
  let featuresKeyFound = false;
  let featuresArrayFound = false;

  const consumeFeatureChars = async function* () {
    let index = 0;
    while (index < pending.length) {
      const char = pending[index];
      featureText += char;
      if (escapeNext) {
        escapeNext = false;
      } else if (char === "\\") {
        escapeNext = true;
      } else if (char === "\"") {
        inString = !inString;
      } else if (!inString) {
        if (char === "{") {
          braceDepth += 1;
        } else if (char === "}") {
          braceDepth -= 1;
          if (braceDepth === 0) {
            const rawFeature = featureText;
            featureText = "";
            pending = pending.slice(index + 1);
            state = "seekFeatureOrEnd";
            let parsed;
            try {
              parsed = JSON.parse(rawFeature);
            } catch (error) {
              throw new Error(
                `Failed to parse feature JSON in ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            if (!parsed || typeof parsed !== "object") {
              throw new Error(`Parsed feature in ${absolutePath} is not an object.`);
            }
            yield parsed;
            return;
          }
        }
      }
      index += 1;
    }
    pending = "";
  };

  for await (const chunk of stream) {
    pending += chunk;
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;

      if (state === "seekFeaturesKey") {
        const markerIndex = pending.indexOf("\"features\"");
        if (markerIndex >= 0) {
          pending = pending.slice(markerIndex + "\"features\"".length);
          featuresKeyFound = true;
          state = "seekFeaturesArrayStart";
          madeProgress = true;
          continue;
        }
        if (pending.length > 32) {
          pending = pending.slice(-32);
        }
        continue;
      }

      if (state === "seekFeaturesArrayStart") {
        const bracketIndex = pending.indexOf("[");
        if (bracketIndex >= 0) {
          pending = pending.slice(bracketIndex + 1);
          featuresArrayFound = true;
          state = "seekFeatureOrEnd";
          madeProgress = true;
          continue;
        }
        if (pending.length > 256) {
          pending = pending.slice(-256);
        }
        continue;
      }

      if (state === "seekFeatureOrEnd") {
        let index = 0;
        while (index < pending.length) {
          const char = pending[index];
          if (char === "]") {
            state = "done";
            pending = pending.slice(index + 1);
            madeProgress = true;
            break;
          }
          if (char === "{") {
            featureText = "{";
            braceDepth = 1;
            inString = false;
            escapeNext = false;
            pending = pending.slice(index + 1);
            state = "captureFeature";
            madeProgress = true;
            break;
          }
          if (char === "," || /\s/u.test(char)) {
            index += 1;
            continue;
          }
          throw new Error(`Unexpected token before feature object in ${absolutePath}: ${char}`);
        }
        if (!madeProgress) {
          pending = "";
        }
        continue;
      }

      if (state === "captureFeature") {
        for await (const parsedFeature of consumeFeatureChars()) {
          madeProgress = true;
          yield parsedFeature;
        }
        continue;
      }
    }
  }

  if (!featuresKeyFound) {
    throw new Error(`FeatureCollection in ${absolutePath} is missing features key.`);
  }
  if (!featuresArrayFound) {
    throw new Error(`FeatureCollection in ${absolutePath} is missing features array.`);
  }
  if (state === "captureFeature") {
    throw new Error(`Unexpected end of file while parsing feature JSON in ${absolutePath}.`);
  }
  if (state !== "done" && state !== "seekFeatureOrEnd") {
    throw new Error(`Unexpected end of GeoJSON stream in ${absolutePath}.`);
  }
}

async function* iterateGeoJsonFeaturesViaJq(filePath) {
  const absolutePath = path.resolve(filePath);
  const child = spawn("jq", ["-c", ".features[]", absolutePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    if (stderrBuffer.length > 8192) {
      stderrBuffer = stderrBuffer.slice(-8192);
    }
  });

  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `Failed to parse jq feature JSON in ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        yield parsed;
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  }

  if (stdoutBuffer.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(stdoutBuffer.trim());
    } catch (error) {
      throw new Error(
        `Failed to parse trailing jq feature JSON in ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    yield parsed;
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`jq failed for ${absolutePath} with exit code ${exitCode}: ${stderrBuffer.trim()}`);
  }
}

async function* iterateGeoJsonFeatures(filePath) {
  try {
    yield* iterateGeoJsonFeaturesViaJq(filePath);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT")) {
      throw error;
    }
  }
  yield* iterateGeoJsonFeaturesFallback(filePath);
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

function maybeRunGc() {
  const gcFn = globalThis.gc;
  if (typeof gcFn === "function") {
    gcFn();
  }
}

function buildLayerConfig(args) {
  const configs = [
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
  if (args.layer === "all") {
    return configs;
  }
  return configs.filter((config) => config.layer === args.layer);
}

function normalizeSourceCrs(rawValue) {
  const normalized = String(rawValue || "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  if (
    normalized === EPSG_4326
    || normalized.endsWith(":4326")
    || normalized.endsWith("::4326")
    || normalized.includes("CRS84")
  ) {
    return EPSG_4326;
  }
  if (
    normalized === EPSG_27700
    || normalized.endsWith(":27700")
    || normalized.endsWith("::27700")
  ) {
    return EPSG_27700;
  }
  return normalized;
}

function extractFirstCoordinatePair(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return [Number(value[0]), Number(value[1])];
  }
  for (const child of value) {
    const candidate = extractFirstCoordinatePair(child);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function looksLikeWgs84(pair) {
  if (!Array.isArray(pair) || pair.length < 2) {
    return false;
  }
  const lon = Number(pair[0]);
  const lat = Number(pair[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}

function looksLikeBritishNationalGrid(pair) {
  if (!Array.isArray(pair) || pair.length < 2) {
    return false;
  }
  const easting = Number(pair[0]);
  const northing = Number(pair[1]);
  return (
    Number.isFinite(easting)
    && Number.isFinite(northing)
    && easting >= 0
    && easting <= 800000
    && northing >= 0
    && northing <= 1400000
  );
}

function inferSourceCrs({ loaded, feature, layer }) {
  const fromHint = normalizeSourceCrs(loaded?.crsHint);
  if (fromHint === EPSG_4326 || fromHint === EPSG_27700) {
    return fromHint;
  }

  const point = extractFirstCoordinatePair(feature?.geometry?.coordinates);
  if (looksLikeWgs84(point)) {
    return EPSG_4326;
  }
  if (looksLikeBritishNationalGrid(point)) {
    return EPSG_27700;
  }

  throw new Error(
    `Unable to determine CRS for ${layer} boundary input ${loaded?.absolutePath || "<unknown>"}. `
      + `Supported inputs are ${EPSG_4326} and ${EPSG_27700}.`,
  );
}

function buildCoordinateTransformer(sourceCrs) {
  const normalized = normalizeSourceCrs(sourceCrs);
  if (!normalized || normalized === EPSG_4326) {
    return null;
  }
  if (normalized === EPSG_27700) {
    return (point) => {
      const [lon, lat] = proj4(EPSG_27700, EPSG_4326, point);
      return [Number(lon), Number(lat)];
    };
  }
  throw new Error(`Unsupported CRS for boundary reprojection: ${sourceCrs}`);
}

function transformCoordinateValue(value, transformPoint) {
  if (!Array.isArray(value)) {
    return value;
  }
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    const [lon, lat] = transformPoint([Number(value[0]), Number(value[1])]);
    return [lon, lat];
  }
  return value.map((child) => transformCoordinateValue(child, transformPoint));
}

function normalizeGeometryToWgs84(geometry, sourceCrs) {
  if (!geometry || typeof geometry !== "object") {
    return geometry;
  }
  const normalized = normalizeSourceCrs(sourceCrs);
  if (!normalized || normalized === EPSG_4326) {
    return geometry;
  }
  const transformPoint = buildCoordinateTransformer(normalized);
  return {
    ...geometry,
    coordinates: transformCoordinateValue(geometry.coordinates, transformPoint),
  };
}

function layerMetadataDir(outputDir) {
  return path.join(outputDir, ".layer_manifests");
}

function layerMetadataPath(outputDir, layer) {
  return path.join(layerMetadataDir(outputDir), `${layer}.json`);
}

async function writeLayerMetadata(outputDir, result) {
  await fs.promises.mkdir(layerMetadataDir(outputDir), { recursive: true });
  await fs.promises.writeFile(layerMetadataPath(outputDir, result.layer), `${JSON.stringify(result)}\n`, "utf8");
}

async function readLayerMetadata(outputDir, layer) {
  const metadataPath = layerMetadataPath(outputDir, layer);
  let raw;
  try {
    raw = await fs.promises.readFile(metadataPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        `Layer metadata missing after ${layer} child build: ${metadataPath}. `
          + "This usually means the child process did not run the current builder code "
          + "or failed before writing its handoff file.",
      );
    }
    throw error;
  }
  return JSON.parse(raw);
}

function buildChildArgs(args, layer) {
  return [
    ...process.execArgv,
    process.argv[1],
    "--child-layer-build",
    "--layer", layer,
    "--pcon-geojson", args.pcon_geojson,
    "--la-geojson", args.la_geojson,
    "--output-dir", args.output_dir,
    "--prefix", args.prefix,
    "--grid-size", String(args.grid_size_degrees),
    "--boundary-detail", args.boundary_detail,
    "--pcon-version", args.pcon_version,
    "--la-version", args.la_version,
    ...(args.pcon_source ? ["--pcon-source", args.pcon_source] : []),
    ...(args.la_source ? ["--la-source", args.la_source] : []),
    ...(args.skip_adjacency ? ["--skip-adjacency"] : []),
  ];
}

async function runChildLayerBuild(args, layer) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, buildChildArgs(args, layer), {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Layer build failed for ${layer} with exit code ${code}.`));
    });
  });

  const metadataPath = layerMetadataPath(path.resolve(args.output_dir), layer);
  try {
    await fs.promises.access(metadataPath, fs.constants.R_OK);
  } catch (error) {
    throw new Error(
      `Layer build completed without metadata handoff for ${layer}: ${metadataPath}. `
        + "Check that this machine has the latest build_pcon_la_lookup_shards.mjs synced.",
    );
  }
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

function writeJsonFile(filePath, payload, { minified = false } = {}) {
  const jsonText = minified
    ? `${JSON.stringify(payload)}\n`
    : `${JSON.stringify(payload, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, jsonText, "utf8");
  return Buffer.byteLength(jsonText, "utf8");
}

function appendJsonLine(filePath, payload) {
  const jsonText = `${JSON.stringify(payload)}\n`;
  fs.appendFileSync(filePath, jsonText, "utf8");
}

function sortedObjectByKey(input) {
  return Object.fromEntries(
    Object.entries(input).sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function ensureFeatureShape(feature, codeKey, nameKey, layer, sourceCrs) {
  const properties = feature && typeof feature === "object" && feature.properties && typeof feature.properties === "object"
    ? feature.properties
    : null;
  const rawGeometry = feature && typeof feature === "object" ? feature.geometry : null;
  const geometry = normalizeGeometryToWgs84(rawGeometry, sourceCrs);
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
  const bbox = normalizeBbox(
    normalizeSourceCrs(sourceCrs) === EPSG_4326 ? feature.bbox : null,
    geometry,
  );
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

function buildGeometryRelativePath(layer, boundaryVersion, code) {
  const normalizedVersion = normalizePathComponent(boundaryVersion || "unversioned");
  const normalizedCode = normalizePathComponent(code);
  return path.join("by_code", layer, normalizedVersion, `${normalizedCode}.json`).replace(/\\/g, "/");
}

function buildTileStagePath(stageDir, tileKey) {
  return path.join(stageDir, `${tileKey}.ndjson`);
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
  const validFeatures = [];
  const bufferedFeatures = [];
  let codeKey = "";
  let nameKey = "";
  let rawFeatureCount = 0;
  let skippedInvalid = 0;
  let skippedUnsupportedGeometry = 0;
  let sourceCrs = normalizeSourceCrs(loaded.crsHint);

  const tileMetaByKey = new Map();
  const seenCodes = new Set();
  const objectEntries = [];
  const tileStageRoot = path.join(outputDir, ".tmp_tile_stage");
  const tileStageDir = path.join(tileStageRoot, layer, boundaryDetail, `grid_${gridToken}`);
  await fs.promises.rm(tileStageDir, { recursive: true, force: true });
  await fs.promises.mkdir(tileStageDir, { recursive: true });

  const processFeature = async (feature) => {
    if (!sourceCrs) {
      sourceCrs = inferSourceCrs({ loaded, feature, layer });
    }
    const prepared = ensureFeatureShape(feature, codeKey, nameKey, layer, sourceCrs);
    if (!prepared) {
      const geometryType = String(feature?.geometry?.type || "");
      if (geometryType && geometryType !== "Polygon" && geometryType !== "MultiPolygon") {
        skippedUnsupportedGeometry += 1;
      } else {
        skippedInvalid += 1;
      }
      return;
    }

    if (seenCodes.has(prepared.code)) {
      throw new Error(`Duplicate ${layer} code detected in boundary input: ${prepared.code}`);
    }
    seenCodes.add(prepared.code);

    const geometryRelativePath = buildGeometryRelativePath(layer, boundaryVersion, prepared.code);
    const geometryPayload = {
      schema_version: 1,
      layer,
      boundary_version: boundaryVersion,
      code: prepared.code,
      name: prepared.name,
      bbox: prepared.bbox,
      geometry: prepared.geometry,
    };
    const geometryOutputPath = path.join(outputDir, geometryRelativePath);
    const geometryBytes = await writeJsonFile(geometryOutputPath, geometryPayload, { minified: true });
    objectEntries.push({
      layer,
      kind: "geometry",
      code: prepared.code,
      relative_path: geometryRelativePath,
      object_key: toObjectPath(prefix, geometryRelativePath),
      bytes: geometryBytes,
      feature_count: 1,
    });

    const tileFeature = {
      code: prepared.code,
      name: prepared.name,
      bbox: prepared.bbox,
      geometry_ref: geometryRelativePath,
    };
    validFeatures.push({
      code: prepared.code,
      name: prepared.name,
      bbox: prepared.bbox,
    });
    const tiles = tilesForGeometry(prepared.geometry, gridSize);
    const effectiveTiles = tiles.length > 0 ? tiles : tilesForBbox(prepared.bbox, gridSize);
    for (const tile of effectiveTiles) {
      if (!tileMetaByKey.has(tile.key)) {
        tileMetaByKey.set(tile.key, tile);
      }
      const stagePath = buildTileStagePath(tileStageDir, tile.key);
      appendJsonLine(stagePath, tileFeature);
    }
  };

  for await (const feature of iterateGeoJsonFeatures(loaded.absolutePath)) {
    rawFeatureCount += 1;

    if (!codeKey || !nameKey) {
      bufferedFeatures.push(feature);
      if (!codeKey) {
        try {
          codeKey = detectPropertyKeyFromFeatures(bufferedFeatures, codeCandidates, `${layer} code`);
        } catch {}
      }
      if (!nameKey) {
        try {
          nameKey = detectPropertyKeyFromFeatures(bufferedFeatures, nameCandidates, `${layer} name`);
        } catch {}
      }
      if (!codeKey || !nameKey) {
        continue;
      }
      for (const bufferedFeature of bufferedFeatures.splice(0)) {
        await processFeature(bufferedFeature);
      }
      continue;
    }

    await processFeature(feature);
  }

  if (!codeKey) {
    throw new Error(`Unable to detect ${layer} code property in ${loaded.absolutePath}.`);
  }
  if (!nameKey) {
    throw new Error(`Unable to detect ${layer} name property in ${loaded.absolutePath}.`);
  }
  if (bufferedFeatures.length > 0) {
    for (const bufferedFeature of bufferedFeatures) {
      await processFeature(bufferedFeature);
    }
  }

  const sortedTiles = Array.from(tileMetaByKey.values()).sort((left, right) => {
    if (left.iy !== right.iy) {
      return left.iy - right.iy;
    }
    return left.ix - right.ix;
  });

  for (const tile of sortedTiles) {
    const tileKey = tile.key;
    const layerPath = path.join(layer, boundaryDetail, `grid_${gridToken}`);
    const relativePath = path.join(layerPath, `${tileKey}.json`).replace(/\\/g, "/");
    const outputPath = path.join(outputDir, relativePath);
    const stagePath = buildTileStagePath(tileStageDir, tileKey);
    const stagedText = fs.readFileSync(stagePath, "utf8");
    const stagedFeatures = stagedText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const shardPayload = {
      schema_version: 1,
      layer,
      boundary_version: boundaryVersion,
      boundary_detail: boundaryDetail,
      grid_size_degrees: gridSize,
      tile: {
        ix: tile.ix,
        iy: tile.iy,
        key: tile.key,
        lat_min: tile.lat_min,
        lat_max: tile.lat_max,
        lon_min: tile.lon_min,
        lon_max: tile.lon_max,
      },
      features: stagedFeatures
        .slice()
        .sort((left, right) => left.code.localeCompare(right.code))
        .map((feature) => ({
          code: feature.code,
          name: feature.name,
          bbox: feature.bbox,
          geometry_ref: feature.geometry_ref,
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

  await fs.promises.rm(tileStageRoot, { recursive: true, force: true });

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
    source_crs: sourceCrs || EPSG_4326,
    output_crs: EPSG_4326,
    code_property: codeKey,
    name_property: nameKey,
    boundary_version: boundaryVersion,
    feature_count: validFeatures.length,
    raw_feature_count: rawFeatureCount,
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
  const objectEntries = [];
  const layersManifest = {};
  const coverageBboxes = [];
  let totalBytes = 0;
  let totalFeatureCount = 0;
  let totalShardCount = 0;
  for (const layerConfig of layerConfigs) {
    const sourceFileSha256 = await sha256FileHex(path.resolve(layerConfig.input_path));
    const loaded = await inspectGeoJsonFile(layerConfig.input_path);
    const result = await buildLayerArtifacts({
      layer: layerConfig.layer,
      loaded,
      boundaryVersion: layerConfig.boundary_version,
      boundaryDetail: args.boundary_detail,
      gridSize: args.grid_size_degrees,
      gridToken,
      outputDir,
      prefix: args.prefix,
      source: layerConfig.source,
      sourceFileSha256,
      sourceFileBytes: loaded.fileBytes,
      codeCandidates: layerConfig.code_candidates,
      nameCandidates: layerConfig.name_candidates,
      skipAdjacency: args.skip_adjacency,
    });
    layersManifest[result.layer] = {
      boundary_version: result.boundary_version,
      source: result.source,
      input_path: result.input_path,
      source_file_name: result.source_file_name,
      source_file_bytes: result.source_file_bytes,
      source_file_sha256: result.source_file_sha256,
      source_crs: result.source_crs,
      output_crs: result.output_crs,
      code_property: result.code_property,
      name_property: result.name_property,
      raw_feature_count: result.raw_feature_count,
      feature_count: result.feature_count,
      shard_count: result.shard_count,
      skipped_invalid_count: result.skipped_invalid_count,
      skipped_unsupported_geometry_count: result.skipped_unsupported_geometry_count,
      bbox_coverage: result.bbox_coverage,
      geometry_storage: "by_code_ref",
      adjacency_enabled: result.adjacency_enabled,
      adjacency_method: result.adjacency_method,
    };

    coverageBboxes.push(result.bbox_coverage);
    totalFeatureCount += result.feature_count;
    totalShardCount += result.shard_count;

    for (const entry of result.object_entries) {
      totalBytes += Number(entry.bytes || 0);
      objectEntries.push(entry);
    }

    maybeRunGc();
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
    geometry_storage: "by_code_ref",
    bbox_coverage: mergeCoverageBboxes(coverageBboxes),
    layers: layersManifest,
    shard_count: totalShardCount,
    feature_count: totalFeatureCount,
    object_count: objectEntries.length + 1,
    objects: objectEntries,
  };

  const manifestRelativePath = "manifest.json";
  const manifestPath = path.join(outputDir, manifestRelativePath);
  const manifestBytes = await writeJsonFile(manifestPath, manifest);

  if (args.child_layer_build) {
    const layerKeys = Object.keys(layersManifest);
    if (layerKeys.length !== 1) {
      throw new Error(`Child layer build expected one layer result, received ${layerKeys.length}.`);
    }
    await writeLayerMetadata(outputDir, {
      layer: layerKeys[0],
      ...layersManifest[layerKeys[0]],
      object_entries: objectEntries,
    });
    await fs.promises.rm(manifestPath, { force: true });
    return;
  }

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
