import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPostcodeLookupFromOnspd,
  detectOnspdColumns,
} from "../scripts/postcodes/build_postcode_lookup_from_onspd.mjs";
import { runGeographyCompatibilityCheck } from "../scripts/postcodes/check_postcode_geography_versions.mjs";

async function withTempDir(fn) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uk-aq-postcode-test-"));
  try {
    return await fn(tempDir);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeJson(filePath, payload) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeText(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf8");
}

test("build parser detects postcode/lat/lon/pcon/la columns from ONSPD-style header", () => {
  const columns = detectOnspdColumns([
    "pcd",
    "pcds",
    "lat",
    "long",
    "doterm",
    "pcon",
    "oslaua",
    "ctry",
    "bua24",
    "osward",
    "ttwa",
  ]);
  assert.equal(columns.postcode.field, "pcds");
  assert.equal(columns.lat.field, "lat");
  assert.equal(columns.lon.field, "long");
  assert.equal(columns.doterm.field, "doterm");
  assert.equal(columns.pcon.field, "pcon");
  assert.equal(columns.la.field, "oslaua");
  assert.equal(columns.ctry.field, "ctry");
  assert.equal(columns.bua24.field, "bua24");
  assert.equal(columns.osward.field, "osward");
  assert.equal(columns.ttwa.field, "ttwa");
});

test("build output includes exact/suggest shards plus area_town index with deduped combos", async () => {
  await withTempDir(async (tempDir) => {
    const onspdRoot = path.join(tempDir, "ONSPD_MAY_2025");
    const docsDir = path.join(onspdRoot, "Documents");
    const dataDir = path.join(onspdRoot, "Data");
    const inputCsvPath = path.join(dataDir, "ONSPD_MAY_2025_UK.csv");
    const outputDir = path.join(tempDir, "out");

    await writeText(path.join(docsDir, "BUA24 names and codes EW as at 04_24.csv"), [
      "BUA24CD,BUA24NM",
      "E63000001,Westminster",
      "E63000002,Islington",
    ].join("\n") + "\n");

    await writeText(path.join(docsDir, "Parish_NCP names and codes EW as at 12_21.csv"), [
      "PARNCP21CD,PARNCP21NM",
      "E04000001,Parish A",
      "E04000002,Parish B",
    ].join("\n") + "\n");

    await writeText(path.join(docsDir, "Ward names and codes UK as at 12_24.csv"), [
      "WD24CD,WD24NM",
      "E05000001,Ward A",
      "E05000002,Ward B",
    ].join("\n") + "\n");

    await writeText(path.join(docsDir, "LA_UA names and codes UK as at 04_23.csv"), [
      "LAD23CD,LAD23NM",
      "E09000033,Westminster",
      "E09000001,City of London",
    ].join("\n") + "\n");

    await writeText(path.join(docsDir, "TTWA names and codes UK as at 12_11 v5.csv"), [
      "TTWA11CD,TTWA11NM",
      "E30000001,London",
      "E30000002,London",
    ].join("\n") + "\n");

    const csvLines = [
      "pcd,pcd2,pcds,lat,long,doterm,pcon,oslaua,ctry,bua24,parish,osward,ttwa",
      "SW1A1AA,SW1A1AA,SW1A 1AA,51.501009,-0.141588,,E14001530,E09000033,E92000001,E63000001,E04000001,E05000001,E30000001",
      "SW1A1AB,SW1A1AB,SW1A 1AB,51.501100,-0.141700,,E14001530,E09000033,E92000001,E63000001,E04000001,E05000001,E30000001",
      "EC1A1BB,EC1A1BB,EC1A 1BB,51.520200,-0.097100,,,E09000001,E92000001,E63000002,E04000002,E05000002,E30000002",
      "SW1A1ZZ,SW1A1ZZ,SW1A 1ZZ,51.500000,-0.120000,202402,E14001530,E09000033,E92000001,E63000001,E04000001,E05000001,E30000001",
      "BADROW,BADROW,BADROW,not-a-lat,not-a-lon,,E14000000,E09000000,E92000001,E63000001,E04000001,E05000001,E30000001",
    ];
    await writeText(inputCsvPath, `${csvLines.join("\n")}\n`);

    const manifest = await buildPostcodeLookupFromOnspd({
      inputPath: inputCsvPath,
      outputDir,
      prefix: "v1",
      sourceVersion: "ONSPD_MAY_2025",
      onspdRoot,
    });

    const swExact = JSON.parse(await fs.promises.readFile(path.join(outputDir, "shards", "SW.json"), "utf8"));
    const ecExact = JSON.parse(await fs.promises.readFile(path.join(outputDir, "shards", "EC.json"), "utf8"));
    const swSuggest = JSON.parse(await fs.promises.readFile(path.join(outputDir, "suggest", "SW.json"), "utf8"));
    const areaTownIndex = JSON.parse(await fs.promises.readFile(path.join(outputDir, "area_town_index.json"), "utf8"));
    const prefixHints = JSON.parse(await fs.promises.readFile(path.join(outputDir, "postcode_prefix_hints.json"), "utf8"));

    assert.equal(swExact.schema_version, 2);
    assert.deepEqual(swExact.columns, ["lat", "lon", "pcon_code", "la_code", "area_town_id"]);
    assert.equal(swSuggest.schema_version, 1);
    assert.deepEqual(swSuggest.columns, ["n", "p", "at", "pc", "la"]);

    const swRowA = swExact.postcodes.SW1A1AA;
    const swRowB = swExact.postcodes.SW1A1AB;
    const ecRow = ecExact.postcodes.EC1A1BB;

    assert.equal(Array.isArray(swRowA), true);
    assert.equal(swRowA.length, 5);
    assert.equal(swRowA[0], 51.501009);
    assert.equal(swRowA[1], -0.141588);
    assert.equal(swRowA[2], "E14001530");
    assert.equal(swRowA[3], "E09000033");
    assert.equal(typeof swRowA[4], "number");

    assert.equal(swRowB[4], swRowA[4]);
    assert.notEqual(ecRow[4], swRowA[4]);

    const swSuggestRow = swSuggest.rows.find((row) => row[0] === "SW1A1AA");
    assert.deepEqual(swSuggestRow, ["SW1A1AA", "SW1A 1AA", swRowA[4], "E14001530", "E09000033"]);

    assert.equal(areaTownIndex.values[String(swRowA[4])][0], "Parish A");
    assert.equal(areaTownIndex.values[String(swRowA[4])][1], "London");

    assert.equal(swExact.postcodes.SW1A1ZZ, undefined);
    assert.equal(Array.isArray(prefixHints.postcode_samples_1.S), true);
    assert.equal(Array.isArray(prefixHints.postcode_samples_2.SW), true);
    assert.equal(prefixHints.postcode_samples_2.SW[0][0], "SW1A1AA");
    assert.equal(prefixHints.postcode_samples_2.SW[0][1], "SW1A 1AA");
    assert.equal(typeof prefixHints.postcode_samples_2.SW[0][2], "number");
    assert.equal(prefixHints.postcode_samples_2.SW[0][3], "E14001530");
    assert.equal(prefixHints.postcode_samples_2.SW[0][4], "E09000033");
    assert.equal("prefixes_1" in prefixHints, false);
    assert.equal("prefixes_2" in prefixHints, false);

    assert.equal(manifest.unique_area_town_combo_count, 2);
    assert.equal(manifest.exact_shard_count, 2);
    assert.equal(manifest.suggest_shard_count, 2);
    assert.equal(manifest.missing_area_name_count, 0);
    assert.equal(manifest.missing_post_town_count, 0);
    assert.equal(manifest.terminated_postcode_skipped_count, 1);

    const swText = await fs.promises.readFile(path.join(outputDir, "shards", "SW.json"), "utf8");
    const suggestText = await fs.promises.readFile(path.join(outputDir, "suggest", "SW.json"), "utf8");
    assert.equal(swText.includes("area_name"), false);
    assert.equal(swText.includes("post_town"), false);
    assert.equal(suggestText.includes("lat"), false);
    assert.equal(suggestText.includes("E14001530"), true);
    assert.equal(suggestText.includes("E09000033"), true);
  });
});

test("geography compatibility check passes when postcode and website codes match", async () => {
  await withTempDir(async (tempDir) => {
    const postcodeDir = path.join(tempDir, "postcode");
    await fs.promises.mkdir(path.join(postcodeDir, "shards"), { recursive: true });
    await writeJson(path.join(postcodeDir, "manifest.json"), {
      schema_version: 2,
      exact_shards: {
        SW: { postcode_count: 1, object_key: "v1/shards/SW.json", relative_path: "shards/SW.json" },
      },
    });
    await writeJson(path.join(postcodeDir, "shards", "SW.json"), {
      schema_version: 2,
      postcodes: {
        SW1A1AA: [51.501009, -0.141588, "E14001530", "E09000033", 1],
      },
    });

    const pconPath = path.join(tempDir, "pcon.hexjson");
    const laPath = path.join(tempDir, "la.geojson");
    await writeJson(pconPath, {
      layout: "odd-r",
      hexes: {
        E14001530: { n: "Test constituency" },
      },
    });
    await writeJson(laPath, {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            la_code: "E09000033",
            la_name: "Westminster",
          },
          geometry: null,
        },
      ],
    });

    const report = await runGeographyCompatibilityCheck({
      postcodeDir,
      pconGeoPath: pconPath,
      laGeoPath: laPath,
    });
    assert.equal(report.ok, true);
    assert.equal(report.comparisons.pcon_missing_from_website_count, 0);
    assert.equal(report.comparisons.la_missing_from_website_count, 0);
  });
});

