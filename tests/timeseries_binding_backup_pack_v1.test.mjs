import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { stableJson } from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  buildTimeseriesBindingBackupPackRootV1,
  buildTimeseriesBindingBackupPackV1,
  publishTimeseriesBindingBackupPacksV1,
  serializeTimeseriesBindingBackupPackRootV1,
  serializeTimeseriesBindingBackupPackV1,
  timeseriesBindingBackupPackKey,
  timeseriesBindingBackupPackRootKey,
  validateTimeseriesBindingBackupPackV1,
} from "../scripts/backup_r2/lib/timeseries_binding_backup_pack_v1.mjs";
import {
  buildTimeseriesBindingSourceRangeManifest,
  buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRangeManifestKey,
  timeseriesBindingSourceRootKey,
} from "../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs";

const BINDING_PREFIX = "history/_index_v2/timeseries_binding";
const PACK_PREFIX = "history/_backup_packs_v1/timeseries_binding";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function sourceRange(rangeStart, bodies) {
  return buildTimeseriesBindingSourceRangeManifest({
    bindingPrefix: BINDING_PREFIX,
    rangeStart,
    rangeEnd: rangeStart + 999,
    units: bodies.map(({ timeseriesId, body }) => ({
      timeseries_id: timeseriesId,
      relative_path: `${BINDING_PREFIX}/timeseries_id=${timeseriesId}.json`,
      sha256: sha256(body),
      size: body.byteLength,
      r2_md5: null,
    })),
  });
}

function sourceMembers(range, bodyById, order = range.units.map((unit) => unit.timeseries_id)) {
  return order.map((timeseriesId) => ({
    timeseries_id: timeseriesId,
    relative_path: `${BINDING_PREFIX}/timeseries_id=${timeseriesId}.json`,
    body: bodyById.get(timeseriesId),
  }));
}

function artifactFor(range, bodyById, order) {
  const payload = buildTimeseriesBindingBackupPackV1({
    sourceRangeManifest: range,
    members: sourceMembers(range, bodyById, order),
  });
  return serializeTimeseriesBindingBackupPackV1(payload);
}

function clone(value) {
  return structuredClone(value);
}

test("pack v1 is deterministic across source enumeration order and preserves exact bytes", () => {
  const bodies = new Map([
    [2, Buffer.from('{"timeseries_id":2,"name":"München"}\n', "utf8")],
    [9, Buffer.from('{"timeseries_id":9,"continuity":null}\n', "utf8")],
  ]);
  const range = sourceRange(0, [...bodies].map(([timeseriesId, body]) => ({
    timeseriesId,
    body,
  })));
  const first = artifactFor(range, bodies, [9, 2]);
  const second = artifactFor(range, bodies, [2, 9]);

  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.payload.members.map((member) => member.timeseries_id), [2, 9]);
  for (const member of first.payload.members) {
    assert.deepEqual(Buffer.from(member.body_base64, "base64"), bodies.get(member.timeseries_id));
  }
  assert.equal("generated_at" in first.payload, false);
});

test("pack v1 closed-set validation rejects each contradictory member condition", () => {
  const bodies = new Map([
    [4, Buffer.from('{"timeseries_id":4}\n')],
    [7, Buffer.from('{"timeseries_id":7}\n')],
  ]);
  const range = sourceRange(0, [...bodies].map(([timeseriesId, body]) => ({
    timeseriesId,
    body,
  })));
  const valid = artifactFor(range, bodies, [4, 7]).payload;

  const missing = clone(valid);
  missing.members.pop();
  missing.member_count = 1;
  assert.throws(
    () => validateTimeseriesBindingBackupPackV1(missing, range),
    /member_count mismatch|Missing timeseries binding/,
  );

  const extra = clone(valid);
  extra.members.push({
    ...extra.members[0],
    timeseries_id: 8,
    relative_path: `${BINDING_PREFIX}/timeseries_id=8.json`,
  });
  extra.member_count = 3;
  assert.throws(
    () => validateTimeseriesBindingBackupPackV1(extra, range),
    /member_count mismatch|Extra timeseries binding/,
  );

  const duplicate = clone(valid);
  duplicate.members[1] = clone(duplicate.members[0]);
  assert.throws(
    () => validateTimeseriesBindingBackupPackV1(duplicate, range),
    /Duplicate timeseries binding/,
  );

  const wrongPath = clone(valid);
  wrongPath.members[0].relative_path = `${BINDING_PREFIX}/timeseries_id=5.json`;
  assert.throws(
    () => validateTimeseriesBindingBackupPackV1(wrongPath, range),
    /path\/id mismatch/,
  );

  const wrongSha = clone(valid);
  wrongSha.members[0].sha256 = "0".repeat(64);
  assert.throws(
    () => validateTimeseriesBindingBackupPackV1(wrongSha, range),
    /SHA-256 mismatch/,
  );

  const wrongSize = clone(valid);
  wrongSize.members[0].size += 1;
  assert.throws(
    () => validateTimeseriesBindingBackupPackV1(wrongSize, range),
    /size mismatch/,
  );

  const wrongRangeHash = clone(valid);
  wrongRangeHash.source_range_hash = "f".repeat(64);
  assert.throws(
    () => validateTimeseriesBindingBackupPackV1(wrongRangeHash, range),
    /source_range_hash mismatch/,
  );

  const wrongOrder = clone(valid);
  wrongOrder.members.reverse();
  assert.throws(
    () => validateTimeseriesBindingBackupPackV1(wrongOrder, range),
    /not strictly sorted/,
  );
});

