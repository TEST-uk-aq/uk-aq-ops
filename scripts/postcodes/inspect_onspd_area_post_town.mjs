#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_ONSPD_CSV = String(
  process.env.UK_AQ_POSTCODE_ONSPD_CSV_PATH
    || process.env.UK_AQ_POSTCODE_INPUT_CSV
    || process.env.ONSPD_CSV_PATH
    || "/Users/mikehinford/Dropbox/Projects/CIC Website/Resources - Main - CIC Web/Postcode lookup/ONSPD_MAY_2025/Data/ONSPD_MAY_2025_UK.csv",
).trim();
const DEFAULT_ONSPD_ROOT = path.resolve(path.dirname(path.dirname(DEFAULT_ONSPD_CSV)));
const DEFAULT_OUTPUT_ALL = "tmp/onspd_may_2025_postcode_area_post_town_all.csv";
const DEFAULT_OUTPUT_UNMATCHED = "tmp/onspd_may_2025_postcode_area_post_town_unmatched.csv";
const DEFAULT_OUTPUT_SUMMARY = "tmp/onspd_may_2025_postcode_area_post_town_summary.md";

const PSEUDO_CODE_PATTERN = /^[A-Z]99999999$/;
const PREFIX_SAMPLES = ["BS1", "BS2", "BS32", "SW1A", "EC1A", "M1", "B1", "CF10", "BT1", "G1", "EH1"];
const AREA_RULES_BY_COUNTRY = {
  E92000001: ["buasd24", "bua24", "parish", "osward", "oslaua"],
  W92000004: ["buasd24", "bua24", "parish", "osward", "oslaua"],
  S92000003: ["osward", "oslaua"],
  N92000002: ["osward", "oslaua"],
  default: ["osward", "oslaua", "bua24", "parish"],
};
const AREA_SOURCE_LABELS = {
  buasd24: "buasd24_name",
  bua24: "bua24_name",
  parish: "parish_name",
  osward: "osward_name",
  oslaua: "oslaua_name",
};

