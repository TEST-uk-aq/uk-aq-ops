#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  buildPostcodeShardObjectKey,
  getPostcodeShard,
  normalisePostcode,
} from "../../workers/shared/postcode_lookup.mjs";

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

function parseCsvLine(line) {
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

function normalizeHeaderName(name) {
  return String(name || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function findColumnIndex(headerNames, candidates) {
  for (const candidate of candidates) {
    const idx = headerNames.indexOf(candidate);
    if (idx >= 0) {
      return idx;
    }
  }
  return -1;
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

function sortObjectKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

async function writeJsonFile(filePath, payload) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.output);
  const generatedAt = new Date().toISOString();

  const stream = fs.createReadStream(inputPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let headerParsed = false;
  let lineNumber = 0;
  let headerNames = [];
  let postcodeColumnIdx = -1;
  let latColumnIdx = -1;
  let lonColumnIdx = -1;

  const shardMaps = new Map();
  let skippedCount = 0;
  let duplicateCount = 0;

  for await (const rawLine of rl) {
    lineNumber += 1;
    const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;

    if (!headerParsed) {
      const headers = parseCsvLine(line);
      headerNames = headers.map(normalizeHeaderName);

      postcodeColumnIdx = findColumnIndex(
        headerNames,
        ["pcds", "postcode", "pcd2", "pcd", "pcd7", "pcd8"],
      );
      latColumnIdx = findColumnIndex(headerNames, ["lat", "latitude"]);
      lonColumnIdx = findColumnIndex(headerNames, ["long", "longitude", "lon", "lng"]);

      if (postcodeColumnIdx < 0) {
        throw new Error(
          `Unable to detect postcode column in header row. Expected one of pcds/postcode/pcd2/pcd/pcd7/pcd8.`,
        );
      }
      if (latColumnIdx < 0 || lonColumnIdx < 0) {
        throw new Error("Unable to detect latitude/longitude columns (lat + long/lon).");
      }

      headerParsed = true;
      continue;
    }

    if (!line.trim()) {
      skippedCount += 1;
      continue;
    }

    const row = parseCsvLine(line);
    const postcode = normalisePostcode(row[postcodeColumnIdx] || "");
    if (!postcode) {
      skippedCount += 1;
      continue;
    }

    const lat = parseCoordinate(row[latColumnIdx], -90, 90);
    const lon = parseCoordinate(row[lonColumnIdx], -180, 180);
    if (lat === null || lon === null) {
      skippedCount += 1;
      continue;
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
    shardMap.set(postcode, [lat, lon]);
  }

  if (!headerParsed) {
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
      schema_version: 1,
      generated_at_utc: generatedAt,
      source: "ONSPD",
      shard,
      postcodes: Object.fromEntries(sortedEntries),
    };

    await writeJsonFile(path.join(outputDir, `${shard}.json`), shardPayload);

    const objectKey = buildPostcodeShardObjectKey(args.prefix, shard);
    shardsManifest[shard] = {
      postcode_count: sortedEntries.length,
      object_key: objectKey,
    };
  }

  const manifest = {
    schema_version: 1,
    generated_at_utc: generatedAt,
    source: "ONSPD",
    shard_count: shardCodes.length,
    postcode_count: postcodeCount,
    skipped_count: skippedCount,
    duplicate_count: duplicateCount,
    input_csv_path: inputPath,
    output_dir: outputDir,
    shards: sortObjectKeys(shardsManifest),
  };

  await writeJsonFile(path.join(outputDir, "manifest.json"), manifest);

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: "ONSPD",
        input_csv_path: inputPath,
        output_dir: outputDir,
        r2_prefix: args.prefix,
        shard_count: manifest.shard_count,
        postcode_count: manifest.postcode_count,
        skipped_count: manifest.skipped_count,
        duplicate_count: manifest.duplicate_count,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`build_postcode_lookup_from_onspd failed: ${message}`);
  process.exit(1);
});
