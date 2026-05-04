#!/usr/bin/env node
/**
 * validate_hexmap_2025.mjs
 *
 * Validates that the 2025 LA hex map is structurally sound and fully compatible
 * with the current postcode lookup.
 *
 * Background
 * ----------
 * The postcode lookup is built from ONSPD Feb 2026 using the `lad25cd` field
 * (LAD 2025 codes). The active hex map must therefore use LAD 2025 codes.
 * Barnsley and Sheffield changed GSS codes in the 2025 boundary revision:
 *   Barnsley: E08000016 → E08000038
 *   Sheffield: E08000019 → E08000039
 * uk_aq_la_hex_2025.geojson uses the same cartogram layout as the 2023 file but
 * with updated LA identifiers.
 *
 * Usage
 * -----
 *   node scripts/postcodes/validate_hexmap_2025.mjs [options]
 *
 * Options
 *   --hex-map <path>          2025 hex map GeoJSON (default: ../uk-aq/data/LAD/uk_aq_la_hex_2025.geojson)
 *   --postcode-dir <dir>      Postcode lookup directory (default: tmp/postcode_lookup_v1)
 *   --ons-lad25 <path>        Optional ONS LAD25 names/codes CSV for official validation
 *   -h, --help
 *
 * Exit codes
 *   0  All checks passed
 *   1  One or more checks failed
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Required 2025 code migrations (old → new)
// ---------------------------------------------------------------------------
const REQUIRED_MIGRATIONS = [
  { old: "E08000016", new: "E08000038", name: "Barnsley" },
  { old: "E08000019", "E08000039": undefined, new: "E08000039", name: "Sheffield" },
];

// Re-write as a cleaner plain array
const MIGRATION_LIST = [
  { old: "E08000016", current: "E08000038", name: "Barnsley" },
  { old: "E08000019", current: "E08000039", name: "Sheffield" },
];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

const DEFAULT_HEX_MAP = path.join(REPO_ROOT, "uk-aq", "data", "LAD", "uk_aq_la_hex_2025.geojson");
const DEFAULT_POSTCODE_DIR = path.resolve(SCRIPT_DIR, "..", "..", "tmp", "postcode_lookup_v1");

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/postcodes/validate_hexmap_2025.mjs [options]",
      "",
      "Options:",
      "  --hex-map <path>       2025 hex map GeoJSON",
      `                         (default: ${DEFAULT_HEX_MAP})`,
      "  --postcode-dir <dir>   Postcode lookup directory",
      `                         (default: ${DEFAULT_POSTCODE_DIR})`,
      "  --ons-lad25 <path>     Optional ONS LAD25 CSV for official code validation",
      "  -h, --help",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    hex_map: DEFAULT_HEX_MAP,
    postcode_dir: DEFAULT_POSTCODE_DIR,
    ons_lad25: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hex-map") { args.hex_map = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (arg === "--postcode-dir") { args.postcode_dir = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (arg === "--ons-lad25") { args.ons_lad25 = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (arg === "-h" || arg === "--help") { usage(); process.exit(0); }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

async function readJsonFile(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function sample(arr, n = 5) {
  return arr.slice(0, n);
}

// ---------------------------------------------------------------------------
// A. Hex map parsing
// ---------------------------------------------------------------------------
export function extractHexFeatures(hexData) {
  if (hexData && hexData.type === "FeatureCollection" && Array.isArray(hexData.features)) {
    return hexData.features.map((f) => ({
      la_code: normalizeCode(f && f.properties && f.properties.la_code),
      la_name: String(f && f.properties && f.properties.la_name || ""),
      cua_code: normalizeCode(f && f.properties && f.properties.cua_code),
    }));
  }
  // HexJSON format: { hexes: { <CODE>: { ... } } }
  if (hexData && hexData.hexes && typeof hexData.hexes === "object") {
    return Object.entries(hexData.hexes).map(([key, val]) => ({
      la_code: normalizeCode(
        (val && val.la_code) || (val && val.code) || key,
      ),
      la_name: String((val && val.la_name) || (val && val.n) || key),
      cua_code: normalizeCode((val && val.cua_code) || ""),
    }));
  }
  throw new Error("Hex map is not a recognised FeatureCollection or HexJSON format.");
}

// ---------------------------------------------------------------------------
// B. Postcode lookup extraction (reuses approach from check_postcode_geography_versions.mjs)
// ---------------------------------------------------------------------------
function extractPostcodeRowLaCode(rowValue) {
  if (Array.isArray(rowValue)) {
    // Schema v2 array: [lat, lon, pcon_code, la_code, area_town_id]
    return normalizeCode(rowValue[3]) || null;
  }
  if (rowValue && typeof rowValue === "object") {
    return normalizeCode(rowValue.la_code || rowValue.lad_code || rowValue.la || "") || null;
  }
  return null;
}

function listShardFiles(postcodeDir, manifest) {
  const exactShards = manifest && manifest.exact_shards && typeof manifest.exact_shards === "object"
    ? manifest.exact_shards
    : (manifest && manifest.shards && typeof manifest.shards === "object" ? manifest.shards : null);

  if (exactShards) {
    return Object.keys(exactShards)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const info = exactShards[key];
        const rel = String(info && info.relative_path ? info.relative_path : "").trim();
        return rel ? path.join(postcodeDir, rel) : path.join(postcodeDir, `${key}.json`);
      });
  }
  return [];
}

export async function collectPostcodeLaCodes(postcodeDir) {
  const manifestPath = path.join(postcodeDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Postcode lookup manifest not found: ${manifestPath}`);
  }
  const manifest = await readJsonFile(manifestPath);

  // Try hints file first (fast path: avoids reading 120+ shard files)
  const hintsPath = path.join(postcodeDir, "postcode_prefix_hints.json");
  if (fs.existsSync(hintsPath)) {
    const hints = await readJsonFile(hintsPath);
    const laCodes = new Set();
    const examplesByCode = new Map();
    const allSamples = [
      ...Object.values(hints.postcode_samples_1 || {}),
      ...Object.values(hints.postcode_samples_2 || {}),
    ].flat();
    for (const item of allSamples) {
      // item: [postcode_normalised, postcode, area_town_id, pcon_code, la_code]
      if (Array.isArray(item) && item.length >= 5) {
        const la = normalizeCode(item[4]);
        if (la) {
          laCodes.add(la);
          if (!examplesByCode.has(la)) examplesByCode.set(la, []);
          const examples = examplesByCode.get(la);
          if (examples.length < 3) examples.push(String(item[1] || item[0] || ""));
        }
      }
    }
    // Hints are a sample: fall back to full shard scan to get complete LA set
    // but only if the hints give fewer codes than expected (< 300 UK LAs)
    if (laCodes.size >= 300) {
      return { la_codes: laCodes, examples_by_code: examplesByCode, source: "hints" };
    }
  }

  // Full shard scan
  const shardFiles = listShardFiles(postcodeDir, manifest);
  if (shardFiles.length === 0) {
    // Walk the directory
    const walk = async (dir) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const results = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) results.push(...(await walk(full)));
        else if (e.isFile() && e.name.endsWith(".json") && e.name !== "manifest.json") results.push(full);
      }
      return results;
    };
    shardFiles.push(...(await walk(postcodeDir)));
  }

  const laCodes = new Set();
  const examplesByCode = new Map();

  for (const shardPath of shardFiles) {
    if (!shardPath.endsWith(".json")) continue;
    const payload = await readJsonFile(shardPath);
    const postcodes = payload && typeof payload === "object" && payload.postcodes ? payload.postcodes : null;
    if (!postcodes) continue;
    for (const [pc, row] of Object.entries(postcodes)) {
      const la = extractPostcodeRowLaCode(row);
      if (!la) continue;
      laCodes.add(la);
      if (!examplesByCode.has(la)) examplesByCode.set(la, []);
      const examples = examplesByCode.get(la);
      if (examples.length < 3) examples.push(pc);
    }
  }

  return { la_codes: laCodes, examples_by_code: examplesByCode, source: "shards" };
}

// ---------------------------------------------------------------------------
// C. ONS LAD25 CSV parsing
// ---------------------------------------------------------------------------
export function parseOnsCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) throw new Error("ONS LAD25 CSV is empty.");
  const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));

  function findCol(candidates) {
    for (const c of candidates) {
      const idx = header.findIndex((h) => h.toUpperCase() === c.toUpperCase());
      if (idx >= 0) return idx;
    }
    return -1;
  }
  const codeIdx = findCol(["LAD25CD", "LAD24CD", "LAD23CD", "LADCD", "CD"]);
  const nameIdx = findCol(["LAD25NM", "LAD24NM", "LAD23NM", "LADNM", "NM", "NAME"]);
  if (codeIdx < 0) throw new Error(`Could not find a LAD code column. Available: ${header.join(", ")}`);

  const codes = new Set();
  const nameByCode = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const code = normalizeCode(cols[codeIdx]);
    if (!code) continue;
    codes.add(code);
    if (nameIdx >= 0 && cols[nameIdx]) nameByCode.set(code, cols[nameIdx].trim());
  }
  return { codes, name_by_code: nameByCode };
}

// ---------------------------------------------------------------------------
// Main validation runner
// ---------------------------------------------------------------------------
export async function runValidation({ hexMapPath, postcodeDir, onsLad25Path }) {
  const failures = [];
  const warnings = [];
  const info = [];

  // ------------------------------------------------------------------
  // A. Hex map structure
  // ------------------------------------------------------------------
  if (!fs.existsSync(hexMapPath)) {
    failures.push(`Hex map file not found: ${hexMapPath}`);
    return { ok: false, failures, warnings, info };
  }

  let hexData;
  try {
    hexData = await readJsonFile(hexMapPath);
  } catch (err) {
    failures.push(`Hex map JSON is not parseable: ${err.message}`);
    return { ok: false, failures, warnings, info };
  }

  let hexFeatures;
  try {
    hexFeatures = extractHexFeatures(hexData);
  } catch (err) {
    failures.push(`Hex map structure error: ${err.message}`);
    return { ok: false, failures, warnings, info };
  }

  const hexCodes = new Set();
  const hexNameByCode = new Map();
  const duplicateCodes = [];
  for (const feat of hexFeatures) {
    if (!feat.la_code) continue;
    if (hexCodes.has(feat.la_code)) {
      duplicateCodes.push(feat.la_code);
    } else {
      hexCodes.add(feat.la_code);
      if (feat.la_name) hexNameByCode.set(feat.la_code, feat.la_name);
    }
  }

  info.push(`Hex map features: ${hexFeatures.length}`);
  info.push(`Hex unique LA codes: ${hexCodes.size}`);

  if (duplicateCodes.length > 0) {
    failures.push(`Duplicate LA codes in hex map: ${duplicateCodes.join(", ")}`);
  }

  // ------------------------------------------------------------------
  // B. Required 2025 code migration
  // ------------------------------------------------------------------
  for (const { old: oldCode, current, name } of MIGRATION_LIST) {
    if (!hexCodes.has(current)) {
      failures.push(`Required 2025 code ${current} (${name}) is missing from hex map.`);
    } else {
      info.push(`✓ ${name} 2025 code ${current} present`);
    }
    if (hexCodes.has(oldCode)) {
      failures.push(
        `Retired 2023 code ${oldCode} (${name}) still present in hex map as a primary feature. Expected it to be replaced by ${current}.`,
      );
    }
    const featureName = hexNameByCode.get(current);
    if (featureName && !featureName.toLowerCase().includes(name.toLowerCase())) {
      warnings.push(
        `Hex feature for ${current} has name "${featureName}" — expected it to contain "${name}". Check the migration.`,
      );
    }
  }

  // ------------------------------------------------------------------
  // C. Postcode lookup compatibility
  // ------------------------------------------------------------------
  let postcodeLaCodes;
  let examplesByCode;
  let postcodeSource;

  try {
    const result = await collectPostcodeLaCodes(postcodeDir);
    postcodeLaCodes = result.la_codes;
    examplesByCode = result.examples_by_code;
    postcodeSource = result.source;
  } catch (err) {
    failures.push(`Postcode lookup error: ${err.message}`);
    return { ok: failures.length === 0, failures, warnings, info };
  }

  info.push(`Postcode unique LA codes: ${postcodeLaCodes.size} (source: ${postcodeSource})`);

  const missingFromHex = [];
  for (const code of postcodeLaCodes) {
    if (!hexCodes.has(code)) {
      const examples = examplesByCode.get(code) || [];
      missingFromHex.push({ code, examples: sample(examples) });
    }
  }

  if (missingFromHex.length > 0) {
    for (const { code, examples } of missingFromHex) {
      const exStr = examples.length ? ` (e.g. ${examples.join(", ")})` : "";
      const hint = MIGRATION_LIST.find((m) => m.old === code);
      const hintStr = hint ? ` — this looks like the retired 2023 code; current code is ${hint.current}` : "";
      failures.push(`Postcode LA code ${code} not found in hex map${exStr}${hintStr}`);
    }
  } else {
    info.push(`✓ All postcode LA codes resolve to a hex feature`);
  }

  const hexOnlyLaCodes = [];
  for (const code of hexCodes) {
    if (!postcodeLaCodes.has(code)) {
      hexOnlyLaCodes.push(code);
    }
  }
  if (hexOnlyLaCodes.length > 0) {
    info.push(
      `Hex codes not seen in postcode lookup (${hexOnlyLaCodes.length}): ${sample(hexOnlyLaCodes, 10).join(", ")}${hexOnlyLaCodes.length > 10 ? " …" : ""}`,
    );
  }

  // ------------------------------------------------------------------
  // D. Optional ONS LAD25 validation
  // ------------------------------------------------------------------
  let onsValidated = false;
  if (onsLad25Path) {
    if (!fs.existsSync(onsLad25Path)) {
      warnings.push(`ONS LAD25 file not found: ${onsLad25Path}`);
    } else {
      let onsCodes;
      let onsNameByCode;
      try {
        const text = await fs.promises.readFile(onsLad25Path, "utf8");
        const ons = parseOnsCsv(text);
        onsCodes = ons.codes;
        onsNameByCode = ons.name_by_code;
        onsValidated = true;
        info.push(`ONS LAD25 CSV loaded: ${onsCodes.size} codes`);
      } catch (err) {
        warnings.push(`Could not parse ONS LAD25 CSV: ${err.message}`);
      }

      if (onsValidated) {
        const postcodeMissingFromOns = [];
        for (const code of postcodeLaCodes) {
          if (!onsCodes.has(code)) postcodeMissingFromOns.push(code);
        }
        if (postcodeMissingFromOns.length > 0) {
          for (const code of postcodeMissingFromOns) {
            failures.push(`Postcode LA code ${code} not found in official ONS LAD25 codes`);
          }
        } else {
          info.push(`✓ All postcode LA codes found in official ONS LAD25`);
        }

        const hexMissingFromOns = [];
        for (const code of hexCodes) {
          if (!onsCodes.has(code)) hexMissingFromOns.push(code);
        }
        if (hexMissingFromOns.length > 0) {
          for (const code of hexMissingFromOns) {
            const name = hexNameByCode.get(code) || code;
            warnings.push(`Hex LA code ${code} (${name}) not found in official ONS LAD25 codes`);
          }
        } else {
          info.push(`✓ All hex LA codes found in official ONS LAD25`);
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    info,
    summary: {
      hex_feature_count: hexFeatures.length,
      hex_unique_la_codes: hexCodes.size,
      postcode_unique_la_codes: postcodeLaCodes.size,
      ons_validated: onsValidated,
      migration_checks: MIGRATION_LIST.map((m) => ({
        name: m.name,
        old_code: m.old,
        new_code: m.current,
        present: hexCodes.has(m.current),
        old_absent: !hexCodes.has(m.old),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const hexMapPath = path.resolve(args.hex_map);
  const postcodeDir = path.resolve(args.postcode_dir);
  const onsLad25Path = args.ons_lad25 ? path.resolve(args.ons_lad25) : null;

  console.log("validate_hexmap_2025");
  console.log("  hex map:      ", hexMapPath);
  console.log("  postcode dir: ", postcodeDir);
  if (onsLad25Path) console.log("  ONS LAD25:    ", onsLad25Path);
  console.log();

  let result;
  try {
    result = await runValidation({ hexMapPath, postcodeDir, onsLad25Path });
  } catch (err) {
    console.error(`Validation error: ${err.message}`);
    process.exit(1);
  }

  for (const line of result.info) {
    console.log(line);
  }
  if (result.warnings.length > 0) {
    console.log();
    for (const w of result.warnings) {
      console.warn(`WARNING: ${w}`);
    }
  }
  if (result.failures.length > 0) {
    console.log();
    for (const f of result.failures) {
      console.error(`FAIL: ${f}`);
    }
    console.log();
    console.error(`Validation failed: ${result.failures.length} error(s)`);
    process.exit(1);
  }

  console.log();
  console.log("Validation passed.");
  if (result.summary) {
    console.log(`  ${result.summary.hex_unique_la_codes} hex LA codes, ${result.summary.postcode_unique_la_codes} postcode LA codes`);
    console.log(`  ONS validated: ${result.summary.ons_validated}`);
    for (const m of result.summary.migration_checks) {
      const status = m.present && m.old_absent ? "✓" : "✗";
      console.log(`  ${status} ${m.name}: old ${m.old_code} absent, new ${m.new_code} present`);
    }
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((err) => {
    console.error(`validate_hexmap_2025 failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