const LOOKUP_SPECS = [
  {
    id: "bua24",
    label: "BUA24 code -> BUA24 name",
    filePattern: /bua24.*names and codes/i,
    codeCandidates: ["BUA24CD", "BUA24_CODE"],
    nameCandidates: ["BUA24NM", "BUA24_NAME", "BUA24NMW"],
  },
  {
    id: "parish",
    label: "PARNCP code -> Parish/Community name",
    filePattern: /parish.*names and codes/i,
    codeCandidates: ["PARNCP21CD", "PARNCPCD", "PARISHCD"],
    nameCandidates: ["PARNCP21NM", "PARNCPNM", "PARISHNM", "PARNCP21NMW"],
  },
  {
    id: "osward",
    label: "Ward code -> Ward name",
    filePattern: /^ward names and codes uk/i,
    codeCandidates: ["WD24CD", "WD23CD", "WD22CD", "WDCD"],
    nameCandidates: ["WD24NM", "WD23NM", "WD22NM", "WDNM", "WD24NMW"],
  },
  {
    id: "oslaua",
    label: "LAD/UA code -> LA/UA name",
    filePattern: /la_ua names and codes uk/i,
    codeCandidates: ["LAD23CD", "LAD24CD", "LAD22CD", "LADCD"],
    nameCandidates: ["LAD23NM", "LAD24NM", "LAD22NM", "LADNM", "LAD23NMW"],
  },
  {
    id: "ctry",
    label: "Country code -> Country name",
    filePattern: /country names and codes uk/i,
    codeCandidates: ["CTRY12CD", "CTRYCD", "CTRY_CODE"],
    nameCandidates: ["CTRY12NM", "CTRYNM", "CTRY_NAME"],
  },
  {
    id: "ttwa",
    label: "TTWA code -> TTWA name",
    filePattern: /ttwa names and codes uk/i,
    codeCandidates: ["TTWA11CD", "TTWACD", "TTWA_CODE"],
    nameCandidates: ["TTWA11NM", "TTWANM", "TTWA_NAME"],
  },
  {
    id: "rgn",
    label: "Region code -> Region name",
    filePattern: /region names and codes en/i,
    codeCandidates: ["RGN20CD", "RGNCD", "RGN_CODE"],
    nameCandidates: ["RGN20NM", "RGNNM", "RGN_NAME"],
  },
  {
    id: "pct",
    label: "PCT code -> PCT name",
    filePattern: /pct names and codes uk/i,
    codeCandidates: ["PCTCD", "PCT_CODE"],
    nameCandidates: ["PCTNM", "PCT_NAME"],
  },
  {
    id: "oscty",
    label: "County code -> County name",
    filePattern: /county names and codes uk/i,
    codeCandidates: ["CTY23CD", "CTYCD", "COUNTYCD"],
    nameCandidates: ["CTY23NM", "CTYNM", "COUNTYNM"],
  },
  {
    id: "ced",
    label: "CED code -> CED name",
    filePattern: /county electoral division names and codes en/i,
    codeCandidates: ["CED23CD", "CEDCD", "CED_CODE"],
    nameCandidates: ["CED23NM", "CEDNM", "CED_NAME"],
  },
];

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/postcodes/inspect_onspd_area_post_town.mjs [options]",
      "",
      "Options:",
      "  --input <path>               ONSPD CSV path",
      "  --onspd-root <path>          ONSPD root folder (containing Documents/)",
      "  --out-all <path>             Output CSV for all rows",
      "  --out-unmatched <path>       Output CSV for unmatched/problem rows",
      "  --out-summary <path>         Output markdown summary path",
      "  -h, --help",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_ONSPD_CSV,
    onspd_root: DEFAULT_ONSPD_ROOT,
    out_all: DEFAULT_OUTPUT_ALL,
    out_unmatched: DEFAULT_OUTPUT_UNMATCHED,
    out_summary: DEFAULT_OUTPUT_SUMMARY,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--onspd-root") {
      args.onspd_root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--out-all") {
      args.out_all = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--out-unmatched") {
      args.out_unmatched = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--out-summary") {
      args.out_summary = String(argv[i + 1] || "").trim();
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
    throw new Error("Missing --input path.");
  }
  if (!args.onspd_root) {
    throw new Error("Missing --onspd-root path.");
  }
  return args;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
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

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeHeaderName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalisePostcode(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function looksPseudoCode(value) {
  if (!value) {
    return true;
  }
  const compact = clean(value).toUpperCase();
  if (!compact) {
    return true;
  }
  if (compact === "NULL" || compact === "N/A" || compact === "NA") {
    return true;
  }
  if (PSEUDO_CODE_PATTERN.test(compact)) {
    return true;
  }
  return false;
}

async function ensureDirForFile(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

async function listLookupCandidates(rootDir) {
  const candidates = [];
  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!/\.(csv|txt)$/i.test(entry.name)) {
        continue;
      }
      candidates.push(full);
    }
  }
  await walk(rootDir);
  return candidates;
}

function pickIndexByCandidates(headers, candidates) {
  const normalized = headers.map(normalizeHeaderName);
  for (const candidate of candidates) {
    const target = normalizeHeaderName(candidate);
    const idx = normalized.indexOf(target);
    if (idx >= 0) {
      return idx;
    }
  }
  return -1;
}

