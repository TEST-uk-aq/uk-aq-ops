import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHierarchicalInventoryRoot,
  buildObservationMonthInventoryShard,
  buildObservationRunManifestInventoryShard,
  completeObservationMonthState,
  emptyHierarchicalStateRoot,
  markLatestTimeseriesProcessed,
  monthStateIsComplete,
  observationMonthInventoryShardKey,
  observationMonthStateShardKey,
  planObservationMonthCopies,
  resolveObservationsTimeseriesLatestPath,
  setStateRootProcessedHash,
  sha256Hex,
  stableJson,
  upsertStateMonthSummary,
  validateLatestTimeseriesState,
  validateObservationMonthState,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";

const h = (char) => char.repeat(64);

test("latest-timeseries backup path follows explicit v2/v3 authority", () => {
  assert.equal(
    resolveObservationsTimeseriesLatestPath("v2"),
    "history/_index_v2/observations_timeseries_latest.json",
  );
  assert.equal(
    resolveObservationsTimeseriesLatestPath("v3"),
    "history/_index_v3/observations_timeseries_latest.json",
  );
  for (const value of [undefined, "", "V1", "V2", "V3", " v2", "v3 ", "latest", "v4"]) {
    assert.throws(
      () => resolveObservationsTimeseriesLatestPath(value),
      /must be exactly v2 or v3/,
    );
  }
});

test("fresh month state plans every current inventory day", () => {
  const shard = buildObservationMonthInventoryShard({
    observationsPrefix: "history/v2/observations",
    year: "2026",
    month: "08",
    sourceMonthManifestKey:
      "history/v2/observations/_manifests/year=2026/month=08/manifest.json",
    sourceMonthHash: h("c"),
    days: [{
      day_utc: "2026-08-06",
      manifest_key: "history/v2/observations/day_utc=2026-08-06/manifest.json",
      manifest_hash: h("d"),
      manifest_file_hash: h("f"),
      manifest_size: 123,
    }],
  });

  const fresh = validateObservationMonthState(null, "2026", "08");
  assert.equal(monthStateIsComplete(fresh, shard), false);
  assert.equal(fresh.processed_source_month_hash, null);
  assert.deepEqual(
    planObservationMonthCopies(fresh, shard).map((entry) => entry.day_utc),
    ["2026-08-06"],
  );
});

test("partial state cannot advance the month hash", () => {
  const shard = buildObservationMonthInventoryShard({
    observationsPrefix: "history/v2/observations",
    year: "2026",
    month: "08",
    sourceMonthManifestKey:
      "history/v2/observations/_manifests/year=2026/month=08/manifest.json",
    sourceMonthHash: h("c"),
    days: [
      {
        day_utc: "2026-08-05",
        manifest_key: "history/v2/observations/day_utc=2026-08-05/manifest.json",
        manifest_hash: h("d"),
        manifest_file_hash: h("f"),
        manifest_size: 111,
      },
      {
        day_utc: "2026-08-06",
        manifest_key: "history/v2/observations/day_utc=2026-08-06/manifest.json",
        manifest_hash: h("e"),
        manifest_file_hash: h("a"),
        manifest_size: 112,
      },
    ],
  });

  const partial = validateObservationMonthState({
    schema_version: 1,
    kind: "uk_aq_r2_history_backup_state_observations_month",
    backup_version: "v2",
    domain: "observations",
    year: "2026",
    month: "08",
    processed_source_month_hash: null,
    days: [{
      day_utc: "2026-08-05",
      manifest_hash: h("d"),
      copied_at: "2026-08-05T20:00:00.000Z",
    }],
  }, "2026", "08");

  assert.equal(partial.processed_source_month_hash, null);
  assert.deepEqual(
    planObservationMonthCopies(partial, shard).map((entry) => entry.day_utc),
    ["2026-08-06"],
  );
  assert.throws(
    () => completeObservationMonthState(partial, shard),
    /one or more day identities are incomplete/,
  );
});

test("inventory and state shard paths are stable", () => {
  assert.equal(
    observationMonthInventoryShardKey(
      "history/_index_v2/backup_inventory_v2",
      "2026",
      "8",
    ),
    "history/_index_v2/backup_inventory_v2/observations/year=2026/month=08.json",
  );
  assert.equal(
    observationMonthStateShardKey(
      "_ops/checkpoints/r2_history_backup_state_v2",
      "2026",
      "8",
    ),
    "_ops/checkpoints/r2_history_backup_state_v2/observations/year=2026/month=08.json",
  );
});

