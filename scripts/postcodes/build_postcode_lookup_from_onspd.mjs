#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import {
  buildPostcodeShardObjectKey,
  getPostcodeShard,
  normalisePostcode,
} from "../../workers/shared/postcode_lookup.mjs";

const POSTCODE_COLUMN_CANDIDATES = ["pcds", "postcode", "pcd2", "pcd", "pcd7", "pcd8"];
const LATITUDE_COLUMN_CANDIDATES = ["lat", "latitude"];
const LONGITUDE_COLUMN_CANDIDATES = ["long", "longitude", "lon", "lng"];
const PCON_COLUMN_CANDIDATES = [
  "pcon24cd",
  "pcon23cd",
  "pconcd",
  "pcon",
  "pconcode",
];
const LA_COLUMN_CANDIDATES = [
  "lad24cd",
  "lad23cd",
  "lad22cd",
  "lad21cd",
  "ladcd",
  "lad",
  "oslaua",
  "lacode",
  "localauthoritycode",
];

const DEFAULT_PREFIX = normalizePrefix(process.env.UK_AQ_POSTCODE_R2_PREFIX || "v1");
const DEFAULT_INPUT_PATH = String(
  process.env.UK_AQ_POSTCODE_ONSPD_CSV_PATH
    || process.env.UK_AQ_POSTCODE_INPUT_CSV
    || process.env.ONSPD_CSV_PATH
    || "",
).trim();
const DEFAULT_OUTPUT_DIR = String(
  process.env.UK_AQ_POSTCODE_LOOKUP_OUTPUT_DIR
    || process.env.UK_AQ_POSTCODE_OUTPUT_DIR
    || "tmp/postcode_lookup_v1",
).trim();

function normalizePrefix(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/postcodes/build_postcode_lookup_from_onspd.mjs --input <onspd.csv> [options]",
      "",
      "Required:",
      "  --input <path>                ONSPD CSV file path",
      "",
      "Optional:",
      "  --output <dir>                Output directory (default: tmp/postcode_lookup_v1)",
      "  --prefix <r2-prefix>          Prefix written into manifest object_key fields (default: v1)",
      "  --source-version <value>      Override source version label in manifest (for example ONSPD_MAY_2025)",
      "  -h, --help",
      "",
      "Env alternatives:",
      "  UK_AQ_POSTCODE_ONSPD_CSV_PATH / UK_AQ_POSTCODE_INPUT_CSV / ONSPD_CSV_PATH",
      "  UK_AQ_POSTCODE_LOOKUP_OUTPUT_DIR / UK_AQ_POSTCODE_OUTPUT_DIR",
      "  UK_AQ_POSTCODE_R2_PREFIX",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT_PATH,
    output: DEFAULT_OUTPUT_DIR,
    prefix: DEFAULT_PREFIX,
    source_version: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--output") {
      args.output = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--prefix") {
      args.prefix = normalizePrefix(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--source-version") {
      args.source_version = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.input) {
    throw new Error("Missing input CSV path. Set --input or UK_AQ_POSTCODE_ONSPD_CSV_PATH.");
  }
  if (!args.output) {
    throw new Error("Missing output directory. Set --output or UK_AQ_POSTCODE_LOOKUP_OUTPUT_DIR.");
  }
  if (!args.prefix) {
    throw new Error("R2 prefix cannot be empty.");
  }
  return args;
}

export function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  values.push(current);
  return values;
}

