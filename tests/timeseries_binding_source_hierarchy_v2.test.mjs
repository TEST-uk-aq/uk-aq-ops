import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTimeseriesBindingRangeInventoryShard,
  validateTimeseriesBindingRootReference,
} from "../scripts/backup_r2/lib/timeseries_binding_ranges_v2.mjs";
import {
  buildTimeseriesBindingSourceRangeManifest,
  buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRangeManifestKey,
  timeseriesBindingSourceRootKey,
  validateTimeseriesBindingSourceRootManifest,
} from "../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs";

const h = (char) => char.repeat(64);

test("source and backup range hashes are deliberately compatible", () => {
  const source = buildTimeseriesBindingSourceRangeManifest({
    bindingPrefix: "history/_index_v2/timeseries_binding",
    rangeStart: 1000,
    rangeEnd: 1999,
    units: [{
      timeseries_id: 1234,
      relative_path:
        "history/_index_v2/timeseries_binding/timeseries_id=1234.json",
      sha256: h("a"),
      size: 321,
      r2_md5: "etag",
    }],
  });
  const backup = buildTimeseriesBindingRangeInventoryShard({
    sourcePrefix: "history/_index_v2/timeseries_binding",
    rangeStart: 1000,
    rangeEnd: 1999,
    units: source.units.map((entry) => ({
      timeseries_id: entry.timeseries_id,
      relative_path: entry.relative_path,
      hash: entry.sha256,
      size: entry.size,
      r2_md5: entry.r2_md5,
      r2_modtime: null,
    })),
  });
  assert.equal(source.source_range_hash, backup.source_range_hash);
});

test("source hierarchy paths retain stable 1000-ID ranges", () => {
  assert.equal(
    timeseriesBindingSourceRootKey("history/_index_v2/timeseries_binding"),
    "history/_index_v2/timeseries_binding/_manifests/root.json",
  );
  assert.equal(
    timeseriesBindingSourceRangeManifestKey(
      "history/_index_v2/timeseries_binding",
      1040000,
      1040999,
    ),
    "history/_index_v2/timeseries_binding/_manifests/range=1040000-1040999.json",
  );
});

test("source root is byte-stable across range input order", () => {
  const prefix = "history/_index_v2/timeseries_binding";
  const ranges = [
    {
      range_start: 1000,
      range_end: 1999,
      source_range_hash: h("b"),
      manifest_key: timeseriesBindingSourceRangeManifestKey(prefix, 1000, 1999),
      unit_count: 4,
    },
    {
      range_start: 0,
      range_end: 999,
      source_range_hash: h("a"),
      manifest_key: timeseriesBindingSourceRangeManifestKey(prefix, 0, 999),
      unit_count: 7,
    },
  ];
  const first = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: prefix,
    ranges,
  });
  const second = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: prefix,
    ranges: [...ranges].reverse(),
  });
  assert.deepEqual(first, second);
  assert.deepEqual(validateTimeseriesBindingSourceRootManifest(first), first);
});

test("backup root reference retains authoritative source root identity", () => {
  const reference = validateTimeseriesBindingRootReference({
    range_size: 1000,
    inventory_root_key:
      "history/_index_v2/backup_inventory_v2/timeseries_binding/root.json",
    inventory_root_hash: h("a"),
    source_root_hash: h("b"),
    source_manifest_root_key:
      "history/_index_v2/timeseries_binding/_manifests/root.json",
    source_manifest_root_hash: h("c"),
    ranges: [],
  });
  assert.equal(
    reference.source_manifest_root_key,
    "history/_index_v2/timeseries_binding/_manifests/root.json",
  );
  assert.equal(reference.source_manifest_root_hash, h("c"));
});