test("a binding change alters only its containing range pack identity", () => {
  const firstBodies = new Map([
    [12, Buffer.from('{"timeseries_id":12,"station_id":1}\n')],
    [1012, Buffer.from('{"timeseries_id":1012,"station_id":2}\n')],
  ]);
  const changedBodies = new Map(firstBodies);
  changedBodies.set(12, Buffer.from('{"timeseries_id":12,"station_id":3}\n'));

  const range0Before = sourceRange(0, [{ timeseriesId: 12, body: firstBodies.get(12) }]);
  const range0After = sourceRange(0, [{ timeseriesId: 12, body: changedBodies.get(12) }]);
  const range1000 = sourceRange(1000, [{
    timeseriesId: 1012,
    body: firstBodies.get(1012),
  }]);
  const before0 = artifactFor(range0Before, firstBodies);
  const after0 = artifactFor(range0After, changedBodies);
  const before1000 = artifactFor(range1000, firstBodies);
  const after1000 = artifactFor(range1000, changedBodies);

  assert.notEqual(before0.sha256, after0.sha256);
  assert.notDeepEqual(before0.bytes, after0.bytes);
  assert.equal(before1000.sha256, after1000.sha256);
  assert.deepEqual(before1000.bytes, after1000.bytes);
});

test("pack membership retains source-authoritative stale physical bindings", () => {
  const bodies = new Map([
    [21, Buffer.from('{"timeseries_id":21,"active":true}\n')],
    [22, Buffer.from('{"timeseries_id":22,"active":false}\n')],
  ]);
  const simulatedCurrentCoreIds = new Set([21]);
  const range = sourceRange(0, [...bodies].map(([timeseriesId, body]) => ({
    timeseriesId,
    body,
  })));
  const pack = artifactFor(range, bodies).payload;

  assert.equal(simulatedCurrentCoreIds.has(22), false);
  assert.deepEqual(pack.members.map((member) => member.timeseries_id), [21, 22]);
});

test("pack root deterministically binds the exact child set and source-root identity", () => {
  const bodies = new Map([
    [3, Buffer.from('{"timeseries_id":3}\n')],
    [1003, Buffer.from('{"timeseries_id":1003}\n')],
  ]);
  const ranges = [
    sourceRange(0, [{ timeseriesId: 3, body: bodies.get(3) }]),
    sourceRange(1000, [{ timeseriesId: 1003, body: bodies.get(1003) }]),
  ];
  const sourceRoot = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: BINDING_PREFIX,
    ranges: ranges.map((range) => ({
      range_start: range.range_start,
      range_end: range.range_end,
      source_range_hash: range.source_range_hash,
      manifest_key: timeseriesBindingSourceRangeManifestKey(
        BINDING_PREFIX,
        range.range_start,
        range.range_end,
      ),
      unit_count: range.units.length,
    })),
  });
  const childReferences = ranges.map((range) => {
    const artifact = artifactFor(range, bodies);
    return {
      range_start: range.range_start,
      range_end: range.range_end,
      source_range_hash: range.source_range_hash,
      pack_relative_path: timeseriesBindingBackupPackKey({
        packPrefix: PACK_PREFIX,
        rangeStart: range.range_start,
        rangeEnd: range.range_end,
        sourceRangeHash: range.source_range_hash,
      }),
      pack_sha256: artifact.sha256,
      pack_size: artifact.size,
      member_count: range.units.length,
    };
  });
  const first = buildTimeseriesBindingBackupPackRootV1({
    sourceRootManifest: sourceRoot,
    packPrefix: PACK_PREFIX,
    ranges: childReferences,
  });
  const second = buildTimeseriesBindingBackupPackRootV1({
    sourceRootManifest: sourceRoot,
    packPrefix: PACK_PREFIX,
    ranges: [...childReferences].reverse(),
  });

  assert.deepEqual(
    serializeTimeseriesBindingBackupPackRootV1(first).bytes,
    serializeTimeseriesBindingBackupPackRootV1(second).bytes,
  );
  assert.equal(first.source_root_hash, sourceRoot.source_root_hash);
  assert.equal(first.range_count, 2);
  assert.equal(first.member_count, 2);
  assert.throws(
    () => buildTimeseriesBindingBackupPackRootV1({
      sourceRootManifest: sourceRoot,
      packPrefix: PACK_PREFIX,
      ranges: childReferences.slice(0, 1),
    }),
    /range_count mismatch/,
  );
});