export function normalizeHeaderName(name) {
  return String(name || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function findColumn(headerNames, rawHeaders, candidates, label) {
  for (const candidate of candidates) {
    const idx = headerNames.indexOf(candidate);
    if (idx >= 0) {
      return {
        index: idx,
        field: String(rawHeaders[idx] || "").replace(/^\uFEFF/, "").trim(),
      };
    }
  }
  throw new Error(
    `Unable to detect ${label} column in header row. ` +
    `Expected one of: ${candidates.join(", ")}.`,
  );
}

export function detectOnspdColumns(rawHeaders) {
  const headerNames = rawHeaders.map(normalizeHeaderName);

  const postcode = findColumn(
    headerNames,
    rawHeaders,
    POSTCODE_COLUMN_CANDIDATES,
    "postcode",
  );
  const lat = findColumn(
    headerNames,
    rawHeaders,
    LATITUDE_COLUMN_CANDIDATES,
    "latitude",
  );
  const lon = findColumn(
    headerNames,
    rawHeaders,
    LONGITUDE_COLUMN_CANDIDATES,
    "longitude",
  );
  const pcon = findColumn(
    headerNames,
    rawHeaders,
    PCON_COLUMN_CANDIDATES,
    "PCON code",
  );
  const la = findColumn(
    headerNames,
    rawHeaders,
    LA_COLUMN_CANDIDATES,
    "local authority code",
  );

  return {
    postcode,
    lat,
    lon,
    pcon,
    la,
  };
}

function parseCoordinate(raw, min, max) {
  const value = Number.parseFloat(String(raw || "").trim());
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value < min || value > max) {
    return null;
  }
  return Number(value.toFixed(6));
}

function parseCodeOrNull(raw) {
  const compact = String(raw || "").trim().toUpperCase();
  return compact || null;
}

function sortObjectKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

async function writeJsonFile(filePath, payload) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function inferOnspdSourceVersion(inputPath) {
  const base = path.basename(String(inputPath || "")).toUpperCase();
  const match = base.match(/ONSPD[_-]?([A-Z]{3})[_-]?(\d{4})/);
  if (match) {
    return `ONSPD_${match[1]}_${match[2]}`;
  }
  if (base.includes("ONSPD")) {
    return "ONSPD";
  }
  return "ONSPD_UNKNOWN";
}

export async function buildPostcodeLookupFromOnspd({
  inputPath,
  outputDir,
  prefix,
  sourceVersion,
}) {
  const generatedAt = new Date().toISOString();
  const stream = fs.createReadStream(inputPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let headerParsed = false;
  let lineNumber = 0;
  let columns = null;

  const shardMaps = new Map();
  let skippedCount = 0;
  let duplicateCount = 0;
  let missingPconCodeCount = 0;
  let missingLaCodeCount = 0;

  for await (const rawLine of rl) {
    lineNumber += 1;
    const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;

    if (!headerParsed) {
      const headers = parseCsvLine(line);
      columns = detectOnspdColumns(headers);
      headerParsed = true;
      continue;
    }

    if (!line.trim()) {
      skippedCount += 1;
      continue;
    }

    const row = parseCsvLine(line);
    const postcode = normalisePostcode(row[columns.postcode.index] || "");
    if (!postcode) {
      skippedCount += 1;
      continue;
    }

    const lat = parseCoordinate(row[columns.lat.index], -90, 90);
    const lon = parseCoordinate(row[columns.lon.index], -180, 180);
    if (lat === null || lon === null) {
      skippedCount += 1;
      continue;
    }

    const pconCode = parseCodeOrNull(row[columns.pcon.index]);
    const laCode = parseCodeOrNull(row[columns.la.index]);
    if (!pconCode) {
      missingPconCodeCount += 1;
    }
    if (!laCode) {
      missingLaCodeCount += 1;
    }

    const shard = getPostcodeShard(postcode);
    if (!shard) {
      skippedCount += 1;
      continue;
    }

    let shardMap = shardMaps.get(shard);
    if (!shardMap) {
      shardMap = new Map();
      shardMaps.set(shard, shardMap);
    }

    if (shardMap.has(postcode)) {
      duplicateCount += 1;
    }
    shardMap.set(postcode, [lat, lon, pconCode, laCode]);
  }

  if (!headerParsed || !columns) {
    throw new Error("Input CSV appears empty; no header row was found.");
  }

  const shardCodes = Array.from(shardMaps.keys()).sort((a, b) => a.localeCompare(b));
  const shardsManifest = {};
  let postcodeCount = 0;

  await fs.promises.mkdir(outputDir, { recursive: true });

  for (const shard of shardCodes) {
    const shardMap = shardMaps.get(shard) || new Map();
    const sortedEntries = Array.from(shardMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    postcodeCount += sortedEntries.length;

    const shardPayload = {
      schema_version: 2,
      generated_at_utc: generatedAt,
      source: "ONSPD",
      source_version: sourceVersion,
      shard,
      postcodes: Object.fromEntries(sortedEntries),
    };

    await writeJsonFile(path.join(outputDir, `${shard}.json`), shardPayload);

    const objectKey = buildPostcodeShardObjectKey(prefix, shard);
    shardsManifest[shard] = {
      postcode_count: sortedEntries.length,
      object_key: objectKey,
    };
  }

  const manifest = {
    schema_version: 2,
    generated_at_utc: generatedAt,
    source: "ONSPD",
    source_version: sourceVersion,
    shard_count: shardCodes.length,
    postcode_count: postcodeCount,
    skipped_count: skippedCount,
    duplicate_count: duplicateCount,
    missing_pcon_code_count: missingPconCodeCount,
    missing_la_code_count: missingLaCodeCount,
    input_csv_path: inputPath,
    output_dir: outputDir,
    postcode_field: columns.postcode.field,
    latitude_field: columns.lat.field,
    longitude_field: columns.lon.field,
    geography_codes: {
      pcon: {
        field: columns.pcon.field,
        expected_version: "PCON 2024",
        contains_names: false,
      },
      la: {
        field: columns.la.field,
        expected_version: "LAD (ONSPD source field)",
        contains_names: false,
      },
    },
    shards: sortObjectKeys(shardsManifest),
  };

  await writeJsonFile(path.join(outputDir, "manifest.json"), manifest);
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.output);
  const sourceVersion = args.source_version || inferOnspdSourceVersion(inputPath);
  const manifest = await buildPostcodeLookupFromOnspd({
    inputPath,
    outputDir,
    prefix: args.prefix,
    sourceVersion,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: manifest.source,
        source_version: manifest.source_version,
        input_csv_path: manifest.input_csv_path,
        output_dir: manifest.output_dir,
        r2_prefix: args.prefix,
        shard_count: manifest.shard_count,
        postcode_count: manifest.postcode_count,
        skipped_count: manifest.skipped_count,
        duplicate_count: manifest.duplicate_count,
        missing_pcon_code_count: manifest.missing_pcon_code_count,
        missing_la_code_count: manifest.missing_la_code_count,
        pcon_field: manifest.geography_codes.pcon.field,
        la_field: manifest.geography_codes.la.field,
      },
      null,
      2,
    ),
  );
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`build_postcode_lookup_from_onspd failed: ${message}`);
    process.exit(1);
  });
}
