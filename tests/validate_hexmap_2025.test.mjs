import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractHexFeatures,
  collectPostcodeLaCodes,
  parseOnsCsv,
  runValidation,
} from "../scripts/postcodes/validate_hexmap_2025.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uk-aq-hexmap-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function writeJson(filePath, payload) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function makeHexMap(extraFeatures = []) {
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { la_code: "E09000033", la_name: "Westminster", cua_code: "E09000033", cua_name: "Westminster", region_nation: "London" }, geometry: null },
      { type: "Feature", properties: { la_code: "E08000038", la_name: "Barnsley", cua_code: "E08000038", cua_name: "Barnsley", region_nation: "Yorkshire and The Humber" }, geometry: null },
      { type: "Feature", properties: { la_code: "E08000039", la_name: "Sheffield", cua_code: "E08000039", cua_name: "Sheffield", region_nation: "Yorkshire and The Humber" }, geometry: null },
      ...extraFeatures,
    ],
  };
}

function makePostcodeDir(tempDir, laCodes) {
  const postcodeDir = path.join(tempDir, "postcode");
  const shardsDir = path.join(postcodeDir, "shards");

  const postcodes = {};
  laCodes.forEach((code, i) => {
    const pc = `SW1A${i + 1}AA`;
    // [lat, lon, pcon_code, la_code, area_town_id]
    postcodes[pc] = [51.5, -0.1, "E14001530", code, 1];
  });

  return { postcodeDir, shardsDir, postcodes };
}

async function writePostcodeLookup(tempDir, laCodes) {
  const { postcodeDir, shardsDir, postcodes } = makePostcodeDir(tempDir, laCodes);
  await fs.promises.mkdir(shardsDir, { recursive: true });
  await writeJson(path.join(postcodeDir, "manifest.json"), {
    schema_version: 2,
    exact_shards: {
      SW: { postcode_count: laCodes.length, object_key: "v1/shards/SW.json", relative_path: "shards/SW.json" },
    },
  });
  await writeJson(path.join(shardsDir, "SW.json"), { schema_version: 2, postcodes });
  return postcodeDir;
}

// ---------------------------------------------------------------------------
// extractHexFeatures
// ---------------------------------------------------------------------------

test("extractHexFeatures: parses FeatureCollection", () => {
  const hex = makeHexMap();
  const features = extractHexFeatures(hex);
  assert.equal(features.length, 3);
  const sheffield = features.find((f) => f.la_code === "E08000039");
  assert.ok(sheffield, "Sheffield E08000039 must be present");
  assert.equal(sheffield.la_name, "Sheffield");
  const barnsley = features.find((f) => f.la_code === "E08000038");
  assert.ok(barnsley, "Barnsley E08000038 must be present");
  assert.equal(barnsley.la_name, "Barnsley");
});

test("extractHexFeatures: parses HexJSON format", () => {
  const hexjson = {
    layout: "odd-r",
    hexes: {
      E08000039: { n: "Sheffield", la_code: "E08000039" },
      E08000038: { n: "Barnsley", la_code: "E08000038" },
    },
  };
  const features = extractHexFeatures(hexjson);
  assert.equal(features.length, 2);
  const sheffield = features.find((f) => f.la_code === "E08000039");
  assert.ok(sheffield);
});

test("extractHexFeatures: throws on unrecognised format", () => {
  assert.throws(() => extractHexFeatures({ not: "a hex map" }), /not a recognised/);
});

// ---------------------------------------------------------------------------
// collectPostcodeLaCodes
// ---------------------------------------------------------------------------

test("collectPostcodeLaCodes: extracts LA codes from shard files", async () => {
  await withTempDir(async (tempDir) => {
    const postcodeDir = await writePostcodeLookup(tempDir, ["E08000039", "E08000038", "E09000033"]);
    const result = await collectPostcodeLaCodes(postcodeDir);
    assert.ok(result.la_codes.has("E08000039"), "Sheffield must be in postcode LA codes");
    assert.ok(result.la_codes.has("E08000038"), "Barnsley must be in postcode LA codes");
    assert.ok(result.la_codes.has("E09000033"), "Westminster must be in postcode LA codes");
  });
});

