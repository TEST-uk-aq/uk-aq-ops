import assert from "node:assert/strict";
import test from "node:test";

import {
  createStagedObjectMap,
  readChildren,
} from "../uk_aq_execute_v2_observations_repair.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2PollutantManifest,
} from "../../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

test("connector child discovery retains a valid unchanged O3 manifest", async () => {
  const prefix = "history/v2/observations/day_utc=2026-05-17/connector_id=1/pollutant_code=";
  const keys = [
    `${prefix}no2/manifest.json`,
    `${prefix}o3/manifest.json`,
    `${prefix}pm10/manifest.json`,
    `${prefix}pm25/manifest.json`,
  ];
  const dayUtc = "2026-05-17";
  const connectorId = 1;
  const manifests = new Map(keys.map((key) => {
    const pollutantCode = key.match(/pollutant_code=([^/]+)/)?.[1];
    const partKey = key.replace("manifest.json", "part-00001.parquet");
    const payload = buildHistoryV2PollutantManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      pollutantCode,
      manifestKey: key,
      sourceRowCount: 1,
      fileEntries: [{
        key: partKey,
        bytes: 1,
        row_count: 1,
        min_timeseries_id: 1,
        max_timeseries_id: 1,
        min_observed_at_utc: "2026-05-17T00:00:00.000Z",
        max_observed_at_utc: "2026-05-17T00:00:00.000Z",
        timeseries_row_counts: { "1": 1 },
      }],
      writerGitSha: "test",
      backedUpAtUtc: "2026-05-18T00:00:00.000Z",
    });
    return [key, payload];
  }));
  const store = {
    listAllObjects: ({ prefix: requestedPrefix }) => keys
      .filter((key) => key.startsWith(requestedPrefix))
      .map((key) => ({ key, bytes: 1, source: "dropbox", content_sha256: "a".repeat(64) })),
    getObjectIfExists: (key) => {
      const payload = manifests.get(key);
      return payload
        ? { key, body: Buffer.from(JSON.stringify(payload)), source: "dropbox" }
        : null;
    },
  };
  const { stagedR2 } = createStagedObjectMap({
    r2: {},
    store,
    dropboxSourceKeys: [`${prefix}o3/manifest.json`],
  });
  const children = await stagedR2.adapter.listAllObjects({ prefix });

  assert.deepEqual(children.map((entry) => entry.key), keys);

  const discovered = await readChildren({
    store: stagedR2.adapter,
    prefix,
    dayUtc,
    connectorId,
    kind: "pollutant",
  });
  assert.deepEqual(discovered.children.map((payload) => payload.pollutant_code), ["no2", "o3", "pm10", "pm25"]);

  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc,
    connectorId,
    manifestKey: "history/v2/observations/day_utc=2026-05-17/connector_id=1/manifest.json",
    pollutantManifests: discovered.children,
    writerGitSha: "test",
    backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  assert.deepEqual(connector.pollutant_codes, ["no2", "o3", "pm10", "pm25"]);
  assert.deepEqual(connector.pollutant_manifests.map((child) => child.pollutant_code), ["no2", "o3", "pm10", "pm25"]);
});
