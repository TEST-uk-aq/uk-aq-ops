import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildCoreInventoryShard,
  validateCoreInventoryShard,
  validateCoreState,
} from "../scripts/backup_r2/lib/hierarchical_core_backup_v2.mjs";
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

  const sync = runHelp("scripts/backup_r2/sync_history_to_dropbox.mjs");
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /sync_history_to_dropbox\.mjs/);
  assert.match(sync.stdout, /--force-prune-recheck/);
  assert.match(sync.stdout, /--state-root-prefix/);
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
