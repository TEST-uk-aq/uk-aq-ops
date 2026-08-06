import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTimeseriesBindingRangeInventoryShard,
  buildTimeseriesBindingRangeStateSkeleton,
  buildTimeseriesBindingRootInventory,
  TIMESERIES_BINDING_RANGE_SIZE,
  timeseriesBindingInventoryRootKey,
  timeseriesBindingRangeBounds,
  timeseriesBindingRangeInventoryShardKey,
  timeseriesBindingRangeStateShardKey,
  validateTimeseriesBindingRangeInventoryShard,
  validateTimeseriesBindingRootInventory,
} from "../scripts/backup_r2/lib/timeseries_binding_ranges_v2.mjs";

const h = (char) => char.repeat(64);

test("timeseries binding ranges use fixed 1000-ID boundaries", () => {
  assert.equal(TIMESERIES_BINDING_RANGE_SIZE, 1000);
  assert.deepEqual(timeseriesBindingRangeBounds(1), {
    range_start: 0,
    range_end: 999,
  });
  assert.deepEqual(timeseriesBindingRangeBounds(999), {
    range_start: 0,
    range_end: 999,
  });
  assert.deepEqual(timeseriesBindingRangeBounds(1000), {
    range_start: 1000,
    range_end: 1999,
  });
});

test("inventory and state range paths are stable", () => {
  assert.equal(
    timeseriesBindingRangeInventoryShardKey(
      "history/_index_v2/backup_inventory_v2",
      1000,
      1999,
    ),
    "history/_index_v2/backup_inventory_v2/timeseries_binding/range=001000-001999.json",
  );
  assert.equal(
    timeseriesBindingInventoryRootKey(
      "history/_index_v2/backup_inventory_v2",
    ),
    "history/_index_v2/backup_inventory_v2/timeseries_binding/root.json",
  );
  assert.equal(
    timeseriesBindingRangeStateShardKey(
      "_ops/checkpoints/r2_history_backup_state_v2",
      1000,
      1999,
    ),
    "_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding/range=001000-001999.json",
  );
});

test("range inventory hash is stable and excludes metadata-only changes", () => {
  const base = {
    sourcePrefix: "history/_index_v2/timeseries_binding",
    rangeStart: 0,
    rangeEnd: 999,
    units: [{
      timeseries_id: 434,
      relative_path:
        "history/_index_v2/timeseries_binding/timeseries_id=434.json",
      hash: h("a"),
      size: 222,
      r2_md5: "first",
      r2_modtime: "2026-08-06T00:00:00Z",
    }],
  };
  const first = buildTimeseriesBindingRangeInventoryShard(base);
  const second = buildTimeseriesBindingRangeInventoryShard({
    ...base,
    units: [{
      ...base.units[0],
      r2_md5: "second",
      r2_modtime: "2026-08-07T00:00:00Z",
    }],
  });
  assert.equal(first.source_range_hash, second.source_range_hash);
  assert.deepEqual(
    validateTimeseriesBindingRangeInventoryShard(first),
    first,
  );
});

test("binding root hash is stable across input order", () => {
  const ranges = [
    {
      range_start: 1000,
      range_end: 1999,
      source_range_hash: h("b"),
      inventory_shard_key:
        "history/_index_v2/backup_inventory_v2/timeseries_binding/range=001000-001999.json",
      unit_count: 10,
    },
    {
      range_start: 0,
      range_end: 999,
      source_range_hash: h("a"),
      inventory_shard_key:
        "history/_index_v2/backup_inventory_v2/timeseries_binding/range=000000-000999.json",
      unit_count: 20,
    },
  ];
  const first = buildTimeseriesBindingRootInventory({
    sourcePrefix: "history/_index_v2/timeseries_binding",
    ranges,
  });
  const second = buildTimeseriesBindingRootInventory({
    sourcePrefix: "history/_index_v2/timeseries_binding",
    ranges: [...ranges].reverse(),
  });
  assert.equal(first.source_root_hash, second.source_root_hash);
  assert.deepEqual(validateTimeseriesBindingRootInventory(first), first);
});

test("range state skeleton uses the same fixed identity", () => {
  assert.deepEqual(
    buildTimeseriesBindingRangeStateSkeleton(0, 999),
    {
      schema_version: 1,
      kind: "uk_aq_r2_history_backup_state_timeseries_binding_range",
      backup_version: "v2",
      range_size: 1000,
      range_start: 0,
      range_end: 999,
      processed_source_range_hash: null,
      units: [],
    },
  );
});
