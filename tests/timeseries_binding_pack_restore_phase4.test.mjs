import { createHash } from "node:crypto";
import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyHierarchicalStateRoot,
  sha256Hex,
  stableJson,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  TIMESERIES_BINDING_PACK_RANGE_STATE_KIND,
  TIMESERIES_BINDING_PACK_ROOT_STATE_KIND,
  timeseriesBindingPackRangeStateShardKey,
  validateTimeseriesBindingPackRangeState,
} from "../scripts/backup_r2/lib/hierarchical_timeseries_binding_pack_sync_v1.mjs";
import {
  buildTimeseriesBindingBackupPackRootV1,
  buildTimeseriesBindingBackupPackV1,
  serializeTimeseriesBindingBackupPackRootV1,
  serializeTimeseriesBindingBackupPackV1,
  timeseriesBindingBackupPackKey,
} from "../scripts/backup_r2/lib/timeseries_binding_backup_pack_v1.mjs";
import {
  TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY,
  TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
  TIMESERIES_BINDING_RESTORE_STATE_PREFIX,
  TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY,
  restoreTimeseriesBindingPacksToR2,
} from "../scripts/backup_r2/lib/timeseries_binding_pack_restore_v1.mjs";
import {
  buildTimeseriesBindingSourceRangeManifest,
  buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRangeManifestKey,
  timeseriesBindingSourceRootKey,
} from "../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs";
import {
  NORMAL_TEST_DROPBOX_PACK_SOURCE,
  NORMAL_TEST_R2_HISTORY_DESTINATION,
  PHASE4_ISOLATED_TEST_R2_DESTINATION,
  parseTimeseriesBindingPackRestoreArgs,
} from "../scripts/backup_r2/restore_timeseries_binding_packs_to_r2.mjs";

const PACK_PREFIX = "history/_backup_packs_v1/timeseries_binding";
const NOW = "2026-09-04T12:00:00.000Z";
const h = (value) => createHash("sha256").update(value).digest("hex");

function memberPath(timeseriesId) {
  return `${TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX}/timeseries_id=${timeseriesId}.json`;
}

function sourceRange(rangeStart, entries) {
  return buildTimeseriesBindingSourceRangeManifest({
    bindingPrefix: TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
    rangeStart,
    rangeEnd: rangeStart + 999,
    units: entries.map(({ timeseriesId, body }) => ({
      timeseries_id: timeseriesId,
      relative_path: memberPath(timeseriesId),
      sha256: h(body),
      size: body.byteLength,
      r2_md5: null,
    })),
  });
}