test("collectPostcodeLaCodes: throws when manifest is missing", async () => {
  await withTempDir(async (tempDir) => {
    await assert.rejects(
      () => collectPostcodeLaCodes(path.join(tempDir, "nonexistent")),
      /manifest not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseOnsCsv
// ---------------------------------------------------------------------------

test("parseOnsCsv: parses LAD25CD column", () => {
  const csv = [
    "LAD25CD,LAD25NM",
    "E08000039,Sheffield",
    "E08000038,Barnsley",
  ].join("\n");
  const { codes, name_by_code } = parseOnsCsv(csv);
  assert.ok(codes.has("E08000039"));
  assert.ok(codes.has("E08000038"));
  assert.equal(name_by_code.get("E08000039"), "Sheffield");
});

test("parseOnsCsv: throws when no code column found", () => {
  const csv = "NOCODE,NAME\nfoo,bar\n";
  assert.throws(() => parseOnsCsv(csv), /Could not find a LAD code column/);
});

// ---------------------------------------------------------------------------
// runValidation — happy path
// ---------------------------------------------------------------------------

test("runValidation: passes for fully compatible 2025 hex map and postcode lookup", async () => {
  await withTempDir(async (tempDir) => {
    const hexPath = path.join(tempDir, "hex.json");
    await writeJson(hexPath, makeHexMap());
    const postcodeDir = await writePostcodeLookup(tempDir, ["E09000033", "E08000039", "E08000038"]);

    const result = await runValidation({ hexMapPath: hexPath, postcodeDir, onsLad25Path: null });
    assert.equal(result.ok, true, `Expected ok but got failures: ${result.failures.join("; ")}`);
    assert.equal(result.failures.length, 0);
    const sheffieldMigration = result.summary.migration_checks.find((m) => m.name === "Sheffield");
    assert.equal(sheffieldMigration.present, true);
    assert.equal(sheffieldMigration.old_absent, true);
    const barnsleyMigration = result.summary.migration_checks.find((m) => m.name === "Barnsley");
    assert.equal(barnsleyMigration.present, true);
    assert.equal(barnsleyMigration.old_absent, true);
  });
});

// ---------------------------------------------------------------------------
// runValidation — Sheffield / Barnsley code checks
// ---------------------------------------------------------------------------

test("runValidation: fails when Sheffield 2025 code E08000039 is absent from hex map", async () => {
  await withTempDir(async (tempDir) => {
    const hexPath = path.join(tempDir, "hex.json");
    // Use the old 2023 Sheffield code — no 2025 code
    await writeJson(hexPath, {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { la_code: "E08000019", la_name: "Sheffield", cua_code: "E08000019", cua_name: "Sheffield", region_nation: "Yorkshire and The Humber" }, geometry: null },
        { type: "Feature", properties: { la_code: "E08000038", la_name: "Barnsley", cua_code: "E08000038", cua_name: "Barnsley", region_nation: "Yorkshire and The Humber" }, geometry: null },
      ],
    });
    const postcodeDir = await writePostcodeLookup(tempDir, ["E08000039"]);

    const result = await runValidation({ hexMapPath: hexPath, postcodeDir, onsLad25Path: null });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes("E08000039") && f.includes("Sheffield")),
      `Expected failure about E08000039/Sheffield, got: ${result.failures.join("; ")}`,
    );
    assert.ok(
      result.failures.some((f) => f.includes("E08000019") && f.includes("Sheffield")),
      `Expected failure about retired E08000019 still present, got: ${result.failures.join("; ")}`,
    );
  });
});

test("runValidation: fails when Barnsley 2025 code E08000038 is absent from hex map", async () => {
  await withTempDir(async (tempDir) => {
    const hexPath = path.join(tempDir, "hex.json");
    await writeJson(hexPath, {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { la_code: "E08000016", la_name: "Barnsley", cua_code: "E08000016", cua_name: "Barnsley", region_nation: "Yorkshire and The Humber" }, geometry: null },
        { type: "Feature", properties: { la_code: "E08000039", la_name: "Sheffield", cua_code: "E08000039", cua_name: "Sheffield", region_nation: "Yorkshire and The Humber" }, geometry: null },
      ],
    });
    const postcodeDir = await writePostcodeLookup(tempDir, ["E08000038"]);

    const result = await runValidation({ hexMapPath: hexPath, postcodeDir, onsLad25Path: null });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("E08000038") && f.includes("Barnsley")));
    assert.ok(result.failures.some((f) => f.includes("E08000016") && f.includes("Barnsley")));
  });
});

