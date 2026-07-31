import assert from "node:assert/strict";
import test from "node:test";

import {
  createStagedObjectMap,
  readChildren,
  stageProtectedConnectorPreservationDependencies,
} from "../uk_aq_execute_v2_observations_repair.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  buildHistoryV2PollutantManifest,
} from "../../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  computeObservationContentHash,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";

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
    const { canonical_rows: _canonicalRows, ...observationContentHash } =
      computeObservationContentHash([{
        connector_id: connectorId,
        station_id: 1,
        timeseries_id: 1,
        pollutant_code: pollutantCode,
        observed_at_utc: "2026-05-17T00:00:00.000Z",
        value: 1,
        verification_status: null,
      }]);
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
      observationContentHash,
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

function preservationManifest({ dayUtc, connectorId, pollutantCode }) {
  const manifestKey = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
  const { canonical_rows: _rows, ...observationContentHash } = computeObservationContentHash([{
    connector_id: connectorId,
    station_id: connectorId,
    timeseries_id: connectorId * 100,
    pollutant_code: pollutantCode,
    observed_at_utc: `${dayUtc}T00:00:00.000Z`,
    value: 1,
    verification_status: null,
  }]);
  return buildHistoryV2PollutantManifest({
    domain: "observations",
    dayUtc,
    connectorId,
    pollutantCode,
    manifestKey,
    sourceRowCount: 1,
    fileEntries: [{
      key: manifestKey.replace("manifest.json", "part-00001.parquet"),
      bytes: 1,
      row_count: 1,
      min_timeseries_id: connectorId * 100,
      max_timeseries_id: connectorId * 100,
      min_observed_at_utc: `${dayUtc}T00:00:00.000Z`,
      max_observed_at_utc: `${dayUtc}T00:00:00.000Z`,
      timeseries_row_counts: { [String(connectorId * 100)]: 1 },
    }],
    writerGitSha: "test",
    backedUpAtUtc: `${dayUtc}T23:00:00.000Z`,
    observationContentHash,
  });
}

function preservationFixture({ missingConnectorId }) {
  const dayUtc = "2026-07-12";
  const connectorIds = missingConnectorId === 1 ? [1] : [1, 7];
  const objects = new Map();
  const connectors = connectorIds.map((connectorId) => {
    const pm25 = preservationManifest({ dayUtc, connectorId, pollutantCode: "pm25" });
    const children = [pm25];
    objects.set(pm25.manifest_key, pm25);
    if (connectorId === missingConnectorId) {
      children.push(preservationManifest({ dayUtc, connectorId, pollutantCode: "humidity" }));
    }
    const manifestKey = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
    const connector = buildHistoryV2ConnectorManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      manifestKey,
      pollutantManifests: children,
      writerGitSha: "test",
      backedUpAtUtc: `${dayUtc}T23:00:00.000Z`,
    });
    objects.set(manifestKey, connector);
    return connector;
  });
  const base = `history/v2/observations/day_utc=${dayUtc}`;
  const day = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc,
    manifestKey: `${base}/manifest.json`,
    connectorManifests: connectors,
    writerGitSha: "test",
    backedUpAtUtc: `${dayUtc}T23:00:00.000Z`,
  });
  objects.set(day.manifest_key, day);
  const store = {
    listAllObjects: ({ prefix }) => [...objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, source: "dropbox", content_sha256: "a".repeat(64) })),
    getObjectIfExists: (key) => {
      const payload = objects.get(key);
      if (!payload) return null;
      const body = Buffer.from(JSON.stringify(payload));
      return { key, body, bytes: body.byteLength, source: "dropbox", content_sha256: "a".repeat(64) };
    },
  };
  return { dayUtc, base, objects, staged: createStagedObjectMap({ r2: {}, store }) };
}

test("dedicated preservation quarantines an unprotected missing child but blocks a protected equivalent", async () => {
  const unprotected = preservationFixture({ missingConnectorId: 7 });
  const audit = {
    healthy_unprotected_children_preserved: 0,
    unprotected_pollutant_omission_count: 0,
    unprotected_connector_omission_count: 0,
    unprotected_day_omission_count: 0,
    unprotected_omissions: [],
  };
  const proposalKeys = [];
  await stageProtectedConnectorPreservationDependencies({
    staged: unprotected.staged,
    base: unprotected.base,
    dayUtc: unprotected.dayUtc,
    proposalKeys,
    protectedConnectorIds: [1],
    selectedMutationConnectorIds: [1],
    latestIndexKey: "history/_index_v2/observations_timeseries_latest.json",
    audit,
  });
  const connector7Key = `${unprotected.base}/connector_id=7/manifest.json`;
  const rebuilt = JSON.parse(unprotected.staged.proposals.get(connector7Key).body);
  assert.deepEqual(rebuilt.pollutant_codes, ["pm25"]);
  assert.equal(rebuilt.pollutant_manifests.some((item) => item.pollutant_code === "humidity"), false);
  assert.equal(audit.healthy_unprotected_children_preserved, 1);
  assert.equal(audit.unprotected_pollutant_omission_count, 1);
  assert.deepEqual(audit.unprotected_omissions.map((item) => ({
    connector_id: item.connector_id,
    pollutant_code: item.pollutant_code,
    child_deleted: item.child_deleted,
    child_overwritten: item.child_overwritten,
    child_tombstoned: item.child_tombstoned,
  })), [{
    connector_id: 7,
    pollutant_code: "humidity",
    child_deleted: false,
    child_overwritten: false,
    child_tombstoned: false,
  }]);
  assert.deepEqual(proposalKeys, [connector7Key]);

  const protectedFixture = preservationFixture({ missingConnectorId: 1 });
  await assert.rejects(stageProtectedConnectorPreservationDependencies({
    staged: protectedFixture.staged,
    base: protectedFixture.base,
    dayUtc: protectedFixture.dayUtc,
    proposalKeys: [],
    protectedConnectorIds: [1],
    selectedMutationConnectorIds: [1],
    latestIndexKey: "history/_index_v2/observations_timeseries_latest.json",
    audit: { healthy_unprotected_children_preserved: 0, unprotected_omissions: [] },
  }), /protected pollutant manifest unreadable/);
});