function memoryR2(initialObjects) {
  const objects = new Map(
    [...initialObjects].map(([key, value]) => [key, Buffer.from(value)]),
  );
  const puts = [];
  const gets = [];
  return {
    r2: {
      adapter: {
        async headObject({ key }) {
          const body = objects.get(key);
          return body
            ? { exists: true, key, bytes: body.byteLength, sha256: sha256(body) }
            : { exists: false, key };
        },
        async getObject({ key }) {
          gets.push(key);
          const body = objects.get(key);
          if (!body) throw new Error(`missing ${key}`);
          return { key, body: Buffer.from(body), bytes: body.byteLength };
        },
        async putObject({ key, body }) {
          puts.push(key);
          const bytes = Buffer.from(body);
          objects.set(key, bytes);
          return { key, bytes: bytes.byteLength };
        },
      },
    },
    objects,
    puts,
    gets,
  };
}

function hierarchyFixture() {
  const bodies = new Map([
    [31, Buffer.from('{"timeseries_id":31}\n')],
    [1031, Buffer.from('{"timeseries_id":1031}\n')],
  ]);
  const ranges = [
    sourceRange(0, [{ timeseriesId: 31, body: bodies.get(31) }]),
    sourceRange(1000, [{ timeseriesId: 1031, body: bodies.get(1031) }]),
  ];
  const root = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: BINDING_PREFIX,
    ranges: ranges.map((range) => ({
      range_start: range.range_start,
      range_end: range.range_end,
      source_range_hash: range.source_range_hash,
      manifest_key: timeseriesBindingSourceRangeManifestKey(
        BINDING_PREFIX,
        range.range_start,
        range.range_end,
      ),
      unit_count: range.units.length,
    })),
  });
  const objects = new Map([
    [timeseriesBindingSourceRootKey(BINDING_PREFIX), stableJson(root)],
  ]);
  for (const range of ranges) {
    objects.set(
      timeseriesBindingSourceRangeManifestKey(
        BINDING_PREFIX,
        range.range_start,
        range.range_end,
      ),
      stableJson(range),
    );
    for (const unit of range.units) objects.set(unit.relative_path, bodies.get(unit.timeseries_id));
  }
  return objects;
}

test("publisher dry-run is read-only and write mode publishes verified root last", async () => {
  const store = memoryR2(hierarchyFixture());
  const dryRun = await publishTimeseriesBindingBackupPacksV1({
    r2: store.r2,
    bindingPrefix: BINDING_PREFIX,
    packPrefix: PACK_PREFIX,
    writeR2: false,
  });
  assert.equal(dryRun.ranges_rebuilt, 2);
  assert.equal(dryRun.ranges_written, 0);
  assert.equal(dryRun.pack_root_written, false);
  assert.deepEqual(store.puts, []);

  const written = await publishTimeseriesBindingBackupPacksV1({
    r2: store.r2,
    bindingPrefix: BINDING_PREFIX,
    packPrefix: PACK_PREFIX,
    writeR2: true,
  });
  assert.equal(written.ranges_written, 2);
  assert.equal(written.pack_root_written, true);
  assert.equal(store.puts.at(-1), timeseriesBindingBackupPackRootKey(PACK_PREFIX));
  assert.equal(store.puts.slice(0, -1).every((key) => key.endsWith(".pack.json")), true);

  store.puts.length = 0;
  store.gets.length = 0;
  const unchanged = await publishTimeseriesBindingBackupPacksV1({
    r2: store.r2,
    bindingPrefix: BINDING_PREFIX,
    packPrefix: PACK_PREFIX,
    writeR2: true,
  });
  assert.equal(unchanged.ranges_reused, 2);
  assert.equal(unchanged.ranges_rebuilt, 0);
  assert.equal(unchanged.pack_root_changed, false);
  assert.deepEqual(store.puts, []);
  assert.equal(
    store.gets.some((key) => /^history\/_index_v2\/timeseries_binding\/timeseries_id=/.test(key)),
    false,
  );
});

