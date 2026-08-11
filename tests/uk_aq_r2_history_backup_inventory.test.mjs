import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildCoreInventoryShard,
  syncCoreToDropbox,
  validateCoreInventoryShard,
  validateCoreState,
} from "../scripts/backup_r2/lib/hierarchical_core_backup_v2.mjs";
import {
  sha256Hex,
  stableJson,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  buildStaleParquetPrunePlan,
} from "../scripts/backup_r2/lib/stale_parquet_prune.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const h = (char) => char.repeat(64);

function runHelp(relativePath) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, relativePath), "--help"],
    { encoding: "utf8" },
  );
}

test("production backup entrypoints load under their established filenames", () => {
  const builder = runHelp("scripts/backup_r2/build_backup_inventory.mjs");
  assert.equal(builder.status, 0, builder.stderr);
  assert.match(builder.stdout, /build_backup_inventory\.mjs/);
  assert.match(builder.stdout, /--core-prefix/);
  assert.match(builder.stdout, /--timeseries-binding-prefix/);
  assert.match(builder.stdout, /--latest-timeseries-key/);
  assert.doesNotMatch(builder.stdout, /--legacy-inventory-key/);

  const sync = runHelp("scripts/backup_r2/sync_history_to_dropbox.mjs");
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /sync_history_to_dropbox\.mjs/);
  assert.match(sync.stdout, /--force-prune-recheck/);
  assert.match(sync.stdout, /--state-root-prefix/);
  assert.doesNotMatch(sync.stdout, /--legacy-state-key/);
});

test("core inventory identity is deterministic and non-range based", () => {
  const shardA = buildCoreInventoryShard("history/v2/core", [
    {
      day_utc: "2026-08-07",
      manifest_hash: h("a"),
      manifest_size: 123,
      r2_md5: "md5-a",
      r2_modtime: "2026-08-07T10:00:00Z",
    },
    {
      day_utc: "2026-08-06",
      manifest_hash: h("b"),
      manifest_size: 122,
      r2_md5: "md5-b",
      r2_modtime: "2026-08-06T10:00:00Z",
    },
  ]);
  const shardB = buildCoreInventoryShard("history/v2/core", [...shardA.days].reverse());

  assert.equal(shardA.source_hash, shardB.source_hash);
  assert.equal(shardA.days[0].day_utc, "2026-08-06");
  assert.equal(shardA.days[1].day_utc, "2026-08-07");
  assert.deepEqual(validateCoreInventoryShard(shardA), shardA);
  assert.equal("ranges" in shardA, false);
});

test("core state accepts compact processed identity", () => {
  const state = validateCoreState({
    schema_version: 1,
    kind: "uk_aq_r2_history_backup_state_core",
    backup_version: "v2",
    processed_source_hash: h("c"),
    days: [{
      day_utc: "2026-08-07",
      manifest_hash: h("d"),
      copied_at: "2026-08-07T12:00:00.000Z",
    }],
  });
  assert.equal(state.processed_source_hash, h("c"));
  assert.equal(state.days.length, 1);
});

test("fresh core state copies and checkpoints every current unit", () => {
  const inventory = buildCoreInventoryShard("history/v2/core", [{
    day_utc: "2026-08-07",
    manifest_hash: h("a"),
    manifest_size: 123,
    r2_md5: "md5-a",
    r2_modtime: "2026-08-07T10:00:00Z",
  }]);
  const inventoryShardKey =
    "history/_index_v2/backup_inventory_v2/global/core.json";
  const stateRoot = {};
  const writes = [];
  let copyCalls = 0;

  const result = syncCoreToDropbox({
    inventoryRoot: {
      core: {
        source_prefix: "history/v2/core",
        inventory_shard_key: inventoryShardKey,
        inventory_shard_hash: sha256Hex(stableJson(inventory)),
        source_hash: inventory.source_hash,
        unit_count: 1,
      },
    },
    stateRoot,
    stateRootPrefix: "_ops/checkpoints/r2_history_backup_state_v2",
    dryRun: false,
    checkpointBatchUnits: 10,
    checkpointFlushSeconds: 60,
    readInventoryJson: (key) => {
      assert.equal(key, inventoryShardKey);
      return inventory;
    },
    readStateJsonMaybe: () => null,
    writeStateJson: (key, payload) => {
      writes.push({ key, payload });
      return { written: true, hash: h("f") };
    },
    copyAndVerifyDay: () => {
      copyCalls += 1;
      return { source_hash: h("a"), verified: true, dry_run: false };
    },
  });

  assert.equal(copyCalls, 1);
  assert.equal(result.report.candidates, 1);
  assert.equal(result.report.copied, 1);
  assert.equal(result.report.state_shards_written, 1);
  assert.equal(result.report.checkpoint_flush_count, 1);
  assert.equal(result.report.complete, true);
  assert.equal(result.state_root_dirty, true);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].key,
    "_ops/checkpoints/r2_history_backup_state_v2/global/core.json",
  );
  assert.equal(
    writes[0].payload.processed_source_hash,
    inventory.source_hash,
  );
  assert.equal(stateRoot.core.state_shard_hash, h("f"));
});

test("manifest-guided prune plan only marks unreferenced Parquet stale", () => {
  const plan = buildStaleParquetPrunePlan({
    unit_relative_path: "history/v2/observations/day_utc=2026-08-07",
    manifest_entries: [{
      relative_path: "manifest.json",
      text: JSON.stringify({
        parquet_object_keys: [
          "history/v2/observations/day_utc=2026-08-07/connector_id=1/current.parquet",
        ],
      }),
    }],
    actual_file_entries: [
      { Path: "connector_id=1/current.parquet" },
      { Path: "connector_id=1/stale.parquet" },
    ],
  });

  assert.deepEqual(plan.stale_relative_paths, ["connector_id=1/stale.parquet"]);
});