async function loadLookupMap(spec, files) {
  const filePath = files.find((candidate) => spec.filePattern.test(path.basename(candidate)));
  if (!filePath) {
    return {
      id: spec.id,
      label: spec.label,
      found: false,
      file_path: null,
      code_column: null,
      name_column: null,
      map: new Map(),
      row_count: 0,
      mapped_count: 0,
      note: "lookup_file_not_found",
    };
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let headers = [];
  let codeIdx = -1;
  let nameIdx = -1;
  const map = new Map();
  let rowCount = 0;

  for await (const rawLine of rl) {
    lineNo += 1;
    const line = lineNo === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    if (lineNo === 1) {
      headers = parseCsvLine(line).map(clean);
      codeIdx = pickIndexByCandidates(headers, spec.codeCandidates);
      nameIdx = pickIndexByCandidates(headers, spec.nameCandidates);
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    rowCount += 1;
    if (codeIdx < 0 || nameIdx < 0) {
      continue;
    }
    const row = parseCsvLine(line);
    const code = clean(row[codeIdx]).toUpperCase();
    const name = clean(row[nameIdx]);
    if (!code || !name) {
      continue;
    }
    map.set(code, name);
  }

  return {
    id: spec.id,
    label: spec.label,
    found: true,
    file_path: filePath,
    code_column: codeIdx >= 0 ? headers[codeIdx] : null,
    name_column: nameIdx >= 0 ? headers[nameIdx] : null,
    map,
    row_count: rowCount,
    mapped_count: map.size,
    note: codeIdx < 0 || nameIdx < 0 ? "code_or_name_column_not_detected" : "ok",
  };
}

function chooseColumn(headers, candidates) {
  const normalized = headers.map(normalizeHeaderName);
  for (const candidate of candidates) {
    const idx = normalized.indexOf(normalizeHeaderName(candidate));
    if (idx >= 0) {
      return {
        index: idx,
        name: headers[idx],
      };
    }
  }
  return {
    index: -1,
    name: null,
  };
}

function readField(row, column) {
  if (!column || column.index < 0) {
    return "";
  }
  return clean(row[column.index]);
}

function readCode(row, column) {
  return readField(row, column).toUpperCase();
}

function lookupName(mapInfo, code) {
  if (!mapInfo || !mapInfo.map) {
    return null;
  }
  return mapInfo.map.get(code) || null;
}

function resolveAreaName({ row, columns, lookupById }) {
  const country = readCode(row, columns.ctry);
  const rawBuasd = readCode(row, columns.buasd24);
  const rawBua = readCode(row, columns.bua24);
  const rawParish = readCode(row, columns.parish);
  const rawWard = readCode(row, columns.osward);
  const rawLa = readCode(row, columns.oslaua);
  const problems = [];
  const missingLookupDetails = [];

  const rawCodeByLookupId = {
    buasd24: rawBuasd,
    bua24: rawBua,
    parish: rawParish,
    osward: rawWard,
    oslaua: rawLa,
  };
  const ruleIds = AREA_RULES_BY_COUNTRY[country] || AREA_RULES_BY_COUNTRY.default;
  const sourceRules = ruleIds.map((id) => ({
    id,
    code: rawCodeByLookupId[id] || "",
    source: AREA_SOURCE_LABELS[id] || `${id}_name`,
  }));

  for (const rule of sourceRules) {
    if (looksPseudoCode(rule.code)) {
      continue;
    }
    const lookupInfo = lookupById.get(rule.id);
    if (!lookupInfo || lookupInfo.note !== "ok") {
      missingLookupDetails.push(`${rule.id}_lookup_unavailable`);
      continue;
    }
    const resolved = lookupName(lookupInfo, rule.code);
    if (resolved) {
      return {
        area_name: resolved,
        area_source: rule.source,
        area_code: rule.code,
        area_problems: problems,
        area_lookup_failures: missingLookupDetails,
      };
    }
    problems.push(`${rule.id}_code_not_in_lookup`);
  }

  return {
    area_name: null,
    area_source: null,
    area_code: null,
    area_problems: problems,
    area_lookup_failures: missingLookupDetails,
  };
}

function detectExplicitPostTownColumn(headers) {
  const normalized = headers.map(normalizeHeaderName);
  const candidates = normalized
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value.includes("posttown") || value.includes("post_town") || value === "posttown");
  if (candidates.length === 0) {
    return { index: -1, name: null };
  }
  const best = candidates[0];
  return { index: best.index, name: headers[best.index] };
}

function resolvePostTown({ row, columns, lookupById, hasExplicitPostTownField }) {
  const rawPostTown = readField(row, columns.post_town);
  const rawTtwa = readCode(row, columns.ttwa);
  const rawBua = readCode(row, columns.bua24);
  const rawLa = readCode(row, columns.oslaua);
  const rawCounty = readCode(row, columns.oscty);
  const problems = [];

  if (rawPostTown) {
    return {
      post_town: rawPostTown,
      post_town_source: "post_town_field",
      post_town_code: rawPostTown,
      post_town_problems: problems,
      raw_post_town_candidate: rawPostTown,
    };
  }

  if (!hasExplicitPostTownField) {
    problems.push("no_post_town_field_found");
  }

  if (!looksPseudoCode(rawTtwa)) {
    const ttwaLookup = lookupById.get("ttwa");
    const ttwaName = ttwaLookup && ttwaLookup.note === "ok" ? lookupName(ttwaLookup, rawTtwa) : null;
    if (ttwaName) {
      return {
        post_town: ttwaName,
        post_town_source: "ttwa_fallback",
        post_town_code: rawTtwa,
        post_town_problems: problems,
        raw_post_town_candidate: rawPostTown,
      };
    }
    problems.push("ttwa_code_not_in_lookup");
  }

  if (!looksPseudoCode(rawBua)) {
    const buaLookup = lookupById.get("bua24");
    const buaName = buaLookup && buaLookup.note === "ok" ? lookupName(buaLookup, rawBua) : null;
    if (buaName) {
      return {
        post_town: buaName,
        post_town_source: "bua24_fallback",
        post_town_code: rawBua,
        post_town_problems: problems,
        raw_post_town_candidate: rawPostTown,
      };
    }
    problems.push("bua24_code_not_in_lookup");
  }

  if (!looksPseudoCode(rawLa)) {
    const laLookup = lookupById.get("oslaua");
    const laName = laLookup && laLookup.note === "ok" ? lookupName(laLookup, rawLa) : null;
    if (laName) {
      return {
        post_town: laName,
        post_town_source: "oslaua_fallback",
        post_town_code: rawLa,
        post_town_problems: problems,
        raw_post_town_candidate: rawPostTown,
      };
    }
    problems.push("oslaua_code_not_in_lookup");
  }

  if (!looksPseudoCode(rawCounty)) {
    const countyLookup = lookupById.get("oscty");
    const countyName = countyLookup && countyLookup.note === "ok" ? lookupName(countyLookup, rawCounty) : null;
    if (countyName) {
      return {
        post_town: countyName,
        post_town_source: "oscty_fallback",
        post_town_code: rawCounty,
        post_town_problems: problems,
        raw_post_town_candidate: rawPostTown,
      };
    }
    problems.push("oscty_code_not_in_lookup");
  }

  return {
    post_town: null,
    post_town_source: null,
    post_town_code: null,
    post_town_problems: problems,
    raw_post_town_candidate: rawPostTown,
  };
}

function incrementCount(counter, key) {
  const label = key || "(null)";
  counter.set(label, (counter.get(label) || 0) + 1);
}

function addPrefixSample(sampleMap, prefix, row) {
  if (!sampleMap.get(prefix)) {
    sampleMap.set(prefix, row);
  }
}

function markdownTable(rows, headers) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [head, sep, body].filter(Boolean).join("\n");
}

