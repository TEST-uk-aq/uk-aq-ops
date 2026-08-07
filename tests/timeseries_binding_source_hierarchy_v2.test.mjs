import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTimeseriesBindingRangeInventoryShard,
  buildTimeseriesBindingRootInventory,
  validateTimeseriesBindingRootReference,
} from "../scripts/backup_r2/lib/timeseries_binding_ranges_v2.mjs";
import {
  buildTimeseriesBindingSourceRangeManifest,
  buildTimeseriesBindingSourceRootManifest,
  refreshTimeseriesBindingSourceHierarchy,
  timeseriesBindingSourceRangeManifestKey,
  timeseriesBindingSourceRootKey,
  validateTimeseriesBindingSourceRootManifest,
} from "../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs";

const h = (char) => char.repeat(64);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const md5 = (value) => createHash("md5").update(value).digest("hex");

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

test("refresh bootstraps once then skips the complete physical listing", async () => {
  const bindingPrefix = "history/_index_v2/timeseries_binding";
  const inventoryPrefix = "history/_index_v2/backup_inventory_v2";
  const physical = [
    {
      timeseries_id: 434,
      key: `${bindingPrefix}/timeseries_id=434.json`,
      body: '{"timeseries_id":434,"connector_id":1}\n',
    },
    {
      timeseries_id: 1234,
      key: `${bindingPrefix}/timeseries_id=1234.json`,
      body: '{"timeseries_id":1234,"connector_id":2}\n',
    },
  ];
  const backupRanges = physical.map((entry) => {
    const rangeStart = Math.floor(entry.timeseries_id / 1000) * 1000;
    const rangeEnd = rangeStart + 999;
    const shard = buildTimeseriesBindingRangeInventoryShard({
      sourcePrefix: bindingPrefix,
      rangeStart,
      rangeEnd,
      units: [{
        timeseries_id: entry.timeseries_id,
        relative_path: entry.key,
        hash: sha256(entry.body),
        size: Buffer.byteLength(entry.body),
        r2_md5: md5(entry.body),
        r2_modtime: null,
      }],
    });
    return {
      shard,
      summary: {
        range_start: rangeStart,
        range_end: rangeEnd,
        source_range_hash: shard.source_range_hash,
        inventory_shard_key:
          `${inventoryPrefix}/timeseries_binding/`
          + `range=${String(rangeStart).padStart(6, "0")}`
          + `-${String(rangeEnd).padStart(6, "0")}.json`,
        unit_count: 1,
      },
    };
  });
  const backupRoot = buildTimeseriesBindingRootInventory({
    sourcePrefix: bindingPrefix,
    ranges: backupRanges.map((entry) => entry.summary),
  });

  const objects = new Map();
  for (const entry of physical) objects.set(entry.key, entry.body);
  for (const entry of backupRanges) {
    objects.set(entry.summary.inventory_shard_key, `${JSON.stringify(entry.shard)}\n`);
  }
  objects.set(
    `${inventoryPrefix}/timeseries_binding/root.json`,
    `${JSON.stringify(backupRoot)}\n`,
  );

  let listCalls = 0;
  const adapter = {
    async headObject({ key }) {
      if (!objects.has(key)) return { exists: false, key };
      const body = objects.get(key);
      return {
        exists: true,
        key,
        etag: md5(body),
        bytes: Buffer.byteLength(body),
      };
    },
    async getObject({ key }) {
      if (!objects.has(key)) throw new Error(`missing ${key}`);
      const body = Buffer.from(objects.get(key));
      return { key, bytes: body.byteLength, body, etag: md5(body) };
    },
    async putObject({ key, body }) {
      const text = Buffer.from(body).toString("utf8");
      objects.set(key, text);
      return { key, bytes: Buffer.byteLength(text), etag: md5(text) };
    },
    async listAllObjects({ prefix }) {
      listCalls += 1;
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({
          key,
          size: Buffer.byteLength(body),
          etag: md5(body),
        }));
    },
  };
  const r2 = { adapter };
  const fingerprint = h("f");

  const first = await refreshTimeseriesBindingSourceHierarchy({
    r2,
    bindingPrefix,
    backupInventoryRootPrefix: inventoryPrefix,
    sourceFingerprint: fingerprint,
    writeR2: true,
  });
  assert.equal(first.physical_listing_performed, true);
  assert.equal(first.physical_bindings_listed, 2);
  assert.equal(first.reused_from_backup_inventory, 2);
  assert.equal(first.read_and_hashed, 0);
  assert.equal(listCalls, 1);

  const second = await refreshTimeseriesBindingSourceHierarchy({
    r2,
    bindingPrefix,
    backupInventoryRootPrefix: inventoryPrefix,
    sourceFingerprint: fingerprint,
    writeR2: true,
  });
  assert.equal(second.status, "skipped");
  assert.equal(second.physical_listing_performed, false);
  assert.equal(second.physical_bindings_listed, 0);
  assert.equal(listCalls, 1);
});
