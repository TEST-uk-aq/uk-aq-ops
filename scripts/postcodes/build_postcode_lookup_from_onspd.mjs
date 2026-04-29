#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import {
  detectAreaTownColumns,
  loadAreaTownLookups,
  parseAreaTownPairKey,
  parseCsvLine as parseCsvLineShared,
  createAreaTownPairKey,
  resolveAreaAndPostTown,
} from "./lib/area_town_resolver.mjs";
import {
  buildPostcodeAreaTownIndexObjectKey,
  buildPostcodeExactShardObjectKey,
  buildPostcodePrefixHintsObjectKey,
  buildPostcodeSuggestShardObjectKey,
  formatPostcode,
  getPostcodeShard,
  normalisePostcode,
} from "../../workers/shared/postcode_lookup.mjs";

const POSTCODE_COLUMN_CANDIDATES = ["pcds", "postcode", "pcd2", "pcd", "pcd7", "pcd8"];
const LATITUDE_COLUMN_CANDIDATES = ["lat", "latitude"];
const LONGITUDE_COLUMN_CANDIDATES = ["long", "longitude", "lon", "lng"];
const DOTERM_COLUMN_CANDIDATES = ["doterm", "dateoftermination"];
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
const MAX_PREFIX_SAMPLE_ROWS = 24;
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

function defaultOnspdRoot(inputPath) {
  const resolvedInput = path.resolve(String(inputPath || ""));
  return path.resolve(path.dirname(path.dirname(resolvedInput)));
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
      "  --onspd-root <dir>            ONSPD root folder (contains Documents/ lookups)",
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
    onspd_root: "",
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
    if (arg === "--onspd-root") {
      args.onspd_root = String(argv[i + 1] || "").trim();
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
  return parseCsvLineShared(line);
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
    `Unable to detect ${label} column in header row. `
    + `Expected one of: ${candidates.join(", ")}.`,
  );
}