function buildFixture() {
  const bodies = new Map([
    [11, Buffer.from('{"timeseries_id":11,"connector_id":3,"source":"sos"}\n')],
    [12, Buffer.from('{"timeseries_id":12,"connector_id":5,"source":"openaq"}\n')],
    [1011, Buffer.from('{"timeseries_id":1011,"connector_id":6,"source":"sensor.community"}\n')],
  ]);
  const ranges = [
    sourceRange(0, [
      { timeseriesId: 11, body: bodies.get(11) },
      { timeseriesId: 12, body: bodies.get(12) },
    ]),
    sourceRange(1000, [
      { timeseriesId: 1011, body: bodies.get(1011) },
    ]),
  ];
  const sourceRoot = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
    ranges: ranges.map((range) => ({
      range_start: range.range_start,
      range_end: range.range_end,
      source_range_hash: range.source_range_hash,
      manifest_key: timeseriesBindingSourceRangeManifestKey(
        TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
        range.range_start,
        range.range_end,
      ),
      unit_count: range.units.length,
    })),
  });
  const packArtifacts = ranges.map((range) => {
    const pack = buildTimeseriesBindingBackupPackV1({
      sourceRangeManifest: range,
      members: range.units.map((unit) => ({
        timeseries_id: unit.timeseries_id,
        relative_path: unit.relative_path,
        body: bodies.get(unit.timeseries_id),
      })),
    });
    const artifact = serializeTimeseriesBindingBackupPackV1(pack);
    return {
      range,
      artifact,
      reference: {
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
      },
    };
  });
  const packRoot = buildTimeseriesBindingBackupPackRootV1({
    sourceRootManifest: sourceRoot,
    packPrefix: PACK_PREFIX,
    ranges: packArtifacts.map((entry) => entry.reference),
  });
  const packRootArtifact = serializeTimeseriesBindingBackupPackRootV1(packRoot);
  const sourceObjects = new Map([
    [TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY, packRootArtifact.bytes],
  ]);
  for (const entry of packArtifacts) {
    sourceObjects.set(entry.reference.pack_relative_path, entry.artifact.bytes);
  }

  const stateRanges = [];
  for (const entry of packArtifacts) {
    const reference = entry.reference;
    const stateShardKey = timeseriesBindingPackRangeStateShardKey(
      TIMESERIES_BINDING_RESTORE_STATE_PREFIX,
      reference.range_start,
      reference.range_end,
    );
    const shard = validateTimeseriesBindingPackRangeState({
      schema_version: 1,
      kind: TIMESERIES_BINDING_PACK_RANGE_STATE_KIND,
      backup_pack_version: "v1",
      range_size: 1000,
      range_start: reference.range_start,
      range_end: reference.range_end,
      processed_source_range_hash: reference.source_range_hash,
      pack_relative_path: reference.pack_relative_path,
      pack_sha256: reference.pack_sha256,
      pack_size: reference.pack_size,
      member_count: reference.member_count,
      copied_at: NOW,
      verified: true,
    }, reference.range_start, reference.range_end);
    const shardBody = Buffer.from(stableJson(shard));
    sourceObjects.set(stateShardKey, shardBody);
    stateRanges.push({
      range_start: reference.range_start,
      range_end: reference.range_end,
      state_shard_key: stateShardKey,
      processed_source_range_hash: reference.source_range_hash,
      pack_relative_path: reference.pack_relative_path,
      pack_sha256: reference.pack_sha256,
      pack_size: reference.pack_size,
      member_count: reference.member_count,
      state_shard_hash: sha256Hex(shardBody),
    });
  }
  const stateRoot = emptyHierarchicalStateRoot(TIMESERIES_BINDING_RESTORE_STATE_PREFIX);
  stateRoot.timeseries_binding_packs = {
    schema_version: 1,
    kind: TIMESERIES_BINDING_PACK_ROOT_STATE_KIND,
    backup_pack_version: "v1",
    processed_source_root_hash: sourceRoot.source_root_hash,
    processed_pack_root_sha256: packRootArtifact.sha256,
    pack_root_relative_path: TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY,
    pack_root_size: packRootArtifact.size,
    copied_at: NOW,
    verified: true,
    ranges: stateRanges,
  };
  sourceObjects.set(
    TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY,
    Buffer.from(stableJson(stateRoot)),
  );
  return {
    bodies,
    ranges,
    sourceRoot,
    packRoot,
    packArtifacts,
    sourceObjects,
  };
}

function refreshFixturePackIdentity(fixture, rangeIndex, mutatePack) {
  const entry = fixture.packArtifacts[rangeIndex];
  const rawPack = JSON.parse(
    fixture.sourceObjects.get(entry.reference.pack_relative_path).toString("utf8"),
  );
  mutatePack(rawPack);
  const packBody = Buffer.from(stableJson(rawPack));
  fixture.sourceObjects.set(entry.reference.pack_relative_path, packBody);

  const packRoot = JSON.parse(
    fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY).toString("utf8"),
  );
  const packRootRange = packRoot.ranges.find(
    (range) => range.range_start === entry.reference.range_start,
  );
  packRootRange.pack_sha256 = sha256Hex(packBody);
  packRootRange.pack_size = packBody.byteLength;
  packRootRange.member_count = rawPack.member_count;
  packRoot.member_count = packRoot.ranges.reduce(
    (sum, range) => sum + range.member_count,
    0,
  );
  const packRootBody = Buffer.from(stableJson(packRoot));
  fixture.sourceObjects.set(TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY, packRootBody);

  const shardKey = timeseriesBindingPackRangeStateShardKey(
    TIMESERIES_BINDING_RESTORE_STATE_PREFIX,
    entry.reference.range_start,
    entry.reference.range_end,
  );
  const shard = JSON.parse(fixture.sourceObjects.get(shardKey).toString("utf8"));
  shard.pack_sha256 = packRootRange.pack_sha256;
  shard.pack_size = packRootRange.pack_size;
  shard.member_count = packRootRange.member_count;
  const shardBody = Buffer.from(stableJson(shard));
  fixture.sourceObjects.set(shardKey, shardBody);

  const stateRoot = JSON.parse(
    fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY).toString("utf8"),
  );
  stateRoot.timeseries_binding_packs.processed_pack_root_sha256 = sha256Hex(packRootBody);
  stateRoot.timeseries_binding_packs.pack_root_size = packRootBody.byteLength;
  const stateRange = stateRoot.timeseries_binding_packs.ranges.find(
    (range) => range.range_start === entry.reference.range_start,
  );
  stateRange.pack_sha256 = packRootRange.pack_sha256;
  stateRange.pack_size = packRootRange.pack_size;
  stateRange.member_count = packRootRange.member_count;
  stateRange.state_shard_hash = sha256Hex(shardBody);
  fixture.sourceObjects.set(
    TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY,
    Buffer.from(stableJson(stateRoot)),
  );
}

