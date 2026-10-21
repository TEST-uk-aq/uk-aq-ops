import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
import { getObservationHistoryGeneration } from "../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  parseTimeseriesBindingPackRestoreArgs as parseRestoreArgs,
  createRestoreDestinationObject,
} from "../scripts/backup_r2/restore_timeseries_binding_packs_to_r2.mjs";

const NORMAL_TEST_DROPBOX_PACK_SOURCE = "uk_aq_dropbox:TEST/R2_history_backup";
const NORMAL_TEST_R2_HISTORY_DESTINATION = "uk_aq_r2:uk-aq-history-cic-test";
const PHASE4_ISOLATED_TEST_R2_DESTINATION = "uk_aq_r2:uk-aq-history-cic-test-timeseries-binding-restore-phase4";
const parseTimeseriesBindingPackRestoreArgs = (argv) => parseRestoreArgs(argv, {
  CFLARE_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
  CFLARE_R2_ACCESS_KEY_ID: "test-access-key",
  CFLARE_R2_SECRET_ACCESS_KEY: "test-secret-key",
  UK_AQ_DROPBOX_ROOT: "TEST",
  UK_AQ_R2_HISTORY_DROPBOX_DIR: "R2_history_backup",
});
const V2_GENERATION = getObservationHistoryGeneration("v2");
const PACK_PREFIX = "history/_backup_packs_v1/timeseries_binding";
const RESERVATION_KEY = "_ops/restores/timeseries_binding_pack_restore_v1/reservation.json";
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
  const stateRoot = emptyHierarchicalStateRoot(TIMESERIES_BINDING_RESTORE_STATE_PREFIX, V2_GENERATION);
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
    listDestinationObjects: async ({ maxKeys, continuationToken = null }) => {
      const keys = [...destinationObjects.keys()].sort().filter((key) => !continuationToken || key > continuationToken);
      const selected = keys.slice(0, maxKeys);
      return { entries: selected.map((key) => ({ key, size: destinationObjects.get(key).byteLength })),
        is_truncated: keys.length > selected.length,
        next_token: keys.length > selected.length ? selected.at(-1) : null };
    },
    writeDestinationObject: async (relativePath, body, options) => {
      if (destinationObjects.has(relativePath)) throw new Error("Create-only destination object already exists");
      assert.equal(options?.ifNoneMatch, "*");
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
    listDestinationObjects: io.listDestinationObjects,
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

  assert.deepEqual(io.writes, [RESERVATION_KEY, ...memberKeys, ...rangeKeys, rootKey]);
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
    "uk_aq_r2:uk-aq-history-cic-test",
  );
  assert.equal(
    PHASE4_ISOLATED_TEST_R2_DESTINATION,
    "uk_aq_r2:uk-aq-history-cic-test-timeseries-binding-restore-phase4",
  );
  const base = [
    "--source-root", NORMAL_TEST_DROPBOX_PACK_SOURCE,
    "--dest-root", NORMAL_TEST_R2_HISTORY_DESTINATION,
  ];
  const dryRun = parseTimeseriesBindingPackRestoreArgs(base);
  assert.equal(dryRun.writeR2, false);

  assert.throws(
    () => parseTimeseriesBindingPackRestoreArgs([...base, "--write-r2"]),
    /active history buckets are forbidden/,
  );
  assert.throws(
    () => parseTimeseriesBindingPackRestoreArgs([
      "--source-root", NORMAL_TEST_DROPBOX_PACK_SOURCE,
      "--dest-root", "uk_aq_r2_live:uk-aq-history-live",
      "--write-r2",
    ]),
    /active history buckets are forbidden/,
  );
  assert.throws(
    () => parseTimeseriesBindingPackRestoreArgs([
      "--source-root", NORMAL_TEST_DROPBOX_PACK_SOURCE,
      "--dest-root", PHASE4_ISOLATED_TEST_R2_DESTINATION,
      "--write-r2",
      "--confirm-isolated-dest-root", PHASE4_ISOLATED_TEST_R2_DESTINATION,
    ]),
    /requires both expected source-root and pack-root SHA-256 pins/,
  );
  const write = parseTimeseriesBindingPackRestoreArgs([
    "--source-root", NORMAL_TEST_DROPBOX_PACK_SOURCE,
    "--dest-root", PHASE4_ISOLATED_TEST_R2_DESTINATION,
    "--write-r2",
    "--expected-source-root-sha256", "1".repeat(64),
    "--expected-pack-root-sha256", "2".repeat(64),
    "--confirm-isolated-dest-root", PHASE4_ISOLATED_TEST_R2_DESTINATION,
  ]);
  assert.equal(write.writeR2, true);
  assert.equal(write.destRoot, PHASE4_ISOLATED_TEST_R2_DESTINATION);
});

