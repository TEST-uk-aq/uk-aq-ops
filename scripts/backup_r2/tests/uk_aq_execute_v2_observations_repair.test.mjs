import assert from "node:assert/strict";
import test from "node:test";

import {
  createStagedObjectMap,
  localDependencySnapshot,
  proposalGraphAudit,
  proposalView,
  readChildren,
} from "../uk_aq_execute_v2_observations_repair.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2PollutantManifest,
} from "../../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  computeObservationContentHash,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";

function localStore(objects) {
  return {
    getObjectIfExists: (key) => objects.get(key) || null,
    listAllObjects: ({ prefix }) => [...objects.values()]
      .filter((object) => object.key.startsWith(prefix))
      .map((object) => ({
        key: object.key,
        size: object.bytes,
        source: object.source,
        content_sha256: object.content_sha256,
        r2_etag: null,
      })),
  };
}

function localObject(key, body, source = "dropbox") {
  const buffer = Buffer.from(body);
  return {
    key,
    body: buffer,
    bytes: buffer.byteLength,
    source,
    content_sha256: sha256Hex(buffer),
  };
}

test("mixed changed and unchanged index proposals retain exact staged and baseline provenance", async () => {
  const prefix = "history/_index_v2/observations_timeseries/";
  const changedKey = `${prefix}day_utc=2026-07-07/connector_id=1/pollutant_code=pm25/manifest.json`;
  const unchangedKey = `${prefix}day_utc=2026-07-07/connector_id=1/pollutant_code=123c6h3ch33/manifest.json`;
  const latestKey = "history/_index_v2/observations_timeseries_latest.json";
  const changedBaseline = localObject(changedKey, JSON.stringify({ version: "old" }));
  const unchangedBaseline = localObject(unchangedKey, JSON.stringify({ version: "same" }));
  const latestBaseline = localObject(latestKey, JSON.stringify({ version: "old-latest" }));
  const store = localStore(new Map([
    [changedKey, changedBaseline],
    [unchangedKey, unchangedBaseline],
    [latestKey, latestBaseline],
  ]));
  const staged = createStagedObjectMap({ r2: {}, store });
  const changed = await staged.stage({
    key: changedKey,
    body: JSON.stringify({ version: "new" }),
    kind: "pollutant_timeseries_index",
  });
  const unchanged = await staged.stage({
    key: unchangedKey,
    body: unchangedBaseline.body,
    kind: "pollutant_timeseries_index",
  });
  const latest = await staged.stage({
    key: latestKey,
    body: JSON.stringify({ version: "new-latest" }),
    kind: "latest_timeseries_index",
    dependencies: [changedKey, unchangedKey],
  });

  assert.equal(changed.changed, true);
  assert.equal(unchanged.changed, false);
  assert.equal(latest.changed, true);
  assert.deepEqual(latest.dependency_identities[changedKey], {
    source: "planned_overlay",
    sha256: changed.new_sha256,
    bytes: changed.bytes,
  });
  assert.deepEqual(latest.dependency_identities[unchangedKey], {
    source: "dropbox",
    sha256: unchangedBaseline.content_sha256,
    bytes: unchangedBaseline.bytes,
  });

  const changedGet = await staged.stagedR2.adapter.getObject({ key: changedKey });
  const unchangedGet = await staged.stagedR2.adapter.getObject({ key: unchangedKey });
  assert.equal(changedGet.source, "planned_overlay");
  assert.equal(changedGet.content_sha256, changed.new_sha256);
  assert.equal(unchangedGet.source, "dropbox");
  assert.equal(unchangedGet.content_sha256, unchangedBaseline.content_sha256);
  assert.equal(unchangedGet.bytes, unchangedBaseline.bytes);

  const changedHead = await staged.stagedR2.adapter.headObject({ key: changedKey });
  const unchangedHead = await staged.stagedR2.adapter.headObject({ key: unchangedKey });
  assert.equal(changedHead.source, "planned_overlay");
  assert.equal(changedHead.content_sha256, changed.new_sha256);
  assert.equal(unchangedHead.source, "dropbox");
  assert.equal(unchangedHead.content_sha256, unchangedBaseline.content_sha256);
  assert.equal(unchangedHead.bytes, unchangedBaseline.bytes);

  const listing = await staged.stagedR2.adapter.listAllObjects({ prefix });
  assert.equal(new Set(listing.map((entry) => entry.key)).size, listing.length);
  assert.equal(listing.find((entry) => entry.key === changedKey).source, "planned_overlay");
  assert.equal(listing.find((entry) => entry.key === changedKey).content_sha256, changed.new_sha256);
  assert.equal(listing.find((entry) => entry.key === unchangedKey).source, "dropbox");
  assert.equal(listing.find((entry) => entry.key === unchangedKey).content_sha256,
    unchangedBaseline.content_sha256);

  const snapshot = localDependencySnapshot({
    child: {
      children: [{ manifest_key: changedKey }, { manifest_key: unchangedKey }],
      identities: new Map([
        [changedKey, {
          content_sha256: changedGet.content_sha256,
          bytes: changedGet.bytes,
          source: changedGet.source,
        }],
        [unchangedKey, {
          content_sha256: unchangedGet.content_sha256,
          bytes: unchangedGet.bytes,
          source: unchangedGet.source,
        }],
      ]),
    },
    proposals: staged.proposals,
    prefix,
    dayUtc: "2026-07-07",
    connectorId: 1,
    kind: "index",
  });
  assert.deepEqual(snapshot.expected_children, [
    {
      key: unchangedKey,
      content_sha256: unchangedBaseline.content_sha256,
      bytes: unchangedBaseline.bytes,
      source: "dropbox",
      staged: false,
    },
    {
      key: changedKey,
      content_sha256: changed.new_sha256,
      bytes: changed.bytes,
      source: "planned_overlay",
      staged: true,
    },
  ]);

  const writeSet = [...staged.proposals.values()]
    .filter((proposal) => proposal.changed === true)
    .map((proposal) => proposal.key)
    .sort();
  assert.deepEqual(writeSet, [changedKey, latestKey].sort());
  assert.deepEqual(
    [proposalView(changed), proposalView(unchanged), proposalView(latest)]
      .map(({ key, status, included_in_write_set: included }) => ({ key, status, included })),
    [
      { key: changedKey, status: "planned", included: true },
      { key: unchangedKey, status: "skipped_unchanged", included: false },
      { key: latestKey, status: "planned", included: true },
    ],
  );
  assert.deepEqual(proposalGraphAudit(staged.proposals), {
    changed_proposal_count: 2,
    skipped_unchanged_proposal_count: 1,
    changed_dependency_count: 1,
    unchanged_baseline_dependency_count: 1,
    mutation_write_count: 2,
    planning_post_put_verification_count: 0,
    expected_post_put_verification_count: 2,
    dependency_count_semantics: "proposal_dependency_edges",
  });

  const overlayKey = `${prefix}day_utc=2026-07-07/connector_id=1/pollutant_code=o3/manifest.json`;
  const overlayBaseline = localObject(overlayKey, JSON.stringify({ version: "overlay-same" }), "overlay");
  const overlayStaged = createStagedObjectMap({
    r2: {},
    store: localStore(new Map([[overlayKey, overlayBaseline]])),
  });
  await overlayStaged.stage({
    key: overlayKey,
    body: overlayBaseline.body,
    kind: "pollutant_timeseries_index",
  });
  assert.deepEqual(overlayStaged.resolveDependencyIdentities([overlayKey])[overlayKey], {
    source: "overlay",
    sha256: overlayBaseline.content_sha256,
    bytes: overlayBaseline.bytes,
  });
});

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
