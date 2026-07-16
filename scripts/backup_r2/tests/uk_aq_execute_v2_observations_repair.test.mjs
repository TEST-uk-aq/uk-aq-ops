import assert from "node:assert/strict";
import test from "node:test";

import { createStagedObjectMap } from "../uk_aq_execute_v2_observations_repair.mjs";

test("connector child discovery retains a valid unchanged O3 manifest", async () => {
  const prefix = "history/v2/observations/day_utc=2026-05-17/connector_id=1/pollutant_code=";
  const keys = [
    `${prefix}no2/manifest.json`,
    `${prefix}o3/manifest.json`,
    `${prefix}pm10/manifest.json`,
    `${prefix}pm25/manifest.json`,
  ];
  const store = {
    listAllObjects: ({ prefix: requestedPrefix }) => keys
      .filter((key) => key.startsWith(requestedPrefix))
      .map((key) => ({ key, bytes: 1, source: "dropbox", content_sha256: "a".repeat(64) })),
    getObjectIfExists: () => null,
  };
  const { stagedR2 } = createStagedObjectMap({ r2: {}, store });
  const children = await stagedR2.adapter.listAllObjects({ prefix });

  assert.deepEqual(children.map((entry) => entry.key), keys);
});
