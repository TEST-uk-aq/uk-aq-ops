import test from "node:test";
import assert from "node:assert/strict";

import {
  detectPropertyKeyFromFeatures,
  extractPolygonBboxes,
  tileForPoint,
  tilesForBbox,
  tilesForGeometry,
} from "../scripts/geography/lib/geo_boundary_shard_utils.mjs";

test("tileForPoint returns expected tile key for known coordinate", () => {
  const tile = tileForPoint(51.501, -0.141, 0.05);
  assert.equal(tile.key, "iy1030_ix-3");
  assert.equal(tile.iy, 1030);
  assert.equal(tile.ix, -3);
  assert.equal(tile.lat_min, 51.5);
  assert.equal(tile.lon_min, -0.15);
});

test("tilesForBbox assigns feature to all overlapping tiles", () => {
  const tiles = tilesForBbox([-0.13, 51.52, -0.08, 51.57], 0.05);
  const keys = tiles.map((tile) => tile.key);
  assert.deepEqual(keys, [
    "iy1030_ix-3",
    "iy1030_ix-2",
    "iy1031_ix-3",
    "iy1031_ix-2",
  ]);
});

test("tilesForBbox includes neighbouring tile when bbox touches tile edge", () => {
  const tiles = tilesForBbox([-0.13, 51.52, -0.1, 51.54], 0.05);
  const keys = tiles.map((tile) => tile.key);
  assert.deepEqual(keys, [
    "iy1030_ix-3",
    "iy1030_ix-2",
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

test("extractPolygonBboxes returns one bbox per MultiPolygon part", () => {
  const geometry = {
    type: "MultiPolygon",
    coordinates: [
      [[[-0.2, 51.5], [-0.1, 51.5], [-0.1, 51.6], [-0.2, 51.6], [-0.2, 51.5]]],
      [[[0.8, 54.1], [0.9, 54.1], [0.9, 54.2], [0.8, 54.2], [0.8, 54.1]]],
    ],
  };
  const bboxes = extractPolygonBboxes(geometry);
  assert.deepEqual(bboxes, [
    [-0.2, 51.5, -0.1, 51.6],
    [0.8, 54.1, 0.9, 54.2],
  ]);
});

test("tilesForGeometry avoids huge bbox over-assignment for disjoint multipolygon parts", () => {
  const geometry = {
    type: "MultiPolygon",
    coordinates: [
      [[[-0.2, 51.5], [-0.1, 51.5], [-0.1, 51.6], [-0.2, 51.6], [-0.2, 51.5]]],
      [[[0.8, 54.1], [0.9, 54.1], [0.9, 54.2], [0.8, 54.2], [0.8, 54.1]]],
    ],
  };

  const geometryTiles = tilesForGeometry(geometry, 0.05);
  const fullBboxTiles = tilesForBbox([-0.2, 51.5, 0.9, 54.2], 0.05);

  // Per-part tiling must be smaller than full-extent bbox tiling.
  assert.ok(geometryTiles.length < fullBboxTiles.length);

  // Coverage remains intact: both parts have tile keys represented.
  const keys = new Set(geometryTiles.map((tile) => tile.key));
  assert.ok(keys.has("iy1030_ix-4"));
  assert.ok(keys.has("iy1082_ix16"));
});
