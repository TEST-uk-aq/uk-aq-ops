#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_POSTCODE_DIR = String(
  process.env.UK_AQ_POSTCODE_LOOKUP_DIR
    || process.env.UK_AQ_POSTCODE_LOOKUP_OUTPUT_DIR
    || process.env.UK_AQ_POSTCODE_OUTPUT_DIR
    || "tmp/postcode_lookup_v1",
).trim();
const DEFAULT_PCON_GEO_FILE = String(process.env.UK_AQ_WEBSITE_PCON_GEO_FILE || "").trim();
const DEFAULT_LA_GEO_FILE = String(process.env.UK_AQ_WEBSITE_LA_GEO_FILE || "").trim();

const PCON_CODE_CANDIDATES = [
  "PCON24CD",
  "pcon24cd",
  "PCONCD",
  "pconcd",
  "pcon",
  "code",
  "id",
];
const LA_CODE_CANDIDATES = [
  "LAD24CD",
  "lad24cd",
  "LAD23CD",
  "lad23cd",
  "LADCD",
  "ladcd",
  "lad",
  "oslaua",
  "la_code",
  "code",
  "id",
];

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/postcodes/check_postcode_geography_versions.mjs [options]",
      "",
      "Options:",
      "  --postcode-dir <dir>         Generated postcode lookup directory (default: tmp/postcode_lookup_v1)",
      "  --pcon-geojson <path>        Website PCON geography file (.geojson or .hexjson)",
      "  --la-geojson <path>          Website LA geography file (.geojson or .hexjson)",
      "  -h, --help",
      "",
      "Env alternatives:",
      "  UK_AQ_POSTCODE_LOOKUP_DIR",
      "  UK_AQ_WEBSITE_PCON_GEO_FILE",
      "  UK_AQ_WEBSITE_LA_GEO_FILE",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    postcode_dir: DEFAULT_POSTCODE_DIR,
    pcon_geojson: DEFAULT_PCON_GEO_FILE,
    la_geojson: DEFAULT_LA_GEO_FILE,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--postcode-dir") {
      args.postcode_dir = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--pcon-geojson") {
      args.pcon_geojson = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--la-geojson") {
      args.la_geojson = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.postcode_dir) {
    throw new Error("Missing postcode lookup directory (--postcode-dir or UK_AQ_POSTCODE_LOOKUP_DIR).");
  }
  if (!args.pcon_geojson) {
    throw new Error("Missing PCON geography file (--pcon-geojson or UK_AQ_WEBSITE_PCON_GEO_FILE).");
  }
  if (!args.la_geojson) {
    throw new Error("Missing LA geography file (--la-geojson or UK_AQ_WEBSITE_LA_GEO_FILE).");
  }
  return args;
}

function normalizeCode(rawValue) {
  return String(rawValue || "").trim().toUpperCase();
}

function normalizePropertyName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isPresent(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function detectPropertyKeyFromFeatures(features, candidates, label) {
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error(`No features available for ${label} property detection.`);
  }

  const candidatePriority = new Map();
  candidates.forEach((candidate, index) => {
    const normalized = normalizePropertyName(candidate);
    if (normalized && !candidatePriority.has(normalized)) {
      candidatePriority.set(normalized, index);
    }
  });

  const scoreByKey = new Map();
  const availableKeys = new Set();

  for (const feature of features) {
    const properties = feature && typeof feature === "object" && feature.properties && typeof feature.properties === "object"
      ? feature.properties
      : null;
    if (!properties) {
      continue;
    }
    for (const [rawKey, rawValue] of Object.entries(properties)) {
      availableKeys.add(rawKey);
      const normalized = normalizePropertyName(rawKey);
      if (!candidatePriority.has(normalized)) {
        continue;
      }
      if (!scoreByKey.has(rawKey)) {
        scoreByKey.set(rawKey, {
          count: 0,
          priority: candidatePriority.get(normalized),
        });
      }
      if (isPresent(rawValue)) {
        const current = scoreByKey.get(rawKey);
        current.count += 1;
      }
    }
  }

  let bestKey = null;
  let bestCount = -1;
  let bestPriority = Number.POSITIVE_INFINITY;

  for (const [key, score] of scoreByKey.entries()) {
    if (score.count > bestCount) {
      bestKey = key;
      bestCount = score.count;
      bestPriority = score.priority;
      continue;
    }
    if (score.count === bestCount) {
      if (score.priority < bestPriority) {
        bestKey = key;
        bestPriority = score.priority;
        continue;
      }
      if (score.priority === bestPriority && String(key).localeCompare(String(bestKey)) < 0) {
        bestKey = key;
      }
    }
  }

  if (bestKey) {
    return bestKey;
  }

  const availablePreview = Array.from(availableKeys).sort((a, b) => a.localeCompare(b));
  throw new Error(
    `Unable to detect ${label} property. Candidates: ${candidates.join(", ")}. Available keys: ${availablePreview.join(", ")}`,
  );
}