// ---------------------------------------------------------------------------
// runValidation — postcode LA code not in hex map
// ---------------------------------------------------------------------------

test("runValidation: fails when postcode LA code is absent from hex map", async () => {
  await withTempDir(async (tempDir) => {
    const hexPath = path.join(tempDir, "hex.json");
    await writeJson(hexPath, makeHexMap());
    // Postcode lookup has an extra code not in the hex map
    const postcodeDir = await writePostcodeLookup(tempDir, ["E08000039", "E99999999"]);

    const result = await runValidation({ hexMapPath: hexPath, postcodeDir, onsLad25Path: null });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes("E99999999")),
      `Expected failure about E99999999, got: ${result.failures.join("; ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// runValidation — duplicate LA codes
// ---------------------------------------------------------------------------

test("runValidation: fails on duplicate hex LA codes", async () => {
  await withTempDir(async (tempDir) => {
    const hexPath = path.join(tempDir, "hex.json");
    await writeJson(hexPath, {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { la_code: "E08000039", la_name: "Sheffield", cua_code: "E08000039", cua_name: "Sheffield", region_nation: "Yorkshire and The Humber" }, geometry: null },
        { type: "Feature", properties: { la_code: "E08000039", la_name: "Sheffield duplicate", cua_code: "E08000039", cua_name: "Sheffield", region_nation: "Yorkshire and The Humber" }, geometry: null },
        { type: "Feature", properties: { la_code: "E08000038", la_name: "Barnsley", cua_code: "E08000038", cua_name: "Barnsley", region_nation: "Yorkshire and The Humber" }, geometry: null },
      ],
    });
    const postcodeDir = await writePostcodeLookup(tempDir, ["E08000039", "E08000038"]);

    const result = await runValidation({ hexMapPath: hexPath, postcodeDir, onsLad25Path: null });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => /duplicate/i.test(f) && f.includes("E08000039")));
  });
});

// ---------------------------------------------------------------------------
// runValidation — hex map file missing
// ---------------------------------------------------------------------------

test("runValidation: fails immediately when hex map file does not exist", async () => {
  await withTempDir(async (tempDir) => {
    const result = await runValidation({
      hexMapPath: path.join(tempDir, "nonexistent.json"),
      postcodeDir: tempDir,
      onsLad25Path: null,
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => /not found/i.test(f)));
  });
});

// ---------------------------------------------------------------------------
// runValidation — ONS CSV validation
// ---------------------------------------------------------------------------

test("runValidation: validates against ONS LAD25 CSV when provided", async () => {
  await withTempDir(async (tempDir) => {
    const hexPath = path.join(tempDir, "hex.json");
    await writeJson(hexPath, makeHexMap());
    const postcodeDir = await writePostcodeLookup(tempDir, ["E09000033", "E08000039", "E08000038"]);

    const onsCsvPath = path.join(tempDir, "lad25.csv");
    await fs.promises.writeFile(
      onsCsvPath,
      ["LAD25CD,LAD25NM", "E09000033,Westminster", "E08000039,Sheffield", "E08000038,Barnsley"].join("\n"),
      "utf8",
    );

    const result = await runValidation({ hexMapPath: hexPath, postcodeDir, onsLad25Path: onsCsvPath });
    assert.equal(result.ok, true, `Expected ok, got: ${result.failures.join("; ")}`);
    assert.equal(result.summary.ons_validated, true);
  });
});

test("runValidation: fails ONS check when postcode LA code not in official ONS list", async () => {
  await withTempDir(async (tempDir) => {
    const hexPath = path.join(tempDir, "hex.json");
    // Add UNOFFICIAL code to hex map
    await writeJson(hexPath, makeHexMap([
      { type: "Feature", properties: { la_code: "Z99999999", la_name: "Fake LA", cua_code: "Z99999999", cua_name: "Fake LA", region_nation: "Test" }, geometry: null },
    ]));
    const postcodeDir = await writePostcodeLookup(tempDir, ["E09000033", "E08000039", "E08000038", "Z99999999"]);

    const onsCsvPath = path.join(tempDir, "lad25.csv");
    await fs.promises.writeFile(
      onsCsvPath,
      ["LAD25CD,LAD25NM", "E09000033,Westminster", "E08000039,Sheffield", "E08000038,Barnsley"].join("\n"),
      "utf8",
    );

    const result = await runValidation({ hexMapPath: hexPath, postcodeDir, onsLad25Path: onsCsvPath });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("Z99999999")));
  });
});

// ---------------------------------------------------------------------------
// Live file checks (run against actual repo data when files are present)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(new URL(import.meta.url).pathname, "..", "..", "..");
const LIVE_HEX_2025 = path.join(REPO_ROOT, "uk-aq", "data", "LAD", "uk_aq_la_hex_2025.geojson");
const LIVE_HEX_2023 = path.join(REPO_ROOT, "uk-aq", "data", "LAD", "uk_aq_la_hex_2023.json");
const LIVE_POSTCODE_DIR = path.join(REPO_ROOT, "uk-aq-ops", "tmp", "postcode_lookup_v1");

test("live: uk_aq_la_hex_2025.geojson contains E08000039 (Sheffield) and E08000038 (Barnsley)", { skip: !fs.existsSync(LIVE_HEX_2025) }, async () => {
  const data = JSON.parse(await fs.promises.readFile(LIVE_HEX_2025, "utf8"));
  const features = extractHexFeatures(data);
  const codes = new Set(features.map((f) => f.la_code));
  assert.ok(codes.has("E08000039"), "Sheffield E08000039 must be present in 2025 hex map");
  assert.ok(codes.has("E08000038"), "Barnsley E08000038 must be present in 2025 hex map");
  assert.ok(!codes.has("E08000019"), "Old Sheffield code E08000019 must NOT be in 2025 hex map");
  assert.ok(!codes.has("E08000016"), "Old Barnsley code E08000016 must NOT be in 2025 hex map");

  const sheffield = features.find((f) => f.la_code === "E08000039");
  assert.ok(sheffield.la_name.toLowerCase().includes("sheffield"), "Sheffield feature name must contain 'Sheffield'");
  const barnsley = features.find((f) => f.la_code === "E08000038");
  assert.ok(barnsley.la_name.toLowerCase().includes("barnsley"), "Barnsley feature name must contain 'Barnsley'");
});

test("live: uk_aq_la_hex_2023.json still exists (backward compatibility)", { skip: !fs.existsSync(LIVE_HEX_2023) }, async () => {
  const stat = await fs.promises.stat(LIVE_HEX_2023);
  assert.ok(stat.isFile(), "2023 hex map must still be a file");
});

test("live: validate_hexmap_2025 passes against actual repo postcode lookup", { skip: !fs.existsSync(LIVE_HEX_2025) || !fs.existsSync(LIVE_POSTCODE_DIR) }, async () => {
  const result = await runValidation({
    hexMapPath: LIVE_HEX_2025,
    postcodeDir: LIVE_POSTCODE_DIR,
    onsLad25Path: null,
  });
  if (!result.ok) {
    console.error("Live validation failures:", result.failures);
  }
  assert.equal(result.ok, true, `Live validation failed:\n${result.failures.join("\n")}`);
});