test("geography compatibility check fails when postcode codes are missing from website geography", async () => {
  await withTempDir(async (tempDir) => {
    const postcodeDir = path.join(tempDir, "postcode");
    await fs.promises.mkdir(path.join(postcodeDir, "shards"), { recursive: true });
    await writeJson(path.join(postcodeDir, "manifest.json"), {
      schema_version: 2,
      exact_shards: {
        SW: { postcode_count: 1, object_key: "v1/shards/SW.json", relative_path: "shards/SW.json" },
      },
    });
    await writeJson(path.join(postcodeDir, "shards", "SW.json"), {
      schema_version: 2,
      postcodes: {
        SW1A1AA: [51.501009, -0.141588, "E14009999", "E09009999", 1],
      },
    });

    const pconPath = path.join(tempDir, "pcon.hexjson");
    const laPath = path.join(tempDir, "la.geojson");
    await writeJson(pconPath, {
      layout: "odd-r",
      hexes: {
        E14001530: { n: "Known constituency" },
      },
    });
    await writeJson(laPath, {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            la_code: "E09000033",
          },
          geometry: null,
        },
      ],
    });

    const report = await runGeographyCompatibilityCheck({
      postcodeDir,
      pconGeoPath: pconPath,
      laGeoPath: laPath,
    });
    assert.equal(report.ok, false);
    assert.equal(report.comparisons.pcon_missing_from_website_count, 1);
    assert.equal(report.comparisons.la_missing_from_website_count, 1);
  });
});