test("root state is updated only after the month shard identity exists", () => {
  const root = emptyHierarchicalStateRoot();
  upsertStateMonthSummary(root, {
    year: "2026",
    month: "08",
    stateShardKey:
      "_ops/checkpoints/r2_history_backup_state_v2/observations/year=2026/month=08.json",
    processedSourceMonthHash: h("c"),
    stateShardHash: h("f"),
  });
  assert.equal(
    root.observations.years[0].months[0].processed_source_month_hash,
    h("c"),
  );
  setStateRootProcessedHash(root, h("a"));
  assert.equal(root.observations.processed_source_root_hash, h("a"));
});

test("latest-timeseries state advances only through verified completion", () => {
  const root = emptyHierarchicalStateRoot();
  assert.equal(
    validateLatestTimeseriesState(
      root.global_units.observations_timeseries_latest,
    ).processed_source_sha256,
    null,
  );
  markLatestTimeseriesProcessed(root, {
    relative_path: "history/_index_v2/observations_timeseries_latest.json",
    sha256: h("e"),
    byte_size: 456,
  }, "2026-08-11T12:00:00.000Z");
  assert.deepEqual(root.global_units.observations_timeseries_latest, {
    source_relative_path: "history/_index_v2/observations_timeseries_latest.json",
    processed_source_sha256: h("e"),
    byte_size: 456,
    copied_at: "2026-08-11T12:00:00.000Z",
    verified: true,
  });
});

test("v2 and v3 latest state identities cannot satisfy each other", () => {
  const root = emptyHierarchicalStateRoot();
  markLatestTimeseriesProcessed(root, {
    relative_path: resolveObservationsTimeseriesLatestPath("v2"),
    sha256: h("e"),
    byte_size: 456,
  }, "2026-08-11T12:00:00.000Z");
  const v3Unit = {
    relative_path: resolveObservationsTimeseriesLatestPath("v3"),
    sha256: h("e"),
    byte_size: 456,
  };
  assert.notEqual(
    root.global_units.observations_timeseries_latest.source_relative_path,
    v3Unit.relative_path,
  );
  markLatestTimeseriesProcessed(root, v3Unit, "2026-08-29T12:00:00.000Z");
  assert.equal(
    root.global_units.observations_timeseries_latest.source_relative_path,
    "history/_index_v3/observations_timeseries_latest.json",
  );
  const v2Unit = {
    relative_path: resolveObservationsTimeseriesLatestPath("v2"),
    sha256: h("e"),
    byte_size: 456,
  };
  assert.notEqual(
    root.global_units.observations_timeseries_latest.source_relative_path,
    v2Unit.relative_path,
  );
});

test("stable JSON is byte-stable for unchanged logical content", () => {
  const runShard = buildObservationRunManifestInventoryShard([]);
  const runShardHash = sha256Hex(stableJson(runShard));
  const rootA = buildHierarchicalInventoryRoot({
    observationsRootManifestKey:
      "history/v2/observations/_manifests/manifest.json",
    observationsRootHash: h("a"),
    years: [{
      year: "2026",
      manifest_key:
        "history/v2/observations/_manifests/year=2026/manifest.json",
      content_hash: h("b"),
      months: [{
        month: "08",
        manifest_key:
          "history/v2/observations/_manifests/year=2026/month=08/manifest.json",
        content_hash: h("c"),
        inventory_shard_key:
          "history/_index_v2/backup_inventory_v2/observations/year=2026/month=08.json",
      }],
    }],
    runManifestInventoryShardKey:
      "history/_index_v2/backup_inventory_v2/global/observation_run_manifests.json",
    runManifestInventoryShardHash: runShardHash,
    runManifestUnitCount: 0,
    latestTimeseries: {
      relative_path: "history/_index_v2/observations_timeseries_latest.json",
      sha256: h("e"),
      byte_size: 456,
    },
  });
  const rootB = JSON.parse(JSON.stringify(rootA));
  assert.equal(stableJson(rootA), stableJson(rootB));
});