function findOptionalColumn(headerNames, rawHeaders, candidates) {
  for (const candidate of candidates) {
    const idx = headerNames.indexOf(candidate);
    if (idx >= 0) {
      return {
        index: idx,
        field: String(rawHeaders[idx] || "").replace(/^\uFEFF/, "").trim(),
      };
    }
  }
  return {
    index: -1,
    field: null,
  };
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
  const doterm = findOptionalColumn(
    headerNames,
    rawHeaders,
    DOTERM_COLUMN_CANDIDATES,
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

  const areaTownColumns = detectAreaTownColumns(rawHeaders);

  return {
    postcode,
    lat,
    lon,
    doterm,
    pcon,
    la,
    ...areaTownColumns,
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

function isDefunctPostcodeDoterm(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return false;
  }
  const numeric = value.replace(/\D+/g, "");
  if (numeric.length === 6) {
    return true;
  }
  return true;
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

function compareSampleRows(left, right) {
  return String(left?.[0] || "").localeCompare(String(right?.[0] || ""));
}

function addPrefixSample(sampleMap, prefix, rowValue, maxRows = MAX_PREFIX_SAMPLE_ROWS) {
  if (!prefix) {
    return;
  }
  const postcodeNormalised = String(rowValue?.[0] || "").trim().toUpperCase();
  if (!postcodeNormalised) {
    return;
  }
  const bucket = sampleMap.get(prefix) || [];
  if (bucket.some((row) => String(row?.[0] || "").toUpperCase() === postcodeNormalised)) {
    return;
  }
  let insertAt = bucket.findIndex((row) => compareSampleRows([postcodeNormalised], row) < 0);
  if (insertAt < 0) {
    insertAt = bucket.length;
  }
  bucket.splice(insertAt, 0, rowValue);
  if (bucket.length > maxRows) {
    bucket.length = maxRows;
  }
  sampleMap.set(prefix, bucket);
}

function buildPrefixHints({
  prefix1Samples,
  prefix2Samples,
  areaTownIdByPairKey,
}) {
  const postcodeSamples1 = {};
  const postcodeSamples2 = {};

  for (const [query, rows] of Array.from(prefix1Samples.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    postcodeSamples1[query] = rows
      .slice()
      .sort(compareSampleRows)
      .slice(0, MAX_PREFIX_SAMPLE_ROWS)
      .map((row) => [
        String(row?.[0] || "").trim().toUpperCase(),
        String(row?.[1] || "").trim(),
        areaTownIdByPairKey.get(row?.[2]) ?? 0,
      ])
      .filter((row) => row[0] && row[1]);
  }

  for (const [query, rows] of Array.from(prefix2Samples.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    postcodeSamples2[query] = rows
      .slice()
      .sort(compareSampleRows)
      .slice(0, MAX_PREFIX_SAMPLE_ROWS)
      .map((row) => [
        String(row?.[0] || "").trim().toUpperCase(),
        String(row?.[1] || "").trim(),
        areaTownIdByPairKey.get(row?.[2]) ?? 0,
      ])
      .filter((row) => row[0] && row[1]);
  }

  return {
    schema_version: 1,
    postcode_samples_1: postcodeSamples1,
    postcode_samples_2: postcodeSamples2,
  };
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
  onspdRoot,
}) {
  const generatedAt = new Date().toISOString();
  const docsRoot = path.resolve(onspdRoot || defaultOnspdRoot(inputPath));
  const { lookupInfos, lookupById, lookup_root: lookupRoot } = await loadAreaTownLookups(docsRoot);
  const resolvedOutputDir = path.resolve(outputDir);
  if (resolvedOutputDir === path.parse(resolvedOutputDir).root) {
    throw new Error(`Refusing to clear output dir root path: ${resolvedOutputDir}`);
  }
  await fs.promises.rm(resolvedOutputDir, { recursive: true, force: true });

  const stream = fs.createReadStream(inputPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let headerParsed = false;
  let lineNumber = 0;
  let columns = null;

  const exactShardMaps = new Map();
  const suggestShardMaps = new Map();
  const areaTownPairs = new Set();
  const prefix1Samples = new Map();
  const prefix2Samples = new Map();

  let skippedCount = 0;
  let duplicateCount = 0;
  let missingPconCodeCount = 0;
  let missingLaCodeCount = 0;
  let missingAreaNameCount = 0;
  let missingPostTownCount = 0;
  let terminatedPostcodeSkippedCount = 0;

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
    if (columns.doterm.index >= 0 && isDefunctPostcodeDoterm(row[columns.doterm.index])) {
      terminatedPostcodeSkippedCount += 1;
      continue;
    }

    const postcodeNormalised = normalisePostcode(row[columns.postcode.index] || "");
    if (!postcodeNormalised) {
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

    const area = getPostcodeShard(postcodeNormalised);
    if (!area) {
      skippedCount += 1;
      continue;
    }

    const resolvedAreaTown = resolveAreaAndPostTown({
      row,
      columns,
      lookupById,
    });
    if (!resolvedAreaTown.area_name) {
      missingAreaNameCount += 1;
    }
    if (!resolvedAreaTown.post_town) {
      missingPostTownCount += 1;
    }

    const areaTownPairKey = createAreaTownPairKey(resolvedAreaTown.area_name, resolvedAreaTown.post_town);
    areaTownPairs.add(areaTownPairKey);

    let exactShardMap = exactShardMaps.get(area);
    if (!exactShardMap) {
      exactShardMap = new Map();
      exactShardMaps.set(area, exactShardMap);
    }

    if (exactShardMap.has(postcodeNormalised)) {
      duplicateCount += 1;
    }
    exactShardMap.set(postcodeNormalised, [lat, lon, pconCode, laCode, areaTownPairKey]);

    let suggestShardMap = suggestShardMaps.get(area);
    if (!suggestShardMap) {
      suggestShardMap = new Map();
      suggestShardMaps.set(area, suggestShardMap);
    }
    const formattedPostcode = formatPostcode(postcodeNormalised);
    suggestShardMap.set(postcodeNormalised, [postcodeNormalised, formattedPostcode, areaTownPairKey]);

    const firstChar = postcodeNormalised.slice(0, 1);
    if (firstChar) {
      addPrefixSample(prefix1Samples, firstChar, [postcodeNormalised, formattedPostcode, areaTownPairKey]);
    }

    const firstTwoChars = postcodeNormalised.slice(0, 2);
    if (firstTwoChars) {
      addPrefixSample(prefix2Samples, firstTwoChars, [postcodeNormalised, formattedPostcode, areaTownPairKey]);
    }
  }

  if (!headerParsed || !columns) {
    throw new Error("Input CSV appears empty; no header row was found.");
  }

  await fs.promises.mkdir(resolvedOutputDir, { recursive: true });

  const areaTownIdByPairKey = new Map();
  const sortedPairKeys = Array.from(areaTownPairs).sort((left, right) => {
    const leftPair = parseAreaTownPairKey(left);
    const rightPair = parseAreaTownPairKey(right);
    const leftArea = String(leftPair.area_name || "");
    const rightArea = String(rightPair.area_name || "");
    const areaCmp = leftArea.localeCompare(rightArea);
    if (areaCmp !== 0) {
      return areaCmp;
    }
    const leftTown = String(leftPair.post_town || "");
    const rightTown = String(rightPair.post_town || "");
    return leftTown.localeCompare(rightTown);
  });

  const areaTownValues = {
    0: [null, null],
  };
  let nextAreaTownId = 1;
  for (const pairKey of sortedPairKeys) {
    const pair = parseAreaTownPairKey(pairKey);
    if (!pair.area_name && !pair.post_town) {
      areaTownIdByPairKey.set(pairKey, 0);
      continue;
    }
    const id = nextAreaTownId;
    nextAreaTownId += 1;
    areaTownIdByPairKey.set(pairKey, id);
    areaTownValues[String(id)] = [pair.area_name || null, pair.post_town || null];
  }

  const exactShardCodes = Array.from(exactShardMaps.keys()).sort((a, b) => a.localeCompare(b));
  const suggestShardCodes = Array.from(suggestShardMaps.keys()).sort((a, b) => a.localeCompare(b));
  const exactShardsManifest = {};
  const suggestShardsManifest = {};
  let postcodeCount = 0;

  for (const shard of exactShardCodes) {
    const shardMap = exactShardMaps.get(shard) || new Map();
    const sortedEntries = Array.from(shardMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    postcodeCount += sortedEntries.length;

    const postcodes = {};
    for (const [postcodeNormalised, rowValue] of sortedEntries) {
      const areaTownId = areaTownIdByPairKey.get(rowValue[4]) ?? 0;
      postcodes[postcodeNormalised] = [rowValue[0], rowValue[1], rowValue[2], rowValue[3], areaTownId];
    }

    const shardPayload = {
      schema_version: 2,
      generated_at_utc: generatedAt,
      source: "ONSPD",
      source_version: sourceVersion,
      shard,
      columns: ["lat", "lon", "pcon_code", "la_code", "area_town_id"],
      postcodes,
    };

    const relativePath = path.posix.join("shards", `${shard}.json`);
    const objectKey = buildPostcodeExactShardObjectKey(prefix, shard);
    await writeJsonFile(path.join(resolvedOutputDir, relativePath), shardPayload);
    exactShardsManifest[shard] = {
      postcode_count: sortedEntries.length,
      object_key: objectKey,
      relative_path: relativePath,
    };
  }

  for (const shard of suggestShardCodes) {
    const shardMap = suggestShardMaps.get(shard) || new Map();
    const sortedRows = Array.from(shardMap.values())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map((rowValue) => [
        rowValue[0],
        rowValue[1],
        areaTownIdByPairKey.get(rowValue[2]) ?? 0,
      ]);

    const shardPayload = {
      schema_version: 1,
      generated_at_utc: generatedAt,
      source: "ONSPD",
      source_version: sourceVersion,
      postcode_area: shard,
      columns: ["n", "p", "at"],
      rows: sortedRows,
    };

    const relativePath = path.posix.join("suggest", `${shard}.json`);
    const objectKey = buildPostcodeSuggestShardObjectKey(prefix, shard);
    await writeJsonFile(path.join(resolvedOutputDir, relativePath), shardPayload);
    suggestShardsManifest[shard] = {
      postcode_count: sortedRows.length,
      object_key: objectKey,
      relative_path: relativePath,
    };
  }

  const areaTownIndex = {
    schema_version: 1,
    generated_at_utc: generatedAt,
    source: "ONSPD",
    source_version: sourceVersion,
    columns: ["area_name", "post_town"],
    values: areaTownValues,
  };
  const areaTownRelativePath = "area_town_index.json";
  await writeJsonFile(path.join(resolvedOutputDir, areaTownRelativePath), areaTownIndex);

  const prefixHints = buildPrefixHints({
    prefix1Samples,
    prefix2Samples,
    areaTownIdByPairKey,
  });
  const prefixHintsPayload = {
    ...prefixHints,
    generated_at_utc: generatedAt,
    source: "ONSPD",
    source_version: sourceVersion,
  };
  const prefixHintsRelativePath = "postcode_prefix_hints.json";
  await writeJsonFile(path.join(resolvedOutputDir, prefixHintsRelativePath), prefixHintsPayload);

  const manifest = {
    schema_version: 2,
    generated_at_utc: generatedAt,
    source: "ONSPD",
    source_version: sourceVersion,
    shard_count: exactShardCodes.length,
    exact_shard_count: exactShardCodes.length,
    suggest_shard_count: suggestShardCodes.length,
    postcode_count: postcodeCount,
    skipped_count: skippedCount,
    duplicate_count: duplicateCount,
    missing_pcon_code_count: missingPconCodeCount,
    missing_la_code_count: missingLaCodeCount,
    missing_area_name_count: missingAreaNameCount,
    missing_post_town_count: missingPostTownCount,
    terminated_postcode_skipped_count: terminatedPostcodeSkippedCount,
    area_town_index_count: Object.keys(areaTownValues).length,
    unique_area_town_combo_count: Object.keys(areaTownValues).length - 1,
    input_csv_path: inputPath,
    onspd_root: docsRoot,
    lookup_root: lookupRoot,
    output_dir: resolvedOutputDir,
    postcode_field: columns.postcode.field,
    latitude_field: columns.lat.field,
    longitude_field: columns.lon.field,
    doterm_field: columns.doterm.field,
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
    area_town_fields: {
      ctry: columns.ctry.field,
      buasd24: columns.buasd24.field,
      bua24: columns.bua24.field,
      parish: columns.parish.field,
      osward: columns.osward.field,
      oslaua: columns.oslaua.field,
      ttwa: columns.ttwa.field,
      post_town: columns.post_town.field,
    },
    exact_shard_layout: {
      columns: ["lat", "lon", "pcon_code", "la_code", "area_town_id"],
      object_key_template: `${normalizePrefix(prefix)}/shards/{AREA}.json`,
    },
    suggest_shard_layout: {
      columns: ["n", "p", "at"],
      object_key_template: `${normalizePrefix(prefix)}/suggest/{AREA}.json`,
    },
    objects: {
      area_town_index: buildPostcodeAreaTownIndexObjectKey(prefix),
      area_town_index_relative_path: areaTownRelativePath,
      postcode_prefix_hints: buildPostcodePrefixHintsObjectKey(prefix),
      postcode_prefix_hints_relative_path: prefixHintsRelativePath,
      exact_shards_prefix: `${normalizePrefix(prefix)}/shards/`,
      suggest_shards_prefix: `${normalizePrefix(prefix)}/suggest/`,
    },
    lookup_files: lookupInfos.map((info) => ({
      id: info.id,
      found: info.found,
      file_path: info.file_path,
      code_column: info.code_column,
      name_column: info.name_column,
      note: info.note,
      mapped_count: info.mapped_count,
    })),
    shards: sortObjectKeys(exactShardsManifest),
    exact_shards: sortObjectKeys(exactShardsManifest),
    suggest_shards: sortObjectKeys(suggestShardsManifest),
  };

  await writeJsonFile(path.join(resolvedOutputDir, "manifest.json"), manifest);
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.output);
  const sourceVersion = args.source_version || inferOnspdSourceVersion(inputPath);
  const onspdRoot = path.resolve(args.onspd_root || defaultOnspdRoot(inputPath));
  const manifest = await buildPostcodeLookupFromOnspd({
    inputPath,
    outputDir,
    prefix: args.prefix,
    sourceVersion,
    onspdRoot,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: manifest.source,
        source_version: manifest.source_version,
        input_csv_path: manifest.input_csv_path,
        onspd_root: manifest.onspd_root,
        output_dir: manifest.output_dir,
        r2_prefix: args.prefix,
        exact_shard_count: manifest.exact_shard_count,
        suggest_shard_count: manifest.suggest_shard_count,
        postcode_count: manifest.postcode_count,
        unique_area_town_combo_count: manifest.unique_area_town_combo_count,
        skipped_count: manifest.skipped_count,
        duplicate_count: manifest.duplicate_count,
        missing_pcon_code_count: manifest.missing_pcon_code_count,
        missing_la_code_count: manifest.missing_la_code_count,
        missing_area_name_count: manifest.missing_area_name_count,
        missing_post_town_count: manifest.missing_post_town_count,
        terminated_postcode_skipped_count: manifest.terminated_postcode_skipped_count,
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
