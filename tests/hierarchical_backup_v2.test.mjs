import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHierarchicalInventoryRoot,
  buildObservationMonthInventoryShard,
  buildObservationRunManifestInventoryShard,
  completeObservationMonthState,
  emptyHierarchicalStateRoot,
  migrateLegacyMonthState,
  monthStateIsComplete,
  observationMonthInventoryShardKey,
  observationMonthStateShardKey,
  planObservationMonthCopies,
  setStateRootProcessedHash,
  sha256Hex,
  stableJson,
  upsertStateMonthSummary,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";

const h = (char) => char.repeat(64);

test("month shard and state migration adopt matching legacy day hashes", () => {
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

  const migrated = migrateLegacyMonthState({
    inventoryShard: shard,
    legacyState: {
      domains: {
        observations: {
          days: {
            "2026-08-06": {
              manifest_hash: h("f"),
              copied_at: "2026-08-06T20:00:00.000Z",
            },
          },
        },
      },
    },
  });

  assert.equal(monthStateIsComplete(migrated, shard), true);
  assert.equal(migrated.processed_source_month_hash, h("c"));
  assert.deepEqual(planObservationMonthCopies(migrated, shard), []);
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

  const migrated = migrateLegacyMonthState({
    inventoryShard: shard,
    legacyState: {
      domains: {
        observations: {
          days: {
            "2026-08-05": { manifest_hash: h("f") },
          },
        },
      },
    },
  });

  assert.equal(migrated.processed_source_month_hash, null);
  assert.deepEqual(
    planObservationMonthCopies(migrated, shard).map((entry) => entry.day_utc),
    ["2026-08-06"],
  );
  assert.throws(
    () => completeObservationMonthState(migrated, shard),
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
  const root = emptyHierarchicalStateRoot(
    "_ops/checkpoints/r2_history_backup_state_v2.json",
  );
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
    legacyInventoryKey: "history/_index_v2/backup_inventory_v2.json",
  });
  const rootB = JSON.parse(JSON.stringify(rootA));
  assert.equal(stableJson(rootA), stableJson(rootB));
});