test("publisher rebuilds and writes only the changed authoritative source range", async () => {
  const store = memoryR2(hierarchyFixture());
  const first = await publishTimeseriesBindingBackupPacksV1({
    r2: store.r2,
    bindingPrefix: BINDING_PREFIX,
    packPrefix: PACK_PREFIX,
    writeR2: true,
  });
  assert.equal(first.ranges_written, 2);
  assert.equal(first.pack_root_written, true);

  const changedBody = Buffer.from('{"timeseries_id":31,"station_id":99}\n');
  const changedRange = sourceRange(0, [{ timeseriesId: 31, body: changedBody }]);
  const unchangedRangeKey = timeseriesBindingSourceRangeManifestKey(
    BINDING_PREFIX,
    1000,
    1999,
  );
  const unchangedRange = JSON.parse(store.objects.get(unchangedRangeKey).toString("utf8"));
  const changedRangeKey = timeseriesBindingSourceRangeManifestKey(BINDING_PREFIX, 0, 999);
  const changedRoot = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: BINDING_PREFIX,
    ranges: [changedRange, unchangedRange].map((range) => ({
      range_start: range.range_start,
      range_end: range.range_end,
      source_range_hash: range.source_range_hash,
      manifest_key: timeseriesBindingSourceRangeManifestKey(
        BINDING_PREFIX,
        range.range_start,
        range.range_end,
      ),
      unit_count: range.units.length,
    })),
  });
  store.objects.set(`${BINDING_PREFIX}/timeseries_id=31.json`, changedBody);
  store.objects.set(changedRangeKey, Buffer.from(stableJson(changedRange)));
  store.objects.set(
    timeseriesBindingSourceRootKey(BINDING_PREFIX),
    Buffer.from(stableJson(changedRoot)),
  );

  store.puts.length = 0;
  store.gets.length = 0;
  const second = await publishTimeseriesBindingBackupPacksV1({
    r2: store.r2,
    bindingPrefix: BINDING_PREFIX,
    packPrefix: PACK_PREFIX,
    writeR2: true,
  });
  const firstChangedRange = first.ranges.find((range) => range.range_start === 0);
  const firstUnchangedRange = first.ranges.find((range) => range.range_start === 1000);
  const secondChangedRange = second.ranges.find((range) => range.range_start === 0);
  const secondUnchangedRange = second.ranges.find((range) => range.range_start === 1000);

  assert.equal(second.ranges_rebuilt, 1);
  assert.equal(second.ranges_reused, 1);
  assert.equal(second.ranges_written, 1);
  assert.equal(secondChangedRange.action, "rebuilt");
  assert.equal(secondChangedRange.written, true);
  assert.notEqual(secondChangedRange.pack_relative_path, firstChangedRange.pack_relative_path);
  assert.notEqual(secondChangedRange.pack_sha256, firstChangedRange.pack_sha256);
  assert.equal(secondUnchangedRange.action, "reused");
  assert.equal(secondUnchangedRange.written, false);
  assert.equal(secondUnchangedRange.pack_relative_path, firstUnchangedRange.pack_relative_path);
  assert.equal(secondUnchangedRange.pack_sha256, firstUnchangedRange.pack_sha256);
  assert.equal(second.pack_root_changed, true);
  assert.equal(second.pack_root_written, true);
  assert.deepEqual(store.puts, [
    secondChangedRange.pack_relative_path,
    timeseriesBindingBackupPackRootKey(PACK_PREFIX),
  ]);
  assert.equal(
    store.gets.includes(`${BINDING_PREFIX}/timeseries_id=31.json`),
    true,
  );
  assert.equal(
    store.gets.includes(`${BINDING_PREFIX}/timeseries_id=1031.json`),
    false,
  );
});

test("publisher never publishes the pack root when child verification fails", async () => {
  const store = memoryR2(hierarchyFixture());
  const sourceRangeKey = timeseriesBindingSourceRangeManifestKey(BINDING_PREFIX, 0, 999);
  const range = JSON.parse(store.objects.get(sourceRangeKey).toString("utf8"));
  const failedPackKey = timeseriesBindingBackupPackKey({
    packPrefix: PACK_PREFIX,
    rangeStart: range.range_start,
    rangeEnd: range.range_end,
    sourceRangeHash: range.source_range_hash,
  });
  const originalGetObject = store.r2.adapter.getObject;
  store.r2.adapter.getObject = async ({ key }) => {
    if (key === failedPackKey && store.puts.includes(failedPackKey)) {
      throw new Error("injected child post-PUT verification failure");
    }
    return originalGetObject({ key });
  };

  await assert.rejects(
    publishTimeseriesBindingBackupPacksV1({
      r2: store.r2,
      bindingPrefix: BINDING_PREFIX,
      packPrefix: PACK_PREFIX,
      writeR2: true,
    }),
    /injected child post-PUT verification failure/,
  );
  assert.equal(store.puts.includes(failedPackKey), true);
  assert.equal(store.objects.has(failedPackKey), true);
  assert.equal(store.puts.includes(timeseriesBindingBackupPackRootKey(PACK_PREFIX)), false);
  assert.equal(store.objects.has(timeseriesBindingBackupPackRootKey(PACK_PREFIX)), false);
});