function sortedSetValues(values) {
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function sample(values, max = 20) {
  return values.slice(0, max);
}

function compareSets(leftSet, rightSet) {
  const left = sortedSetValues(leftSet);
  const right = sortedSetValues(rightSet);
  const rightLookup = new Set(right);
  const leftLookup = new Set(left);

  return {
    missing_in_right: left.filter((code) => !rightLookup.has(code)),
    extra_in_right: right.filter((code) => !leftLookup.has(code)),
  };
}

async function readJsonFile(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function extractPostcodeRowCodes(rowValue) {
  if (Array.isArray(rowValue)) {
    return {
      pcon_code: normalizeCode(rowValue[2]) || null,
      la_code: normalizeCode(rowValue[3]) || null,
    };
  }
  if (rowValue && typeof rowValue === "object") {
    return {
      pcon_code: normalizeCode(rowValue.pcon_code || rowValue.pcon || "") || null,
      la_code: normalizeCode(rowValue.la_code || rowValue.lad_code || rowValue.la || "") || null,
    };
  }
  return { pcon_code: null, la_code: null };
}

function listShardFilesFromManifest(postcodeDir, manifest) {
  const shards = manifest && typeof manifest === "object" && manifest.shards && typeof manifest.shards === "object"
    ? manifest.shards
    : null;
  if (!shards) {
    return [];
  }
  return Object.keys(shards)
    .sort((a, b) => a.localeCompare(b))
    .map((shard) => path.join(postcodeDir, `${shard}.json`));
}

async function listShardFiles(postcodeDir) {
  const manifestPath = path.join(postcodeDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = await readJsonFile(manifestPath);
      const fromManifest = listShardFilesFromManifest(postcodeDir, manifest);
      if (fromManifest.length > 0) {
        return fromManifest;
      }
    } catch (_err) {
      // Fall through to directory scan when manifest cannot be parsed.
    }
  }

  const entries = await fs.promises.readdir(postcodeDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(postcodeDir, name));
}

export async function collectPostcodeCodesFromLookupDir(postcodeDir) {
  const shardFiles = await listShardFiles(postcodeDir);
  if (shardFiles.length === 0) {
    throw new Error(`No shard JSON files found in ${postcodeDir}.`);
  }

  const pconCodes = new Set();
  const laCodes = new Set();
  let postcodeCount = 0;

  for (const shardPath of shardFiles) {
    const payload = await readJsonFile(shardPath);
    const postcodes = payload && typeof payload === "object" && payload.postcodes && typeof payload.postcodes === "object"
      ? payload.postcodes
      : null;
    if (!postcodes) {
      continue;
    }

    for (const rowValue of Object.values(postcodes)) {
      postcodeCount += 1;
      const record = extractPostcodeRowCodes(rowValue);
      if (record.pcon_code) {
        pconCodes.add(record.pcon_code);
      }
      if (record.la_code) {
        laCodes.add(record.la_code);
      }
    }
  }

  return {
    shard_file_count: shardFiles.length,
    postcode_count: postcodeCount,
    pcon_codes: pconCodes,
    la_codes: laCodes,
  };
}

function collectCodesFromFeatureRecords(features, candidatePropertyKeys, label) {
  const codes = new Set();
  const propertyCandidates = candidatePropertyKeys.filter(
    (candidate) => normalizePropertyName(candidate) !== "id",
  );
  let detectedField = null;

  try {
    detectedField = detectPropertyKeyFromFeatures(features, propertyCandidates, label);
  } catch (_err) {
    detectedField = null;
  }

  if (detectedField) {
    for (const feature of features) {
      const properties = feature && typeof feature === "object" && feature.properties && typeof feature.properties === "object"
        ? feature.properties
        : null;
      const code = normalizeCode(properties ? properties[detectedField] : "");
      if (code) {
        codes.add(code);
      }
    }
  }

  for (const feature of features) {
    const featureCode = normalizeCode(feature && typeof feature === "object" ? feature.id : "");
    if (featureCode) {
      codes.add(featureCode);
    }
    const properties = feature && typeof feature === "object" && feature.properties && typeof feature.properties === "object"
      ? feature.properties
      : null;
    if (!properties) {
      continue;
    }

    for (const [key, value] of Object.entries(properties)) {
      const normalizedKey = normalizePropertyName(key);
      if (!normalizedKey.includes("code") && !normalizedKey.includes("cd")) {
        continue;
      }
      const normalizedValue = normalizeCode(value);
      if (normalizedValue) {
        codes.add(normalizedValue);
      }
    }
  }

  return {
    codes,
    detected_field: detectedField || "feature.id/properties.*code",
    format: "feature_collection",
  };
}

function collectCodesFromHexjsonPayload(payload, candidatePropertyKeys) {
  const hexes = payload && typeof payload === "object" && payload.hexes && typeof payload.hexes === "object"
    ? payload.hexes
    : null;
  if (!hexes) {
    return null;
  }

  const codes = new Set();
  const normalizedCandidates = new Set(candidatePropertyKeys.map(normalizePropertyName));

  for (const [hexKey, value] of Object.entries(hexes)) {
    const keyCode = normalizeCode(hexKey);
    if (keyCode) {
      codes.add(keyCode);
    }

    if (!value || typeof value !== "object") {
      continue;
    }

    const directId = normalizeCode(value.id || value.code || "");
    if (directId) {
      codes.add(directId);
    }

    for (const [rawKey, rawValue] of Object.entries(value)) {
      const normalizedKey = normalizePropertyName(rawKey);
      if (normalizedCandidates.has(normalizedKey) || normalizedKey.includes("code") || normalizedKey.includes("cd")) {
        const normalizedValue = normalizeCode(rawValue);
        if (normalizedValue) {
          codes.add(normalizedValue);
        }
      }
    }

    const properties = value.properties && typeof value.properties === "object" ? value.properties : null;
    if (!properties) {
      continue;
    }

    for (const [rawKey, rawValue] of Object.entries(properties)) {
      const normalizedKey = normalizePropertyName(rawKey);
      if (normalizedCandidates.has(normalizedKey) || normalizedKey.includes("code") || normalizedKey.includes("cd")) {
        const normalizedValue = normalizeCode(rawValue);
        if (normalizedValue) {
          codes.add(normalizedValue);
        }
      }
    }
  }

  return {
    codes,
    detected_field: "hexes.<key>/hexes.*code",
    format: "hexjson",
  };
}

export function collectCodesFromGeometryPayload(payload, candidatePropertyKeys, label) {
  const fromHexjson = collectCodesFromHexjsonPayload(payload, candidatePropertyKeys);
  if (fromHexjson) {
    return fromHexjson;
  }

  const features = payload && typeof payload === "object" && Array.isArray(payload.features)
    ? payload.features
    : (Array.isArray(payload) ? payload : null);
  if (features) {
    return collectCodesFromFeatureRecords(features, candidatePropertyKeys, label);
  }

  throw new Error(
    `${label} file is not a supported geometry shape. Expected HexJSON { hexes: {...} } or GeoJSON FeatureCollection.`,
  );
}

export async function runGeographyCompatibilityCheck({
  postcodeDir,
  pconGeoPath,
  laGeoPath,
}) {
  const postcodeLookup = await collectPostcodeCodesFromLookupDir(postcodeDir);
  const pconPayload = await readJsonFile(pconGeoPath);
  const laPayload = await readJsonFile(laGeoPath);

  const pconGeo = collectCodesFromGeometryPayload(pconPayload, PCON_CODE_CANDIDATES, "PCON code");
  const laGeo = collectCodesFromGeometryPayload(laPayload, LA_CODE_CANDIDATES, "LA code");

  const pconCompare = compareSets(postcodeLookup.pcon_codes, pconGeo.codes);
  const laCompare = compareSets(postcodeLookup.la_codes, laGeo.codes);
  const hasMissing = pconCompare.missing_in_right.length > 0 || laCompare.missing_in_right.length > 0;

  return {
    ok: !hasMissing,
    postcode_dir: postcodeDir,
    pcon_geo_file: pconGeoPath,
    la_geo_file: laGeoPath,
    postcode_lookup: {
      shard_file_count: postcodeLookup.shard_file_count,
      postcode_count: postcodeLookup.postcode_count,
      pcon_unique_count: postcodeLookup.pcon_codes.size,
      la_unique_count: postcodeLookup.la_codes.size,
    },
    website_geography: {
      pcon: {
        format: pconGeo.format,
        detected_field: pconGeo.detected_field,
        unique_count: pconGeo.codes.size,
      },
      la: {
        format: laGeo.format,
        detected_field: laGeo.detected_field,
        unique_count: laGeo.codes.size,
      },
    },
    comparisons: {
      pcon_missing_from_website_count: pconCompare.missing_in_right.length,
      pcon_missing_from_website_examples: sample(pconCompare.missing_in_right),
      la_missing_from_website_count: laCompare.missing_in_right.length,
      la_missing_from_website_examples: sample(laCompare.missing_in_right),
      website_pcon_not_seen_in_postcode_count: pconCompare.extra_in_right.length,
      website_pcon_not_seen_in_postcode_examples: sample(pconCompare.extra_in_right),
      website_la_not_seen_in_postcode_count: laCompare.extra_in_right.length,
      website_la_not_seen_in_postcode_examples: sample(laCompare.extra_in_right),
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const postcodeDir = path.resolve(args.postcode_dir);
  const pconGeoPath = path.resolve(args.pcon_geojson);
  const laGeoPath = path.resolve(args.la_geojson);

  const report = await runGeographyCompatibilityCheck({
    postcodeDir,
    pconGeoPath,
    laGeoPath,
  });

  console.log(JSON.stringify(report, null, 2));

  if (report.comparisons.website_pcon_not_seen_in_postcode_count > 0) {
    console.error("warning: website PCON geography includes codes not present in postcode lookup output");
  }
  if (report.comparisons.website_la_not_seen_in_postcode_count > 0) {
    console.error("warning: website LA geography includes codes not present in postcode lookup output");
  }

  if (!report.ok) {
    process.exit(1);
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`check_postcode_geography_versions failed: ${message}`);
    process.exit(1);
  });
}