function replacePackRootSourceHash(fixture, sourceRootHash) {
  const packRoot = JSON.parse(
    fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY).toString("utf8"),
  );
  packRoot.source_root_hash = sourceRootHash;
  const packRootBody = Buffer.from(stableJson(packRoot));
  fixture.sourceObjects.set(TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY, packRootBody);
  const stateRoot = JSON.parse(
    fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY).toString("utf8"),
  );
  stateRoot.timeseries_binding_packs.processed_source_root_hash = sourceRootHash;
  stateRoot.timeseries_binding_packs.processed_pack_root_sha256 = sha256Hex(packRootBody);
  stateRoot.timeseries_binding_packs.pack_root_size = packRootBody.byteLength;
  fixture.sourceObjects.set(
    TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY,
    Buffer.from(stableJson(stateRoot)),
  );
}

function harness(fixture, { corruptReadbackId = null } = {}) {
  const destinationObjects = new Map();
  const writes = [];
  const reads = [];
  return {
    destinationObjects,
    writes,
    reads,
    readSourceObject: async (relativePath) => {
      const value = fixture.sourceObjects.get(relativePath);
      return value ? Buffer.from(value) : null;
    },
    writeDestinationObject: async (relativePath, body) => {
      writes.push(relativePath);
      destinationObjects.set(relativePath, Buffer.from(body));
    },
    readDestinationObject: async (relativePath) => {
      reads.push(relativePath);
      const value = destinationObjects.get(relativePath);
      if (!value) return null;
      if (relativePath === memberPath(corruptReadbackId)) {
        return Buffer.from("corrupt-readback");
      }
      return Buffer.from(value);
    },
  };
}

async function runRestore(fixture, options = {}) {
  const io = options.io || harness(fixture);
  const report = await restoreTimeseriesBindingPacksToR2({
    sourceRoot: NORMAL_TEST_DROPBOX_PACK_SOURCE,
    destRoot: PHASE4_ISOLATED_TEST_R2_DESTINATION,
    readSourceObject: io.readSourceObject,
    writeDestinationObject: io.writeDestinationObject,
    readDestinationObject: io.readDestinationObject,
    dryRun: options.dryRun ?? true,
    writeConcurrency: options.writeConcurrency || 1,
    expectedSourceRootHash: options.expectedSourceRootHash || fixture.sourceRoot.source_root_hash,
    expectedPackRootSha256: options.expectedPackRootSha256
      || sha256Hex(fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY)),
  });
  return { report, io };
}

test("Phase 4 dry-run globally verifies a multi-range connector-neutral generation", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  const { report } = await runRestore(fixture, { io, dryRun: true });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.ranges_total, 2);
  assert.equal(report.ranges_verified, 2);
  assert.equal(report.members_total, 3);
  assert.equal(report.members_verified, 3);
  assert.equal(report.members_planned, 3);
  assert.equal(report.range_manifests_planned, 2);
  assert.equal(report.reconstructed_source_root_hash, fixture.sourceRoot.source_root_hash);
  assert.equal(report.source_root_hash_match, true);
  assert.equal(report.control_products_restored, false);
  assert.equal(report.source_root_written, false);
  assert.equal(report.root_published_last, false);
  assert.deepEqual(io.writes, []);
  assert.equal(io.destinationObjects.size, 0);
});

test("Phase 4 writes exact bytes, all connectors, range manifests, then source root last", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  const { report } = await runRestore(fixture, {
    io,
    dryRun: false,
    writeConcurrency: 1,
  });
  const memberKeys = [...fixture.bodies.keys()].map(memberPath);
  const rangeKeys = fixture.ranges.map((range) => timeseriesBindingSourceRangeManifestKey(
    TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
    range.range_start,
    range.range_end,
  ));
  const rootKey = timeseriesBindingSourceRootKey(TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX);

  assert.deepEqual(io.writes, [...memberKeys, ...rangeKeys, rootKey]);
  for (const [timeseriesId, body] of fixture.bodies) {
    assert.deepEqual(io.destinationObjects.get(memberPath(timeseriesId)), body);
  }
  assert.deepEqual(io.destinationObjects.get(memberPath(12)), fixture.bodies.get(12));
  assert.deepEqual(io.destinationObjects.get(memberPath(1011)), fixture.bodies.get(1011));
  assert.equal(report.members_written, 3);
  assert.equal(report.members_readback_verified, 3);
  assert.equal(report.range_manifests_written, 2);
  assert.equal(report.range_manifests_readback_verified, 2);
  assert.equal(report.source_root_written, true);
  assert.equal(report.source_root_readback_verified, true);
  assert.equal(report.root_published_last, true);
  assert.equal(io.writes.at(-1), rootKey);
});

