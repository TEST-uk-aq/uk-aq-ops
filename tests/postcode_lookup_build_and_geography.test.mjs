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

test("build parser detects postcode/lat/lon/pcon/la columns from ONSPD-style header", () => {
  const columns = detectOnspdColumns([
    "pcd",
    "pcds",
    "lat",
    "long",
    "pcon",
    "oslaua",
  ]);
  assert.equal(columns.postcode.field, "pcds");
  assert.equal(columns.lat.field, "lat");
  assert.equal(columns.lon.field, "long");
  assert.equal(columns.pcon.field, "pcon");
  assert.equal(columns.la.field, "oslaua");
});

test("build output shards include pcon_code/la_code and exclude names", async () => {
  await withTempDir(async (tempDir) => {
    const inputCsvPath = path.join(tempDir, "ONSPD_MAY_2025_UK.csv");
    const outputDir = path.join(tempDir, "out");
    const csvLines = [
      "pcd,pcd2,pcds,lat,long,pcon,oslaua",
      "SW1A1AA,SW1A1AA,SW1A 1AA,51.501009,-0.141588,E14001530,E09000033",
      "EC1A1BB,EC1A1BB,EC1A 1BB,51.520200,-0.097100,,E09000001",
      "BADROW,BADROW,BADROW,not-a-lat,not-a-lon,E14000000,E09000000",
    ];
    await fs.promises.writeFile(inputCsvPath, `${csvLines.join("\n")}\n`, "utf8");

    const manifest = await buildPostcodeLookupFromOnspd({
      inputPath: inputCsvPath,
      outputDir,
      prefix: "v1",
      sourceVersion: "ONSPD_MAY_2025",
    });

    const swShard = JSON.parse(await fs.promises.readFile(path.join(outputDir, "SW.json"), "utf8"));
    const ecShard = JSON.parse(await fs.promises.readFile(path.join(outputDir, "EC.json"), "utf8"));

    assert.deepEqual(swShard.postcodes.SW1A1AA, [51.501009, -0.141588, "E14001530", "E09000033"]);
    assert.deepEqual(ecShard.postcodes.EC1A1BB, [51.5202, -0.0971, null, "E09000001"]);
    assert.equal(swShard.schema_version, 2);
    assert.equal(swShard.source_version, "ONSPD_MAY_2025");
    assert.equal("pcon_name" in swShard.postcodes, false);
    assert.equal("la_name" in swShard.postcodes, false);

    assert.equal(manifest.missing_pcon_code_count, 1);
    assert.equal(manifest.missing_la_code_count, 0);
    assert.equal(manifest.geography_codes.pcon.field, "pcon");
    assert.equal(manifest.geography_codes.la.field, "oslaua");

    const swText = await fs.promises.readFile(path.join(outputDir, "SW.json"), "utf8");
    assert.equal(swText.includes("pcon_name"), false);
    assert.equal(swText.includes("la_name"), false);
  });
});

test("geography compatibility check passes when postcode and website codes match", async () => {
  await withTempDir(async (tempDir) => {
    const postcodeDir = path.join(tempDir, "postcode");
    await fs.promises.mkdir(postcodeDir, { recursive: true });
    await writeJson(path.join(postcodeDir, "manifest.json"), {
      schema_version: 2,
      shards: {
        SW: { postcode_count: 1, object_key: "v1/SW.json" },
      },
    });
    await writeJson(path.join(postcodeDir, "SW.json"), {
      schema_version: 2,
      postcodes: {
        SW1A1AA: [51.501009, -0.141588, "E14001530", "E09000033"],
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
    await fs.promises.mkdir(postcodeDir, { recursive: true });
    await writeJson(path.join(postcodeDir, "manifest.json"), {
      schema_version: 2,
      shards: {
        SW: { postcode_count: 1, object_key: "v1/SW.json" },
      },
    });
    await writeJson(path.join(postcodeDir, "SW.json"), {
      schema_version: 2,
      postcodes: {
        SW1A1AA: [51.501009, -0.141588, "E14009999", "E09009999"],
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