export async function inspectOnspdAreaPostTown({
  onspdCsvPath,
  onspdRoot,
  outAllPath,
  outUnmatchedPath,
  outSummaryPath,
}) {
  const docsDir = path.join(onspdRoot, "Documents");
  const lookupCandidates = await listLookupCandidates(docsDir);
  const lookupInfos = [];
  for (const spec of LOOKUP_SPECS) {
    // eslint-disable-next-line no-await-in-loop
    const loaded = await loadLookupMap(spec, lookupCandidates);
    lookupInfos.push(loaded);
  }
  const lookupById = new Map(lookupInfos.map((info) => [info.id, info]));

  await ensureDirForFile(outAllPath);
  await ensureDirForFile(outUnmatchedPath);
  await ensureDirForFile(outSummaryPath);

  const allOut = fs.createWriteStream(outAllPath, { encoding: "utf8" });
  const unmatchedOut = fs.createWriteStream(outUnmatchedPath, { encoding: "utf8" });
  allOut.write(
    [
      "postcode",
      "postcode_normalised",
      "ctry_code",
      "ttwa_code",
      "ttwa_name",
      "area_name",
      "area_source",
      "area_code",
      "post_town",
      "post_town_source",
      "post_town_code",
      "pcon_code",
      "la_code",
    ].join(",") + "\n",
  );
  unmatchedOut.write(
    [
      "postcode",
      "postcode_normalised",
      "ctry_code",
      "problem",
      "raw_bua24",
      "raw_buasd24",
      "raw_ttwa",
      "raw_parish",
      "raw_osward",
      "raw_oslaua",
      "raw_post_town_candidate",
      "area_name",
      "area_source",
      "area_code",
      "post_town",
      "post_town_source",
      "post_town_code",
    ].join(",") + "\n",
  );

  const stream = fs.createReadStream(onspdCsvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  let headers = [];
  let columns = null;
  let totalRows = 0;
  let areaMatched = 0;
  let postTownMatched = 0;
  let unmatchedCount = 0;
  const ctryCounts = new Map();
  const areaSourceCounts = new Map();
  const postTownSourceCounts = new Map();
  const prefixExamples = new Map(PREFIX_SAMPLES.map((prefix) => [prefix, null]));
  const missingExamples = [];
  const noPostTownFieldReasons = new Set();

  for await (const rawLine of rl) {
    lineNo += 1;
    const line = lineNo === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    if (lineNo === 1) {
      headers = parseCsvLine(line).map(clean);
      columns = {
        postcode: chooseColumn(headers, ["pcds", "pcd2", "postcode", "pcd", "pcd7", "pcd8"]),
        postcode_alt: chooseColumn(headers, ["pcd2", "pcd"]),
        ctry: chooseColumn(headers, ["ctry"]),
        bua24: chooseColumn(headers, ["bua24"]),
        buasd24: chooseColumn(headers, ["buasd24"]),
        ttwa: chooseColumn(headers, ["ttwa"]),
        parish: chooseColumn(headers, ["parish"]),
        osward: chooseColumn(headers, ["osward"]),
        oslaua: chooseColumn(headers, ["oslaua", "lad", "ladcd", "lad23cd", "lad24cd"]),
        oscty: chooseColumn(headers, ["oscty"]),
        pcon: chooseColumn(headers, ["pcon", "pconcd", "pcon24cd"]),
        post_town: detectExplicitPostTownColumn(headers),
      };
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    totalRows += 1;
    const row = parseCsvLine(line);
    const postcodeRaw = readField(row, columns.postcode) || readField(row, columns.postcode_alt);
    const postcode = postcodeRaw;
    const postcodeNormalised = normalisePostcode(postcodeRaw);
    const outward = postcodeNormalised.length > 3
      ? postcodeNormalised.slice(0, -3)
      : postcodeNormalised;
    const ctryCode = readCode(row, columns.ctry);
    const pconCode = readCode(row, columns.pcon);
    const laCode = readCode(row, columns.oslaua);
    const rawBua = readCode(row, columns.bua24);
    const rawBuasd = readCode(row, columns.buasd24);
    const rawTtwa = readCode(row, columns.ttwa);
    const rawParish = readCode(row, columns.parish);
    const rawWard = readCode(row, columns.osward);
    const rawLa = readCode(row, columns.oslaua);

    incrementCount(ctryCounts, ctryCode || "(blank)");

    const areaResult = resolveAreaName({ row, columns, lookupById });
    const postTownResult = resolvePostTown({
      row,
      columns,
      lookupById,
      hasExplicitPostTownField: columns.post_town.index >= 0,
    });

    if (areaResult.area_name) {
      areaMatched += 1;
    }
    if (postTownResult.post_town) {
      postTownMatched += 1;
    }

    incrementCount(areaSourceCounts, areaResult.area_source || "(null)");
    incrementCount(postTownSourceCounts, postTownResult.post_town_source || "(null)");

    allOut.write(
      [
        postcode,
        postcodeNormalised,
        ctryCode,
        rawTtwa,
        lookupName(lookupById.get("ttwa"), rawTtwa) || "",
        areaResult.area_name || "",
        areaResult.area_source || "",
        areaResult.area_code || "",
        postTownResult.post_town || "",
        postTownResult.post_town_source || "",
        postTownResult.post_town_code || "",
        pconCode,
        laCode,
      ].map(csvEscape).join(",") + "\n",
    );

    const areaProblems = [...areaResult.area_problems, ...areaResult.area_lookup_failures];
    const postTownProblems = [...postTownResult.post_town_problems];
    const problems = [];
    if (!areaResult.area_name) {
      problems.push("missing_area_name");
    }
    if (!postTownResult.post_town) {
      problems.push("missing_post_town");
    }
    for (const item of [...areaProblems, ...postTownProblems]) {
      if (!problems.includes(item)) {
        problems.push(item);
      }
    }

    const hasLookupFailure = problems.some((problem) =>
      problem.endsWith("_code_not_in_lookup")
      || problem.endsWith("_lookup_unavailable")
    );
    const isProblemRow = !areaResult.area_name || !postTownResult.post_town || hasLookupFailure;

    if (problems.includes("no_post_town_field_found")) {
      noPostTownFieldReasons.add("no_post_town_field_found");
    }

    if (isProblemRow) {
      unmatchedCount += 1;
      unmatchedOut.write(
        [
          postcode,
          postcodeNormalised,
          ctryCode,
          problems.join(";"),
          rawBua,
          rawBuasd,
          rawTtwa,
          rawParish,
          rawWard,
          rawLa,
          postTownResult.raw_post_town_candidate || "",
          areaResult.area_name || "",
          areaResult.area_source || "",
          areaResult.area_code || "",
          postTownResult.post_town || "",
          postTownResult.post_town_source || "",
          postTownResult.post_town_code || "",
        ].map(csvEscape).join(",") + "\n",
      );
      if (missingExamples.length < 20) {
        missingExamples.push({
          postcode,
          ctryCode,
          problem: problems.join(";"),
          rawBua,
          rawTtwa,
          rawParish,
          rawWard,
          rawLa,
          area_name: areaResult.area_name || "",
          post_town: postTownResult.post_town || "",
        });
      }
    }

    for (const prefix of PREFIX_SAMPLES) {
      if (prefixExamples.get(prefix)) {
        continue;
      }
      if (outward.startsWith(prefix)) {
        addPrefixSample(prefixExamples, prefix, {
          postcode,
          postcodeNormalised,
          ctryCode,
          area_name: areaResult.area_name || "",
          area_source: areaResult.area_source || "",
          post_town: postTownResult.post_town || "",
          post_town_source: postTownResult.post_town_source || "",
          rawBua,
          rawTtwa,
          rawParish,
          rawWard,
          rawLa,
        });
      }
    }
  }

  allOut.end();
  unmatchedOut.end();
  await Promise.all([
    new Promise((resolve) => allOut.on("finish", resolve)),
    new Promise((resolve) => unmatchedOut.on("finish", resolve)),
  ]);

  const areaMatchPct = totalRows > 0 ? (areaMatched * 100 / totalRows) : 0;
  const postTownMatchPct = totalRows > 0 ? (postTownMatched * 100 / totalRows) : 0;
  const prefixRows = PREFIX_SAMPLES.map((prefix) => {
    const sample = prefixExamples.get(prefix);
    if (!sample) {
      return [prefix, "(not found)", "", "", "", "", "", "", "", ""];
    }
    return [
      prefix,
      sample.postcode,
      sample.ctryCode,
      sample.area_name || "(missing)",
      sample.area_source || "(null)",
      sample.post_town || "(missing)",
      sample.post_town_source || "(null)",
      sample.rawTtwa || "",
      sample.rawBua || "",
      sample.rawWard || "",
    ];
  });

  const detectedNameLikeColumns = headers.filter((header) => {
    const normalized = normalizeHeaderName(header);
    return normalized.includes("town")
      || normalized.includes("post")
      || normalized.endsWith("nm")
      || normalized.includes("name");
  });

  const candidateAreaColumns = headers.filter((header) => {
    const normalized = normalizeHeaderName(header);
    return normalized === "pcd"
      || normalized === "pcds"
      || normalized === "pcd2"
      || normalized === "ctry"
      || normalized === "bua24"
      || normalized === "buasd24"
      || normalized === "parish"
      || normalized === "osward"
      || normalized === "oslaua"
      || normalized === "ced"
      || normalized === "pcon"
      || normalized.includes("town")
      || normalized.includes("post")
      || normalized.includes("nm")
      || normalized.includes("name");
  });

  const summaryLines = [];
  summaryLines.push("# ONSPD May 2025 Postcode Area/Post Town Inspection");
  summaryLines.push("");
  summaryLines.push(`Input CSV: \`${onspdCsvPath}\``);
  summaryLines.push(`ONSPD root: \`${onspdRoot}\``);
  summaryLines.push("");
  summaryLines.push("## Header Inspection");
  summaryLines.push("");
  summaryLines.push(`- Total column count: **${headers.length}**`);
  summaryLines.push(`- Likely postcode column: **${columns.postcode.name || "(not found)"}**`);
  summaryLines.push(`- Likely country column: **${columns.ctry.name || "(not found)"}**`);
  summaryLines.push(`- Likely post town column: **${columns.post_town.name || "(not found)"}**`);
  summaryLines.push(
    `- Likely area/subarea code columns: \`${[
      columns.buasd24.name || "buasd24:(not found)",
      columns.bua24.name || "bua24:(not found)",
      columns.parish.name || "parish:(not found)",
      columns.osward.name || "osward:(not found)",
      columns.oslaua.name || "oslaua:(not found)",
      columns.ttwa.name || "ttwa:(not found)",
      columns.ced?.name || "ced:(not tracked)",
      columns.pcon.name || "pcon:(not found)",
    ].join("`, `")}\``,
  );
  summaryLines.push("");
  summaryLines.push("### All columns");
  summaryLines.push("");
  for (const header of headers) {
    summaryLines.push(`- \`${header}\``);
  }
  summaryLines.push("");
  summaryLines.push("### Name/town/post-like columns");
  summaryLines.push("");
  if (detectedNameLikeColumns.length === 0) {
    summaryLines.push("- (none)");
  } else {
    for (const header of detectedNameLikeColumns) {
      summaryLines.push(`- \`${header}\``);
    }
  }
  summaryLines.push("");
  summaryLines.push("### Candidate columns requested");
  summaryLines.push("");
  for (const header of candidateAreaColumns) {
    summaryLines.push(`- \`${header}\``);
  }
  summaryLines.push("");
  summaryLines.push("## Lookup Files Detected");
  summaryLines.push("");
  const lookupRows = lookupInfos.map((info) => [
    info.id,
    info.found ? "yes" : "no",
    info.file_path ? `\`${info.file_path}\`` : "(not found)",
    info.code_column || "(not detected)",
    info.name_column || "(not detected)",
    info.mapped_count.toLocaleString(),
    info.note,
  ]);
  summaryLines.push(
    markdownTable(lookupRows, [
      "lookup",
      "found",
      "file",
      "code column",
      "name column",
      "mapped values",
      "note",
    ]),
  );
  summaryLines.push("");
  summaryLines.push("## Rules Used");
  summaryLines.push("");
  summaryLines.push("### area_name resolution by country");
  summaryLines.push("");
  summaryLines.push("- England (`E92000001`): `buasd24` -> `bua24` -> `parish` -> `osward` -> `oslaua`");
  summaryLines.push("- Wales (`W92000004`): `buasd24` -> `bua24` -> `parish` -> `osward` -> `oslaua`");
  summaryLines.push("- Scotland (`S92000003`): `osward` -> `oslaua`");
  summaryLines.push("- Northern Ireland (`N92000002`): `osward` -> `oslaua`");
  summaryLines.push("- Pseudo/missing codes ignored (empty/null and `*99999999`).");
  summaryLines.push("");
  summaryLines.push("### post_town resolution");
  summaryLines.push("");
  summaryLines.push("- Explicit post-town field if present in ONSPD header.");
  summaryLines.push("- Else fallback: `ttwa` name -> `bua24` name -> `oslaua` name -> `oscty` name -> null.");
  summaryLines.push("- If no explicit post-town field exists, source is tagged as fallback and problems may include `no_post_town_field_found`.");
  summaryLines.push("");
  summaryLines.push("## Processing Summary");
  summaryLines.push("");
  summaryLines.push(`- Total postcode rows processed: **${totalRows.toLocaleString()}**`);
  summaryLines.push(`- Matched area_name rows: **${areaMatched.toLocaleString()}** (${areaMatchPct.toFixed(2)}%)`);
  summaryLines.push(`- Matched post_town rows: **${postTownMatched.toLocaleString()}** (${postTownMatchPct.toFixed(2)}%)`);
  summaryLines.push(`- Unmatched/problem rows: **${unmatchedCount.toLocaleString()}**`);
  summaryLines.push("");
  summaryLines.push("### Counts by ctry_code");
  summaryLines.push("");
  summaryLines.push(
    markdownTable(
      Array.from(ctryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, v.toLocaleString()]),
      ["ctry_code", "rows"],
    ),
  );
  summaryLines.push("");
  summaryLines.push("### Counts by area_source");
  summaryLines.push("");
  summaryLines.push(
    markdownTable(
      Array.from(areaSourceCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, v.toLocaleString()]),
      ["area_source", "rows"],
    ),
  );
  summaryLines.push("");
  summaryLines.push("### Counts by post_town_source");
  summaryLines.push("");
  summaryLines.push(
    markdownTable(
      Array.from(postTownSourceCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, v.toLocaleString()]),
      ["post_town_source", "rows"],
    ),
  );
  summaryLines.push("");
  summaryLines.push("## Prefix Examples");
  summaryLines.push("");
  summaryLines.push(
    markdownTable(
      prefixRows,
      [
        "prefix",
        "postcode",
        "ctry_code",
        "area_name",
        "area_source",
        "post_town",
        "post_town_source",
        "raw_ttwa",
        "raw_bua24",
        "raw_osward",
      ],
    ),
  );
  summaryLines.push("");
  summaryLines.push("## Missing Examples");
  summaryLines.push("");
  if (missingExamples.length === 0) {
    summaryLines.push("- No missing/problem rows.");
  } else {
    summaryLines.push(
      markdownTable(
        missingExamples.slice(0, 20).map((item) => [
          item.postcode,
          item.ctryCode,
          item.problem,
          item.rawTtwa,
          item.rawBua,
          item.rawParish,
          item.rawWard,
          item.rawLa,
          item.area_name || "(missing)",
          item.post_town || "(missing)",
        ]),
        [
          "postcode",
          "ctry_code",
          "problem",
          "raw_ttwa",
          "raw_bua24",
          "raw_parish",
          "raw_osward",
          "raw_oslaua",
          "area_name",
          "post_town",
        ],
      ),
    );
  }
  summaryLines.push("");
  summaryLines.push("## Caveats");
  summaryLines.push("");
  summaryLines.push("- ONSPD main CSV is code-heavy; area/post-town labels are inferred from separate lookup files.");
  summaryLines.push("- No explicit post-town column was detected in this ONSPD header.");
  summaryLines.push("- `BUASD24` was not present in the CSV header and no BUASD lookup file was detected in the provided folder.");
  summaryLines.push("- Pseudo codes such as `E99999999`, `W99999999`, `S99999999`, `N99999999` were ignored.");
  if (noPostTownFieldReasons.size > 0) {
    summaryLines.push("- `no_post_town_field_found` occurred where fallback logic was required.");
  }
  summaryLines.push("");

  await fs.promises.writeFile(outSummaryPath, `${summaryLines.join("\n")}\n`, "utf8");

  return {
    totalRows,
    areaMatched,
    postTownMatched,
    unmatchedCount,
    areaMatchPct,
    postTownMatchPct,
    columns,
    lookupInfos,
    outputs: {
      all: outAllPath,
      unmatched: outUnmatchedPath,
      summary: outSummaryPath,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const onspdCsvPath = path.resolve(args.input);
  const onspdRoot = path.resolve(args.onspd_root);
  const outAllPath = path.resolve(args.out_all);
  const outUnmatchedPath = path.resolve(args.out_unmatched);
  const outSummaryPath = path.resolve(args.out_summary);

  const result = await inspectOnspdAreaPostTown({
    onspdCsvPath,
    onspdRoot,
    outAllPath,
    outUnmatchedPath,
    outSummaryPath,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        input_csv: onspdCsvPath,
        onspd_root: onspdRoot,
        total_rows: result.totalRows,
        area_matched: result.areaMatched,
        area_match_percent: Number(result.areaMatchPct.toFixed(2)),
        post_town_matched: result.postTownMatched,
        post_town_match_percent: Number(result.postTownMatchPct.toFixed(2)),
        unmatched_rows: result.unmatchedCount,
        outputs: result.outputs,
        detected_columns: {
          postcode: result.columns.postcode.name,
          ctry: result.columns.ctry.name,
          post_town: result.columns.post_town.name,
          buasd24: result.columns.buasd24.name,
          bua24: result.columns.bua24.name,
          ttwa: result.columns.ttwa.name,
          parish: result.columns.parish.name,
          osward: result.columns.osward.name,
          oslaua: result.columns.oslaua.name,
          pcon: result.columns.pcon.name,
        },
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
    console.error(`inspect_onspd_area_post_town failed: ${message}`);
    process.exit(1);
  });
}