test("missing or byte-mismatched child packs fail before every destination write", async (t) => {
  await t.test("missing child", async () => {
    const fixture = buildFixture();
    fixture.sourceObjects.delete(fixture.packArtifacts[0].reference.pack_relative_path);
    const io = harness(fixture);
    await assert.rejects(runRestore(fixture, { io, dryRun: false }), /is missing/);
    assert.deepEqual(io.writes, []);
  });
  await t.test("child size mismatch", async () => {
    const fixture = buildFixture();
    const key = fixture.packArtifacts[0].reference.pack_relative_path;
    fixture.sourceObjects.set(key, Buffer.concat([fixture.sourceObjects.get(key), Buffer.from(" ")]));
    const io = harness(fixture);
    await assert.rejects(runRestore(fixture, { io, dryRun: false }), /byte identity mismatch/);
    assert.deepEqual(io.writes, []);
  });
  await t.test("child SHA mismatch", async () => {
    const fixture = buildFixture();
    const key = fixture.packArtifacts[0].reference.pack_relative_path;
    const changed = Buffer.from(fixture.sourceObjects.get(key));
    changed[changed.length - 2] = changed[changed.length - 2] === 10 ? 32 : 10;
    fixture.sourceObjects.set(key, changed);
    const io = harness(fixture);
    await assert.rejects(runRestore(fixture, { io, dryRun: false }), /byte identity mismatch/);
    assert.deepEqual(io.writes, []);
  });
});

test("packed checkpoint root and range evidence are mandatory before writes", async (t) => {
  await t.test("legacy individual state cannot replace missing pack state", async () => {
    const fixture = buildFixture();
    const stateRoot = JSON.parse(
      fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY).toString("utf8"),
    );
    delete stateRoot.timeseries_binding_packs;
    stateRoot.timeseries_binding = {
      processed_source_root_hash: fixture.sourceRoot.source_root_hash,
      ranges: [],
    };
    fixture.sourceObjects.set(
      TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY,
      Buffer.from(stableJson(stateRoot)),
    );
    const io = harness(fixture);
    await assert.rejects(runRestore(fixture, { io, dryRun: false }), /pack checkpoint root/);
    assert.deepEqual(io.writes, []);
  });
  await t.test("checkpoint pack-root identity mismatch", async () => {
    const fixture = buildFixture();
    const stateRoot = JSON.parse(
      fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY).toString("utf8"),
    );
    stateRoot.timeseries_binding_packs.processed_pack_root_sha256 = "0".repeat(64);
    fixture.sourceObjects.set(
      TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY,
      Buffer.from(stableJson(stateRoot)),
    );
    const io = harness(fixture);
    await assert.rejects(runRestore(fixture, { io, dryRun: false }), /pack root byte identity/);
    assert.deepEqual(io.writes, []);
  });
  await t.test("checkpoint range shard hash mismatch", async () => {
    const fixture = buildFixture();
    const shardKey = fixture.sourceRoot.ranges[0].manifest_key
      .replace(`${TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX}/_manifests/`, `${TIMESERIES_BINDING_RESTORE_STATE_PREFIX}/timeseries_binding_packs/`);
    fixture.sourceObjects.set(
      shardKey,
      Buffer.concat([fixture.sourceObjects.get(shardKey), Buffer.from(" ")]),
    );
    const io = harness(fixture);
    await assert.rejects(runRestore(fixture, { io, dryRun: false }), /shard SHA-256 mismatch/);
    assert.deepEqual(io.writes, []);
  });
});

test("member base64, hash, path, duplicate, extra and missing violations fail before writes", async (t) => {
  const cases = [
    ["non-canonical base64", (pack) => {
      pack.members[0].body_base64 = `${pack.members[0].body_base64}\n`;
    }],
    ["member hash", (pack) => {
      pack.members[0].sha256 = "0".repeat(64);
    }],
    ["non-normalized path", (pack) => {
      pack.members[0].relative_path = `/${pack.members[0].relative_path}`;
    }],
    ["duplicate member", (pack) => {
      pack.members[1] = structuredClone(pack.members[0]);
    }],
    ["extra member", (pack) => {
      const body = Buffer.from('{"timeseries_id":13,"connector_id":9}\n');
      pack.members.push({
        timeseries_id: 13,
        relative_path: memberPath(13),
        size: body.byteLength,
        sha256: h(body),
        body_base64: body.toString("base64"),
      });
      pack.member_count += 1;
    }],
    ["missing member", (pack) => {
      pack.members.pop();
      pack.member_count -= 1;
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = buildFixture();
      refreshFixturePackIdentity(fixture, 0, mutate);
      const io = harness(fixture);
      await assert.rejects(runRestore(fixture, {
        io,
        dryRun: false,
        expectedPackRootSha256: sha256Hex(
          fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY),
        ),
      }));
      assert.deepEqual(io.writes, []);
    });
  }
});