test("the older generic restore refuses binding payload before any I/O", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/backup_r2/restore_history_from_dropbox.mjs", import.meta.url)),
    "--source-root", "synthetic-source", "--dest-root", "synthetic-destination",
    "--domain", "timeseries_binding",
  ], { encoding: "utf8", env: { UK_AQ_R2_HISTORY_VERSION: "v2" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --domain value: timeseries_binding/);
});


test("restore refuses a nonempty unreserved bucket before every destination write", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  io.destinationObjects.set("unrelated.txt", Buffer.from("unrelated"));
  await assert.rejects(runRestore(fixture, { io, dryRun: false }), /not empty/);
  assert.deepEqual(io.writes, []);
  assert.deepEqual(io.destinationObjects.get("unrelated.txt"), Buffer.from("unrelated"));
});

test("restore resumes only an identical reservation with exact existing members", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  await runRestore(fixture, { io, dryRun: false });
  assert.ok(io.destinationObjects.has(RESERVATION_KEY));
  const rootKey = timeseriesBindingSourceRootKey(TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX);
  io.destinationObjects.delete(rootKey);
  io.destinationObjects.delete(memberPath(12));
  io.writes.length = 0;
  const { report } = await runRestore(fixture, { io, dryRun: false });
  assert.equal(report.destination_safety.mode, "resume");
  assert.deepEqual(io.writes, [memberPath(12), rootKey]);
  assert.equal(report.members_written, 1);
  assert.equal(report.members_reused, 2);
  assert.equal(report.root_published_last, true);
});

test("restore rejects conflicting reservations and unrelated or corrupt resume content", async () => {
  for (const scenario of ["reservation", "unrelated", "member", "premature-root"]) {
    const fixture = buildFixture();
    const io = harness(fixture);
    await runRestore(fixture, { io, dryRun: false });
    const rootKey = timeseriesBindingSourceRootKey(TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX);
    if (scenario !== "premature-root") io.destinationObjects.delete(rootKey);
    if (scenario === "reservation") io.destinationObjects.set(RESERVATION_KEY, Buffer.from("wrong reservation"));
    if (scenario === "unrelated") io.destinationObjects.set("unrelated.txt", Buffer.from("unrelated"));
    if (scenario === "member") io.destinationObjects.set(memberPath(12), Buffer.from("wrong member"));
    if (scenario === "premature-root") io.destinationObjects.delete(memberPath(12));
    io.writes.length = 0;
    await assert.rejects(runRestore(fixture, { io, dryRun: false }), /reservation|unrelated|identity|incomplete/);
    assert.deepEqual(io.writes, []);
  }
});

test("restore dry-run does not reserve or inspect a destination", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  io.listDestinationObjects = () => { throw new Error("dry-run must not inspect destination"); };
  const { report } = await runRestore(fixture, { io, dryRun: true });
  assert.equal(report.ok, true);
  assert.deepEqual(io.writes, []);
});


