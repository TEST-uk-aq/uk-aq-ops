import test from "node:test";
import assert from "node:assert/strict";

import {
  detectPropertyKeyFromFeatures,
  tileForPoint,
  tilesForBbox,
} from "../scripts/geography/lib/geo_boundary_shard_utils.mjs";

test("tileForPoint returns expected tile key for known coordinate", () => {
  const tile = tileForPoint(51.501, -0.141, 0.05);
  assert.equal(tile.key, "51.50_-0.15");
  assert.equal(tile.lat_min, 51.5);
  assert.equal(tile.lon_min, -0.15);
});

test("tilesForBbox assigns feature to all overlapping tiles", () => {
  const tiles = tilesForBbox([-0.13, 51.52, -0.08, 51.57], 0.05);
  const keys = tiles.map((tile) => tile.key);
  assert.deepEqual(keys, [
    "51.50_-0.15",
    "51.50_-0.10",
    "51.55_-0.15",
    "51.55_-0.10",
  ]);
});

test("tilesForBbox includes neighbouring tile when bbox touches tile edge", () => {
  const tiles = tilesForBbox([-0.13, 51.52, -0.1, 51.54], 0.05);
  const keys = tiles.map((tile) => tile.key);
  assert.deepEqual(keys, [
    "51.50_-0.15",
    "51.50_-0.10",
  ]);
});

test("detectPropertyKeyFromFeatures detects PCON and LA candidate keys", () => {
  const pconFeatures = [
    {
      properties: {
        PCON24CD: "E14000001",
        PCON24NM: "Example constituency",
      },
    },
  ];
  const laFeatures = [
    {
      properties: {
        lad24cd: "E09000001",
        lad24nm: "Example borough",
      },
    },
  ];

  const pconCode = detectPropertyKeyFromFeatures(pconFeatures, ["PCON24CD", "code"], "pcon code");
  const pconName = detectPropertyKeyFromFeatures(pconFeatures, ["PCON24NM", "name"], "pcon name");
  const laCode = detectPropertyKeyFromFeatures(laFeatures, ["LAD24CD", "code"], "la code");
  const laName = detectPropertyKeyFromFeatures(laFeatures, ["LAD24NM", "name"], "la name");

  assert.equal(pconCode, "PCON24CD");
  assert.equal(pconName, "PCON24NM");
  assert.equal(laCode, "lad24cd");
  assert.equal(laName, "lad24nm");
});