test("reconstructed source root must match the pack-root authority before writes", async () => {
  const fixture = buildFixture();
  const contradictoryHash = "f".repeat(64);
  replacePackRootSourceHash(fixture, contradictoryHash);
  const io = harness(fixture);
  await assert.rejects(runRestore(fixture, {
    io,
    dryRun: false,
    expectedSourceRootHash: contradictoryHash,
    expectedPackRootSha256: sha256Hex(
      fixture.sourceObjects.get(TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY),
    ),
  }), /Reconstructed source root hash does not match pack authority/);
  assert.deepEqual(io.writes, []);
});

test("destination member readback failure prevents all manifest and root publication", async () => {
  const fixture = buildFixture();
  const io = harness(fixture, { corruptReadbackId: 12 });
  await assert.rejects(runRestore(fixture, {
    io,
    dryRun: false,
    writeConcurrency: 1,
  }), /Restored binding exact-byte readback mismatch: 12/);
  assert.equal(
    io.writes.some((key) => key.includes("/_manifests/")),
    false,
  );
  assert.equal(
    io.writes.includes(timeseriesBindingSourceRootKey(TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX)),
    false,
  );
});

test("write CLI is dry-run by default and exactly guards the isolated TEST target", () => {
  assert.equal(
    NORMAL_TEST_R2_HISTORY_DESTINATION,
    "uk_aq_r2_test:uk-aq-history-cic-test",
  );
  assert.equal(
    PHASE4_ISOLATED_TEST_R2_DESTINATION,
    "uk_aq_r2_test:uk-aq-history-cic-test-timeseries-binding-restore-phase4",
  );
  const base = [
    "--source-root", NORMAL_TEST_DROPBOX_PACK_SOURCE,
    "--dest-root", NORMAL_TEST_R2_HISTORY_DESTINATION,
  ];
  const dryRun = parseTimeseriesBindingPackRestoreArgs(base);
  assert.equal(dryRun.writeR2, false);

  assert.throws(
    () => parseTimeseriesBindingPackRestoreArgs([...base, "--write-r2"]),
    /normal TEST history bucket/,
  );
  assert.throws(
    () => parseTimeseriesBindingPackRestoreArgs([
      "--source-root", NORMAL_TEST_DROPBOX_PACK_SOURCE,
      "--dest-root", "uk_aq_r2_live:uk-aq-history-live",
      "--write-r2",
    ]),
    /exact isolated TEST destination/,
  );
  assert.throws(
    () => parseTimeseriesBindingPackRestoreArgs([
      "--source-root", NORMAL_TEST_DROPBOX_PACK_SOURCE,
      "--dest-root", PHASE4_ISOLATED_TEST_R2_DESTINATION,
      "--write-r2",
      "--confirm-isolated-test-dest-root", PHASE4_ISOLATED_TEST_R2_DESTINATION,
    ]),
    /requires both expected source-root and pack-root SHA-256 pins/,
  );
  const write = parseTimeseriesBindingPackRestoreArgs([
    "--source-root", NORMAL_TEST_DROPBOX_PACK_SOURCE,
    "--dest-root", PHASE4_ISOLATED_TEST_R2_DESTINATION,
    "--write-r2",
    "--expected-source-root-sha256", "1".repeat(64),
    "--expected-pack-root-sha256", "2".repeat(64),
    "--confirm-isolated-test-dest-root", PHASE4_ISOLATED_TEST_R2_DESTINATION,
  ]);
  assert.equal(write.writeR2, true);
  assert.equal(write.destRoot, PHASE4_ISOLATED_TEST_R2_DESTINATION);
});

test("the older generic restore remains limited to its unchanged domains", () => {
  const source = fs.readFileSync(
    new URL("../scripts/backup_r2/restore_history_from_dropbox.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /DOMAIN_NAMES = Object\.freeze\(\["observations", "aqilevels", "core"\]\)/);
  assert.doesNotMatch(source, /DOMAIN_NAMES[^\n]*timeseries_binding/);
});