test("restore PUT signs create-only precondition and never retries or falls back on conflict", async () => {
  const r2 = { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "history-sandbox-timeseries-binding-restore-test",
    region: "auto", access_key_id: "synthetic-id", secret_access_key: "synthetic-secret" };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 412 });
  };
  await assert.rejects(createRestoreDestinationObject({
    r2, key: "synthetic-object.json", body: Buffer.from("{}"), ifNoneMatch: "*", fetchImpl,
  }), /create-only write refused/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers["if-none-match"], "*");
  assert.match(requests[0].init.headers.authorization, /SignedHeaders=[^,]*if-none-match/);
  assert.equal(requests[0].init.redirect, "error");
  await assert.rejects(createRestoreDestinationObject({ r2, key: "synthetic-object.json", body: Buffer.from("{}"), fetchImpl }), /If-None-Match/);
  assert.equal(requests.length, 1);
});

test("resume inspection has a closed-set bound and rejects broken pagination before writes", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  await runRestore(fixture, { io, dryRun: false });
  const originalList = io.listDestinationObjects;
  const limits = [];
  io.listDestinationObjects = async (options) => {
    limits.push(options.maxKeys);
    return originalList({ ...options, maxKeys: Math.min(2, options.maxKeys) });
  };
  io.writes.length = 0;
  const { report } = await runRestore(fixture, { io, dryRun: false });
  assert.equal(report.source_root_reused, true);
  assert.equal(report.destination_safety.objects_inspected, 7);
  assert.deepEqual(io.writes, []);
  assert.equal(limits[0], 8);
  assert.ok(limits.every((limit) => limit > 0 && limit <= 8));
  assert.ok(limits.length <= 8);
  assert.equal(report.destination_safety.objects_final_checked, 7);
  io.listDestinationObjects = async () => ({ entries: [], is_truncated: true, next_token: "stuck" });
  await assert.rejects(runRestore(fixture, { io, dryRun: false }), /Invalid bounded/);
  assert.deepEqual(io.writes, []);
});

test("fresh reservation rejects unrelated objects that appear during admission", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  const create = io.writeDestinationObject;
  io.writeDestinationObject = async (key, body, options) => {
    await create(key, body, options);
    if (key === RESERVATION_KEY) io.destinationObjects.set("unrelated.txt", Buffer.from("keep"));
  };
  await assert.rejects(runRestore(fixture, { io, dryRun: false }), /unrelated|reservation/);
  assert.deepEqual(io.writes, [RESERVATION_KEY]);
  assert.deepEqual(io.destinationObjects.get("unrelated.txt"), Buffer.from("keep"));
});

test("unrelated objects introduced during restore prevent source-root publication", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  const read = io.readDestinationObject;
  const lastRange = timeseriesBindingSourceRangeManifestKey(TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX, 1000, 1999);
  io.readDestinationObject = async (key) => {
    const body = await read(key);
    if (key === lastRange) io.destinationObjects.set("unrelated.txt", Buffer.from("keep"));
    return body;
  };
  await assert.rejects(runRestore(fixture, { io, dryRun: false }), /unrelated/);
  assert.equal(io.destinationObjects.has(timeseriesBindingSourceRootKey(TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX)), false);
  assert.deepEqual(io.destinationObjects.get("unrelated.txt"), Buffer.from("keep"));
});

test("a committed write with lost acknowledgement resumes only after reservation and byte verification", async () => {
  const fixture = buildFixture();
  const io = harness(fixture);
  const create = io.writeDestinationObject;
  io.writeDestinationObject = async (key, body, options) => {
    await create(key, body, options);
    if (key === memberPath(12)) throw new Error("synthetic interrupted acknowledgement");
  };
  await assert.rejects(runRestore(fixture, { io, dryRun: false }), /interrupted acknowledgement/);
  assert.equal(io.destinationObjects.has(timeseriesBindingSourceRootKey(TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX)), false);
  io.writeDestinationObject = create;
  io.writes.length = 0;
  const { report } = await runRestore(fixture, { io, dryRun: false });
  assert.equal(report.members_reused, 2);
  assert.equal(report.members_written, 1);
  assert.equal(io.writes.includes(memberPath(12)), false);
  assert.equal(report.source_root_readback_verified, true);
});
